"use client";

/**
 * CrewFace: a crew member as a small 3D character.
 *
 * The member's AvatarConfig (or, untouched, the one derived from its seed)
 * says who the character is: a body shape, a colour and pattern, a material
 * (plush fur, velvet, knit, felt, soft vinyl, ceramic), eyes, brows, cheeks,
 * a mouth and up to three accessories. Presence is carried by pose and
 * expression, and always also by words beside the face:
 *
 *   available   three-quarter, eyes ahead, at ease
 *   thinking    looking up and aside, one brow asking; looks around while focused
 *   working     forward and down, lids lowered; a focused bob while focused
 *   waiting     hops once to face you, eyes wide, brows up, then still
 *   paused      eyes closed, settled lower, colour quieted; breathes while focused
 *   offline     grey, still, half lidded, the fur flattened
 *
 * Sizes up to 28 px render as cached sprites (<img>, no WebGL context each);
 * larger faces are live views of the one shared renderer, drawn only while
 * something moves. Until a render is ready, and wherever WebGL is missing,
 * the flat silhouette stands in at the same framing.
 *
 * The face is decorative by default (rows print the name and the state
 * beside it); pass `label` where it stands alone.
 */

import * as React from "react";
import { avatarFromSeed, avatarKey, colorFrom, normalizeAvatar, type AvatarConfig } from "./avatar2";
import type { AvatarConfig as LegacyAvatarConfig } from "./avatar";
import type { CrewState, Facing } from "./rig";
import { Silhouette } from "./silhouette";
import { resolveTheme, storedSprite, type Theme } from "./sprite-store";
import type { LiveHandle } from "./engine";
import "./face.css";

export type { CrewState, Facing, LiveHandle };

export const CREW_STATE_LABEL: Record<CrewState, string> = {
  available: "Available",
  thinking: "Thinking",
  working: "Working",
  waiting: "Waiting for you",
  paused: "Paused",
  offline: "Offline",
};

export interface CrewMember {
  id: string;
  name: string;
  role?: string;
  /** A seed the character is derived from when there is no stored avatar. */
  seed: string;
  /** The stored look (v2; first-engine v1 looks are read too). Absent: derived from the seed. */
  avatar?: AvatarConfig | LegacyAvatarConfig;
  /** A colour chosen without a full avatar (a palette id, a hex, or a first-engine family). */
  family?: string;
}

export interface CrewFaceProps {
  member: CrewMember;
  state?: CrewState;
  size?: number;
  className?: string;
  /**
   * Motion on (gaze, event blinks, state changes). Off for faces that are
   * pictures of a choice. Reduced motion always removes movement.
   */
  live?: boolean;
  /** Play the arrival (a new member, the first time it is shown). */
  arrive?: boolean;
  /** Which way the three-quarter view faces at rest. Rows face their text. */
  facing?: Facing;
  /** Give the face an accessible name ("Mira, waiting for you"). */
  label?: boolean | string;
  /** The focused context (the open thread, the roster card being viewed): allows the state loops. */
  focused?: boolean;
  /** The large character in the member's own thread: allows the idle (breathing, an occasional blink). */
  idle?: boolean;
  /** Follow the pointer when it comes near (faces of 28 px and up). Defaults to `live`. */
  gaze?: boolean;
  /** Morph shape changes and boing on every change (the avatar editor). */
  morph?: boolean;
  /** Voice level 0..1: the character talks (voice mode). */
  level?: number;
  /** Increment to play the happy reaction (thanked). */
  cheer?: number;
  /** Increment to play the waiting hop again. */
  hop?: number;
  /** Frame the character lower (-) or higher (+), as a fraction of the frame (the thread peek). */
  offsetY?: number;
  /** Force a live render at any size. */
  forceLive?: boolean;
  /** Receive the live handle (blink on typing, drag in the editor). */
  onHandle?: (h: LiveHandle | null) => void;
}

let enginePromise: Promise<typeof import("./engine")> | null = null;
/** three.js arrives in its own chunk, the first time a face needs it. */
export function loadEngine() {
  enginePromise ??= import("./engine");
  return enginePromise;
}

/** The config a member renders with: its stored avatar, else its seed's. */
export function avatarOf(member: CrewMember): AvatarConfig {
  return member.avatar ? normalizeAvatar(member.avatar, member.seed) : avatarFromSeed(member.seed, colorFrom(member.family));
}

/** The config a member renders with, memoised by its key. */
export function useAvatar(member: CrewMember): AvatarConfig {
  const cfg = avatarOf(member);
  const key = avatarKey(cfg);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return React.useMemo(() => cfg, [key]);
}

function useTheme(ref: React.RefObject<Element | null>): Theme | null {
  const [theme, setTheme] = React.useState<Theme | null>(null);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setTheme(resolveTheme(el));
    read();
    window.addEventListener("jcf-theme", read);
    const mq = matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", read);
    return () => {
      window.removeEventListener("jcf-theme", read);
      mq.removeEventListener("change", read);
    };
  }, [ref]);
  return theme;
}

export function CrewFace(props: CrewFaceProps) {
  const { member, state = "available", size = 20, forceLive } = props;
  const cfg = useAvatar(member);
  const name =
    typeof props.label === "string" ? props.label : props.label ? `${member.name}, ${CREW_STATE_LABEL[state].toLowerCase()}` : undefined;
  if ((size <= 28 || props.live === false) && !forceLive) return <SpriteFace {...props} cfg={cfg} name={name} state={state} size={size} />;
  return <LiveFace {...props} cfg={cfg} name={name} state={state} size={size} />;
}

type Inner = CrewFaceProps & { cfg: AvatarConfig; name?: string; state: CrewState; size: number };

/** A still character rendered once and cached (sizes up to 28 px, and pictures of a choice). */
export function SpriteFace({ cfg, state, size, facing = "right", className, name, arrive }: Inner) {
  const ref = React.useRef<HTMLSpanElement | null>(null);
  const theme = useTheme(ref);
  const [layers, setLayers] = React.useState<{ top: string | null; under: string | null }>({ top: null, under: null });
  const key = avatarKey(cfg);

  React.useEffect(() => {
    if (!theme) return;
    let cancelled = false;
    const show = (url: string) => {
      if (cancelled) return;
      setLayers((l) => (l.top === url ? l : { top: url, under: l.top }));
    };
    const stored = storedSprite(cfg, state, size, theme, facing);
    if (stored) show(stored);
    else
      loadEngine()
        .then((m) => {
          const e = m.getEngine();
          return e.ok ? e.sprite(cfg, state, size, theme, facing) : null;
        })
        .then((url) => url && show(url))
        .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, state, size, theme, facing]);

  // Drop the layer underneath once the new one has faded in.
  React.useEffect(() => {
    if (!layers.under) return;
    const t = setTimeout(() => setLayers((l) => ({ top: l.top, under: null })), 220);
    return () => clearTimeout(t);
  }, [layers.under]);

  return (
    <span
      ref={ref}
      className={className ? `jcf ${className}` : "jcf"}
      style={{ width: size, height: size }}
      data-arrive={arrive ? "" : undefined}
      data-ready={layers.top ? "" : undefined}
      role={name ? "img" : undefined}
      aria-label={name}
      aria-hidden={name ? undefined : true}
    >
      <Silhouette cfg={cfg} size={size} state={state} />
      {layers.under ? <img className="jcf__img" src={layers.under} alt="" width={size} height={size} draggable={false} /> : null}
      {layers.top ? (
        <img key={layers.top} className="jcf__img" data-fade={layers.under ? "" : undefined} src={layers.top} alt="" width={size} height={size} draggable={false} />
      ) : null}
    </span>
  );
}

function LiveFace({ cfg, state, size, facing = "right", className, name, arrive, live = true, focused = false, idle = false, gaze, morph, level, cheer, hop, offsetY, onHandle }: Inner) {
  const canvas = React.useRef<HTMLCanvasElement | null>(null);
  const ghost = React.useRef<HTMLCanvasElement | null>(null);
  const handle = React.useRef<LiveHandle | null>(null);
  const [ready, setReady] = React.useState(false);
  const key = avatarKey(cfg);
  const opts = { cfg, state, size, facing, loop: live && focused, idle: live && idle, gaze: live && (gaze ?? true), morph: !!morph, offsetY: offsetY ?? 0 };
  const latest = React.useRef(opts);
  const onHandleRef = React.useRef(onHandle);
  React.useLayoutEffect(() => {
    latest.current = opts;
    onHandleRef.current = onHandle;
  });

  React.useEffect(() => {
    let disposed = false;
    const c = canvas.current;
    if (!c) return;
    loadEngine()
      .then((m) => {
        if (disposed) return;
        const e = m.getEngine();
        if (!e.ok) return;
        handle.current = e.mount(c, ghost.current, latest.current, () => setReady(true));
        if (arrive) handle.current.arrive();
        onHandleRef.current?.(handle.current);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      handle.current?.dispose();
      handle.current = null;
      onHandleRef.current?.(null);
    };
    // Remount only when the pixel size changes; everything else is an update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size]);

  React.useEffect(() => {
    handle.current?.update(latest.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, state, facing, opts.loop, opts.idle, opts.gaze, opts.morph, opts.offsetY]);

  React.useEffect(() => {
    handle.current?.level(level ?? 0);
  }, [level]);
  React.useEffect(() => {
    if (cheer) handle.current?.happy();
  }, [cheer]);
  React.useEffect(() => {
    if (hop) handle.current?.hop();
  }, [hop]);

  return (
    <span
      className={className ? `jcf jcf--live ${className}` : "jcf jcf--live"}
      style={{ width: size, height: size }}
      data-ready={ready ? "" : undefined}
      role={name ? "img" : undefined}
      aria-label={name}
      aria-hidden={name ? undefined : true}
    >
      <Silhouette cfg={cfg} size={size} state={state} />
      <canvas ref={canvas} className="jcf__canvas" style={{ width: size, height: size }} />
      <canvas ref={ghost} className="jcf__ghost" style={{ width: size, height: size }} />
    </span>
  );
}
