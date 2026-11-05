import { skillDraftKey, type SkillDraftContext, type TaughtSkillForm } from "@/lib/skills/teach";

/* Shared inputs for the Teach Juno tests (tests/teach-skill*.test.ts). */

export const NOW = new Date("2026-10-25T10:00:00Z");

export function ctx(overrides: Partial<SkillDraftContext> = {}): SkillDraftContext {
  return {
    key: skillDraftKey("msg-1", 0),
    now: NOW,
    conversationId: "conv-1",
    connectors: [
      { id: "composio:gmail", label: "Gmail" },
      { id: "google-drive", label: "Google Drive" },
    ],
    observed: { tools: ["web_search", "not_a_tool"], apps: ["composio:gmail"] },
    untrusted: false,
    ...overrides,
  };
}

export const INVOICES = {
  name: "File the monthly invoices",
  whenToUse: "When I ask to file or sort invoices for a month.",
  steps: [
    "1. Open the Invoices label in Gmail.",
    "Download each PDF attached to an unread email.",
    "Rename it to client-month.pdf and put it in the month's Drive folder.",
  ],
  inputs: [{ name: "Month", description: "Which month to file", required: true }, "Client"],
  doneWhen: "Every invoice is in the month's folder.",
  rules: ["Never delete an email.", "Never delete an email.", "  "],
  tools: ["Web Search", "web_search", "python", "Bash(git add *)", "telepathy"],
  apps: ["gmail", "Google Drive", "Notion"],
  questions: ["Which Drive folder holds the months?"],
};

export const FULL_FORM: TaughtSkillForm = {
  name: "File the monthly invoices",
  whenToUse: "When I ask to file invoices.",
  steps: ["Open the Invoices label.", "Download each PDF.", "Rename it to client-month.pdf."],
  inputs: [
    { name: "Month", description: "Which month", required: true },
    { name: "Client", description: "", required: false },
  ],
  doneWhen: "Every invoice is filed.",
  rules: ["Never delete an email."],
  notes: ["Which folder? Finance/2026"],
  questions: ["Should paid invoices be skipped?"],
  tools: ["web_search"],
  connectors: ["composio:gmail"],
  domains: [],
};
