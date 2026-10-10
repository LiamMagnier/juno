import type { Plan } from "./compare";
import type { Finding, Source } from "./types";

const SECTIONS: { title: string; kinds: Finding["kind"][] }[] = [
  { title: "New models", kinds: ["new-model"] },
  { title: "Retirements", kinds: ["retirement", "auto-routed", "expired"] },
  { title: "Prices", kinds: ["rate", "long-context", "fast-tier"] },
  { title: "Context windows and capabilities", kinds: ["context-window", "capability"] },
  { title: "Lifecycle", kinds: ["lifecycle"] },
  { title: "Lab model-list APIs", kinds: ["api-missing", "api-new"] },
  { title: "Discovery (OpenRouter, not a source of truth)", kinds: ["discovery"] },
  { title: "Not verified this run", kinds: ["unverified", "conflict"] },
  { title: "Sources that failed", kinds: ["source-error"] },
];

const MARK: Record<Finding["severity"], string> = { change: "change", warn: "**check**", info: "note" };

function sourceLinks(sources: Source[] | undefined): string {
  if (!sources?.length) return "";
  return " (" + sources.map((s) => `[${new URL(s.url).hostname}](${s.url}), ${s.fetched}`).join("; ") + ")";
}

export interface ReportMeta {
  today: string;
  applied: boolean;
  labsRead: string[];
  labsFailed: string[];
  apiChecked: string[];
  apiSkipped: { provider: string; reason: string }[];
  discovery: "on" | "off" | "failed";
}

export function renderReport(plan: Plan, meta: ReportMeta): string {
  const lines: string[] = [];
  const changes = plan.findings.filter((f) => f.applied);
  const checks = plan.findings.filter((f) => f.severity === "warn");
  lines.push(`# Model catalogue sync, ${meta.today}`, "");
  lines.push(
    meta.applied
      ? `Applied: ${changes.length} change(s) written to the catalogue. ${checks.length} item(s) need a person.`
      : `Dry run: ${changes.length} change(s) would be written by \`npm run models:sync -- --apply\`. ${checks.length} item(s) need a person.`,
    ""
  );
  lines.push(`- Official pages read: ${meta.labsRead.join(", ") || "none"}${meta.labsFailed.length ? `; failed: ${meta.labsFailed.join(", ")}` : ""}`);
  lines.push(`- Lab model-list APIs checked: ${meta.apiChecked.join(", ") || "none"}${meta.apiSkipped.length ? `; skipped: ${meta.apiSkipped.map((s) => `${s.provider} (${s.reason})`).join(", ")}` : ""}`);
  lines.push(`- OpenRouter discovery: ${meta.discovery}`);
  lines.push(`- Verified official rates on file: ${Object.keys(plan.rates).length} models`, "");

  for (const section of SECTIONS) {
    const items = plan.findings.filter((f) => section.kinds.includes(f.kind));
    if (!items.length) continue;
    lines.push(`## ${section.title}`, "");
    const order: Finding["severity"][] = ["change", "warn", "info"];
    items.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity) || (a.model ?? "").localeCompare(b.model ?? ""));
    for (const f of items) {
      lines.push(`- ${MARK[f.severity]}${f.applied ? (meta.applied ? " (applied)" : " (would apply)") : ""}: \`${f.model ?? "-"}\` ${f.message}${sourceLinks(f.sources)}`);
      if (f.official && f.current !== f.official) lines.push(`  - note: "${f.current ?? "(none)"}" -> "${f.official}"`);
    }
    lines.push("");
  }
  if (plan.additions.length) {
    lines.push("## Hand-wiring checklist for new models", "");
    for (const a of plan.additions) {
      lines.push(
        `- \`${a.provider}:${a.id}\`: reasoning ladder (src/lib/model-metrics.ts \`reasoningCaps\`), thinking wire (anthropic-thinking.ts / provider adapter), evidence (src/lib/model-reasoning-capabilities.ts), tool record pin (tests/model-tool-capabilities.test.ts), then \`npm run models:probe -- --model=${a.id} --dry\`.`
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}
