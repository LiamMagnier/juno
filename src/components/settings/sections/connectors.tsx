"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { AppIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Switch } from "@/components/ui/switch";
import { ConnectorMark } from "@/components/connections/connector-logos";
import type { ConnectorStatus } from "@/components/connections/types";
import { ChoiceMenu, type ChoiceOption } from "@/components/settings/choice-menu";
import { createSaveLedger } from "@/components/settings/save-ledger";
import { useSaveStates, type SaveState } from "@/components/settings/save-status";
import { useSettingsResource } from "@/components/settings/use-settings-resource";
import { queueSettingsPatch } from "@/components/settings/use-settings-save";
import { SettingRow, SettingRowSkeleton, SettingsGroup, SettingsInlineError } from "@/components/settings/setting-row";
// Type-only on purpose. `@/lib/action-approval` pulls in node:crypto for the
// receipt and policy digests, so importing a VALUE from it would drag that into
// the browser bundle. POLICY_OPTIONS below is keyed by the union, so adding a
// policy and forgetting it here is a type error, not a silently missing option.
import type { ActionPermissionPolicy } from "@/lib/action-approval";

export interface ConnectorPolicy {
  actionApprovalPolicy: ActionPermissionPolicy;
  lockdownMode: boolean;
  blockedConnectors: string[];
}

/**
 * One line per policy, describing what the SERVER actually does: read off
 * `decideActionPolicy` in @/lib/action-approval, not off the option names. A
 * permission screen that overstates what it allows is worse than none, so
 * each line names the cases that still stop and ask.
 */
const POLICY_COPY: Record<ActionPermissionPolicy, { label: string; description: string }> = {
  always_ask: {
    label: "Ask every time",
    description: "Juno asks before every action in a connected app, including ones that only read.",
  },
  ask_for_any_change: {
    label: "Ask before any change",
    description: "Reading runs on its own. Anything that writes, sends or deletes waits for you.",
  },
  ask_for_important_actions: {
    label: "Ask for important actions",
    description:
      "Reading and reversible changes (labels, archiving, renaming) run on their own. Anything that leaves your account, deletes, or can’t be classified waits for you.",
  },
  allow_selected_low_risk: {
    label: "Allow what I’ve approved",
    description: "Reading runs on its own, and so do the reversible actions you chose to always allow.",
  },
  block: {
    label: "Block everything",
    description: "Every action in a connected app is refused, and nothing can be approved.",
  },
};

const POLICY_OPTIONS: ChoiceOption<ActionPermissionPolicy>[] = (
  Object.keys(POLICY_COPY) as ActionPermissionPolicy[]
).map((value) => ({ value, ...POLICY_COPY[value] }));

function parsePolicy(body: unknown): ConnectorPolicy {
  const stored = (body as { settings?: Partial<ConnectorPolicy> } | null)?.settings;
  // Refuse to draw defaults over a response without the policy: showing an
  // account as more locked down than it is would be a lie in the safe-looking
  // direction, which is the kind nobody goes back to check.
  if (!stored?.actionApprovalPolicy) throw new Error("missing policy");
  return {
    actionApprovalPolicy: stored.actionApprovalPolicy,
    lockdownMode: stored.lockdownMode === true,
    blockedConnectors: stored.blockedConnectors ?? [],
  };
}

function parseConnectors(body: unknown): ConnectorStatus[] {
  return (body as { connectors?: ConnectorStatus[] } | null)?.connectors ?? [];
}

/*
 * The policy's write ledger, for the life of the page. One key, because every
 * write sends the whole policy. Module-level because the section remounts on
 * every switch, and a write can settle after the mount that made it is gone.
 */
const policyLedger = createSaveLedger<"policy">();
/** The outcome of the newest policy write, which an overtaken one reports as its own. */
let newestPolicyWrite: Promise<boolean> = Promise.resolve(true);

/**
 * The apps Juno can reach, and what it may do in them.
 *
 * This fetches `/api/settings` (the policy fields are not in the client
 * bootstrap) and `/api/connectors` once each. The list and the policy used to
 * fetch the connectors twice, and draw every app twice: once as "Connected"
 * and once more as a Block switch further down. Now each connected app is one
 * row whose switch is whether Juno may use it.
 */
export function ConnectorsSection() {
  const connectors = useSettingsResource("/api/connectors", parseConnectors);
  const policy = useSettingsResource("/api/settings", parsePolicy);
  const saves = useSaveStates();

  // Several quick changes put several PATCHes in the queue. Only the newest
  // may roll the controls back, and it rolls them back to what the server
  // last accepted (see save-ledger.ts), not to what they showed before it:
  // with two changes in flight that was the first change, so when both
  // failed an app stayed drawn as blocked that the server never blocked.
  // Every write carries the whole policy, so a failure a newer write has
  // overtaken lost nothing: the newer one stores this change too. It says
  // nothing of its own and reports the newer write's outcome as its row's.
  const write = (key: string, next: ConnectorPolicy) => {
    const shown = policy.data;
    if (!shown) return;
    const ticket = policyLedger.begin(["policy"], () => shown);
    policy.setData(next);
    const outcome = (async (): Promise<boolean> => {
      const res = await queueSettingsPatch({ ...next }).catch(() => null);
      if (res?.ok) {
        policyLedger.settle(ticket, ["policy"], { ok: true, written: { policy: next } });
        return true;
      }
      const rollback = policyLedger.settle(ticket, ["policy"], { ok: false });
      if (!rollback) return newestPolicyWrite;
      policy.setData(rollback.policy as ConnectorPolicy);
      toast.error("Couldn’t save. Your permissions are unchanged.");
      return false;
    })();
    newestPolicyWrite = outcome;
    void saves.track(key, () => outcome);
  };

  return (
    <ConnectorsView
      connectors={connectors.data}
      connectorsFailed={connectors.error && connectors.data === null}
      onRetryConnectors={() => void connectors.reload()}
      policy={policy.data}
      policyFailed={policy.error && policy.data === null}
      onRetryPolicy={() => void policy.reload()}
      status={saves.status}
      onPolicy={(actionApprovalPolicy) => {
        if (policy.data && policy.data.actionApprovalPolicy !== actionApprovalPolicy) {
          write("policy", { ...policy.data, actionApprovalPolicy });
        }
      }}
      onLockdown={(lockdownMode) => policy.data && write("lockdown", { ...policy.data, lockdownMode })}
      onAllowApp={(id, allowed) => {
        if (!policy.data) return;
        const blockedConnectors = allowed
          ? policy.data.blockedConnectors.filter((b) => b !== id)
          : [...new Set([...policy.data.blockedConnectors, id])];
        write(`app:${id}`, { ...policy.data, blockedConnectors });
      }}
    />
  );
}

/** The Connectors section, drawn from data: the dev gallery renders this with fixtures. */
export function ConnectorsView({
  connectors,
  connectorsFailed,
  onRetryConnectors,
  policy,
  policyFailed,
  onRetryPolicy,
  status,
  onPolicy,
  onLockdown,
  onAllowApp,
}: {
  connectors: ConnectorStatus[] | null;
  connectorsFailed: boolean;
  onRetryConnectors: () => void;
  policy: ConnectorPolicy | null;
  policyFailed: boolean;
  onRetryPolicy: () => void;
  status: (key: string) => SaveState;
  onPolicy: (policy: ActionPermissionPolicy) => void;
  onLockdown: (on: boolean) => void;
  onAllowApp: (id: string, allowed: boolean) => void;
}) {
  /*
   * Connected apps, plus any id that is blocked but no longer connected. A
   * block outlives the connection it was made against: the id stays in the
   * settings row and refuses calls again the moment the app is relinked, so
   * listing only connected apps would leave that block invisible and
   * impossible to lift from here.
   */
  const rows = React.useMemo(() => {
    const list = (connectors ?? [])
      .filter((c) => c.connected)
      .map((c) => ({ id: c.id, label: c.label, account: c.accountLabel, connected: true }));
    const listed = new Set(list.map((r) => r.id));
    for (const id of policy?.blockedConnectors ?? []) {
      if (listed.has(id)) continue;
      // The directory still knows its name when it is merely disconnected.
      const known = connectors?.find((c) => c.id === id);
      list.push({ id, label: known?.label ?? id, account: null, connected: false });
    }
    return list;
  }, [connectors, policy?.blockedConnectors]);

  const lockdown = policy?.lockdownMode === true;
  const currentPolicy = policy ? POLICY_COPY[policy.actionApprovalPolicy] : null;

  return (
    <>
      <SettingsGroup
        title="Connected apps"
        description="Turn one off to block everything Juno would do in it, reading included."
        aside={
          <Button asChild variant="outline" size="sm">
            <Link href="/connections">Browse apps</Link>
          </Button>
        }
      >
        {connectorsFailed ? (
          <SettingsInlineError onRetry={onRetryConnectors}>
            Couldn’t load your apps. Nothing has been disconnected.
          </SettingsInlineError>
        ) : connectors === null ? (
          <>
            <SettingRowSkeleton />
            <SettingRowSkeleton />
          </>
        ) : rows.length === 0 ? (
          <div className="py-4">
            <EmptyState
              size="panel"
              icon={AppIcons.connections}
              title="No apps connected"
              description="Connect GitHub, your calendar, mail or notes and Juno can work inside them."
              action={
                <Button asChild size="sm">
                  <Link href="/connections">Browse apps</Link>
                </Button>
              }
            />
          </div>
        ) : (
          rows.map((row) => {
            const blocked = policy?.blockedConnectors.includes(row.id) ?? false;
            return (
              <SettingRow
                key={row.id}
                htmlFor={`connector-${row.id}`}
                label={
                  <span className="flex min-w-0 items-center gap-2.5">
                    <ConnectorMark id={row.id} className="size-4 shrink-0 text-foreground" />
                    <span className="truncate">{row.label}</span>
                  </span>
                }
                description={
                  !row.connected
                    ? "Not connected. Still blocked if you connect it again."
                    : blocked
                      ? "Blocked. Juno can’t use this app."
                      : (row.account ?? undefined)
                }
                status={status(`app:${row.id}`)}
                // No switch until the policy is read: a disabled switch drawn
                // "on" while it loads, or after it failed to, claimed every
                // app was allowed, including the ones this account blocked.
                control={
                  policy ? (
                    <Switch
                      id={`connector-${row.id}`}
                      checked={!blocked}
                      onCheckedChange={(allowed) => onAllowApp(row.id, allowed)}
                    />
                  ) : undefined
                }
              />
            );
          })
        )}
      </SettingsGroup>

      <SettingsGroup
        title="Permissions"
        description="Juno checks these before every action in a connected app, so a change applies to chats already open."
      >
        {policyFailed ? (
          <SettingsInlineError onRetry={onRetryPolicy}>
            Couldn’t load your permissions. They still apply as they were.
          </SettingsInlineError>
        ) : !policy || !currentPolicy ? (
          <>
            <SettingRowSkeleton />
            <SettingRowSkeleton />
          </>
        ) : (
          <>
            <SettingRow
              label="When Juno acts in an app"
              description={
                lockdown
                  ? "Lockdown is on, so every action is refused. This applies again when you turn it off."
                  : currentPolicy.description
              }
              wide
              status={status("policy")}
              control={
                <ChoiceMenu
                  label="When Juno acts in an app"
                  value={policy.actionApprovalPolicy}
                  options={POLICY_OPTIONS}
                  onChange={onPolicy}
                  className="@[34rem]/pane:w-60"
                />
              }
            />
            <SettingRow
              label="Lockdown"
              htmlFor="connector-lockdown"
              description="Refuse every action, reading included, whatever the choice above and every approval already given."
              status={status("lockdown")}
              control={<Switch id="connector-lockdown" checked={lockdown} onCheckedChange={onLockdown} />}
            />
          </>
        )}
      </SettingsGroup>
    </>
  );
}
