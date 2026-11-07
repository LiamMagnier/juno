import type { LiveComponent, LiveSpec } from "@/lib/live-ui/spec";

/**
 * A Live UI view as plain lines of text, for the places that cannot run it:
 * a document's .docx export, its plain text, the outline the model reads
 * before it edits. Pure and synchronous, so the browser canvas and the server
 * export share it.
 *
 * It keeps what a reader could study on paper (steps, timelines, quiz
 * questions, an explorer's parts, callouts, checklists, stops) and drops what
 * only means something live (inputs, formulas, charts). Quiz answers are left
 * out on purpose: the view hides them until the reader chooses, and a printout
 * should not give them away either.
 */
export function liveUISummaryLines(spec: LiveSpec): string[] {
  const lines: string[] = [];
  walk(spec.ui, lines);
  return lines;
}

function walk(list: readonly LiveComponent[], out: string[]): void {
  for (const c of list) {
    switch (c.type) {
      case "row":
      case "grid":
        walk(c.children, out);
        break;
      case "section":
        if (c.title) out.push(c.title);
        walk(c.children, out);
        break;
      case "steps":
        if (c.title) out.push(c.title);
        c.steps.forEach((step, index) => {
          out.push(`${index + 1}. ${step.title}${step.summary ? `: ${step.summary}` : ""}`);
          if (step.notice) out.push(`   ${step.notice}`);
          walk(step.ui, out);
        });
        if (c.takeaway) out.push(c.takeaway);
        break;
      case "timeline":
        if (c.title) out.push(c.title);
        for (const item of c.items) {
          out.push(`${item.time ? `${item.time} · ` : ""}${item.label}${item.detail ? `: ${item.detail}` : ""}`);
        }
        break;
      case "quiz":
        if (c.title) out.push(c.title);
        c.questions.forEach((q, index) => {
          out.push(`Q${index + 1}. ${q.question}`);
          q.options.forEach((option, i) => out.push(`   ${String.fromCharCode(97 + i)}) ${option.label}`));
        });
        break;
      case "explorer":
        if (c.title) out.push(c.title);
        for (const part of c.parts) out.push(`${part.label}${part.summary ? `: ${part.summary}` : ""}`);
        break;
      case "callout":
        out.push(c.title ? `${c.title}: ${c.text}` : c.text);
        break;
      case "checklist":
        if (c.title) out.push(c.title);
        for (const item of c.items) out.push(`☐ ${item.label}${item.note ? `: ${item.note}` : ""}`);
        break;
      case "stops":
        if (c.title) out.push(c.title);
        for (const stop of c.stops) out.push(`${stop.time ? `${stop.time} · ` : ""}${stop.name}${stop.note ? `: ${stop.note}` : ""}`);
        break;
      case "exercise":
        out.push(`${c.title}${c.tag ? ` (${c.tag})` : ""}`, c.prompt.replace(/\*\*/g, ""));
        break;
      case "text":
        if (!c.text.includes("{{")) out.push(c.text.replace(/\*\*/g, ""));
        break;
      case "recipe":
        if (c.title) out.push(c.title);
        out.push(`For ${c.servings} ${c.yieldLabel}`);
        for (const i of c.ingredients) out.push(`• ${i.qty !== undefined ? `${i.qty}${i.unit ? ` ${i.unit}` : ""} ` : ""}${i.name}${i.note ? ` (${i.note})` : ""}`);
        c.steps.forEach((step, index) => out.push(`${index + 1}. ${step.text}${step.minutes ? ` (${step.minutes} min)` : ""}`));
        break;
      case "choices":
        if (c.question) out.push(c.question);
        for (const o of c.options) out.push(`○ ${o.label}${o.detail ? `: ${o.detail}` : ""}`);
        break;
      case "compare":
        if (c.title) out.push(c.title);
        c.options.forEach((o, index) => {
          out.push(`${o.name}${o.price ? ` · ${o.price}` : ""}${c.recommend === index ? " (recommended)" : ""}${o.tagline ? `: ${o.tagline}` : ""}`);
          for (const p of o.pros) out.push(`   + ${p}`);
          for (const m of o.cons) out.push(`   − ${m}`);
        });
        break;
      case "cards":
        if (c.title) out.push(c.title);
        for (const it of c.items) out.push(`${it.title}${it.subtitle ? ` · ${it.subtitle}` : ""}${it.detail ? `: ${it.detail}` : ""}`);
        break;
      case "tabs":
        for (const tab of c.tabs) {
          out.push(tab.label);
          walk(tab.children, out);
        }
        break;
      case "flashcards":
        if (c.title) out.push(c.title);
        for (const card of c.cards) out.push(`${card.front}: ${card.back}`);
        break;
      case "timer": {
        if (c.title) out.push(c.title);
        const mmss = (n: number) => (n >= 60 ? `${Math.floor(n / 60)} min${n % 60 ? ` ${n % 60} s` : ""}` : `${n} s`);
        out.push(`${c.intervals.map((iv) => `${iv.label} ${mmss(iv.seconds)}`).join(", ")}${c.rounds > 1 ? ` × ${c.rounds} rounds` : ""}`);
        break;
      }
      case "schedule":
        if (c.title) out.push(c.title);
        for (const d of c.days) {
          out.push(d.items.length ? `${d.label}:` : `${d.label}: rest`);
          for (const it of d.items) out.push(`   ☐ ${it.time ? `${it.time} ` : ""}${it.label}${it.detail ? `: ${it.detail}` : ""}`);
        }
        break;
      default:
        break;
    }
  }
}

/**
 * A reply with each ```live-ui fence replaced by its readable lines, for
 * Copy (message-item.tsx). ChatGPT copies an interactive answer as text; this
 * used to paste the view's JSON. The title becomes a bold line, the summary
 * follows as a list; a view with nothing readable (a calculator) leaves its
 * title only. Every other fence, and everything inside one, is untouched.
 */
export function readableLiveUIText(markdown: string, parse: (source: string) => LiveSpec | null): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)\s*$/.exec(lines[i]);
    if (!open) {
      out.push(lines[i]);
      continue;
    }
    const fence = open[1];
    const lang = open[2].trim().toLowerCase();
    let end = i + 1;
    while (end < lines.length && !new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`).test(lines[end])) end++;
    const body = lines.slice(i + 1, end);
    if (!["live-ui", "live", "juno-live"].includes(lang)) {
      out.push(...lines.slice(i, Math.min(end + 1, lines.length)));
      i = end;
      continue;
    }
    const spec = parse(body.join("\n"));
    if (spec) {
      if (spec.title) out.push(`**${spec.title}**`);
      const summary = liveUISummaryLines(spec);
      if (summary.length) {
        if (spec.title) out.push("");
        out.push(...summary.map((l) => (/^\s/.test(l) ? `  ${l.trim()}` : `- ${l}`)));
      }
    }
    i = end;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}
