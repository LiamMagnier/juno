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

type Surface = "chat" | "work";

const ROUTE: Record<Surface, string> = {
  chat: "/chat",
  work: "/work",
};

export function ChatWorkSwitcher({ className }: { className?: string }) {
  const router = useRouter();
  const pathname = usePathname();

  // `/work` and everything under it is Work; anything else this renders over is
  // Chat. Derived from the route rather than held in state, so a back button, a
  // deep link and a click all agree without anything having to synchronise.
  const value: Surface = pathname?.startsWith("/work") ? "work" : "chat";

  const go = React.useCallback(
    (next: Surface) => {
      if (next === value) return;
      router.push(ROUTE[next]);
      // NO `juno:new-chat` HERE, unlike the sidebar's Home button. The sidebar
      // fires it because its push can be a no-op — it pushes /chat from /chat,
      // which does not remount, so ChatView has to be told to clear itself. This
      // control cannot reach that case: the guard above means the route always
      // changes, so the event was dispatched from /work with no ChatView mounted
      // to hear it, and the fresh one that mounts a tick later starts clean
      // anyway. It was a listener-less dispatch pretending to be a reset.
    },
    [router, value],
  );

  /**
   * Incognito puts this control out of reach: an incognito chat is not saved,
   * and navigating to Work would discard it with no warning.
   *
   * It is a MIRROR of ChatView's own `privateMode`, kept over an event rather
   * than in shared state because this control lives in the shell and that state
   * lives in the page. Two consequences the first version got wrong:
   *
   * 1. The mirror has to be corrected when the chat goes away. ChatView
   *    dispatches `false` as it unmounts (see its private-mode effect) —
   *    without that, leaving an incognito chat through the sidebar left this
   *    control dimmed and unclickable on /work for the rest of the session,
   *    with the one route that could reset it reachable only by the sidebar.
   * 2. `pointer-events-none` is not "unavailable", it is "unavailable to a
   *    mouse". The segments stayed focusable and the radiogroup's own arrow
   *    keys still fired `onChange`, so a keyboard user could navigate away
   *    from an incognito chat through a control that looked switched off.
   *    `inert` is the whole answer — pointer, keyboard and the a11y tree — and
   *    it is what the disclosure panels in this codebase already use.
   */
  const [incognito, setIncognito] = React.useState(false);
  React.useEffect(() => {
    const handleIncognito = (event: Event) => setIncognito((event as CustomEvent<boolean>).detail);
    window.addEventListener("juno:incognito", handleIncognito);
    return () => window.removeEventListener("juno:incognito", handleIncognito);
  }, []);

  return (
    <div
      inert={incognito}
      className={cn("flex justify-center transition-opacity duration-fast", className, incognito && "opacity-50")}
    >
      <SegmentedControl<Surface>
        value={value}
        onChange={go}
        ariaLabel="Chat or Work"
        // Tighter than the sidebar's: this one floats over content with no
        // panel behind it, so it earns its size from the two words in it rather
        // than from a column width it has to fill.
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
