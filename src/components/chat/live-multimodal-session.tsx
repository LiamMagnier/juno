"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { Mic, MicOff, Video, VideoOff, Monitor, X, Volume2, Sparkles } from "lucide-react";

export interface LiveMultimodalSessionProps {
  isOpen: boolean;
  onClose: () => void;
  modelId?: string;
  onTranscriptReceived?: (transcript: string) => void;
}

export function LiveMultimodalSession({
  isOpen,
  onClose,
  modelId = "gemini-3.1-pro",
  onTranscriptReceived,
}: LiveMultimodalSessionProps) {
  const [isAudioMuted, setIsAudioMuted] = useState(false);
  const [isVideoEnabled, setIsVideoEnabled] = useState(false);
  const [isScreenShareEnabled, setIsScreenShareEnabled] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Initializing live session...");
  const [agentSpeaking] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);

  const startMedia = useCallback(async () => {
    try {
      setStatusMessage("Connecting to multimodal model...");
      const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = audioStream;
      setIsConnected(true);
      setStatusMessage("Connected. Listening...");
      if (onTranscriptReceived) {
        onTranscriptReceived("Session started");
      }
    } catch {
      setStatusMessage("Microphone permission denied or unavailable.");
    }
  }, [onTranscriptReceived]);

  const toggleVideo = async () => {
    if (isVideoEnabled) {
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getVideoTracks().forEach((t) => t.stop());
      }
      setIsVideoEnabled(false);
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: true });
        mediaStreamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
        setIsVideoEnabled(true);
        setIsScreenShareEnabled(false);
      } catch {
        setStatusMessage("Camera access failed.");
      }
    }
  };

  const toggleScreenShare = async () => {
    if (isScreenShareEnabled) {
      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach((t) => t.stop());
      }
      setIsScreenShareEnabled(false);
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
        };
      } catch {
        setStatusMessage("Screen sharing cancelled.");
      }
    }
  };

  useEffect(() => {
    if (isOpen) {
      startMedia();
    } else {
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      }
      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach((t) => t.stop());
      }
      setIsConnected(false);
      setIsVideoEnabled(false);
      setIsScreenShareEnabled(false);
    }
  }, [isOpen, startMedia]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-in fade-in duration-200">
      <div className="relative w-full max-w-4xl bg-neutral-900 border border-neutral-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col items-center">
        {/* Header */}
        <div className="w-full flex items-center justify-between px-6 py-4 border-b border-neutral-800 bg-neutral-950/50">
          <div className="flex items-center gap-3">
            <div className="h-3 w-3 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-sm font-semibold text-neutral-200">Juno Live Multimodal Session</span>
            <span className="text-xs bg-neutral-800 text-neutral-400 px-2 py-0.5 rounded-full font-mono">{modelId}</span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

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
                <div className={`w-24 h-24 rounded-full flex items-center justify-center border-2 ${agentSpeaking ? "border-indigo-500 scale-110 shadow-lg shadow-indigo-500/20" : "border-neutral-700"} transition-all duration-300`}>
                  <Sparkles className={`w-10 h-10 ${agentSpeaking ? "text-indigo-400 animate-spin" : "text-neutral-600"}`} />
                </div>
                {agentSpeaking && (
                  <div className="absolute inset-0 rounded-full border border-indigo-400 animate-ping opacity-25" />
                )}
              </div>
              <p className="text-sm text-neutral-400">{statusMessage}</p>
            </div>
          )}

          {/* Live Status Pill */}
          <div className="absolute bottom-4 left-4 bg-neutral-900/80 backdrop-blur-sm border border-neutral-800 px-3 py-1.5 rounded-full flex items-center gap-2 text-xs text-neutral-300">
            <Volume2 className="w-3.5 h-3.5 text-neutral-400" />
            <span>{agentSpeaking ? "Juno is speaking..." : isConnected ? "Listening..." : "Connecting..."}</span>
          </div>
        </div>

        {/* Control Bar */}
        <div className="w-full px-6 py-4 bg-neutral-950 border-t border-neutral-800 flex items-center justify-center gap-4">
          <button
            onClick={() => setIsAudioMuted(!isAudioMuted)}
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
            className="px-5 py-2.5 rounded-full bg-red-600 hover:bg-red-500 text-white font-medium text-sm transition-colors ml-4"
          >
            End Call
          </button>
        </div>
      </div>
    </div>
  );
}
