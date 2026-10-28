import "server-only";

import { z } from "zod";

import type { JobAgent, Prisma } from "@/generated/prisma/client";
import { loadJobSearchConfig } from "@/lib/job-search/config";
import { EMPTY_QUERY, JOB_SOURCES, searchQuerySchema, type JobSource, type SearchQuery } from "@/lib/job-search/search";
import { prisma } from "@/lib/prisma";
import { AGENT_RUNS_KEPT, agentRunSchema, LEGACY_AGENT_KEYS, legacyAgentSettingsSchema, type AgentRun, type LegacyAgentSettings } from "@/lib/settings";

// The job agents (E16): one per job title, each with its own source, search,
// hour and limits, and its own runs. Up to 1.9 there was one, kept in
// Settings; the first time the agents are read, it becomes the first one.

/** At most this many agents: each may run three searches a day. */
export const MAX_AGENTS = 10;

export type Agent = {
  id: string;
  name: string;
  source: JobSource;
  query: SearchQuery;
  enabled: boolean;
  hour: number;
  minScore: number;
  maxScores: number;
  maxDrafts: number;
  autoDraft: boolean;
  /** Newest first. */
  runs: AgentRun[];
};

/** What Settings → Job agent may change on an agent. */
export const agentChangesSchema = z.object({
  name: z.string().trim().max(100).optional(),
  source: z.enum(JOB_SOURCES).optional(),
  enabled: z.boolean().optional(),
  query: searchQuerySchema.optional(),
  hour: z.number().int().min(0).max(23).optional(),
  minScore: z.number().int().min(0).max(100).optional(),
  maxScores: z.number().int().min(1).max(30).optional(),
  maxDrafts: z.number().int().min(0).max(10).optional(),
  autoDraft: z.boolean().optional(),
});
export type AgentChanges = z.infer<typeof agentChangesSchema>;

/** The score an agent's candidates must reach when their agent is gone. */
export const DEFAULT_MIN_SCORE = 70;

const runsSchema = z.array(agentRunSchema).catch([]);

export function agentFromRow(row: JobAgent): Agent {
  return {
    id: row.id,
    name: row.name,
    source: row.source,
    query: searchQuerySchema.catch(EMPTY_QUERY).parse(row.query),
    enabled: row.enabled,
    hour: row.hour,
    minScore: row.minScore,
    maxScores: row.maxScores,
    maxDrafts: row.maxDrafts,
    autoDraft: row.autoDraft,
    runs: runsSchema.parse(row.runs),
  };
}

/** "Data scientist" for an agent without a name of its own. */
export const agentName = (agent: Pick<Agent, "name" | "query">) => agent.name.trim() || agent.query.keywords.trim() || "Job agent";

/** A new agent's row, from what was chosen. */
export function agentRowData(agent: Partial<Omit<Agent, "id">> & { source: JobSource }, position: number): Prisma.JobAgentCreateInput {
  return {
    name: agent.name ?? "",
    source: agent.source,
    query: agent.query ?? EMPTY_QUERY,
    enabled: agent.enabled ?? false,
    hour: agent.hour ?? 7,
    minScore: agent.minScore ?? DEFAULT_MIN_SCORE,
    maxScores: agent.maxScores ?? 15,
    maxDrafts: agent.maxDrafts ?? 3,
    autoDraft: agent.autoDraft ?? false,
    runs: (agent.runs ?? []).slice(0, AGENT_RUNS_KEPT),
    position,
  };
}

/**
 * The single agent of 1.9 and before, from its settings, as a new agent:
 * null when it was never set up. The source is the one Settings → Job search
 * chose, which it searched then.
 */
export function legacyAgent(settings: LegacyAgentSettings, source: JobSource | null): (Partial<Omit<Agent, "id">> & { source: JobSource }) | null {
  const used = settings.agentEnabled || settings.agentQuery.keywords.trim() !== "" || settings.agentRuns.length > 0;
  if (!used) return null;
  return {
    source: source && source !== "ARBEITSAGENTUR" ? source : "JSEARCH",
    query: settings.agentQuery,
    enabled: settings.agentEnabled,
    hour: settings.agentHour,
    minScore: settings.agentMinScore,
    maxScores: settings.agentMaxScores,
    maxDrafts: settings.agentMaxDrafts,
    autoDraft: settings.agentAutoDraft,
    runs: settings.agentRuns,
  };
}

/** Moves the old single agent's settings into the first JobAgent, once. Its candidates go with it. */
export async function migrateLegacyAgent(): Promise<void> {
  const rows = await prisma.setting.findMany({ where: { key: { in: LEGACY_AGENT_KEYS } } });
  if (rows.length === 0) return;
  const settings = legacyAgentSettingsSchema.parse(Object.fromEntries(rows.map((row) => [row.key, row.value])));
  const old = legacyAgent(settings, (await loadJobSearchConfig()).source);
  await prisma.$transaction(async (tx) => {
    // Another request moved it first.
    const { count } = await tx.setting.deleteMany({ where: { key: { in: LEGACY_AGENT_KEYS } } });
    if (count === 0 || !old) return;
    const created = await tx.jobAgent.create({ data: agentRowData(old, 0), select: { id: true } });
    await tx.agentCandidate.updateMany({ where: { agentId: null }, data: { agentId: created.id } });
  });
}

/** Every agent, in the order Settings lists them. */
export async function listAgents(): Promise<Agent[]> {
  await migrateLegacyAgent();
  const rows = await prisma.jobAgent.findMany({ orderBy: [{ position: "asc" }, { createdAt: "asc" }] });
  return rows.map(agentFromRow);
}

export async function loadAgent(id: string): Promise<Agent | null> {
  const row = await prisma.jobAgent.findUnique({ where: { id } });
  return row ? agentFromRow(row) : null;
}

/** A new agent, off, after the others; it starts from `initial`. */
export async function createAgent(initial: Partial<Omit<Agent, "id" | "runs">> & { source: JobSource }): Promise<Agent> {
  const last = await prisma.jobAgent.findFirst({ orderBy: { position: "desc" }, select: { position: true } });
  return agentFromRow(await prisma.jobAgent.create({ data: agentRowData({ ...initial, enabled: false }, (last?.position ?? -1) + 1) }));
}

export async function updateAgent(id: string, changes: AgentChanges): Promise<Agent> {
  return agentFromRow(await prisma.jobAgent.update({ where: { id }, data: changes }));
}

/** Deletes an agent; what it found stays, so it doesn't come back. */
export async function deleteAgent(id: string): Promise<void> {
  await prisma.jobAgent.deleteMany({ where: { id } });
}

/** Saves an agent's runs, newest first, keeping the latest AGENT_RUNS_KEPT. */
export async function saveAgentRuns(id: string, runs: readonly AgentRun[]): Promise<void> {
  await prisma.jobAgent.update({ where: { id }, data: { runs: runs.slice(0, AGENT_RUNS_KEPT) } });
}
