"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Icon } from "../icons";
import { R, T, useReduced } from "../motion";
import { useClock, useLevel, useSampled, useTick } from "./clock";
import { type Talker } from "./signal";
import { VoiceString, type StringPhase } from "./voice-string";

/*
 * The composer, speaking. Not a new object: the system's composer (the same
 * surface, hairline, radius and row, from composer.css), in two more modes.
 *
 * DICTATION (C15, the mic). The mic you pressed turns into the system's
 * waveform glyph (D-028's mic-to-meter swap) and its five bars follow your
 * voice in ember; the caret, where your words will land, stops blinking and
 * listens: its height follows the same level (the listening caret). Words
 * arrive at the caret as you speak: the settled part in ink, the unstable
 * tail in the third ink. Stop with the mic again, Enter or ⌘⇧Space; Esc
 * stops and drops the unstable tail. The disc stays quiet while you talk and
 * arms when the words are final: dictation never sends.
 *
 * VOICE (C16, the disc while the field is empty). The composer stays where it
 * is and becomes the call: the model and dictate leave (exit, 160 ms), the
 * disc's glyph turns from voice to end (fast), mute and sound output arrive
 * where they were, and the string draws out of the disc across the empty
 * middle of the row. The field stays and takes typing ("Add to the
 * conversation"); Enter adds it, and a send control appears in the field row
 * only while there is text. End (or Esc in the voice row) reverses it all.
 *
 * Neither mode prints its state. The state is the string's form, tone and
 * motion, and a polite live region ("Listening", "Juno is speaking") that is
 * announced at most every 2 s; the row's group carries the same words as its
 * description for anyone who tabs into it.
 */

export type DictPhase = "idle" | "permission" | "listening" | "interim" | "finalizing" | "done" | "error";
export type ErrorKind = "blocked" | "silence" | "network" | "voice-lost";

export const VOICE_WORDS: Record<StringPhase, string> = {
  connecting: "Connecting voice",
  listening: "Listening",
  thinking: "Juno is thinking",
  answering: "Juno is speaking",
  muted: "Microphone muted",
  interrupted: "Juno stopped. Listening",
  approval: "Waiting for your approval on screen. Saying yes won’t approve it.",
  reconnecting: "Connection lost. Reconnecting",
  error: "Voice disconnected",
  ended: "Voice conversation ended",
};

export const ERROR_COPY: Record<ErrorKind, { icon: string; text: React.ReactNode; verb: string }> = {
  blocked: {
    icon: "mic-off",
    text: "The microphone is blocked. Allow it in this site’s settings, then try again.",
    verb: "Try again",
  },
  silence: {
    icon: "mic",
    text: "Juno didn’t hear anything. Check that the right microphone is on.",
    verb: "Try again",
  },
  network: {
    icon: "offline",
    text: "Dictation lost its connection. What you said so far is kept.",
    verb: "Try again",
  },
  "voice-lost": {
    icon: "offline",
    text: "Voice disconnected. Everything said so far is in this chat.",
    verb: "Resume",
  },
};

/** The polite live region: the state in words, never on screen. Changes faster than every 2 s are not announced. */
export function StateAnnouncer({ words }: { words: string }) {
  const [said, setSaid] = React.useState(words);
  const lastAt = React.useRef(0);
  React.useEffect(() => {
    if (words === said) return;
    const wait = Math.max(0, 2000 - (performance.now() - lastAt.current));
    const t = window.setTimeout(() => {
      lastAt.current = performance.now();
      setSaid(words);
    }, wait);
    return () => window.clearTimeout(t);
  }, [words, said]);
  return (
    <span className="sr" role="status" aria-live="polite" data-voice-state={words}>
      {said}
    </span>
  );
}

/** The caret, listening: still ember, its height the level of your voice (no blink while it listens). */
function ListeningCaret({ who = "you" }: { who?: Talker }) {
  const ref = React.useRef<HTMLSpanElement | null>(null);
  const level = useLevel();
  useTick((t) => {
    const el = ref.current;
    if (!el) return;
    const lv = level(t, who);
    el.style.transform = `scaleY(${(0.5 + lv * 0.85).toFixed(3)})`;
  });
  return <span ref={ref} className="jn-caret jv-caret" aria-hidden="true" />;
}

/** The mic, live: the system's mic-to-waveform swap, the bars following your voice. */
const GAINS = [0.55, 0.82, 1, 0.82, 0.55];

function LiveMic({ live }: { live: boolean }) {
  const level = useLevel();
  // Five gains on ONE level, each a frame behind the last (the system glyph's bars; not a pretend spectrum).
  const levels = useSampled((t) => (live ? GAINS.map((g, i) => Math.max(0.08, Math.min(1, level(t - i * 18, "you") * g * 1.25))) : undefined), 33, [live, level]);
  return <Icon name="mic" size={20} state={live ? "active" : "rest"} levels={levels} />;
}

function ErrorRow({ kind }: { kind: ErrorKind }) {
  const e = ERROR_COPY[kind];
  return (
    <div className="jn-dockrow jv-err" role="alert">
      <span className="jv-err__icon">
        <Icon name={e.icon} size={16} />
      </span>
      <span className="jn-dockrow__text jv-err__text">{e.text}</span>
      <button type="button" className="jb jb--secondary jb--sm">
        {e.verb}
      </button>
    </div>
  );
}

export type ComposerMode =
  | { kind: "text"; draft?: string; tip?: boolean; focused?: boolean }
  | { kind: "dictation"; phase: DictPhase; final?: string; interim?: string; error?: ErrorKind }
  | { kind: "voice"; phase: StringPhase; since?: number; typed?: string; answerer?: Talker; error?: ErrorKind };

export function VoiceComposer({
  mode,
  placeholder = "Reply…",
  label = "Message Juno",
  modelLabel = "Auto",
  memberDisc = false,
  onVoice,
  onEnd,
  onMute,
  onDictate,
}: {
  mode: ComposerMode;
  placeholder?: string;
  label?: string;
  modelLabel?: string;
  /** In a member's thread the armed disc wears the member's colour (member.css). */
  memberDisc?: boolean;
  onVoice?: () => void;
  onEnd?: () => void;
  onMute?: () => void;
  onDictate?: () => void;
}) {
  const reduced = useReduced();
  const clock = useClock();
  const voice = mode.kind === "voice" && mode.phase !== "ended";
  const dict = mode.kind === "dictation" ? mode : null;
  const dictLive = !!dict && (dict.phase === "listening" || dict.phase === "interim");
  const muted = mode.kind === "voice" && mode.phase === "muted";
  const voicePhase = mode.kind === "voice" ? mode.phase : null;
  // When a caller does not say when a phase began, it began when it first rendered.
  const [auto, setAuto] = React.useState(() => ({ phase: voicePhase, at: clock.now() }));
  if (auto.phase !== voicePhase) setAuto({ phase: voicePhase, at: clock.now() });
  const autoSince = auto.at;

  const draft = mode.kind === "text" ? (mode.draft ?? "") : mode.kind === "dictation" ? (mode.final ?? "") + (mode.interim ?? "") : (mode.typed ?? "");
  const hasWords = draft.length > 0;
  // While you dictate, the disc already wears send (what comes next), quiet until the words are final:
  // never the voice glyph beside the live mic's bars, which would be the same drawing twice.
  const dictActive = !!dict && (dict.phase === "permission" || dict.phase === "listening" || dict.phase === "interim" || dict.phase === "finalizing");
  const discMode: "voice" | "send" | "end" = voice ? "end" : hasWords || dictActive ? "send" : "voice";
  const discQuiet = dictActive;

  const words = mode.kind === "voice" ? VOICE_WORDS[mode.phase] : dict ? (dictLive ? "Listening" : dict.phase === "done" ? "Stopped listening" : dict.phase === "error" ? "Dictation stopped" : "") : "";
  const describedBy = React.useId();
  const error = mode.kind === "dictation" ? mode.error : mode.kind === "voice" ? mode.error : undefined;
  const swap = reduced ? R : T.fast;

  return (
    <div className="jn-composer-wrap jv-wrap" data-variant="dock">
      <div
        className="jn-composer jv-composer"
        data-variant="dock"
        data-voice={voice ? voicePhase : undefined}
        data-dict={dict ? dict.phase : undefined}
        data-focus={dict || (mode.kind === "text" && mode.focused) || (mode.kind === "voice" && mode.typed) ? "" : undefined}
        data-dock={error ? "" : undefined}
      >
        {error ? <ErrorRow kind={error} /> : null}

        <div className="jn-field jv-field" role="textbox" aria-multiline="true" aria-label={label} tabIndex={0}>
          {dict && (dict.final || dict.interim || dictLive) ? (
            <div className="jn-sentence jv-dictated">
              {dict.final ? <span className="jv-final">{dict.final}</span> : null}
              {dict.interim ? <span className="jv-interim">{dict.interim}</span> : null}
              {dictLive ? <ListeningCaret /> : dict.phase === "done" ? <span className="jn-caret" /> : null}
            </div>
          ) : hasWords ? (
            <div className="jn-sentence">
              {draft}
              {mode.kind === "text" && mode.focused ? <span className="jn-caret" /> : null}
            </div>
          ) : (
            <div className="jn-field__placeholder">
              <AnimatePresence initial={false} mode="popLayout">
                <motion.span key={voice ? "v" : "t"} aria-hidden="true" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={reduced ? R : T.fast}>
                  {voice ? "Add to the conversation" : placeholder}
                </motion.span>
              </AnimatePresence>
            </div>
          )}
          {voice && hasWords ? (
            <button type="button" className="jib jib--sm jv-fieldsend" aria-label="Add to the conversation">
              <Icon name="send" size={16} />
            </button>
          ) : null}
        </div>

        <div className="jn-crow jv-row" role={voice ? "group" : undefined} aria-label={voice ? "Voice conversation" : undefined} aria-describedby={voice ? describedBy : undefined}>
          <button type="button" className="jib jicon-trigger jn-crow__add jtip" data-tip="Add files and more" data-tip-side="top" aria-label="Add files, photos and more">
            <Icon name="plus" size={20} />
          </button>

          {/* The middle of the row: empty in the text composer, the string in a call. */}
          <span className="jn-crow__spacer jv-mid">
            <AnimatePresence initial={false}>
              {mode.kind === "voice" ? (
                <motion.span
                  key="string"
                  className="jv-mid__string"
                  initial={{ opacity: 1 }}
                  exit={{ opacity: 0, transition: { duration: 0.16, delay: 0.36 } }}
                >
                  <VoiceString phase={mode.phase} since={mode.since ?? autoSince} answerer={mode.answerer} />
                </motion.span>
              ) : null}
            </AnimatePresence>
          </span>

          <AnimatePresence initial={false} mode="popLayout">
            {voice ? (
              <motion.span
                key="voice-controls"
                className="jv-controls"
                initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, transition: reduced ? R : T.exit }}
                transition={reduced ? R : T.base}
              >
                <button
                  type="button"
                  className="jib jicon-trigger jtip jv-mute"
                  aria-pressed={muted}
                  aria-label={muted ? "Unmute microphone" : "Mute microphone"}
                  data-tip={muted ? "Unmute" : "Mute"}
                  data-tip-side="top"
                  onClick={onMute}
                >
                  <Icon name={muted ? "mic-off" : "mic"} size={20} />
                </button>
                <button type="button" className="jib jicon-trigger jtip" aria-haspopup="menu" aria-label="Sound output: MacBook Pro speakers" data-tip="MacBook Pro speakers" data-tip-side="top">
                  <Icon name="read-aloud" size={20} />
                </button>
              </motion.span>
            ) : (
              <motion.span
                key="text-controls"
                className="jv-controls"
                initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, transition: reduced ? R : T.exit }}
                transition={reduced ? R : T.base}
              >
                <button type="button" className="jn-model jicon-trigger" aria-haspopup="dialog" aria-expanded={false}>
                  <span className="jn-model__name">{modelLabel}</span>
                  <Icon name="chevron-down" size={16} />
                </button>
                <button
                  type="button"
                  className={["jib jicon-trigger jtip jv-dict", mode.kind === "text" && mode.tip ? "jv-tip-on" : ""].join(" ")}
                  aria-pressed={dictLive}
                  aria-label={dictLive ? "Stop dictating" : "Dictate"}
                  aria-keyshortcuts="Meta+Shift+Space"
                  data-tip={dictLive ? "Stop dictating" : "Dictate"}
                  data-kbd="⌘⇧Space"
                  data-tip-side="top"
                  data-live={dictLive ? "" : undefined}
                  data-waiting={dict?.phase === "permission" ? "" : undefined}
                  onClick={onDictate}
                >
                  <LiveMic live={dictLive} />
                </button>
              </motion.span>
            )}
          </AnimatePresence>

          <button
            type="button"
            className={["jn-disc jicon-trigger", memberDisc ? "jn-disc--member" : ""].join(" ")}
            data-mode={discMode === "end" ? "send" : discMode}
            data-end={discMode === "end" ? "" : undefined}
            data-quiet={discQuiet ? "" : undefined}
            aria-disabled={discQuiet || undefined}
            aria-label={discMode === "end" ? "End voice conversation" : discMode === "send" ? "Send message" : "Start a voice conversation"}
            aria-keyshortcuts={discMode === "end" ? "Escape" : undefined}
            onClick={discMode === "end" ? onEnd : discMode === "voice" ? onVoice : undefined}
          >
            <AnimatePresence initial={false} mode="popLayout">
              <motion.span
                key={discMode}
                className="jn-disc__glyph"
                initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.8 }}
                transition={swap}
              >
                <Icon name={discMode === "end" ? "close" : discMode === "send" ? "send" : "voice"} size={20} />
              </motion.span>
            </AnimatePresence>
          </button>
        </div>
      </div>
      <span id={describedBy} className="sr">
        {words}
      </span>
      {words ? <StateAnnouncer words={words} /> : null}
    </div>
  );
}
