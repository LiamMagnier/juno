"use client";

/**
 * Settings › Code, subscriptions group: finds the user's Mac, reaches
 * its env server (device link), and shows what it reports. The API keys group
 * below it stays the models lane's (it carries 30-day usage).
 */
import "./code-v2.css";
import * as React from "react";
import Link from "next/link";
import { ConnectionsPanel } from "./connections";
import { useEnvLink } from "./use-env-link";
import { Button } from "@/components/ui/button";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { SettingRow, SettingRowSkeleton, SettingsGroup } from "@/components/settings/setting-row";
import { formatAgo } from "@/components/settings/format";
import { fallbackSetupCommand, managedSetup } from "@/lib/code-v2/providers-view";
import { managedCall } from "@/lib/code-v2/runtime-lane";
import { BRAND, PRODUCT_NAME } from "@/lib/brand/names";
import { cn } from "@/lib/utils";
import type { Provider } from "@/lib/providers";
import type { DeviceInfo } from "./types";

interface DeviceRow {
  id: string;
  name: string;
  online?: boolean;
  lastSeenAt: string;
}

/**
 * The labs whose own coding agents run Code on their own plans, one mark each
 * (Gemini CLI and Antigravity are both Google's; OpenCode has no lab), in the
 * order the Mac lists them.
 */
const SUBSCRIPTION_LABS: readonly Provider[] = ["anthropic", "openai", "google", "xai", "deepseek"];

/**
 * Before a Mac is paired: one row that says what subscriptions are and where
 * they connect, and the way to get there.
 *
 * It used to be the Mac's own master/detail box drawn empty: seven identical
 * grey rows that each said "Connect your Mac to check", a detail pane holding
 * one sentence and a disabled Re-check, in Code's type and radii, 460px tall.
 * That is what every web reader without a Mac saw, which is most of them.
 */
function SubscriptionsRow({ label, sentence, control }: { label: string; sentence: string; control?: React.ReactNode }) {
  return (
    <SettingsGroup title="Subscriptions">
      <SettingRow
        label={label}
        description={
          <>
            <span className="block">{sentence}</span>
            <span className="mt-3 flex items-center gap-3 text-muted-foreground" aria-hidden="true">
              {SUBSCRIPTION_LABS.map((lab) => (
                <ProviderLogo key={lab} provider={lab} className="size-4" />
              ))}
            </span>
          </>
        }
        control={control}
      />
    </SettingsGroup>
  );
}

const WHAT_SUBSCRIPTIONS_ARE = `Claude, ChatGPT, Gemini, Grok and other coding agents can run ${BRAND.code.label} on their own plans. They connect through ${PRODUCT_NAME} for Mac, and their sign-in and billing stay with them.`;

function SubscriptionsWithoutMac() {
  return (
    <SubscriptionsRow
      label="Use the plans you already pay for"
      sentence={WHAT_SUBSCRIPTIONS_ARE}
      control={
        <Button asChild variant="outline" size="sm">
          <Link href="/download">Download for Mac</Link>
        </Button>
      }
    />
  );
}

/**
 * The subscriptions group. "Try again" remounts the probe under a new key:
 * the Mac list is read afresh and the env link is opened anew, which is the
 * only way to re-ask a Mac whose first answer never came (the link only
 * refreshes a Mac that answered once). It used to say "come back to this
 * page", with nothing to press but reload.
 */
export function SubscriptionConnections() {
  const [attempt, setAttempt] = React.useState(0);
  return <SubscriptionsProbe key={attempt} onRetry={() => setAttempt((n) => n + 1)} />;
}

function SubscriptionsProbe({ onRetry }: { onRetry: () => void }) {
  // `undefined` while the device list loads, `null` once it says there is none.
  const [device, setDevice] = React.useState<DeviceInfo | null | undefined>(undefined);
  React.useEffect(() => {
    let live = true;
    fetch("/api/code/devices")
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { devices?: DeviceRow[] } | null) => {
        const list = (b?.devices ?? []).sort((a, z) => Number(!!z.online) - Number(!!a.online) || z.lastSeenAt.localeCompare(a.lastSeenAt));
        const d = list[0];
        if (live) setDevice(d ? { id: d.id, name: d.name, online: !!d.online, lastSeenAt: d.lastSeenAt } : null);
      })
      .catch(() => {
        if (live) setDevice(null);
      });
    return () => {
      live = false;
    };
  }, []);
  const env = useEnvLink(device ? { id: device.id, online: device.online } : null, null);

  // Still finding the Mac, or still asking it what it has.
  if (device === undefined || (device?.online && !env.probed)) {
    return (
      <SettingsGroup title="Subscriptions">
        <div role="status" aria-label={device ? `Reaching ${device.name}` : "Looking for your Mac"}>
          <SettingRowSkeleton />
        </div>
      </SettingsGroup>
    );
  }
  if (device === null) return <SubscriptionsWithoutMac />;
  // A Mac this browser cannot reach right now: say which and why, once,
  // rather than seven rows that each say "Connect your Mac to check".
  if (!device.online || !env.ready) {
    const seen = device.lastSeenAt ? `, last seen ${formatAgo(Date.parse(device.lastSeenAt), Date.now())}` : "";
    return (
      <SubscriptionsRow
        label={device.name}
        sentence={
          !device.online
            ? `Offline${seen}. Open ${PRODUCT_NAME} on it to use your subscriptions here.`
            : (env.pairingRequired ?? `Online, but it didn’t answer. Open ${PRODUCT_NAME} on it, then try again.`)
        }
        control={
          <Button variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        }
      />
    );
  }

  // With a Mac, the Mac's own master/detail, which has real rows to show,
  // under the same header every other group has: "Subscriptions" as the
  // medium title, and which Mac they run through as its note. The panel drew
  // both itself, in Code's kit: the note as a 12px line with a laptop glyph
  // ABOVE the box, and "Subscriptions" as a caption INSIDE it, so only this
  // state of the group read as another product. Those two are hidden here,
  // and the box takes the settings card's hairline and radius, flush under
  // the header (`bare`: a card around it would be a box in a box). Inside
  // Settings it takes the height of its rows: the workspace sheet's 460px
  // floor left a blank pane under a short list. A load error (the panel's
  // second note) still shows.
  const seen = device.lastSeenAt ? `, seen ${formatAgo(Date.parse(device.lastSeenAt), Date.now())}` : "";
  return (
    <SettingsGroup
      title="Subscriptions"
      description={`On the web, subscriptions run through ${device.name}${seen}.`}
      bare
      className={cn(
        "[&_.inner>.cv2-note:first-child]:hidden [&_.cv2-md-list>.cv2-msect:first-child]:hidden",
        "[&_.cv2-md]:mt-0 [&_.cv2-md]:min-h-0 [&_.cv2-md]:rounded-2xl [&_.cv2-md]:!border-border/60 [&_.cv2-md]:!bg-transparent [&_.cv2-md-list]:!border-border/60",
        "[&_.cv2-note]:flex-nowrap [&_.cv2-note]:items-start [&_.cv2-note>svg]:mt-px"
      )}
    >
      <ConnectionsPanel
        embedded
        showKeys={false}
        instances={env.instances}
        device={device}
        onProbe={env.ready ? env.probe : undefined}
        onManaged={
          env.ready && env.client
            ? (instanceId, op) => {
                if (!env.client) throw new Error("Your Mac is not connected.");
                return managedCall(env.client, instanceId, op);
              }
            : undefined
        }
        onSetup={async (instance, action) => {
          const managed = managedSetup(instance, action);
          if (managed && env.client) {
            // Antigravity: the Mac downloads Google's runtime, or starts Google sign-in, itself.
            if (managed.type === "provider.install") {
              await env.client.request("provider.install", managed.params);
              return `Installing Google’s runtime on ${device.name}. This row updates as it goes.`;
            }
            const auth = (await env.client.request("provider.auth", managed.params)).auth;
            return auth.message ?? "Google sign-in started. The link appears here.";
          }
          let command: string | null = null;
          try {
            command = (await env.client?.request("provider.setup", { instanceId: instance.id, action }))?.step?.command ?? null;
          } catch {
            command = null;
          }
          command ??= fallbackSetupCommand(instance, action);
          if (!command) throw new Error("Run the vendor’s own setup on your Mac, then press Re-check.");
          // Settings has no terminal pane: say the command; the Code workspace opens one with it typed in.
          return `Run ${command} in Terminal on ${device.name}, then Re-check. In a Code session, Alevr opens a terminal with it typed in.`;
        }}
      />
    </SettingsGroup>
  );
}
