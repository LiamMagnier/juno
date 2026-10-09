"use client";

import * as React from "react";
import { AnimatePresence, motion, useReducedMotion, type Variants } from "framer-motion";
import { SettingsPaneHeader } from "@/components/settings/setting-row";
import { settingsSection, type SettingsSectionId } from "@/components/settings/settings-sections";
import { settingsPanelId, settingsTabId } from "@/components/settings/settings-rail";
import { AppearanceSection, GeneralSection } from "@/components/settings/sections/general";
import { CapabilitiesSection, KeyboardSection, NotificationsSection } from "@/components/settings/sections/preferences";
import { PersonalizationSection } from "@/components/settings/sections/personalization";
import { MemorySection } from "@/components/settings/sections/memory";
import { ModelsSection } from "@/components/settings/sections/models";
import { ConnectorsSection } from "@/components/settings/sections/connectors";
import { ConnectionsSection } from "@/components/settings/sections/connections";
import { DevicesSection } from "@/components/settings/sections/devices";
import { VoiceSection } from "@/components/settings/sections/voice";
import { DataPrivacySection } from "@/components/settings/sections/data-privacy";
import { AccountSection } from "@/components/settings/sections/account";
import { BillingSection } from "@/components/settings/sections/billing";
import { duration, ease, transition } from "@/lib/motion";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { cn } from "@/lib/utils";
// The serif and mono of the editorial kit (ed-h2, ed-h3, ed-annot, ed-stagger)
// that the settings primitives are set in.
import "@/components/app/editorial.css";

const SECTION_COMPONENTS: Record<SettingsSectionId, React.ComponentType> = {
  general: GeneralSection,
  personalization: PersonalizationSection,
  memory: MemorySection,
  models: ModelsSection,
  connectors: ConnectorsSection,
  devices: DevicesSection,
  voice: VoiceSection,
  data: DataPrivacySection,
  account: AccountSection,
  billing: BillingSection,
  appearance: AppearanceSection,
  notifications: NotificationsSection,
  capabilities: CapabilitiesSection,
  keyboard: KeyboardSection,
  connections: ConnectionsSection,
};

/**
 * One line under each section's name on what the section is for. Purpose,
 * not a table of contents: the groups below name themselves.
 */
const SECTION_LEDES: Record<SettingsSectionId, string> = {
  general: "The language the interface speaks, and the way to everything else.",
  appearance: `How ${PRODUCT_NAME} looks, and how its replies read.`,
  notifications: `When ${PRODUCT_NAME} should reach you, here and in your inbox.`,
  personalization: `What ${PRODUCT_NAME} knows about you, and how it answers.`,
  keyboard: "Sending, and every shortcut worth knowing.",
  capabilities: "What a reply can reach for without being asked.",
  memory: `What ${PRODUCT_NAME} carries from one conversation to the next.`,
  models: "Which models answer, and where each new message starts.",
  connectors: `The apps ${PRODUCT_NAME} can read from and act in, and what it asks first.`,
  connections: "The plans you already pay for, run on your Mac, and your own API keys. Neither is billed by your plan.",
  voice: "The voice that reads replies aloud, and how it listens.",
  devices: `The Macs ${PRODUCT_NAME} can work on, and what it may do there.`,
  data: "Your conversations: take them with you, bring them in, or let them go.",
  account: "Who you are here, how you sign in, and the way out.",
  billing: "Your plan, what you have used, and the ceiling you set.",
};

/**
 * The switch between sections: the old one fades out on the fast rung, then
 * the new one fades in on the base rung with a 4px settle. One after the
 * other (`mode="wait"`), never both at once: two dense panes overlapping for
 * the length of an exit was a muddy double image, which is what the previous
 * `popLayout` cross-fade drew. Under reduced motion the settle goes and the
 * fades stay.
 */
const SHIFT_PX = 4;
const PANE: Variants = {
  hidden: { opacity: 0, y: SHIFT_PX },
  visible: { opacity: 1, y: 0, transition: transition.base },
  exit: { opacity: 0, transition: { duration: duration.fast, ease: ease.in } },
};
const PANE_REDUCED: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: transition.base },
  exit: { opacity: 0, transition: { duration: duration.fast, ease: ease.in } },
};

/** The nearest ancestor that scrolls vertically: the modal's pane, or the page's canvas. */
function scrollParent(node: HTMLElement | null): HTMLElement | null {
  let el = node?.parentElement ?? null;
  while (el) {
    const overflowY = getComputedStyle(el).overflowY;
    if ((overflowY === "auto" || overflowY === "scroll") && el.scrollHeight > el.clientHeight) return el;
    el = el.parentElement;
  }
  return document.scrollingElement instanceof HTMLElement ? document.scrollingElement : null;
}

/**
 * One section, drawn: its name and its content. The modal and the `/settings`
 * page both render exactly this, so a control can never exist in one and not
 * the other.
 *
 * The header stays put across a switch; only its words change, with a short
 * fade. It used to ride inside the animating block, so the section's name
 * rose into place on every click along with everything under it.
 *
 * `key={section}` remounts the content so each section's own state (drafts,
 * previews) starts clean. When the new section mounts, the scroller it lives
 * in goes back to the top: a switch used to land partway down the new section,
 * at whatever depth the reader had scrolled the old one to.
 *
 * First paint does not animate here at all: the modal has its own entrance
 * and the page arrives with the route. An entrance inside an entrance is two
 * motions for one event.
 *
 * `tabpanel` only when the rail beside it is a tablist (the modal). On the
 * page the rail is a <nav> of links, and the pane is a plain region named by
 * its own heading.
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
  const rootRef = React.useRef<HTMLDivElement>(null);
  // The name fades only once the reader has switched; on first paint the
  // frame's own entrance is the only motion (adjusting state on a prop
  // change, React's own pattern: no effect, no extra paint).
  const [firstSection] = React.useState(section);
  const [switched, setSwitched] = React.useState(false);
  if (!switched && section !== firstSection) setSwitched(true);

  const resetScroll = React.useCallback(() => {
    const scroller = scrollParent(rootRef.current);
    if (scroller && scroller.scrollTop > 0) scroller.scrollTop = 0;
  }, []);

  return (
    <div
      ref={rootRef}
      // `ed` scopes the editorial kit's variables (its easing, its hairlines),
      // which the stagger below reads.
      className={cn("ed", className)}
      role={tabpanel ? "tabpanel" : "region"}
      id={tabpanel ? settingsPanelId(section) : undefined}
      aria-labelledby={tabpanel ? settingsTabId(section) : headingId}
    >
      <SettingsPaneHeader
        title={
          <span key={section} id={headingId} className={cn("block", switched && "motion-safe:animate-fade-in")}>
            {meta.label}
          </span>
        }
        lede={
          <span key={section} className={cn("block", switched && "motion-safe:animate-fade-in")}>
            {SECTION_LEDES[section]}
          </span>
        }
      />
      <AnimatePresence mode="wait" initial={false} onExitComplete={resetScroll}>
        <motion.div
          key={section}
          variants={reduce ? PANE_REDUCED : PANE}
          initial="hidden"
          animate="visible"
          exit="exit"
          // The groups arrive one after another (the editorial kit's stagger,
          // nothing under reduced motion): each section's root is a fragment
          // of SettingsGroups, so they are this wrapper's children.
          className="ed-stagger min-w-0"
        >
          <Section />
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
