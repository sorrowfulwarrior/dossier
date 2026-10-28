import "server-only";

import { z } from "zod";

import { APIFY_SOURCES, searchQuerySchema } from "@/lib/job-search/search";
import { SOURCE_INFO } from "@/lib/job-search/sources";
import { runSearch } from "@/lib/posting-searches";

import { defineJob } from "./runner";

/** The key of an Apify search, so asking again follows the run under way rather than paying for another. */
export const apifySearchJobKey = (source: string, query: unknown) => `apify-search:${source}:${JSON.stringify(query)}`;

/**
 * A Find jobs search on LinkedIn or Indeed through Apify: its scraper takes
 * a minute or two, too long to wait for in a request, so it's a job. It's
 * kept like any search; a problem with the source is its result, not a
 * failure, so the screen can say what to do.
 */
export const apifySearchJob = defineJob({
  type: "apify-search",
  input: z.object({ source: z.enum(APIFY_SOURCES), query: searchQuerySchema }),
  result: z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), id: z.string() }), z.object({ ok: z.literal(false), problem: z.string(), message: z.string() })]),
  async run({ source, query }, { step, signal }) {
    await step(`Running the ${SOURCE_INFO[source].name} scraper, which takes a minute or two`);
    const outcome = await runSearch(query, { source, signal });
    return outcome.ok ? { ok: true as const, id: outcome.id } : { ok: false as const, problem: outcome.problem, message: outcome.message };
  },
});
