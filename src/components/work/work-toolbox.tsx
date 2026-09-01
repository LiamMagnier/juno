"use client";

import * as React from "react";
import Link from "next/link";
import { Wrench } from "lucide-react";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Pressable } from "@/components/ui/pressable";
import type { ConnectorStatus } from "@/components/connections/types";
import { trustPermitsAutoSelection, type ClientWorkSkill } from "@/lib/work/skills";
import { WorkRowSkeletons } from "@/components/work/shell/work-states";
import { fetchWorkSkills } from "@/components/work/work-transport";
import { cn } from "@/lib/utils";

/*
 * What this task can reach for: the skills Juno may apply, and the apps the
 * account is linked to.
 *
 * Both halves are facts about the account rather than about this one task, and
 * the panel says so rather than pretending otherwise. The per-task narrowing is
 * real now — a session carries the apps the reader switched on for it, and the
 * executor refuses the rest — but it is chosen in the composer, before the task
 * exists, and it is not editable from here. Rendering a switch on this panel
 * would be the mistake this comment used to describe from the other side: a
 * control that looks like permission while the run it belongs to has already
 * resolved its connectors and started.
 *
 * What is true and worth stating is the shape of the rule. A run can only use an
 * app that is linked to the account, so the list below is the ceiling rather
 * than the grant; and a skill is only ever picked up unasked when it has been
 * trusted, which is a decision made on the skill itself. Both are one link away,
 * and both are read from the endpoints that own them rather than restated here.
 */

interface ConnectorsResponse {
  connectors?: ConnectorStatus[];
}

export function WorkToolbox() {
  const [skills, setSkills] = React.useState<ClientWorkSkill[] | null>(null);
  const [connectors, setConnectors] = React.useState<ConnectorStatus[] | null>(null);
  const [failed, setFailed] = React.useState(false);

  const load = React.useCallback(async () => {
    setFailed(false);
    const [skillResult, connectorResult] = await Promise.all([
      fetchWorkSkills(),
      // The chat surface's own endpoint, not a second one written for Work. A
      // parallel connector list would be a parallel answer to "is Gmail linked",
      // and the two would disagree the first time somebody disconnected it from
      // the other page.
      fetch("/api/connectors")
        .then(async (response) =>
          response.ok ? ((await response.json()) as ConnectorsResponse) : null
        )
        .catch(() => null),
    ]);

    if (skillResult.kind === "ok") setSkills(skillResult.value);
    if (connectorResult !== null) setConnectors(connectorResult.connectors ?? []);
    if (skillResult.kind !== "ok" || connectorResult === null) setFailed(true);
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  if (skills === null && connectors === null && !failed) {
    // 36px, the height of a `ToolboxRow` — a label over a note, at row density.
    return <WorkRowSkeletons count={2} height={36} className="space-y-2" />;
  }

  // `autoSelect` and `trust` are written separately and only the pair is the
  // answer, which is why this asks `trustPermitsAutoSelection` rather than
  // reading the one column: a row saying `autoSelect: true, trust: "untrusted"`
  // is a skill the planner will not touch, and listing it as one it might would
  // be the wrong way round to be wrong.
  const chosenForYou = (skill: ClientWorkSkill) =>
    skill.autoSelect && trustPermitsAutoSelection(skill.trust);
  const enabled = (skills ?? []).filter((skill) => skill.enabled);
  const automatic = enabled.filter(chosenForYou);
  const named = enabled.filter((skill) => !chosenForYou(skill));
  const linked = (connectors ?? []).filter((connector) => connector.connected);

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-1.5 font-mono text-label text-muted-foreground">Skills</p>
        {skills === null ? (
          <p className="text-ui leading-relaxed text-muted-foreground">
            Your skills couldn’t be read just now.
          </p>
        ) : automatic.length === 0 && named.length === 0 ? (
          <p className="text-ui leading-relaxed text-muted-foreground">
            No skills yet. A skill is a set of instructions with a name, so you can hand Juno a way
            of working instead of describing it again.{" "}
            <Link href="/work/skills" className="underline underline-offset-2 hover:text-foreground">
              Write one
            </Link>
            .
          </p>
        ) : (
          <>
            {automatic.length > 0 && (
              <ul className="space-y-1">
                {automatic.map((skill) => (
                  <ToolboxRow
                    key={skill.id}
                    href={`/work/skills/${skill.id}`}
                    icon={<Wrench className="size-3 text-muted-foreground" aria-hidden="true" />}
                    label={skill.name}
                    note="Juno may apply this on its own"
                  />
                ))}
              </ul>
            )}
            {named.length > 0 && (
              <ul className={cn("space-y-1", automatic.length > 0 && "mt-1")}>
                {named.map((skill) => (
                  <ToolboxRow
                    key={skill.id}
                    href={`/work/skills/${skill.id}`}
                    icon={<Wrench className="size-3 text-muted-foreground" aria-hidden="true" />}
                    label={skill.name}
                    note={`Only when you type /${skill.slug}`}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      <div>
        <p className="mb-1.5 font-mono text-label text-muted-foreground">Apps</p>
        {connectors === null ? (
          <p className="text-ui leading-relaxed text-muted-foreground">
            Your connections couldn’t be read just now.
          </p>
        ) : linked.length === 0 ? (
          <p className="text-ui leading-relaxed text-muted-foreground">
            Nothing is linked, so this task reaches nothing outside Juno.{" "}
            <Link href="/connections" className="underline underline-offset-2 hover:text-foreground">
              Connect an app
            </Link>
            .
          </p>
        ) : (
          <>
            <ul className="space-y-1">
              {linked.map((connector) => (
                <ToolboxRow
                  key={connector.id}
                  href="/connections"
                  icon={<StatusIcons.success className="size-3 text-success-ink" aria-hidden="true" />}
                  label={connector.label}
                  note={connector.accountLabel ?? "Linked"}
                />
              ))}
            </ul>
            {/* The ceiling, stated once, and the fact that a task may sit below
                it. Saying only the first would read as a promise that every app
                here is available to this task, which is exactly what the
                composer's switches decide. */}
            <p className="mt-2 text-caption leading-relaxed text-muted-foreground">
              A task can only reach an app that is linked here, and only the ones it was given when
              it was written. Anything else is simply not available to it.
            </p>
          </>
        )}
      </div>

      {failed && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void load()}
          className="h-7 gap-1.5 px-2 font-mono text-micro text-muted-foreground"
        >
          <ActionIcons.refresh className="size-3" aria-hidden="true" /> Try again
        </Button>
      )}
    </div>
  );
}

function ToolboxRow({
  href,
  icon,
  label,
  note,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  note: string;
}) {
  return (
    <li>
      {/* `Pressable kind="row"` is the primitive this shape was hand-written
          against four separate times in Work, each with its own radius, padding
          and hover fill. Nothing left here but the contents. */}
      <Pressable kind="row" size="sm" asChild>
        <Link href={href}>
          <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
          <span className="min-w-0 flex-1 truncate text-ui text-foreground">{label}</span>
          <span className="shrink-0 font-mono text-micro text-muted-foreground">{note}</span>
        </Link>
      </Pressable>
    </li>
  );
}
