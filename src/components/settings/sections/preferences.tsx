"use client";

/**
 * The web-only settings panes (WEB_SETTINGS_SECTIONS): Notifications,
 * Capabilities and Keyboard. Device preferences read and write lib/ui-prefs;
 * the two email rows are account settings and save like everywhere else.
 */

import * as React from "react";
import { useApp } from "@/components/app/app-provider";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { useModifierKeyLabel } from "@/components/ui/platform";
import { SettingRow, SettingsGroup } from "@/components/settings/setting-row";
import { CrossConversationGroup } from "@/components/settings/sections/cross-conversation";
import { useSettingsSave } from "@/components/settings/use-settings-save";
import { useSaveStates } from "@/components/settings/save-status";
import { openSettings } from "@/components/settings/settings-sections";
import { playReplyChime, useUiPref, type SendKey } from "@/lib/ui-prefs";
import { shortcutGroups } from "@/lib/shortcut-groups";

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

export function NotificationsSection() {
  const { settings } = useApp();
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
      <SettingsGroup title="Replies" description="Set for this device only.">
        <SettingRow
          label="Notify me when a reply is ready"
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
          control={
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="sm" onClick={() => playReplyChime()}>
                Preview
              </Button>
              <Switch id="reply-sound" checked={replySound} onCheckedChange={setReplySound} />
            </div>
          }
        />
      </SettingsGroup>
      <SettingsGroup title="Email" description="Sent to the address on your account.">
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

/* ——— Capabilities ———————————————————————————————————————————————————— */


export function CapabilitiesSection() {
  const [followUps, setFollowUps] = useUiPref("followUps");
  const [codeWrap, setCodeWrap] = useUiPref("codeWrap");
  return (
    <>
      <SettingsGroup title="In replies" description="Set for this device only.">
        <SettingRow
          label="Follow-up suggestions"
          htmlFor="cap-followups"
          description="Offer a few next questions under a finished reply."
          control={<Switch id="cap-followups" checked={followUps} onCheckedChange={setFollowUps} />}
        />
        <SettingRow
          label="Wrap long code lines"
          htmlFor="cap-codewrap"
          description="Wrap code blocks to the column instead of scrolling sideways."
          control={<Switch id="cap-codewrap" checked={codeWrap} onCheckedChange={setCodeWrap} />}
        />
      </SettingsGroup>
      <CrossConversationGroup />
      <SettingsGroup title="Tools" description="Turn tools on for a single message from the composer's + menu.">
        {[
          { id: "memory", label: "Memory", description: "What the assistant remembers between chats." },
          { id: "connectors", label: "Apps", description: "Services it can read from and act in." },
          { id: "models", label: "Models", description: "Your default model and favourites." },
          { id: "voice", label: "Voice", description: "Read-aloud voice and dictation." },
        ].map((link) => (
          <button key={link.id} type="button" onClick={() => openSettings(link.id)} className="group flex w-full items-center gap-4 py-4 text-left">
            <span className="min-w-0 flex-1">
              <span className="block text-body font-medium text-foreground">{link.label}</span>
              <span className="mt-0.5 block text-ui text-muted-foreground">{link.description}</span>
            </span>
            <span aria-hidden="true" className="text-ui text-muted-foreground transition-transform duration-fast ease-out-soft group-hover:translate-x-0.5 group-hover:text-foreground">
              Open
            </span>
          </button>
        ))}
      </SettingsGroup>
    </>
  );
}

/* ——— Keyboard ———————————————————————————————————————————————————————— */

export function KeyboardSection() {
  const mod = useModifierKeyLabel();
  const [sendKey, setSendKey] = useUiPref("sendKey");
  const sendOptions: { value: SendKey; label: string }[] = [
    { value: "enter", label: "Enter" },
    { value: "mod-enter", label: `${mod} Enter` },
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
  return (
    <>
      <SettingsGroup title="Composer">
        <SettingRow
          label="Send messages with"
          description={sendKey === "enter" ? "Shift + Enter adds a new line." : "Enter adds a new line."}
          wide
          control={<SegmentedControl ariaLabel="Send messages with" value={sendKey} onChange={setSendKey} options={sendOptions} className="w-full @[34rem]/pane:w-auto" />}
        />
      </SettingsGroup>
      {groups.map((group) => (
        <SettingsGroup key={group.title} title={group.title}>
          {group.items.map((item) => (
            <div key={item.label} className="flex items-center justify-between gap-4 py-3">
              <span className="text-ui text-foreground">{item.label}</span>
              <span className="flex shrink-0 items-center gap-1">
                {item.keys.map((k, i) => (
                  <Kbd key={i}>{k}</Kbd>
                ))}
              </span>
            </div>
          ))}
        </SettingsGroup>
      ))}
    </>
  );
}
