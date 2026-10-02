"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft } from "@/components/ui/icons";
import { SettingsRail } from "@/components/settings/settings-rail";
import { SettingsPane } from "@/components/settings/settings-pane";
import { resolveSettingsSection, settingsHref } from "@/components/settings/settings-sections";
import { readReturnPath } from "@/components/settings/settings-modal-lazy";
import SettingsLoading from "./loading";

/**
 * Settings as a full window (ChatGPT's model, the owner's request): its own
 * left column — Back to app, search, the grouped sections — and the pane on
 * the ground, covering the app's sidebar rather than sharing the window with
 * it. Esc and ⌘, return to where the reader came from.
 */
function SettingsPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const section = resolveSettingsSection(searchParams.get("section"));
  const back = React.useCallback(() => router.push(readReturnPath()), [router]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      // Esc inside an open menu or a field belongs to that control.
      if (target?.closest("[role=menu],[role=listbox],[role=dialog],input,textarea,select")) return;
      back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [back]);

  return (
    <div className="fixed inset-0 z-modal flex flex-col bg-background text-foreground md:flex-row motion-safe:animate-fade-in">
      <aside className="@container/rail flex shrink-0 flex-col border-b border-border/60 bg-sidebar px-3 pb-3 pt-3 md:h-full md:w-64 md:border-b-0 md:border-r md:pt-4">
        <button
          type="button"
          onClick={back}
          className="group mb-3 flex h-9 items-center gap-2.5 rounded-control px-2.5 text-nav text-sidebar-foreground transition-colors duration-fast ease-out-soft hover:bg-sidebar-hover hover:text-foreground"
        >
          <ArrowLeft aria-hidden="true" className="size-4 transition-transform duration-fast ease-out-soft group-hover:-translate-x-0.5" />
          Back to app
        </button>
        <div className="min-h-0 flex-1 overflow-y-auto no-scrollbar">
          <SettingsRail active={section} hrefFor={settingsHref} />
        </div>
      </aside>
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {/* Keyed on the section: a new section rises in under a still rail,
            rather than its rows swapping in place. */}
        <div key={section} className="@container/pane mx-auto w-full max-w-[44rem] px-5 pb-16 pt-8 motion-safe:animate-rise-in sm:px-10 md:pt-12">
          <SettingsPane section={section} />
        </div>
      </main>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <React.Suspense fallback={<SettingsLoading />}>
      <SettingsPageContent />
    </React.Suspense>
  );
}
