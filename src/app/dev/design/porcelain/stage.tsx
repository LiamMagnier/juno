"use client";

import * as React from "react";
import { MotionConfig } from "framer-motion";
import { CodeSessionScene, CodeStartScene, CrewScene, HomeScene, MenusScene, ThreadScene } from "./scenes";
import { SystemScene } from "./system";
import { MotionScene } from "./motion";
import type { SceneId } from "./scene-ids";


/**
 * The Porcelain root: tokens, faces and theme live on one element. Theme is
 * the `theme` param when given, otherwise the system's colour scheme.
 */
export function PorcelainStage({
  scene,
  theme,
  view,
  full,
  moment,
  fontClass,
}: {
  scene: SceneId;
  theme?: "light" | "dark";
  view?: string;
  full?: boolean;
  moment?: number;
  fontClass: string;
}) {
  const [resolved, setResolved] = React.useState<"light" | "dark">(theme ?? "light");
  React.useLayoutEffect(() => {
    if (theme) return setResolved(theme);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => setResolved(mq.matches ? "dark" : "light");
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);

  return (
    <MotionConfig reducedMotion="user">
      <div className={`pc ${fontClass}`} data-theme={resolved} data-full={full ? "" : undefined} data-scene={scene}>
        {scene === "home" && <HomeScene />}
        {scene === "thread" && <ThreadScene />}
        {scene === "menus" && <MenusScene />}
        {scene === "crew" && <CrewScene />}
        {scene === "code" && (view === "start" ? <CodeStartScene /> : <CodeSessionScene />)}
        {scene === "system" && <SystemScene />}
        {scene === "motion" && <MotionScene only={moment} />}
      </div>
    </MotionConfig>
  );
}
