"use client";

import * as React from "react";
import { MotionPrefProvider } from "./motion-pref";
import { CodeScene, CodeStartScene } from "./code";
import { CrewScene } from "./crew";
import { SystemScene } from "./system";
import { HomeScene, MenusScene, ThreadScene } from "./scenes";

export type SceneId = "home" | "thread" | "menus" | "panel" | "crew" | "code" | "code-start" | "system" | "motion";

export function CanvasStage({
  scene,
  theme,
  reduced,
  params,
  fontClass,
}: {
  scene: SceneId;
  theme?: "light" | "dark";
  reduced: boolean;
  params: Record<string, string>;
  fontClass: string;
}) {
  return (
    <div className={`cv ${fontClass}`} data-theme={theme} data-rm={reduced ? "" : undefined}>
      <MotionPrefProvider reduced={reduced}>
        {scene === "home" ? <HomeScene focused={params.focus === "1"} /> : null}
        {scene === "panel" ? <HomeScene panel={params.app ?? "stripe"} focused /> : null}
        {scene === "thread" ? <ThreadScene top={params.at === "top"} planOpen={params.plan === "1"} /> : null}
        {scene === "menus" ? <MenusScene /> : null}
        {scene === "crew" ? <CrewScene /> : null}
        {scene === "code" ? <CodeScene /> : null}
        {scene === "code-start" ? <CodeStartScene /> : null}
        {scene === "system" ? <SystemScene /> : null}
      </MotionPrefProvider>
    </div>
  );
}
