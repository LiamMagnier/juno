"use client";

import { Switch } from "@/components/ui/switch";
import { useApp } from "@/components/app/app-provider";
import { useSaveStates } from "@/components/settings/save-status";
import { useSettingsSave } from "@/components/settings/use-settings-save";
import { SettingRow, SettingsGroup } from "@/components/settings/setting-row";
import { CROSS_MESSAGES_DEFAULT } from "@/lib/cross-conversation/policy";

/**
 * "Let conversations message each other" (src/lib/cross-conversation): may an
 * agent in one conversation list, read and message your other ones. On by
 * default in Code, where sessions already coordinate work; off by default in
 * Chat, where a conversation is usually one person's private thread. A
 * conversation's own toggle (its menu) wins over these.
 */
export function CrossConversationGroup() {
  const { settings } = useApp();
  const save = useSettingsSave();
  const saves = useSaveStates();
  const chat = settings.crossMessagesChat ?? CROSS_MESSAGES_DEFAULT.chat;
  const code = settings.crossMessagesCode ?? CROSS_MESSAGES_DEFAULT.code;
  return (
    <SettingsGroup
      title="Let conversations message each other"
      description="An agent can list, read and message your other conversations. What it sends arrives as a message from that conversation, never as you, and it can't approve anything."
    >
      <SettingRow
        label="In Chat"
        htmlFor="cross-messages-chat"
        description="Chats can reach your other chats and Code sessions. Off by default."
        status={saves.status("crossMessagesChat")}
        control={
          <Switch
            id="cross-messages-chat"
            checked={chat}
            onCheckedChange={(crossMessagesChat) => void saves.track("crossMessagesChat", () => save({ crossMessagesChat }))}
          />
        }
      />
      <SettingRow
        label="In Code"
        htmlFor="cross-messages-code"
        description="Code sessions can reach each other and your chats. On by default."
        status={saves.status("crossMessagesCode")}
        control={
          <Switch
            id="cross-messages-code"
            checked={code}
            onCheckedChange={(crossMessagesCode) => void saves.track("crossMessagesCode", () => save({ crossMessagesCode }))}
          />
        }
      />
    </SettingsGroup>
  );
}
