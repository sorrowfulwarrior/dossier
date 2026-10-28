"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import { useTrackSave } from "@/components/save-tracker";
import { toastResult } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Toggle } from "@/components/ui/toggle";
import { useAutosave } from "@/hooks/use-autosave";
import type { Country } from "@/lib/job-search/countries";
import { searchHref, type JobSource, type SearchQuery } from "@/lib/job-search/search";
import type { JobKeyState } from "@/lib/job-search/sources";

import { createJobAgent, deleteJobAgent, saveJobAgent } from "../agent/actions";
import { RemoteOnlyField, SearchFields, type SearchFieldErrors } from "../jobs/search-fields";
import { ApifySection } from "./apify-section";
import { SettingsSectionIntro } from "./settings-screen";

export type AgentSettings = {
  id: string;
  name: string;
  source: JobSource;
  enabled: boolean;
  query: SearchQuery;
  hour: number;
  minScore: number;
  maxScores: number;
  maxDrafts: number;
  autoDraft: boolean;
};

/** A source an agent may search, and whether its key is in place. */
export type AgentSourceChoice = { source: JobSource; name: string; ready: boolean };

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const MIN_SCORES = [50, 55, 60, 65, 70, 75, 80, 85, 90];
const SCORE_COUNTS = Array.from({ length: 30 }, (_, index) => index + 1);
const DRAFT_COUNTS = Array.from({ length: 11 }, (_, index) => index);
const clock = (hour: number) => `${String(hour).padStart(2, "0")}:00`;
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const nameOf = (agent: Pick<AgentSettings, "name" | "query">) => agent.name.trim() || agent.query.keywords.trim() || "New job agent";

/**
 * Settings → Job agent (E16-7): the agents, one per job title, each with
 * its own source, search, hour and limits; then the Apify token they and
 * Find jobs use for LinkedIn and Indeed. Each change saves at once; a search
 * once typing pauses.
 */
export function AgentSection({
  agents: initial,
  sources,
  newQuery,
  aiReady,
  countries,
  timeZone,
  apify,
}: {
  agents: AgentSettings[];
  /** The sources an agent may search (never the Bundesagentur für Arbeit). */
  sources: readonly AgentSourceChoice[];
  /** Where a new agent's search starts: the last one in Find jobs. */
  newQuery: SearchQuery;
  aiReady: boolean;
  countries: readonly Country[];
  /** The user's time zone, which the hour is in. */
  timeZone: string;
  apify: { keyState: JobKeyState; maxResults: number };
}) {
  const router = useRouter();
  const [agents, setAgents] = useState(initial);
  const [open, setOpen] = useState<string | null>(initial.length === 1 ? initial[0].id : null);
  const [deleting, setDeleting] = useState<AgentSettings | null>(null);
  const [pending, startTransition] = useTransition();
  const firstReady = sources.find((choice) => choice.ready)?.source ?? sources[0]?.source ?? "JSEARCH";

  const add = () =>
    startTransition(async () => {
      const result = toastResult(await createJobAgent({ source: firstReady, query: newQuery }));
      if (!result.ok) return;
      const { id, name, source, enabled, query, hour, minScore, maxScores, maxDrafts, autoDraft } = result.data;
      setAgents((current) => [...current, { id, name, source, enabled, query, hour, minScore, maxScores, maxDrafts, autoDraft }]);
      setOpen(id);
    });

  const remove = (agent: AgentSettings) =>
    startTransition(async () => {
      if (!toastResult(await deleteJobAgent({ id: agent.id })).ok) return;
      setAgents((current) => current.filter((entry) => entry.id !== agent.id));
      router.refresh();
    });

  return (
    <>
      <SettingsSectionIntro title="Job agent">
        Each agent runs one search a day, for one job title on the source you choose, scores the new postings against your profile, and keeps the best on
        the Agent screen. They never send or apply.
      </SettingsSectionIntro>

      {!aiReady && (
        <p role="note" className="rounded-card bg-warning-surface px-4 py-3 text-meta text-warning">
          The agents score postings with the AI provider in{" "}
          <Link href="/settings?section=ai" className="font-medium text-warning underline underline-offset-2">
            Settings → AI provider
          </Link>
          , which isn&apos;t set up yet. Choose one first.
        </p>
      )}

      {agents.length === 0 && (
        <Card padding="none" className="px-7 py-5 text-sm text-muted">
          No job agents yet. Add one for each job title you&apos;re looking for.
        </Card>
      )}

      <ul className="flex flex-col gap-3">
        {agents.map((agent) => (
          <li key={agent.id}>
            <AgentCard
              initial={agent}
              open={open === agent.id}
              onToggle={() => setOpen(open === agent.id ? null : agent.id)}
              onChange={(next) => setAgents((current) => current.map((entry) => (entry.id === next.id ? next : entry)))}
              onDelete={() => setDeleting(agent)}
              sources={sources}
              countries={countries}
              timeZone={timeZone}
            />
          </li>
        ))}
      </ul>

      <Button variant="secondary" className="self-start" aria-disabled={pending || undefined} onClick={() => !pending && add()}>
        Add agent
      </Button>

      <p className="text-meta text-muted">
        Each agent searches at most three times in any 24 hours. Scoring and drafts go to your AI provider with your profile, as a new application does; the
        job source only gets the search.
      </p>

      <ApifySection initial={apify} />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(value) => !value && setDeleting(null)}
        title={`Delete ${deleting ? nameOf(deleting) : "this agent"}?`}
        description="It stops searching. What it found stays on the Agent screen, and those postings won't come back."
        confirmLabel="Delete agent"
        onConfirm={() => {
          if (deleting) remove(deleting);
          setDeleting(null);
        }}
      />
    </>
  );
}

/** One agent: a line with its name, source and switch, and its settings when open. */
function AgentCard({
  initial,
  open,
  onToggle,
  onChange,
  onDelete,
  sources,
  countries,
  timeZone,
}: {
  initial: AgentSettings;
  open: boolean;
  onToggle: () => void;
  onChange: (agent: AgentSettings) => void;
  onDelete: () => void;
  sources: readonly AgentSourceChoice[];
  countries: readonly Country[];
  timeZone: string;
}) {
  const track = useTrackSave();
  const [settings, setSettings] = useState(initial);
  const [errors, setErrors] = useState<SearchFieldErrors>({});
  const source = sources.find((choice) => choice.source === settings.source);

  const update = (next: AgentSettings) => {
    setSettings(next);
    onChange(next);
  };
  const change = (patch: Partial<Omit<AgentSettings, "id">>) => {
    const previous = settings;
    update({ ...settings, ...patch });
    void track(saveJobAgent({ id: settings.id, ...patch })).then((result) => {
      if (!toastResult(result).ok) update(previous);
    });
  };
  // One value for the hook, made again only when the search or name changes.
  const typed = useMemo(() => ({ query: settings.query, name: settings.name }), [settings.query, settings.name]);
  const { flush } = useAutosave(typed, ({ query, name }) => track(saveJobAgent({ id: settings.id, query, name })));
  const setQuery = (patch: Partial<SearchQuery>) => {
    setErrors({});
    update({ ...settings, query: { ...settings.query, ...patch } });
  };

  const turnOn = (on: boolean) => {
    if (on) {
      const problems = {
        keywords: settings.query.keywords.trim() ? undefined : "Type what the agent should look for.",
        country: settings.query.country ? undefined : "Choose a country.",
      };
      setErrors(problems);
      if (problems.keywords || problems.country) {
        if (!open) onToggle();
        return;
      }
      // With it, so a search typed a moment ago is saved too.
      return change({ enabled: true, query: settings.query });
    }
    change({ enabled: false });
  };

  const panelId = `agent-${settings.id}`;
  return (
    <Card padding="none" className="flex flex-col">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 px-7 py-4">
        <button type="button" aria-expanded={open} aria-controls={panelId} onClick={onToggle} className="flex min-w-0 flex-1 flex-col gap-[3px] text-left">
          <span className="text-field font-medium">{nameOf(settings)}</span>
          <span className="text-meta text-muted">
            {source?.name ?? settings.source} · {settings.enabled ? `Runs daily after ${clock(settings.hour)}` : "Off"}
          </span>
        </button>
        <Toggle label={`Run ${nameOf(settings)}`} className="[&_label]:sr-only" checked={settings.enabled} onCheckedChange={turnOn} />
        <Button variant="text" size="sm" aria-expanded={open} aria-controls={panelId} onClick={onToggle}>
          {open ? "Done" : "Edit"}
        </Button>
      </div>

      {open && (
        <div id={panelId} className="flex flex-col gap-6 border-t border-line px-7 py-[26px]">
          {source && !source.ready && (
            <p role="note" className="rounded-card bg-warning-surface px-4 py-3 text-meta text-warning">
              {source.name} needs {source.source.startsWith("APIFY_") ? "your Apify token, below" : "its key in "}
              {!source.source.startsWith("APIFY_") && (
                <Link href="/settings?section=jobs" className="font-medium text-warning underline underline-offset-2">
                  Settings → Job search
                </Link>
              )}
              . It doesn&apos;t run until then.
            </p>
          )}

          <div className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2" onBlur={flush}>
            <Input
              label="Name"
              value={settings.name}
              placeholder={settings.query.keywords.trim() || "e.g. Data scientist in Berlin"}
              hint="Shown on the Agent screen; its search when empty."
              onChange={(event) => update({ ...settings, name: event.target.value })}
            />
            <Select
              label="Source"
              value={settings.source}
              hint="Where this agent searches. LinkedIn and Indeed run on Apify, paid per result."
              onChange={(event) => change({ source: event.target.value as JobSource })}
            >
              {sources.map((choice) => (
                <option key={choice.source} value={choice.source}>
                  {choice.name}
                  {choice.ready ? "" : " (needs a key)"}
                </option>
              ))}
            </Select>
          </div>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <h3 className="text-field font-medium">What it looks for</h3>
              <p className="text-meta text-muted">
                The same search as in{" "}
                <Link href={searchHref(settings.query)} className="font-medium text-ink underline underline-offset-2">
                  Find jobs
                </Link>
                . Postings you saved, dismissed or applied for there, or that another agent found, are left out.
              </p>
            </div>
            <div className="grid grid-cols-1 items-start gap-x-4 gap-y-4 sm:grid-cols-2" onBlur={flush}>
              <SearchFields value={settings.query} onChange={setQuery} source={settings.source} countries={countries} errors={errors} />
              <div className="sm:col-span-2">
                <RemoteOnlyField value={settings.query} onChange={setQuery} source={settings.source} />
              </div>
            </div>
          </div>

          <div className="grid gap-x-[18px] gap-y-5 sm:grid-cols-2">
            <Select label="Runs after" hint={`Your time (${timeZone})`} value={String(settings.hour)} onChange={(event) => change({ hour: Number(event.target.value) })}>
              {HOURS.map((hour) => (
                <option key={hour} value={hour}>
                  {clock(hour)}
                </option>
              ))}
            </Select>
            <Select
              label="Minimum score"
              hint="Postings scored lower stay out of the queue."
              value={String(settings.minScore)}
              onChange={(event) => change({ minScore: Number(event.target.value) })}
            >
              {[...new Set([...MIN_SCORES, settings.minScore])].sort((a, b) => a - b).map((score) => (
                <option key={score} value={score}>
                  {score} of 100
                </option>
              ))}
            </Select>
            <Select label="Postings scored per run" value={String(settings.maxScores)} onChange={(event) => change({ maxScores: Number(event.target.value) })}>
              {SCORE_COUNTS.map((count) => (
                <option key={count} value={count}>
                  {count}
                </option>
              ))}
            </Select>
            <Select
              label="Drafts per run, at most"
              value={String(settings.maxDrafts)}
              disabled={!settings.autoDraft}
              hint={settings.autoDraft ? undefined : "Turn on Prepare drafts on its own first"}
              onChange={(event) => change({ maxDrafts: Number(event.target.value) })}
            >
              {DRAFT_COUNTS.map((count) => (
                <option key={count} value={count}>
                  {count}
                </option>
              ))}
            </Select>
            <Toggle
              className="sm:col-span-2"
              label="Prepare drafts on its own"
              description={
                settings.autoDraft
                  ? `For the best new postings of each run, up to ${plural(settings.maxDrafts, "draft", "drafts")}: a tailored resume and cover letter, waiting for your review.`
                  : "Off. You choose which postings get a draft with Prepare draft."
              }
              checked={settings.autoDraft}
              onCheckedChange={(autoDraft) => change({ autoDraft })}
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <p className="text-meta text-muted">
              Each run scores up to {plural(settings.maxScores, "posting", "postings")}
              {settings.autoDraft ? ` and prepares up to ${plural(settings.maxDrafts, "draft", "drafts")}` : ""}.
            </p>
            <Button variant="danger-text" size="sm" onClick={onDelete}>
              Delete agent
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
