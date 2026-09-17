"use client";

import * as React from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ClientWorkSkill } from "@/lib/work/skills";
import { AppIcons } from "@/lib/app-icons";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { WorkList } from "@/components/work/shell/work-section";
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
 * That is worth saying on the page, because a skill is the one thing here a
 * person might paste in from somewhere else.
 *
 * IT USED TO BE `/work/skills`, UNDER A TAB ROW. Work is no longer a place
 * (docs/design/TWO_PRODUCTS.md §2), so the four-tab track that made this one of
 * Work's rooms went with it — there is no sibling set to switch between any
 * more. This is a destination of its own, reached from More in the sidebar, and
 * a page reached that way opens on its name: no `Work` eyebrow saying which
 * section it belongs to, because it belongs to the product rather than to a
 * section. `/work/skills` still answers and still lands here, which matters
 * more for this page than for any other in the move — a shipped macOS build
 * links to it by hand.
 */
export default function SkillsPage() {
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
    <AppPage measure="wide">
      <AppPageHeader
        heading="Skills"
        lede="Reusable instructions with a name. Type a slash and the name in a task, or let Juno reach for one itself — only ever for a skill you have said you trust."
        actions={
          <Button asChild size="sm" className="gap-1.5">
            <Link href="/skills/new">
              <Plus className="size-3.5" aria-hidden="true" /> New skill
            </Link>
          </Button>
        }
      />

      {failed ? (
        <WorkLoadError onRetry={() => void load()}>
          Couldn’t load your skills. This page is empty because the request failed, not because
          you have none.
        </WorkLoadError>
      ) : skills === null ? (
        <WorkList>
          <WorkRowSkeletons />
        </WorkList>
      ) : skills.length === 0 ? (
        <EmptyState
          icon={AppIcons.skills}
          title="No skills yet"
          description="The easiest way to get one is to not write it. Delegate a task from the chat composer, and when the run finishes well, press “Save this as a skill” on it — Juno drafts the instructions from the steps it actually took and you edit them before anything is saved."
          action={
            <>
              <Button asChild size="sm" variant="outline">
                <Link href="/chat">Go and run something</Link>
              </Button>
              {/*
                Authoring is still here and still second. A blank textarea asking
                somebody to write instructions for a job they have not done yet
                is the hardest moment to write them, and leading with it is why
                skill libraries stay empty — but it is the right door for
                somebody bringing instructions they already have.
              */}
              <Button asChild size="sm" className="gap-1.5">
                <Link href="/skills/new">
                  <Plus className="size-3.5" aria-hidden="true" /> Write one
                </Link>
              </Button>
            </>
          }
        />
      ) : (
        <WorkList>
          {skills.map((skill, index) => (
            <WorkSkillRow key={skill.id} skill={skill} index={index} />
          ))}
        </WorkList>
      )}
    </AppPage>
  );
}
