"use client";

import { useState } from "react";

import { useTrackSave } from "@/components/save-tracker";
import { toastResult } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { APIFY_ACTOR_URLS, APIFY_MAX_RESULTS, APIFY_TOKEN_URL, type JobKeyState } from "@/lib/job-search/sources";

import { saveJobSearchDetails, saveJobSourceKey, testJobSource } from "./actions";
import { ConnectionStatus, KeyField, type Connection } from "./job-search-section";

/**
 * Settings → Job agent → Apify: the token for the LinkedIn and Indeed
 * scrapers, which agents and Find jobs run through Apify's MCP server, and
 * how many results a run may ask for. Runs are paid on the user's own Apify
 * account; the test only connects, so it costs nothing.
 */
export function ApifySection({ initial }: { initial: { keyState: JobKeyState; maxResults: number } }) {
  const track = useTrackSave();
  const [view, setView] = useState(initial);
  const [connection, setConnection] = useState<Connection>({ status: "untested" });

  const saveKey = async (change: { action: "set"; value: string } | { action: "clear" }) => {
    setConnection({ status: "untested" });
    const result = toastResult(await track(saveJobSourceKey({ source: "APIFY", change })));
    if (result.ok) setView(result.data.apify);
    return result.ok;
  };

  const chooseMax = async (maxResults: (typeof APIFY_MAX_RESULTS)[number]) => {
    const previous = view;
    setView({ ...view, maxResults });
    const result = toastResult(await track(saveJobSearchDetails({ apifyMaxResults: maxResults })));
    setView(result.ok ? result.data.apify : previous);
  };

  const test = async () => {
    if (connection.status === "testing") return;
    setConnection({ status: "testing" });
    const result = await testJobSource({ source: "APIFY_LINKEDIN" });
    if (!result.ok) setConnection({ status: "failed", message: result.error });
    else if (result.data.connected) setConnection({ status: "connected", seconds: result.data.seconds });
    else setConnection({ status: "failed", message: result.data.message });
  };

  return (
    <section aria-labelledby="apify-heading" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h3 id="apify-heading" className="font-serif text-section">
          Apify
        </h3>
        <p className="text-meta text-muted">
          LinkedIn and Indeed, scraped by{" "}
          <a href={APIFY_ACTOR_URLS.APIFY_LINKEDIN} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-ink">
            curious_coder/linkedin-jobs-scraper
          </a>{" "}
          and{" "}
          <a href={APIFY_ACTOR_URLS.APIFY_INDEED} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-ink">
            curious_coder/indeed-scraper
          </a>{" "}
          on your Apify account, through Apify&apos;s MCP server. Choose them as an agent&apos;s source above, or in Find jobs.
        </p>
      </div>
      <Card className="flex flex-col gap-5">
        <div className="grid grid-cols-1 items-start gap-x-[18px] gap-y-5 sm:grid-cols-2">
          <KeyField
            label="API token"
            keyState={view.keyState}
            envName="DOSSIER_APIFY_TOKEN"
            getKey={{ href: APIFY_TOKEN_URL, text: "Apify's console, under Integrations" }}
            onSave={saveKey}
          />
          <Select
            label="Results per run, at most"
            hint="Apify charges per result: this caps what each run can cost."
            value={String(view.maxResults)}
            onChange={(event) => void chooseMax(Number(event.target.value) as (typeof APIFY_MAX_RESULTS)[number])}
          >
            {[...new Set([...APIFY_MAX_RESULTS, view.maxResults])].sort((a, b) => a - b).map((count) => (
              <option key={count} value={count}>
                {count}
              </option>
            ))}
          </Select>
        </div>
        <p role="note" className="rounded-card bg-warning-surface px-4 py-3 text-meta text-warning">
          Each search runs a scraper on Apify, which takes a minute or two and is billed to your Apify account, at most {view.maxResults} results a run.
          Your searches go to Apify and the site it scrapes; nothing from your profile does.
        </p>
        {view.keyState !== "none" && view.keyState !== "unreadable" && (
          <div className="flex flex-wrap items-center gap-3.5 pt-1">
            <Button variant="secondary" onClick={() => void test()} disabled={connection.status === "testing"}>
              {connection.status === "testing" ? "Testing…" : "Test connection"}
            </Button>
            <ConnectionStatus connection={connection} source="APIFY_LINKEDIN" />
          </div>
        )}
      </Card>
    </section>
  );
}
