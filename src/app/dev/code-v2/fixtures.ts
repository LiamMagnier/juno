/**
 * Fixture data for the /dev/code-v2 gallery: one `WorkspaceModel` per state
 * the workspace has to draw (DESIGN §6), built from real contract shapes and
 * the real model catalogue so the pickers show real tiers and prices.
 */
import type { ProviderCapabilities, ProviderInstance, RoleRouting, SubagentItem, TurnItem } from "@/lib/code-v2/contracts";
import { codeProviderModels } from "@/lib/code-v2/code-models";
import type { ThreadSummary } from "@/lib/code-v2/thread-sections";
import type { WorkspaceActions, WorkspaceModel, WorkspaceUiState } from "@/components/code/v2/types";

const NOW = Date.now();
const at = (minutesAgo: number, seconds = 0) => new Date(NOW - minutesAgo * 60_000 + seconds * 1000).toISOString();
const inMinutes = (m: number) => new Date(NOW + m * 60_000).toISOString();

const ALL_MODES: ProviderCapabilities["approvals"] = ["read-only", "ask", "auto-edit", "auto", "full"];
const caps = (over: Partial<ProviderCapabilities> = {}): ProviderCapabilities => ({
  steering: true,
  queue: true,
  interrupt: true,
  resume: true,
  fork: true,
  rollback: true,
  planMode: true,
  approvals: ALL_MODES,
  subagents: true,
  computerUse: true,
  contextTiers: true,
  effortLevels: ["low", "medium", "high", "max"],
  images: true,
  mcpInjection: true,
  ...over,
});

const subTier = (tokens: number, label: string) => ({ tokens, label, inputPerMTok: 0, outputPerMTok: 0 });

export const INSTANCES: ProviderInstance[] = [
  {
    id: "alevr",
    kind: "alevr",
    label: "Alevr",
    status: "ready",
    statusMessage: "Alevr models on your Plus plan. $12.40 of $40 used this month.",
    capabilities: caps(),
    models: codeProviderModels(undefined, { at: NOW }),
  },
  {
    id: "claude-agent:default",
    kind: "claude-agent",
    label: "Claude",
    status: "ready",
    version: "2.4.1",
    account: { email: "maya@okafor.dev", plan: "max", tokenSource: "claude.ai" },
    limits: [
      { id: "five_hour", label: "5-hour", usedPct: 38, resetsAt: inMinutes(134) },
      { id: "seven_day", label: "Weekly", usedPct: 12, resetsAt: inMinutes(60 * 24 * 3) },
    ],
    capabilities: caps({ effortLevels: ["low", "medium", "high", "max"] }),
    models: [
      { id: "claude-opus-5-5", label: "Claude Opus 5.5", isDefault: true, effortLevels: ["low", "medium", "high", "max"], defaultEffort: "high", contextTiers: [subTier(200_000, "200K"), subTier(1_000_000, "1M")] },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", effortLevels: ["low", "medium", "high", "max"], defaultEffort: "high", contextTiers: [subTier(200_000, "200K"), subTier(1_000_000, "1M")] },
      { id: "claude-fable-5-1", label: "Claude Fable 5.1", effortLevels: ["medium", "high", "max"], defaultEffort: "high", contextTiers: [subTier(1_000_000, "1M")] },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", effortLevels: ["low", "medium", "high"], contextTiers: [subTier(200_000, "200K")] },
    ],
    checkedAt: at(2),
  },
  {
    id: "codex:default",
    kind: "codex",
    label: "Codex",
    status: "ready",
    version: "0.61.0",
    account: { email: "maya@okafor.dev", plan: "plus", tokenSource: "chatgpt" },
    limits: [{ id: "primary", label: "5-hour", usedPct: 54, resetsAt: inMinutes(71) }],
    capabilities: caps({ effortLevels: ["low", "medium", "high", "xhigh"] }),
    models: [
      { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", isDefault: true, effortLevels: ["low", "medium", "high", "xhigh"], defaultEffort: "medium", contextTiers: [subTier(272_000, "272K")] },
      { id: "gpt-6-astra", label: "GPT-6 Astra", effortLevels: ["low", "medium", "high"], contextTiers: [subTier(272_000, "272K")] },
    ],
    checkedAt: at(2),
  },
  {
    id: "acp:dsh",
    kind: "acp",
    label: "DeepSeek Harness",
    status: "ready",
    version: "1.3.0",
    acpCommand: ["dsh", "acp"],
    account: { tokenSource: "apiKey" },
    capabilities: caps({ steering: false, rollback: false, computerUse: false, contextTiers: false, effortLevels: [], approvals: ["ask", "auto-edit", "auto"] }),
    models: [{ id: "deepseek-v4-flash", label: "DeepSeek V4.1 Flash", isDefault: true, contextTiers: [subTier(128_000, "128K")] }],
    checkedAt: at(2),
  },
  {
    id: "acp:gemini",
    kind: "acp",
    label: "Gemini CLI",
    status: "signed-out",
    acpCommand: ["gemini", "--experimental-acp"],
    version: "0.9.2",
    statusMessage: "Installed, not signed in. Use an API key, Vertex or a Workspace account.",
    capabilities: caps(),
  },
  {
    id: "acp:grok",
    kind: "acp",
    label: "Grok",
    status: "signed-out",
    acpCommand: ["grok"],
    account: { email: "maya@okafor.dev", plan: "supergrok" },
    statusMessage: "Your sign-in expired on Tuesday.",
    capabilities: caps(),
  },
  { id: "acp:opencode", kind: "acp", label: "OpenCode", status: "not-installed", acpCommand: ["opencode", "acp"] },
  // Antigravity mid sign-in (runtime lane `provider.auth`): the Google page is open, waiting for the loopback redirect.
  {
    id: "acp:antigravity",
    kind: "acp",
    label: "Antigravity",
    status: "signed-out",
    acpCommand: ["antigravity-acp"],
    capabilities: caps(),
    auth: { phase: "waiting", flowId: "flow_1", method: "Google account", authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=example", expiresAt: "2026-10-09T18:10:00Z" },
  } as ProviderInstance,
  {
    id: "byok:anthropic",
    kind: "byok",
    label: "Anthropic key",
    status: "ready",
    capabilities: caps(),
    models: codeProviderModels(undefined, { provider: "anthropic", at: NOW }),
  },
];

export const DEVICE = { id: "dev-mac", name: "Maya's MacBook Pro", online: true, lastSeenAt: at(2) };

export const THREADS: ThreadSummary[] = [
  { id: "t1", title: "Move checkout totals to the server", project: "storefront", state: "running", updatedAt: at(0), branch: "alevr/server-totals" },
  { id: "t2", title: "Cart total regression suite", project: "storefront", state: "waiting", updatedAt: at(3), waitingFor: "wants to run a command", branch: "alevr/cart-suite" },
  { id: "t3", title: "Lazy-load product images", project: "storefront", state: "idle", updatedAt: at(48), pr: 7723, unread: true },
  { id: "t6", title: "Webhook retries with backoff", project: "payments-api", state: "idle", updatedAt: at(130), branch: "alevr/webhook-retries" },
  { id: "t4", title: "Fix the stale cart total", project: "storefront", state: "idle", updatedAt: at(240), pr: 7698 },
  { id: "t5", title: "Document the webhooks API", project: "docs-site", state: "idle", updatedAt: at(60 * 26), branch: "main" },
  { id: "t7", title: "Upgrade to React 20", project: "storefront", state: "idle", updatedAt: at(60 * 24 * 4), settled: true, pr: 7610 },
  { id: "t8", title: "Rate limit the search endpoint", project: "payments-api", state: "idle", updatedAt: at(60 * 24 * 6), settled: true, branch: "alevr/search-limit" },
  { id: "t9", title: "Dark mode for the receipt emails", project: "storefront", state: "idle", updatedAt: at(60 * 24 * 9), settled: true },
];

const DIFF_TOTAL = `--- a/src/server/cart/total.ts
+++ b/src/server/cart/total.ts
@@ -1,9 +1,24 @@
 import { applyCoupon } from "./pricing";
+import { taxFor } from "./tax";

-export function total(items, coupon) {
+export function total(items: Item[], coupon?: Coupon) {
+  // Same order as the payment intent: tax first, then the coupon.
   const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
-  return applyCoupon(subtotal, coupon) + taxFor(subtotal);
+  const taxed = subtotal + taxFor(subtotal);
+  return coupon ? applyCoupon(taxed, coupon) : taxed;
 }
@@ -30,4 +45,12 @@ export async function GET(req: Request) {
   const cart = await loadCart(req);
-  return Response.json({ total: cart.total });
+  const value = total(cart.items, cart.coupon);
+  return Response.json({ total: value, currency: cart.currency });
 }
`;
const DIFF_HOOK = `--- a/src/cart/useCartTotal.ts
+++ b/src/cart/useCartTotal.ts
@@ -12,3 +12,4 @@ export function useCartTotal(cartId: string) {
-  const total = useSelector(selectCartTotal);
+  const { data: total } = useQuery(
+    cartTotalQuery(cartId)
+  );
   return total ?? null;
`;
const DIFF_TEST = `--- /dev/null
+++ b/src/server/cart/total.server.test.ts
@@ -0,0 +1,6 @@
+import { total } from "./total";
+
+test("tax applies before the coupon", () => {
+  expect(total([{ price: 100, qty: 1 }], { pct: 10 })).toBe(99);
+});
+
`;

function workedTurn(): TurnItem[] {
  return [
    { id: "u1", turnId: "turn1", kind: "user_message", text: "Move the checkout total to the server. Today the cart computes it in the browser and drifts from what Stripe charges. Add tests.", createdAt: at(12), delivery: "send" },
    { id: "r1", turnId: "turn1", kind: "reasoning", text: "The drift is an ordering problem: the browser applies the coupon before tax, the payment intent applies it after. Fix the order in one place and make the client read it.", streaming: false, summary: true, createdAt: at(12, 3) },
    { id: "s1", turnId: "turn1", kind: "search", callId: "c1", query: "src/cart/selectors.ts", scope: "files", status: "completed", createdAt: at(12, 10) },
    { id: "s2", turnId: "turn1", kind: "search", callId: "c2", query: "cartTotal", scope: "content", matches: 11, status: "completed", createdAt: at(12, 14) },
    { id: "f1", turnId: "turn1", kind: "file_change", callId: "c3", status: "completed", createdAt: at(11), changes: [{ path: "src/server/cart/total.ts", change: "modify", diff: DIFF_TOTAL, additions: 7, deletions: 3 }] },
    { id: "f2", turnId: "turn1", kind: "file_change", callId: "c4", status: "completed", createdAt: at(10), changes: [{ path: "src/cart/useCartTotal.ts", change: "modify", diff: DIFF_HOOK, additions: 3, deletions: 1 }] },
    { id: "f3", turnId: "turn1", kind: "file_change", callId: "c5", status: "completed", createdAt: at(9), changes: [{ path: "src/server/cart/total.server.test.ts", change: "add", diff: DIFF_TEST, additions: 6, deletions: 0 }] },
    { id: "x1", turnId: "turn1", kind: "command_execution", callId: "c6", command: "pnpm test --filter cart", output: "✓ cart/total.server.test.ts (9)\n✓ cart/useCartTotal.test.tsx (6)\nTests 15 passed", exitCode: 0, durationMs: 21_000, status: "completed", createdAt: at(8, 30) },
    { id: "a1", turnId: "turn1", kind: "assistant_message", text: "The browser total and the charged total came from two different sums: `selectCartTotal` applied the coupon before tax, the payment intent applied it after. I moved the sum into `/api/cart/total` and the cart now reads it from there.", streaming: false, createdAt: at(8) },
    { id: "k1", turnId: "turn1", kind: "checkpoint", checkpointId: "cp1", turnOrdinal: 1, filesChanged: 3, additions: 16, deletions: 4, createdAt: at(8) },
  ];
}

function runningTurn(): TurnItem[] {
  return [
    { id: "u2", turnId: "turn2", kind: "user_message", text: "Run the cart suite before you call it done.", createdAt: at(1.2), delivery: "send" },
    { id: "r2", turnId: "turn2", kind: "reasoning", text: "Typecheck first, then the filtered suite.", streaming: false, summary: true, createdAt: at(1.1) },
    { id: "x2", turnId: "turn2", kind: "command_execution", callId: "c7", command: "pnpm typecheck", output: "Done in 17.6s", exitCode: 0, durationMs: 18_000, status: "completed", createdAt: at(1) },
    { id: "x3", turnId: "turn2", kind: "command_execution", callId: "c8", command: "pnpm test --filter cart", output: "✓ cart/total.server.test.ts (9)\n✓ cart/useCartTotal.test.tsx (6)\n… cart/checkout.e2e.test.ts", status: "running", createdAt: at(0.7) },
  ];
}

const USAGE_ALEVR = { inputTokens: 412_000, outputTokens: 38_000, contextTokens: 184_000, contextWindow: 272_000, autoCompactAt: 217_000, costUsd: 1.84, billing: "alevr" as const };
const USAGE_SUB = { inputTokens: 512_000, outputTokens: 41_000, contextTokens: 184_000, contextWindow: 1_000_000, autoCompactAt: 800_000, billing: "subscription" as const };

const ROUTING_SOLO: RoleRouting = { preset: "solo", orchestrator: { instanceId: "claude-agent:default", model: "claude-opus-5-5", effort: "high" } };
const ROUTING_LEAD: RoleRouting = {
  preset: "lead-workers",
  orchestrator: { instanceId: "claude-agent:default", model: "claude-opus-5-5", effort: "high" },
  workers: [
    { instanceId: "codex:default", model: "gpt-6.1-sol", effort: "medium" },
    { instanceId: "codex:default", model: "gpt-6.1-sol", effort: "medium" },
    { instanceId: "codex:default", model: "gpt-6.1-sol", effort: "medium" },
  ],
  reviewer: { instanceId: "alevr", model: "anthropic:claude-sonnet-5-5", effort: "medium" },
  explorer: { instanceId: "acp:dsh", model: "deepseek-v4-flash" },
  budget: { maxUsd: 4 },
};
const ROUTING_BEST: RoleRouting = {
  preset: "best-of-n",
  orchestrator: { instanceId: "alevr", model: "openai:gpt-6.1-sol", effort: "high" },
  workers: [
    { instanceId: "claude-agent:default", model: "claude-opus-5-5", effort: "high" },
    { instanceId: "codex:default", model: "gpt-6.1-sol", effort: "high" },
    { instanceId: "alevr", model: "google:gemini-3.8-flash" },
  ],
  budget: { maxUsd: 6 },
};

function agents(): SubagentItem[] {
  const base = { turnId: "turn3", createdAt: at(3) };
  return [
    { ...base, id: "sa1", kind: "subagent", agentId: "w1", role: "worker", label: "Worker 1", title: "Server route for the total", model: { instanceId: "codex:default", model: "gpt-6.1-sol" }, status: "completed", closingText: "Added /api/cart/total with tax before coupon.", elapsedMs: 112_000, candidate: { additions: 84, deletions: 6 }, task: "Add GET /api/cart/total computing tax before the coupon." },
    { ...base, id: "sa2", kind: "subagent", agentId: "w2", role: "worker", label: "Worker 2", title: "Client reads the server total", model: { instanceId: "codex:default", model: "gpt-6.1-sol" }, status: "running", liveLine: "Editing src/cart/useCartTotal.ts", elapsedMs: 161_000, task: "Replace the client-side total in useCartTotal with a query to /api/cart/total. Keep the optimistic coupon state. Don't touch the server route.", costUsd: 0.21 },
    { ...base, id: "sa3", kind: "subagent", agentId: "w3", role: "worker", label: "Worker 3", title: "Cart total regression suite", model: { instanceId: "codex:default", model: "gpt-6.1-sol" }, status: "waiting", liveLine: "wants to run a command", elapsedMs: 123_000, costUsd: 0.31 },
    { ...base, id: "sa4", kind: "subagent", agentId: "e1", role: "explorer", label: "Explorer", title: "Map every caller of selectCartTotal", model: { instanceId: "acp:dsh", model: "deepseek-v4-flash" }, status: "completed", closingText: "Found 3 call sites and 2 tests. Closed.", elapsedMs: 38_000, costUsd: 0.12 },
  ];
}

const noop = () => undefined;

export function makeActions(log: (name: string, ...args: unknown[]) => void): WorkspaceActions {
  const wrap =
    (name: string) =>
    (...args: unknown[]) => {
      log(name, ...args);
    };
  return {
    send: wrap("send"),
    queue: wrap("queue"),
    steer: wrap("steer"),
    stop: wrap("stop"),
    respond: wrap("respond"),
    setSelection: wrap("setSelection"),
    setRouting: wrap("setRouting"),
    setRuntimeMode: wrap("setRuntimeMode"),
    setInteractionMode: wrap("setInteractionMode"),
    editQueued: wrap("editQueued"),
    removeQueued: wrap("removeQueued"),
    moveQueued: wrap("moveQueued"),
    steerQueued: wrap("steerQueued"),
    compact: wrap("compact"),
    rollback: wrap("rollback"),
    decideHunk: wrap("decideHunk"),
    commit: wrap("commit"),
    messageAgent: wrap("messageAgent"),
    stopAgent: wrap("stopAgent"),
    keepCandidate: wrap("keepCandidate"),
    approvePlan: wrap("approvePlan"),
    resumeAtReset: wrap("resumeAtReset"),
    openThread: wrap("openThread"),
    newThread: wrap("newThread"),
    terminalInput: wrap("terminalInput"),
    openTerminal: wrap("openTerminal"),
    renameThread: wrap("renameThread"),
  };
}

const FILES = [
  "package.json",
  "src/cart/selectors.ts",
  "src/cart/useCartTotal.ts",
  "src/cart/useCartTotal.test.tsx",
  "src/server/cart/total.ts",
  "src/server/cart/total.server.test.ts",
  "src/server/cart/pricing.ts",
  "src/server/cart/tax.ts",
  "src/app/checkout/page.tsx",
];

type Base = Omit<WorkspaceModel, "actions">;

function base(over: Partial<Base>): Base {
  return {
    thread: { id: "t1", title: "Move checkout totals to the server", repo: "storefront", branch: "alevr/server-totals" },
    items: [],
    state: "idle",
    queue: [],
    instances: INSTANCES,
    selection: { instanceId: "claude-agent:default", model: "claude-opus-5-5", effort: "high", contextTokens: 1_000_000 },
    routing: ROUTING_SOLO,
    runtimeMode: "auto-edit",
    interactionMode: "default",
    files: FILES,
    fileContents: { "src/server/cart/tax.ts": 'export function taxFor(amount: number) {\n  return Math.round(amount * 0.2 * 100) / 100;\n}\n' },
    device: DEVICE,
    threads: THREADS,
    usage: USAGE_SUB,
    byokKeys: [{ provider: "anthropic", hint: "…4f2a", addedAt: at(60 * 24 * 9), lastUsedAt: at(60 * 3) }],
    ...over,
  };
}

export interface GalleryState {
  id: string;
  label: string;
  model: Base;
  ui?: WorkspaceUiState;
}

export const STATES: GalleryState[] = [
  {
    id: "streaming",
    label: "Streaming, queue, Changes",
    model: base({ items: [...workedTurn(), ...runningTurn()], state: "running", queue: [{ id: "q1", text: "Also update the README section on how totals are computed" }], routing: { ...ROUTING_LEAD } }),
    ui: { dockOpen: true, dockTab: "changes" },
  },
  {
    id: "needs-you",
    label: "Needs you: approval takeover, agents",
    model: base({
      thread: { id: "t2", title: "Move checkout totals to the server", repo: "storefront", branch: "alevr/server-totals" },
      items: [
        { id: "u3", turnId: "turn3", kind: "user_message", text: "Move checkout totals to the server and add tests. Split the call sites across workers.", createdAt: at(4), delivery: "send" },
        { id: "r3", turnId: "turn3", kind: "reasoning", text: "Three call sites; one worker each.", streaming: false, createdAt: at(4, 2) },
        { id: "p3", turnId: "turn3", kind: "plan", text: "3 tasks, one per call site", steps: [{ text: "Server route for the total", status: "completed" }, { text: "Client reads the server total", status: "in_progress" }, { text: "Cart total regression suite", status: "in_progress" }], createdAt: at(4, 5) },
        { id: "a3", turnId: "turn3", kind: "assistant_message", text: "Three workers, one per call site. The explorer already mapped them; I'll merge their branches and have the reviewer read each diff.", streaming: false, createdAt: at(4, 8) },
        ...agents(),
        { id: "ap1", turnId: "turn3", kind: "approval_request", callId: "c9", requestId: "req1", action: "command", summary: "pnpm test --filter cart -- --runInBand", detail: "pnpm test --filter cart -- --runInBand", justification: "To run the new regression suite against the server route. It reads files and writes nothing outside coverage/.", options: ["accept", "acceptForSession", "decline"], status: "pending", createdAt: at(0.5), agentId: "w3", agentLabel: "Worker 3" },
      ],
      state: "waiting",
      routing: ROUTING_LEAD,
    }),
    ui: { dockOpen: true, dockTab: "agents", selectedAgentId: "w2" },
  },
  {
    id: "limited",
    label: "Limited: plan limit reached",
    model: base({
      items: [...workedTurn(), { id: "u5", turnId: "turn5", kind: "user_message", text: "Now port the same fix to the mobile checkout.", createdAt: at(2), delivery: "send" }, { id: "i5", turnId: "turn5", kind: "interrupt", reason: "limit", message: "Claude plan limit reached.", resumeAt: inMinutes(134), createdAt: at(1) }],
      state: "limited",
      resumeAt: inMinutes(134),
      instances: INSTANCES.map((i) => (i.id === "claude-agent:default" ? { ...i, status: "limited" as const, limits: [{ id: "five_hour", label: "5-hour", usedPct: 100, resetsAt: inMinutes(134) }] } : i)),
    }),
  },
  {
    id: "subagents",
    label: "Subagents: tree in the thread",
    model: base({
      items: [
        { id: "u3", turnId: "turn3", kind: "user_message", text: "Move checkout totals to the server and add tests. Split the call sites across workers.", createdAt: at(4), delivery: "send" },
        { id: "a3", turnId: "turn3", kind: "assistant_message", text: "Three workers, one per call site.", streaming: false, createdAt: at(4, 8) },
        ...agents().map((a) => (a.status === "waiting" ? { ...a, status: "running" as const, liveLine: "Running pnpm test --filter cart" } : a)),
      ],
      state: "running",
      routing: ROUTING_LEAD,
      usage: USAGE_ALEVR,
      selection: { instanceId: "alevr", model: "openai:gpt-6.1-sol", effort: "high" },
    }),
    ui: { dockOpen: true, dockTab: "agents" },
  },
  {
    id: "best-of-n",
    label: "Best of N compare",
    model: base({
      items: [
        { id: "u6", turnId: "turn6", kind: "user_message", text: "Make the cart drawer open in under 100 ms on a cold load.", createdAt: at(9), delivery: "send" },
        { id: "b1", turnId: "turn6", kind: "subagent", agentId: "cA", role: "worker", label: "Candidate A", model: ROUTING_BEST.workers![0], status: "completed", elapsedMs: 241_000, closingText: "Code-split the drawer and preload it on hover.", worktreeBranch: "alevr/drawer-a", candidate: { additions: 64, deletions: 12, testsLine: "42 passed · drawer opens in 71 ms" }, createdAt: at(9) },
        { id: "b2", turnId: "turn6", kind: "subagent", agentId: "cB", role: "worker", label: "Candidate B", model: ROUTING_BEST.workers![1], status: "completed", elapsedMs: 198_000, closingText: "Moved cart hydration off the critical path.", worktreeBranch: "alevr/drawer-b", candidate: { additions: 31, deletions: 40, testsLine: "42 passed · drawer opens in 88 ms" }, createdAt: at(9) },
        { id: "b3", turnId: "turn6", kind: "subagent", agentId: "cC", role: "worker", label: "Candidate C", model: ROUTING_BEST.workers![2], status: "completed", elapsedMs: 156_000, costUsd: 0.18, closingText: "Replaced the animation library with CSS.", worktreeBranch: "alevr/drawer-c", candidate: { additions: 120, deletions: 210, testsLine: "41 passed, 1 failed" }, createdAt: at(9) },
        { id: "a6", turnId: "turn6", kind: "assistant_message", text: "Three candidates finished. A is fastest and keeps the API; C fails one test. Compare them in Agents and keep one.", streaming: false, createdAt: at(4) },
      ],
      routing: ROUTING_BEST,
      selection: { instanceId: "alevr", model: "openai:gpt-6.1-sol", effort: "high" },
      usage: USAGE_ALEVR,
    }),
    ui: { dockOpen: true, dockTab: "agents" },
  },
  {
    id: "settled",
    label: "Settled thread",
    model: base({ items: [...workedTurn(), { id: "u8", turnId: "turn8", kind: "user_message", text: "Also show the server total in the order confirmation email.", createdAt: at(6), delivery: "send" }, { id: "r8", turnId: "turn8", kind: "reasoning", text: "The email template reads the cart from the session.", streaming: false, createdAt: at(6, 2) }, { id: "s8", turnId: "turn8", kind: "search", callId: "c20", query: "src/emails/order-confirmation.tsx", scope: "files", status: "completed", createdAt: at(5.8) }, { id: "f8", turnId: "turn8", kind: "file_change", callId: "c21", status: "completed", createdAt: at(5), changes: [{ path: "src/emails/order-confirmation.tsx", change: "modify", additions: 4, deletions: 2 }] }, { id: "a8", turnId: "turn8", kind: "assistant_message", text: "The confirmation email now renders `total` from the same server route, so the receipt, the cart and the charge always agree.", streaming: false, createdAt: at(4.5) }] }),
  },
  {
    id: "model-picker",
    label: "Model picker",
    model: base({ items: workedTurn() }),
    ui: { popover: "model" },
  },
  {
    id: "tiers",
    label: "Context window (Alevr)",
    model: base({ items: workedTurn(), selection: { instanceId: "alevr", model: "openai:gpt-6.1-sol", effort: "high" }, usage: USAGE_ALEVR }),
    ui: { popover: "tier" },
  },
  {
    id: "overflow",
    label: "Composer options menu",
    model: base({ items: workedTurn() }),
    ui: { popover: "overflow" },
  },
  {
    id: "orchestrate",
    label: "Team",
    model: base({ items: workedTurn(), routing: ROUTING_LEAD }),
    ui: { popover: "orchestrate" },
  },
  {
    id: "plan",
    label: "Plan waiting for approval",
    model: base({
      interactionMode: "plan",
      items: [
        { id: "u7", turnId: "turn7", kind: "user_message", text: "Plan a migration of the cart store from Redux to Zustand. Don't change anything yet.", createdAt: at(3), delivery: "send" },
        { id: "p7", turnId: "turn7", kind: "plan", text: "Migrate slice by slice behind the existing selectors, so components don't change until the last step.", steps: [{ text: "Add a Zustand store that mirrors the cart slice", status: "pending" }, { text: "Point selectors at the new store", status: "pending" }, { text: "Move the three thunks to store actions", status: "pending" }, { text: "Delete the Redux slice and provider", status: "pending" }], awaitingApproval: true, createdAt: at(1) },
      ],
      state: "waiting",
    }),
  },
  {
    id: "empty",
    label: "Empty thread",
    model: base({ thread: { id: "t9", title: "New session", repo: "storefront", branch: "main" }, usage: undefined }),
  },
  {
    id: "offline",
    label: "Offline device",
    model: base({ items: [...workedTurn(), ...runningTurn()], state: "running", offline: true, device: { ...DEVICE, online: false, lastSeenAt: at(6) } }),
    ui: { dockOpen: true, dockTab: "terminal" },
  },
  {
    id: "connections",
    label: "Settings: Connections",
    model: base({ items: workedTurn() }),
    ui: { settings: "connections", alevrPlan: { name: "Plus plan", spentUsd: 12.4, capUsd: 40 } },
  },
  {
    id: "settings-orchestration",
    label: "Settings: Orchestration",
    model: base({ items: workedTurn(), routing: ROUTING_LEAD }),
    ui: { settings: "orchestration" },
  },
  {
    id: "no-provider",
    label: "No provider connected",
    model: base({ instances: INSTANCES.map((i) => ({ ...i, status: i.kind === "alevr" ? ("error" as const) : ("signed-out" as const) })), device: null, items: [] }),
  },
];

export function stateById(id: string | null): GalleryState {
  return STATES.find((s) => s.id === id) ?? STATES[0];
}

export { noop };
