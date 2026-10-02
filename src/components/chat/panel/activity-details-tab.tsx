"use client";

import * as React from "react";
import { toast } from "sonner";

import { createRemovalQueue } from "@/components/memory/removal-queue";
import { Collapse } from "@/components/ui/collapse";
import { ChevronRight, TriangleAlert } from "@/components/ui/icons";
import { formatPhrase, Phrase, PhraseWithArgs } from "@/lib/i18n-phrase";
import { PROVIDERS, type Provider } from "@/lib/providers";
import type { ClientMemoryReceipt } from "@/types/chat";
import { cn } from "@/lib/utils";

import { PANEL_COPY } from "./copy";
import { contextLine, toolNamePhrases, type DetailsModel } from "./panel-model";
import { usePanelPorts } from "./panel-ports";

/*
 * The Details tab (SPEC §8.3.3): which model answered and at what effort, how
 * much context it used against its window, which tools and connectors it had,
 * and the saved memories the turn used — each with Forget.
 *
 * Not here, on purpose: cost as a headline, the five-way filter, Summary/Full
 * and the Research/Think/Write ledger (DECISIONS U3). Money shows only in the
 * Research panel's details, in the plan currency.
 */

function Row({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2">
      <dt className="text-caption font-medium text-muted-foreground">
        <Phrase text={term} />
      </dt>
      <dd className="min-w-0 text-ui text-foreground">{children}</dd>
    </div>
  );
}

function providerLabel(provider: string | null): string | null {
  if (!provider) return null;
  return (PROVIDERS as Partial<Record<string, { label: string }>>)[provider as Provider]?.label ?? provider;
}

function ToolsRow({ tools }: { tools: NonNullable<DetailsModel["tools"]> }) {
  const [open, setOpen] = React.useState(false);
  const names = React.useMemo(() => toolNamePhrases(tools.offered), [tools.offered]);
  const listId = React.useId();
  return (
    <Row term={PANEL_COPY.details.tools}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((value) => !value)}
        disabled={names.length === 0}
        className="-mx-1.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-start transition-colors duration-fast ease-out-soft hover:bg-accent disabled:pointer-events-none motion-reduce:transition-none"
      >
        <PhraseWithArgs
          spec={{ parts: [{ phrase: PANEL_COPY.details.toolsAvailable }, { kind: "number", value: names.length }] }}
        />
        {names.length > 0 && (
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-3.5 text-muted-foreground transition-transform duration-base ease-in-out motion-reduce:transition-none rtl:-scale-x-100",
              open && "rotate-90 rtl:-rotate-90"
            )}
          />
        )}
      </button>
      <Collapse open={open}>
        <ul id={listId} className="flex flex-col gap-0.5 pt-1 text-ui text-muted-foreground">
          {names.map((name) => (
            <li key={name}>
              <Phrase text={name} />
            </li>
          ))}
        </ul>
      </Collapse>
      {(tools.nativeSearch || tools.roundBudget > 0) && (
        <PhraseWithArgs
          className="mt-1 block text-caption text-muted-foreground"
          spec={[
            ...(tools.nativeSearch ? [{ parts: [{ phrase: PANEL_COPY.details.nativeSearch }] }] : []),
            ...(tools.roundBudget > 0
              ? [{ parts: [{ phrase: PANEL_COPY.details.stepBudget }, { kind: "count" as const, n: tools.roundBudget, ...PANEL_COPY.units.step }] }]
              : []),
          ]}
        />
      )}
    </Row>
  );
}

function ConnectorsRow({ connectors }: { connectors: NonNullable<DetailsModel["connectors"]> }) {
  return (
    <Row term={PANEL_COPY.details.connectors}>
      <ul className="flex flex-col gap-1">
        {connectors.ready.map((connector) => (
          <li key={`ready-${connector.id}`} className="flex items-baseline gap-2">
            <bdi translate="no" lang="" data-no-auto-translate className="min-w-0 truncate">
              {connector.label}
            </bdi>
            <span className="text-caption text-muted-foreground">
              <Phrase text={PANEL_COPY.details.connected} />
            </span>
          </li>
        ))}
        {connectors.failed.map((connector) => (
          <li key={`failed-${connector.id}`} className="flex items-start gap-2">
            <bdi translate="no" lang="" data-no-auto-translate className="min-w-0 truncate">
              {connector.label}
            </bdi>
            <span className="flex min-w-0 items-center gap-1 text-caption text-warning-foreground">
              <TriangleAlert className="size-3 shrink-0" />
              <PhraseWithArgs
                spec={[
                  { parts: [{ phrase: PANEL_COPY.details.couldntConnect }] },
                  ...(connector.reason in PANEL_COPY.connectorFailure
                    ? [{ parts: [{ phrase: PANEL_COPY.connectorFailure[connector.reason] }] }]
                    : []),
                ]}
              />
            </span>
          </li>
        ))}
      </ul>
    </Row>
  );
}

/**
 * Forget, with an Undo, on an endpoint that has none: the row leaves at once,
 * the toast offers Undo, and the PATCH goes out only when the toast has gone
 * (or the tab is hidden, or the panel unmounts) — the deferral the Memory page
 * uses (`use-deferred-removal.ts`), on the same queue.
 */
function useForgetWithUndo() {
  const ports = usePanelPorts();
  const [hidden, setHidden] = React.useState<ReadonlySet<string>>(() => new Set());
  const [queue] = React.useState(() => createRemovalQueue<ClientMemoryReceipt>());

  const setMember = React.useCallback((id: string, on: boolean) => {
    setHidden((current) => {
      if (current.has(id) === on) return current;
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const send = React.useCallback(
    async (memory: ClientMemoryReceipt) => {
      try {
        const response = await ports.fetch(`/api/memory/${encodeURIComponent(memory.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ forget: true }),
          keepalive: true,
        });
        if (!response.ok) throw new Error(String(response.status));
      } catch {
        toast.error(formatPhrase(PANEL_COPY.details.forgetFailed));
        setMember(memory.id, false);
      }
    },
    [ports, setMember]
  );

  const flushOne = React.useCallback(
    (id: string) => {
      const entry = queue.take(id);
      if (entry) void send(entry.memory);
    },
    [queue, send]
  );

  React.useEffect(() => {
    const flushAll = () => {
      for (const entry of queue.takeAll()) void send(entry.memory);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushAll();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      flushAll();
    };
  }, [queue, send]);

  const forget = React.useCallback(
    (memory: ClientMemoryReceipt) => {
      if (queue.has(memory.id)) return;
      setMember(memory.id, true);
      const toastId = toast.success(formatPhrase(PANEL_COPY.details.forgotten), {
        action: {
          label: formatPhrase(PANEL_COPY.details.undo),
          onClick: () => {
            if (queue.cancel(memory.id)) setMember(memory.id, false);
          },
        },
        onAutoClose: () => flushOne(memory.id),
        onDismiss: () => flushOne(memory.id),
      });
      queue.add({ memory, kind: "forget", toastId });
    },
    [queue, setMember, flushOne]
  );

  return { hidden, forget };
}

function MemoryRow({ memory, onForget }: { memory: ClientMemoryReceipt; onForget(memory: ClientMemoryReceipt): void }) {
  const sourceHref =
    memory.sourceRef && !["manual", "edit", "forget"].includes(memory.sourceRef) ? `/chat/${memory.sourceRef}` : null;
  return (
    <li className="flex flex-col gap-1 py-1.5">
      {/* The saved fact is the reader's own content: shown as written. */}
      <p className="break-words text-ui text-foreground/85" data-no-auto-translate dir="auto">
        {memory.content}
      </p>
      <div className="flex flex-wrap gap-x-3 text-caption text-muted-foreground">
        {sourceHref && (
          <a
            href={sourceHref}
            className="underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-foreground hover:underline"
          >
            <Phrase text={PANEL_COPY.details.openSourceChat} />
          </a>
        )}
        <button
          type="button"
          onClick={() => onForget(memory)}
          className="underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-foreground hover:underline"
        >
          <Phrase text={PANEL_COPY.details.forget} />
        </button>
      </div>
    </li>
  );
}

export function ActivityDetailsTab({ details }: { details: DetailsModel }) {
  const { hidden, forget } = useForgetWithUndo();
  const memory = details.memory.filter((entry) => !hidden.has(entry.id));
  const context = details.context ? contextLine(details.context) : [];
  const provider = providerLabel(details.model?.provider ?? null);

  return (
    <dl className="flex flex-col divide-y divide-border/60 px-4 py-1">
      {details.model && (
        <Row term={PANEL_COPY.details.model}>
          <bdi translate="no" lang="" data-no-auto-translate>
            {details.model.label}
          </bdi>
          {provider ? (
            <span className="block text-caption text-muted-foreground" translate="no" data-no-auto-translate>
              {provider}
            </span>
          ) : null}
          {details.model.routed ? (
            <span className="block text-caption text-muted-foreground">
              <Phrase text={PANEL_COPY.details.routed} />
            </span>
          ) : null}
        </Row>
      )}
      {details.effort && (
        <Row term={PANEL_COPY.details.effort}>
          <Phrase text={PANEL_COPY.details.rung[details.effort.rung]} />
          {details.effort.auto ? (
            <span className="block text-caption text-muted-foreground">
              <Phrase text={PANEL_COPY.details.chosenAutomatically} />
            </span>
          ) : null}
        </Row>
      )}
      {context.length > 0 && (
        <Row term={PANEL_COPY.details.context}>
          <PhraseWithArgs spec={context} />
        </Row>
      )}
      {details.tools && <ToolsRow tools={details.tools} />}
      {details.connectors && <ConnectorsRow connectors={details.connectors} />}
      {details.memory.length > 0 && (
        <Row term={PANEL_COPY.details.memory}>
          {memory.length > 0 ? (
            <ul className="flex flex-col">
              {memory.map((entry) => (
                <MemoryRow key={entry.id} memory={entry} onForget={forget} />
              ))}
            </ul>
          ) : null}
          <a
            href="/memory"
            className="mt-1 inline-block text-caption text-muted-foreground underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-foreground hover:underline"
          >
            <Phrase text={PANEL_COPY.details.manageAll} />
          </a>
        </Row>
      )}
    </dl>
  );
}
