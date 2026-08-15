"use client";

import * as React from "react";
import Link from "next/link";
import { FileUp, Loader2, Sparkles } from "lucide-react";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Pressable } from "@/components/ui/pressable";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { Switch } from "@/components/ui/switch";
import { useApp } from "@/components/app/app-provider";
import type { ConnectorStatus } from "@/components/connections/types";
import { useWorkSkills } from "@/components/work/composer-home/use-work-skills";
import type { WorkThreadContextState } from "@/components/work/composer/use-work-thread-context";
import type { WorkThreadFiles } from "@/components/work/composer/work-thread-files";
import { AppIcons } from "@/lib/app-icons";
import { cn } from "@/lib/utils";

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

export function WorkThreadAddPanel({
  context,
  files,
  onOpenLibrary,
}: {
  context: WorkThreadContextState;
  /**
   * The uploads, owned by the composer.
   *
   * They cannot live in here. Radix unmounts a popover's content when it closes,
   * so a `useUploads` in this file lost every in-flight upload the moment the
   * reader dismissed the menu — and the panel's own "Give it this file" button
   * is a SECOND deliberate press, which means closing the menu between the two
   * was not an unlikely path, it was the obvious one. Hoisted to the composer
   * the uploads also get somewhere to be seen: a chip strip above the field,
   * exactly as on the home composer.
   */
  files: WorkThreadFiles;
  /**
   * Opens the account's library.
   *
   * Owned by the composer rather than by this panel, and that is not tidiness:
   * `LibraryPicker` is a modal dialog and this panel lives inside a popover
   * Radix unmounts the moment focus leaves it, so a dialog opened from in here
   * would take its own trigger down with it. The composer closes the popover
   * and opens the dialog as one gesture, exactly as the Code composer's menu
   * does with the same picker.
   */
  onOpenLibrary: () => void;
}) {
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
          <div className="space-y-2 rounded-field border border-border/70 px-2.5 py-2">
            <p className="text-ui leading-relaxed text-muted-foreground">
              Juno couldn’t read what this task is already working with, so it can’t safely add to
              it. Nothing has changed.
            </p>
            <Button variant="outline" size="sm" onClick={context.reload} className="gap-1.5">
              <ActionIcons.refresh className="size-3.5" aria-hidden="true" /> Try again
            </Button>
          </div>
        )}

        {!context.reachKnown && !context.reachUnreadable && (
          <p className="flex items-center gap-2 font-mono text-caption text-muted-foreground">
            <Loader2 className="size-3 animate-spin" aria-hidden="true" />
            Reading what this task is working with…
          </p>
        )}

        {features.storage && context.reachKnown && (
          <FilesSection context={context} files={files} onOpenLibrary={onOpenLibrary} />
        )}

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
function FilesSection({
  context,
  files,
  onOpenLibrary,
}: {
  context: WorkThreadContextState;
  files: WorkThreadFiles;
  onOpenLibrary: () => void;
}) {
  return (
    // The hairline separates sections and never opens the panel with one, which
    // is what `first:` is doing on all three: any of them can be the first one
    // drawn, because each is conditional on what the account actually has.
    <div className="border-t border-border/60 pt-4 first:border-t-0 first:pt-0">
      <p className="mb-1.5 font-mono text-label text-muted-foreground">Files</p>
      <p className="mb-2 text-ui leading-relaxed text-muted-foreground">
        A run is handed its files when it starts, so anything added now is for the next attempt.
      </p>

      {/* Two pickers and nothing else. The files themselves — and the press that
          hands them to the task — are on the composer's own surface, above the
          field, where the home composer has always shown them. They were listed
          in here, inside a popover that unmounts on close, which is how a reader
          who picked a file, closed the menu to re-read the transcript and came
          back found it gone. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={files.pick}
          disabled={context.saving}
          className="gap-1.5"
        >
          <FileUp className="size-3.5" aria-hidden="true" /> Add a file
        </Button>
        {/* The home composer offers Files AND the library behind its [+]; this
            one offered only Files, so the same act — give this task a document
            — meant re-uploading something the account already holds. */}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onOpenLibrary}
          disabled={context.saving}
          className="gap-1.5"
        >
          <AppIcons.library className="size-3.5" aria-hidden="true" /> From your library
        </Button>
      </div>
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
      <p className="mb-1.5 font-mono text-label text-muted-foreground">Apps</p>
      {failed ? (
        <div className="space-y-2">
          <p className="text-ui leading-relaxed text-muted-foreground">
            Couldn’t read your connected apps, so there is nothing to switch here.
          </p>
          <Button variant="outline" size="sm" onClick={() => void load()} className="gap-1.5">
            <ActionIcons.refresh className="size-3.5" aria-hidden="true" /> Retry
          </Button>
        </div>
      ) : (
        <ul className="space-y-0.5">
          {(connectors ?? []).map((connector) => {
            const active = context.connectorIds.includes(connector.id);
            return (
              <li key={connector.id}>
                {/* `selected` is deliberately NOT set: the Switch beside the
                    label already reports on/off, and the row fill would be a
                    second, louder answer to the same question. This is here for
                    the shared radius, padding, press and disabled behaviour the
                    hand-rolled version was re-deciding. */}
                <Pressable
                  kind="row"
                  size="sm"
                  role="switch"
                  aria-checked={active}
                  disabled={context.saving}
                  onClick={() => toggle(connector.id)}
                >
                  <AppIcons.connections
                    className={cn(
                      "size-3.5 shrink-0",
                      active ? "text-primary" : "text-muted-foreground"
                    )}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate text-ui">{connector.label}</span>
                  <Switch checked={active} tabIndex={-1} aria-hidden className="pointer-events-none" />
                </Pressable>
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-2 text-caption leading-relaxed text-muted-foreground">
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
      <p className="mb-1.5 font-mono text-label text-muted-foreground">Skill</p>
      {failed ? (
        <div className="space-y-2">
          <p className="text-ui leading-relaxed text-muted-foreground">
            Couldn’t read your skills. This is empty because the request failed, not because you
            have none.
          </p>
          <Button variant="outline" size="sm" onClick={reload} className="gap-1.5">
            <ActionIcons.refresh className="size-3.5" aria-hidden="true" /> Retry
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
                <Pressable
                  kind="row"
                  size="sm"
                  selected={active}
                  disabled={context.saving}
                  aria-pressed={active}
                  onClick={() => context.change({ skillSlug: active ? null : skill.slug })}
                >
                  <Sparkles
                    className={cn(
                      "size-3.5 shrink-0",
                      active ? "text-primary" : "text-muted-foreground"
                    )}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ui">{skill.name}</span>
                    <span className="block truncate font-mono text-micro text-muted-foreground">
                      /{skill.slug}
                    </span>
                  </span>
                  {active && <StatusIcons.success className="size-3.5 shrink-0 text-primary" aria-hidden="true" />}
                </Pressable>
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-2 text-caption leading-relaxed text-muted-foreground">
        The attempt now running keeps the skill it started with.{" "}
        <Link href="/work/skills" className="underline underline-offset-2 hover:text-foreground">
          Manage skills
        </Link>
        .
      </p>
    </div>
  );
}
