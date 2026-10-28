import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { apifyIndeed, apifyLinkedin, indeedInput, linkedinSearchUrl, postingFromIndeed, postingFromLinkedin } from "./apify";
import { JobSearchError } from "./errors";
import { EMPTY_QUERY, type SearchQuery } from "./search";

const query: SearchQuery = { ...EMPTY_QUERY, keywords: "product designer", place: "Hamburg", country: "de", radiusKm: 50, postedWithin: "week" };
const credentials = { token: "apify_api_test", maxResults: 10 };

const linkedinItem = {
  id: "4012345678",
  title: "Product Designer",
  companyName: "Ledgerly",
  location: "Hamburg, Germany",
  link: "https://www.linkedin.com/jobs/view/4012345678",
  applyUrl: "https://careers.ledgerly.example/jobs/12",
  workRemoteAllowed: false,
  salaryInfo: ["€60,000", "€75,000"],
  postedAt: "2026-10-26",
  descriptionText: "Design the ledger.",
};
const indeedItem = {
  id: "a1b2c3",
  title: "UX Designer",
  companyDetails: { name: "Northwind" },
  formattedLocation: "Remote in Hamburg",
  salary: { min: 55000, max: 70000, type: "YEARLY", currencyCode: "EUR" },
  pubDate: Date.parse("2026-10-25T00:00:00Z"),
  jobDescription: "Shape our app.",
  viewJobLink: "https://de.indeed.com/viewjob?jk=a1b2c3",
  jobSourceName: "Northwind Careers",
};

/** A stand-in for Apify's MCP server, with its three tools, answering as Apify does. */
function fakeApify({ items, statuses = ["SUCCEEDED"], token = credentials.token, toolError }: { items: unknown[]; statuses?: string[]; token?: string; toolError?: string }) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const queue = [...statuses];
  const run = () => ({ runId: "run-1", actorId: "actor", status: queue.shift() ?? "SUCCEEDED", storages: { datasets: { default: { id: "dataset-1" } } }, summary: "", nextStep: "" });
  const answer = (structuredContent: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent });
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "apify", version: "1.0.0" });
    const tool = (name: string, inputSchema: z.ZodObject, result: (args: Record<string, unknown>) => Record<string, unknown>) =>
      server.registerTool(name, { inputSchema }, async (args: Record<string, unknown>) => {
        calls.push({ name, args });
        if (toolError) return { content: [{ type: "text" as const, text: toolError }], isError: true };
        return answer(result(args));
      });
    tool("call-actor", z.object({ actor: z.string(), input: z.record(z.string(), z.unknown()), waitSecs: z.number().optional(), callOptions: z.record(z.string(), z.unknown()).optional() }), run);
    tool("get-actor-run", z.object({ runId: z.string(), waitSecs: z.number().optional() }), run);
    tool("get-dataset-items", z.object({ datasetId: z.string(), limit: z.number().optional(), clean: z.boolean().optional() }), () => ({ datasetId: "dataset-1", items }));
    return server;
  });
  const urls: URL[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    urls.push(new URL(request.url));
    if (request.headers.get("authorization") !== `Bearer ${token}`) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handler.fetch(request);
  });
  return { calls, urls };
}

afterEach(() => vi.unstubAllGlobals());

describe("Apify's LinkedIn scraper", () => {
  it("asks for LinkedIn's own search, the place with its country, in miles, capped", () => {
    const url = new URL(linkedinSearchUrl({ ...query, remoteOnly: true }));
    expect(`${url.origin}${url.pathname}`).toBe("https://www.linkedin.com/jobs/search/");
    expect(Object.fromEntries(url.searchParams)).toEqual({ keywords: "product designer", location: "Hamburg, Germany", distance: "31", f_TPR: "r604800", f_WT: "2" });
    expect(Object.fromEntries(new URL(linkedinSearchUrl({ ...query, place: "", postedWithin: "any" })).searchParams)).toEqual({ keywords: "product designer", location: "Germany" });
  });

  it("reads a scraped job as a posting, with the employer's link first", () => {
    expect(postingFromLinkedin(linkedinItem)).toEqual({
      source: "APIFY_LINKEDIN",
      externalId: "4012345678",
      title: "Product Designer",
      company: "Ledgerly",
      place: "Hamburg, Germany",
      remote: false,
      salary: "€60,000–€75,000",
      postedAt: "2026-10-26T00:00:00.000Z",
      url: "https://careers.ledgerly.example/jobs/12",
      via: "LinkedIn",
      description: "Design the ledger.",
      complete: true,
    });
    expect(postingFromLinkedin({ ...linkedinItem, applyUrl: "javascript:alert(1)", workRemoteAllowed: null, workplaceTypes: ["Remote"] })).toMatchObject({
      url: "https://www.linkedin.com/jobs/view/4012345678",
      remote: true,
    });
    expect(postingFromLinkedin({ title: "No id" })).toBeNull();
  });

  it("runs the actor through Apify's MCP server with the token, waits for it and reads its results", async () => {
    const apify = fakeApify({ items: [linkedinItem, linkedinItem, { nope: true }], statuses: ["RUNNING", "RUNNING", "SUCCEEDED"] });
    const page = await apifyLinkedin.search(query, credentials, null);
    expect(page).toEqual({ postings: [postingFromLinkedin(linkedinItem)], next: null });
    expect(apify.calls.map((call) => call.name)).toEqual(["call-actor", "get-actor-run", "get-actor-run", "get-dataset-items"]);
    expect(apify.calls[0].args).toEqual({
      actor: "curious_coder/linkedin-jobs-scraper",
      input: { urls: [linkedinSearchUrl(query)], limitPerSource: 10, scrapeCompany: false },
      waitSecs: 45,
      callOptions: { maxItems: 10, timeout: 300 },
    });
    expect(apify.calls[3].args).toEqual({ datasetId: "dataset-1", limit: 10, clean: true });
    expect(`${apify.urls[0].origin}${apify.urls[0].pathname}`).toBe("https://mcp.apify.com/");
    expect(apify.urls[0].searchParams.get("tools")).toBe("call-actor,get-actor-run,get-dataset-items");
  });

  it("says when the token is refused, the account can't pay, or the run failed", async () => {
    fakeApify({ items: [], token: "another" });
    await expect(apifyLinkedin.search(query, credentials, null)).rejects.toMatchObject({ problem: "key", message: "Apify didn't accept your token. Check it in Settings → Job agent → Apify." });
    fakeApify({ items: [], toolError: "You have exceeded your monthly usage limit." });
    await expect(apifyLinkedin.search(query, credentials, null)).rejects.toMatchObject({ problem: "quota" });
    fakeApify({ items: [], statuses: ["FAILED"] });
    const failed = await apifyLinkedin.search(query, credentials, null).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(JobSearchError);
    expect(failed).toMatchObject({ problem: "unavailable", detail: "APIFY_LINKEDIN: mcp: run FAILED" });
  });

  it("tests the connection without running an actor", async () => {
    const apify = fakeApify({ items: [] });
    await apifyLinkedin.test(credentials);
    expect(apify.calls).toEqual([]);
  });
});

describe("Apify's Indeed scraper", () => {
  it("asks Indeed's country site with the nearest date filter it has, capped", () => {
    expect(indeedInput(query, 25)).toEqual({ country: "de", query: "product designer", location: "Hamburg", radiusKm: 50, postedWithinDays: "7", count: 25 });
    expect(indeedInput({ ...query, country: "gb", place: "", remoteOnly: true, postedWithin: "month" }, 10)).toEqual({
      country: "uk",
      query: "product designer",
      location: "Remote",
      postedWithinDays: "14",
      count: 10,
    });
  });

  it("reads a scraped job as a posting", () => {
    expect(postingFromIndeed(indeedItem)).toEqual({
      source: "APIFY_INDEED",
      externalId: "a1b2c3",
      title: "UX Designer",
      company: "Northwind",
      place: "Remote in Hamburg",
      remote: true,
      salary: "EUR 55,000–70,000 a year",
      postedAt: "2026-10-25T00:00:00.000Z",
      url: "https://de.indeed.com/viewjob?jk=a1b2c3",
      via: "Northwind Careers",
      description: "Shape our app.",
      complete: true,
    });
    expect(postingFromIndeed({ ...indeedItem, originalApplyUrl: "https://northwind.example/apply", salary: "€50k", jobSourceName: null })).toMatchObject({
      url: "https://northwind.example/apply",
      salary: "€50k",
      via: "Indeed",
    });
  });

  it("runs its own actor", async () => {
    const apify = fakeApify({ items: [indeedItem] });
    expect((await apifyIndeed.search(query, credentials, null)).postings).toHaveLength(1);
    expect(apify.calls[0].args).toMatchObject({ actor: "curious_coder/indeed-scraper", input: indeedInput(query, 10) });
  });
});
