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
      default:
        break;
    }
  }
}
