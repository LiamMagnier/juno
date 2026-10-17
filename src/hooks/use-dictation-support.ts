"use client";

import * as React from "react";
import { useOptionalApp } from "@/components/app/app-provider";
import { PLANS } from "@/lib/plans";
import type { ClientQuota } from "@/types/chat";

/*
 * WHETHER THIS BROWSER CAN DICTATE, AND HOW (G36).
 *
 * Dictation has two ways to turn speech into text (composer-dictation.tsx):
 *
 *   server   the microphone is recorded in the page and transcribed by the
 *            deployment's speech-to-text route (/api/voice/stt). Works in every
 *            browser that can open a microphone: Firefox, Safari and Chromium.
 *   browser  the Web Speech API transcribes on its own (Chromium and Safari).
 *
 * The mic used to be drawn only when Web Speech existed, so Firefox never saw
 * it even on a deployment whose server transcribes everything. It is now drawn
 * whenever either path can work, and hidden only when neither can: a control
 * that opens onto "this browser cannot transcribe speech" is a dead end.
 */

export type DictationMode = "server" | "browser" | "none";

/** Pure: which path dictation would take with these capabilities. */
export function dictationMode(input: { serverStt: boolean; microphone: boolean; webSpeech: boolean }): DictationMode {
  if (input.serverStt && input.microphone) return "server";
  if (input.webSpeech) return "browser";
  return "none";
}

/** The page can record the microphone itself: a secure context, getUserMedia and Web Audio. */
export function canRecordMicrophone(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  if (window.isSecureContext === false) return false;
  const audio =
    typeof window.AudioContext === "function" ||
    typeof (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext === "function";
  return audio && typeof navigator.mediaDevices?.getUserMedia === "function";
}

/** The browser has its own recognizer (Web Speech). */
export function hasWebSpeech(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as Record<string, unknown>;
  return typeof (w.SpeechRecognition ?? w.webkitSpeechRecognition) === "function";
}

/**
 * The server can transcribe for this account: the deployment has a
 * speech-to-text provider AND the plan includes voice, which /api/voice/stt
 * checks (a plan without it is refused with 403, every time).
 */
export function serverDictationAvailable(app: { features: { serverStt: boolean }; quota: Pick<ClientQuota, "plan"> } | null): boolean {
  if (!app?.features.serverStt) return false;
  return PLANS[app.quota.plan]?.voice ?? false;
}

/**
 * The dictation path for this browser on this deployment. "none" until
 * mounted, so the server and the first client render agree and the mic
 * appears after hydration rather than flashing away.
 */
export function useDictationMode(): DictationMode {
  const app = useOptionalApp();
  const serverStt = serverDictationAvailable(app);
  const [mode, setMode] = React.useState<DictationMode>("none");
  React.useEffect(() => {
    setMode(dictationMode({ serverStt, microphone: canRecordMicrophone(), webSpeech: hasWebSpeech() }));
  }, [serverStt]);
  return mode;
}

/** Whether to draw a Dictate control at all. */
export function useDictationSupported(): boolean {
  return useDictationMode() !== "none";
}
