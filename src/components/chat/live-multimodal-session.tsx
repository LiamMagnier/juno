"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  Monitor,
  X,
  Volume2,
  AlertCircle,
  RefreshCw,
  Radio,
} from "lucide-react";
import type {
  VoiceProviderId,
  VoiceClientMessage,
  VoiceServerMessage,
  VoiceHistoryEntry,
} from "@/lib/voice-relay-protocol";
import {
  MIC_SAMPLE_RATE,
  PLAYBACK_SAMPLE_RATE,
} from "@/lib/voice-relay-protocol";
import {
  RealtimeVoiceActivityDetector,
  normalizedSpeechLoudness,
} from "@/lib/realtime-voice-activity";
import { cn } from "@/lib/utils";

export type LiveSessionState =
  | "idle"
  | "requestingPermission"
  | "connecting"
  | "connected"
  | "listening"
  | "thinking"
  | "speaking"
  | "reconnecting"
  | "failed"
  | "ended";

export interface LiveMultimodalSessionProps {
  isOpen: boolean;
  onClose: () => void;
  provider?: VoiceProviderId;
  modelId?: string;
  initialHistory?: VoiceHistoryEntry[];
  onTranscriptReceived?: (transcript: string, role: "user" | "assistant", isFinal: boolean) => void;
  onError?: (error: string) => void;
}

function normalizeRelayUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (trimmed.startsWith("http://")) return `ws://${trimmed.slice(7)}`;
  if (trimmed.startsWith("https://")) return `wss://${trimmed.slice(8)}`;
  return trimmed;
}

/** Convert Float32Array audio buffer to 16-bit PCM ArrayBuffer */
function floatTo16BitPCM(input: Float32Array): ArrayBuffer {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return output.buffer;
}

export function LiveMultimodalSession({
  isOpen,
  onClose,
  provider = "gemini",
  modelId,
  initialHistory = [],
  onTranscriptReceived,
  onError,
}: LiveMultimodalSessionProps) {
  const [sessionState, setSessionState] = useState<LiveSessionState>("idle");
  const [isAudioMuted, setIsAudioMuted] = useState(false);
  const [isVideoEnabled, setIsVideoEnabled] = useState(false);
  const [isScreenShareEnabled, setIsScreenShareEnabled] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [currentTranscript, setCurrentTranscript] = useState<string>("");

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioInputSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const audioProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const playContextRef = useRef<AudioContext | null>(null);
  const playSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextPlayTimeRef = useRef<number>(0);
  const speakingRef = useRef<boolean>(false);
  const bargeDetectorRef = useRef(new RealtimeVoiceActivityDetector());
  const videoFrameIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectAttemptRef = useRef<number>(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isManuallyClosedRef = useRef<boolean>(false);

  const flushPlayback = useCallback(() => {
    for (const src of playSourcesRef.current) {
      try {
        src.stop();
      } catch {}
    }
    playSourcesRef.current.clear();
    if (playContextRef.current && playContextRef.current.state !== "closed") {
      nextPlayTimeRef.current = playContextRef.current.currentTime;
    }
  }, []);

  const handleInterrupt = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      const msg: VoiceClientMessage = { type: "control.interrupt" };
      wsRef.current.send(JSON.stringify(msg));
    }
    flushPlayback();
    bargeDetectorRef.current.reset();
    speakingRef.current = false;
    setSessionState("listening");
  }, [flushPlayback]);

  // Play incoming PCM chunk
  const playPcm = useCallback((arrayBuffer: ArrayBuffer) => {
    try {
      if (!playContextRef.current || playContextRef.current.state === "closed") {
        playContextRef.current = new AudioContext({ sampleRate: PLAYBACK_SAMPLE_RATE });
      }
      const ctx = playContextRef.current;
      if (ctx.state === "suspended") {
        void ctx.resume();
      }

      const int16 = new Int16Array(arrayBuffer);
      if (int16.length === 0) return;
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7fff);
      }

      const audioBuffer = ctx.createBuffer(1, float32.length, PLAYBACK_SAMPLE_RATE);
      audioBuffer.copyToChannel(float32, 0);

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);

      const now = ctx.currentTime;
      const startTime = Math.max(now, nextPlayTimeRef.current);
      source.start(startTime);
      nextPlayTimeRef.current = startTime + audioBuffer.duration;
      playSourcesRef.current.add(source);
      speakingRef.current = true;
      setSessionState("speaking");

      source.onended = () => {
        playSourcesRef.current.delete(source);
        if (playSourcesRef.current.size === 0) {
          speakingRef.current = false;
          setSessionState((prev) => (prev === "speaking" ? "listening" : prev));
        }
      };
    } catch (e) {
      console.warn("[LiveMultimodal] PCM playback error:", e);
    }
  }, []);

  // Capture video frame and send to relay
  const sendVideoFrame = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) return;

    try {
      if (!canvasRef.current) {
        canvasRef.current = document.createElement("canvas");
      }
      const canvas = canvasRef.current;
      const maxDim = 720;
      let width = video.videoWidth;
      let height = video.videoHeight;
      if (width > maxDim || height > maxDim) {
        if (width > height) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
      }
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, width, height);

      const dataUrl = canvas.toDataURL("image/jpeg", 0.6);
      const base64 = dataUrl.split(",")[1];
      if (base64) {
        const msg: VoiceClientMessage = {
          type: "video.frame",
          jpegBase64: base64,
        };
        wsRef.current.send(JSON.stringify(msg));
      }
    } catch {
      // Ignore frame draw errors
    }
  }, []);

  // Cleanup all hardware & network resources
  const releaseResources = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (videoFrameIntervalRef.current) {
      clearInterval(videoFrameIntervalRef.current);
      videoFrameIntervalRef.current = null;
    }
    if (audioProcessorRef.current) {
      audioProcessorRef.current.disconnect();
      audioProcessorRef.current = null;
    }
    if (audioInputSourceRef.current) {
      audioInputSourceRef.current.disconnect();
      audioInputSourceRef.current = null;
    }
    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      void audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    flushPlayback();
    if (playContextRef.current && playContextRef.current.state !== "closed") {
      void playContextRef.current.close().catch(() => {});
      playContextRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((t) => t.stop());
      screenStreamRef.current = null;
    }
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {}
      wsRef.current = null;
    }
    speakingRef.current = false;
    bargeDetectorRef.current.reset();
  }, [flushPlayback]);

  // Start live session connection
  const connectSession = useCallback(async (isRetry = false) => {
    if (isManuallyClosedRef.current) return;
    setErrorMessage(null);
    if (!isRetry) {
      setSessionState("requestingPermission");
    } else {
      setSessionState("reconnecting");
    }

    try {
      // 1. Get microphone access
      let audioStream = mediaStreamRef.current;
      if (!audioStream) {
        audioStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            sampleRate: MIC_SAMPLE_RATE,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        mediaStreamRef.current = audioStream;
      }

      setSessionState("connecting");

      // 2. Fetch short-lived relay token from server
      const tokenRes = await fetch("/api/voice/relay-token");
      if (!tokenRes.ok) {
        const errData = await tokenRes.json().catch(() => ({}));
        throw new Error(errData.message || errData.error || `Server returned ${tokenRes.status}`);
      }
      const { token, url: relayUrl } = await tokenRes.json();
      if (!token || !relayUrl) {
        throw new Error("Missing relay session credentials");
      }

      // 3. Connect WebSocket to relay
      const targetWsUrl = `${normalizeRelayUrl(relayUrl)}/?token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(targetWsUrl);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttemptRef.current = 0;
        setSessionState("connected");

        // Send session.start
        const startMsg: VoiceClientMessage = {
          type: "session.start",
          provider,
          history: initialHistory,
        };
        ws.send(JSON.stringify(startMsg));

        // Start Web Audio recording loop
        const audioCtx = new AudioContext({ sampleRate: MIC_SAMPLE_RATE });
        audioContextRef.current = audioCtx;
        const source = audioCtx.createMediaStreamSource(audioStream!);
        audioInputSourceRef.current = source;
        const processor = audioCtx.createScriptProcessor(2048, 1, 1);
        audioProcessorRef.current = processor;

        processor.onaudioprocess = (e) => {
          if (isAudioMuted || ws.readyState !== WebSocket.OPEN) return;
          const inputData = e.inputBuffer.getChannelData(0);

          // Real-time automatic barge-in / speech activity detection
          if (speakingRef.current) {
            let sum = 0;
            for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
            const rms = Math.sqrt(sum / inputData.length);
            const loudness = normalizedSpeechLoudness(rms);
            const transition = bargeDetectorRef.current.observe(
              loudness,
              (inputData.length / MIC_SAMPLE_RATE) * 1000
            );
            if (transition === "began") {
              handleInterrupt();
            }
          } else {
            bargeDetectorRef.current.reset();
          }

          const pcmBuffer = floatTo16BitPCM(inputData);
          ws.send(pcmBuffer);
        };

        source.connect(processor);
        processor.connect(audioCtx.destination);
      };

      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          // Assistant audio output
          playPcm(event.data);
        } else if (typeof event.data === "string") {
          try {
            const msg = JSON.parse(event.data) as VoiceServerMessage;
            if (msg.type === "session.ready") {
              setSessionState("listening");
            } else if (msg.type === "turn") {
              if (msg.phase === "start") {
                speakingRef.current = true;
                setSessionState("speaking");
              } else if (msg.phase === "end") {
                if (playSourcesRef.current.size === 0) {
                  speakingRef.current = false;
                  setSessionState("listening");
                }
              }
            } else if (msg.type === "transcript") {
              setCurrentTranscript(msg.text);
              if (onTranscriptReceived) {
                onTranscriptReceived(msg.text, msg.role, msg.final);
              }
            } else if (msg.type === "interrupted") {
              flushPlayback();
              speakingRef.current = false;
              setSessionState("listening");
            } else if (msg.type === "error") {
              console.error("[LiveMultimodal] Server error:", msg.message);
              setErrorMessage(msg.message);
              if (onError) onError(msg.message);
            } else if (msg.type === "session.closed") {
              setSessionState("ended");
            }
          } catch {}
        }
      };

      ws.onerror = () => {
        setErrorMessage("Connection to live session service lost.");
      };

      ws.onclose = () => {
        if (!isManuallyClosedRef.current) {
          if (reconnectAttemptRef.current < 4) {
            reconnectAttemptRef.current += 1;
            const backoff = Math.min(1000 * Math.pow(2, reconnectAttemptRef.current), 8000);
            setSessionState("reconnecting");
            reconnectTimerRef.current = setTimeout(() => {
              void connectSession(true);
            }, backoff);
          } else {
            setSessionState("failed");
            setErrorMessage("Session disconnected after multiple retry attempts.");
          }
        } else {
          setSessionState("ended");
        }
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[LiveMultimodal] Setup failed:", msg);
      setSessionState("failed");
      setErrorMessage(msg.includes("Permission") ? "Microphone permission denied." : msg);
      if (onError) onError(msg);
    }
  }, [provider, initialHistory, isAudioMuted, onTranscriptReceived, onError, playPcm, flushPlayback, handleInterrupt]);

  // Handle Mute toggle
  const toggleMute = () => {
    const nextMute = !isAudioMuted;
    setIsAudioMuted(nextMute);
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getAudioTracks().forEach((track) => {
        track.enabled = !nextMute;
      });
    }
  };

  // Handle Video toggle
  const toggleVideo = async () => {
    if (isVideoEnabled) {
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getVideoTracks().forEach((t) => t.stop());
      }
      setIsVideoEnabled(false);
      if (videoFrameIntervalRef.current) {
        clearInterval(videoFrameIntervalRef.current);
        videoFrameIntervalRef.current = null;
      }
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 1280, height: 720, frameRate: 15 },
        });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
        if (mediaStreamRef.current) {
          mediaStreamRef.current.getVideoTracks().forEach((t) => t.stop());
          stream.getVideoTracks().forEach((t) => mediaStreamRef.current?.addTrack(t));
        }
        setIsVideoEnabled(true);
        setIsScreenShareEnabled(false);

        if (videoFrameIntervalRef.current) clearInterval(videoFrameIntervalRef.current);
        videoFrameIntervalRef.current = setInterval(sendVideoFrame, 1000);
      } catch {
        setErrorMessage("Camera access failed or denied.");
      }
    }
  };

  // Handle Screen Share toggle
  const toggleScreenShare = async () => {
    if (isScreenShareEnabled) {
      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach((t) => t.stop());
        screenStreamRef.current = null;
      }
      setIsScreenShareEnabled(false);
      if (videoFrameIntervalRef.current) {
        clearInterval(videoFrameIntervalRef.current);
        videoFrameIntervalRef.current = null;
      }
    } else {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        screenStreamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
        setIsScreenShareEnabled(true);
        setIsVideoEnabled(false);

        stream.getVideoTracks()[0].onended = () => {
          setIsScreenShareEnabled(false);
          if (videoFrameIntervalRef.current) {
            clearInterval(videoFrameIntervalRef.current);
            videoFrameIntervalRef.current = null;
          }
        };

        if (videoFrameIntervalRef.current) clearInterval(videoFrameIntervalRef.current);
        videoFrameIntervalRef.current = setInterval(sendVideoFrame, 1000);
      } catch {
        // User cancelled picker
      }
    }
  };

  useEffect(() => {
    if (isOpen) {
      isManuallyClosedRef.current = false;
      void connectSession();
    } else {
      isManuallyClosedRef.current = true;
      releaseResources();
      setSessionState("idle");
    }

    return () => {
      isManuallyClosedRef.current = true;
      releaseResources();
    };
  }, [isOpen, connectSession, releaseResources]);

  if (!isOpen) return null;

  const isSpeaking = sessionState === "speaking";
  const isListening = sessionState === "listening" || sessionState === "connected";
  const isConnecting = sessionState === "connecting" || sessionState === "requestingPermission";
  const isReconnecting = sessionState === "reconnecting";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="live-multimodal-title"
      className="fixed inset-0 z-modal flex items-center justify-center bg-scrim/80 p-4 backdrop-blur-md animate-fade-in"
    >
      <div className="relative flex w-full max-w-4xl flex-col items-center overflow-hidden rounded-panel border border-border/80 bg-card shadow-float">
        {/* Header */}
        <div className="flex w-full items-center justify-between border-b border-border/60 bg-muted/40 px-6 py-4">
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "size-2.5 rounded-full transition-colors",
                isSpeaking || isListening
                  ? "bg-primary animate-pulse"
                  : isReconnecting
                  ? "bg-warning animate-pulse"
                  : sessionState === "failed"
                  ? "bg-destructive"
                  : "bg-muted-foreground/40"
              )}
            />
            <span id="live-multimodal-title" className="text-sm font-semibold tracking-tight text-foreground">
              Live Voice & Video
            </span>
            <span className="rounded-full border border-border/60 bg-secondary/80 px-2 py-0.5 font-mono text-micro text-muted-foreground">
              {provider} {modelId ? `· ${modelId}` : ""}
            </span>
          </div>
          <button
            onClick={onClose}
            aria-label="Close session"
            className="pressable inline-flex size-8 items-center justify-center rounded-control text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Error Banner */}
        {errorMessage && (
          <div className="flex w-full items-center justify-between border-b border-destructive/30 bg-destructive/10 px-6 py-2.5 text-xs text-destructive">
            <div className="flex items-center gap-2">
              <AlertCircle className="size-4 shrink-0" />
              <span>{errorMessage}</span>
            </div>
            {sessionState === "failed" && (
              <button
                onClick={() => void connectSession()}
                className="pressable flex items-center gap-1.5 rounded-control bg-destructive px-2.5 py-1 text-xs font-medium text-destructive-foreground hover:opacity-90"
              >
                <RefreshCw className="size-3.5" />
                Retry
              </button>
            )}
          </div>
        )}

        {/* Video / Visual Stream Area */}
        <div className="relative flex h-[380px] w-full items-center justify-center overflow-hidden bg-background/50">
          {isVideoEnabled || isScreenShareEnabled ? (
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="h-full w-full rounded-lg object-contain"
            />
          ) : (
            <div className="flex flex-col items-center gap-5 text-muted-foreground">
              {/* Dynamic Aura Pulse */}
              <div className="relative flex size-24 items-center justify-center">
                {isSpeaking && (
                  <div className="absolute inset-0 animate-ping rounded-full bg-primary/20" />
                )}
                <div
                  className={cn(
                    "flex size-20 items-center justify-center rounded-full border transition-[color,background-color,border-color,box-shadow,transform] duration-base ease-out-soft",
                    isSpeaking
                      ? "border-primary/80 bg-primary/10 shadow-lg scale-110"
                      : isListening
                      ? "border-primary/40 bg-secondary/50"
                      : "border-border/80 bg-muted/20"
                  )}
                >
                  <div className="flex items-center gap-1">
                    <span
                      className={cn(
                        "w-1 rounded-full bg-primary transition-[height,opacity] duration-base ease-out-soft",
                        isSpeaking ? "h-6 animate-pulse" : isListening ? "h-3" : "h-1.5 opacity-40"
                      )}
                    />
                    <span
                      className={cn(
                        "w-1 rounded-full bg-primary transition-[height,opacity] duration-base ease-out-soft",
                        isSpeaking ? "h-8 animate-pulse [animation-delay:150ms]" : isListening ? "h-4" : "h-1.5 opacity-40"
                      )}
                    />
                    <span
                      className={cn(
                        "w-1 rounded-full bg-primary transition-[height,opacity] duration-base ease-out-soft",
                        isSpeaking ? "h-5 animate-pulse [animation-delay:300ms]" : isListening ? "h-2.5" : "h-1.5 opacity-40"
                      )}
                    />
                  </div>
                </div>
              </div>

              <p className="max-w-md px-4 text-center text-sm text-foreground/80">
                {currentTranscript || (
                  isSpeaking
                    ? "Juno is speaking… (speak anytime to interrupt)"
                    : isListening
                    ? "Listening… speak naturally."
                    : isConnecting
                    ? "Connecting to live voice relay…"
                    : isReconnecting
                    ? "Reconnecting…"
                    : "Session ended."
                )}
              </p>
            </div>
          )}

          {/* Live Status Indicator */}
          <div className="absolute bottom-4 left-4 flex items-center gap-2 rounded-full border border-border/80 bg-card/90 px-3 py-1.5 text-xs text-foreground shadow-sm backdrop-blur-md">
            {isSpeaking ? (
              <>
                <Volume2 className="size-3.5 text-primary animate-pulse" />
                <span className="font-medium">Speaking</span>
              </>
            ) : isListening ? (
              <>
                <Radio className="size-3.5 text-primary" />
                <span className="font-medium">Listening</span>
              </>
            ) : (
              <span className="font-medium capitalize text-muted-foreground">{sessionState}</span>
            )}
          </div>
        </div>

        {/* Control Bar */}
        <div className="flex w-full items-center justify-center gap-3 border-t border-border/60 bg-muted/30 px-6 py-4">
          <button
            onClick={toggleMute}
            aria-label={isAudioMuted ? "Unmute microphone" : "Mute microphone"}
            className={cn(
              "pressable inline-flex size-10 items-center justify-center rounded-full border transition-[color,background-color,border-color]",
              isAudioMuted
                ? "border-destructive/60 bg-destructive/15 text-destructive"
                : "border-border/80 bg-secondary text-foreground hover:bg-accent"
            )}
            title={isAudioMuted ? "Unmute Mic" : "Mute Mic"}
          >
            {isAudioMuted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
          </button>

          <button
            onClick={toggleVideo}
            aria-label={isVideoEnabled ? "Turn off camera" : "Turn on camera"}
            className={cn(
              "pressable inline-flex size-10 items-center justify-center rounded-full border transition-[color,background-color,border-color]",
              isVideoEnabled
                ? "border-primary/60 bg-primary/15 text-primary"
                : "border-border/80 bg-secondary text-foreground hover:bg-accent"
            )}
            title={isVideoEnabled ? "Turn off camera" : "Turn on camera"}
          >
            {isVideoEnabled ? <Video className="size-4" /> : <VideoOff className="size-4" />}
          </button>

          <button
            onClick={toggleScreenShare}
            aria-label={isScreenShareEnabled ? "Stop screen sharing" : "Share screen"}
            className={cn(
              "pressable inline-flex size-10 items-center justify-center rounded-full border transition-[color,background-color,border-color]",
              isScreenShareEnabled
                ? "border-primary/60 bg-primary/15 text-primary"
                : "border-border/80 bg-secondary text-foreground hover:bg-accent"
            )}
            title={isScreenShareEnabled ? "Stop screen sharing" : "Share screen"}
          >
            <Monitor className="size-4" />
          </button>

          <button
            onClick={onClose}
            aria-label="End call"
            className="pressable ml-3 inline-flex h-10 items-center gap-1.5 rounded-full border border-destructive/30 bg-destructive px-5 text-sm font-medium text-destructive-foreground shadow-sm hover:opacity-90 active:scale-95"
          >
            End Call
          </button>
        </div>
      </div>
    </div>
  );
}
