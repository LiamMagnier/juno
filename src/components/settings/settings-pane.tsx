"use client";

import * as React from "react";
import { AnimatePresence, motion, useReducedMotion, type Variants } from "framer-motion";
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
import { reducedVariants, transition, variants } from "@/lib/motion";
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
 * The pane's switch. The incoming section is the workhorse `rise`; the
 * outgoing one only fades, on the exit rung, because it is leaving in place
 * rather than going anywhere. Under reduced motion the rise loses its travel
 * and keeps its fade (`reducedVariants`), the same tier as the CSS side.
 */
const PANE: Variants = {
  hidden: variants.rise.hidden,
  visible: variants.rise.visible,
  exit: { opacity: 0, transition: transition.exit },
};
const PANE_REDUCED: Variants = {
  hidden: reducedVariants.rise.hidden,
  visible: reducedVariants.rise.visible,
  exit: { opacity: 0, transition: transition.exit },
};

/**
 * One section, drawn: its heading, its lede, its content. The modal and the
 * `/settings` page both render exactly this, so a control can never exist in
 * one and not the other again.
 *
 * `key={section}` remounts on switch so each section's own state (drafts,
 * previews) starts clean — and the switch is a CROSS-FADE rather than a snap:
 * `AnimatePresence mode="popLayout"` lifts the outgoing section out of the
 * flow while it fades, so the incoming one takes its place at once instead of
 * waiting for it, and the two overlap for the exit rung.
 *
 * FIRST PAINT IS CSS, NOT FRAMER. The (app) layout renders on the server, and
 * a framer `initial="hidden"` would be written into that HTML as `opacity:0`,
 * leaving the pane invisible beside a visible rail until the bundle hydrates
 * (and for ever without JS). So `AnimatePresence initial={false}` renders the
 * first section at rest, and that first section arrives on the CSS
 * `animate-rise-in` instead, which plays on first paint with no JS at all.
 * Framer takes over only for switches the reader makes after that.
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
  const reduce = useReducedMotion();
  // The first section the pane was mounted with keeps its CSS entrance; once
  // the reader switches, framer owns every entrance (adjusting state on a
  // prop change, React's own pattern — no effect, no extra paint).
  const [firstSection] = React.useState(section);
  const [switched, setSwitched] = React.useState(false);
  if (!switched && section !== firstSection) setSwitched(true);
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.div
        key={section}
        variants={reduce ? PANE_REDUCED : PANE}
        initial="hidden"
        animate="visible"
        exit="exit"
        className={cn(!switched && "motion-safe:animate-rise-in [animation-fill-mode:backwards]", className)}
        role={tabpanel ? "tabpanel" : "region"}
        id={tabpanel ? settingsPanelId(section) : undefined}
        aria-labelledby={tabpanel ? settingsTabId(section) : headingId}
      >
        <SettingsPaneHeader title={<span id={headingId}>{meta.label}</span>} description={meta.description} />
        <Section />
      </motion.div>
    </AnimatePresence>
  );
}
