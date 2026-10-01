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

export function ContextReceiptLine({ receipt }: { receipt: ContextReceipt }) {
  if (!receipt.tokens.length) return null;
  const applied = receipt.tokens.filter(token => token.outcome === "applied");
  const dropped = receipt.tokens.filter(token => token.outcome === "dropped");
  return <details className="mt-1 max-w-full text-left text-caption text-muted-foreground">
    <summary className="cursor-pointer break-words py-1">{applied.length ? `Used ${applied.map(token => token.label).join(", ")}` : "Context needs attention"}{dropped.length ? ` · ${dropped.length} could not be used` : ""}</summary>
    <ul className="space-y-1 py-1">{receipt.tokens.map(token => <li key={`${token.kind}:${token.id}`}>
      <span className={token.outcome === "dropped" ? "text-warning-foreground" : undefined}>{token.message ?? `${token.label}${token.outcome === "applied" ? " was included." : " could not be included."}`}</span>
      {token.code === "needs_connection" && token.connect?.href.startsWith("/connections") && <a className="ml-1 underline underline-offset-2" href={token.connect.href}>Connect {token.label}</a>}
    </li>)}</ul>
  </details>;
}
