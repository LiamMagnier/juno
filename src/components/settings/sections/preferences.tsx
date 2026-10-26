"use client";

/**
 * Web-only settings: the Notifications section (WEB_SETTINGS_SECTIONS), and
 * General's Keyboard group with its shortcuts dialog. Device preferences read
 * and write lib/ui-prefs; the two email rows are account settings and save
 * like everywhere else, and this browser's push subscription saves through
 * lib/notify/web-push-client.
 */

import * as React from "react";
import { useApp } from "@/components/app/app-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Play } from "@/components/ui/icons";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useModifierKeyLabel } from "@/components/ui/platform";
import { SettingRow, SettingsGroup } from "@/components/settings/setting-row";
import { useSettingsSave } from "@/components/settings/use-settings-save";
import { useSaveStates } from "@/components/settings/save-status";
import { playReplyChime, useUiPref, type SendKey, type TouchReturn } from "@/lib/ui-prefs";
import { useTouchPrimary } from "@/lib/touch-keyboard";
import { shortcutGroups } from "@/lib/shortcut-groups";
import { codeShortcutGroups, splitShortcutColumns, type ShortcutGroup } from "@/components/settings/code-shortcuts";
import { cn } from "@/lib/utils";
import type { PushPreferences } from "@/lib/notify/types";
import {
  disableWebPush,
  enableWebPush,
  updateWebPushPrefs,
  webPushStatus,
  type WebPushState,
} from "@/lib/notify/web-push-client";
import { BRAND, PRODUCT_NAME } from "@/lib/brand/names";

/* ——— Notifications ——————————————————————————————————————————————————— */

type Permission = NotificationPermission | "unsupported";

function usePermission(): [Permission, () => Promise<Permission>] {
  const [permission, setPermission] = React.useState<Permission>("default");
  React.useEffect(() => {
    setPermission("Notification" in window ? Notification.permission : "unsupported");
  }, []);
  const request = React.useCallback(async (): Promise<Permission> => {
    if (!("Notification" in window)) return "unsupported";
    const next = await Notification.requestPermission();
    setPermission(next);
    return next;
  }, []);
  return [permission, request];
}

/**
 * Every notification switch, once. Browser notifications used to be split
 * across two sections: the per-tab reply alert here, and this browser's push
 * subscription under Account, which also repeated the two email switches
 * under its own "Notifications" heading. Now this browser's two kinds sit
 * together, push first because it reaches you when the tab is closed, each
 * named for when it fires so the pair cannot be mistaken for each other.
 */
export function NotificationsSection() {
  const { settings, features } = useApp();
  const save = useSettingsSave();
  const saves = useSaveStates();
  const [notifyOnReply, setNotifyOnReply] = useUiPref("notifyOnReply");
  const [replySound, setReplySound] = useUiPref("replySound");
  const [permission, requestPermission] = usePermission();

  const toggleNotify = async (on: boolean) => {
    if (!on) return setNotifyOnReply(false);
    const granted = permission === "granted" ? "granted" : await requestPermission();
    setNotifyOnReply(granted === "granted");
  };

  const permissionNote =
    permission === "denied"
      ? "Your browser is blocking notifications for this site. Allow them in the site settings, then turn this on."
      : permission === "unsupported"
        ? "This browser cannot show notifications."
        : "A system notification when a reply finishes while you are in another tab or app.";

  return (
    <>
      <SettingsGroup title="This browser" description="Set for this browser only.">
        {features.webPush && features.webPushPublicKey ? (
          <BrowserNotificationRows publicKey={features.webPushPublicKey} />
        ) : null}
        <SettingRow
          label="Reply alerts while this tab is open"
          htmlFor="notify-reply"
          description={permissionNote}
          control={
            <Switch
              id="notify-reply"
              checked={notifyOnReply && permission === "granted"}
              disabled={permission === "denied" || permission === "unsupported"}
              onCheckedChange={(on) => void toggleNotify(on)}
            />
          }
        />
        <SettingRow
          label="Play a sound"
          htmlFor="reply-sound"
          description="A short chime when a reply finishes in the background."
          // The play glyph and the switch stay on the right at 360px, where
          // the pair would otherwise drop under the text, on the left.
          inline
          control={
            <div className="flex items-center gap-2">
              {/* Voice › Voice sounds' control: a play glyph named in its
                  tooltip. The "Preview" word beside the switch read as the
                  switch's own label ("Preview: on"). */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Play the chime"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => playReplyChime()}
                  >
                    <Play className="size-4" aria-hidden="true" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Play the chime</TooltipContent>
              </Tooltip>
              <Switch id="reply-sound" checked={replySound} onCheckedChange={setReplySound} />
            </div>
          }
        />
      </SettingsGroup>
      <SettingsGroup
        title="Email"
        description={
          features.email
            ? "Sent to the address on your account."
            : "Email isn’t set up on this server yet. Your choices are kept for when it is."
        }
      >
        <SettingRow
          label="Budget alerts"
          htmlFor="notif-email-budget"
          description="An email when you reach 80% of your monthly budget."
          status={saves.status("emailBudgetAlerts")}
          control={
            <Switch
              id="notif-email-budget"
              checked={settings.emailBudgetAlerts}
              onCheckedChange={(emailBudgetAlerts) => void saves.track("emailBudgetAlerts", () => save({ emailBudgetAlerts }))}
            />
          }
        />
        <SettingRow
          label="Weekly digest"
          htmlFor="notif-email-digest"
          description="A recap of your usage every Monday."
          status={saves.status("emailWeeklyDigest")}
          control={
            <Switch
              id="notif-email-digest"
              checked={settings.emailWeeklyDigest}
              onCheckedChange={(emailWeeklyDigest) => void saves.track("emailWeeklyDigest", () => save({ emailWeeklyDigest }))}
            />
          }
        />
      </SettingsGroup>
    </>
  );
}

/**
 * This browser's Web Push subscription, and the two switches every push
 * destination carries (a phone and a Mac have the same pair).
 *
 * Per browser, not per account. The subscription IS the preference, so it
 * lives with the browser that holds it: turning it on here says nothing about
 * the laptop at work. Nothing is registered and nothing prompts until the
 * switch is pressed (src/lib/notify/web-push-client.ts).
 *
 * Absent where this browser cannot do it at all (iOS Safari in a tab, a
 * private window with service workers off), rather than a switch that can
 * only fail. Blocked is shown, because that one the reader can change.
 */
export function BrowserNotificationRows({ publicKey }: { publicKey: string }) {
  const saves = useSaveStates();
  const [state, setState] = React.useState<WebPushState | null>(null);
  const [prefs, setPrefs] = React.useState<PushPreferences | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void webPushStatus(publicKey).then((status) => {
      if (cancelled) return;
      setState(status.state);
      setPrefs(status.prefs);
    });
    return () => {
      cancelled = true;
    };
  }, [publicKey]);

  if (state === null || state === "unsupported") return null;

  const turn = (on: boolean) => {
    if (!on) {
      setState("off");
      void saves.track("webPush", async () => {
        await disableWebPush();
        return true;
      });
      return;
    }
    // Started in the click itself, before anything is awaited: the browser
    // shows its permission prompt only while the gesture that asked is live.
    const enabling = enableWebPush(publicKey);
    setState("on");
    void saves.track("webPush", async () => {
      const result = await enabling;
      if (!result.ok) {
        setState(result.reason === "denied" ? "denied" : result.reason === "unsupported" ? "unsupported" : "off");
        return false;
      }
      const status = await webPushStatus(publicKey);
      setState(status.state);
      setPrefs(status.prefs);
      return status.state === "on";
    });
  };

  const setPref = (key: keyof PushPreferences, value: boolean) => {
    if (!prefs) return;
    const previous = prefs;
    setPrefs({ ...prefs, [key]: value });
    void saves.track(key, async () => {
      const ok = await updateWebPushPrefs({ [key]: value });
      if (!ok) setPrefs(previous);
      return ok;
    });
  };

  const denied = state === "denied";
  return (
    <>
      <SettingRow
        label="Push notifications"
        htmlFor="web-push"
        description={
          denied
            ? "Blocked in your browser settings. Allow notifications for this site there, then come back."
            : `When a task needs you or something finishes, even when ${PRODUCT_NAME} isn’t open.`
        }
        status={saves.status("webPush")}
        control={<Switch id="web-push" checked={state === "on"} disabled={denied} onCheckedChange={turn} />}
      />
      {state === "on" && prefs ? (
        <>
          <SettingRow
            label="When something needs you"
            htmlFor="web-push-needs-you"
            description="Approvals and questions a task or an agent is waiting on."
            status={saves.status("notifyNeedsYou")}
            control={
              <Switch
                id="web-push-needs-you"
                checked={prefs.notifyNeedsYou}
                onCheckedChange={(on) => setPref("notifyNeedsYou", on)}
              />
            }
          />
          <SettingRow
            label="Updates"
            htmlFor="web-push-updates"
            description="Finished tasks, and ideas your agents want to share."
            status={saves.status("notifyUpdates")}
            control={
              <Switch
                id="web-push-updates"
                checked={prefs.notifyUpdates}
                onCheckedChange={(on) => setPref("notifyUpdates", on)}
              />
            }
          />
        </>
      ) : null}
    </>
  );
}

/* ——— Keyboard (General) ——————————————————————————————————————————————— */

type ShortcutScope = "chat" | "code";
const SHORTCUT_SCOPES: { value: ShortcutScope; label: string }[] = [
  { value: "chat", label: BRAND.chat.label },
  { value: "code", label: BRAND.code.label },
];

/**
 * General's Keyboard group: how a message is sent, and every shortcut one
 * press away.
 *
 * Keyboard was a section of its own, the send key over thirty-odd shortcut
 * rows, with a Chat/Code switch on the first group's heading that changed
 * every group under it. The shortcuts are reference rather than settings, so
 * they open in a sheet (as ChatGPT's do), with the switch at its top where it
 * plainly governs the whole list. Before that, Code's shortcuts were a section
 * too, with a second "Everywhere" group whose keys disagreed with Chat's.
 */
export function KeyboardGroup() {
  const mod = useModifierKeyLabel();
  const [sendKey, setSendKey] = useUiPref("sendKey");
  const [touchReturn, setTouchReturn] = useUiPref("touchReturn");
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);
  // The on-screen keyboard's row shows where there is one: a touch-first
  // device with no mouse or trackpad attached (lib/touch-keyboard.ts, G35).
  const touch = useTouchPrimary();
  const sendOptions: { value: SendKey; label: string }[] = [
    { value: "enter", label: "Enter" },
    { value: "mod-enter", label: `${mod} Enter` },
  ];
  const touchReturnOptions: { value: TouchReturn; label: string }[] = [
    { value: "newline", label: "Adds a line" },
    { value: "send", label: "Sends" },
  ];
  const groups = shortcutGroups(mod).map((group) =>
    group.title !== "Composer"
      ? group
      : {
          ...group,
          items: group.items.map((item) =>
            item.label === "Send message" && sendKey === "mod-enter"
              ? { ...item, keys: [mod, "↵"] }
              : item.label === "New line" && sendKey === "mod-enter"
                ? { ...item, keys: ["↵"] }
                : item
          ),
        }
  );
  const sendRows = (
    <>
      <SettingRow
        label="Send messages with"
        description={sendKey === "enter" ? "Shift + Enter adds a new line." : "Enter adds a new line."}
        wide
        control={<SegmentedControl ariaLabel="Send messages with" value={sendKey} onChange={setSendKey} options={sendOptions} className="w-full @[34rem]/pane:w-auto" />}
      />
      {touch && sendKey === "enter" ? (
        <SettingRow
          label="Return on the on-screen keyboard"
          description={
            touchReturn === "newline"
              ? "The send button sends. Return on a connected keyboard still sends."
              : "Return sends, like Enter on a keyboard."
          }
          wide
          control={
            <SegmentedControl
              ariaLabel="Return on the on-screen keyboard"
              value={touchReturn}
              onChange={setTouchReturn}
              options={touchReturnOptions}
              className="w-full @[34rem]/pane:w-auto"
            />
          }
        />
      ) : null}
    </>
  );
  return (
    <SettingsGroup title="Keyboard">
      {sendRows}
      <SettingRow
        label="Keyboard shortcuts"
        description={
          touch
            ? "For a keyboard connected to this device."
            : `Every shortcut in ${BRAND.chat.label} and ${BRAND.code.label}.`
        }
        control={
          <Button variant="outline" size="sm" onClick={() => setShortcutsOpen(true)}>
            View
          </Button>
        }
      />
      {/* Portaled: the dialog adds nothing to the card's rows. */}
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} chatGroups={groups} />
    </SettingsGroup>
  );
}

/**
 * Every shortcut, for Chat or for Code, in two balanced columns from 640px
 * (one on a phone, where the dialog is a sheet).
 *
 * The list scrolls inside a body of fixed height, so flipping Chat to Code
 * (six groups against four) changes what is listed, not the size of the
 * dialog: a centred dialog that grows re-centres, and the switch jumps away
 * from under the pointer that just pressed it.
 */
function ShortcutsDialog({
  open,
  onOpenChange,
  chatGroups,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chatGroups: readonly ShortcutGroup[];
}) {
  const mod = useModifierKeyLabel();
  const [scope, setScope] = React.useState<ShortcutScope>("chat");
  const codeGroups = React.useMemo(() => codeShortcutGroups(mod), [mod]);
  const columns = splitShortcutColumns(scope === "code" ? codeGroups : chatGroups);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-w-2xl flex-col gap-0 p-0 sm:p-0">
        <div className="flex flex-col items-start gap-2 px-5 pb-4 pt-4 sm:px-6">
          {/* The title's line is the close button's own box (36px, 44 on
              touch) at the close's own 16px inset, so the two share one
              midline. With the switch under it, the title used to sit on the
              header's 20px padding and the ✕ landed 6px below its centre on
              a phone. */}
          <div className="flex min-h-9 items-center pr-12 coarse:min-h-11">
            <DialogTitle>Keyboard shortcuts</DialogTitle>
          </div>
          <DialogDescription className="sr-only">Every keyboard shortcut, for {BRAND.chat.label} or for {BRAND.code.label}.</DialogDescription>
          <SegmentedControl ariaLabel="Shortcuts for" size="sm" value={scope} onChange={setScope} options={SHORTCUT_SCOPES} />
        </div>
        <div className="h-[min(40rem,calc(100dvh-12rem))] overflow-y-auto overscroll-contain border-t border-border/60 px-5 pb-6 sm:px-6">
          <div className="grid gap-x-10 sm:grid-cols-2">
            {columns.map((column, ci) => (
              <div key={ci}>
                {column.map((group) => (
                  <section key={`${scope}:${group.title}`} className="pt-5">
                    <h3 className="text-caption text-muted-foreground">{group.title}</h3>
                    <div className="divide-y divide-border/60">
                      {group.items.map((item, i) => (
                        <ShortcutRow key={`${i}:${item.label}`} label={item.label} keys={item.keys} className="py-2.5" />
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Arrow keys as glyphs from the icon set. The faces ship as Latin subsets,
 * which carry ↑ and ↓ but not ← and →, so those two fell back to a system
 * font and printed smaller and fainter than their neighbours. All four are
 * drawn so they match each other; the name rides along for screen readers.
 */
const ARROW_KEYS: Record<string, { icon: typeof ArrowLeft; name: string }> = {
  "←": { icon: ArrowLeft, name: "Left arrow" },
  "→": { icon: ArrowRight, name: "Right arrow" },
  "↑": { icon: ArrowUp, name: "Up arrow" },
  "↓": { icon: ArrowDown, name: "Down arrow" },
};

/** One shortcut: what it does, then its keys as keycaps. Chat's and Code's alike. */
export function ShortcutRow({ label, keys, className }: { label: React.ReactNode; keys: readonly string[]; className?: string }) {
  return (
    <div className={cn("flex items-center justify-between gap-4 py-3", className)}>
      <span className="text-ui text-foreground">{label}</span>
      <span className="flex shrink-0 items-center gap-1">
        {keys.map((k, i) => {
          const arrow = ARROW_KEYS[k];
          if (!arrow) return <Kbd key={i}>{k}</Kbd>;
          const Glyph = arrow.icon;
          return (
            <Kbd key={i}>
              {/* The keycap's own ink (`text-current`), not the darker glyph
                  ink the icon set gives a muted control: here the glyph
                  stands in for a character, beside ↵ and ⇧ set as text. */}
              <Glyph className="size-3 text-current" aria-hidden="true" />
              <span className="sr-only">{arrow.name}</span>
            </Kbd>
          );
        })}
      </span>
    </div>
  );
}
