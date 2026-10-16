"use client";
import * as React from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { withConnectorEventStream } from "@/lib/first-party-connectors/trigger-stream";

/** The Work editor can embed this without owning connector-specific rules. */
export function ConnectorEventStreamField({ connector, attributes, disabled, onChange }: {
  connector: string;
  attributes: unknown;
  disabled?: boolean;
  onChange: (attributes: Record<string, string>) => void;
}) {
  const id = React.useId();
  const app = connector.trim().toLowerCase();
  if (app !== "slack" && app !== "google-calendar") return null;
  const value = withConnectorEventStream(attributes, (attributes && typeof attributes === "object" && "stream" in attributes && typeof attributes.stream === "string") ? attributes.stream : "").stream ?? "";
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{app === "slack" ? "Slack channel ID" : "Calendar ID (optional)"}</Label>
      <Input id={id} value={value} required={app === "slack"} maxLength={256} autoComplete="off" spellCheck={false} disabled={disabled} aria-describedby={`${id}-hint`} placeholder={app === "slack" ? "C123456" : "primary"} onChange={(e) => onChange(withConnectorEventStream(attributes, e.target.value))} />
      <p id={`${id}-hint`} className="text-caption text-muted-foreground">
        {app === "slack" ? "Required. Watch new messages in this channel." : "Leave blank to watch your primary calendar."}
      </p>
    </div>
  );
}
