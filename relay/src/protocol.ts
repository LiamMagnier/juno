/**
 * Juno voice relay — client <-> relay wire protocol (single source of truth).
 *
 * Mirrors: src/lib/voice-relay-protocol.ts (web) and VoiceRelayProtocol.swift
 * (iOS). Change all three together.
 *
 * ONE DELIBERATE EXCEPTION: the `thinking` fields below are carried by the
 * relay and the web client only. Swift's decoder ignores JSON keys it has no
 * CodingKey for, so iOS keeps working untouched — it simply never asks for the
 * reasoning variant and never reads which one it got. Mirroring them needs
 * `sessionReady` to grow a payload, which changes an enum case every
 * exhaustive switch in the iOS app matches on; that belongs in a change that
 * can build and test Swift.
 *
 * Transport: one WebSocket per voice session, authenticated with a short-lived
 * HMAC token minted by the Juno backend (?token= query param).
 *
 * Frames:
 *  - BINARY client->relay : microphone audio, PCM16 little-endian mono 16 kHz
 *  - BINARY relay->client : model speech,     PCM16 little-endian mono 24 kHz
 *  - TEXT   both ways     : one JSON message per frame (types below)
 */

export type VoiceProviderId = "openai" | "gemini" | "qwen" | "minimax" | "mock";
// "mock" is dev-only (relay env RELAY_ENABLE_MOCK=1) — no external calls.

export interface ProviderCapabilities {
  /** Accepts JPEG video/screen frames (video.frame messages). */
  videoInput: boolean;
  /** Accepts a continuing low-frame-rate screen stream without bloating the
   * provider's conversational item history. */
  screenInput?: boolean;
  /** True speech-to-speech (sends/receives audio natively). MiniMax is a
   *  composed ASR->LLM->TTS pipeline and is false. */
  trueS2S: boolean;
  /** Provider needs the CLIENT to transcribe the user (send input.text with
   *  final utterances instead of relying on server transcripts). */
  needsClientTranscript: boolean;
  /** The caller may choose whether this provider reasons before answering.
   *  Where false, `thinking` on session.start/switch is ignored. */
  thinkingChoice: boolean;
  /** Hard provider session ceiling, seconds. Relay closes with
   *  reason "session-limit" when reached. */
  maxSessionSec: number;
}

/** A finalized existing-chat turn supplied when voice mode starts. The relay
 * validates and bounds this untrusted client history before giving it to a
 * provider. */
export interface VoiceHistoryEntry {
  role: "user" | "assistant";
  text: string;
  /** Bounded, untrusted document context for a composed user turn. */
  context?: string;
}

export const VOICE_HISTORY_MAX_TURNS = 20;
export const VOICE_HISTORY_MAX_TURN_CHARS = 2_000;
export const VOICE_HISTORY_MAX_TOTAL_CHARS = 12_000;

// ---- client -> relay ----
export type ClientMessage =
  /** `thinking` asks for the reasoning variant of a provider that has one. It
   *  is a request, not a fact: the relay answers with what it actually got. */
  | { type: "session.start"; provider: VoiceProviderId; history?: VoiceHistoryEntry[]; thinking?: boolean }
  | { type: "session.switch"; provider: VoiceProviderId; thinking?: boolean }
  /** Final user utterance from on-device speech recognition (MiniMax mode). */
  | {
      type: "input.text";
      text: string;
      turnId?: string;
      displayText?: string;
      /** Context returned by the authenticated attachment route, never bytes. */
      context?: string;
      /** Exact uploaded ids retained for the transcript save boundary. */
      attachmentIds?: string[];
    }
  /** Explicit barge-in: stop the model speaking now. */
  | { type: "control.interrupt" }
  /** One JPEG screen/camera frame, base64 (no data: prefix). Send <= 1 fps. */
  | { type: "video.frame"; jpegBase64: string }
  | { type: "ping" };

// ---- relay -> client ----
export type ServerMessage =
  /** `thinking` is the EFFECTIVE state, not the request: a provider with no
   *  reasoning variant reports false however it was asked. */
  | {
      type: "session.ready";
      provider: VoiceProviderId;
      capabilities: ProviderCapabilities;
      thinking: boolean;
      /** True when the call was given what Juno remembers about the caller. */
      memory?: boolean;
      /** Present only for a call in an agent's thread: true when the call is
       *  that agent, false when its persona could not be had and Juno answers. */
      persona?: boolean;
      /** The model actually serving the call, as the provider reports it. */
      model?: string;
      /** A non-fatal note about how the session came up — a fallback protocol,
       *  say. Unlike `error` this does not end the call. */
      notice?: string;
    }
  | { type: "transcript"; role: "user" | "assistant"; text: string; final: boolean; turnId?: string }
  | { type: "turn"; speaker: "assistant" | "user"; phase: "start" | "end" }
  /** Model output was cancelled (user barge-in). Client must flush its
   *  audio playback queue immediately. */
  | { type: "interrupted" }
  /** Running session estimate, pushed every 5s. `estCostInUsd`/`estCostOutUsd`
   *  split `estCostUsd` into what the user's speech and the model's speech
   *  cost; both are optional because a provider may report no usable token
   *  counts, and clients predating the split simply ignore them. */
  | {
      type: "usage";
      provider: VoiceProviderId;
      audioInSec: number;
      audioOutSec: number;
      estCostUsd: number;
      estCostInUsd?: number;
      estCostOutUsd?: number;
    }
  | { type: "session.closed"; reason: "session-limit" | "provider" | "client" | "error" }
  | { type: "error"; message: string }
  | { type: "pong" };

export const MIC_SAMPLE_RATE = 16000;
export const PLAYBACK_SAMPLE_RATE = 24000;
