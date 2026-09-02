"use client";

import { AppIcons } from "@/lib/app-icons";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { MemoryManager } from "@/components/memory/memory-manager";

export default function MemoryPage() {
  return (
    <AppPage measure="reading">
      <AppPageHeader
        eyebrow="Memory"
        heading="What Juno remembers"
        icon={AppIcons.memory}
        lede="Distilled from your conversations and preferences to make answers relevant and personalized."
      />
      <MemoryManager />
    </AppPage>
  );
}
