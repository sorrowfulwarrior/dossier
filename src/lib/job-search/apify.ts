import "server-only";

import { z } from "zod";

import type { JobSourceAdapter, RequestContext, SourceCredentials } from "./adapter";
import { runActor, withApify } from "./apify-mcp";
import { countryName } from "./countries";
import { safeLink, type FoundPosting, type PostedWithin, type SearchPage, type SearchQuery } from "./search";

// Two Apify actors as job sources, through Apify's MCP server
// (apify-mcp.ts): curious_coder's LinkedIn and Indeed scrapers. A run
// scrapes once and gives one page; there's no next one. Both are paid per
// result on the user's Apify account, so each run asks for at most
// `maxResults`.

export const APIFY_ACTORS = {
  APIFY_LINKEDIN: "curious_coder/linkedin-jobs-scraper",
  APIFY_INDEED: "curious_coder/indeed-scraper",
} as const;

type ApifySource = keyof typeof APIFY_ACTORS;

// Every field may be missing, null or of another type; one odd field doesn't drop the posting.
const text = z.union([z.string(), z.number()]).nullish().catch(null).transform((value) => (value == null ? "" : String(value).trim()));
const flag = z.boolean().nullish().catch(null);

const toIso = (value: string | number | null | undefined): string | null => {
  if (value == null || value === "") return null;
  const time = typeof value === "number" ? value : Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
};

const limited = (posting: FoundPosting): FoundPosting => ({
  ...posting,
  externalId: posting.externalId.slice(0, 500),
  title: posting.title.slice(0, 500),
  company: posting.company.slice(0, 300),
  place: posting.place.slice(0, 300),
  salary: posting.salary.slice(0, 200),
  url: posting.url.slice(0, 2000),
  via: posting.via.slice(0, 100),
  description: posting.description.slice(0, 100_000),
});

// ─── LinkedIn ────────────────────────────────────────────────────────────────

/** LinkedIn's own time filter, in seconds since posting. */
const LINKEDIN_POSTED: Record<PostedWithin, string | null> = { any: null, day: "r86400", "3days": "r259200", week: "r604800", month: "r2592000" };

const linkedinSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  title: text,
  companyName: text,
  location: text,
  link: text,
  applyUrl: text,
  workRemoteAllowed: flag,
  workplaceTypes: z.array(z.string()).nullish().catch(null),
  salaryInfo: z.union([z.string(), z.array(z.string())]).nullish().catch(null),
  postedAt: text,
  descriptionText: text,
});

/** A LinkedIn job search, as the actor reads it: the place with its country, LinkedIn's own filters. */
export function linkedinSearchUrl(query: SearchQuery): string {
  const url = new URL("https://www.linkedin.com/jobs/search/");
  url.searchParams.set("keywords", query.keywords);
  const country = query.country ? countryName(query.country) : "";
  const location = [query.place, country].filter(Boolean).join(", ");
  if (location) url.searchParams.set("location", location);
  // LinkedIn counts in miles.
  if (query.place) url.searchParams.set("distance", String(Math.max(5, Math.round(query.radiusKm / 1.609))));
  const posted = LINKEDIN_POSTED[query.postedWithin];
  if (posted) url.searchParams.set("f_TPR", posted);
  // 2 is LinkedIn's "Remote".
  if (query.remoteOnly) url.searchParams.set("f_WT", "2");
  return url.toString();
}

export function postingFromLinkedin(item: unknown): FoundPosting | null {
  const job = linkedinSchema.safeParse(item);
  if (!job.success || !job.data.id) return null;
  const { data } = job;
  const salary = Array.isArray(data.salaryInfo) ? data.salaryInfo.filter(Boolean).join("–") : (data.salaryInfo ?? "");
  const remote = data.workRemoteAllowed ?? (data.workplaceTypes?.some((type) => /remote/i.test(type)) ? true : null);
  return limited({
    source: "APIFY_LINKEDIN",
    externalId: data.id,
    title: data.title,
    company: data.companyName,
    place: data.location,
    remote,
    salary: salary.trim(),
    postedAt: toIso(data.postedAt),
    url: safeLink(data.applyUrl) || safeLink(data.link),
    via: "LinkedIn",
    description: data.descriptionText,
    complete: data.descriptionText.length > 0,
  });
}

// ─── Indeed ──────────────────────────────────────────────────────────────────

/** Indeed's own filter takes 1, 3, 7 or 14 days; a month is as close as 14 comes. */
const INDEED_POSTED: Record<PostedWithin, string> = { any: "", day: "1", "3days": "3", week: "7", month: "14" };

/** Indeed's country sites by ISO code, where the two differ. */
const INDEED_COUNTRY: Record<string, string> = { gb: "uk" };

const indeedSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String).optional().catch(undefined),
  jobKey: z.union([z.string(), z.number()]).transform(String).optional().catch(undefined),
  title: text,
  companyName: text,
  companyDetails: z.object({ name: text }).partial().nullish().catch(null),
  formattedLocation: text,
  salary: z
    .union([
      z.string(),
      z.object({ min: z.number().nullish(), max: z.number().nullish(), type: z.string().nullish(), currencyCode: z.string().nullish() }).partial(),
    ])
    .nullish()
    .catch(null),
  pubDate: z.union([z.number(), z.string()]).nullish().catch(null),
  jobDescription: text,
  originalApplyUrl: text,
  viewJobLink: text,
  jobSourceName: text,
});
type IndeedJob = z.output<typeof indeedSchema>;

const PERIODS: Record<string, string> = { YEARLY: "a year", MONTHLY: "a month", WEEKLY: "a week", DAILY: "a day", HOURLY: "an hour" };

function indeedSalary(salary: IndeedJob["salary"]): string {
  if (!salary) return "";
  if (typeof salary === "string") return salary.trim();
  const { min, max } = salary;
  if (min == null && max == null) return "";
  const amount = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 0 });
  const range = min != null && max != null && min !== max ? `${amount(min)}–${amount(max)}` : amount((min ?? max)!);
  return [salary.currencyCode, range, PERIODS[salary.type?.toUpperCase() ?? ""]].filter(Boolean).join(" ");
}

export function indeedInput(query: SearchQuery, maxResults: number): Record<string, unknown> {
  return {
    country: INDEED_COUNTRY[query.country] ?? (query.country || "us"),
    query: query.keywords,
    location: query.remoteOnly && !query.place ? "Remote" : query.place,
    ...(query.place ? { radiusKm: query.radiusKm } : {}),
    ...(INDEED_POSTED[query.postedWithin] ? { postedWithinDays: INDEED_POSTED[query.postedWithin] } : {}),
    count: maxResults,
  };
}

export function postingFromIndeed(item: unknown): FoundPosting | null {
  const job = indeedSchema.safeParse(item);
  if (!job.success) return null;
  const { data } = job;
  const id = data.id || data.jobKey;
  if (!id) return null;
  const pubDate = typeof data.pubDate === "string" && /^\d+$/.test(data.pubDate) ? Number(data.pubDate) : data.pubDate;
  return limited({
    source: "APIFY_INDEED",
    externalId: id,
    title: data.title,
    company: data.companyDetails?.name || data.companyName,
    place: data.formattedLocation,
    remote: /remote/i.test(data.formattedLocation) ? true : null,
    salary: indeedSalary(data.salary),
    postedAt: toIso(pubDate),
    url: safeLink(data.originalApplyUrl) || safeLink(data.viewJobLink),
    via: data.jobSourceName || "Indeed",
    description: data.jobDescription,
    complete: data.jobDescription.length > 0,
  });
}

// ─── The adapters ────────────────────────────────────────────────────────────

const INPUT: Record<ApifySource, (query: SearchQuery, maxResults: number) => Record<string, unknown>> = {
  APIFY_LINKEDIN: (query, maxResults) => ({ urls: [linkedinSearchUrl(query)], limitPerSource: maxResults, scrapeCompany: false }),
  APIFY_INDEED: indeedInput,
};

const POSTING: Record<ApifySource, (item: unknown) => FoundPosting | null> = {
  APIFY_LINKEDIN: postingFromLinkedin,
  APIFY_INDEED: postingFromIndeed,
};

function adapter<S extends ApifySource>(source: S): JobSourceAdapter<S> {
  const search = async (
    query: SearchQuery,
    { token, maxResults }: SourceCredentials[S],
    _next: string | null,
    context: RequestContext = {},
  ): Promise<SearchPage> => {
    const items = await withApify(
      source,
      token,
      (session) => runActor(session, source, APIFY_ACTORS[source], INPUT[source](query, maxResults), { maxItems: maxResults, signal: context.signal }),
      context,
    );
    const seen = new Set<string>();
    const postings: FoundPosting[] = [];
    for (const item of items) {
      const posting = POSTING[source](item);
      if (!posting || seen.has(posting.externalId)) continue;
      seen.add(posting.externalId);
      postings.push(posting);
    }
    return { postings, next: null };
  };
  return {
    source,
    search,
    // The scrapers give the whole description.
    details: async (posting) => (posting.description ? posting.description : null),
    // Connecting checks the token without running an actor, so it costs nothing.
    test: async ({ token }, context = {}) => withApify(source, token, async () => undefined, context),
  };
}

export const apifyLinkedin = adapter("APIFY_LINKEDIN");
export const apifyIndeed = adapter("APIFY_INDEED");
