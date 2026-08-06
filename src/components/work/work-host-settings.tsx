"use client";

import * as React from "react";
import { FileText, Folder, Link2, Plug } from "lucide-react";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import type { ClientWorkGrant, ClientWorkHost } from "@/lib/work/serializers";
import {
  WORK_PERMISSION_POLICIES,
  type WorkAccessMode,
  type WorkCapability,
  type WorkGrantKind,
  type WorkPermissionPolicy,
} from "@/lib/work/domain";
import {
  hostAdvertisedPolicy,
  hostAdvertisedToggles,
  hostCapabilities,
  hostNameList,
  type PatchWorkHostInput,
  type WorkHostToggleKey,
} from "@/components/work/work-transport";
import { CapabilityChip, WorkStateNote, workTimeAgo } from "@/components/work/work-vocabulary";
import { cn } from "@/lib/utils";

/*
 * What one Mac may do, as controls.
 *
 * Every control on this panel obeys the same asymmetry, which is the escalation
 * boundary of the whole relay and is enforced by the route rather than by this
 * file: switching a capability *off* always works, from anywhere, immediately;
 * switching one *on* requires the Mac to have advertised it. The ceiling is the
 * host's own last advertisement — `WorkHost.capabilities`, read here by
 * `hostAdvertisedToggles` — because the alternative is a stolen browser session
 * granting shell access to a machine whose owner never offered it, and the owner
 * is the one person in the system standing in front of that machine.
 *
 * So a switch that is off and could not be turned on is drawn disabled with the
 * reason under it, rather than live-and-then-snapping-back. The route would
 * refuse it and name it in `refused`, and the caller shows that too — but a
 * control the user can press and watch fail is a bug report, and this one is not
 * a bug. A switch that is *on* is never disabled by the ceiling, whatever the
 * manifest says, because taking a permission away has to work from anywhere.
 * The same rule shapes the policy control in three values instead of two: a
 * segment stricter than the Mac's is always offered, a looser one is not.
 *
 * The three list columns — allowed apps, blocked apps, allowed domains — are
 * shown and not editable, and that is the route's shape rather than an omission
 * here: `hostPatchSchema` (src/lib/work/relay.ts) accepts the six toggles, the
 * approval policy and `revoked: false`, and nothing else. They are set on the
 * Mac. Drawing an editor over an endpoint that would drop the change is worse
 * than saying where the change has to be made.
 */

// ---------------------------------------------------------------------------
// The six switches
// ---------------------------------------------------------------------------

interface ToggleSpec {
  key: WorkHostToggleKey;
  label: string;
  /** What granting it actually lets a task do on this machine. */
  detail: string;
}

/**
 * The five capability switches, in the order they widen.
 *
 * Files first because it is the one nearly every local task needs, shell last
 * because it is the one that subsumes the others: a task with a shell on this
 * Mac does not need permission to open a file.
 */
const CAPABILITY_TOGGLES: readonly ToggleSpec[] = [
  {
    key: "allowsFileWork",
    label: "Files in the folders you have shared",
    detail:
      "Read and change files inside the folders listed below, and nowhere else on the disk. Each folder carries its own limit on writing and deleting.",
  },
  {
    key: "allowsBrowser",
    label: "Your signed-in browser",
    detail:
      "Use the browser profile on this Mac, with the sessions already signed in to it. Anything you are logged in to, a task can reach.",
  },
  {
    key: "allowsComputerUse",
    label: "Screen control",
    detail:
      "See the screen, click and type. This is also what lets Juno drive an app through its accessibility tree — the two ride one switch, because driving an app is screen control by another name.",
  },
  {
    key: "allowsShell",
    label: "Shell commands",
    detail:
      "Run commands in a terminal on this Mac. Intended for developer work, and the broadest thing on this list: a command can reach anything your account can.",
  },
  {
    key: "allowsBackground",
    label: "Keep working while you are away",
    detail:
      "Carry on with a task when you have walked away from this Mac and every other device is offline. Without it, unattended work waits for you.",
  },
];

/**
 * One switch as a patch body, built rather than spelled out at each call site.
 *
 * PATCH is a partial update and the difference is load-bearing: a body that
 * filled in the absent switches would switch Work off for the whole Mac every
 * time somebody changed the browser toggle. One key goes in, and that is all the
 * route is told about.
 */
function togglePatch(key: WorkHostToggleKey, next: boolean): PatchWorkHostInput {
  const patch: PatchWorkHostInput = {};
  patch[key] = next;
  return patch;
}

function ToggleRow({
  label,
  detail,
  checked,
  advertised,
  disabled,
  onChange,
}: {
  label: string;
  detail: string;
  checked: boolean;
  /** Whether the Mac has offered this in its last advertisement. */
  advertised: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  /*
   * The ceiling only ever locks the ON direction.
   *
   * Switching a capability off has to work from anywhere, immediately, and that
   * includes the two cases where the Mac is not currently advertising it: a host
   * whose manifest this build cannot read at all, and one that stopped offering
   * something it had already been granted. Disabling the switch on `!advertised`
   * alone takes the kill switch away in exactly the situation somebody would
   * reach for it — a Mac behaving oddly, with a manifest that no longer makes
   * sense. So the switch is only dead when it is already off and could not be
   * turned on, which is a control that would do nothing rather than a control
   * that was needed.
   */
  const unofferedAndOff = !advertised && !checked;
  const unofferedButOn = !advertised && checked;
  return (
    <label
      className={cn(
        "flex items-center justify-between gap-3 rounded-xl border border-border/50 px-3.5 py-2.5",
        unofferedAndOff && "opacity-70",
        unofferedButOn && "border-warning/35"
      )}
    >
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-foreground">{label}</span>
        <span
          className={cn(
            "mt-0.5 block text-[11.5px] leading-relaxed",
            unofferedButOn ? "text-warning-foreground" : "text-muted-foreground"
          )}
        >
          {advertised
            ? detail
            : unofferedButOn
              ? // A real state, and one worth flagging: the Mac has stopped
                // offering something it still holds. The heartbeat will clear it
                // on its next pass — `reconcileToggles` writes the intersection
                // — so until then this page is the honest place to say so, and
                // the switch stays live because taking it away first is the
                // point of a kill switch.
                "This Mac is no longer offering this, and it is still switched on. It will lapse on its own at the next check-in; you can switch it off here now."
              : // Not "unavailable". The reader can very often fix this, and the
                // fix is on the machine rather than on this page.
                "This Mac has not offered this. Switch it on in Juno on the Mac itself and it becomes available here."}
        </span>
      </span>
      <Switch
        checked={checked}
        disabled={disabled || unofferedAndOff}
        onCheckedChange={onChange}
        aria-label={label}
      />
    </label>
  );
}

// ---------------------------------------------------------------------------
// Approval policy
// ---------------------------------------------------------------------------

const POLICY_LABEL: Record<WorkPermissionPolicy, string> = {
  conservative: "Ask a lot",
  balanced: "Ask about commands",
  permissive: "Ask rarely",
};

/**
 * Policy strength, so a segment looser than the Mac's can be drawn unavailable.
 *
 * A local copy of `POLICY_RANK` in domain.ts, which is not exported —
 * `narrowestPolicy` is the export, and it answers "which of these wins" rather
 * than the question this control asks, which is "is this option even offered".
 * Deriving the second from the first would mean calling it once per segment to
 * see whether the answer came back unchanged.
 */
const POLICY_RANK: Record<WorkPermissionPolicy, number> = {
  conservative: 0,
  balanced: 1,
  permissive: 2,
};

/**
 * What each policy actually rules, taken from `WorkRisk.ruling`.
 *
 * The ladder is: `conservative` allows only a plain read; `balanced` also allows
 * an edit; `permissive` allows a command too. Nothing above that is on the
 * ladder at all — sensitive and irreversible actions ask under every policy, and
 * there is no setting anywhere that turns that off, which is why it is stated
 * once beneath the control rather than folded into the "Ask rarely" sentence
 * where it would read like a caveat on one option.
 */
const POLICY_DETAIL: Record<WorkPermissionPolicy, string> = {
  conservative: "Juno asks before changing a file or running a command. Reading goes ahead.",
  balanced: "Juno edits files without asking, and asks before running a command.",
  permissive: "Juno edits files and runs commands without asking.",
};

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

const ACCESS_LABEL: Record<WorkAccessMode, string> = {
  read: "Read only",
  // "No delete" here means no delete *and no Trash move*: a file moved to the
  // Trash is gone from where the user left it, which is not a permission
  // somebody would recognise as no-delete.
  read_write_no_delete: "Read and change, nothing removed",
  read_write: "Read, change and remove",
};

const GRANT_ICON: Record<WorkGrantKind, typeof Folder> = {
  local_folder: Folder,
  local_file: FileText,
  cloud_folder: Folder,
  cloud_file: FileText,
  connector_scope: Plug,
};

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

export function WorkHostSettings({
  host,
  grants,
  routableCapabilities,
  busy,
  onPatch,
}: {
  host: ClientWorkHost;
  /**
   * Null when the detail request failed after the host was already known —
   * rendered as "couldn't be read", never as "this Mac has been given nothing",
   * which is the sentence somebody deciding whether to revoke would act on.
   */
  grants: ClientWorkGrant[] | null;
  routableCapabilities: readonly WorkCapability[];
  busy: boolean;
  onPatch: (patch: PatchWorkHostInput) => void;
}) {
  const revoked = host.revokedAt !== null;
  const advertised = React.useMemo(() => hostAdvertisedToggles(host), [host]);
  const advertisedPolicy = hostAdvertisedPolicy(host);
  const granted = React.useMemo(() => hostCapabilities(host), [host]);

  const allowedApps = hostNameList(host.allowedApps);
  const blockedApps = hostNameList(host.blockedApps);
  const allowedDomains = hostNameList(host.allowedDomains);

  // Every control is inert on a revoked Mac, and the route agrees: it refuses
  // any PATCH against one except the single `revoked: false` that brings it
  // back. Offering live switches over an endpoint that will answer 403 would
  // make the restore look optional.
  const locked = busy || revoked;

  return (
    <div className="space-y-7">
      <section className="space-y-2.5">
        <h2 className="font-mono text-label text-muted-foreground">What this Mac may do</h2>

        <ToggleRow
          label="Juno Work on this Mac"
          detail="The master switch. With it off, this Mac claims nothing at all — the five below stop applying, and a task that needs a real machine looks for another one."
          checked={host.enabled}
          advertised={advertised.enabled}
          disabled={locked}
          onChange={(enabled) => onPatch({ enabled })}
        />

        {!host.enabled && !revoked && (
          <WorkStateNote tone="info">
            Work is switched off for this Mac, so nothing below is in force. The switches still
            record what it would be allowed to do when you switch it back on.
          </WorkStateNote>
        )}

        {CAPABILITY_TOGGLES.map((spec) => (
          <ToggleRow
            key={spec.key}
            label={spec.label}
            detail={spec.detail}
            checked={host[spec.key]}
            advertised={advertised[spec.key]}
            disabled={locked}
            onChange={(next) => onPatch(togglePatch(spec.key, next))}
          />
        ))}
      </section>

      <section>
        <h2 className="mb-2.5 font-mono text-label text-muted-foreground">
          When Juno stops to ask
        </h2>
        <div className="rounded-xl border border-border/50 px-3.5 py-3">
          <SegmentedControl
            value={host.approvalPolicy}
            onChange={(approvalPolicy) => onPatch({ approvalPolicy })}
            options={WORK_PERMISSION_POLICIES.map((policy) => ({
              value: policy,
              label: POLICY_LABEL[policy],
              // The same ceiling as the switches, in three values instead of
              // two: the owner may pick any policy at least as strict as the
              // Mac's, and a looser request lands on the Mac's rather than
              // taking effect. A segment that would be silently pulled back is
              // drawn as unavailable instead. A manifest with no readable policy
              // offers no ceiling — greying two segments out on the strength of
              // a missing field would take away a choice nobody withheld.
              disabled:
                locked ||
                (advertisedPolicy !== null &&
                  POLICY_RANK[policy] > POLICY_RANK[advertisedPolicy]),
            }))}
            ariaLabel="How often Juno asks before acting on this Mac"
            optionClassName="px-3 py-1 text-[12.5px]"
            className="max-w-md"
          />
          <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
            {POLICY_DETAIL[host.approvalPolicy]}
          </p>
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
            Anything Juno cannot take back — a permanent delete, a message sent, a purchase, a
            change to a security setting — is asked about under every one of these. There is no
            setting that turns that off.
          </p>
          {advertisedPolicy !== null && POLICY_RANK[advertisedPolicy] < 2 && (
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
              This Mac asked for “{POLICY_LABEL[advertisedPolicy]}”, so that is as relaxed as it
              goes from here. Loosen it in Juno on the Mac itself.
            </p>
          )}
        </div>
      </section>

      <section>
        <h2 className="mb-2.5 font-mono text-label text-muted-foreground">What it has offered</h2>
        {routableCapabilities.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">
            This Mac has not listed anything it can do. That is what an older build of the app looks
            like from here — it will fill in on its next check-in after an update.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5">
              {routableCapabilities.map((capability) => (
                <CapabilityChip
                  key={capability}
                  capability={capability}
                  // Struck through means the Mac offers it and it is switched
                  // off above — the one reading that tells somebody why a task
                  // was refused on a machine that is plainly awake.
                  available={granted.includes(capability)}
                />
              ))}
            </div>
            <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
              What this Mac told Juno it can do. A struck-through one is offered by the Mac and
              switched off above. This list is the Mac’s to report and cannot be edited from a
              browser.
            </p>
          </>
        )}
      </section>

      <section>
        <h2 className="mb-2.5 font-mono text-label text-muted-foreground">Folders it can reach</h2>
        {grants === null ? (
          <p className="rounded-xl border border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">
            The folders shared with this Mac couldn’t be read just now, which says nothing about
            whether it has any.
          </p>
        ) : grants.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">
            Nothing has been shared with this Mac, so file work on it has nowhere to happen. A
            folder is chosen in Juno on the Mac, where the file picker is.
          </p>
        ) : (
          <>
            <ul className="space-y-1.5">
              {grants.map((grant) => {
                const Icon = GRANT_ICON[grant.kind];
                return (
                  <li
                    key={grant.id}
                    className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-xl border border-border/60 bg-card/50 px-3.5 py-2.5"
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                      {grant.displayName}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                      {ACCESS_LABEL[grant.accessMode]}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
                      {grant.lastUsedAt === null ? "never used" : `used ${workTimeAgo(grant.lastUsedAt)}`}
                    </span>
                  </li>
                );
              })}
            </ul>
            {/* Why there is a name here and no path. The relay's client
                serialiser drops `localPath` and `resolvedRealPath` by
                construction, and this sentence is what stops the absence
                reading as a bug in the list. */}
            <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
              Named, never located. Juno does not send the path of a folder on your Mac to a
              browser — a path is a path in a screenshot, in a support ticket, and in the next
              thing that asks an agent to read what sits next to it.
            </p>
          </>
        )}
      </section>

      <section>
        <h2 className="mb-2.5 font-mono text-label text-muted-foreground">Apps and sites</h2>
        <div className="space-y-2">
          <NameList
            icon={<Plug className="h-3.5 w-3.5" aria-hidden="true" />}
            title="Apps it may drive"
            names={allowedApps}
            empty="No app is singled out, so screen control is bounded only by the switch above."
          />
          <NameList
            icon={<Plug className="h-3.5 w-3.5" aria-hidden="true" />}
            title="Apps it may never touch"
            names={blockedApps}
            empty="Nothing is blocked by name."
          />
          <NameList
            icon={<Link2 className="h-3.5 w-3.5" aria-hidden="true" />}
            title="Sites the browser may visit"
            names={allowedDomains}
            empty="No site list, so the browser switch above is the whole answer."
          />
        </div>
        <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
          These three are set in Juno on the Mac and are shown here as they stand. The browser
          cannot change them.
        </p>
      </section>
    </div>
  );
}

function NameList({
  icon,
  title,
  names,
  empty,
}: {
  icon: React.ReactNode;
  title: string;
  names: readonly string[];
  /** What the absence means, in words. An empty list is never left blank. */
  empty: string;
}) {
  return (
    <div className="rounded-xl border border-border/50 px-3.5 py-2.5">
      <p className="flex items-center gap-2 text-[13px] font-medium text-foreground">
        <span className="shrink-0 text-muted-foreground">{icon}</span>
        {title}
      </p>
      {names.length === 0 ? (
        <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">{empty}</p>
      ) : (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {names.map((name) => (
            <span
              key={name}
              className="inline-flex items-center rounded-full border border-border/70 bg-background/50 px-2 py-0.5 font-mono text-[10px] leading-none text-muted-foreground"
            >
              {name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
