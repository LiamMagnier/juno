"use client";

import * as React from "react";
import { Loader2, Send } from "@/components/ui/icons";

import { Button } from "@/components/ui/button";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { RealtimeVoice, voiceCallParts, type VoiceCallParts } from "@/components/voice/realtime-voice";
import { useOptionalApp } from "@/components/app/app-provider";
import { useRealtimeVoice } from "@/hooks/use-realtime-voice";
import { ActionIcons } from "@/lib/app-icons";
import { PLANS } from "@/lib/plans";
import {
  buildCodeVoiceBriefing,
  codeVoiceAutoSendQueue,
  codeVoiceCatchUp,
  codeVoiceReadBack,
  type CodeVoiceBriefingInput,
} from "@/components/code/code-voice-briefing";
import { PRODUCT_NAME } from "@/lib/brand/names";

/*
 * Voice mode for Juno Code — the launcher's gate, and the live call.
 *
 * Both Code surfaces mount this: the landing composer at /code, where the call
 * is about deciding what to ask for, and a live session, where it is about what
 * the run did. One file because the two composers have to agree — the
 * alternative was two panels describing the same arrangement in different words
 * on adjacent screens.
 *
 * ── What this is NOT ───────────────────────────────────────────────────────
 *
 * Chat persists its whole voice transcript: `closeVoice` POSTs to
 * /api/voice/transcript, which writes USER/ASSISTANT Message rows and will
 * CREATE the conversation when there isn't one. That works there because a chat
 * conversation IS a list of messages, so the transcript and the thing it makes
 * are the same type. A code session is not: it is a workspace or a repo, a
 * prompt, and a run. The transcript route has no `kind` check, so pointing it
 * at a kind:"code" conversation would succeed and drop plain chat rows into a
 * code session's transcript, rendered as though Juno Code had said them, with
 * no run, no diff and no approval behind any of it.
 *
 * So this follows the Work thread's arrangement instead: talk freely, and the
 * only thing that ever leaves the call is the one line you deliberately hand
 * over. Nothing else is kept — which the panel says on screen, because a user
 * who talked for five minutes deserves to know that before they hang up.
 */

/**
 * Open / closed for the voice call, in the shape a composer's primary action
 * wants.
 *
 * `onOpenVoiceMode` is deliberately `undefined` — never a no-op — whenever
 * voice is unavailable or already live. Every composer in the product decides
 * whether its primary button is a voice launcher by testing the mere existence
 * of this prop (`showVoiceButton` in chat/composer.tsx:589 and
 * work-thread-composer.tsx:273), so a defined-but-inert handler leaves wave
 * bars on a build with no relay and a second launcher pointing at a call that
 * is already on screen.
 *
 * The plan check is here and not optional. `useWorkVoice` gates only on the
 * relay URL, so on a free plan its launcher draws, the panel mounts, and
 * /api/voice/relay-token answers 403 "Voice mode requires a paid plan." — a
 * sentence that lands inside an opened voice panel instead of a button that
 * never appeared. Chat gets this right (`PLANS[quota.plan].voice` in
 * chat-view.tsx:1198) and Code copies chat, not Work.
 */
export function useCodeVoice({ disabled = false }: { disabled?: boolean } = {}): {
  /** True when the panel should be mounted. */
  open: boolean;
  /** Pass straight to the composer. Undefined means "draw no voice affordance". */
  onOpenVoiceMode: (() => void) | undefined;
  /** Hand to the panel's `onClose`. */
  close: () => void;
} {
  // Optional: the Code v2 composer also renders in galleries and tests with no
  // app provider, where there is no plan to ask and so no voice.
  const plan = useOptionalApp()?.quota.plan;
  const [open, setOpen] = React.useState(false);
  // Read as a whole member expression: Next inlines NEXT_PUBLIC_* at build
  // time by textual substitution, so destructuring `process.env` first would
  // leave nothing to substitute and voice would be off in every build.
  const configured = Boolean(process.env.NEXT_PUBLIC_VOICE_RELAY_URL);
  const available = configured && !!plan && PLANS[plan].voice;

  const openVoice = React.useCallback(() => setOpen(true), []);
  const close = React.useCallback(() => setOpen(false), []);

  return {
    // Gating the mount as well as the launcher keeps the two in step if the
    // page's own `disabled` flips while a call is live.
    open: open && available,
    onOpenVoiceMode: available && !open && !disabled ? openVoice : undefined,
    close,
  };
}

/** What handing a spoken line over actually does, on each surface. */
export interface CodeVoiceSend {
  /** "start" creates the session; "send" gives an existing one its next task. */
  intent: "start" | "send";
  /**
   * The app's reason it cannot accept a line right now — the composer's own
   * gate sentence. Shown in place of the button, because a disabled button that
   * cannot say why is the thing this surface already had too many of.
   */
  blockedReason?: string | null;
  /** A send is already in flight elsewhere on the page. Locks the button. */
  sending?: boolean;
  /**
   * True when a successful send navigates away — the landing composer pushes to
   * the new session. The panel then ends the call itself before handing over,
   * so the microphone is released deliberately rather than by the unmount that
   * `useRealtimeVoice` cleans up after.
   */
  endsCall?: boolean;
  /**
   * The page's own send path. Resolves true when the words landed, false when
   * they did not — a refusal leaves the line on screen to be sent again.
   */
  onSend: (text: string) => Promise<boolean>;
}

/** The session's side of the call: whether a run is working, and its newest reply. */
export interface CodeVoiceReply {
  running: boolean;
  /** The newest assistant text in the thread, or null before there is one. */
  latest: string | null;
}

export interface CodeVoicePanelProps {
  briefing: CodeVoiceBriefingInput;
  /** Omit to offer no way in at all: the call is then read-only. */
  send?: CodeVoiceSend;
  /**
   * The thread, so a finished run's reply is spoken back. Omit where there is
   * no thread yet (the landing, which hands over and ends the call).
   */
  reply?: CodeVoiceReply;
  /** Ends the call and unmounts this. Always offered; never automatic. */
  onClose: () => void;
}

function intentSentence(send: CodeVoiceSend): string {
  return send.intent === "start"
    ? "Nothing has started yet. Sending starts the session and hands it this message"
    : "This goes to the session as its next instruction";
}

function sendButtonLabel(send: CodeVoiceSend): string {
  return send.intent === "start" ? "Start the session with this" : "Send this to the session";
}

/**
 * The live call.
 *
 * Mounted only while it is open, and that is not tidiness: `useRealtimeVoice`
 * holds a microphone, a socket and two AudioContexts, and a code session
 * already re-renders on every streamed frame.
 *
 * THE AURA IS NOT HERE ANY MORE. It used to be the first child of this
 * fragment, on the theory that a `z-index: -1` layer had to be a sibling of the
 * composer to sit behind it. That has been false since the layer was portalled
 * to <body> and given `--z-aura`, and it is now mounted once for the whole app
 * in `(app)/layout.tsx` and driven by `lib/aura.ts` — this panel publishes
 * nothing, because `useRealtimeVoice` publishes for every surface that runs a
 * call.
 */
export function CodeVoicePanel({ briefing, send, reply, onClose }: CodeVoicePanelProps) {
  const voice = useRealtimeVoice();

  /** The digest of what the model has actually been told, briefing or catch-up. */
  const [toldDigest, setToldDigest] = React.useState<string | null>(null);
  const [sentLineIds, setSentLineIds] = React.useState<readonly number[]>([]);
  const [sending, setSending] = React.useState(false);
  const [sendFailed, setSendFailed] = React.useState(false);
  /** Exact texts pushed as context, so they can be kept out of the transcript. */
  const contextPushes = React.useRef<Set<string>>(new Set());

  // Start once, with the briefing as it stands at the press. `start` is
  // deliberately absent from the dependency list: the hook rebuilds that
  // callback whenever the provider or status changes, and following it here
  // would restart the session — microphone, socket and all — mid-conversation.
  const startedRef = React.useRef(false);
  const voiceRef = React.useRef(voice);
  voiceRef.current = voice;
  const briefingRef = React.useRef(briefing);
  briefingRef.current = briefing;
  React.useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const built = buildCodeVoiceBriefing(briefingRef.current);
    setToldDigest(built.digest);
    void voiceRef.current.start(undefined, built.entries);
  }, []);

  /*
   * Has the session moved on since the model was briefed?
   *
   * On a timer rather than derived from the briefing prop, and the difference
   * matters here in a way it does not on the Work thread. A code session's
   * message array is rebuilt on every streamed token, so a `useMemo` keyed on
   * it would re-render the whole briefing — several kilobytes through two
   * regexes — tens of times a second, to answer a question whose only consumer
   * is a banner a human reads. Four seconds is far below the rate anyone can
   * act, and the work is now bounded no matter how fast the run streams.
   */
  const [liveDigest, setLiveDigest] = React.useState<string | null>(null);
  React.useEffect(() => {
    const tick = () => setLiveDigest(buildCodeVoiceBriefing(briefingRef.current).digest);
    tick();
    const id = window.setInterval(tick, 4_000);
    return () => window.clearInterval(id);
  }, []);
  const staleBy = toldDigest !== null && liveDigest !== null && toldDigest !== liveDigest;

  const catchUp = React.useCallback(() => {
    const text = codeVoiceCatchUp(briefingRef.current);
    if (!voiceRef.current.sendText(text)) return;
    contextPushes.current.add(text);
    // Both, from one build: setting only what was told would leave the banner
    // up until the next tick, on a control whose whole job is to dismiss it.
    const digest = buildCodeVoiceBriefing(briefingRef.current).digest;
    setToldDigest(digest);
    setLiveDigest(digest);
  }, []);

  /*
   * The visible transcript. Context pushes are filtered by exact text: they
   * travel as `input.text`, which the relay echoes back as a user line —
   * correct for the model, wrong for the reader, who would find a paragraph of
   * status they never said sitting in their own half of the conversation.
   */
  const lines = React.useMemo(
    () => voice.transcript.filter((line) => !contextPushes.current.has(line.text.trim())),
    [voice.transcript],
  );

  /** The last thing the reader finished saying, and has not already sent. */
  const sendable = React.useMemo(() => {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line.role !== "user" || !line.final || !line.text.trim()) continue;
      return sentLineIds.includes(line.id) ? null : line;
    }
    return null;
  }, [lines, sentLineIds]);

  const close = React.useCallback(() => {
    voiceRef.current.end();
    onClose();
  }, [onClose]);
  const closeRef = React.useRef(close);
  closeRef.current = close;

  /*
   * AUTO-SEND (the owner's choice, 2026-10-10): every sentence the reader
   * finishes becomes the session's next turn on its own, like a voice call
   * with ChatGPT, through the page's own send (a new turn, or a steer or
   * queued follow-up while a run works). A line that does not land stays on
   * screen with a retry, so nothing said is lost.
   */
  const handled = React.useRef<Set<number>>(new Set());
  const sendRef = React.useRef(send);
  sendRef.current = send;
  React.useEffect(() => {
    const current = sendRef.current;
    if (!current || current.blockedReason) return;
    const queue = codeVoiceAutoSendQueue(lines, handled.current);
    if (!queue.length) return;
    for (const line of queue) handled.current.add(line.id);
    void (async () => {
      for (const line of queue) {
        setSending(true);
        try {
          const landed = await current.onSend(line.text);
          if (landed) {
            setSentLineIds((ids) => [...ids, line.id]);
            setSendFailed(false);
            if (current.endsCall) {
              closeRef.current();
              return;
            }
          } else setSendFailed(true);
        } finally {
          setSending(false);
        }
      }
    })();
  }, [lines]);

  /*
   * READ THE REPLY BACK. When a run this call can see finishes, its newest
   * reply goes to the voice model to say out loud. The push travels as a user
   * line and is kept out of the transcript and out of auto-send.
   */
  const wasRunning = React.useRef(reply?.running ?? false);
  const lastSpoken = React.useRef<string | null>(reply?.latest ?? null);
  React.useEffect(() => {
    const was = wasRunning.current;
    wasRunning.current = reply?.running ?? false;
    if (!reply || !was || reply.running) return;
    const latest = reply.latest?.trim();
    if (!latest || latest === lastSpoken.current) return;
    lastSpoken.current = latest;
    const text = codeVoiceReadBack(latest);
    if (voiceRef.current.sendText(text)) contextPushes.current.add(text.trim());
  }, [reply?.running, reply?.latest, reply]);

  /*
   * FOLLOW THE CONVERSATION.
   *
   * The transcript is a bounded 14rem box. Without this, every line the model
   * speaks after the box fills lands below the fold and the reader watches a
   * frozen viewport during a live call — the one surface where new text arrives
   * without the reader touching anything.
   *
   * The viewport's own `scrollTop` is set directly rather than calling
   * `scrollIntoView` on a sentinel: this panel sits inside a page-level
   * `overflow-y-auto` on the landing, and `scrollIntoView` walks EVERY scrollable
   * ancestor — so pinning the transcript would also yank the page under the
   * reader on each spoken word.
   */
  const transcriptRef = React.useRef<HTMLDivElement>(null);
  // Keyed on the tail's text as well as the count: a partial line is REWRITTEN
  // in place as it is spoken, so a count-only dependency would pin the view once
  // per utterance and then let the line grow off the bottom.
  const tail = lines.length > 0 ? lines[lines.length - 1].text : "";
  React.useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length, tail]);


  const submit = React.useCallback(async () => {
    if (!send || !sendable || sending || send.sending || send.blockedReason) return;
    setSending(true);
    setSendFailed(false);
    try {
      handled.current.add(sendable.id);
      const landed = await send.onSend(sendable.text.trim());
      if (!landed) {
        // Deliberately still live. A refusal is the one case where the words
        // and the microphone both need to still be there.
        setSendFailed(true);
        return;
      }
      setSentLineIds((current) => [...current, sendable.id]);
      // Hang up on the way out rather than letting the route change do it: the
      // hook's unmount teardown would get there eventually, but only after the
      // new screen has mounted with a microphone still open behind it.
      if (send.endsCall) close();
    } finally {
      setSending(false);
    }
  }, [close, send, sendable, sending]);

  return (
    <>
      {/* `rounded-field` + `px-3 py-2.5` + `bg-muted`, which is the recipe the
          four other cards stacked in this column use (the queued note, the
          changed-files list, the agent cards and the approval card). This panel
          was the odd one out at `rounded-card p-3 bg-card/80` — a different
          radius, a different inset and, on the true-black ground, a fill that
          composited BELOW the composer it sits on top of.

          `mx-1` is the last part of that recipe and was the last thing still
          missing: the four siblings are inset 4px from the composer they stack
          on, and this panel — the tallest of them — ran the full width, so the
          one card that most obviously reads as a stack was the one that broke
          the stack's left and right edges. `w-full` goes with it; a block
          <section> already fills its host, and keeping both would have pushed
          the panel 8px wider than the column. */}
      <section
        aria-label="Voice conversation about this code session"
        className="mx-1 mb-2 flex flex-col gap-3 rounded-field border border-border/70 bg-muted px-3 py-2.5 motion-safe:animate-rise-in"
      >
        {/* The arrangement, stated plainly and kept on screen. Not a tooltip and
            not a one-time notice: it has to be readable at the moment somebody
            decides whether to believe what they just heard, and at the moment
            they decide whether it is safe to hang up. */}
        <p className="text-caption leading-relaxed text-muted-foreground">
          {send
            ? send.endsCall
              ? "Say what you want built. When you finish a sentence it starts the session, and this call ends."
              : `Each sentence you finish goes to the session as its next instruction, and ${PRODUCT_NAME} reads the reply back when the run is done.`
            : `${PRODUCT_NAME} was told where this runs${briefing.turns.length > 0 ? " and how the session has gone so far" : ""}. It can\u2019t see your code or run anything.`}
        </p>

        {staleBy && (
          /* `bg-accent` — one rung further from the page than the panel's own
             `bg-muted`, in both themes (light steps down 95→92%, dark steps up
             9.5→13%). The old `bg-muted/40` was a recess, and on a 0%-lightness
             ground there is no headroom left below the panel to recess into. */
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-border/60 bg-accent px-3 py-2">
            <p className="font-mono text-label text-muted-foreground">
              {`This has moved on since ${PRODUCT_NAME} was briefed`}
            </p>
            <Button type="button" variant="outline" size="sm" onClick={catchUp} className="gap-2 coarse:h-11">
              <ActionIcons.refresh className="size-3.5" aria-hidden="true" />
              {`Bring ${PRODUCT_NAME} up to date`}
            </Button>
          </div>
        )}

        {lines.length > 0 && (
          // ScrollFade rather than a bare `overflow-y-auto`: this is a bounded
          // region whose content grows on its own, so it needs the "there is
          // more this way" edge the project picker's bounded list already has.
          <ScrollFade className="max-h-56" viewportClassName="pr-1" viewportRef={transcriptRef}>
            {/* Each line rises in once, when it is first spoken — keyed by id,
                so a partial line rewritten in place as it is spoken does not
                replay its entrance on every word. */}
            <div className="space-y-3">
              {lines.map((line) =>
                line.role === "user" ? (
                  <div key={line.id} className="flex justify-end motion-safe:animate-fade-in-up">
                    <p className="max-w-[85%] whitespace-pre-wrap rounded-control bg-secondary px-3 py-2 text-ui leading-relaxed text-secondary-foreground">
                      {line.text}
                    </p>
                  </div>
                ) : (
                  <p key={line.id} className="whitespace-pre-wrap text-ui leading-relaxed text-foreground motion-safe:animate-fade-in-up">
                    {line.text}
                  </p>
                ),
              )}
            </div>
          </ScrollFade>
        )}

        {send && sendable && (sendFailed || !!send.blockedReason) && (
          <div className="flex flex-col gap-2 rounded-control border border-border/60 bg-accent p-2.5">
            {/* What the press does, before the press: starting a session and
                steering a running one are not the same event, and finding out
                afterwards is too late. */}
            <p className="font-mono text-label text-muted-foreground">{intentSentence(send)}</p>
            <p className="text-ui leading-relaxed text-foreground">{sendable.text}</p>
            <p className="text-caption text-muted-foreground">
              {`These exact words go over. ${PRODUCT_NAME}’s side of this call does not.`}
              {send.endsCall ? " Sending starts the session and ends this call." : ""}
            </p>
            {send.blockedReason ? (
              <p className="text-caption text-muted-foreground">{send.blockedReason}</p>
            ) : (
              <>
                {sendFailed && (
                  <p role="alert" className="text-caption text-destructive">
                    Those words didn&rsquo;t land. Try again, or type them in the box below.
                  </p>
                )}
                {/* No `size="sm"`. The line being handed over is irreversible
                    once sent, and the comparable commit controls in ApprovalCard
                    are deliberately h-11 for exactly that reason — this was a
                    32px target with no coarse growth. The default size's own
                    `coarse:h-11` now covers touch. */}
                <Button
                  type="button"
                  onClick={() => void submit()}
                  disabled={sending || send.sending === true}
                  className="self-end gap-2"
                >
                  {/* The glyph reports the state instead of sitting still
                      beside a label that changed — ApprovalCard's Allow does the
                      same while it waits. */}
                  {sending ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Send className="size-4" aria-hidden="true" />
                  )}
                  {sending ? "Sending…" : sendButtonLabel(send)}
                </Button>
              </>
            )}
          </div>
        )}

        <RealtimeVoice voice={voice} onClose={close} />
      </section>
    </>
  );
}

/**
 * A Code call drawn the way Chat's is (owner, 2026-10-10): inside the
 * composer, not as a panel. The composer takes the returned parts as Chat's
 * does (`voiceCall`: "Type while you talk…", the call's controls in the row,
 * End in Send's place while nothing is typed, the glow along its edge).
 *
 * What makes it Code's: every sentence the reader finishes goes to the thread
 * on its own (a new turn, or a steer or queued follow-up while a run works),
 * and when a run finishes its reply is handed to the voice model to say back.
 * Nothing said is filed as a chat: the thread is the record.
 */
export function useCodeVoiceCall({
  open,
  onClose,
  briefing,
  send,
  reply,
}: {
  open: boolean;
  onClose: () => void;
  briefing: CodeVoiceBriefingInput;
  send: CodeVoiceSend;
  reply?: CodeVoiceReply;
}): VoiceCallParts | undefined {
  const voice = useRealtimeVoice();
  const voiceRef = React.useRef(voice);
  voiceRef.current = voice;
  const briefingRef = React.useRef(briefing);
  briefingRef.current = briefing;
  const sendRef = React.useRef(send);
  sendRef.current = send;
  /** Read-back pushes travel as user lines; they are never sent to the thread. */
  const pushes = React.useRef<Set<string>>(new Set());
  const handled = React.useRef<Set<number>>(new Set());

  // Start once per opening, with the briefing as it stands; end on close.
  React.useEffect(() => {
    if (!open) return;
    handled.current = new Set();
    pushes.current = new Set();
    const built = buildCodeVoiceBriefing(briefingRef.current);
    void voiceRef.current.start(undefined, built.entries);
    return () => voiceRef.current.end();
  }, [open]);

  const close = React.useCallback(() => {
    voiceRef.current.end();
    onClose();
  }, [onClose]);
  const closeRef = React.useRef(close);
  closeRef.current = close;

  // Auto-send each finished sentence.
  React.useEffect(() => {
    if (!open) return;
    const current = sendRef.current;
    if (current.blockedReason) return;
    const lines = voice.transcript.filter((line) => !pushes.current.has(line.text.trim()));
    const queue = codeVoiceAutoSendQueue(lines, handled.current);
    if (!queue.length) return;
    for (const line of queue) handled.current.add(line.id);
    void (async () => {
      for (const line of queue) {
        const landed = await current.onSend(line.text);
        if (landed && current.endsCall) {
          closeRef.current();
          return;
        }
      }
    })();
  }, [open, voice.transcript]);

  // Read the reply back when a run finishes.
  const wasRunning = React.useRef(reply?.running ?? false);
  const lastSpoken = React.useRef<string | null>(reply?.latest ?? null);
  React.useEffect(() => {
    const was = wasRunning.current;
    wasRunning.current = reply?.running ?? false;
    if (!open || !reply || !was || reply.running) return;
    const latest = reply.latest?.trim();
    if (!latest || latest === lastSpoken.current) return;
    lastSpoken.current = latest;
    const text = codeVoiceReadBack(latest);
    if (voiceRef.current.sendText(text)) pushes.current.add(text.trim());
  }, [open, reply?.running, reply?.latest, reply]);

  return open ? voiceCallParts({ voice, onClose: close }) : undefined;
}
