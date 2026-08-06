"use client";

import * as React from "react";
import Link from "next/link";
import { Check, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { ConnectorStatus } from "@/components/connections/types";
import { trustPermitsAutoSelection, type ClientWorkSkill } from "@/lib/work/skills";
import { fetchWorkSkills } from "@/components/work/work-transport";
import { cn } from "@/lib/utils";

/*
 * What this task can reach for: the skills Juno may apply, and the apps it is
 * linked to.
 *
 * Both halves are facts about the account rather than about this one task, and
 * the panel says so rather than pretending otherwise. There is no per-task
 * connector grant to render: `WorkSession` has no connector column, no route
 * accepts one, and a switch here would persist a preference in this browser
 * that no executor ever reads — a control that looks like permission and grants
 * nothing is worse than no control, because the reader would stop checking.
 *
 * What is true and worth stating is the shape of the rule. A run can only use an
 * app that is linked to the account, so the list below is the ceiling; and a
 * skill is only ever picked up unasked when it has been trusted, which is a
 * decision made on the skill itself. Both are one link away, and both are read
 * from the endpoints that own them rather than restated here.
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
    return (
      <div className="space-y-2">
        {[...Array(2)].map((_, index) => (
          <Skeleton
            key={index}
            className="h-9 w-full rounded-xl"
            style={{ animationDelay: `${index * 70}ms` }}
          />
        ))}
      </div>
    );
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
        <p className="mb-1.5 font-mono text-[10px] text-muted-foreground/70">Skills</p>
        {skills === null ? (
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            Your skills couldn’t be read just now.
          </p>
        ) : automatic.length === 0 && named.length === 0 ? (
          <p className="text-[13px] leading-relaxed text-muted-foreground">
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
                    icon={<Sparkles className="h-3 w-3 text-primary" aria-hidden="true" />}
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
                    icon={<Sparkles className="h-3 w-3 text-muted-foreground" aria-hidden="true" />}
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
        <p className="mb-1.5 font-mono text-[10px] text-muted-foreground/70">Apps</p>
        {connectors === null ? (
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            Your connections couldn’t be read just now.
          </p>
        ) : linked.length === 0 ? (
          <p className="text-[13px] leading-relaxed text-muted-foreground">
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
                  icon={<Check className="h-3 w-3 text-success-ink" aria-hidden="true" />}
                  label={connector.label}
                  note={connector.accountLabel ?? "Linked"}
                />
              ))}
            </ul>
            {/* The ceiling, stated once. A task cannot reach an app that is not
                on this list, and nothing it does can add one. */}
            <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
              A task can only reach an app that is linked here. Anything else is simply not available
              to it.
            </p>
          </>
        )}
      </div>

      {failed && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void load()}
          className="h-7 gap-1.5 px-2 font-mono text-[10px] text-muted-foreground"
        >
          <RefreshCw className="h-3 w-3" aria-hidden="true" /> Try again
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
      <Link
        href={href}
        className="flex items-center gap-2 rounded-lg px-1.5 py-1 transition-colors duration-fast ease-out-soft hover:bg-accent/60"
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">{icon}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{label}</span>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{note}</span>
      </Link>
    </li>
  );
}
