"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";

import { PageHeader } from "@/components/page-header";
import { ScoreBadge } from "@/components/score-badge";
import { linksAttribution, SourceAttribution } from "@/components/source-attribution";
import { toast, toastResult } from "@/components/toast";
import { Button, buttonClassName } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ToggleChip } from "@/components/ui/chip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useJob } from "@/hooks/use-job";
import type { AgentCandidateView, AgentSummary, AgentView } from "@/lib/agent/view";

import { approveAgentDraft, dismissAgentCandidate, prepareAgentDraft, restoreAgentCandidate, runAgentNow } from "./actions";

type ScanResult = { message: string };
type DraftResult = { applicationId: string };

const SETTINGS: Record<NonNullable<AgentSummary["setupSection"]>, { href: string; label: string }> = {
  agent: { href: "/settings?section=agent", label: "Settings → Job agent" },
  ai: { href: "/settings?section=ai", label: "Settings → AI provider" },
  jobs: { href: "/settings?section=jobs", label: "Settings → Job search" },
};

/**
 * The Agent screen (E16-6): each job agent, what it searches and when it
 * runs, then the drafts they prepared and the postings they scored, waiting
 * for a look, for all of them or one. Nothing here sends anything.
 */
export function AgentScreen({ view }: { view: AgentView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [showBelow, setShowBelow] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState<AgentCandidateView | null>(null);
  const [only, setOnly] = useState<string | null>(null);

  const hide = (id: string, gone: boolean) =>
    setHidden((current) => {
      const next = new Set(current);
      if (gone) next.add(id);
      else next.delete(id);
      return next;
    });

  const dismiss = (candidate: AgentCandidateView) =>
    startTransition(async () => {
      hide(candidate.id, true);
      const result = await dismissAgentCandidate({ candidateId: candidate.id });
      if (!result.ok) {
        hide(candidate.id, false);
        return toast(result.error);
      }
      const undo = result.data.undo;
      if (!undo) return toast("Dismissed, with its draft. It won't come back.");
      toast("Dismissed. It won't come back.", {
        action: {
          label: "Undo",
          onClick: () =>
            void restoreAgentCandidate({ ...undo, reasons: stringList(undo.reasons), redFlags: stringList(undo.redFlags) }).then((restored) => {
              if (!toastResult(restored).ok) return;
              hide(candidate.id, false);
              router.refresh();
            }),
        },
      });
      router.refresh();
    });

  const shown = (candidate: AgentCandidateView) => !hidden.has(candidate.id) && (only === null || candidate.agentId === only);
  const drafts = view.drafts.filter(shown);
  const scored = view.scored.filter(shown);
  const below = view.belowMinimum.filter(shown);
  const empty = drafts.length === 0 && scored.length === 0;
  const named = view.agents.length > 1;

  return (
    <>
      <PageHeader
        title="Job agent"
        description="Each agent searches once a day for one job title, scores the new postings against your profile, and keeps the best here for you. Drafts wait for your review, and nothing is ever sent."
        actions={
          <Link href={SETTINGS.agent.href} className={buttonClassName("secondary", "md")}>
            {view.agents.length === 0 ? "Add an agent" : "Manage agents"}
          </Link>
        }
      />
      <div className="flex flex-col gap-8 px-10 pb-20">
        {view.agents.length === 0 ? (
          <p role="note" className="rounded-card bg-warning-surface px-4 py-3 text-meta text-warning">
            No job agents yet.{" "}
            <Link href={SETTINGS.agent.href} className="font-medium text-warning underline underline-offset-2">
              Add one in Settings → Job agent
            </Link>
            {view.drafts.length + view.scored.length > 0 && ". What earlier ones found is still here."}
          </p>
        ) : (
          <ul aria-label="Job agents" className="flex flex-col gap-3">
            {view.agents.map((agent) => (
              <li key={agent.id}>
                <AgentCard agent={agent} />
              </li>
            ))}
          </ul>
        )}

        {named && (
          <div role="group" aria-label="Show postings from" className="flex flex-wrap gap-2">
            <ToggleChip selected={only === null} onClick={() => setOnly(null)}>
              All agents
            </ToggleChip>
            {view.agents.map((agent) => (
              <ToggleChip key={agent.id} selected={only === agent.id} onClick={() => setOnly(only === agent.id ? null : agent.id)}>
                {agent.name}
              </ToggleChip>
            ))}
          </div>
        )}

        <Section title="Drafts to review" count={drafts.length}>
          {drafts.length === 0 ? (
            <Empty>
              {view.autoDraft
                ? "No drafts yet. After a run, the best new postings get a draft here."
                : "No drafts yet. Prepare one from a scored posting, or let an agent prepare them in Settings → Job agent."}
            </Empty>
          ) : (
            <ul className="flex flex-col gap-3">
              {drafts.map((candidate) => (
                <li key={candidate.id}>
                  <CandidateCard candidate={candidate} named={named}>
                    <Link href={`/applications/${candidate.applicationId}`} className={buttonClassName("primary", "sm", "hover:text-on-primary")}>
                      Review draft
                    </Link>
                    <Button
                      variant="secondary"
                      size="sm"
                      aria-disabled={pending || undefined}
                      onClick={() =>
                        startTransition(async () => {
                          if (toastResult(await approveAgentDraft({ candidateId: candidate.id })).ok) router.refresh();
                        })
                      }
                    >
                      Approve
                    </Button>
                    <OpenPosting url={candidate.url} />
                    <Button variant="danger-text" size="sm" className="ml-auto" onClick={() => setConfirming(candidate)}>
                      Dismiss
                    </Button>
                  </CandidateCard>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Scored postings" count={scored.length}>
          {scored.length === 0 ? (
            <Empty>{empty ? "Nothing waiting yet. A run puts the postings that fit you best here." : "No postings waiting for a draft."}</Empty>
          ) : (
            <ul className="flex flex-col gap-3">
              {scored.map((candidate) => (
                <li key={candidate.id}>
                  <ScoredCard candidate={candidate} named={named} onDismiss={() => dismiss(candidate)} />
                </li>
              ))}
            </ul>
          )}
          {below.length > 0 && (
            <div className="flex flex-col gap-3">
              <button type="button" aria-expanded={showBelow} onClick={() => setShowBelow(!showBelow)} className="w-fit text-meta text-muted underline underline-offset-2 hover:text-ink">
                {below.length} below {minimumText(view, only)} · {showBelow ? "Hide" : "Show"}
              </button>
              {showBelow && (
                <ul className="flex flex-col gap-3">
                  {below.map((candidate) => (
                    <li key={candidate.id}>
                      <ScoredCard candidate={candidate} named={named} onDismiss={() => dismiss(candidate)} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Section>
      </div>

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
        title="Dismiss this draft?"
        description="Its resume, cover letter and chat are deleted, and the posting won't come back."
        confirmLabel="Dismiss draft"
        onConfirm={() => {
          if (confirming) dismiss(confirming);
          setConfirming(null);
        }}
      />
    </>
  );
}

/** "your minimum score of 70", or "their agents' minimum scores" when the agents differ. */
function minimumText(view: AgentView, only: string | null): string {
  const scores = new Set((only ? view.agents.filter((agent) => agent.id === only) : view.agents).map((agent) => agent.minScore));
  return scores.size === 1 ? `your minimum score of ${[...scores][0]}` : "their agents' minimum scores";
}

/** One agent: what it searches, its runs, why it isn't running, and Run now. */
function AgentCard({ agent }: { agent: AgentSummary }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [runJobId, setRunJobId] = useState(agent.runJobId);
  const run = useJob<ScanResult>(runJobId, 0, (job) => {
    if (job.status !== "DONE" && job.status !== "FAILED") return;
    setRunJobId(null);
    toast(job.status === "DONE" ? (job.result?.message ?? "The run is done.") : (job.error ?? "The run didn't finish."));
    router.refresh();
  });
  const running = Boolean(runJobId) && (!run || run.status === "QUEUED" || run.status === "RUNNING");

  const runNow = () =>
    startTransition(async () => {
      const result = toastResult(await runAgentNow({ agentId: agent.id }));
      if (result.ok) setRunJobId(result.data.jobId);
    });

  return (
    <Card padding="none" className="flex flex-col px-7 py-2">
      <div className="flex flex-wrap items-center justify-between gap-3 py-3.5">
        <h2 className="font-serif text-[20px] leading-tight">{agent.name}</h2>
        <Button
          size="sm"
          aria-label={running ? undefined : `Run now ${agent.name}`}
          aria-disabled={running || pending || undefined}
          onClick={() => !running && !pending && runNow()}
        >
          {running ? "Running…" : "Run now"}
        </Button>
      </div>
      <Notices agent={agent} />
      <dl>
        <Fact label="Searches for">{agent.search ?? "Nothing yet"}</Fact>
        <Fact label="Last run">
          {agent.lastRun ? (
            <>
              {agent.lastRun.at}
              {agent.lastRun.message && <span className="block text-muted">{agent.lastRun.message}</span>}
            </>
          ) : (
            "Not yet"
          )}
        </Fact>
        <Fact label="Next run">{agent.nextRun ?? "Off"}</Fact>
      </dl>
      {running && (
        <p role="status" className="border-t border-line py-3.5 text-sm text-muted">
          {run?.step ?? "Starting the run…"}
        </p>
      )}
    </Card>
  );
}

const stringList = (value: unknown): string[] | null => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : null);

/** Why the agent isn't running, and where to fix it. */
function Notices({ agent }: { agent: AgentSummary }) {
  const note = (children: ReactNode) => (
    <p role="note" className="mb-2 rounded-card bg-warning-surface px-4 py-3 text-meta text-warning">
      {children}
    </p>
  );
  if (!agent.enabled) {
    return note(
      <>
        This agent is off.{" "}
        <Link href={SETTINGS.agent.href} className="font-medium text-warning underline underline-offset-2">
          Turn it on in Settings → Job agent
        </Link>
      </>,
    );
  }
  if (agent.setupProblem && agent.setupSection) {
    return note(
      <>
        {agent.setupProblem.replace(/ in Settings → [^.]+ first\.$/, ".")}{" "}
        <Link href={SETTINGS[agent.setupSection].href} className="font-medium text-warning underline underline-offset-2">
          Go to {SETTINGS[agent.setupSection].label}
        </Link>
      </>,
    );
  }
  if (agent.limitReached) return note("This agent has run 3 times in the past 24 hours, as many as it may. It runs again once a day has passed since the first.");
  return null;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-t border-line py-3.5 text-sm first:border-t-0 sm:flex-row sm:justify-between sm:gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="sm:text-right">{children}</dd>
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  const id = `agent-${title.toLowerCase().replace(/\W+/g, "-")}`;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={id} className="font-serif text-section">
          {title}
        </h2>
        <p className="text-meta text-muted">{count} waiting</p>
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-card border border-line-card bg-card px-5 py-4 text-sm text-muted">{children}</p>;
}

function OpenPosting({ url }: { url: string }) {
  if (!url) return null;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className={buttonClassName("secondary", "sm")}>
      Open posting <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

/** A posting the agent found: what it is, its score and why. The actions go below. */
function CandidateCard({ candidate, named = false, children }: { candidate: AgentCandidateView; named?: boolean; children: ReactNode }) {
  return (
    <Card padding="none" className="flex flex-col gap-3.5 px-6 py-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="font-serif text-[20px] leading-tight text-pretty">{candidate.title}</h3>
          {candidate.company && <p className="text-sm text-ink">{candidate.company}</p>}
          {candidate.facts && <p className="text-meta text-muted">{candidate.facts}</p>}
          {candidate.origin && <p className="text-xs text-muted">{candidate.origin}</p>}
          {named && candidate.agentName && <p className="text-xs text-muted">Found by {candidate.agentName}</p>}
          {/* As the source's terms ask (E14-2); the origin names the others. */}
          {linksAttribution(candidate.source) && <SourceAttribution source={candidate.source} url={candidate.url} className="mt-1.5 self-start" />}
        </div>
        <ScoreBadge score={candidate.score} />
      </div>
      {candidate.reasons.length > 0 && (
        <ul aria-label="Why it fits" className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted">
          {candidate.reasons.map((reason, index) => (
            <li key={index}>{reason}</li>
          ))}
        </ul>
      )}
      {candidate.redFlags.length > 0 && (
        <div className="rounded-card bg-warning-surface px-3.5 py-2.5 text-meta text-warning">
          <p className="font-medium">Worth knowing</p>
          <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-4">
            {candidate.redFlags.map((flag, index) => (
              <li key={index}>{flag}</li>
            ))}
          </ul>
        </div>
      )}
      {candidate.error && (
        <p role="alert" className="text-meta text-error">
          {candidate.error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2.5 border-t border-line pt-3.5">{children}</div>
    </Card>
  );
}

/** A scored posting: Prepare draft (following the job while it writes), Open posting, Dismiss. */
function ScoredCard({ candidate, named, onDismiss }: { candidate: AgentCandidateView; named: boolean; onDismiss: () => void }) {
  const router = useRouter();
  const [jobId, setJobId] = useState(candidate.draftJobId);
  const [starting, startTransition] = useTransition();
  const job = useJob<DraftResult>(jobId, 0, (update) => {
    if (update.status === "DONE") {
      setJobId(null);
      toast("The draft is ready for your review.");
      router.refresh();
    } else if (update.status === "FAILED") {
      setJobId(null);
      toast(update.error ?? "The draft couldn't be prepared.");
      router.refresh();
    }
  });
  const preparing = starting || Boolean(jobId);

  const prepare = () =>
    startTransition(async () => {
      const result = toastResult(await prepareAgentDraft({ candidateId: candidate.id }));
      if (!result.ok) return;
      if (result.data.applicationId) router.refresh();
      else setJobId(result.data.jobId);
    });

  return (
    <CandidateCard candidate={candidate} named={named}>
      <Button size="sm" aria-disabled={preparing || undefined} onClick={() => !preparing && prepare()}>
        {preparing ? "Preparing draft…" : "Prepare draft"}
      </Button>
      <OpenPosting url={candidate.url} />
      {preparing && job?.step && (
        <span role="status" className="text-meta text-muted">
          {job.step}
        </span>
      )}
      <Button variant="danger-text" size="sm" className="ml-auto" onClick={onDismiss}>
        Dismiss
      </Button>
    </CandidateCard>
  );
}
