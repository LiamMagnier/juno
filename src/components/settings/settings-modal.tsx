"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { Dialog, DialogCloseButton, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { SettingsRail } from "@/components/settings/settings-rail";
import { SettingsPane } from "@/components/settings/settings-pane";
import {
  DEFAULT_SETTINGS_SECTION,
  resolveSettingsSection,
  type SettingsSectionId,
} from "@/components/settings/settings-sections";
import { applyFontSize, readFontSize } from "@/components/settings/font-size";

/**
 * Settings, the modal. Mounted once by the app layout and opened from
 * anywhere by the `juno:settings` window event (detail = section id or an
 * alias) or by ⌘, / Ctrl+,.
 *
 * Left: the rail on an inset well. Right: the section, on the modal's own
 * floating surface. The `/settings` route renders the same rail and pane in
 * a page frame — this file owns nothing but the frame around them.
 */
export function SettingsModal() {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);
  const [section, setSection] = React.useState<SettingsSectionId>(DEFAULT_SETTINGS_SECTION);

  // Text size is a device preference; apply it on first mount so the whole
  // app scales before anything else paints.
  React.useEffect(() => applyFontSize(readFontSize()), []);

  React.useEffect(() => {
    const handleOpen = (e: Event) => {
      setSection(resolveSettingsSection((e as CustomEvent<string>).detail));
      setOpen(true);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== "," || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      e.preventDefault();
      setOpen((o) => !o);
    };
    window.addEventListener("juno:settings", handleOpen);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("juno:settings", handleOpen);
      window.removeEventListener("keydown", handleKey);
    };
  }, []);

  // On the settings page itself the page IS the settings; a modal over it
  // would be the same content twice.
  React.useEffect(() => {
    if (pathname?.startsWith("/settings")) setOpen(false);
  }, [pathname]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="flex h-[min(88dvh,760px)] w-[calc(100%-2rem)] max-w-4xl flex-col gap-0 overflow-hidden p-0 sm:p-0 md:flex-row"
        hideClose
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogCloseButton className="z-10" />

        <aside className="shrink-0 border-b border-border/60 p-3 md:w-56 md:border-b-0 md:border-r md:p-4">
          <div className="mb-3 hidden items-center justify-between px-1 md:flex">
            <h2 className="text-heading">Settings</h2>
            <Kbd aria-hidden="true">⌘,</Kbd>
          </div>
          <SettingsRail active={section} onSelect={setSection} />
        </aside>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-2xl px-5 pb-10 pt-12 sm:px-8 md:pt-7">
            <SettingsPane section={section} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
