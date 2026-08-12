"use client";

import * as React from "react";
import { User, Settings, NotebookPen } from "lucide-react";
import { Dialog, DialogCloseButton, DialogContent, DialogTitle } from "@/components/ui/dialog";
import SettingsPage from "@/app/(app)/settings/page";
import MemoryPage from "@/app/(app)/memory/page";
import ProfilePage from "@/app/(app)/profile/page";
import { cn } from "@/lib/utils";

type SettingsTab = "general" | "memory" | "profile";

export function SettingsModal() {
  const [open, setOpen] = React.useState(false);
  const [activeTab, setActiveTab] = React.useState<SettingsTab>("general");

  React.useEffect(() => {
    const handleOpen = (e: Event) => {
      const customEvent = e as CustomEvent<SettingsTab>;
      setActiveTab(customEvent.detail || "general");
      setOpen(true);
    };
    window.addEventListener("juno:settings", handleOpen);
    return () => window.removeEventListener("juno:settings", handleOpen);
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="flex h-[min(84dvh,780px)] max-w-5xl flex-col gap-0 overflow-hidden bg-popover p-0 md:flex-row"
        hideClose
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogCloseButton className="z-10 bg-popover" />
        {/*
         * `bg-secondary`, NOT `bg-sidebar`. Elevation is relative, and this rail
         * is not on the page — it is inside a dialog that floats at `--popover`.
         * `--sidebar` is defined against the PAGE ground, where it is flush black
         * and separates by a border; painted onto a 13%-lightness dialog it is 13
         * points darker than its own parent, which reads as a hole punched
         * through the panel rather than a rail attached to it.
         *
         * `--secondary` is one rung below `--popover`, so the rail is recessed
         * from the pane beside it by the same single step the ladder uses
         * everywhere else. The rule this is an instance of: a token named for a
         * surface (`sidebar`, `background`) is only correct on that surface;
         * inside a floating layer, pick the rung relative to the layer.
         */}
        <aside className="w-full shrink-0 border-b border-border/70 bg-secondary p-3 md:w-56 md:border-b-0 md:border-r">
          <div className="flex items-center justify-between px-2 py-2 md:mb-2 md:px-3">
            <h2 className="text-lg font-semibold tracking-tight text-foreground">Settings</h2>
          </div>
          <nav aria-label="Settings sections" className="flex gap-1 overflow-x-auto pb-0.5 md:flex-col md:overflow-visible md:pb-0">
            <TabButton
              active={activeTab === "general"}
              onClick={() => setActiveTab("general")}
              icon={<Settings className="size-4" />}
              label="General"
            />
            <TabButton
              active={activeTab === "memory"}
              onClick={() => setActiveTab("memory")}
              icon={<NotebookPen className="size-4" />}
              label="Memory"
            />
            <TabButton
              active={activeTab === "profile"}
              onClick={() => setActiveTab("profile")}
              icon={<User className="size-4" />}
              label="Profile"
            />
          </nav>
        </aside>

        {/* `bg-popover`, matching the shell. This pane was `bg-background` — the
            LOWEST rung in the ladder painted on top of the highest elevation
            layer — so on true black the modal body read as a hole cut through
            the dialog it belongs to. The split is carried by the aside's
            bg-secondary + border-r, which is what that border is for. (This
            line said `bg-sidebar` — the class the block above removed, and for
            the reason it explains. A comment naming a class that is no longer
            there is the next person's wrong turn.) */}
        <div className="relative min-h-0 flex-1 overflow-y-auto bg-popover">
          <div className="mx-auto w-full max-w-3xl px-5 pb-10 pt-6 sm:px-8 md:px-10 md:pt-12">
            {activeTab === "general" && <SettingsPage.Content hideHeader />}
            {activeTab === "memory" && <MemoryPage.Content hideHeader />}
            {activeTab === "profile" && <ProfilePage.Content hideHeader />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      type="button"
      aria-current={active ? "page" : undefined}
      className={cn(
        // min-h-9 so the rail's targets are one height whether or not a label
        // wraps, and the easing declared rather than left on the browser default.
        "flex min-h-9 min-w-max items-center gap-2.5 rounded-control px-3 py-2 text-left text-sm font-medium",
        "transition-colors duration-fast ease-out-soft",
        active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
        "md:w-full"
      )}
    >
      <span className={cn("shrink-0", active ? "text-foreground" : "text-muted-foreground")}>
        {icon}
      </span>
      {label}
    </button>
  );
}
