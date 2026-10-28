import "server-only";

import { z } from "zod";

import { defineJob } from "@/lib/jobs/runner";

import { agentScanResultSchema, runAgentScan } from "./run";

/** Keyed by agent, so the schedule and Run now find that agent's run while it's queued or running. */
export const agentJobKey = (agentId: string) => `agent:${agentId}`;

/** One run of a job agent (E16-3): one search, then scores; one source request at most. */
export const agentScanJob = defineJob({
  type: "agent-scan",
  input: z.object({ agentId: z.string().min(1), manual: z.boolean() }),
  result: agentScanResultSchema,
  run: (input, context) => runAgentScan(input, context),
});
