import { MENTION_KIND_ORDER, type MentionItem, type MentionSearchResult } from "@/lib/mentions/types";

/*
 * SYNTHETIC context for the dev galleries (/dev/composer-landing,
 * /dev/context-editor): what GET /api/mentions would return for a signed-in
 * account, so the REAL composer, field, palette and token popover can be seen
 * signed out. Labelled fixtures, never sent anywhere; production always asks
 * the owner-scoped endpoint.
 */

const now = Date.now();
const ago = (hours: number) => new Date(now - hours * 3_600_000).toISOString();

export const MENTION_FIXTURES: MentionItem[] = [
  {
    kind: "crew",
    id: "cm1fixtureagentmira0001",
    label: "Mira",
    subtitle: "Accounts",
    icon: "crew",
    avatar: { shape: "orb", tone: "amber", eyes: "soft", mark: "none" },
    updatedAt: ago(1),
    score: 1,
  },
  {
    kind: "crew",
    id: "cm1fixtureagentscout002",
    label: "Scout",
    subtitle: "Research",
    icon: "crew",
    avatar: { shape: "pebble", tone: "violet", eyes: "round", mark: "antenna" },
    updatedAt: ago(30),
    score: 1,
  },
  {
    kind: "file",
    id: "cm1fixturefileq3forecast",
    label: "Q3 Forecast.xlsx",
    subtitle: "Spreadsheet",
    icon: "file:sheet",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: 2_100_000,
    updatedAt: ago(3),
    score: 1,
  },
  {
    kind: "file",
    id: "cm1fixturefilerenewal01",
    label: "Renewal notes.md",
    subtitle: "Text",
    icon: "file:text",
    updatedAt: ago(52),
    score: 1,
  },
  {
    kind: "project",
    id: "cm1fixtureprojectatlas1",
    label: "Atlas launch",
    subtitle: "14 chats",
    icon: "project",
    updatedAt: ago(2),
    score: 1,
  },
  {
    kind: "app",
    id: "github",
    label: "GitHub",
    subtitle: "liam-northwind",
    icon: "app:github",
    connectorId: "github",
    connected: true,
    approval: { reads: "allow", changes: "ask", sends: "ask", deletes: "ask", summary: "Reads issues and code. Opening a pull request asks you first." },
    updatedAt: ago(20),
    score: 1,
  },
  {
    kind: "app",
    id: "slack",
    label: "Slack",
    subtitle: "liam@northwind.io",
    icon: "app:slack",
    connectorId: "slack",
    connected: true,
    approval: { reads: "allow", changes: "ask", sends: "ask", deletes: "ask", summary: "Reads channels you are in. Posting a message asks you first." },
    updatedAt: ago(400),
    score: 1,
  },
  {
    kind: "app",
    id: "linear",
    label: "Linear",
    subtitle: "Issues and projects",
    icon: "app:linear",
    connectorId: "linear",
    connected: false,
    needsConnection: true,
    connectHref: "/connections",
    score: 1,
  },
  {
    kind: "chat",
    id: "cm1fixturechatpricing01",
    label: "Pricing page copy, second pass",
    icon: "chat",
    updatedAt: ago(26),
    score: 1,
  },
];

/** The fixture lookup: prefix and word matches, in the search's kind order. */
export async function loadMentionFixtures(query: string): Promise<MentionSearchResult> {
  const q = query.trim().toLowerCase();
  const items = MENTION_FIXTURES.filter(
    (item) => !q || item.label.toLowerCase().startsWith(q) || item.label.toLowerCase().split(/[\s.,]+/).some((word) => word.startsWith(q)),
  ).sort((a, b) => MENTION_KIND_ORDER.indexOf(a.kind) - MENTION_KIND_ORDER.indexOf(b.kind));
  return { query, kinds: [...MENTION_KIND_ORDER], items };
}
