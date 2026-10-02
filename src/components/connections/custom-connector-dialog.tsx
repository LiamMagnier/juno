"use client";

import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { toast } from "sonner";
import { KeyRound, Link2Off, RefreshCw, Trash2 } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { SkillDialogContent, SkillDialogFixed, SkillDialogStep } from "@/components/skills/skill-dialog-shell";
import { WorkStateNote } from "@/components/work/work-vocabulary";
import {
  beginCustomConnectorSignIn,
  CustomConnectorError,
  getCustomConnector,
  monogram,
  refreshCustomConnectorTools,
  removeCustomConnector,
  updateCustomConnector,
  type CustomConnector,
  type CustomConnectorTool,
} from "@/components/connections/custom-connector-api";
import { staggerDelay, transition } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { PRODUCT_NAME } from "@/lib/brand/names";

/**
 * One custom MCP server, managed: its name, whether Juno is signed in, and
 * the tools Juno may use, one switch each.
 *
 * Tools are split by what they do, not alphabetically, because that is the
 * decision being made: READS can run without a word, CHANGES wait for your
 * approval in the chat (the broker's rule for every connector, restated here
 * so the switch reads as "allowed at all", not "allowed unasked"). A server's
 * own read-only hints decide the split, with Juno's name heuristics as the
 * fallback, which is also how the runtime classifies them.
 *
 * Switching a tool off takes it out of the list the model is ever shown, from
 * the next message on. The list is the server's own, fetched on open when it
 * was never fetched and on Refresh; chats always list live regardless.
 */
export function CustomConnectorDialog({
  connectorId,
  onOpenChange,
  onChanged,
  onDisconnect,
}: {
  connectorId: string | null;
  onOpenChange: (open: boolean) => void;
  /** The directory's copy is stale (renamed, tools changed, removed). */
  onChanged: () => void;
  onDisconnect: (connector: CustomConnector) => void;
}) {
  return (
    <Dialog open={connectorId !== null} onOpenChange={onOpenChange}>
      <SkillDialogContent className="max-w-lg" aria-describedby={undefined}>
        {connectorId ? (
          <ManageConnector
            key={connectorId}
            id={connectorId}
            onClose={() => onOpenChange(false)}
            onChanged={onChanged}
            onDisconnect={onDisconnect}
          />
        ) : null}
      </SkillDialogContent>
    </Dialog>
  );
}

function ManageConnector({
  id,
  onClose,
  onChanged,
  onDisconnect,
}: {
  id: string;
  onClose: () => void;
  onChanged: () => void;
  onDisconnect: (connector: CustomConnector) => void;
}) {
  const [connector, setConnector] = React.useState<CustomConnector | null>(null);
  const [failed, setFailed] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [confirmRemove, setConfirmRemove] = React.useState(false);
  const [removing, setRemoving] = React.useState(false);

  const refresh = React.useCallback(
    async (quiet = false) => {
      setRefreshing(true);
      try {
        const { connector: fresh } = await refreshCustomConnectorTools(id);
        setConnector(fresh);
        setFailed(null);
        onChanged();
      } catch (err) {
        const message = err instanceof CustomConnectorError ? err.message : "Couldn't reach the server.";
        if (quiet) setFailed(message);
        else toast.error(message);
      } finally {
        setRefreshing(false);
      }
    },
    [id, onChanged]
  );

  React.useEffect(() => {
    let live = true;
    getCustomConnector(id)
      .then(({ connector: loaded }) => {
        if (!live) return;
        setConnector(loaded);
        // Never listed (the first list after sign-in timed out): ask now.
        if (loaded.connected && loaded.tools === null) void refresh(true);
      })
      .catch(() => live && setFailed("Couldn't load this server."));
    return () => {
      live = false;
    };
  }, [id, refresh]);

  const save = async (patch: { name?: string; disabledTools?: string[] }, rollback: CustomConnector) => {
    try {
      const { connector: saved } = await updateCustomConnector(id, patch);
      setConnector(saved);
      onChanged();
    } catch (err) {
      setConnector(rollback);
      toast.error(err instanceof CustomConnectorError ? err.message : "Couldn't save that change.");
    }
  };

  const setToolsEnabled = (names: string[], on: boolean) => {
    if (!connector) return;
    const disabled = new Set(connector.disabledTools);
    for (const name of names) {
      if (on) disabled.delete(name);
      else disabled.add(name);
    }
    const next = { ...connector, disabledTools: [...disabled] };
    const before = connector;
    setConnector(next);
    void save({ disabledTools: next.disabledTools }, before);
  };

  const rename = (value: string) => {
    if (!connector) return;
    const name = value.trim();
    if (!name || name === connector.name) return;
    const before = connector;
    setConnector({ ...connector, name });
    void save({ name }, before);
  };

  const remove = async () => {
    setRemoving(true);
    try {
      await removeCustomConnector(id);
      toast.success(`Removed ${connector?.name ?? "the server"}.`);
      onChanged();
      onClose();
    } catch (err) {
      setRemoving(false);
      toast.error(err instanceof CustomConnectorError ? err.message : "Couldn't remove it. Try again.");
    }
  };

  if (!connector) {
    return (
      <SkillDialogStep key="loading" className="p-5 sm:p-6">
        <DialogTitle className="sr-only">Loading server</DialogTitle>
        {failed ? (
          <WorkStateNote tone="error">{failed}</WorkStateNote>
        ) : (
          <div role="status" aria-label="Loading" className="space-y-3">
            <div className="flex items-center gap-3">
              <Skeleton className="size-10 rounded-field" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-56" />
              </div>
            </div>
            <Skeleton className="h-24 w-full rounded-card" />
          </div>
        )}
      </SkillDialogStep>
    );
  }

  const tools = connector.tools ?? [];
  const disabled = new Set(connector.disabledTools);
  const reads = tools.filter((t) => t.access === "read");
  const changes = tools.filter((t) => t.access !== "read");
  const onCount = tools.filter((t) => !disabled.has(t.name)).length;

  return (
    <>
      <SkillDialogFixed className="border-b border-border/60 p-5 pb-4 sm:p-6 sm:pb-4">
        <div className="flex items-center gap-3 pr-10">
          <span
            aria-hidden="true"
            className="surface-inset flex size-10 shrink-0 items-center justify-center rounded-field text-ui font-semibold text-foreground"
          >
            {monogram(connector.name)}
          </span>
          <div className="min-w-0 flex-1">
            <DialogTitle className="sr-only">{connector.name}</DialogTitle>
            <NameField value={connector.name} onCommit={rename} />
            <DialogDescription className="truncate px-1.5 font-mono text-caption text-muted-foreground" translate="no">
              {connector.host}
            </DialogDescription>
          </div>
        </div>
        {connector.description ? (
          <p className="mt-3 line-clamp-3 text-caption leading-5 text-muted-foreground">{connector.description}</p>
        ) : null}
      </SkillDialogFixed>

      <AnimatePresence mode="popLayout" initial={false}>
        {!connector.connected ? (
          <SkillDialogStep key="signed-out" className="p-5 sm:p-6">
            <WorkStateNote tone="info">{`${PRODUCT_NAME} isn’t signed in to this server, so its tools aren’t available.`}</WorkStateNote>
            <div className="mt-4 flex justify-end">
              <Button onClick={() => beginCustomConnectorSignIn(connector.id)} className="gap-1.5">
                <KeyRound className="size-4" />
                Sign in
              </Button>
            </div>
          </SkillDialogStep>
        ) : (
          <SkillDialogStep key="tools" className="min-h-0 flex-1">
            <div className="flex items-center justify-between gap-2 px-5 pt-4 sm:px-6">
              <div>
                <h3 className="text-ui font-medium">Tools</h3>
                <p className="text-caption tabular-nums text-muted-foreground" aria-live="polite">
                  {connector.tools === null
                    ? refreshing
                      ? "Asking the server…"
                      : "Not listed yet"
                    : `${onCount} of ${tools.length} on`}
                </p>
              </div>
              <IconButton
                label="Refresh tools"
                onClick={() => void refresh()}
                disabled={refreshing}
                className="size-8"
              >
                <RefreshCw className={cn("size-4", refreshing && "motion-safe:animate-spin")} />
              </IconButton>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-2 pt-3 sm:px-6">
              {failed && connector.tools === null ? (
                <WorkStateNote tone="error">{failed}</WorkStateNote>
              ) : connector.tools === null ? (
                <div className="space-y-2" aria-hidden="true">
                  {[0, 1, 2].map((i) => (
                    <Skeleton key={i} className="h-12 w-full rounded-field" />
                  ))}
                </div>
              ) : tools.length === 0 ? (
                <p className="py-6 text-center text-caption text-muted-foreground">This server offers no tools.</p>
              ) : (
                <div className="space-y-5">
                  <ToolGroup
                    title="Reads"
                    note={`${PRODUCT_NAME} uses these as needed.`}
                    tools={reads}
                    disabled={disabled}
                    onToggle={setToolsEnabled}
                  />
                  <ToolGroup
                    title="Changes things"
                    note={`${PRODUCT_NAME} asks you in the chat before each use.`}
                    tools={changes}
                    disabled={disabled}
                    onToggle={setToolsEnabled}
                    offset={reads.length}
                  />
                </div>
              )}
            </div>
          </SkillDialogStep>
        )}
      </AnimatePresence>

      <SkillDialogFixed className="flex items-center justify-between gap-2 border-t border-border/60 px-5 py-3 sm:px-6">
        <AnimatePresence mode="wait" initial={false}>
          {confirmRemove ? (
            <motion.div
              key="confirm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: transition.base }}
              exit={{ opacity: 0, transition: transition.exit }}
              className="flex w-full items-center justify-between gap-2"
            >
              <span className="text-caption text-muted-foreground">Remove it and sign out?</span>
              <div className="flex gap-1.5">
                <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(false)} disabled={removing}>
                  Keep
                </Button>
                <Button variant="destructive" size="sm" onClick={() => void remove()} loading={removing}>
                  Remove
                </Button>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="actions"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: transition.base }}
              exit={{ opacity: 0, transition: transition.exit }}
              className="flex w-full items-center justify-between gap-2"
            >
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmRemove(true)}
                className="danger-hover gap-1.5 px-2 text-muted-foreground"
              >
                <Trash2 className="size-3.5" />
                Remove server
              </Button>
              {connector.connected ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onDisconnect(connector)}
                  className="danger-hover gap-1.5 px-2 text-muted-foreground"
                >
                  <Link2Off className="size-3.5" />
                  Sign out
                </Button>
              ) : null}
            </motion.div>
          )}
        </AnimatePresence>
      </SkillDialogFixed>
    </>
  );
}

/** The name as a quiet field: reads as the title, edits in place. */
function NameField({ value, onCommit }: { value: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => setDraft(value), [value]);
  return (
    <Input
      value={draft}
      aria-label="Name"
      onChange={(event) => setDraft(event.target.value.slice(0, 60))}
      onBlur={() => (draft.trim() ? onCommit(draft) : setDraft(value))}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setDraft(value);
          event.currentTarget.blur();
        }
      }}
      className="h-8 border-transparent bg-transparent px-1.5 text-heading font-medium shadow-none hover:border-border/60 focus-visible:border-border"
    />
  );
}

function ToolGroup({
  title,
  note,
  tools,
  disabled,
  onToggle,
  offset = 0,
}: {
  title: string;
  note: string;
  tools: CustomConnectorTool[];
  disabled: Set<string>;
  onToggle: (names: string[], on: boolean) => void;
  offset?: number;
}) {
  const reduce = useReducedMotion() ?? false;
  if (tools.length === 0) return null;
  const allOn = tools.every((t) => !disabled.has(t.name));
  return (
    <section aria-label={title}>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <h4 className="text-caption font-medium text-foreground">{title}</h4>
          <p className="text-micro text-muted-foreground">{note}</p>
        </div>
        <button
          type="button"
          onClick={() => onToggle(tools.map((t) => t.name), !allOn)}
          className="shrink-0 rounded-control px-1.5 py-0.5 text-caption text-muted-foreground transition-colors duration-fast hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {allOn ? "Turn all off" : "Turn all on"}
        </button>
      </div>
      <ul className="divide-y divide-border/60">
        {tools.map((tool, index) => {
          const on = !disabled.has(tool.name);
          return (
            <li
              key={tool.name}
              className="flex items-start gap-3 py-2.5 motion-safe:animate-rise-in [animation-fill-mode:backwards]"
              style={staggerDelay(index + offset, "tight")}
            >
              <div
                className={cn(
                  "min-w-0 flex-1 transition-opacity duration-fast ease-out-soft",
                  !on && !reduce && "opacity-55",
                  !on && reduce && "opacity-70"
                )}
              >
                <p className="truncate text-ui leading-5 text-foreground">
                  {tool.title ?? <span className="font-mono text-ui">{tool.name}</span>}
                </p>
                {tool.description ? (
                  <p className="line-clamp-2 text-caption leading-4 text-muted-foreground">{tool.description}</p>
                ) : null}
              </div>
              <Switch
                checked={on}
                onCheckedChange={(value) => onToggle([tool.name], value)}
                aria-label={`Let ${PRODUCT_NAME} use ${tool.title ?? tool.name}`}
                className="mt-0.5"
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
