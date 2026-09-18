"use client";

import * as React from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { AppIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Card, CardEyebrow } from "@/components/ui/card";
import { Pressable } from "@/components/ui/pressable";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { ConnectorStatus } from "@/components/connections/types";
import { MODEL_LIST } from "@/lib/models";
import {
  DEFAULT_WORK_PERMISSION_POLICY,
  WORK_APPROVAL_MODE_LABEL,
  WORK_APPROVAL_MODE_SUMMARY,
  type WorkPermissionPolicy,
} from "@/lib/work/domain";
import { isWorkCapableModel } from "@/lib/work/models";
import type { WorkProjectDefaults } from "@/lib/work/projects";

/**
 * The value the picker uses for "this project has no opinion".
 *
 * A sentinel rather than an empty string, because Radix's Select reserves the
 * empty value for "nothing chosen" and would render the placeholder instead of
 * this row — which reads as a control that forgot its own state.
 */
const INHERIT = "__inherit__";

/**
 * The approval modes a PROJECT may state.
 *
 * "Just do it" is deliberately absent, and its absence is the control telling
 * the truth. A project narrows from `DEFAULT_WORK_PERMISSION_POLICY` and cannot
 * widen past it, so a project set to the widest mode resolves back to the
 * default on every task and the row would be a setting that does nothing. The
 * place to ask for that mode is the task itself, where the composer discloses
 * it in the same press.
 */
const PROJECT_APPROVAL_MODES: WorkPermissionPolicy[] = ["conservative", "balanced"];

/**
 * What a task filed in this project starts with.
 *
 * This is the writer that makes a project a *role*. `Project.workDefaults` is
 * read at session creation — approval mode, model, connected apps, preferred
 * Mac — and before this control existed nothing in the product could write the
 * column, so the inheritance was code nobody could reach: every real account
 * had `{}` there and every field resolved to the account's own answer.
 *
 * Every row here is a DEFAULT and not a grant, which is what decides the
 * wording under each. The server resolves all of it against the acting
 * account's own ceilings — the model through the plan gate, the Mac against a
 * row carrying that user, the apps intersected with what that user has linked,
 * the approval mode narrowed from the product default — so nothing set here can
 * hand a task an authority the account did not already have.
 */
export function ProjectWorkDefaults({
  value,
  onChange,
  onSave,
  saving,
  dirty,
}: {
  value: WorkProjectDefaults;
  onChange: (next: WorkProjectDefaults) => void;
  onSave: () => void;
  saving: boolean;
  dirty: boolean;
}) {
  const [connectors, setConnectors] = React.useState<ConnectorStatus[] | null>(null);
  const [connectorsFailed, setConnectorsFailed] = React.useState(false);

  const loadConnectors = React.useCallback(async () => {
    setConnectorsFailed(false);
    try {
      // The chat surface's own endpoint, not a second one written for projects:
      // a parallel connector list is a parallel answer to "is Gmail linked",
      // and the two disagree the first time somebody unlinks it elsewhere.
      const response = await fetch("/api/connectors");
      if (!response.ok) throw new Error("connectors");
      const data = (await response.json()) as { connectors?: ConnectorStatus[] };
      setConnectors((data.connectors ?? []).filter((connector) => connector.connected));
    } catch {
      setConnectorsFailed(true);
    }
  }, []);

  React.useEffect(() => {
    void loadConnectors();
  }, [loadConnectors]);

  const restricted = value.connectorIds !== undefined;
  const chosen = value.connectorIds ?? [];

  const toggleConnector = (connectorId: string) => {
    const held = chosen.includes(connectorId);
    onChange({
      ...value,
      // An empty result stays an empty ARRAY rather than becoming absent. The
      // reader who switched the last app off said "tasks here reach nothing",
      // and turning that back into "no opinion" would hand them every app the
      // account has linked — the one direction of this control that must never
      // happen silently.
      connectorIds: held ? chosen.filter((id) => id !== connectorId) : [...chosen, connectorId],
    });
  };

  return (
    <Card className="p-5">
      <CardEyebrow>Task defaults</CardEyebrow>
      <p className="mt-1 text-body text-muted-foreground">
        What a task filed in this project starts with. Each of these is a starting point, not a
        permission — a task can still be told something different, and nothing here gives Juno
        anything your account has not already allowed.
      </p>

      <div className="mt-5 space-y-5">
        <label className="block space-y-2">
          <span className="text-body font-medium text-foreground">How often it asks</span>
          <Select
            value={value.permissionPolicy ?? INHERIT}
            onValueChange={(next) =>
              onChange({
                ...value,
                permissionPolicy:
                  next === INHERIT ? undefined : (next as WorkPermissionPolicy),
              })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={INHERIT}>
                {WORK_APPROVAL_MODE_LABEL[DEFAULT_WORK_PERMISSION_POLICY]} (default)
              </SelectItem>
              {PROJECT_APPROVAL_MODES.map((policy) => (
                <SelectItem key={policy} value={policy}>
                  {WORK_APPROVAL_MODE_LABEL[policy]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="block text-caption leading-relaxed text-muted-foreground">
            {value.permissionPolicy === undefined
              ? WORK_APPROVAL_MODE_SUMMARY[DEFAULT_WORK_PERMISSION_POLICY]
              : WORK_APPROVAL_MODE_SUMMARY[value.permissionPolicy]}{" "}
            A project can only ask Juno to be more careful than the default, never less — a task
            that wants to be left alone has to say so itself.
          </span>
        </label>

        <label className="block space-y-2">
          <span className="text-body font-medium text-foreground">Model</span>
          <Select
            value={value.model ?? INHERIT}
            onValueChange={(next) =>
              onChange({ ...value, model: next === INHERIT ? undefined : next })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={INHERIT}>Whatever the task picks</SelectItem>
              {MODEL_LIST.filter(isWorkCapableModel).map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {model.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="block text-caption leading-relaxed text-muted-foreground">
            Only the models the task runner can drive. One your plan does not include is dropped
            when the task is created rather than refusing it, so the task still runs.
          </span>
        </label>

        <div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-body font-medium text-foreground">
              Only these connected apps
            </span>
            {/* Disabled until the list lands, because the "on" branch below
                starts from it: flipping this switch while the request is still
                in flight would seed the project with an EMPTY list, and an
                empty list is the instruction "tasks here reach nothing". */}
            <Switch
              checked={restricted}
              disabled={saving || connectors === null}
              onCheckedChange={(next) =>
                onChange({
                  ...value,
                  // On starts from every linked app rather than from nothing:
                  // switching this on is the reader saying "let me choose",
                  // and starting them at "reaches nothing" would be the
                  // control making the choice for them.
                  connectorIds: next
                    ? (connectors ?? []).map((connector) => connector.id)
                    : undefined,
                })
              }
              aria-label="Restrict which connected apps tasks in this project may reach"
            />
          </div>
          {connectorsFailed ? (
            <div className="mt-3 space-y-2">
              <p className="text-caption leading-relaxed text-muted-foreground">
                Couldn’t read your connected apps, so there is nothing to choose from here.
              </p>
              <Button variant="outline" size="sm" onClick={() => void loadConnectors()}>
                Retry
              </Button>
            </div>
          ) : restricted && (connectors?.length ?? 0) > 0 ? (
            <ul className="mt-3 space-y-0.5">
              {(connectors ?? []).map((connector) => {
                const active = chosen.includes(connector.id);
                return (
                  <li key={connector.id}>
                    <Pressable
                      kind="row"
                      size="sm"
                      role="switch"
                      aria-checked={active}
                      disabled={saving}
                      onClick={() => toggleConnector(connector.id)}
                    >
                      <AppIcons.connections
                        className={cn(
                          "size-3.5 shrink-0",
                          active ? "text-primary" : "text-muted-foreground"
                        )}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate text-ui">{connector.label}</span>
                      <Switch
                        checked={active}
                        tabIndex={-1}
                        aria-hidden
                        className="pointer-events-none"
                      />
                    </Pressable>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {restricted && chosen.length === 0 ? (
            <p className="mt-3 text-caption leading-relaxed text-muted-foreground">
              Tasks filed here reach no connected app at all. Switch one on, or switch this off
              to leave the choice to the task.
            </p>
          ) : (
            <p className="mt-3 text-caption leading-relaxed text-muted-foreground">
              {restricted
                ? "A task filed here can pick among these and cannot add to them. Your connections are unchanged — "
                : "Tasks filed here choose their own apps, from everything you have connected — "}
              <Link
                href="/connections"
                className="underline underline-offset-2 hover:text-foreground"
              >
                manage them
              </Link>
              .
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={onSave} disabled={saving || !dirty} size="sm" className="gap-2">
            {saving && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
            Save task defaults
          </Button>
          <p className="text-caption leading-relaxed text-muted-foreground">
            Tasks already created keep what they were created with.
          </p>
        </div>
      </div>
    </Card>
  );
}
