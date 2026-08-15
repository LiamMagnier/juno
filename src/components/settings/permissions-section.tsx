"use client";

import * as React from "react";
import Link from "next/link";
import { StatusIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Label } from "@/components/ui/label";
import { Pressable } from "@/components/ui/pressable";
import { Switch } from "@/components/ui/switch";
import { Tile, TileSaveStatus, type TileSaveState } from "@/components/settings/tile";
import { useRadioGroup } from "@/components/settings/use-radio-group";
import type { ConnectorStatus } from "@/components/connections/types";
// Type-only on purpose. `@/lib/action-approval` pulls in node:crypto for the
// receipt and policy digests, so importing a VALUE from it would drag that into
// the browser bundle. The union is still the single source of truth: POLICY_COPY
// below is a Record keyed by it, so adding a policy to the union and forgetting
// it here is a type error rather than a silently missing option.
import type { ActionPermissionPolicy } from "@/lib/action-approval";
import { staggerDelay } from "@/lib/motion";

interface PermissionState {
  actionApprovalPolicy: ActionPermissionPolicy;
  lockdownMode: boolean;
  blockedConnectors: string[];
}

/**
 * One line per policy, describing what the SERVER actually does — these are read
 * straight off `decideActionPolicy` in @/lib/action-approval, not off the option
 * names. A permission screen that overstates what it allows is worse than no
 * screen at all, so each line names the cases that still stop and ask.
 */
const POLICY_COPY: Record<ActionPermissionPolicy, { label: string; description: string }> = {
  always_ask: {
    label: "Ask every time",
    description: "Juno asks before every connector action, including ones that only read.",
  },
  ask_for_any_change: {
    label: "Ask before any change",
    description:
      "Reading runs on its own. Anything that writes, sends, or deletes waits for your answer.",
  },
  ask_for_important_actions: {
    label: "Ask for important actions",
    description:
      "Reading and reversible changes such as labelling, archiving, or renaming run on their own. Anything that leaves your account, deletes, or that Juno cannot classify still waits for you.",
  },
  allow_selected_low_risk: {
    label: "Allow what I have approved",
    description:
      "Reading runs on its own, and so do the reversible actions you chose to always allow. Everything else waits for your answer.",
  },
  block: {
    label: "Block everything",
    description: "Every connector action is refused, and nothing can be approved to run.",
  },
};

// Insertion order of the record above is the display order, so the list can
// never drift out of sync with the copy it renders.
const POLICY_ORDER = Object.keys(POLICY_COPY) as ActionPermissionPolicy[];

/**
 * Connector permissions for the settings page.
 *
 * Everything here is enforced server-side by the approval broker
 * (`resolveActionPolicy` -> `decideActionPolicy`) on every connector call. This
 * card is therefore a view of stored policy, never the thing that enforces it:
 * it refuses to render controls until it has read the real values, because
 * drawing schema defaults over a failed fetch would tell the user their account
 * is more locked down than it is.
 */
export function PermissionsSection({ index = 0 }: { index?: number }) {
  const [state, setState] = React.useState<PermissionState | null>(null);
  const [connectors, setConnectors] = React.useState<ConnectorStatus[]>([]);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [save, setSave] = React.useState<TileSaveState>("idle");

  // Toggling three switches quickly puts three PATCHes on the wire. Only the
  // newest one may write the status line or roll the UI back — otherwise a slow
  // early failure would revert a later change the server already accepted.
  const saveSeqRef = React.useRef(0);
  const savedTimerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const load = React.useCallback(async () => {
    setLoadFailed(false);
    setState(null);
    try {
      const [settingsRes, connectorsRes] = await Promise.all([
        fetch("/api/settings"),
        fetch("/api/connectors"),
      ]);
      if (!settingsRes.ok) throw new Error(String(settingsRes.status));
      const settingsBody = (await settingsRes.json()) as {
        settings?: Partial<PermissionState>;
      };
      const stored = settingsBody.settings;
      if (!stored?.actionApprovalPolicy) throw new Error("missing policy");
      setState({
        actionApprovalPolicy: stored.actionApprovalPolicy,
        lockdownMode: stored.lockdownMode === true,
        blockedConnectors: stored.blockedConnectors ?? [],
      });
      // A connector list that fails to load costs the per-app switches, not the
      // policy controls — those are the ones that matter most and they need
      // nothing from this request.
      if (connectorsRes.ok) {
        const body = (await connectorsRes.json()) as { connectors?: ConnectorStatus[] };
        setConnectors(body.connectors ?? []);
      }
    } catch {
      setLoadFailed(true);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => () => clearTimeout(savedTimerRef.current), []);

  const patch = React.useCallback(
    async (next: PermissionState) => {
      const previous = state;
      const seq = ++saveSeqRef.current;
      clearTimeout(savedTimerRef.current);
      setState(next);
      setSave("saving");
      try {
        const res = await fetch("/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(next),
        });
        if (seq !== saveSeqRef.current) return; // a later change owns the UI
        if (!res.ok) throw new Error(String(res.status));
        setSave("saved");
        // The confirmation is transient, the state it describes is not. Clearing
        // it keeps a stale "Saved" from sitting next to controls the user has
        // since changed by hand elsewhere.
        savedTimerRef.current = setTimeout(() => setSave("idle"), 4000);
      } catch {
        if (seq !== saveSeqRef.current) return;
        // Put the controls back where the server still has them. Claiming a
        // permission changed when the write failed is the one lie this card
        // cannot afford.
        if (previous) setState(previous);
        setSave("failed");
      }
    },
    [state]
  );

  const selectPolicy = (policy: ActionPermissionPolicy) => {
    if (!state || state.actionApprovalPolicy === policy) return;
    void patch({ ...state, actionApprovalPolicy: policy });
  };

  // The roving-tabindex + arrow-key behaviour this group has always had, now
  // from the shared helper so the four radiogroups on settings/page.tsx that
  // were missing it get the same one rather than a second implementation.
  const policyOption = useRadioGroup(
    POLICY_ORDER,
    POLICY_ORDER.indexOf(state?.actionApprovalPolicy as ActionPermissionPolicy),
    selectPolicy
  );

  const setLockdown = (lockdownMode: boolean) => {
    if (!state) return;
    void patch({ ...state, lockdownMode });
  };

  const setConnectorBlocked = (connectorId: string, blocked: boolean) => {
    if (!state) return;
    const blockedConnectors = blocked
      ? [...new Set([...state.blockedConnectors, connectorId])]
      : state.blockedConnectors.filter((id) => id !== connectorId);
    void patch({ ...state, blockedConnectors });
  };

  /*
   * Connected apps, plus any id that is blocked but no longer connected.
   *
   * A block outlives the connection it was made against — the id stays in the
   * settings row and starts refusing calls again the moment the app is
   * relinked. Listing only connected apps would leave that block invisible and
   * impossible to lift from here.
   */
  const connectorRows = React.useMemo(() => {
    const rows = connectors
      .filter((c) => c.connected)
      .map((c) => ({ id: c.id, label: c.label, connected: true }));
    const listed = new Set(rows.map((r) => r.id));
    for (const id of state?.blockedConnectors ?? []) {
      if (!listed.has(id)) rows.push({ id, label: id, connected: false });
    }
    return rows;
  }, [connectors, state?.blockedConnectors]);

  return (
    <Tile
      eyebrow="Connector permissions"
      i={index}
      // One status line for the whole card, present in every state — see
      // TileSaveStatus for why it never unmounts.
      aside={<TileSaveStatus state={save} failedMessage="Couldn't save. Your permissions are unchanged." />}
    >
      <p className="mb-4 text-sm text-muted-foreground">
        What Juno may do with your connected apps on its own, and what it has to stop and ask you
        about first. Juno checks this before every connector call, so a change here applies to chats
        already open.
      </p>

      {loadFailed ? (
        // A failed read of the permission policy is a failure, not a well of
        // information. It was a neutral border-border/70 box, indistinguishable
        // from the ordinary field wells around it.
        <EmptyState
          tone="error"
          size="panel"
          icon={StatusIcons.error}
          title="Couldn't load your permissions"
          description="Nothing is shown rather than a guess."
          action={
            <Button variant="outline" size="sm" onClick={() => void load()}>
              Try again
            </Button>
          }
        />
      ) : !state ? (
        // gap-2 and rounded-card, because a skeleton's whole job is to be the
        // shape that arrives: these stood in for five `Pressable kind="tile"`
        // cards at rounded-card (14) and were drawn at rounded-field (10), so
        // the corners visibly stepped out when the real policy list landed.
        <div className="grid grid-cols-1 gap-2" aria-hidden>
          {[...Array(5)].map((_, i) => (
            <div key={i} className="skeleton h-16 rounded-card" style={staggerDelay(i, "loose")} />
          ))}
        </div>
      ) : (
        <>
          {state.lockdownMode && (
            // p-4, matching the spend-ceiling warning well on this same page:
            // the two warning states in settings share one chrome.
            <p className="mb-4 flex items-start gap-2 rounded-field border border-warning/40 bg-warning/10 p-4 text-sm text-foreground">
              <StatusIcons.security className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
              Lockdown is on, so every connector action is refused right now. The choice below takes
              effect again when you turn it off.
            </p>
          )}

          {/* text-muted-foreground to match every other field label on this
              surface — this was the third of three label treatments in one grid. */}
          <Label id="action-policy-label" className="mb-2 block text-xs text-muted-foreground">
            When Juno wants to use a connected app
          </Label>
          <div
            role="radiogroup"
            aria-labelledby="action-policy-label"
            className="grid grid-cols-1 gap-2"
          >
            {POLICY_ORDER.map((policy, position) => {
              const option = POLICY_COPY[policy];
              const selected = state.actionApprovalPolicy === policy;
              return (
                <Pressable
                  key={policy}
                  kind="tile"
                  selected={selected}
                  role="radio"
                  aria-checked={selected}
                  onClick={() => selectPolicy(policy)}
                  // No shadows. `--shadow-float` is the OUT-OF-FLOW token —
                  // card.tsx explicitly forbids an in-flow tile reaching for it,
                  // because a hovered tile then outranks every dropdown in the
                  // product — and on a black ground both shadows are black ink,
                  // so the whole hover state degraded to a 2px translate. The
                  // Pressable `tile` kind already carries border + fill hover.
                  //
                  // And no `hover:bg-card` either, which is what the line above
                  // used to say while doing the opposite: utilities are emitted
                  // after the components layer, so it beat the kind's
                  // `hover:bg-accent` and repainted the hover in the tile's OWN
                  // rest fill. Five policy cards whose only hover was a 2px lift.
                  className="min-h-11 motion-safe:hover:-translate-y-0.5"
                  {...policyOption(position)}
                >
                  <span className="flex w-full items-center justify-between gap-2 text-sm font-medium">
                    {option.label}
                    {selected && <StatusIcons.success className="size-3.5 shrink-0 text-primary" aria-hidden />}
                  </span>
                  <span className="text-xs leading-relaxed text-muted-foreground">
                    {option.description}
                  </span>
                </Pressable>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Juno only ever offers to remember an approval for reversible actions. Anything
            destructive or sensitive is asked again every single time.
          </p>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium" id="lockdown-label">
                Lockdown
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground" id="lockdown-description">
                Refuse every connector action, including ones that only read. This overrides the
                choice above and every approval you have already given, until you turn it off.
              </p>
            </div>
            <Switch
              checked={state.lockdownMode}
              onCheckedChange={setLockdown}
              aria-labelledby="lockdown-label"
              aria-describedby="lockdown-description"
            />
          </div>

          <div className="mt-5 border-t border-border/60 pt-4">
            <p className="text-sm font-medium">Blocked apps</p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              A blocked app is refused everything, reads included — lockdown for one app instead of
              all of them.
            </p>

            {connectorRows.length === 0 ? (
              <p className="mt-3 text-xs text-muted-foreground">
                No apps are connected yet.{" "}
                <Link href="/connections" className="underline underline-offset-2 hover:text-foreground">
                  Connect one
                </Link>{" "}
                and it will appear here.
              </p>
            ) : (
              <ul className="mt-3 space-y-1">
                {connectorRows.map((row) => {
                  const blocked = state.blockedConnectors.includes(row.id);
                  return (
                    <li
                      key={row.id}
                      className="flex min-h-11 flex-wrap items-center justify-between gap-3 py-1"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{row.label}</span>
                        {!row.connected && (
                          <span className="block text-xs text-muted-foreground">
                            Not connected right now. The block still applies if you reconnect it.
                          </span>
                        )}
                      </span>
                      {/* The app name alone would not say what the switch does,
                          and "Blocked" alone would not say which app. */}
                      <Switch
                        checked={blocked}
                        onCheckedChange={(value) => setConnectorBlocked(row.id, value)}
                        aria-label={`Block ${row.label}`}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </Tile>
  );
}
