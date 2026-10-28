"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { AgentCandidateStatus } from "@/generated/prisma/enums";
import { agentDraftJob, approveCandidate, dismissCandidate, draftJobKey, restoreCandidate } from "@/lib/agent/draft";
import { agentChangesSchema, createAgent, deleteAgent, listAgents, loadAgent, MAX_AGENTS, updateAgent, type Agent } from "@/lib/agent/agents";
import { agentJobKey, agentScanJob } from "@/lib/agent/jobs";
import { agentQueryReady, agentSetupProblem } from "@/lib/agent/run";
import { runLimitProblem } from "@/lib/agent/runs";
import { action, ActionError } from "@/lib/action";
import { JOB_SOURCES, safeLink, searchQuerySchema } from "@/lib/job-search/search";
import { cancelJob, findUnfinishedJobs, startJob } from "@/lib/jobs/runner";
import { prisma } from "@/lib/prisma";

// The Agent screen's actions (E16). Nothing here ever sends anything:
// approving only makes a draft a normal Draft application.

const agentId = z.string().min(1).max(100);

/** The agent, or an error saying it's gone. */
async function agentOrError(id: string): Promise<Agent> {
  const agent = await loadAgent(id);
  if (!agent) throw new ActionError("That job agent was deleted.");
  return agent;
}

/** What Settings → Job agent shows of an agent, and every screen it shows on. */
function revalidateAgents() {
  revalidatePath("/agent");
  revalidatePath("/settings");
}

/**
 * Add agent in Settings → Job agent: a new one, off, searching `query` on
 * `source`, so each job title gets one. At most MAX_AGENTS.
 */
export const createJobAgent = action(
  z.object({ source: z.enum(JOB_SOURCES), query: searchQuerySchema, name: z.string().trim().max(100).optional() }),
  async ({ source, query, name }) => {
    if ((await listAgents()).length >= MAX_AGENTS) throw new ActionError(`You can have up to ${MAX_AGENTS} job agents. Delete one first.`);
    const agent = await createAgent({ source, query, name });
    revalidateAgents();
    return agent;
  },
);

/**
 * Settings → Job agent (E16-7): each change to an agent saves at once.
 * Turning one on needs a search with keywords and a country.
 */
export const saveJobAgent = action(agentChangesSchema.extend({ id: agentId }), async ({ id, ...changes }) => {
  const agent = await agentOrError(id);
  const query = changes.query ?? agent.query;
  if (changes.enabled && !agentQueryReady(query)) {
    throw new ActionError(query.keywords.trim() ? "Choose a country for the search before turning the agent on." : "Type what the agent should look for before turning it on.");
  }
  if (changes.source === "ARBEITSAGENTUR") throw new ActionError("The job agent doesn't search the Bundesagentur für Arbeit. Choose another source.");
  const saved = await updateAgent(id, changes);
  revalidateAgents();
  return saved;
});

/** Deletes an agent and stops its run; what it found stays on the Agent screen, so it doesn't come back. */
export const deleteJobAgent = action(z.object({ id: agentId }), async ({ id }, { toast }) => {
  for (const job of await findUnfinishedJobs(agentJobKey(id))) await cancelJob(job.id);
  await deleteAgent(id);
  revalidateAgents();
  toast("Job agent deleted. What it found stays on the Agent screen.");
  return null;
});

/**
 * Run now (E16-4): one more run of an agent, at most once an hour after its
 * previous one and within its daily limit. A run already queued or running
 * is reused rather than started again.
 */
export const runAgentNow = action(z.object({ agentId }), async ({ agentId: id }) => {
  const agent = await agentOrError(id);
  if (!agent.enabled) throw new ActionError("Turn this job agent on in Settings → Job agent first.");
  const setup = await agentSetupProblem(agent);
  if (setup) throw new ActionError(setup);
  const key = agentJobKey(agent.id);
  const [unfinished] = await findUnfinishedJobs(key);
  if (unfinished) return { jobId: unfinished.id, reused: true };
  const limit = runLimitProblem(agent.runs, new Date(), { manual: true });
  if (limit) throw new ActionError(limit);
  const jobId = await startJob(agentScanJob, { agentId: agent.id, manual: true }, { key });
  revalidatePath("/agent");
  return { jobId, reused: false };
});

const candidateId = z.string().min(1).max(100);

/** Every screen an agent draft shows on, or leaves. */
function revalidateAgent() {
  revalidatePath("/agent");
  revalidatePath("/applications");
  revalidatePath("/jobs");
  revalidatePath("/");
}

/**
 * Prepare draft (E16-5): writes a candidate's draft in the background. A
 * draft under way is reused, and one already made is answered with.
 */
export const prepareAgentDraft = action(z.object({ candidateId }), async ({ candidateId }) => {
  const candidate = await prisma.agentCandidate.findUnique({ where: { id: candidateId }, select: { status: true, applicationId: true } });
  if (!candidate) throw new ActionError("That posting is no longer in the agent's queue.");
  if (candidate.status === AgentCandidateStatus.DRAFTED && candidate.applicationId) return { jobId: null, applicationId: candidate.applicationId };
  const [unfinished] = await findUnfinishedJobs(draftJobKey(candidateId));
  if (unfinished) return { jobId: unfinished.id, applicationId: null };
  if (candidate.status !== AgentCandidateStatus.SCORED) throw new ActionError("That posting is no longer waiting for a draft.");
  const jobId = await startJob(agentDraftJob, { candidateId }, { key: draftJobKey(candidateId) });
  revalidatePath("/agent");
  return { jobId, applicationId: null };
});

/** Approve (E16-5): the draft joins Applications as a Draft. Nothing is sent. */
export const approveAgentDraft = action(z.object({ candidateId }), async ({ candidateId }, { toast }) => {
  const applicationId = await approveCandidate(candidateId);
  revalidateAgent();
  toast("Added to Applications as a draft. Nothing has been sent.");
  return { applicationId };
});

/**
 * Dismiss (E16-5): the posting never comes back; its draft, if any, is
 * deleted. A posting dismissed before it had a draft can be put back.
 */
export const dismissAgentCandidate = action(z.object({ candidateId }), async ({ candidateId }) => {
  const { undo } = await dismissCandidate(candidateId);
  revalidateAgent();
  return { undo };
});

/** Undo on a dismissed posting's toast. */
export const restoreAgentCandidate = action(
  z.object({
    id: candidateId,
    place: z.string().max(500),
    remote: z.boolean().nullable(),
    salary: z.string().max(500),
    postedAt: z.coerce.date().nullable(),
    // Shown as a link again: only a web address.
    url: z.string().max(4000).transform(safeLink),
    via: z.string().max(500),
    description: z.string().max(200_000),
    complete: z.boolean(),
    reasons: z.array(z.string().max(500)).max(10).nullable(),
    redFlags: z.array(z.string().max(500)).max(10).nullable(),
  }),
  async (saved) => {
    await restoreCandidate(saved);
    revalidateAgent();
    return null;
  },
);
