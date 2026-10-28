import "server-only";

import { Client, SdkHttpError, StreamableHTTPClientTransport, UnauthorizedError } from "@modelcontextprotocol/client";
import { z } from "zod";

import { appVersion } from "@/lib/version";

import { jobSearchError } from "./errors";
import type { JobSource } from "./search";

// Apify, through its MCP server (mcp.apify.com): an actor is started with
// call-actor, followed with get-actor-run until it's done, and its results
// read with get-dataset-items. Only those three tools are loaded. Each run
// costs on the user's Apify account, so every run is capped.

export const APIFY_MCP_URL = "https://mcp.apify.com";
const TOOLS = ["call-actor", "get-actor-run", "get-dataset-items"] as const;

/** How long one tool call may wait on the server, in seconds (Apify's own limit). */
const WAIT_SECS = 45;
/** How long a run may take, in all: the actor is stopped after this too. */
export const APIFY_RUN_TIMEOUT_SECS = 300;
/** Each call waits up to WAIT_SECS on the server, so it gets some time over that. */
const CALL_TIMEOUT_MS = (WAIT_SECS + 30) * 1000;

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"]);

const runSchema = z.object({
  runId: z.string().min(1),
  status: z.string(),
  storages: z.object({ datasets: z.object({ default: z.object({ id: z.string().min(1) }) }).partial() }).partial().optional(),
});
const itemsSchema = z.object({ items: z.array(z.unknown()) });

type ToolAnswer = { content?: unknown; structuredContent?: unknown; isError?: boolean };

/** The text of a tool's answer, for its error and when there's no structured content. */
const textOf = (answer: ToolAnswer) =>
  (Array.isArray(answer.content) ? answer.content : [])
    .map((block: unknown) => (block && typeof block === "object" && "text" in block && typeof block.text === "string" ? block.text : ""))
    .join("\n");

/** The structured answer, else the first text block read as JSON. */
function dataOf(answer: ToolAnswer): unknown {
  if (answer.structuredContent) return answer.structuredContent;
  const first = (Array.isArray(answer.content) ? answer.content : [])[0] as { text?: unknown } | undefined;
  if (typeof first?.text !== "string") return null;
  try {
    return JSON.parse(first.text) as unknown;
  } catch {
    return null;
  }
}

export type ApifySession = {
  /** Calls one of TOOLS; a tool's own error becomes a JobSearchError. */
  call: (name: (typeof TOOLS)[number], args: Record<string, unknown>) => Promise<unknown>;
};

/** Turns what the MCP client throws into a JobSearchError for `source`. */
function failure(source: JobSource, error: unknown): Error {
  if (error instanceof Error && error.name === "JobSearchError") return error;
  if (error instanceof UnauthorizedError) return jobSearchError("key", source, { detail: "mcp: unauthorized" });
  if (error instanceof SdkHttpError) {
    const detail = `mcp: HTTP ${error.status}`;
    if (error.status === 401 || error.status === 403) return jobSearchError("key", source, { detail });
    if (error.status === 429) return jobSearchError("quota", source, { detail });
    return jobSearchError(error.status >= 500 ? "unavailable" : "changed", source, { detail });
  }
  const reason = error instanceof Error ? error.name : "request failed";
  return jobSearchError("unavailable", source, { detail: `mcp: ${reason}` });
}

/** A tool's error, as a problem the user can act on: a used-up plan, or the source failing. */
function toolFailure(source: JobSource, name: string, text: string): Error {
  const detail = `mcp ${name}: tool error`;
  if (/credit|usage limit|monthly limit|memory limit|quota|payment|insufficient/i.test(text)) return jobSearchError("quota", source, { detail });
  if (/token|unauthori[sz]ed|permission/i.test(text)) return jobSearchError("key", source, { detail });
  return jobSearchError("unavailable", source, { detail });
}

/** Opens a session with Apify's MCP server for `source`, runs `work` in it, and closes it. */
export async function withApify<T>(
  source: JobSource,
  token: string,
  work: (session: ApifySession) => Promise<T>,
  { baseUrl, signal }: { baseUrl?: string; signal?: AbortSignal } = {},
): Promise<T> {
  const url = new URL(baseUrl ?? APIFY_MCP_URL);
  url.searchParams.set("tools", TOOLS.join(","));
  url.searchParams.set("telemetry-enabled", "false");
  const transport = new StreamableHTTPClientTransport(url, { authProvider: { token: async () => token } });
  const client = new Client({ name: "dossier", version: appVersion });
  try {
    await client.connect(transport, { signal });
  } catch (error) {
    throw failure(source, error);
  }
  try {
    return await work({
      call: async (name, args) => {
        let answer: ToolAnswer;
        try {
          answer = (await client.callTool({ name, arguments: args }, { signal, timeout: CALL_TIMEOUT_MS })) as ToolAnswer;
        } catch (error) {
          throw failure(source, error);
        }
        if (answer.isError) throw toolFailure(source, name, textOf(answer));
        return dataOf(answer);
      },
    });
  } finally {
    await client.close().catch(() => undefined);
  }
}

/**
 * Runs `actor` with `input` and gives its results, at most `maxItems`. The
 * actor's own input should cap the work too: maxItems only caps what's billed.
 */
export async function runActor(
  session: ApifySession,
  source: JobSource,
  actor: string,
  input: Record<string, unknown>,
  { maxItems, signal }: { maxItems: number; signal?: AbortSignal },
): Promise<unknown[]> {
  const started = runSchema.safeParse(
    await session.call("call-actor", { actor, input, waitSecs: WAIT_SECS, callOptions: { maxItems, timeout: APIFY_RUN_TIMEOUT_SECS } }),
  );
  if (!started.success) throw jobSearchError("changed", source, { detail: "mcp call-actor: unexpected answer" });
  let run = started.data;
  const deadline = Date.now() + (APIFY_RUN_TIMEOUT_SECS + 60) * 1000;
  while (!TERMINAL.has(run.status)) {
    if (signal?.aborted) throw jobSearchError("unavailable", source, { detail: "mcp: stopped" });
    if (Date.now() > deadline) throw jobSearchError("unavailable", source, { detail: "mcp: run took too long" });
    const next = runSchema.safeParse(await session.call("get-actor-run", { runId: run.runId, waitSecs: WAIT_SECS }));
    if (!next.success) throw jobSearchError("changed", source, { detail: "mcp get-actor-run: unexpected answer" });
    run = next.data;
  }
  // A run that ran out of time may still have found some.
  if (run.status !== "SUCCEEDED" && run.status !== "TIMED-OUT") throw jobSearchError("unavailable", source, { detail: `mcp: run ${run.status}` });
  const datasetId = run.storages?.datasets?.default?.id;
  if (!datasetId) return [];
  const items = itemsSchema.safeParse(await session.call("get-dataset-items", { datasetId, limit: maxItems, clean: true }));
  if (!items.success) throw jobSearchError("changed", source, { detail: "mcp get-dataset-items: unexpected answer" });
  return items.data.items.slice(0, maxItems);
}
