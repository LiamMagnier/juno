"use client";

import * as React from "react";
import { User, CreditCard, Palette, MessageSquare, NotebookPen } from "lucide-react";
import { ActionIcons, AppIcons } from "@/lib/app-icons";
import { Dialog, DialogCloseButton, DialogContent, DialogTitle } from "@/components/ui/dialog";
import SettingsPage from "@/app/(app)/settings/page";
import MemoryPage from "@/app/(app)/memory/page";
import ProfilePage from "@/app/(app)/profile/page";
import { cn } from "@/lib/utils";

type SettingsTab = "general" | "usage" | "appearance" | "chat" | "memory" | "account" | "danger";

export function SettingsModal() {
  const [open, setOpen] = React.useState(false);
  const [activeTab, setActiveTab] = React.useState<SettingsTab>("general");

  React.useEffect(() => {
    const handleOpen = (e: Event) => {
      const customEvent = e as CustomEvent<string>;
      const detail = customEvent.detail;
      if (detail === "memory") setActiveTab("memory");
      else if (detail === "usage" || detail === "billing") setActiveTab("usage");
      else if (detail === "appearance" || detail === "theme") setActiveTab("appearance");
      else if (detail === "chat" || detail === "models") setActiveTab("chat");
      else if (detail === "profile") setActiveTab("general");
      else if (detail === "account" || detail === "permissions") setActiveTab("account");
      else if (detail === "danger") setActiveTab("danger");
      else setActiveTab("general");
      setOpen(true);
    };
    window.addEventListener("juno:settings", handleOpen);
    return () => window.removeEventListener("juno:settings", handleOpen);
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="flex h-[min(88dvh,760px)] max-w-4xl flex-col gap-0 overflow-hidden rounded-3xl border border-border/80 bg-background p-0 sm:p-0 text-foreground shadow-2xl backdrop-blur-2xl md:flex-row"
        hideClose
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogCloseButton className="z-10 bg-transparent text-muted-foreground hover:text-foreground" />

        {/* Sidebar Navigation */}
        <aside className="w-full shrink-0 border-b border-border/60 bg-muted/35 p-3.5 md:w-52 md:border-b-0 md:border-r">
          <div className="flex items-center justify-between px-2 py-2 md:mb-3 md:px-2.5">
            <h2 className="text-base font-semibold tracking-tight text-foreground">Settings</h2>
          </div>
          <nav aria-label="Settings sections" className="flex gap-1 overflow-x-auto pb-0.5 md:flex-col md:overflow-visible md:pb-0">
            <TabButton
              active={activeTab === "general"}
              onClick={() => setActiveTab("general")}
              icon={<User className="size-4" />}
              label="Profile"
            />
            <TabButton
              active={activeTab === "usage"}
              onClick={() => setActiveTab("usage")}
              icon={<CreditCard className="size-4" />}
              label="Plan & Usage"
            />
            <TabButton
              active={activeTab === "appearance"}
              onClick={() => setActiveTab("appearance")}
              icon={<Palette className="size-4" />}
              label="Appearance"
            />
            <TabButton
              active={activeTab === "chat"}
              onClick={() => setActiveTab("chat")}
              icon={<MessageSquare className="size-4" />}
              label="Chat & Models"
            />
            <TabButton
              active={activeTab === "memory"}
              onClick={() => setActiveTab("memory")}
              icon={<NotebookPen className="size-4" />}
              label="Memory"
            />
            {/* The plug every other surface draws for connections, not the
                ShieldCheck this row used to carry: a badged shield says
                "verified", which is neither what the row navigates to nor what
                it claims, and it was the only place in the product where
                Connections wore a mark other than AppIcons.connections. */}
            <TabButton
              active={activeTab === "account"}
              onClick={() => setActiveTab("account")}
              icon={<AppIcons.connections className="size-4" />}
              label="Connected Apps"
            />
            <TabButton
              active={activeTab === "danger"}
              onClick={() => setActiveTab("danger")}
              icon={<ActionIcons.delete className="size-4 text-muted-foreground group-hover:text-destructive" />}
              label="Data & Privacy"
            />
          </nav>
        </aside>

        {/* Main Content Area */}
        <div className="relative min-h-0 flex-1 overflow-y-auto bg-background">
          <div className="mx-auto w-full max-w-2xl px-6 pb-10 pt-6 sm:px-8 md:pt-8">
            {activeTab === "general" && <ProfilePage.Content hideHeader />}
            {activeTab === "usage" && <SettingsPage.Content hideHeader filterGroup="usage" />}
            {activeTab === "appearance" && <SettingsPage.Content hideHeader filterGroup="appearance" />}
            {activeTab === "chat" && <SettingsPage.Content hideHeader filterGroup="chat" />}
            {activeTab === "memory" && <MemoryPage.Content hideHeader />}
            {activeTab === "account" && <SettingsPage.Content hideHeader filterGroup="account" />}
            {activeTab === "danger" && <SettingsPage.Content hideHeader filterGroup="danger" />}
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
        "group flex min-h-8 min-w-max items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium",
        "transition-colors duration-fast ease-out-soft",
        active ? "bg-accent text-foreground font-semibold shadow-xs" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
        "md:w-full"
      )}
    >
      <span className={cn("shrink-0", active ? "text-foreground" : "text-muted-foreground group-hover:text-foreground")}>
        {icon}
      </span>
      {label}
    </button>
  );
}
