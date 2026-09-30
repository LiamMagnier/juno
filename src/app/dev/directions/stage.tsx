"use client";

import * as React from "react";
import { AppProvider } from "@/components/app/app-provider";
import { AUTO_MODEL_ID } from "@/lib/auto-model";
import type { AppBootstrap } from "@/types/app";
import { cn } from "@/lib/utils";
import { CrewScene, HomeScene, MenusScene, ThreadScene } from "./scenes";
import { SystemScene } from "./system";
import { directionCss, type DirectionId, type SceneId } from "./tokens";

/* Only what the rendered components read (see /dev/transcript). */
const BOOTSTRAP = {
  user: { id: "dev", name: "Liam Magnier", email: null, image: null },
  settings: {
    theme: "system",
    accent: "coral",
    defaultModel: AUTO_MODEL_ID,
    personality: "default",
    customInstructions: "",
    responseLanguage: "auto",
    uiLocale: "en",
    memoryEnabled: true,
    memorySensitiveTopics: [],
    memoryBackgroundLearning: false,
    backgroundProviderMode: "same_provider",
    voiceId: null,
    favoriteModels: [],
    emailBudgetAlerts: false,
    emailWeeklyDigest: false,
  },
  quota: { plan: "PRO", used: 0, limit: null, remaining: null },
  spend: {},
  conversations: [],
  folders: [],
  features: {
    billing: false,
    purchasablePlans: [],
    purchasableAnnualPlans: [],
    serverStt: false,
    serverTts: false,
    ttsProvider: null,
    storage: true,
    webSearch: true,
    deepResearch: true,
    email: false,
    providers: ["anthropic", "openai", "google", "xai"],
    isOwner: false,
  },
} as unknown as AppBootstrap;

/** The generated token sheet for the given directions. */
export function DirectionStyles({ directions }: { directions: readonly DirectionId[] }) {
  return <style dangerouslySetInnerHTML={{ __html: directions.map(directionCss).join("\n") }} />;
}

/**
 * The scope: a wrapper carrying `data-direction` and the direction's font
 * variables. While a scene is mounted the same attribute and classes sit on
 * <html>, so anything Radix portals to <body> reads the same tokens.
 */
export function DirectionScope({
  direction,
  fontClass,
  mirror = false,
  className,
  children,
}: {
  direction: DirectionId;
  fontClass: string;
  /** Copy the scope onto <html> (one direction per page only). */
  mirror?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  React.useLayoutEffect(() => {
    if (!mirror) return;
    const html = document.documentElement;
    const classes = fontClass.split(/\s+/).filter(Boolean);
    html.dataset.direction = direction;
    html.classList.add(...classes);
    return () => {
      delete html.dataset.direction;
      html.classList.remove(...classes);
    };
  }, [direction, fontClass, mirror]);
  return (
    <div data-direction={direction} className={cn(fontClass, className)}>
      {children}
    </div>
  );
}

export function DirectionStage({ direction, scene, fontClass }: { direction: DirectionId; scene: SceneId; fontClass: string }) {
  return (
    <>
      <DirectionStyles directions={[direction]} />
      <DirectionScope direction={direction} fontClass={fontClass} mirror className="min-h-dvh">
        <AppProvider bootstrap={BOOTSTRAP}>
          {scene === "home" && <HomeScene direction={direction} />}
          {scene === "thread" && <ThreadScene direction={direction} />}
          {scene === "menus" && <MenusScene direction={direction} />}
          {scene === "crew" && <CrewScene direction={direction} />}
          {scene === "system" && <SystemScene direction={direction} />}
        </AppProvider>
      </DirectionScope>
    </>
  );
}
