import type { Page, TestInfo } from "@playwright/test";

/**
 * P2's bridge to P0's harness (e2e/support/*), which lands beside this
 * directory when the wave 2 branches meet in integrate-wave2. The modules are
 * imported by a computed path so this branch still typechecks without them;
 * a spec that needs one skips with a reason when it is absent.
 */

type GateMeasurement = { samples?: number[]; value?: number; pass?: boolean; detail?: string; context?: Record<string, unknown> };

interface P0Support {
  recordGate(testInfo: TestInfo, id: string, measurement: GateMeasurement): Promise<unknown>;
  decodePng(input: Uint8Array): { width: number; height: number; data: Uint8Array };
  simulateCvd(bitmap: unknown, kind: string): unknown;
  compareShapeMasks(a: unknown, b: unknown): { distinguishable: boolean; detail: string };
  CVD_GATE_KINDS: readonly string[];
  runAxe?(page: Page, options?: { include?: string }): Promise<{ violations: Array<{ id: string; impact?: string | null }> }>;
}

async function load(name: string): Promise<Record<string, unknown> | null> {
  const specifier = ["..", "..", "support", name].join("/");
  try {
    return (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** P0's helpers, or null on a branch without them. */
export async function p0Support(): Promise<P0Support | null> {
  const [recorder, png, cvd, axe] = await Promise.all([load("gate-recorder"), load("png"), load("cvd"), load("axe")]);
  if (!recorder || !png || !cvd) return null;
  return {
    recordGate: recorder.recordGate as P0Support["recordGate"],
    decodePng: png.decodePng as P0Support["decodePng"],
    simulateCvd: cvd.simulateCvd as P0Support["simulateCvd"],
    compareShapeMasks: cvd.compareShapeMasks as P0Support["compareShapeMasks"],
    CVD_GATE_KINDS: cvd.CVD_GATE_KINDS as readonly string[],
    runAxe: axe?.runAxe as P0Support["runAxe"],
  };
}

/**
 * Server-renders P2's components to static markup in the test process, so a
 * spec can mount them on any page that ships the production stylesheet
 * (/sign-in) without a fixture route in the product. The components compile
 * with the classic JSX runtime, so React is put on globalThis first.
 */
export async function renderFixtures(): Promise<Record<string, string>> {
  const React = await import("react");
  (globalThis as { React?: unknown }).React = React;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { StatusMark } = await import("@/components/brand/status-mark");
  const { GalaxyMark } = await import("@/components/brand/galaxy-mark");
  const { EmptyState } = await import("@/components/ui/empty-state");
  const { Skeleton } = await import("@/components/ui/skeleton");
  const { AttachmentChip, QuoteCard } = await import("@/components/ui/attachment-chip");
  const { UserBubble } = await import("@/components/ui/user-bubble");
  const { ApprovalActions } = await import("@/components/approvals/approval-actions");
  const h = React.createElement;
  const r = (el: React.ReactElement) => renderToStaticMarkup(el);
  const statuses = ["running", "needsYou", "ready", "blocked"] as const;
  const sizes = [10, 12, 14] as const;
  const noop = () => {};
  return {
    statusGrid: r(
      h(
        "div",
        { id: "status-grid", style: { display: "grid", gridTemplateColumns: "repeat(5, max-content)", gap: 16, padding: 16, background: "hsl(var(--background))" } },
        ...sizes.flatMap((size) => statuses.map((status) => h("span", { key: `${status}-${size}`, "data-fixture": `${status}-${size}` }, h(StatusMark, { status, size })))),
        h("span", { key: "badge", "data-fixture": "badge" }, h(StatusMark, { status: "needsYou", variant: "badge" })),
      ),
    ),
    cvdPair: r(
      h(
        "div",
        { id: "cvd-pair", style: { display: "flex", gap: 16, padding: 16, background: "hsl(var(--background))" } },
        h("span", { id: "cvd-hand", style: { display: "inline-block", width: 64, height: 64 } }, h(StatusMark, { status: "needsYou", size: 14, className: "cvd-scale" })),
        h("span", { id: "cvd-cross", style: { display: "inline-block", width: 64, height: 64 } }, h(StatusMark, { status: "blocked", size: 14, className: "cvd-scale" })),
      ),
    ),
    galaxy: r(h("span", { id: "galaxy-fixture" }, h(GalaxyMark, { phase: "working", size: 14 }))),
    emptyState: r(h(EmptyState, { title: "No chats yet", description: "Start one with the composer below.", action: h("button", { type: "button" }, "New chat") })),
    skeleton: r(h("div", { style: { display: "grid", gap: 8, width: 320 } }, h(Skeleton, { style: { height: 16 } }), h(Skeleton, { style: { height: 16, width: "60%" } }))),
    chips: r(
      h(
        "div",
        { style: { display: "flex", gap: 12, flexWrap: "wrap" } },
        h(AttachmentChip, { kind: "file", name: "Quarterly report.pdf", meta: "PDF · 2.4 MB" }),
        h(AttachmentChip, { kind: "file", name: "notes.txt", state: "uploading", progress: 0.4 }),
        h(AttachmentChip, { kind: "file", name: "budget.xlsx", state: "failed", onRetry: noop }),
      ),
    ),
    quote: r(h(QuoteCard, { text: "The selection the reader quoted, held above the composer." })),
    bubble: r(h(UserBubble, null, "How well do heat pumps work in cold climates?")),
    approval: r(
      h(ApprovalActions, {
        requestId: "fixture",
        title: "Start the test suite",
        summary: "In your project folder.",
        command: "npm test -- --watch=false",
        verb: { kind: "run" },
        onApprove: noop,
        onAllowSession: noop,
        onNotNow: noop,
        onTellInstead: noop,
      }),
    ),
  };
}

/** Opens the anonymous sign-in page (it ships the production stylesheet) and mounts `html` into a fixture host. */
export async function mountOnSignIn(page: Page, html: string, attrs: Record<string, string> = {}): Promise<void> {
  await page.goto("/sign-in");
  await page.evaluate(
    ({ markup, a }) => {
      for (const [name, value] of Object.entries(a)) document.documentElement.setAttribute(name, value);
      document.getElementById("p2-fixture")?.remove();
      const host = document.createElement("div");
      host.id = "p2-fixture";
      host.style.cssText = "position:fixed;inset:0;z-index:2147483646;overflow:auto;padding:24px;background:hsl(var(--background));color:hsl(var(--foreground))";
      host.innerHTML = markup;
      // React hoists <style href precedence> into <head> on the client; static markup leaves them in place, which also works.
      document.body.appendChild(host);
    },
    { markup: html, a: attrs },
  );
}
