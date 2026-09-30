"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { CodeScene } from "./code";
import { MotionScene } from "./motion";
import { CrewScene, HomeScene, MenusScene, ThreadScene } from "./scenes";
import { SystemScene } from "./system";
import { INSTRUMENT_TOKENS_CSS, type SceneId } from "./tokens";

/*
 * The stage: one scene filling the viewport, inside the Instrument scope.
 * `theme` pins light or dark; without it the scope follows the OS. The
 * scope sits on this element (not <html>), and every floating surface is
 * rendered inside it, so nothing depends on the app's own theme class.
 */
export function InstrumentStage({
  scene,
  theme,
  fontClass,
  full,
  view,
  moment,
  rm,
}: {
  scene: SceneId;
  theme: "light" | "dark" | "system";
  fontClass: string;
  full: boolean;
  view?: string;
  moment?: string;
  rm: boolean;
}) {
  // Paint the page behind the scope in the scope's own chassis, so overscroll never shows the app's paper.
  React.useLayoutEffect(() => {
    const html = document.documentElement;
    const prev = html.style.background;
    html.style.background = theme === "dark" ? "#0C0C0D" : theme === "light" ? "#F3F3F4" : "";
    return () => {
      html.style.background = prev;
    };
  }, [theme]);

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: INSTRUMENT_TOKENS_CSS }} />
      <div
        data-instrument=""
        data-theme={theme}
        data-rm={rm ? "" : undefined}
        className={cn(fontClass, "min-h-dvh")}
      >
        {scene === "home" && <HomeScene />}
        {scene === "thread" && <ThreadScene full={full} />}
        {scene === "menus" && <MenusScene />}
        {scene === "crew" && <CrewScene />}
        {scene === "code" && <CodeScene view={view === "session" ? "session" : "start"} />}
        {scene === "system" && <SystemScene />}
        {scene === "motion" && <MotionScene moment={moment} />}
      </div>
    </>
  );
}
