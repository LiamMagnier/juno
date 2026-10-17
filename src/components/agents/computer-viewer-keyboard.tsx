"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { usePhrase } from "@/lib/i18n-phrase";
import { cn } from "@/lib/utils";

/*
 * Typing on the agent's computer from a touch screen, and pasting into it
 * from anywhere.
 *
 * noVNC reads keys from its canvas, which a phone never raises a keyboard
 * for, so a person who took control to type a 2FA code could not. The
 * Keyboard button focuses a hidden text field instead, and everything typed
 * into it is forwarded as X keysyms through `rfb.sendKey`. The Type text
 * field puts text on the remote clipboard (`rfb.clipboardPasteFrom`) and then
 * types it, so a password copied from a password manager reaches a field that
 * blocks paste too. Nothing typed here is kept: the hidden field is reset
 * after every keystroke and the text field is cleared once it is sent.
 *
 * The keysym rules are pure and exported for tests/computer-viewer-input.test.ts.
 */

/** X keysyms for the keys a soft keyboard sends that are not text. */
export const KEYSYMS = {
  BackSpace: 0xff08,
  Tab: 0xff09,
  Return: 0xff0d,
  Escape: 0xff1b,
  Delete: 0xffff,
  Home: 0xff50,
  Left: 0xff51,
  Up: 0xff52,
  Right: 0xff53,
  Down: 0xff54,
  PageUp: 0xff55,
  PageDown: 0xff56,
  End: 0xff57,
} as const;

const SPECIAL_KEYS: Record<string, number> = {
  Backspace: KEYSYMS.BackSpace,
  Tab: KEYSYMS.Tab,
  Enter: KEYSYMS.Return,
  Escape: KEYSYMS.Escape,
  Delete: KEYSYMS.Delete,
  Home: KEYSYMS.Home,
  End: KEYSYMS.End,
  PageUp: KEYSYMS.PageUp,
  PageDown: KEYSYMS.PageDown,
  ArrowLeft: KEYSYMS.Left,
  ArrowUp: KEYSYMS.Up,
  ArrowRight: KEYSYMS.Right,
  ArrowDown: KEYSYMS.Down,
};

/**
 * The keysym for one character: Latin-1 maps to itself, a newline is Return,
 * a tab is Tab, anything else in Unicode is 0x01000000 + its code point (the
 * X convention x11vnc understands). Other control characters have none.
 */
export function keysymForChar(char: string): number | null {
  const code = char.codePointAt(0);
  if (code === undefined) return null;
  if (code === 0x0a || code === 0x0d) return KEYSYMS.Return;
  if (code === 0x09) return KEYSYMS.Tab;
  if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) return code;
  if (code > 0xff) return 0x01000000 + code;
  return null;
}

/** The keysym for a `KeyboardEvent.key` that is not text (Enter, Backspace, arrows…), or null. */
export function keysymForKey(key: string): number | null {
  return SPECIAL_KEYS[key] ?? null;
}

/** What the viewer hands this file: the live RFB, or the part of it typing needs. */
export interface KeySink {
  sendKey(keysym: number, code: string | null, down?: boolean): void;
  clipboardPasteFrom?(text: string): void;
}

/** Types `text` one character at a time ("\r\n" is one Return). Returns how many keys were sent. */
export function typeText(sink: KeySink, text: string): number {
  let sent = 0;
  const normalised = text.replace(/\r\n?/g, "\n");
  for (const char of normalised) {
    const keysym = keysymForChar(char);
    if (keysym === null) continue;
    sink.sendKey(keysym, null);
    sent++;
  }
  return sent;
}

/** Puts `text` on the remote clipboard, then types it. */
export function pasteAndType(sink: KeySink, text: string): number {
  if (!text) return 0;
  try {
    sink.clipboardPasteFrom?.(text);
  } catch {
    // Typing still lands where paste is not supported.
  }
  return typeText(sink, text);
}

/**
 * One `input` event from the hidden field, forwarded. Returns whether it
 * sent anything. A composition in progress (an IME, dictation) is left to
 * `compositionend`.
 */
export function forwardInputEvent(
  sink: KeySink,
  event: { inputType?: string; data?: string | null; isComposing?: boolean }
): boolean {
  if (event.isComposing) return false;
  switch (event.inputType) {
    case "deleteContentBackward":
    case "deleteWordBackward":
    case "deleteSoftLineBackward":
      sink.sendKey(KEYSYMS.BackSpace, "Backspace");
      return true;
    case "deleteContentForward":
      sink.sendKey(KEYSYMS.Delete, "Delete");
      return true;
    case "insertLineBreak":
    case "insertParagraph":
      sink.sendKey(KEYSYMS.Return, "Enter");
      return true;
    default:
      return event.data ? typeText(sink, event.data) > 0 : false;
  }
}

/**
 * A keydown in the hidden field: the keys that produce no text (Enter on a
 * hardware keyboard, Tab, Escape, the arrows) are sent here and kept out of
 * the field. Keys an IME is handling (keyCode 229) and shortcuts are left.
 */
export function forwardKeyDown(
  sink: KeySink,
  event: { key: string; keyCode?: number; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; isComposing?: boolean }
): boolean {
  if (event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return false;
  const keysym = keysymForKey(event.key);
  if (keysym === null) return false;
  sink.sendKey(keysym, event.key === "Enter" ? "Enter" : null);
  return true;
}

/*
 * The hidden field keeps one character in it, so a soft keyboard's Backspace
 * on an "empty" field still raises `deleteContentBackward` (many send nothing
 * for a field that is truly empty).
 */
const SENTINEL = " ";

function resetField(field: HTMLInputElement) {
  field.value = SENTINEL;
  try {
    field.setSelectionRange(SENTINEL.length, SENTINEL.length);
  } catch {
    // not every input type supports a selection
  }
}

/**
 * The Keyboard button, its hidden field, and the Type text field. Shown only
 * while the person has control; `getSink` returns the live RFB (or null
 * while it is connecting, when keys are dropped rather than queued).
 */
export function ComputerViewerKeyboard({
  getSink,
  disabled = false,
  tone = "surface",
  className,
}: {
  getSink: () => KeySink | null;
  disabled?: boolean;
  /** "stage": on the dark full-bleed footer; "surface": on the page. */
  tone?: "stage" | "surface";
  className?: string;
}) {
  const fieldRef = React.useRef<HTMLInputElement | null>(null);
  const [typing, setTyping] = React.useState(false);
  const [pasteOpen, setPasteOpen] = React.useState(false);
  const [paste, setPaste] = React.useState("");
  const typeOnLabel = usePhrase("Type on the computer");
  const pasteLabel = usePhrase("Text to type on the computer");

  React.useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    const onInput = (event: Event) => {
      const input = event as InputEvent;
      const sink = getSink();
      if (sink) forwardInputEvent(sink, { inputType: input.inputType, data: input.data, isComposing: input.isComposing });
      if (!input.isComposing) resetField(field);
    };
    const onCompositionEnd = (event: CompositionEvent) => {
      const sink = getSink();
      if (sink && event.data) typeText(sink, event.data);
      resetField(field);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const sink = getSink();
      if (sink && forwardKeyDown(sink, event)) event.preventDefault();
    };
    field.addEventListener("input", onInput);
    field.addEventListener("compositionend", onCompositionEnd);
    field.addEventListener("keydown", onKeyDown);
    return () => {
      field.removeEventListener("input", onInput);
      field.removeEventListener("compositionend", onCompositionEnd);
      field.removeEventListener("keydown", onKeyDown);
    };
  }, [getSink]);

  const startTyping = () => {
    const field = fieldRef.current;
    if (!field) return;
    resetField(field);
    // Focus inside the tap's own handler: iOS raises the keyboard only then.
    field.focus({ preventScroll: true });
    setTyping(true);
  };

  const sendPaste = (event: React.FormEvent) => {
    event.preventDefault();
    const sink = getSink();
    if (!sink || !paste) return;
    pasteAndType(sink, paste);
    setPaste("");
    setPasteOpen(false);
  };

  const buttonClass =
    tone === "stage"
      ? "computer-viewer__chip rounded-full px-3 coarse:min-h-11"
      : "rounded-full px-3 coarse:min-h-11";

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <input
        ref={fieldRef}
        type="text"
        aria-label={typeOnLabel}
        className="computer-viewer__keyproxy"
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="enter"
        defaultValue={SENTINEL}
        disabled={disabled}
        onBlur={() => setTyping(false)}
        tabIndex={-1}
      />
      <Button
        type="button"
        size="sm"
        variant={tone === "stage" ? "ghost" : "outline"}
        className={buttonClass}
        aria-pressed={typing}
        disabled={disabled}
        onClick={startTyping}
      >
        Keyboard
      </Button>
      <Button
        type="button"
        size="sm"
        variant={tone === "stage" ? "ghost" : "outline"}
        className={buttonClass}
        aria-expanded={pasteOpen}
        disabled={disabled}
        onClick={() => setPasteOpen((open) => !open)}
      >
        Type text
      </Button>
      {pasteOpen ? (
        <form onSubmit={sendPaste} className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
          <input
            type="text"
            value={paste}
            onChange={(event) => setPaste(event.target.value)}
            aria-label={pasteLabel}
            placeholder="Paste or type, then send"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="computer-viewer__paste min-w-0 flex-1 rounded-control px-3 py-1.5 text-ui coarse:min-h-11 sm:w-56"
            // Clipboard text lives here only until it is sent.
            data-no-auto-translate
          />
          <Button type="submit" size="sm" className="rounded-full px-3 coarse:min-h-11" disabled={!paste || disabled}>
            Send
          </Button>
        </form>
      ) : null}
    </div>
  );
}
