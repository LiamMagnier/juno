"use client";

import * as React from "react";
import Link from "next/link";
import { Plus, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ClientWorkSkill } from "@/lib/work/skills";
import { WorkPageFrame } from "@/components/work/work-nav";
import { WorkSkillRow } from "@/components/work/work-skill-row";
import { WorkLoadError, WorkRowSkeletons } from "@/components/work/shell/work-states";
import { fetchWorkSkills } from "@/components/work/work-transport";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * The instructions Juno can be handed, rather than told again every time.
 *
 * A skill is a set of instructions plus a declaration of what it wants — tools,
 * connectors, a policy — and the declaration is a request, never a grant:
 * `resolveSkillPermissions` intersects it with what the account, the project and
 * the Mac have already allowed, and the intersection can only come out smaller.
 * That is worth saying on the page, because a skill is the one thing in Work a
 * person might paste in from somewhere else.
 */
export default function WorkSkillsPage() {
  const [skills, setSkills] = React.useState<ClientWorkSkill[] | null>(null);
  const [failed, setFailed] = React.useState(false);

  const load = React.useCallback(async () => {
    setFailed(false);
    const result = await fetchWorkSkills();
    if (result.kind === "ok") {
      setSkills(result.value);
      return;
    }
    setFailed(true);
    setSkills(null);
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  return (
    <WorkPageFrame
      title="Skills"
      description="Reusable instructions with a name. Type a slash and its name in a task, or let Juno reach for one itself — which it only ever does for a skill you have said you trust."
      action={
        <Button asChild size="sm" className="gap-1.5">
          <Link href="/work/skills/new">
            <Plus className="size-3.5" aria-hidden="true" /> New skill
          </Link>
        </Button>
      }
    >
      {failed ? (
        <WorkLoadError onRetry={() => void load()}>
          Couldn’t load your skills. This page is empty because the request failed, not because you
          have none.
        </WorkLoadError>
      ) : skills === null ? (
        <WorkRowSkeletons />
      ) : skills.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          title="No skills yet"
          description="Write down the way you want something done once — how your invoices are filed, what a weekly summary has to contain — and hand it to Juno by name instead of describing it again each time."
          action={
            <Button asChild size="sm" className="gap-1.5">
              <Link href="/work/skills/new">
                <Plus className="size-3.5" aria-hidden="true" /> New skill
              </Link>
            </Button>
          }
        />
      ) : (
        <div className="space-y-2.5">
          {skills.map((skill, index) => (
            <WorkSkillRow key={skill.id} skill={skill} index={index} />
          ))}
        </div>
      )}
    </WorkPageFrame>
  );
}
