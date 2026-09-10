"use client";

import * as React from "react";
import { SettingsPaneHeader } from "@/components/settings/setting-row";
import { settingsSection, type SettingsSectionId } from "@/components/settings/settings-sections";
import { settingsPanelId, settingsTabId } from "@/components/settings/settings-rail";
import { GeneralSection } from "@/components/settings/sections/general";
import { PersonalizationSection } from "@/components/settings/sections/personalization";
import { MemorySection } from "@/components/settings/sections/memory";
import { ModelsSection } from "@/components/settings/sections/models";
import { ConnectorsSection } from "@/components/settings/sections/connectors";
import { VoiceSection } from "@/components/settings/sections/voice";
import { DataPrivacySection } from "@/components/settings/sections/data-privacy";
import { AccountSection } from "@/components/settings/sections/account";
import { BillingSection } from "@/components/settings/sections/billing";
import { cn } from "@/lib/utils";

const SECTION_COMPONENTS: Record<SettingsSectionId, React.ComponentType> = {
  general: GeneralSection,
  personalization: PersonalizationSection,
  memory: MemorySection,
  models: ModelsSection,
  connectors: ConnectorsSection,
  voice: VoiceSection,
  data: DataPrivacySection,
  account: AccountSection,
  billing: BillingSection,
};

/**
 * One section, drawn: its heading, its lede, its content. The modal and the
 * `/settings` page both render exactly this, so a control can never exist in
 * one and not the other again.
 *
 * `key={section}` remounts on switch so each section arrives on the rise-in
 * and its own state (drafts, previews) starts clean.
 *
 * `tabpanel` only when the rail beside it is a tablist (the modal — see
 * settings-rail.tsx). On the page the rail is a <nav> of links, and a
 * tabpanel with no tabs is a promise to assistive tech that nothing keeps;
 * there the pane is a plain region named by its own heading.
 */
export function SettingsPane({
  section,
  tabpanel = false,
  className,
}: {
  section: SettingsSectionId;
  /** True inside the modal, where the rail is a tablist. */
  tabpanel?: boolean;
  className?: string;
}) {
  const meta = settingsSection(section);
  const Section = SECTION_COMPONENTS[section];
  const headingId = `settings-${section}`;
  return (
    <div
      key={section}
      className={cn("motion-safe:animate-rise-in [animation-fill-mode:backwards]", className)}
      role={tabpanel ? "tabpanel" : "region"}
      id={tabpanel ? settingsPanelId(section) : undefined}
      aria-labelledby={tabpanel ? settingsTabId(section) : headingId}
    >
      <SettingsPaneHeader title={<span id={headingId}>{meta.label}</span>} description={meta.description} />
      <Section />
    </div>
  );
}
