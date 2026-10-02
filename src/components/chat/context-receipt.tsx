"use client";
import { AppIcons } from "@/lib/app-icons";
import { ConnectorMark } from "@/components/connections/connector-logos";
import { contextTokensFromReceipt, segmentWithTokens, type ContextReceipt } from "@/lib/chat/context-tokens";

export function SentContextText({ text, receipt }: { text: string; receipt: ContextReceipt }) {
  return <>{segmentWithTokens(text, contextTokensFromReceipt(receipt)).map((part, index) => {
    if (part.kind === "text") return part.text;
    const Mark = part.token.kind === "project" ? AppIcons.projects : part.token.kind === "crew" ? AppIcons.agents : part.token.kind === "skill" ? AppIcons.skills : part.token.kind === "chat" ? AppIcons.conversation : AppIcons.library;
    return <span className="context-token" key={index}><span className="context-token-mark" aria-hidden="true">{part.token.kind === "app" ? <ConnectorMark id={part.token.id} className="size-4" /> : <Mark className="size-4" motion="none" />}</span>{part.text}</span>;
  })}</>;
}

/** "A", "A and B", "A, B and C". */
function listOf(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/*
 * THE RESOLUTION RECEIPT (INTERACTION_SPEC M23, signature S1): one quiet line
 * under the person's turn, aligned with it, saying how the things they named
 * resolved: "Q3 Forecast.xlsx and Stripe added. Sending with Slack asks you
 * first." What could not be used is said in the same sentence, and only then
 * does a disclosure carry the reasons and the way to fix each one.
 */
export function ContextReceiptLine({ receipt }: { receipt: ContextReceipt }) {
  if (!receipt.tokens.length) return null;
  const applied = receipt.tokens.filter(token => token.outcome === "applied");
  const dropped = receipt.tokens.filter(token => token.outcome === "dropped");
  // An app whose sends ask first says so here, once, where the person named it.
  const asksFirst = applied.filter(token => token.kind === "app" && token.approval?.sends === "ask").map(token => token.label);
  const sentence = [
    applied.length ? `${listOf(applied.map(token => token.label))} added.` : null,
    asksFirst.length ? `Sending with ${listOf(asksFirst)} asks you first.` : null,
    dropped.length ? `${listOf(dropped.map(token => token.label))} could not be used.` : null,
  ].filter(Boolean).join(" ");
  return <div className="mt-1.5 max-w-[88%] pr-1 text-right text-label leading-4 text-muted-foreground">
    <p className="break-words">{sentence}</p>
    {dropped.length > 0 && <details className="text-left">
      <summary className="ml-auto w-fit cursor-pointer list-none py-1 text-right underline decoration-border underline-offset-2 hover:text-foreground">Why</summary>
      <ul className="space-y-1 pb-1">{dropped.map(token => <li key={`${token.kind}:${token.id}`}>
        <span className="text-foreground/75">{token.message ?? `${token.label} could not be included.`}</span>
        {token.code === "needs_connection" && token.connect?.href.startsWith("/connections") && <a className="ml-1 text-foreground underline underline-offset-2" href={token.connect.href}>Connect {token.label}</a>}
      </li>)}</ul>
    </details>}
  </div>;
}
