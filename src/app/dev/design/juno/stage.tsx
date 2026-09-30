"use client";

import * as React from "react";
import { MotionPref } from "./motion";
import { HomeScene, MenusScene, ThreadScene } from "./scenes";
import { CrewScene, MemberScene } from "./crew-scenes";
import { CodeScene, CodeStartScene } from "./code";
import { LibraryScene } from "./library";
import { CustomizeScene } from "./customize";
import { SystemScene } from "./system";
import { MotionScene } from "./motion-scene";
import type { SceneId } from "./scene-ids";


export function JunoStage({
  scene,
  theme,
  params,
  fontClass,
  fontOverride,
}: {
  scene: SceneId;
  theme?: "light" | "dark";
  params: Record<string, string>;
  fontClass: string;
  fontOverride?: React.CSSProperties;
}) {
  const reduced = params.rm === "1";
  return (
    <div
      className={`jn ${fontClass}`}
      data-theme={theme}
      data-rm={reduced ? "" : undefined}
      data-still={params.still === "1" ? "" : undefined}
      data-scene={scene}
      style={fontOverride}
    >
      <MotionPref reduced={reduced}>
        {scene === "home" ? <HomeScene focused={params.focus === "1"} panel={params.app} empty={params.empty === "1"} /> : null}
        {scene === "thread" ? <ThreadScene top={params.at === "top"} planOpen={params.plan === "1"} stage={params.stage} menu={params.menu === "1"} /> : null}
        {scene === "menus" ? <MenusScene /> : null}
        {scene === "crew" ? params.member ? <MemberScene id={params.member} /> : <CrewScene /> : null}
        {scene === "code" ? params.state === "start" ? <CodeStartScene /> : <CodeScene /> : null}
        {scene === "library" ? <LibraryScene /> : null}
        {scene === "customize" ? <CustomizeScene app={params.app} /> : null}
        {scene === "system" ? <SystemScene /> : null}
        {scene === "motion" ? <MotionScene only={params.m} /> : null}
      </MotionPref>
    </div>
  );
}
