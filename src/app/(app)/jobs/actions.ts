"use server";

import { z } from "zod";

import { action, ActionError } from "@/lib/action";
import { isAiConfigured, isAiUsable } from "@/lib/ai/config";
import { handOffFoundPosting, handsOffToClaude } from "@/lib/connector/handoff";
import { loadJobSearchConfig } from "@/lib/job-search/config";
import { fullText } from "@/lib/job-search/find";
import { foundPostingSchema, isApifySource, JOB_SOURCES, searchQuerySchema } from "@/lib/job-search/search";
import { apifySearchJob, apifySearchJobKey } from "@/lib/jobs/apify-search";
import { findUnfinishedJobs, startJob } from "@/lib/jobs/runner";
import { scoreJobKey, scorePostingJob } from "@/lib/jobs/score-posting";
import { removeSearch, runSearch, showMoreFor } from "@/lib/posting-searches";
import { dismissPosting, savePosting, storePosting, unmarkPosting } from "@/lib/postings";
import { saveSettings } from "@/lib/settings-data";

// Find jobs (E14-6). Each search is kept with what it found (E14-10).
// Postings come back from the screen as the search gave them, checked
// against the posting shape.

const postingRef = z.object({ source: z.enum(JOB_SOURCES), externalId: z.string().min(1).max(500) });
const searchId = z.string().min(1).max(100);

/** "I understand" under the Bundesagentur für Arbeit's note (#223), for a BA choice made before it, or by DOSSIER_JOBS_SOURCE. */
export const acceptArbeitsagenturNote = action(z.object({}), async () => {
  const { arbeitsagentur } = await loadJobSearchConfig();
  if (!arbeitsagentur.offered) throw new ActionError("The Bundesagentur für Arbeit isn't offered on this server.");
  await saveSettings({ arbeitsagenturAcceptedAt: new Date().toISOString() });
  return null;
});

/**
 * "Search": asks the source chosen here, else the one in Settings, and keeps
 * the search with what it found; gives its id, or what went wrong. LinkedIn
 * and Indeed on Apify take a minute or two, so they run as a job instead,
 * whose result is the same.
 */
export const runJobSearch = action(
  z.object({ query: searchQuerySchema, source: z.enum(JOB_SOURCES).optional() }),
  async ({ query, source }): Promise<Awaited<ReturnType<typeof runSearch>> | { ok: true; jobId: string }> => {
    if (!source || !isApifySource(source)) return runSearch(query, { source });
    if (!query.country) return { ok: false, problem: "no-country", message: "Choose a country to search in." };
    const key = apifySearchJobKey(source, query);
    const [unfinished] = await findUnfinishedJobs(key);
    return { ok: true, jobId: unfinished?.id ?? (await startJob(apifySearchJob, { source, query }, { key })) };
  },
);

/** "Show more": the next page, added to the kept search. */
export const showMorePostings = action(z.object({ searchId }), ({ searchId }) => showMoreFor(searchId));

/** Removes a kept search and what it found; saved postings stay. */
export const removeJobSearch = action(z.object({ id: searchId }), async ({ id }, { toast }) => {
  await removeSearch(id);
  toast("Search removed. Saved postings from it stay in Saved.");
  return null;
});

/** The whole text of a posting the search only gave the start of; null when it can't be had. */
export const loadFullText = action(z.object({ posting: foundPostingSchema }), async ({ posting }) => ({ text: await fullText(posting) }));

export const savePostingForLater = action(z.object({ posting: foundPostingSchema }), async ({ posting }, { toast }) => {
  const saved = await savePosting(posting);
  toast("Saved for later.");
  return { postingId: saved.id };
});

export const unsavePosting = action(postingRef, async (ref, { toast }) => {
  await unmarkPosting(ref, "saved");
  toast("Removed from Saved.");
  return null;
});

/** Dismiss: out of this and later searches. Says whether it was saved, so Undo can put it back. */
export const dismissFoundPosting = action(z.object({ posting: foundPostingSchema }), ({ posting }) => dismissPosting(posting));

/**
 * "Start application" (E14-8): keeps the posting with its whole text when it
 * can be had, for New application to open from its id.
 */
export const startApplicationFrom = action(z.object({ posting: foundPostingSchema }), async ({ posting }) => {
  const text = await fullText(posting);
  const stored = await storePosting(text ? { ...posting, description: text, complete: true } : posting);
  return { postingId: stored.id };
});

/** Brings a dismissed posting back, into Saved again when it was there (Undo). */
export const restorePosting = action(postingRef.extend({ saved: z.boolean() }), async ({ saved, ...ref }) => {
  await unmarkPosting(ref, "dismissed", { saved });
  return null;
});

/**
 * "Score" (#208): how well a posting fits the profile, in the background; a
 * scoring under way is followed, not started again. With the Claude connector
 * on and no AI model of Dossier's own, a Claude chat scores it instead (#221).
 */
export const startScoringPosting = action(z.object({ posting: foundPostingSchema }), async ({ posting }): Promise<{ jobId: string } | { handoff: string }> => {
  if (await handsOffToClaude(await isAiUsable())) return { handoff: await handOffFoundPosting(posting, "score") };
  if (!(await isAiConfigured())) throw new ActionError("Choose an AI provider in Settings → AI provider first.");
  const key = scoreJobKey(posting);
  const [unfinished] = await findUnfinishedJobs(key);
  return { jobId: unfinished?.id ?? (await startJob(scorePostingJob, { posting }, { key })) };
});
