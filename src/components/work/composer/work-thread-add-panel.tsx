"use client";

import * as React from "react";
import Link from "next/link";
import { Check, FileText, FileUp, Loader2, RefreshCw, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { Switch } from "@/components/ui/switch";
import { useApp } from "@/components/app/app-provider";
import { useUploads } from "@/hooks/use-uploads";
import type { ConnectorStatus } from "@/components/connections/types";
import { useWorkSkills } from "@/components/work/composer-home/use-work-skills";
import type { WorkThreadContextState } from "@/components/work/composer/use-work-thread-context";
import { AppIcons } from "@/lib/app-icons";
import { DOC_MIME } from "@/lib/uploads";
import { cn, formatBytes } from "@/lib/utils";

/*
 * The [+] on a running task: everything you can hand it that is not a message.
 *
 * The panel this replaced said there was nothing here to add — that a task is
 * handed its files, its apps and its skill when it starts and no route edits
 * them afterwards. That was true and is no longer: `PATCH
 * /sessions/[id]/context` exists, and what changed with it is *when* a change
 * lands, not whether it can be made at all. So every section here says the same
 * thing in its own words — a running attempt keeps what it started with, and
 * what you add now is what the next one gets.
 *
 * Which is why this is not `ComposerAddMenu` from `composer-home/`. That menu is
 * written for a task that does not exist yet, where nothing has to be said about
 * timing and where picking a skill writes into a textarea the reader can still
 * edit. Here the goal is immutable and every section needs a sentence the home
 * menu has no slot for. The structure is deliberately the same three sections in
 * the same order, so the two read as one control in two places.
 *
 * ── Not knowing is a state ─────────────────────────────────────────────────
 *
 * Apps and files are grant rows, not columns on the session, so this client
 * cannot know what the task holds until it has read them. Until then:
 *
 *   - the app switches are not drawn at all. A switch shown off for an app the
 *     task actually holds is a lie about permission, and it is the kind that
 *     gets believed.
 *   - files are not offered. Handing one over means sending the whole list, and
 *     a list assembled without knowing what is already in it is how a grant
 *     somebody made yesterday disappears.
 *   - the skill *is* offered, because it is a single value rather than a set:
 *     naming one is a complete statement that needs nothing merged into it. Only
 *     the tick beside the current one is withheld, because that is the part
 *     nobody could read.
 */

/**
 * What the picker offers — the chat composer's document list with every image
 * type removed, for the reason the home composer gives: `attachedSources` in
 * scripts/work-runner.ts reads `Attachment.extractedText`, which is null for a
 * photo. Offering images would promise Juno a look at a picture it can never
 * get.
 */
const WORK_ACCEPT_ATTRIBUTE = [
  ...DOC_MIME,
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".ts",
  ".tsx",
  ".js",
  ".py",
].join(",");

export function WorkThreadAddPanel({ context }: { context: WorkThreadContextState }) {
  const { features } = useApp();
  const { load } = context;

  /*
   * Reading what the task holds happens here rather than in the composer, and
   * that is the whole cost argument: Radix mounts a popover's content when it
   * opens, so a reader who never opens the [+] never makes any of the three
   * requests on this panel. `load` runs at most once however often this mounts.
   */
  React.useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="flex max-h-[min(30rem,70vh)] flex-col">
      <ScrollFade className="min-h-0 flex-1" viewportClassName="space-y-4 p-3">
        {context.reachUnreadable && (
          <div className="space-y-2 rounded-lg border border-border/70 px-2.5 py-2">
            <p className="text-[12.5px] leading-relaxed text-muted-foreground">
              Juno couldn’t read what this task is already working with, so it can’t safely add to
              it. Nothing has changed.
            </p>
            <Button variant="outline" size="sm" onClick={context.reload} className="gap-1.5">
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Try again
            </Button>
          </div>
        )}

        {!context.reachKnown && !context.reachUnreadable && (
          <p className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
            <Loader2 className="size-3 animate-spin" aria-hidden="true" />
            Reading what this task is working with…
          </p>
        )}

        {features.storage && context.reachKnown && <FilesSection context={context} />}

        {context.reachKnown && <AppsSection context={context} />}

        {/* Skills last, and drawn even when the read failed: it is the one
            section that needs nothing merged into what is already there. The
            account-wide view of skills and connections — what Juno may reach for
            on its own, what is linked at all — is the rail's Context panel, one
            column across, and is not repeated here. */}
        <SkillSection context={context} />
      </ScrollFade>
    </div>
  );
}

/**
 * Documents handed to the task.
 *
 * Handing over is a press rather than a side effect of the upload finishing.
 * Two reasons, and the second is the one that matters: a reader who picked three
 * files gets one request and one sentence instead of three, and a request that
 * fails leaves the button exactly where it was — which is a retry that costs
 * nothing and needs no machinery to offer.
 *
 * The whole list is sent, not the new ids alone. `WorkFileGrant` rows are what
 * the next dispatch reads, and a partial list is only safe if the route is
 * certain to treat it as an addition. Sending what the task should end up with
 * is correct under either reading.
 */
function FilesSection({ context }: { context: WorkThreadContextState }) {
  const { uploads, addFiles, remove, isUploading, readyAttachments } = useUploads(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const pending = readyAttachments.filter(
    (attachment) => !context.attachmentIds.includes(attachment.id)
  );

  const hand = React.useCallback(() => {
    if (pending.length === 0 || context.saving) return;
    context.change({
      attachmentIds: [...context.attachmentIds, ...pending.map((attachment) => attachment.id)],
    });
  }, [context, pending]);

  return (
    // The hairline separates sections and never opens the panel with one, which
    // is what `first:` is doing on all three: any of them can be the first one
    // drawn, because each is conditional on what the account actually has.
    <div className="border-t border-border/60 pt-4 first:border-t-0 first:pt-0">
      <p className="mb-1.5 font-mono text-[10px] text-muted-foreground/70">Files</p>
      <p className="mb-2 text-[12.5px] leading-relaxed text-muted-foreground">
        A run is handed its files when it starts, so anything added now is for the next attempt.
      </p>

      {uploads.length > 0 && (
        <ul className="mb-2 space-y-1.5">
          {uploads.map((upload) => {
            const added =
              upload.attachment !== undefined &&
              context.attachmentIds.includes(upload.attachment.id);
            return (
              <li
                key={upload.localId}
                className="flex items-center gap-2 rounded-lg border border-border/70 px-2 py-1.5 motion-safe:animate-rise-in"
              >
                <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px]">{upload.fileName}</span>
                  <span className="block font-mono text-[10px] text-muted-foreground">
                    {upload.status === "uploading"
                      ? `${upload.progress}%`
                      : upload.status === "error"
                        ? "Couldn’t be uploaded"
                        : added
                          ? "On this task from the next attempt"
                          : formatBytes(upload.size)}
                  </span>
                </span>
                {upload.status === "uploading" && (
                  <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                )}
                {added ? (
                  <Check className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
                ) : (
                  <button
                    type="button"
                    onClick={() => remove(upload.localId)}
                    aria-label={`Remove ${upload.fileName}`}
                    className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors duration-fast ease-out-soft hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X className="size-3.5" aria-hidden="true" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => fileInputRef.current?.click()}
          disabled={context.saving}
          className="gap-1.5"
        >
          <FileUp className="h-3.5 w-3.5" aria-hidden="true" /> Add a file
        </Button>
        {pending.length > 0 && (
          <Button
            type="button"
            size="sm"
            onClick={hand}
            disabled={context.saving || isUploading}
            className="gap-1.5"
          >
            {context.saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : null}
            {pending.length === 1 ? "Give it this file" : `Give it these ${pending.length} files`}
          </Button>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={WORK_ACCEPT_ATTRIBUTE}
        className="hidden"
        onChange={(event) => {
          if (event.target.files?.length) addFiles(event.target.files);
          // Cleared so picking the same file twice still fires a change event.
          event.target.value = "";
        }}
      />
    </div>
  );
}

/**
 * Which connected apps this task may reach.
 *
 * Nothing here links, unlinks or re-authorises anything: it narrows one task
 * inside what the account already permits, which is why the footer sends the
 * reader to /connections rather than offering to connect an app from a composer.
 * `evaluateConnector` refuses everything left off with `not_selected_for_task`.
 */
function AppsSection({ context }: { context: WorkThreadContextState }) {
  const [connectors, setConnectors] = React.useState<ConnectorStatus[] | null>(null);
  const [failed, setFailed] = React.useState(false);

  const load = React.useCallback(async () => {
    setFailed(false);
    try {
      // The chat surface's own endpoint, not a second one written for Work: a
      // parallel connector list is a parallel answer to "is Gmail linked", and
      // the two disagree the first time somebody unlinks it elsewhere.
      const response = await fetch("/api/connectors");
      if (!response.ok) throw new Error("connectors");
      const data = (await response.json()) as { connectors?: ConnectorStatus[] };
      setConnectors((data.connectors ?? []).filter((connector) => connector.connected));
    } catch {
      setFailed(true);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const toggle = React.useCallback(
    (connectorId: string) => {
      const held = context.connectorIds.includes(connectorId);
      context.change({
        connectorIds: held
          ? context.connectorIds.filter((id) => id !== connectorId)
          : [...context.connectorIds, connectorId],
      });
    },
    [context]
  );

  // Nothing while the list is in flight, and nothing for an account with no
  // linked apps: a section headed "Apps" over "you have none" offers a choice
  // that does not exist, and the reach summary below already links to the page
  // that can do something about it.
  if (connectors === null && !failed) return null;
  if (!failed && connectors !== null && connectors.length === 0) return null;

  return (
    <div className="border-t border-border/60 pt-4 first:border-t-0 first:pt-0">
      <p className="mb-1.5 font-mono text-[10px] text-muted-foreground/70">Apps</p>
      {failed ? (
        <div className="space-y-2">
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            Couldn’t read your connected apps, so there is nothing to switch here.
          </p>
          <Button variant="outline" size="sm" onClick={() => void load()} className="gap-1.5">
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Retry
          </Button>
        </div>
      ) : (
        <ul className="space-y-0.5">
          {(connectors ?? []).map((connector) => {
            const active = context.connectorIds.includes(connector.id);
            return (
              <li key={connector.id}>
                <button
                  type="button"
                  role="switch"
                  aria-checked={active}
                  disabled={context.saving}
                  onClick={() => toggle(connector.id)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-fast ease-out-soft hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                >
                  <AppIcons.connections
                    className={cn(
                      "size-3.5 shrink-0",
                      active ? "text-primary" : "text-muted-foreground"
                    )}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate text-[12.5px]">{connector.label}</span>
                  <Switch checked={active} tabIndex={-1} aria-hidden className="pointer-events-none" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
        Off means this task cannot reach it. Your connections are unchanged —{" "}
        <Link href="/connections" className="underline underline-offset-2 hover:text-foreground">
          manage them
        </Link>
        .
      </p>
    </div>
  );
}

/**
 * The skill this task runs under.
 *
 * One at a time, because the runtime only has one: `applySkill` resolves exactly
 * one skill per run, and a list of switches would promise a stack of
 * instructions nothing can apply. Picking the current one takes it back off.
 *
 * The caveat here is sharper than the others and is stated rather than softened.
 * A skill is resolved when a run is built, and the goal a plan is validated
 * against is fixed for the life of the task — so this is a choice about the next
 * attempt, and there is no reading of it under which the attempt now running
 * changes what it is doing.
 */
function SkillSection({ context }: { context: WorkThreadContextState }) {
  const { skills, failed, reload } = useWorkSkills();

  if (skills === null && !failed) return null;
  if (!failed && skills !== null && skills.length === 0) return null;

  return (
    <div className="border-t border-border/60 pt-4 first:border-t-0 first:pt-0">
      <p className="mb-1.5 font-mono text-[10px] text-muted-foreground/70">Skill</p>
      {failed ? (
        <div className="space-y-2">
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            Couldn’t read your skills. This is empty because the request failed, not because you
            have none.
          </p>
          <Button variant="outline" size="sm" onClick={reload} className="gap-1.5">
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Retry
          </Button>
        </div>
      ) : (
        <ul className="space-y-0.5">
          {(skills ?? []).map((skill) => {
            // Only claimed where it was read. Until then the rows are choices
            // rather than a report of which one is in force.
            const active = context.reachKnown && context.skillSlug === skill.slug;
            return (
              <li key={skill.id}>
                <button
                  type="button"
                  disabled={context.saving}
                  aria-pressed={active}
                  onClick={() => context.change({ skillSlug: active ? null : skill.slug })}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-fast ease-out-soft hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                >
                  <Sparkles
                    className={cn(
                      "size-3.5 shrink-0",
                      active ? "text-primary" : "text-muted-foreground"
                    )}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px]">{skill.name}</span>
                    <span className="block truncate font-mono text-[10px] text-muted-foreground/70">
                      /{skill.slug}
                    </span>
                  </span>
                  {active && <Check className="size-3.5 shrink-0 text-primary" aria-hidden="true" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
        The attempt now running keeps the skill it started with.{" "}
        <Link href="/work/skills" className="underline underline-offset-2 hover:text-foreground">
          Manage skills
        </Link>
        .
      </p>
    </div>
  );
}
