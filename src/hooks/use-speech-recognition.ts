"use client";

import * as React from "react";

/* Minimal typings for the Web Speech API (not in the standard lib). */
interface SpeechRecognitionResultLike {
  0: { transcript: string };
  isFinal: boolean;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: { length: number; [i: number]: SpeechRecognitionResultLike };
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}

function getRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition || w.webkitSpeechRecognition || null) as (new () => SpeechRecognitionLike) | null;
}

export function useSpeechRecognition(
  opts: { onFinal?: (text: string) => void; onEnd?: () => void; onError?: (error: string) => void; lang?: string; continuous?: boolean } = {}
) {
  const [listening, setListening] = React.useState(false);
  const [interim, setInterim] = React.useState("");
  const recognitionRef = React.useRef<SpeechRecognitionLike | null>(null);
  // Resolve support after mount so the first client render matches the server
  // (where `window` is absent) and avoids a hydration mismatch.
  const [supported, setSupported] = React.useState(false);
  React.useEffect(() => {
    setSupported(getRecognitionCtor() !== null);
  }, []);
  const onFinalRef = React.useRef(opts.onFinal);
  onFinalRef.current = opts.onFinal;
  const onEndRef = React.useRef(opts.onEnd);
  onEndRef.current = opts.onEnd;
  const onErrorRef = React.useRef(opts.onError);
  onErrorRef.current = opts.onError;
  const continuous = opts.continuous ?? true;

  const stop = React.useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  const start = React.useCallback(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;
    const recognition = new Ctor();
    recognition.lang = opts.lang ?? (typeof navigator !== "undefined" ? navigator.language : "en-US");
    recognition.continuous = continuous;
    recognition.interimResults = true;

    recognition.onresult = (e) => {
      let interimText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) {
          onFinalRef.current?.(res[0].transcript.trim());
        } else {
          interimText += res[0].transcript;
        }
      }
      setInterim(interimText);
    };
    recognition.onerror = (event) => {
      setListening(false);
      onErrorRef.current?.(event.error);
    };
    recognition.onend = () => {
      setListening(false);
      setInterim("");
      onEndRef.current?.();
    };

    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  }, [opts.lang, continuous]);

  React.useEffect(() => () => recognitionRef.current?.abort(), []);

  return { supported, listening, interim, start, stop };
}
