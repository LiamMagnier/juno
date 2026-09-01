"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";

import { SegmentedControl } from "@/components/ui/segmented-control";
import { AppIcons } from "@/lib/app-icons";
import { cn } from "@/lib/utils";

/**
 * Chat ⇄ Work, above the conversation.
 *
 * Work used to be the third segment of the sidebar's mode toggle, sitting
 * between Home and Code as though the product had three halves. It does not.
 * Code is a different product — different sidebar, different lists, different
 * routes. Work is the SAME assistant, asked to go and do the thing rather than
 * to answer about it. Two things that differ by intent belong next to each
 * other; a thing that differs by product does not.
 *
 * Putting it here also fixes where the choice was being made. In the sidebar it
 * was a decision taken before you had written anything, in a panel that is
 * collapsed half the time and hidden entirely on a phone. Above the composer it
 * sits in the one place you are already looking while deciding what to ask for,
 * and it stays visible while you type.
 *
 * The control is the shared `SegmentedControl`, unchanged — same well, same
 * raised thumb, same gliding geometry and radiogroup keyboard contract as the
 * sidebar toggle it was split from. This is one idiom used twice, not a second
 * switcher that merely resembles the first.
 */

type Surface = "chat" | "work" | "code";

const ROUTE: Record<Surface, string> = {
  chat: "/chat",
  work: "/work",
  code: "/code",
};

export function ChatWorkSwitcher({ className }: { className?: string }) {
  const router = useRouter();
  const pathname = usePathname();

  // `/work` is Work, `/code` is Code, anything else is Chat.
  const value: Surface = pathname?.startsWith("/work")
    ? "work"
    : pathname?.startsWith("/code")
      ? "code"
      : "chat";

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
        ariaLabel="Chat, Work or Code"
        className="w-auto"
        optionClassName="gap-1.5 px-4 py-1.5 text-ui font-medium"
        options={[
          { value: "chat", label: "Chat", icon: <AppIcons.home className="size-3.5" /> },
          { value: "work", label: "Work", icon: <AppIcons.work className="size-3.5" /> },
          { value: "code", label: "Code", icon: <AppIcons.code className="size-3.5" /> },
        ]}
      />
    </div>
  );
}
