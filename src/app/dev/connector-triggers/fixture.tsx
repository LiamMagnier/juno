"use client";
import * as React from "react";
import { TriggerListEditor } from "@/components/work/work-triggers";
import type { WorkTriggerDraft } from "@/components/work/work-transport";
import { normalizeTriggerDrafts } from "@/lib/work/triggers";
import { Button } from "@/components/ui/button";

/** Production editor with local state only; vendor acceptance belongs to the
 * opt-in connector suites, not this isolated QA gallery. */
export function ConnectorTriggerFixture() {
  const [triggers, setTriggers] = React.useState<WorkTriggerDraft[]>([{ kind: "connector_event", enabled: true, config: { connector: "slack", events: [], attributes: { resourceId: "keep-filter" } } }]);
  const [saved, setSaved] = React.useState("");
  return (
    <main className="mx-auto max-w-xl space-y-4 p-4">
      <h1 className="text-heading font-semibold">Connector trigger</h1>
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); const normalized = normalizeTriggerDrafts(triggers, "Europe/Paris"); setSaved(JSON.stringify(normalized.ok ? normalized.drafts : normalized)); }}>
        <TriggerListEditor triggers={triggers} onChange={setTriggers} grants={[]} runKind="work" disabled={false} />
        <Button type="submit">Save trigger</Button>
      </form>
      <output aria-label="Saved trigger" className="block break-all text-caption">{saved}</output>
    </main>
  );
}
