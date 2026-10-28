import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { SearchQuery } from "@/lib/job-search/search";
import { setStatus } from "@/lib/status-actions";
import { createTestClient, resetDatabase } from "@/test/db";

import {
  approveAgentDraft,
  createJobAgent,
  deleteJobAgent,
  dismissAgentCandidate,
  prepareAgentDraft,
  restoreAgentCandidate,
  runAgentNow,
  saveJobAgent,
} from "./actions";

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("@/lib/auth/session", () => ({
  getSession: async () => ({ persistent: false, issuedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/jobs/runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs/runner")>()),
  startJob: vi.fn(async () => "new-run"),
}));
const setup = vi.hoisted(() => ({ ai: true, noKey: false }));
vi.mock("@/lib/ai/config", () => ({ isAiConfigured: async () => setup.ai }));
vi.mock("@/lib/job-search/config", async () => {
  const { jobSearchError } = await import("@/lib/job-search/errors");
  return {
    loadJobSearchConfig: async () => ({ source: "JSEARCH", saved: true, jsearch: { key: "k", host: "openwebninja", keyState: "set" }, adzuna: { appId: "", key: null, keyState: "none" } }),
    credentialsFor: (_config: unknown, source: "JSEARCH" | "APIFY_INDEED") => {
      if (setup.noKey) throw jobSearchError("no-key", source);
      return { key: "k", host: "openwebninja" };
    },
    requestContext: () => ({}),
  };
});

const prisma = () => db.client!;
const candidate = (data: { status?: "SCORED" | "DRAFTED" | "DRAFTING"; applicationId?: string } = {}) =>
  prisma().agentCandidate.create({
    data: { source: "JSEARCH", externalId: `job-${Math.random()}`, dedupeKey: `key-${Math.random()}`, title: "Data Scientist", company: "Ledgerly", url: "https://jobs.example/1", score: 88, reasons: ["Python"], ...data },
  });
const query: SearchQuery = { keywords: "Data scientist", place: "", country: "de", radiusKm: 25, remoteOnly: false, postedWithin: "any" };

let agentId = "";
const setAgent = (data: Record<string, unknown>) => prisma().jobAgent.update({ where: { id: agentId }, data });

beforeEach(async () => {
  Object.assign(setup, { ai: true, noKey: false });
  await resetDatabase(prisma());
  agentId = (await prisma().jobAgent.create({ data: { source: "JSEARCH", query, enabled: true } })).id;
});
afterAll(() => prisma().$disconnect());

describe("Run now (E16-4)", () => {
  it("starts a run, keyed so the schedule and the screen find it", async () => {
    const { startJob } = await import("@/lib/jobs/runner");
    expect(await runAgentNow({ agentId })).toEqual({ ok: true, data: { jobId: "new-run", reused: false } });
    expect(startJob).toHaveBeenLastCalledWith(expect.objectContaining({ type: "agent-scan" }), { agentId, manual: true }, { key: `agent:${agentId}` });
  });

  it("reuses a run that's queued or running", async () => {
    const running = await prisma().job.create({ data: { type: "agent-scan", key: `agent:${agentId}`, status: "RUNNING", input: { agentId, manual: false } } });
    expect(await runAgentNow({ agentId })).toEqual({ ok: true, data: { jobId: running.id, reused: true } });
  });

  it("says what's missing before it starts", async () => {
    await setAgent({ enabled: false });
    expect(await runAgentNow({ agentId })).toEqual({ ok: false, error: "Turn this job agent on in Settings → Job agent first." });
    await setAgent({ enabled: true, query: { ...query, keywords: "" } });
    expect(await runAgentNow({ agentId })).toMatchObject({ ok: false, error: "Add what to look for in Settings → Job agent first." });
    await setAgent({ query });
    setup.ai = false;
    expect(await runAgentNow({ agentId })).toMatchObject({ ok: false, error: "Choose an AI provider in Settings → AI provider first." });
    setup.ai = true;
    // An agent on Apify without a token.
    await setAgent({ source: "APIFY_INDEED" });
    setup.noKey = true;
    expect(await runAgentNow({ agentId })).toMatchObject({ ok: false, error: "Add your Apify token in Settings → Job agent → Apify first." });
    expect(await runAgentNow({ agentId: "gone" })).toEqual({ ok: false, error: "That job agent was deleted." });
  });

  it("waits an hour after the previous run, and keeps to 3 a day", async () => {
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
    await setAgent({ runs: [{ at: at(20), manual: false, message: null }] });
    expect(await runAgentNow({ agentId })).toEqual({ ok: false, error: "The agent ran less than an hour ago. Try again in 40 minutes." });
    await setAgent({ runs: [at(70), at(200), at(400)].map((time) => ({ at: time, manual: true, message: null })) });
    expect(await runAgentNow({ agentId })).toMatchObject({ ok: false, error: expect.stringMatching(/^The agent has run 3 times in the past 24 hours/) });
  });
});

describe("the drafts' actions (E16-5)", () => {
  it("prepares a draft in its own job, reuses one under way, and answers with one already made", async () => {
    const { startJob } = await import("@/lib/jobs/runner");
    const scored = await candidate();
    expect(await prepareAgentDraft({ candidateId: scored.id })).toEqual({ ok: true, data: { jobId: "new-run", applicationId: null } });
    expect(startJob).toHaveBeenLastCalledWith(expect.objectContaining({ type: "agent-draft" }), { candidateId: scored.id }, { key: `agent-candidate:${scored.id}` });

    const queued = await prisma().job.create({ data: { type: "agent-draft", key: `agent-candidate:${scored.id}`, input: { candidateId: scored.id } } });
    expect(await prepareAgentDraft({ candidateId: scored.id })).toEqual({ ok: true, data: { jobId: queued.id, applicationId: null } });

    const application = await prisma().application.create({ data: { origin: "AGENT", awaitingReview: true } });
    const drafted = await candidate({ status: "DRAFTED", applicationId: application.id });
    expect(await prepareAgentDraft({ candidateId: drafted.id })).toEqual({ ok: true, data: { jobId: null, applicationId: application.id } });
    expect(await prepareAgentDraft({ candidateId: "gone" })).toEqual({ ok: false, error: "That posting is no longer in the agent's queue." });
  });

  it("approves a draft into Applications, saying nothing was sent", async () => {
    const application = await prisma().application.create({ data: { origin: "AGENT", awaitingReview: true } });
    const drafted = await candidate({ status: "DRAFTED", applicationId: application.id });
    expect(await approveAgentDraft({ candidateId: drafted.id })).toEqual({
      ok: true,
      data: { applicationId: application.id },
      toast: "Added to Applications as a draft. Nothing has been sent.",
    });
    expect(await prisma().application.findUniqueOrThrow({ where: { id: application.id } })).toMatchObject({ awaitingReview: false });
  });

  it("dismisses a posting, with what Undo needs, and puts it back", async () => {
    const scored = await candidate();
    const result = await dismissAgentCandidate({ candidateId: scored.id });
    expect(result).toMatchObject({ ok: true, data: { undo: { id: scored.id, url: "https://jobs.example/1", reasons: ["Python"] } } });
    if (!result.ok || !result.data.undo) throw new Error("no undo");
    // As the browser sends it back: dates as strings, and a link that must stay a web address.
    const sent = JSON.parse(JSON.stringify(result.data.undo));
    expect(await restoreAgentCandidate({ ...sent, url: "javascript:alert(1)" })).toEqual({ ok: true, data: null });
    expect(await prisma().agentCandidate.findUniqueOrThrow({ where: { id: scored.id } })).toMatchObject({ status: "SCORED", url: "", reasons: ["Python"] });
  });

  it("approves a draft waiting for review when its status moves on (#195)", async () => {
    const application = await prisma().application.create({ data: { origin: "AGENT", awaitingReview: true } });
    const drafted = await candidate({ status: "DRAFTED", applicationId: application.id });
    expect(await setStatus({ id: application.id, to: "SENT" })).toMatchObject({ ok: true });
    expect(await prisma().application.findUniqueOrThrow({ where: { id: application.id } })).toMatchObject({ status: "SENT", awaitingReview: false });
    expect(await prisma().agentCandidate.findUniqueOrThrow({ where: { id: drafted.id } })).toMatchObject({ status: "APPROVED" });
  });
});

describe("the agents in Settings → Job agent (E16-7)", () => {
  it("saves each change, and turns on only with keywords and a country", async () => {
    await setAgent({ enabled: false, query: { ...query, keywords: "" } });
    expect(await saveJobAgent({ id: agentId, enabled: true })).toEqual({ ok: false, error: "Type what the agent should look for before turning it on." });
    expect(await saveJobAgent({ id: agentId, enabled: true, query: { ...query, country: "" } })).toEqual({ ok: false, error: "Choose a country for the search before turning the agent on." });
    expect(await saveJobAgent({ id: agentId, enabled: true, query })).toMatchObject({ ok: true, data: { enabled: true, query } });
    // Typing a new search into an agent that's on saves as it goes.
    expect(await saveJobAgent({ id: agentId, query: { ...query, keywords: "" } })).toMatchObject({ ok: true });
    expect(await saveJobAgent({ id: agentId, name: "Berlin data", source: "APIFY_LINKEDIN", hour: 9, minScore: 80, autoDraft: true, maxDrafts: 5 })).toMatchObject({ ok: true });
    expect(await prisma().jobAgent.findUniqueOrThrow({ where: { id: agentId } })).toMatchObject({
      name: "Berlin data",
      source: "APIFY_LINKEDIN",
      enabled: true,
      hour: 9,
      minScore: 80,
      autoDraft: true,
      maxDrafts: 5,
      maxScores: 15,
    });
    expect(await saveJobAgent({ id: agentId, maxScores: 31 })).toMatchObject({ ok: false });
    expect(await saveJobAgent({ id: agentId, source: "ARBEITSAGENTUR" })).toMatchObject({ ok: false });
  });

  it("adds agents, off and after the others, and deletes them, keeping what they found", async () => {
    const added = await createJobAgent({ source: "APIFY_INDEED", query: { ...query, keywords: "Analyst" } });
    expect(added).toMatchObject({ ok: true, data: { source: "APIFY_INDEED", enabled: false, query: { keywords: "Analyst" } } });
    const id = added.ok ? added.data.id : "";
    const found = await prisma().agentCandidate.create({ data: { agentId: id, source: "APIFY_INDEED", externalId: "in-1", dedupeKey: "in-1" } });
    expect(await deleteJobAgent({ id })).toMatchObject({ ok: true });
    expect(await prisma().jobAgent.count()).toBe(1);
    expect(await prisma().agentCandidate.findUniqueOrThrow({ where: { id: found.id } })).toMatchObject({ agentId: null });
  });
});
