/**
 * The crew renderer: one WebGLRenderer for every character on the page.
 *
 * Loaded lazily (face.tsx imports it with a dynamic import), so a page pays
 * for three.js only when it shows a character that no cached sprite covers.
 *
 *   ONE CONTEXT. A single offscreen WebGL canvas. Characters are drawn into
 *   regions of it with viewport and scissor and each region is copied into
 *   the face's own 2D canvas (or a cached image) in the same frame, so the
 *   page composites characters like any other image: they scroll with the
 *   compositor, sit under sheets and popovers, clip inside scrollers, and cost
 *   nothing while still.
 *
 *   SPRITES (28 px and under: sidebar rows, tokens, bylines, reactions, the
 *   editor's thumbnails). Rendered once per (config, state, size, pixel ratio,
 *   theme, facing) at twice the device resolution with fewer fur shells, then
 *   downsampled and cached in memory and (up to 48 px) in localStorage, so a
 *   returning visit shows every small face without loading three.js.
 *
 *   LIVE VIEWS (32 px and up: thread peek and header, roster, profile,
 *   editor). Rendered on demand only: a frame is drawn while a spring moves
 *   (a state change, the pointer's gaze, a blink, an arrival, a drag, a hop,
 *   a reaction) and the loop stops when everything has settled. Offscreen
 *   views (IntersectionObserver) and hidden tabs do no work at all. The
 *   sanctioned slow loops (thinking, working, paused breathing, the thread
 *   character's idle) draw at 30 fps.
 */

import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { avatarKey, formKey, type AvatarConfig } from "./avatar2";
import { Character, tuning } from "./character";
import { hashSeed } from "./identity";
import { Rig, restingPose, type CrewState, type Facing, type Pose } from "./rig";
import { prefersReduced, readStore, resolveTheme, spriteDpr, spriteKey, writeStore, type Theme } from "./sprite-store";

export type { Theme };

/* ——————————————————————————— Look ——————————————————————————— */

/** Studio light per theme. Dark is its own lighting (a cooler, stronger rim to hold the silhouette), not a darker copy. */
const LOOK = {
  light: { exposure: 1.0, env: 0.62, key: 2.3, keyColor: 0xfff6ee, rim: 1.2, rimColor: 0xffffff, fill: 0.35, shadow: 0.9 },
  dark: { exposure: 1.0, env: 0.5, key: 2.2, keyColor: 0xfff3ea, rim: 2.6, rimColor: 0xdde5ff, fill: 0.25, shadow: 1 },
} as const;

const FOV = 18;
const ELEVATION = 0.12;

/** How much of the frame the character fills: sprites are tight, live views leave room to hop. */
function fill(size: number, live: boolean) {
  if (!live) return size <= 20 ? 0.9 : size <= 28 ? 0.88 : 0.84;
  return size <= 64 ? 0.8 : 0.74;
}

/* ——————————————————————————— Views ——————————————————————————— */

export interface LiveOptions {
  cfg: AvatarConfig;
  state: CrewState;
  size: number;
  facing: Facing;
  /** State loops allowed (focused context). */
  loop: boolean;
  /** The thread character's idle (breathing, an occasional blink). */
  idle: boolean;
  /** Follow the pointer when it comes near. */
  gaze: boolean;
  /** Morph shape changes (the editor) and boing on every change. */
  morph?: boolean;
  /** Vertical framing offset, -1..1 of the frame (the peek sits the character lower). */
  offsetY?: number;
}

export interface LiveHandle {
  update(next: Partial<LiveOptions>): void;
  blink(): void;
  arrive(): void;
  hop(): void;
  happy(): void;
  boing(): void;
  level(l: number): void;
  drag(yaw: number, pitch: number): void;
  release(vYaw: number, vPitch: number): void;
  dispose(): void;
}

class LiveView {
  ctx: CanvasRenderingContext2D;
  model = new Character();
  rig: Rig;
  opts: LiveOptions;
  visible = false;
  seen = false;
  dirty = true;
  lastDraw = 0;
  pointerInside = false;
  alpha = 1;
  onFirst?: () => void;
  px: number;
  reduced: boolean;
  constructor(
    public canvas: HTMLCanvasElement,
    public ghost: HTMLCanvasElement | null,
    opts: LiveOptions,
    public dpr: number,
  ) {
    this.opts = opts;
    this.px = Math.round(opts.size * dpr);
    canvas.width = this.px;
    canvas.height = this.px;
    if (ghost) {
      ghost.width = this.px;
      ghost.height = this.px;
    }
    this.ctx = canvas.getContext("2d")!;
    this.reduced = prefersReduced(canvas);
    this.rig = new Rig(this.rigOptions());
    this.model.set(opts.cfg, opts.size);
  }
  rigOptions() {
    const o = this.opts;
    return {
      state: o.state,
      facing: o.facing,
      small: o.size <= 28,
      reduced: this.reduced,
      loop: o.loop && o.size >= 32,
      idle: o.idle && o.size >= 64,
      headphones: o.cfg.accessories.some((a) => a.id === "headphones"),
      googly: o.cfg.eyes.style === "googly",
      seed: hashSeed(o.cfg.seed) % 10007,
    };
  }
  theme(): Theme {
    return resolveTheme(this.canvas);
  }
  /** Copy what is on screen into the ghost and fade it out: the reduced-motion (and material-swap) transition. */
  crossfade(ms: number) {
    const g = this.ghost;
    if (!g || !this.seen) return;
    const gctx = g.getContext("2d");
    if (!gctx) return;
    gctx.clearRect(0, 0, g.width, g.height);
    gctx.drawImage(this.canvas, 0, 0);
    g.style.transition = "none";
    g.style.opacity = "1";
    void g.offsetWidth;
    g.style.transition = `opacity ${ms}ms cubic-bezier(0.2, 0, 0, 1)`;
    g.style.opacity = "0";
  }
}

/* ——————————————————————————— Engine ——————————————————————————— */

interface SpriteRequest {
  key: string;
  cfg: AvatarConfig;
  state: CrewState;
  size: number;
  dpr: number;
  theme: Theme;
  facing: Facing;
  resolve: (url: string) => void;
  reject: (e: unknown) => void;
}

export interface EngineStats {
  /** Animation frames that ran (each draws zero or more views). */
  frames: number;
  /** View renders (one per character per frame). */
  renders: number;
  sprites: number;
  lastFrameMs: number;
  /** Frames in the last second that did GPU work. */
  busyFrames: number;
}

class Engine {
  ok = false;
  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 60);
  private key = new THREE.DirectionalLight(0xffffff, 1.7);
  private rim = new THREE.DirectionalLight(0xffffff, 0.8);
  private fillL = new THREE.DirectionalLight(0xffffff, 0.3);
  private slot = new THREE.Group();
  private W = 1024;
  private H = 512;
  private views = new Set<LiveView>();
  private raf = 0;
  private last = 0;
  private io: IntersectionObserver | null = null;
  private byCanvas = new Map<Element, LiveView>();
  private sprites: SpriteRequest[] = [];
  private spriteCache = new Map<string, Promise<string>>();
  private spriteModel = new Character();
  private pointer: { x: number; y: number } | null = null;
  stats: EngineStats = { frames: 0, renders: 0, sprites: 0, lastFrameMs: 0, busyFrames: 0 };

  constructor() {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = this.W;
      canvas.height = this.H;
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: "low-power" });
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(this.W, this.H, false);
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.NeutralToneMapping;
      this.renderer.setScissorTest(true);
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const room = new RoomEnvironment();
      this.scene.environment = pmrem.fromScene(room, 0.04).texture;
      room.dispose?.();
      pmrem.dispose();
      this.key.position.set(-3.0, 4.4, 3.4);
      this.rim.position.set(3.2, 2.6, -3.6);
      this.fillL.position.set(3.5, 0.5, 2.5);
      this.scene.add(this.key, this.rim, this.fillL, this.slot);
      this.ok = true;
    } catch {
      this.ok = false;
      return;
    }
    this.io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const v = this.byCanvas.get(e.target);
          if (!v) continue;
          v.visible = e.isIntersecting;
          if (v.visible) {
            v.dirty = true;
            // A single blink the first time the character comes into view.
            if (!v.seen) v.rig.blink(performance.now() + 420);
            this.schedule();
          }
        }
      },
      { rootMargin: "64px" },
    );
    window.addEventListener("pointermove", this.onPointer, { passive: true });
    document.addEventListener("pointerleave", this.onLeave);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        for (const v of this.views) v.dirty = true;
        this.last = 0;
        this.schedule();
      }
    });
    const mq = matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", () => this.invalidateTheme());
    const rm = matchMedia("(prefers-reduced-motion: reduce)");
    rm.addEventListener("change", () => this.invalidateTheme());
    new MutationObserver(() => this.invalidateTheme()).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ["data-theme", "data-rm"] });
    setInterval(() => {
      this.stats.busyFrames = this.busyCount;
      this.busyCount = 0;
    }, 1000);
  }
  private busyCount = 0;

  private invalidateTheme() {
    const now = performance.now();
    for (const v of this.views) {
      v.dirty = true;
      const r = prefersReduced(v.canvas);
      if (r !== v.reduced) {
        v.reduced = r;
        v.rig.update(v.rigOptions(), now);
      }
    }
    this.schedule();
    window.dispatchEvent(new Event("jcf-theme"));
  }

  /* ———— pointer gaze ———— */

  private onPointer = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    this.pointer = { x: e.clientX, y: e.clientY };
    this.updateGaze();
  };
  private onLeave = () => {
    this.pointer = null;
    this.updateGaze();
  };
  private updateGaze() {
    const now = performance.now();
    let any = false;
    for (const v of this.views) {
      if (!v.visible || !v.opts.gaze || v.opts.size < 28) continue;
      const p = this.pointer;
      if (!p) {
        v.rig.gaze(0, 0);
        v.pointerInside = false;
        any = true;
        continue;
      }
      const r = v.canvas.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height * 0.45;
      const dx = Math.max(r.left - p.x, 0, p.x - r.right);
      const dy = Math.max(r.top - p.y, 0, p.y - r.bottom);
      const near = Math.hypot(dx, dy) <= 160;
      const inside = dx === 0 && dy === 0;
      if (inside && !v.pointerInside) v.rig.blink(now);
      v.pointerInside = inside;
      const reach = Math.max(120, r.width * 1.3);
      if (near) v.rig.gaze((p.x - cx) / reach, (p.y - cy) / reach);
      else v.rig.gaze(0, 0);
      any = true;
    }
    if (any) this.schedule();
  }

  /* ———— live views ———— */

  mount(canvas: HTMLCanvasElement, ghost: HTMLCanvasElement | null, opts: LiveOptions, onFirst?: () => void): LiveHandle {
    const dpr = spriteDpr();
    const v = new LiveView(canvas, ghost, opts, dpr);
    v.onFirst = onFirst;
    v.model.onChange = () => {
      v.dirty = true;
      this.schedule();
    };
    this.views.add(v);
    this.byCanvas.set(canvas, v);
    this.io?.observe(canvas);
    this.schedule();
    const kick = () => {
      v.dirty = true;
      this.schedule();
    };
    return {
      update: (next) => {
        const now = performance.now();
        const prev = v.opts;
        v.opts = { ...prev, ...next };
        if (next.cfg && avatarKey(next.cfg) !== avatarKey(prev.cfg)) {
          const shapeChanged = formKey(next.cfg) !== formKey(prev.cfg);
          if (v.opts.morph && !v.reduced) {
            v.model.set(next.cfg, v.opts.size, shapeChanged ? now : undefined);
            v.rig.boing(now);
          } else {
            v.crossfade(v.reduced ? 160 : 200);
            v.model.set(next.cfg, v.opts.size);
          }
        }
        if (next.state && next.state !== prev.state && v.reduced) v.crossfade(160);
        v.rig.update(v.rigOptions(), now);
        kick();
      },
      blink: () => {
        if (v.rig.blink(performance.now())) this.schedule();
      },
      arrive: () => {
        v.rig.arrive(performance.now());
        kick();
      },
      hop: () => {
        v.rig.hop(performance.now());
        kick();
      },
      happy: () => {
        v.rig.happy(performance.now());
        kick();
      },
      boing: () => {
        v.rig.boing(performance.now());
        kick();
      },
      level: (l) => {
        v.rig.level(l);
        this.schedule();
      },
      drag: (yaw, pitch) => {
        v.rig.drag(yaw, pitch);
        this.schedule();
      },
      release: (vy, vp) => {
        v.rig.release(vy, vp);
        this.schedule();
      },
      dispose: () => {
        this.io?.unobserve(canvas);
        this.views.delete(v);
        this.byCanvas.delete(canvas);
        v.model.dispose();
      },
    };
  }

  private schedule() {
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
  }

  private tick = (now: number) => {
    this.raf = 0;
    const t0 = performance.now();
    const dt = Math.min(1 / 30, Math.max(0.001, (now - (this.last || now - 16)) / 1000));
    this.last = now;
    let again = false;
    const batch: LiveView[] = [];
    for (const v of this.views) {
      if (!v.visible) continue;
      const moving = v.rig.step(dt, now) || v.model.morphing(now);
      if (moving || v.rig.pending(now)) again = true;
      if (!moving && !v.dirty) continue;
      // Slow loops draw at 30 fps.
      if (!v.dirty && v.rig.loopOnly(now) && now - v.lastDraw < 31) continue;
      batch.push(v);
    }
    if (batch.length) this.renderLive(batch, now);
    if (this.sprites.length) this.renderSprites();
    this.stats.frames++;
    if (batch.length) this.busyCount++;
    this.stats.lastFrameMs = performance.now() - t0;
    if ((again || this.sprites.length) && !document.hidden) this.schedule();
    else this.last = 0;
  };

  private ensureSize(w: number, h: number) {
    if (w <= this.W && h <= this.H) return;
    this.W = Math.min(4096, Math.max(this.W, nextPow2(w)));
    this.H = Math.min(4096, Math.max(this.H, nextPow2(h)));
    this.renderer.setSize(this.W, this.H, false);
  }

  /** Shelf-pack square regions of the atlas. Returns [x, y] per size, or null where it overflows. */
  private pack(sizes: number[]): ([number, number] | null)[] {
    const out: ([number, number] | null)[] = [];
    const maxW = 2048;
    let x = 0;
    let y = 0;
    let row = 0;
    for (const s of sizes) {
      if (x + s > maxW) {
        x = 0;
        y += row;
        row = 0;
      }
      if (y + s > 2048) {
        out.push(null);
        continue;
      }
      out.push([x, y]);
      x += s;
      row = Math.max(row, s);
    }
    this.ensureSize(Math.min(maxW, Math.max(...sizes.map((s, i) => (out[i] ? out[i]![0] + s : 0)))), y + row);
    return out;
  }

  private draw(model: Character, theme: Theme, size: number, live: boolean, offsetY: number, x: number, y: number, px: number) {
    const look = LOOK[theme];
    this.renderer.toneMappingExposure = look.exposure;
    this.scene.environmentIntensity = look.env;
    this.key.intensity = look.key;
    this.key.color.setHex(look.keyColor);
    this.rim.intensity = look.rim;
    this.rim.color.setHex(look.rimColor);
    this.fillL.intensity = look.fill;
    model.shadowOpacity = look.shadow;
    // Frame the character by its resting bounds (not its pose), so states never rescale it.
    const b = model.bounds;
    const hgt = b.top - b.bottom;
    const ext = Math.max(hgt, b.half * 2);
    const f = fill(size, live);
    const dist = ext / f / 2 / Math.tan((FOV * Math.PI) / 360);
    const cy = b.bottom + hgt / 2 + (live ? ext * 0.05 : 0) + offsetY * ext;
    this.camera.position.set(0, cy + Math.sin(ELEVATION) * dist, Math.cos(ELEVATION) * dist);
    this.camera.lookAt(0, cy, 0);
    this.camera.updateMatrixWorld();
    this.slot.clear();
    this.slot.add(model.root);
    const gy = this.H - y - px;
    this.renderer.setViewport(x, gy, px, px);
    this.renderer.setScissor(x, gy, px, px);
    this.renderer.render(this.scene, this.camera);
    this.stats.renders++;
  }

  private renderLive(batch: LiveView[], now: number) {
    batch.sort((a, b) => b.px - a.px);
    const spots = this.pack(batch.map((v) => v.px));
    const pose = {} as Pose;
    batch.forEach((v, i) => {
      const spot = spots[i];
      if (!spot) return;
      v.rig.sample(now, pose);
      v.model.pose(pose, now);
      this.draw(v.model, v.theme(), v.opts.size, true, v.opts.offsetY ?? 0, spot[0], spot[1], v.px);
      v.alpha = pose.opacity;
    });
    const src = this.renderer.domElement;
    batch.forEach((v, i) => {
      const spot = spots[i];
      if (!spot) {
        v.dirty = true;
        return;
      }
      v.ctx.clearRect(0, 0, v.px, v.px);
      v.ctx.globalAlpha = v.alpha;
      v.ctx.drawImage(src, spot[0], spot[1], v.px, v.px, 0, 0, v.px, v.px);
      v.ctx.globalAlpha = 1;
      v.dirty = false;
      if (!v.seen) {
        v.seen = true;
        v.onFirst?.();
      }
      v.lastDraw = now;
    });
  }

  /* ———— sprites ———— */

  sprite(cfg: AvatarConfig, state: CrewState, size: number, theme: Theme, facing: Facing): Promise<string> {
    const dpr = spriteDpr();
    const key = spriteKey(cfg, state, size, dpr, theme, facing);
    const hit = this.spriteCache.get(key);
    if (hit) return hit;
    const stored = readStore(key);
    if (stored) {
      const p = Promise.resolve(stored);
      this.spriteCache.set(key, p);
      return p;
    }
    const p = new Promise<string>((resolve, reject) => {
      this.sprites.push({ key, cfg, state, size, dpr, theme, facing, resolve, reject });
      this.schedule();
    });
    this.spriteCache.set(key, p);
    if (this.spriteCache.size > 800) {
      const first = this.spriteCache.keys().next().value;
      if (first) this.spriteCache.delete(first);
    }
    return p;
  }

  private spriteBusy = false;
  private renderSprites() {
    if (this.spriteBusy) return;
    const batch = this.sprites.splice(0, 24);
    if (!batch.length) return;
    // Uploaded images load asynchronously and must be ready before a sprite is cached.
    const needsWait = batch.some((r) => r.cfg.pattern.kind === "image");
    if (needsWait) {
      this.spriteBusy = true;
      const m = new Character();
      Promise.all(
        batch.map((r) => {
          if (r.cfg.pattern.kind !== "image") return Promise.resolve();
          m.set(r.cfg, r.size);
          return m.ready;
        }),
      ).finally(() => {
        m.dispose();
        this.spriteBusy = false;
        this.drawSprites(batch);
        this.schedule();
      });
      return;
    }
    this.drawSprites(batch);
  }

  private drawSprites(batch: SpriteRequest[]) {
    // Small sprites are drawn at twice the device resolution and downsampled; large ones rely on MSAA.
    const sizes = batch.map((r) => Math.round(r.size * r.dpr * (r.size <= 72 ? 2 : 1)));
    const spots = this.pack(sizes);
    const pose = {} as Pose;
    batch.forEach((r, i) => {
      const spot = spots[i];
      if (!spot) {
        this.sprites.push(r);
        return;
      }
      this.spriteModel.set(r.cfg, r.size);
      Object.assign(pose, restingPose(r.state, r.facing, r.size <= 28));
      this.spriteModel.pose(pose, 0);
      this.draw(this.spriteModel, r.theme, r.size, false, 0, spot[0], spot[1], sizes[i]);
      const out = Math.round(r.size * r.dpr);
      const c = document.createElement("canvas");
      c.width = out;
      c.height = out;
      const ctx = c.getContext("2d")!;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(this.renderer.domElement, spot[0], spot[1], sizes[i], sizes[i], 0, 0, out, out);
      const url = c.toDataURL("image/png");
      if (r.size <= 48) writeStore(r.key, url);
      this.stats.sprites++;
      r.resolve(url);
    });
  }

  /** Warm the shader programs so the first live frame does not stall. */
  async warm(cfgs: AvatarConfig[]) {
    if (!this.ok) return;
    const models = cfgs.map((c) => {
      const m = new Character();
      m.set(c, 64);
      m.pose(restingPose("available"), 0);
      this.slot.add(m.root);
      return m;
    });
    try {
      await this.renderer.compileAsync(this.scene, this.camera);
    } catch {
      /* compile on first draw instead */
    }
    this.slot.clear();
    for (const m of models) m.dispose();
  }

  /** For the gallery's performance panel. */
  info() {
    const i = this.renderer.info;
    return { programs: i.programs?.length ?? 0, geometries: i.memory.geometries, textures: i.memory.textures, calls: i.render.calls, triangles: i.render.triangles, views: this.views.size };
  }
}

function nextPow2(n: number) {
  let p = 256;
  while (p < n) p *= 2;
  return p;
}

let engine: Engine | null = null;
export function getEngine(): Engine {
  if (!engine) {
    engine = new Engine();
    // Dev inspection (the gallery's performance panel and render scripts read it).
    if (process.env.NODE_ENV !== "production") (window as unknown as { __jcEngine?: Engine; __jcTHREE?: typeof THREE }).__jcEngine = engine;
    if (process.env.NODE_ENV !== "production") (window as unknown as { __jcTHREE?: typeof THREE }).__jcTHREE = THREE;
  }
  return engine;
}
export type { Engine };
export { tuning };
