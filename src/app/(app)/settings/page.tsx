import type { Metadata } from "next";
import { headers } from "next/headers";

import { isAiConfigured, loadAiConfig, loadAiSettingsView } from "@/lib/ai/config";
import { listAgents } from "@/lib/agent/agents";
import { jobSearchView, loadJobSearchConfig, sourceReady } from "@/lib/job-search/config";
import { COUNTRIES } from "@/lib/job-search/countries";
import { EMPTY_QUERY, JOB_SOURCES } from "@/lib/job-search/search";
import { SOURCE_INFO } from "@/lib/job-search/sources";
import { loadSearch } from "@/lib/posting-searches";
import { providerOption } from "@/lib/ai/provider-options";
import { lastNightlyBackup } from "@/lib/backup-schedule";
import { backupsDir } from "@/lib/backups";
import { mcpUrl } from "@/lib/connector/oauth";
import { exportFileName } from "@/lib/data-export";
import { formatShortDate } from "@/lib/dates";
import { env } from "@/lib/env";
import { googleConnection } from "@/lib/google/account";
import { loadGoogleClientConfig, redirectUri } from "@/lib/google/oauth";
import { lastKnownTimeZone, userTimeZone } from "@/lib/time-zone";
import { appVersion } from "@/lib/version";
import { prisma } from "@/lib/prisma";
import { loadProfileName } from "@/lib/profile-data";
import { loadSettings } from "@/lib/settings-data";
import { availableUpdate } from "@/lib/update-check";
import { USAGE_PING_HOST, usagePingChoice } from "@/lib/usage-ping";

import { AgentSection } from "./agent-section";
import { AiBehaviour } from "./ai-behaviour";
import { AiProviderSection } from "./ai-provider-section";
import { DataSection } from "./data-section";
import { DocumentsSection } from "./documents-section";
import { GoogleSection } from "./google-section";
import { GoogleNotice } from "./google-notice";
import { JobSearchSection } from "./job-search-section";
import { AboutSection, type AboutFacts, type UsagePingView } from "./about-section";
import { ConnectorSection } from "./connector-section";
import { settingsSectionFromParam } from "./sections";
import { SettingsScreen } from "./settings-screen";

export const metadata: Metadata = { title: "Settings" };

/** Settings (PRD §6.8); the section is in `?section=` (E10-1). */
export default async function SettingsPage({ searchParams }: PageProps<"/settings">) {
  const params = await searchParams;
  const section = settingsSectionFromParam(params.section);
  const settings = await loadSettings();

  return (
    <SettingsScreen section={section}>
      {section === "ai" ? (
        <>
          <AiProviderSection initial={await loadAiSettingsView()} />
          <AiBehaviour initial={{ creativity: settings.creativity, strict: settings.strict, showDiff: settings.showDiff }} />
        </>
      ) : section === "jobs" ? (
        <JobSearchSection initial={jobSearchView(await loadJobSearchConfig())} />
      ) : section === "agent" ? (
        await agentSection()
      ) : section === "google" ? (
        <>
          <GoogleNotice outcome={typeof params.google === "string" ? params.google : null} />
          <GoogleSection
            connection={await googleView()}
            client={await googleClientView()}
            browserTimeZone={(await userTimeZone()) ?? null}
            redirectUri={redirectUri(await requestOrigin())}
            initial={{
              gmailRead: settings.gmailRead,
              gmailScope: settings.gmailScope,
              gmailInterval: settings.gmailInterval,
              calendarAvailability: settings.calendarAvailability,
              calendarEvents: settings.calendarEvents,
              calendarId: settings.calendarId,
              workDays: settings.workDays,
              workStart: settings.workStart,
              workEnd: settings.workEnd,
              workTimeZone: settings.workTimeZone,
              slotMinutes: settings.slotMinutes,
              bufferMinutes: settings.bufferMinutes,
            }}
          />
        </>
      ) : section === "claude" ? (
        <ConnectorSection initial={{ on: settings.connectorEnabledAt !== null }} address={mcpUrl(env.DOSSIER_PUBLIC_URL ?? (await requestOrigin()))} />
      ) : section === "data" ? (
        <DataSection
          hasApiKey={[settings.apiKeyEnc, settings.jsearchKeyEnc, settings.adzunaKeyEnc, settings.apifyTokenEnc].some((key) => key !== null)}
          exportName={exportFileName()}
          backups={{
            on: settings.nightlyBackup,
            retentionDays: env.DOSSIER_BACKUP_RETENTION_DAYS,
            dir: backupsDir(),
            lastRun: whenRan(await lastNightlyBackup()),
            problem: settings.backupProblem,
          }}
          jobRetentionHours={settings.jobRetentionHours}
        />
      ) : section === "documents" ? (
        <DocumentsSection
          // Only these fields: the settings also hold the encrypted API key, which never leaves the server.
          initial={{
            paper: settings.paper,
            dateFormat: settings.dateFormat,
            defaultTone: settings.defaultTone,
            docLanguage: settings.docLanguage,
            resumeLanguage: settings.resumeLanguage,
            customLanguages: settings.customLanguages,
            fileNamePattern: settings.fileNamePattern,
            includeRefs: settings.includeRefs,
            pageLimit: settings.pageLimit,
          }}
          preview={await filePreview()}
        />
      ) : (
        <AboutSection
          facts={await aboutFacts()}
          usagePing={await usagePingView()}
          updates={{ daily: settings.updateCheck, available: availableUpdate(settings) }}
        />
      )}
    </SettingsScreen>
  );
}

/** The connection as the Google section shows it: never a token. */
async function googleView() {
  const connection = await googleConnection();
  if (connection.status !== "connected") return connection;
  const { lastSyncAt, ...rest } = connection;
  return { ...rest, lastSync: whenRan(lastSyncAt) };
}

/** The OAuth client as the Google section shows it: the ID, never the secret. */
async function googleClientView() {
  const { id, idState, secretState } = await loadGoogleClientConfig();
  return { id, idState, secretState };
}

/** The address this page was reached at, for the redirect URI to register. */
async function requestOrigin(): Promise<string> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host")?.split(",")[0]?.trim() || requestHeaders.get("host") || "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto")?.split(",")[0]?.trim() || (host.startsWith("localhost") ? "http" : "https");
  return `${protocol}://${host}`;
}

/** The file name preview uses your name and your latest application, or sample values (SET-8). */
async function filePreview() {
  const [name, latest] = await Promise.all([
    loadProfileName(),
    prisma.application.findFirst({ where: { awaitingReview: false }, orderBy: { createdAt: "desc" }, select: { company: true, role: true } }),
  ]);
  return {
    name: name.trim() || "Jane Doe",
    company: latest?.company.trim() || "Ledgerly",
    role: latest?.role.trim() || "Senior Product Designer",
  };
}

/** "today at 03:00", "yesterday at 03:00" or "on 25 Sep at 03:00", in the server's time zone. */
function whenRan(date: Date | null, now = new Date()): string | null {
  if (!date) return null;
  const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const day = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((day(now) - day(date)) / 86_400_000);
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `yesterday at ${time}`;
  return `on ${formatShortDate(date, now)} at ${time}`;
}

/** "12.4 MB" */
function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/** The About rows (SET-12). */
async function aboutFacts(): Promise<AboutFacts> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host")?.split(",")[0]?.trim() || requestHeaders.get("host") || "Unknown";
  const [[database], ai, applications] = await Promise.all([
    prisma.$queryRaw<{ size: bigint }[]>`SELECT pg_database_size(current_database()) AS size`,
    loadAiConfig(),
    prisma.application.count({ where: { awaitingReview: false } }),
  ]);
  return [
    { label: "Version", value: appVersion },
    { label: "Server", value: host },
    { label: "Database", value: `PostgreSQL · ${formatBytes(Number(database.size))}` },
    { label: "Sign-in", value: "set via DOSSIER_PASSWORD" },
    { label: "AI", value: [providerOption(ai.provider).name, ai.model].filter(Boolean).join(" · ") },
    { label: "Applications", value: String(applications) },
  ];
}

/** The usage ping's switch in About (#172): the answer in effect, who gave it, and the install ID. */
async function usagePingView(): Promise<UsagePingView> {
  const settings = await loadSettings();
  return { host: USAGE_PING_HOST, ...usagePingChoice(settings), id: settings.usagePingId, production: process.env.NODE_ENV === "production" };
}

/** Settings → Job agent: the agents, the sources they may search, and Apify's token. */
async function agentSection() {
  const [agents, config] = await Promise.all([listAgents(), loadJobSearchConfig()]);
  // A job agent searches on its own, which the BA's terms forbid most clearly (#223).
  const sources = JOB_SOURCES.filter((source) => source !== "ARBEITSAGENTUR").map((source) => ({
    source,
    name: SOURCE_INFO[source].name,
    ready: sourceReady(config, source),
  }));
  return (
    <AgentSection
      agents={agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        source: agent.source,
        enabled: agent.enabled,
        query: agent.query,
        hour: agent.hour,
        minScore: agent.minScore,
        maxScores: agent.maxScores,
        maxDrafts: agent.maxDrafts,
        autoDraft: agent.autoDraft,
      }))}
      sources={sources}
      // A new agent starts from the last search in Find jobs.
      newQuery={(await loadSearch())?.query ?? EMPTY_QUERY}
      aiReady={await isAiConfigured()}
      countries={COUNTRIES}
      timeZone={await lastKnownTimeZone()}
      apify={{ keyState: config.apify.keyState, maxResults: config.apify.maxResults }}
    />
  );
}
