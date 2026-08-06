"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { ClientWorkHost } from "@/lib/work/serializers";
import { WorkPageFrame } from "@/components/work/work-nav";
import { WorkScheduleEditor } from "@/components/work/work-schedule-editor";
import { fetchWorkHosts } from "@/components/work/work-transport";

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
 */
export default function NewWorkSchedulePage() {
  const router = useRouter();
  const [hosts, setHosts] = React.useState<ClientWorkHost[] | null>(null);

  React.useEffect(() => {
    void fetchWorkHosts().then((result) => {
      if (result.kind === "ok") setHosts(result.value);
    });
  }, []);

  return (
    <WorkPageFrame
      title="New schedule"
      description="Say what should happen, when it should start, and what Juno may do about it while you are not there."
      back={{ href: "/work/schedules", label: "Back to schedules" }}
    >
      <WorkScheduleEditor
        schedule={null}
        hosts={hosts}
        onSaved={(schedule) => router.push(`/work/schedules/${schedule.id}`)}
        onCancel={() => router.push("/work/schedules")}
      />
    </WorkPageFrame>
  );
}
