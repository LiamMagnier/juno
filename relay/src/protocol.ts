/**
 * Juno voice relay — client <-> relay wire protocol (single source of truth).
 *
 * Mirrors: src/lib/voice-relay-protocol.ts (web) and VoiceRelayProtocol.swift
 * (iOS). Change all three together.
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
  /** True speech-to-speech (sends/receives audio natively). MiniMax is a
   *  composed ASR->LLM->TTS pipeline and is false. */
  trueS2S: boolean;
  /** Provider needs the CLIENT to transcribe the user (send input.text with
   *  final utterances instead of relying on server transcripts). */
  needsClientTranscript: boolean;
  /** Hard provider session ceiling, seconds. Relay closes with
   *  reason "session-limit" when reached. */
  maxSessionSec: number;
}

// ---- client -> relay ----
export type ClientMessage =
  | { type: "session.start"; provider: VoiceProviderId }
  | { type: "session.switch"; provider: VoiceProviderId }
  /** Final user utterance from on-device speech recognition (MiniMax mode). */
  | { type: "input.text"; text: string }
  /** Explicit barge-in: stop the model speaking now. */
  | { type: "control.interrupt" }
  /** One JPEG screen/camera frame, base64 (no data: prefix). Send <= 1 fps. */
  | { type: "video.frame"; jpegBase64: string }
  | { type: "ping" };

// ---- relay -> client ----
export type ServerMessage =
  | { type: "session.ready"; provider: VoiceProviderId; capabilities: ProviderCapabilities }
  | { type: "transcript"; role: "user" | "assistant"; text: string; final: boolean }
  | { type: "turn"; speaker: "assistant"; phase: "start" | "end" }
  /** Model output was cancelled (user barge-in). Client must flush its
   *  audio playback queue immediately. */
  | { type: "interrupted" }
  | { type: "usage"; provider: VoiceProviderId; audioInSec: number; audioOutSec: number; estCostUsd: number }
  | { type: "session.closed"; reason: "session-limit" | "provider" | "client" | "error" }
  | { type: "error"; message: string }
  | { type: "pong" };

export const MIC_SAMPLE_RATE = 16000;
export const PLAYBACK_SAMPLE_RATE = 24000;
