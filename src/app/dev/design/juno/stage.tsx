"use client";

import * as React from "react";
import { MotionPref } from "./motion";
import { HomeScene, MenusScene, ThreadScene } from "./scenes";
import { CrewScene, MemberScene } from "./crew-scenes";
import { CodeScene, CodeStartScene } from "./code";
import { LibraryScene } from "./library";
import { CustomizeScene } from "./customize";
import { CrewMarkLab, SystemScene } from "./system";
import { MotionScene } from "./motion-scene";
import { StatesScene } from "./states";
import { BrandScene } from "./brand-scene";
import type { SceneId } from "./scene-ids";


/**
 * Tooltips as a group (Revision 2): the first waits 600 ms; once one has
 * shown, moving to a neighbour shows its tooltip at once, until the pointer
 * has been off every tooltip trigger for 400 ms. One delegated pair of
 * pointer listeners on the stage; CSS reads the root's data-tip-warm.
 */
function useTooltipGroup(ref: React.RefObject<HTMLDivElement | null>) {
  React.useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let warmT = 0;
    let coolT = 0;
    const over = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest?.(".jtip")) return;
      window.clearTimeout(coolT);
      if (root.hasAttribute("data-tip-warm")) return;
      window.clearTimeout(warmT);
      warmT = window.setTimeout(() => root.setAttribute("data-tip-warm", ""), 600);
    };
    const out = (e: PointerEvent) => {
      const from = (e.target as Element | null)?.closest?.(".jtip");
      const to = (e.relatedTarget as Element | null)?.closest?.(".jtip");
      if (!from || to) return;
      window.clearTimeout(warmT);
      coolT = window.setTimeout(() => root.removeAttribute("data-tip-warm"), 400);
    };
    root.addEventListener("pointerover", over);
    root.addEventListener("pointerout", out);
    return () => {
      root.removeEventListener("pointerover", over);
      root.removeEventListener("pointerout", out);
      window.clearTimeout(warmT);
      window.clearTimeout(coolT);
    };
  }, [ref]);
}

/**
 * The capture harness's scene switch (dev only): window.__jnGo("scene=thread&theme=dark") re-mounts the
 * stage on another scene WITHOUT a server round trip, so a batch of stills or clips loads the page once.
 * Revision 2: on the shared, saturated dev server one server render took about a minute.
 */
function useCaptureSwitch(initial: { scene: SceneId; theme?: "light" | "dark"; params: Record<string, string> }) {
  const [view, setView] = React.useState({ ...initial, key: 0 });
  React.useEffect(() => {
    const w = window as unknown as { __jnGo?: (q: string) => void };
    w.__jnGo = (q: string) => {
      const params: Record<string, string> = {};
      new URLSearchParams(q).forEach((v, k) => (params[k] = v));
      const theme = params.theme === "dark" || params.theme === "light" ? params.theme : undefined;
      setView((v) => ({ scene: (params.scene as SceneId) ?? v.scene, theme, params, key: v.key + 1 }));
    };
    return () => {
      delete w.__jnGo;
    };
  }, []);
  return view;
}

export function JunoStage(props: {
  scene: SceneId;
  theme?: "light" | "dark";
  params: Record<string, string>;
  fontClass: string;
  fontOverride?: React.CSSProperties;
}) {
  const view = useCaptureSwitch({ scene: props.scene, theme: props.theme, params: props.params });
  return <Stage key={view.key} {...props} scene={view.scene} theme={view.theme} params={view.params} />;
}

function Stage({
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
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  useTooltipGroup(rootRef);
  return (
    <div
      ref={rootRef}
      className={`jn ${fontClass}`}
      data-theme={theme}
      data-rm={reduced ? "" : undefined}
      data-still={params.still === "1" ? "" : undefined}
      data-scene={scene}
      style={fontOverride}
    >
      <MotionPref reduced={reduced}>
        {scene === "home" ? <HomeScene
            focused={params.focus === "1"}
            panel={params.app}
            draft={params.draft === "1"}
            model={params.model === "1"}
            plus={params.plus === "1"}
            pop={params.pop === "account" || params.pop === "activity" ? params.pop : undefined}
          /> : null}
        {scene === "thread" ? <ThreadScene top={params.at === "top"} planOpen={params.plan === "1"} stage={params.stage} menu={params.menu === "1"} /> : null}
        {scene === "menus" ? <MenusScene /> : null}
        {scene === "crew" ? params.member && !params.flow ? <MemberScene id={params.member} top={params.at === "top"} /> : <CrewScene flow={params.flow} member={params.member} /> : null}
        {scene === "code" ? params.state === "start" ? <CodeStartScene /> : <CodeScene pane={params.pane === "changes" ? "changes" : "session"} /> : null}
        {scene === "library" ? <LibraryScene view={params.view === "list" ? "list" : "grid"} query={params.q ?? ""} /> : null}
        {scene === "customize" ? <CustomizeScene app={params.app} /> : null}
        {scene === "system" ? (
          params.lab === "cmark" ? (
            <CrewMarkLab zooms={params.zoom?.split(",").map(Number)} eyes={params.eye?.split(",").map(Number)} />
          ) : (
            <SystemScene />
          )
        ) : null}
        {scene === "motion" ? <MotionScene only={params.m} /> : null}
        {scene === "states" ? <StatesScene /> : null}
        {scene === "brand" ? <BrandScene /> : null}
      </MotionPref>
    </div>
  );
}
