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
  Sparkles,
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
  const nextPlayTimeRef = useRef<number>(0);
  const videoFrameIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectAttemptRef = useRef<number>(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isManuallyClosedRef = useRef<boolean>(false);

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
  }, []);

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
          const pcmBuffer = floatTo16BitPCM(inputData);
          ws.send(pcmBuffer);
        };

        source.connect(processor);
        processor.connect(audioCtx.destination);
      };

      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          // Assistant audio output
          setSessionState("speaking");
          playPcm(event.data);
        } else if (typeof event.data === "string") {
          try {
            const msg = JSON.parse(event.data) as VoiceServerMessage;
            if (msg.type === "session.ready") {
              setSessionState("listening");
            } else if (msg.type === "turn") {
              if (msg.phase === "start") {
                setSessionState("speaking");
              } else if (msg.phase === "end") {
                setSessionState("listening");
              }
            } else if (msg.type === "transcript") {
              setCurrentTranscript(msg.text);
              if (onTranscriptReceived) {
                onTranscriptReceived(msg.text, msg.role, msg.final);
              }
            } else if (msg.type === "interrupted") {
              setSessionState("listening");
              if (playContextRef.current) {
                nextPlayTimeRef.current = playContextRef.current.currentTime;
              }
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
  }, [provider, initialHistory, isAudioMuted, onTranscriptReceived, onError, playPcm]);

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
        // Replace or add video track
        if (mediaStreamRef.current) {
          mediaStreamRef.current.getVideoTracks().forEach((t) => t.stop());
          stream.getVideoTracks().forEach((t) => mediaStreamRef.current?.addTrack(t));
        }
        setIsVideoEnabled(true);
        setIsScreenShareEnabled(false);

        // Send 1 frame per second
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

  // Handle interruption / barge-in
  const handleInterrupt = () => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      const msg: VoiceClientMessage = { type: "control.interrupt" };
      wsRef.current.send(JSON.stringify(msg));
    }
    if (playContextRef.current) {
      nextPlayTimeRef.current = playContextRef.current.currentTime;
    }
    setSessionState("listening");
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
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-in fade-in duration-200"
    >
      <div className="relative w-full max-w-4xl bg-neutral-900 border border-neutral-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col items-center">
        {/* Header */}
        <div className="w-full flex items-center justify-between px-6 py-4 border-b border-neutral-800 bg-neutral-950/50">
          <div className="flex items-center gap-3">
            <div
              className={`h-3 w-3 rounded-full ${
                sessionState === "connected" || sessionState === "listening" || sessionState === "speaking"
                  ? "bg-emerald-500 animate-pulse"
                  : isReconnecting
                  ? "bg-amber-500 animate-pulse"
                  : sessionState === "failed"
                  ? "bg-red-500"
                  : "bg-neutral-500"
              }`}
            />
            <span id="live-multimodal-title" className="text-sm font-semibold text-neutral-200">
              Juno Live Multimodal Session
            </span>
            <span className="text-xs bg-neutral-800 text-neutral-400 px-2 py-0.5 rounded-full font-mono">
              {provider} {modelId ? `· ${modelId}` : ""}
            </span>
          </div>
          <button
            onClick={onClose}
            aria-label="Close session"
            className="p-1.5 text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Error Banner if any */}
        {errorMessage && (
          <div className="w-full bg-red-950/60 border-b border-red-900/50 px-6 py-2.5 flex items-center justify-between text-xs text-red-200">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
              <span>{errorMessage}</span>
            </div>
            {sessionState === "failed" && (
              <button
                onClick={() => void connectSession()}
                className="flex items-center gap-1.5 px-2.5 py-1 bg-red-900/60 hover:bg-red-800 text-red-100 rounded-md font-medium"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Retry
              </button>
            )}
          </div>
        )}

        {/* Video / Visual Stream Area */}
        <div className="w-full h-[380px] bg-neutral-950 flex items-center justify-center relative overflow-hidden">
          {isVideoEnabled || isScreenShareEnabled ? (
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-contain rounded-lg"
            />
          ) : (
            <div className="flex flex-col items-center gap-4 text-neutral-500">
              <div className="relative">
                <div
                  className={`w-24 h-24 rounded-full flex items-center justify-center border-2 ${
                    isSpeaking
                      ? "border-indigo-500 scale-110 shadow-lg shadow-indigo-500/20"
                      : isListening
                      ? "border-emerald-500/60"
                      : "border-neutral-700"
                  } transition-all duration-300`}
                >
                  <Sparkles
                    className={`w-10 h-10 ${
                      isSpeaking
                        ? "text-indigo-400 animate-spin"
                        : isListening
                        ? "text-emerald-400"
                        : "text-neutral-600"
                    }`}
                  />
                </div>
                {isSpeaking && (
                  <div className="absolute inset-0 rounded-full border border-indigo-400 animate-ping opacity-25" />
                )}
              </div>
              <p className="text-sm text-neutral-400 max-w-md text-center px-4">
                {currentTranscript || (
                  isSpeaking
                    ? "Juno is speaking..."
                    : isListening
                    ? "Listening... Speak naturally or interrupt anytime."
                    : isConnecting
                    ? "Connecting to live voice relay..."
                    : isReconnecting
                    ? "Network dropped. Reconnecting..."
                    : "Session ended."
                )}
              </p>
            </div>
          )}

          {/* Live Status Pill */}
          <div className="absolute bottom-4 left-4 bg-neutral-900/80 backdrop-blur-sm border border-neutral-800 px-3 py-1.5 rounded-full flex items-center gap-2 text-xs text-neutral-300">
            {isSpeaking ? (
              <>
                <Volume2 className="w-3.5 h-3.5 text-indigo-400 animate-pulse" />
                <span>Speaking (Click Interrupt to stop)</span>
              </>
            ) : isListening ? (
              <>
                <Radio className="w-3.5 h-3.5 text-emerald-400" />
                <span>Listening</span>
              </>
            ) : (
              <span>{sessionState}</span>
            )}
          </div>

          {/* Barge-in Button when speaking */}
          {isSpeaking && (
            <button
              onClick={handleInterrupt}
              className="absolute bottom-4 right-4 bg-indigo-600/90 hover:bg-indigo-600 text-white text-xs px-3.5 py-1.5 rounded-full shadow-lg font-medium transition-all"
            >
              Interrupt
            </button>
          )}
        </div>

        {/* Control Bar */}
        <div className="w-full px-6 py-4 bg-neutral-950 border-t border-neutral-800 flex items-center justify-center gap-4">
          <button
            onClick={toggleMute}
            aria-label={isAudioMuted ? "Unmute microphone" : "Mute microphone"}
            className={`p-3.5 rounded-full border transition-all ${
              isAudioMuted
                ? "bg-red-500/20 border-red-500/50 text-red-400"
                : "bg-neutral-800 border-neutral-700 text-neutral-200 hover:bg-neutral-700"
            }`}
            title={isAudioMuted ? "Unmute Mic" : "Mute Mic"}
          >
            {isAudioMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
          </button>

          <button
            onClick={toggleVideo}
            aria-label={isVideoEnabled ? "Turn off camera" : "Turn on camera"}
            className={`p-3.5 rounded-full border transition-all ${
              isVideoEnabled
                ? "bg-indigo-500/20 border-indigo-500/50 text-indigo-400"
                : "bg-neutral-800 border-neutral-700 text-neutral-200 hover:bg-neutral-700"
            }`}
            title={isVideoEnabled ? "Turn off camera" : "Turn on camera"}
          >
            {isVideoEnabled ? <Video className="w-5 h-5" /> : <VideoOff className="w-5 h-5" />}
          </button>

          <button
            onClick={toggleScreenShare}
            aria-label={isScreenShareEnabled ? "Stop screen sharing" : "Share screen"}
            className={`p-3.5 rounded-full border transition-all ${
              isScreenShareEnabled
                ? "bg-blue-500/20 border-blue-500/50 text-blue-400"
                : "bg-neutral-800 border-neutral-700 text-neutral-200 hover:bg-neutral-700"
            }`}
            title={isScreenShareEnabled ? "Stop screen sharing" : "Share screen"}
          >
            <Monitor className="w-5 h-5" />
          </button>

          <button
            onClick={onClose}
            aria-label="End call"
            className="px-5 py-2.5 rounded-full bg-red-600 hover:bg-red-500 text-white font-medium text-sm transition-colors ml-4"
          >
            End Call
          </button>
        </div>
      </div>
    </div>
  );
}
