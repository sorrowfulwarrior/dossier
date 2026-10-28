import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient, resetDatabase } from "@/test/db";

import { countAgentQueue, loadAgentView } from "./view";

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("@/lib/time-zone", () => ({ lastKnownTimeZone: async () => "Europe/Berlin" }));
vi.mock("@/lib/ai/config", () => ({ isAiConfigured: async () => true }));
vi.mock("@/lib/job-search/config", () => ({
  loadJobSearchConfig: async () => ({ source: "JSEARCH", saved: true, jsearch: { key: "k", host: "openwebninja", keyState: "set" }, adzuna: { appId: "", key: null, keyState: "none" } }),
  credentialsFor: () => ({ key: "k", host: "openwebninja" }),
}));

const prisma = () => db.client!;
const now = new Date("2026-10-20T10:00:00Z");
const query = { keywords: "Data scientist", place: "Berlin", country: "de", radiusKm: 25, remoteOnly: false, postedWithin: "any" };
let agentId = "";
const candidate = (externalId: string, score: number, data: Record<string, unknown> = {}) =>
  prisma().agentCandidate.create({ data: { agentId, source: "JSEARCH", externalId, dedupeKey: externalId, title: `Posting ${externalId}`, company: "Ledgerly", place: "Berlin", remote: true, score, via: "LinkedIn", postedAt: new Date("2026-10-18T00:00:00Z"), ...data } });

beforeEach(async () => {
  await resetDatabase(prisma());
  const agent = await prisma().jobAgent.create({
    data: { source: "JSEARCH", enabled: true, query, runs: [{ at: "2026-10-20T05:00:00Z", manual: false, message: "2 new postings are waiting for a look." }] },
  });
  agentId = agent.id;
});
afterAll(() => prisma().$disconnect());

describe("the Agent screen's data (E16-6)", () => {
  it("splits the queue into drafts, scored postings and those below the minimum, best first", async () => {
    const application = await prisma().application.create({ data: { origin: "AGENT", awaitingReview: true } });
    await candidate("draft", 90, { status: "DRAFTED", applicationId: application.id });
    const good = await candidate("good", 75);
    await candidate("better", 88);
    await candidate("low", 30);
    await candidate("gone", 95, { status: "DISMISSED" });
    await candidate("kept", 95, { status: "APPROVED" });
    const job = await prisma().job.create({ data: { type: "agent-draft", key: `agent-candidate:${good.id}`, input: { candidateId: good.id } } });

    const view = await loadAgentView(now);
    expect(view.drafts.map((entry) => entry.title)).toEqual(["Posting draft"]);
    expect(view.scored.map((entry) => entry.title)).toEqual(["Posting better", "Posting good"]);
    expect(view.belowMinimum.map((entry) => entry.title)).toEqual(["Posting low"]);
    expect(view.scored[1]).toMatchObject({ facts: "Berlin · Remote", origin: "Posted 2 days ago · via LinkedIn on JSearch", draftJobId: job.id, agentId, agentName: "Data scientist" });
    expect(view.agents).toHaveLength(1);
    expect(view.agents[0]).toMatchObject({
      id: agentId,
      name: "Data scientist",
      search: "Data scientist · Berlin, 25 km · via JSearch",
      setupProblem: null,
      limitReached: false,
      lastRun: { at: "Tue 20 Oct, 07:00", message: "2 new postings are waiting for a look." },
      nextRun: "Wed 21 Oct, 07:00",
    });
    // The badge: scored at or above the minimum, and drafts.
    expect(await countAgentQueue()).toBe(3);
  });

  it("holds each candidate to its own agent's minimum score", async () => {
    const strict = await prisma().jobAgent.create({ data: { name: "Strict", source: "APIFY_LINKEDIN", enabled: true, query, minScore: 85 } });
    await candidate("mine", 75);
    await candidate("theirs", 80, { agentId: strict.id });
    // An agent that was deleted leaves its candidates at the default of 70.
    await candidate("orphan", 72, { agentId: null });
    const view = await loadAgentView(now);
    expect(view.scored.map((entry) => entry.title)).toEqual(["Posting mine", "Posting orphan"]);
    expect(view.belowMinimum.map((entry) => [entry.title, entry.agentName])).toEqual([["Posting theirs", "Strict"]]);
    expect(view.agents.map((agent) => agent.search)).toEqual(["Data scientist · Berlin, 25 km · via JSearch", "Data scientist · Berlin, 25 km · via LinkedIn (Apify)"]);
    expect(await countAgentQueue()).toBe(2);
  });

  it("says what's missing, and when the day's runs are used up", async () => {
    await prisma().jobAgent.update({
      where: { id: agentId },
      data: {
        enabled: false,
        query: { keywords: "", place: "", country: "", radiusKm: 25, remoteOnly: false, postedWithin: "any" },
        runs: ["09:30", "08:00", "06:00"].map((time) => ({ at: `2026-10-20T${time}:00Z`, manual: true, message: null })),
      },
    });
    expect((await loadAgentView(now)).agents[0]).toMatchObject({
      enabled: false,
      search: null,
      setupProblem: "Add what to look for in Settings → Job agent first.",
      setupSection: "agent",
      limitReached: true,
      nextRun: null,
    });
  });
});
