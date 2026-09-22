"use client";

import { Button } from "@/components/ui/button";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { MemoryManager } from "@/components/memory/memory-manager";
import { openSettings } from "@/components/settings/settings-sections";

export default function MemoryPage() {
  return (
    <AppPage measure="reading">
      <AppPageHeader
        heading="What Juno remembers"
        lede="Built from your conversations, kept by subject, and yours to correct."
        actions={
          // The switches that decide what Juno is ALLOWED to learn live in
          // settings; the page is what it has learned. They are two different
          // questions, so the page links to the other one rather than growing a
          // second copy of it that can disagree.
          <Button variant="outline" size="sm" onClick={() => openSettings("memory")}>
            Memory settings
          </Button>
        }
      />
      <MemoryManager />
    </AppPage>
  );
}
