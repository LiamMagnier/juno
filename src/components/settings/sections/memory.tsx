"use client";

import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useApp } from "@/components/app/app-provider";
import { MemoryManager } from "@/components/memory/memory-manager";
import { useSettingsSave } from "@/components/settings/use-settings-save";
import { SettingRow, SettingsGroup } from "@/components/settings/setting-row";
import type { ClientSettings } from "@/types/app";

export function MemorySection() {
  const { settings } = useApp();
  const save = useSettingsSave();

  return (
    <>
      <SettingsGroup title="Memory" description="What Juno is allowed to remember about you between conversations.">
        <SettingRow
          label="Reference saved memories"
          htmlFor="memory-enabled"
          description="Juno learns durable facts and preferences from your chats and uses them in later ones."
          control={
            <Switch
              id="memory-enabled"
              checked={settings.memoryEnabled}
              onCheckedChange={(v) => void save({ memoryEnabled: v })}
            />
          }
        />
        <SettingRow
          label="Background processing"
          description="Which providers may read your chats to build memory, titles and summaries — work you never see."
          control={
            <Select
              value={settings.backgroundProviderMode}
              onValueChange={(v) =>
                void save({ backgroundProviderMode: v as ClientSettings["backgroundProviderMode"] })
              }
            >
              <SelectTrigger aria-label="Background processing" className="w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="same_provider">Only the provider I chat with</SelectItem>
                <SelectItem value="selected_provider">Only my selected provider</SelectItem>
                <SelectItem value="any_allowed_provider">Any configured provider</SelectItem>
                <SelectItem value="local_only">On-device models only</SelectItem>
              </SelectContent>
            </Select>
          }
        />
      </SettingsGroup>

      <SettingsGroup
        title="Manage memories"
        description="What Juno currently remembers, and the words to change it."
        aside={
          <Button asChild variant="outline" size="sm">
            <Link href="/memory">Open memory page</Link>
          </Button>
        }
      >
        <div className="py-3">
          <MemoryManager compact />
        </div>
      </SettingsGroup>
    </>
  );
}
