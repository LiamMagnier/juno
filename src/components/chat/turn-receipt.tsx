"use client";

import type { ComponentType, ReactNode, Ref } from "react";
import { Activity, ChevronRight, FileText, Globe, Plug, Terminal, Wrench } from "@/components/ui/icons";
import type { ToolCallRecord } from "@/types/run";
import { cn } from "@/lib/utils";

export const receiptChip = "inline-flex min-h-7 min-w-0 items-center gap-1.5 rounded-full bg-secondary px-2.5 text-ui text-foreground";

type Receipt = { label: string; Icon: ComponentType<{ className?: string }> };

function receiptFor(call: ToolCallRecord): Receipt {
  if (call.tool === "run_code") {
    const language = typeof call.args?.language === "string" ? call.args.language.toLowerCase() : "";
    return { label: language === "python" ? "Ran Python" : "Ran code", Icon: Terminal };
  }
  if (call.tool === "read_document") {
    return { label: typeof call.args?.file === "string" ? call.args.file : "Read a document", Icon: FileText };
  }
  if (call.origin === "connector") return { label: call.connectorLabel || call.title, Icon: Plug };
  if (call.tool === "web_search" || call.tool === "provider_web_search") return { label: "Searched the web", Icon: Globe };
  return { label: call.title, Icon: Wrench };
}

export function TurnReceipt({ calls, fallback, duration, memory, expanded, controls, onToggle, triggerRef }: {
  calls: readonly ToolCallRecord[];
  fallback: ReactNode;
  duration: string | null;
  memory?: ReactNode;
  expanded: boolean;
  controls: string;
  onToggle: () => void;
  triggerRef: Ref<HTMLButtonElement>;
}) {
  const unique = new Map<string, Receipt>();
  for (const call of calls) {
    const item = receiptFor(call);
    unique.set(item.label, item);
  }
  const shown = Array.from(unique.values()).slice(0, 3);
  const more = unique.size - shown.length;

  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-1.5 gap-y-1" data-turn-receipts="">
      {fallback && (
        <button
          type="button"
          ref={triggerRef}
          aria-expanded={expanded}
          aria-controls={controls}
          onClick={onToggle}
          className="group/receipt flex max-w-full flex-wrap items-center gap-1 rounded-control text-start focus-visible:outline-offset-2 coarse:min-h-11"
        >
          {shown.length ? shown.map(({ label, Icon }) => (
            <span key={label} title={label} className={cn(receiptChip, "max-w-48 group-hover/receipt:bg-accent group-aria-expanded/receipt:bg-accent motion-safe:transition-colors motion-safe:duration-fast")}>
              <Icon className="size-3.5 shrink-0" />
              <span className="truncate">{label}</span>
            </span>
          )) : (
            <span className={cn(receiptChip, "max-w-full group-hover/receipt:bg-accent group-aria-expanded/receipt:bg-accent motion-safe:transition-colors motion-safe:duration-fast")}>
              <Activity className="size-3.5 shrink-0" />
              <span className="truncate">{fallback}</span>
            </span>
          )}
          {more > 0 && <span className={receiptChip} aria-label={`${more} more`} translate="no">+{more}</span>}
          <span className="sr-only">, run details</span>
          <ChevronRight aria-hidden="true" className={cn("size-3.5 shrink-0 text-muted-foreground motion-safe:transition-transform motion-safe:duration-base max-sm:hidden", expanded && "rotate-90")} />
        </button>
      )}
      {memory}
      {duration && <span className="ps-1 text-label tabular-nums text-muted-foreground" translate="no">{duration}</span>}
    </div>
  );
}
