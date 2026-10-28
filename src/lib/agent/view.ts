import "server-only";

import { AgentCandidateStatus, JobStatus } from "@/generated/prisma/enums";
import { formatDateTime } from "@/lib/dates";
import { countryName } from "@/lib/job-search/countries";
import { describeSearch, postedAgo, type JobSource } from "@/lib/job-search/search";
import { SOURCE_INFO } from "@/lib/job-search/sources";
import { prisma } from "@/lib/prisma";
import { lastKnownTimeZone } from "@/lib/time-zone";

import { agentName, DEFAULT_MIN_SCORE, listAgents, type Agent } from "./agents";
import { stringsOf } from "./candidates";
import { agentJobKey } from "./jobs";
import { agentSetupProblem } from "./run";
import { AGENT_MAX_RUNS_PER_DAY, runsInPastDay } from "./runs";
import { nextAgentRun } from "./schedule";

// What the Agent screen shows (E16-6): each agent, and what they found
// together.

export type AgentCandidateView = {
  id: string;
  title: string;
  company: string;
  /** "Rotterdam · Remote · €70k", what's known of them. */
  facts: string;
  /** "Posted 2 days ago · via LinkedIn on JSearch". */
  origin: string;
  source: JobSource;
  url: string;
  score: number;
  reasons: string[];
  redFlags: string[];
  /** Why the last try at a draft failed. */
  error: string | null;
  /** The draft, once there is one. */
  applicationId: string | null;
  /** The job preparing its draft, while one is queued or running. */
  draftJobId: string | null;
  /** The agent that found it; null once that agent is deleted. */
  agentId: string | null;
  agentName: string | null;
};

/** One agent, as the Agent screen lists it. */
export type AgentSummary = {
  id: string;
  name: string;
  source: JobSource;
  enabled: boolean;
  autoDraft: boolean;
  minScore: number;
  /** "Data scientist · Berlin, 25 km · via LinkedIn (Apify)", or null without a search. */
  search: string | null;
  /** Why it can't run: no search, AI provider, source or key; null when it's set up. */
  setupProblem: string | null;
  /** Which settings section fixes it. */
  setupSection: "agent" | "ai" | "jobs" | null;
  /** The daily limit is used up. */
  limitReached: boolean;
  lastRun: { at: string; message: string | null } | null;
  /** In the user's zone; null while the agent is off. */
  nextRun: string | null;
  /** A run queued or running, to follow. */
  runJobId: string | null;
};

export type AgentView = {
  agents: AgentSummary[];
  /** Whether any agent prepares drafts on its own. */
  autoDraft: boolean;
  drafts: AgentCandidateView[];
  /** At or above their agent's minimum score, best first. */
  scored: AgentCandidateView[];
  /** Below it: kept so they don't come back, shown on request. */
  belowMinimum: AgentCandidateView[];
};

/** The score a candidate must reach to wait for a look: its agent's minimum. */
const minimumFor = (agents: ReadonlyMap<string, Agent>, agentId: string | null) => (agentId ? agents.get(agentId)?.minScore : undefined) ?? DEFAULT_MIN_SCORE;

/** The Agent item's badge (E16-6): what's waiting for a look. */
export async function countAgentQueue(): Promise<number> {
  const agents = await listAgents();
  const known = agents.map((agent) => agent.id);
  return prisma.agentCandidate.count({
    where: {
      OR: [
        ...agents.map((agent) => ({ agentId: agent.id, status: AgentCandidateStatus.SCORED, score: { gte: agent.minScore } })),
        { OR: [{ agentId: null }, { agentId: { notIn: known } }], status: AgentCandidateStatus.SCORED, score: { gte: DEFAULT_MIN_SCORE } },
        { status: AgentCandidateStatus.DRAFTED, applicationId: { not: null } },
      ],
    },
  });
}

/** "Today" and "Yesterday" in a sentence; "2 days ago" or "15 Oct" as they are. */
const posted = (ago: string) => (ago === "Today" || ago === "Yesterday" ? ago.toLowerCase() : ago);

const sectionOf = (problem: string): AgentSummary["setupSection"] =>
  problem.includes("AI provider") ? "ai" : problem.includes("Job search") ? "jobs" : "agent";

export async function loadAgentView(now = new Date()): Promise<AgentView> {
  const agents = await listAgents();
  const [timeZone, candidates, draftJobs, runJobs] = await Promise.all([
    lastKnownTimeZone(),
    prisma.agentCandidate.findMany({
      where: { status: { in: [AgentCandidateStatus.SCORED, AgentCandidateStatus.DRAFTING, AgentCandidateStatus.DRAFTED] } },
      orderBy: [{ score: "desc" }, { createdAt: "desc" }],
    }),
    prisma.job.findMany({
      where: { type: "agent-draft", status: { in: [JobStatus.QUEUED, JobStatus.RUNNING] } },
      select: { id: true, key: true },
    }),
    prisma.job.findMany({
      where: { key: { in: agents.map((agent) => agentJobKey(agent.id)) }, status: { in: [JobStatus.QUEUED, JobStatus.RUNNING] } },
      select: { id: true, key: true },
    }),
  ]);
  const draftJob = new Map(draftJobs.map((job) => [job.key?.replace(/^agent-candidate:/, ""), job.id]));
  const runJob = new Map(runJobs.map((job) => [job.key, job.id]));
  const byId = new Map(agents.map((agent) => [agent.id, agent]));

  const summaries = await Promise.all(
    agents.map(async (agent): Promise<AgentSummary> => {
      const { query, source } = agent;
      const setupProblem = await agentSetupProblem(agent);
      const last = agent.runs[0];
      return {
        id: agent.id,
        name: agentName(agent),
        source,
        enabled: agent.enabled,
        autoDraft: agent.autoDraft,
        minScore: agent.minScore,
        search: query.keywords.trim()
          ? `${describeSearch(query, countryName(query.country) || query.country.toUpperCase())} · via ${SOURCE_INFO[source].name}`
          : null,
        setupProblem,
        setupSection: setupProblem ? sectionOf(setupProblem) : null,
        limitReached: runsInPastDay(agent.runs, now).length >= AGENT_MAX_RUNS_PER_DAY,
        lastRun: last ? { at: formatDateTime(new Date(last.at), timeZone, now), message: last.message } : null,
        nextRun: agent.enabled ? formatDateTime(nextAgentRun(now, agent.hour, timeZone, agent.runs), timeZone, now) : null,
        runJobId: runJob.get(agentJobKey(agent.id)) ?? null,
      };
    }),
  );

  const view = (candidate: (typeof candidates)[number]): AgentCandidateView => {
    const agent = candidate.agentId ? byId.get(candidate.agentId) : undefined;
    return {
      id: candidate.id,
      title: candidate.title.trim() || "Untitled posting",
      company: candidate.company.trim(),
      facts: [candidate.place, candidate.remote ? "Remote" : "", candidate.salary].filter(Boolean).join(" · "),
      origin: [
        candidate.postedAt ? `Posted ${posted(postedAgo(candidate.postedAt.toISOString(), now))}` : "",
        [candidate.via ? `via ${candidate.via}` : "", `on ${SOURCE_INFO[candidate.source].name}`].filter(Boolean).join(" "),
      ]
        .filter(Boolean)
        .join(" · "),
      source: candidate.source,
      url: candidate.url,
      score: candidate.score,
      reasons: stringsOf(candidate.reasons),
      redFlags: stringsOf(candidate.redFlags),
      error: candidate.error,
      applicationId: candidate.applicationId,
      draftJobId: draftJob.get(candidate.id) ?? null,
      agentId: agent?.id ?? null,
      agentName: agent ? agentName(agent) : null,
    };
  };
  const drafts = candidates.filter((candidate) => candidate.status === AgentCandidateStatus.DRAFTED && candidate.applicationId).map(view);
  const waiting = candidates.filter((candidate) => candidate.status !== AgentCandidateStatus.DRAFTED);
  const reaches = (candidate: (typeof candidates)[number]) => candidate.score >= minimumFor(byId, candidate.agentId);

  return {
    agents: summaries,
    autoDraft: agents.some((agent) => agent.autoDraft),
    drafts,
    scored: waiting.filter(reaches).map(view),
    belowMinimum: waiting.filter((candidate) => !reaches(candidate)).map(view),
  };
}
