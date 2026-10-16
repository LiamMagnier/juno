"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { ClientWorkHost } from "@/lib/work/serializers";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { WorkScheduleEditor } from "@/components/work/work-schedule-editor";
import { fetchWorkHosts } from "@/components/work/work-transport";
import { readRoutineDraft, type RoutineDraftHandoff } from "@/components/work/routine-draft";
import { FEATURE_NAMES, PRODUCT_NAME } from "@/lib/brand/names";

/**
 * A new schedule.
 *
 * The host list is loaded here and handed down rather than fetched inside the
 * editor, because the editor is shared with the edit page and a component that
 * fetched its own would do it twice on a page that already had the answer.
 *
 * A failed host load is not blocking. `hosts: null` renders the Mac picker
 * disabled with "Any of my Macs" in it, and the one thing that genuinely
 * requires the list — pinning to a named Mac — is refused by the form with a
 * sentence rather than by a save that 404s on a host id nobody could choose.
 *
 * `?draft=<id>` opens it on a routine handed over from a chat card's "More
 * options" (src/components/work/routine-draft.ts). The id names an entry in
 * this tab's session storage, never the routine itself, and the editor waits
 * the one effect it takes to read it so it starts on the right fields.
 */
export default function NewAutomationPage() {
  const router = useRouter();
  const [hosts, setHosts] = React.useState<ClientWorkHost[] | null>(null);
  const [prefill, setPrefill] = React.useState<RoutineDraftHandoff | null | undefined>(undefined);

  React.useEffect(() => {
    void fetchWorkHosts().then((result) => {
      if (result.kind === "ok") setHosts(result.value);
    });
  }, []);

  React.useEffect(() => {
    let id: string | null = null;
    try {
      id = new URLSearchParams(window.location.search).get("draft");
    } catch {
      id = null;
    }
    setPrefill(readRoutineDraft(id));
  }, []);

  return (
    <AppPage measure="reading">
      <AppPageHeader
        eyebrow={FEATURE_NAMES.routines.label}
        heading="New routine"
        lede={`Say what should happen, when it should start, and what ${PRODUCT_NAME} may do about it while you are not there.`}
        backHref="/automations"
        backLabel="Back to routines"
      />
      {prefill !== undefined && (
        <WorkScheduleEditor
          schedule={null}
          hosts={hosts}
          prefill={prefill}
          onSaved={(schedule) => router.push(`/automations/${schedule.id}`)}
          onCancel={() => router.push("/automations")}
        />
      )}
    </AppPage>
  );
}
