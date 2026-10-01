/**
 * The sprite cache's persistent half (no three.js here, on purpose): a small
 * face that was drawn once is read back from localStorage on the next visit,
 * so sidebars, tokens and bylines never wait for the renderer to load.
 */

import { avatarKey, type AvatarConfig } from "./avatar2";
import type { CrewState, Facing } from "./rig";

export type Theme = "light" | "dark";

const STORE_PREFIX = "jcf2:";

export function spriteDpr() {
  return typeof window === "undefined" ? 2 : Math.min(2, window.devicePixelRatio || 1);
}

export function spriteKey(cfg: AvatarConfig, state: CrewState, size: number, dpr: number, theme: Theme, facing: Facing) {
  return `${avatarKey(cfg)}#${state}#${size}#${dpr}#${theme}#${facing}`;
}

export function readStore(key: string): string | null {
  try {
    return localStorage.getItem(STORE_PREFIX + key);
  } catch {
    return null;
  }
}

export function writeStore(key: string, url: string) {
  // Avatars wearing an uploaded image are not persisted: they can be large and personal.
  if (key.includes("|i.")) return;
  try {
    localStorage.setItem(STORE_PREFIX + key, url);
  } catch {
    try {
      // Full: drop our own entries and start again.
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k?.startsWith(STORE_PREFIX)) localStorage.removeItem(k);
      }
    } catch {
      /* storage unavailable */
    }
  }
}

/** A cached sprite, read without loading the renderer. */
export function storedSprite(cfg: AvatarConfig, state: CrewState, size: number, theme: Theme, facing: Facing): string | null {
  return readStore(spriteKey(cfg, state, size, spriteDpr(), theme, facing));
}

export function resolveTheme(el: Element): Theme {
  const t = el.closest("[data-theme]")?.getAttribute("data-theme");
  if (t === "dark" || t === "light") return t;
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function prefersReduced(el: Element): boolean {
  if (el.closest("[data-rm]")) return true;
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}
