/**
 * Per-device interface preferences: how this screen reads, moves and talks
 * back. Account-wide choices (theme, accent, language, memory) live in the
 * user's settings row; these are the ones that legitimately differ between a
 * laptop and a phone, so they stay in this browser, like Text size.
 *
 * Every preference that changes rendering is mirrored onto <html> as a
 * `data-*` attribute, written by UI_PREFS_BOOT_SCRIPT before first paint so a
 * reload never flashes the default and then jumps. CSS reads the attributes
 * (globals.css, "Interface preferences").
 */

import * as React from "react";

export type ChatFont = "default" | "system" | "serif" | "mono";
export type TranscriptWidth = "narrow" | "medium" | "wide";
export type MotionPref = "system" | "reduced";
export type SendKey = "enter" | "mod-enter";

export interface UiPrefs {
  chatFont: ChatFont;
  transcriptWidth: TranscriptWidth;
  motion: MotionPref;
  sendKey: SendKey;
  codeWrap: boolean;
  followUps: boolean;
  notifyOnReply: boolean;
  replySound: boolean;
}

export const UI_PREF_DEFAULTS: UiPrefs = {
  chatFont: "default",
  transcriptWidth: "medium",
  motion: "system",
  sendKey: "enter",
  codeWrap: false,
  followUps: true,
  notifyOnReply: false,
  replySound: false,
};

/** Preferences mirrored onto <html> (attribute name → pref key). */
const HTML_ATTRS = {
  "data-chat-font": "chatFont",
  "data-transcript-width": "transcriptWidth",
  "data-motion": "motion",
  "data-code-wrap": "codeWrap",
} as const satisfies Record<string, keyof UiPrefs>;

const KEY = "alevr:ui-prefs:v1";
const EVENT = "alevr:ui-prefs";

function sanitize(raw: unknown): UiPrefs {
  const out: UiPrefs = { ...UI_PREF_DEFAULTS };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  const pick = <K extends keyof UiPrefs>(key: K, allowed: readonly UiPrefs[K][]) => {
    if (allowed.includes(r[key] as UiPrefs[K])) out[key] = r[key] as UiPrefs[K];
  };
  pick("chatFont", ["default", "system", "serif", "mono"]);
  pick("transcriptWidth", ["narrow", "medium", "wide"]);
  pick("motion", ["system", "reduced"]);
  pick("sendKey", ["enter", "mod-enter"]);
  for (const key of ["codeWrap", "followUps", "notifyOnReply", "replySound"] as const) {
    if (typeof r[key] === "boolean") out[key] = r[key] as boolean;
  }
  return out;
}

let cache: UiPrefs | null = null;

export function readUiPrefs(): UiPrefs {
  if (typeof window === "undefined") return UI_PREF_DEFAULTS;
  if (cache) return cache;
  try {
    cache = sanitize(JSON.parse(window.localStorage.getItem(KEY) ?? "null"));
  } catch {
    cache = { ...UI_PREF_DEFAULTS };
  }
  return cache;
}

function applyToDocument(prefs: UiPrefs) {
  const root = document.documentElement;
  for (const [attr, key] of Object.entries(HTML_ATTRS)) {
    const value = prefs[key as keyof UiPrefs];
    const isDefault = value === UI_PREF_DEFAULTS[key as keyof UiPrefs];
    if (isDefault) root.removeAttribute(attr);
    else root.setAttribute(attr, String(value));
  }
}

export function writeUiPref<K extends keyof UiPrefs>(key: K, value: UiPrefs[K]) {
  const next = { ...readUiPrefs(), [key]: value };
  cache = next;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Private window or blocked storage: the choice lasts for this tab only.
  }
  applyToDocument(next);
  window.dispatchEvent(new CustomEvent(EVENT));
}

function subscribe(onChange: () => void) {
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    cache = null;
    applyToDocument(readUiPrefs());
    onChange();
  };
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

const serverPrefs = () => UI_PREF_DEFAULTS;

/** All preferences, live: re-renders when any changes, in this tab or another. */
export function useUiPrefs(): UiPrefs {
  return React.useSyncExternalStore(subscribe, readUiPrefs, serverPrefs);
}

export function useUiPref<K extends keyof UiPrefs>(key: K): [UiPrefs[K], (value: UiPrefs[K]) => void] {
  const prefs = useUiPrefs();
  const set = React.useCallback((value: UiPrefs[K]) => writeUiPref(key, value), [key]);
  return [prefs[key], set];
}

/** Non-React read for event handlers that must not re-render (the composer's Enter). */
export function uiPref<K extends keyof UiPrefs>(key: K): UiPrefs[K] {
  return readUiPrefs()[key];
}

/** Runs before first paint (layout.tsx): mirrors the stored prefs onto <html>. */
export const UI_PREFS_BOOT_SCRIPT = `try{var p=JSON.parse(localStorage.getItem(${JSON.stringify(KEY)})||"null")||{},r=document.documentElement,m=${JSON.stringify(
  Object.fromEntries(Object.entries(HTML_ATTRS).map(([attr, key]) => [attr, [key, UI_PREF_DEFAULTS[key]]]))
)};for(var a in m){var v=p[m[a][0]];if(v!==undefined&&v!==m[a][1])r.setAttribute(a,String(v))}}catch(e){}`;

/** A short chime for "your reply is ready", synthesised so no asset ships. */
export function playReplyChime() {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const now = ctx.currentTime;
    [659.25, 987.77].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t = now + i * 0.11;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.08, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.4);
    });
    window.setTimeout(() => void ctx.close().catch(() => {}), 800);
  } catch {
    // Audio blocked before any user gesture: the notification still shows.
  }
}

/**
 * Tell the reader a reply finished while they were away: a system
 * notification when allowed and the tab is hidden, and/or a chime.
 */
export function announceReplyFinished(title: string) {
  if (typeof document === "undefined") return;
  const prefs = readUiPrefs();
  const away = document.visibilityState === "hidden" || !document.hasFocus();
  if (!away) return;
  if (prefs.replySound) playReplyChime();
  if (prefs.notifyOnReply && "Notification" in window && Notification.permission === "granted") {
    try {
      const n = new Notification("Your reply is ready", { body: title, tag: "alevr-reply", silent: prefs.replySound });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    } catch {
      // Some browsers only allow notifications from a service worker.
    }
  }
}
