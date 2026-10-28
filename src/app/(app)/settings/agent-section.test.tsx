import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { toast } from "@/components/toast";

import { createJobAgent, deleteJobAgent, saveJobAgent } from "../agent/actions";
import { AgentSection, type AgentSettings, type AgentSourceChoice } from "./agent-section";

vi.mock("../agent/actions", () => ({
  saveJobAgent: vi.fn(async () => ({ ok: true, data: null })),
  createJobAgent: vi.fn(),
  deleteJobAgent: vi.fn(async () => ({ ok: true, data: null })),
}));
vi.mock("./actions", () => ({ saveJobSourceKey: vi.fn(), saveJobSearchDetails: vi.fn(), testJobSource: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ toast: vi.fn(), toastResult: (result: { ok: boolean; error?: string }) => (result.ok ? result : (toast(result.error!), result)) }));

const agent: AgentSettings = {
  id: "agent-1",
  name: "",
  source: "JSEARCH",
  enabled: false,
  query: { keywords: "Data scientist", place: "Berlin", country: "de", radiusKm: 25, remoteOnly: false, postedWithin: "any" },
  hour: 7,
  minScore: 70,
  maxScores: 15,
  maxDrafts: 3,
  autoDraft: false,
};
const sources: AgentSourceChoice[] = [
  { source: "JSEARCH", name: "JSearch", ready: true },
  { source: "ADZUNA", name: "Adzuna", ready: false },
  { source: "APIFY_LINKEDIN", name: "LinkedIn (Apify)", ready: true },
  { source: "APIFY_INDEED", name: "Indeed (Apify)", ready: false },
];
const countries = [
  { code: "de", name: "Germany" },
  { code: "nl", name: "Netherlands" },
];
const open = (props: Partial<Parameters<typeof AgentSection>[0]> = {}) =>
  render(
    <AgentSection
      agents={[agent]}
      sources={sources}
      newQuery={agent.query}
      aiReady
      countries={countries}
      timeZone="Europe/Berlin"
      apify={{ keyState: "set", maxResults: 25 }}
      {...props}
    />,
  );
const runSwitch = () => screen.getByRole("switch", { name: "Run Data scientist" });

beforeEach(() => vi.clearAllMocks());

describe("Settings → Job agent (E16-7)", () => {
  it("is off until it's turned on, and turns on with the search, saved with it", async () => {
    const user = userEvent.setup();
    open();
    expect(runSwitch()).toHaveAttribute("aria-checked", "false");
    await user.click(runSwitch());
    expect(saveJobAgent).toHaveBeenCalledWith({ id: "agent-1", enabled: true, query: agent.query });
    expect(screen.getByText("JSearch · Runs daily after 07:00")).toBeInTheDocument();
  });

  it("needs keywords and a country to turn on", async () => {
    const user = userEvent.setup();
    open({ agents: [{ ...agent, name: "Data scientist", query: { ...agent.query, keywords: "", country: "" } }] });
    await user.click(runSwitch());
    expect(saveJobAgent).not.toHaveBeenCalled();
    expect(screen.getByLabelText("What")).toHaveAccessibleDescription("Type what the agent should look for.");
    expect(screen.getByLabelText("Country")).toHaveAccessibleDescription("Choose a country.");
    expect(runSwitch()).toHaveAttribute("aria-checked", "false");
  });

  it("saves the search and name once typing pauses, and the other choices at once", async () => {
    const user = userEvent.setup();
    open();
    await user.type(screen.getByLabelText("What"), " NLP");
    await waitFor(() => expect(saveJobAgent).toHaveBeenLastCalledWith({ id: "agent-1", name: "", query: { ...agent.query, keywords: "Data scientist NLP" } }), { timeout: 2000 });
    await user.selectOptions(screen.getByLabelText("Source"), "LinkedIn (Apify)");
    expect(saveJobAgent).toHaveBeenLastCalledWith({ id: "agent-1", source: "APIFY_LINKEDIN" });
    await user.selectOptions(screen.getByLabelText("Runs after"), "09:00");
    expect(saveJobAgent).toHaveBeenLastCalledWith({ id: "agent-1", hour: 9 });
    await user.selectOptions(screen.getByLabelText("Minimum score"), "80 of 100");
    expect(saveJobAgent).toHaveBeenLastCalledWith({ id: "agent-1", minScore: 80 });
    await user.selectOptions(screen.getByLabelText("Postings scored per run"), "20");
    expect(saveJobAgent).toHaveBeenLastCalledWith({ id: "agent-1", maxScores: 20 });
  });

  it("prepares no drafts on its own unless asked, and then up to the cap", async () => {
    const user = userEvent.setup();
    open();
    expect(screen.getByLabelText("Drafts per run, at most")).toBeDisabled();
    const toggle = screen.getByRole("switch", { name: "Prepare drafts on its own" });
    expect(toggle).toHaveAccessibleDescription("Off. You choose which postings get a draft with Prepare draft.");
    await user.click(toggle);
    expect(saveJobAgent).toHaveBeenLastCalledWith({ id: "agent-1", autoDraft: true });
    await user.selectOptions(screen.getByLabelText("Drafts per run, at most"), "5");
    expect(saveJobAgent).toHaveBeenLastCalledWith({ id: "agent-1", maxDrafts: 5 });
    expect(toggle).toHaveAccessibleDescription(/up to 5 drafts/);
  });

  it("warns when the agent's source has no key yet", async () => {
    open({ agents: [{ ...agent, source: "APIFY_INDEED" }] });
    expect(screen.getAllByRole("note")[0]).toHaveTextContent("Indeed (Apify) needs your Apify token, below. It doesn't run until then.");
    expect(within(screen.getByLabelText("Source")).getByRole("option", { name: "Adzuna (needs a key)" })).toBeInTheDocument();
  });

  it("adds an agent per job title, starting from the last search, and deletes one after asking", async () => {
    const user = userEvent.setup();
    vi.mocked(createJobAgent).mockResolvedValueOnce({ ok: true, data: { ...agent, id: "agent-2", name: "", runs: [] } });
    open();
    await user.click(screen.getByRole("button", { name: "Add agent" }));
    expect(createJobAgent).toHaveBeenCalledWith({ source: "JSEARCH", query: agent.query });
    expect(await screen.findAllByRole("switch", { name: "Run Data scientist" })).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Delete agent" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete agent" }));
    expect(deleteJobAgent).toHaveBeenCalledWith({ id: "agent-2" });
  });

  it("points to the AI provider while it isn't set up, and has the Apify section", () => {
    open({ aiReady: false, agents: [] });
    expect(screen.getByRole("link", { name: "Settings → AI provider" })).toHaveAttribute("href", "/settings?section=ai");
    expect(screen.getByText(/No job agents yet/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Apify" })).toBeInTheDocument();
    expect(screen.getByLabelText("Results per run, at most")).toHaveValue("25");
  });

  it("switches back and says why when a change isn't saved", async () => {
    const user = userEvent.setup();
    vi.mocked(saveJobAgent).mockResolvedValueOnce({ ok: false, error: "Type what the agent should look for before turning it on." });
    open();
    await user.click(runSwitch());
    await waitFor(() => expect(runSwitch()).toHaveAttribute("aria-checked", "false"));
    expect(toast).toHaveBeenCalledWith("Type what the agent should look for before turning it on.");
  });
});
