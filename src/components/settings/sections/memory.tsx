"use client";

import * as React from "react";
import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useApp } from "@/components/app/app-provider";
import { MemoryManager } from "@/components/memory/memory-manager";
import { useSettingsSave } from "@/components/settings/use-settings-save";
import { SettingRow, SettingsGroup } from "@/components/settings/setting-row";
import { SENSITIVE_TOPICS, SENSITIVE_TOPIC_META } from "@/lib/memory-sensitive";
import type { ClientSettings } from "@/types/app";

export function MemorySection() {
  const { settings } = useApp();
  const save = useSettingsSave();

  const allowed = React.useMemo(
    () => new Set(settings.memorySensitiveTopics),
    [settings.memorySensitiveTopics]
  );

  const toggleTopic = (topic: (typeof SENSITIVE_TOPICS)[number], on: boolean) => {
    const next = SENSITIVE_TOPICS.filter((id) => (id === topic ? on : allowed.has(id)));
    void save({ memorySensitiveTopics: next });
  };

  return (
    <>
      {/* No title and no lede: the pane header directly above this is "Memory"
          with the registry's one-line description, and this group used to
          repeat both — the same word one rung down and a paraphrase of the
          same sentence. The pane's lede is this group's lede. */}
      <SettingsGroup>
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

      {/*
       * Sensitive subjects.
       *
       * OFF IS THE DEFAULT AND OFF IS THE POINT. Juno's extractor is good at
       * noticing durable facts, which means it is equally good at noticing a
       * diagnosis mentioned once while drafting an email about it. Nobody asks
       * for that to become a permanent line in their profile, and finding it
       * on this page later is the wrong moment to discover the feature.
       *
       * Every switch is additive and reversible, and turning one OFF does not
       * delete what was learned while it was on — the memory page lists those
       * facts with a Sensitive chip so they can be forgotten deliberately.
       * Silently deleting them would be the friendlier-looking choice and the
       * wrong one: a switch that destroys data is a switch people are afraid
       * to touch.
       */}
      <SettingsGroup
        title="Sensitive subjects"
        description="Juno never learns these on its own. Turn one on and it will remember that subject like any other — you can turn it back off at any time, and anything already learned stays listed below until you forget it."
      >
        {SENSITIVE_TOPICS.map((topic) => (
          <SettingRow
            key={topic}
            label={SENSITIVE_TOPIC_META[topic].label}
            htmlFor={`memory-sensitive-${topic}`}
            description={SENSITIVE_TOPIC_META[topic].description}
            control={
              <Switch
                id={`memory-sensitive-${topic}`}
                checked={allowed.has(topic)}
                onCheckedChange={(on) => toggleTopic(topic, on)}
              />
            }
          />
        ))}
        <p className="flex items-start gap-1.5 px-1 pt-1 text-caption text-muted-foreground/80">
          <ShieldAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
          <span>
            A fact you add yourself is always kept, whatever these say — this controls what Juno writes down without
            being asked.
          </span>
        </p>
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
