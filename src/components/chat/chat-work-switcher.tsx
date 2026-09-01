"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";

import { SegmentedControl } from "@/components/ui/segmented-control";
import { AppIcons } from "@/lib/app-icons";
import { cn } from "@/lib/utils";

/**
 * Chat ⇄ Work, above the conversation.
 *
 * This control sits in the main content header and toggles between the two
 * surfaces that share the same assistant context: Chat (ask/answer) and Work
 * (delegate an outcome). Code is a different product — different sidebar,
 * different lists, different routes — and lives in the sidebar's own
 * Chat / Code switcher instead.
 */

type Surface = "chat" | "work";

const ROUTE: Record<Surface, string> = {
  chat: "/chat",
  work: "/work",
};

export function ChatWorkSwitcher({ className }: { className?: string }) {
  const router = useRouter();
  const pathname = usePathname();

  // `/work` is Work, anything else is Chat.
  const value: Surface = pathname?.startsWith("/work") ? "work" : "chat";

  const go = React.useCallback(
    (next: Surface) => {
      if (next === value) return;
      router.push(ROUTE[next]);
    },
    [router, value],
  );

  const [incognito, setIncognito] = React.useState(false);
  React.useEffect(() => {
    const handleIncognito = (event: Event) => setIncognito((event as CustomEvent<boolean>).detail);
    window.addEventListener("juno:incognito", handleIncognito);
    return () => window.removeEventListener("juno:incognito", handleIncognito);
  }, []);

  if (incognito) return null;

  return (
    <div
      className={cn("flex justify-center transition-opacity duration-fast", className)}
    >
      <SegmentedControl<Surface>
        value={value}
        onChange={go}
        ariaLabel="Chat or Work"
        className="w-auto"
        optionClassName="gap-1.5 px-4 py-1.5 text-ui font-medium"
        options={[
          { value: "chat", label: "Chat", icon: <AppIcons.home className="size-3.5" /> },
          { value: "work", label: "Work", icon: <AppIcons.work className="size-3.5" /> },
        ]}
      />
    </div>
  );
}
