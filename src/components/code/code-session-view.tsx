"use client";

import * as React from "react";

import { MessageList } from "@/components/chat/message-list";
import { ThoughtPanelProvider } from "@/components/chat/thought-panel-context";
import { splitEngaged } from "@/components/chat/split-layout";
import { CanvasPanel } from "@/components/canvas/canvas-panel";
import { CodeVoicePanel, useCodeVoice, type CodeVoiceSend } from "@/components/code/code-voice";
import type { CodeVoiceBriefingInput } from "@/components/code/code-voice-briefing";
import { CodeSessionBanner } from "@/components/code/code-session-banner";
import { CodeSessionComposer } from "@/components/code/code-session-composer";
import {
  CodeRunStack,
  totalChurn,
  useCurrentActivity,
  useSessionFileChanges,
} from "@/components/code/code-run-cards";
import { CodeSessionMenu } from "@/components/code/code-session-menu";
import { RunReviewPane } from "@/components/code/run-review";
import { useRunDetail } from "@/components/code/use-code-runs";
import { useCodeChecks } from "@/components/code/use-code-checks";
import { useCodeAutoFix } from "@/components/code/use-code-auto-fix";
import { useCodeTaskMeta, useDevicePresence } from "@/components/code/code-session-meta";
import { useApp } from "@/components/app/app-provider";
import { useUploads } from "@/hooks/use-uploads";
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";
import { useComposerAutosize } from "@/components/ui/composer-shell";
import { useCodeActivityContents } from "@/components/code/code-activity";
import { useCodeSession, isLiveId, type CodeRollbackVerb } from "@/hooks/use-code-session";
import { isDefaultCodeSessionTitle } from "@/lib/title-ownership";
import { clearPendingCodePrompt, peekPendingCodePrompt } from "@/lib/code-session-handoff";
import { Button } from "@/components/ui/button";
import { ActionIcons, CodeIcons } from "@/lib/app-icons";
import { DEFAULT_MODEL } from "@/lib/models";
import type { ReasoningEffort } from "@/lib/model-metrics";
import { cn } from "@/lib/utils";
import type {
  ClientArtifact,
  ClientAttachment,
  ClientConversation,
  ClientMessage,
  GenerationStatus,
} from "@/types/chat";

/*
 * The chat surface for a kind:"code" conversation. Same rendering language as
 * ChatView (MessageList/MessageItem are reused verbatim), but the composer
 * submits remote tasks that run with Juno Code on the user's Mac:
 * POST /api/code/tasks → SSE /api/code/tasks/[id]/events → /respond | /cancel.
 *
 * ── WHAT THIS FILE IS, AFTER THE SPLIT ─────────────────────────────────────
 *
 * It used to be 1,650 lines, of which about 1,100 were markup: a header, a
 * composer, four cards and two hooks, inlined in one function. The rules that
 * actually govern this surface — can it run, what does it run on, what happens
 * when it can't — were scattered between them, so reading "is the Mac
 * reachable" meant scrolling past an attachment tray.
 *
 * What is left here is only the orchestration: session state, the gates derived
 * from it, and the three regions those gates feed —
 *
 *   CodeSessionBanner    what this session is and what it is doing now
 *   CodeRunStack         what changed, who is helping, what needs an answer
 *   CodeSessionComposer  the next instruction
 *   RunReviewPane        the diff, docked as a column beside the transcript
 *
 * Everything below reads as one screen's worth of decisions, which is the point
 * of the split. Nothing about the transport, the task API or the event
 * vocabulary moved.
 *
 * ── THE DIFF IS A COLUMN IN HERE NOW ───────────────────────────────────────
 *
 * RunReviewPane used to mount from the run list and nowhere else, so the review
 * — files on the left, changes on the right, per-line notes — was reachable only
 * from a page that is going away, and a person reading their session had no way
 * to see what it had written beyond a collapsed card of filenames. It is the
 * third docked column now, on exactly the terms the thought dock and the canvas
 * already keep: an in-flow flex sibling, no z-index, the newest request wins.
 *
 * Its notes do NOT dispatch themselves. They land in a tray above the composer
 * and go out with whatever the reader types next, because a review is a draft
 * instruction and sending one nobody pressed send on was the behaviour this
 * replaced.
 */

interface CodeSessionViewProps {
  conversation: ClientConversation;
  initialMessages: ClientMessage[];
  /**
   * The conversation's artifacts, loaded by the page alongside the messages.
   *
   * Passed down rather than fetched here, and that is the whole point: the page
   * already reads them in `getConversationThread`, so a fetch on this side would
   * be a SECOND data path for one set of rows, with its own loading state and
   * its own opportunity to disagree with the first. This surface used to hand
   * `MessageList` a literal `[]` and a no-op opener, which meant an artifact
   * card in a code transcript rendered and then did nothing when pressed.
   */
  initialArtifacts: ClientArtifact[];
}

export function CodeSessionView({ conversation, initialMessages, initialArtifacts }: CodeSessionViewProps) {
  const { setActiveConversationId, updateConversation, conversations, features, settings } = useApp();
  const workspaceName = conversation.codeWorkspaceName?.trim() || "Code session";
  const workspacePath = conversation.codeWorkspacePath ?? null;
  const workspaceKey = conversation.codeWorkspaceKey ?? null;
  const meta = useCodeTaskMeta(conversation.id);
  const isCloud = meta.isCloud;
  /*
   * WHICH KIND OF SESSION THIS IS, IS NOT KNOWN YET.
   *
   * `meta.loaded` was declared, set and never read, so `isCloud` starting false
   * meant every cloud session opened wearing the device UI for one fetch
   * round-trip: a Folder glyph, the repo's "owner/name" printed in the mono slot
   * as if it were a path on disk, a "Checking your Mac…" pill, and a footer
   * promising it runs on your Mac. Then it all flipped. Guessing device and
   * correcting is worse than saying we are still looking, so everything that
   * differs between the two waits here.
   */
  const resolving = !meta.loaded;
  const { presence, refresh: refreshPresence } = useDevicePresence(
    workspaceKey,
    conversation.codeWorkspaceName?.trim() || null,
    !(meta.loaded && meta.isCloud),
  );
  const cloudRepoFull = meta.repoOwner && meta.repoName ? `${meta.repoOwner}/${meta.repoName}` : null;

  const session = useCodeSession({
    conversationId: conversation.id,
    initialMessages,
    onActivity: () => updateConversation(conversation.id, { lastMessageAt: new Date().toISOString() }),
  });

  React.useEffect(() => {
    setActiveConversationId(conversation.id);
  }, [conversation.id, setActiveConversationId]);

  // Re-attach to a run that was live when the page loaded (reload mid-task).
  // Read off the rows `useCodeTaskMeta` already fetched — this used to be a
  // second, identical request for the same list on every mount.
  const resumedRef = React.useRef(false);
  React.useEffect(() => {
    if (resumedRef.current || !meta.loaded) return;
    resumedRef.current = true;
    if (meta.activeTask) session.resume(meta.activeTask);
    // Once per conversation, the first time the rows land. session.resume is
    // stable for the lifetime of this conversation id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta.loaded, meta.activeTask]);

  const [draft, setDraft] = React.useState("");
  /*
   * THE REVIEW TRAY: notes written in the diff, waiting for the reader to send.
   *
   * The review pane used to deliver its bundle by parking it in the session
   * hand-off and navigating — after which a device session AUTO-DISPATCHED it as
   * its own task and a cloud session silently left it as the draft. Neither was
   * what the reader asked for: one sent words they had not finished, the other
   * lost the fact that they were a review at all.
   *
   * So the bundle sits HERE, drawn above the composer, and rides out with
   * whatever is typed next. It is one string rather than a list of notes because
   * the pane owns the note model and the composer only has to carry the sentence
   * — and because merging two note collections on their way to one message is a
   * problem nobody has.
   */
  const [reviewNotes, setReviewNotes] = React.useState<string | null>(null);
  const [dictating, setDictating] = React.useState(false);
  const [model, setModel] = React.useState(conversation.model || settings.defaultModel || DEFAULT_MODEL);
  const [reasoningEffort, setReasoningEffort] = React.useState<ReasoningEffort>(null);

  const handleModelChange = React.useCallback((next: string) => {
    setModel(next);
    updateConversation(conversation.id, { model: next });
    void fetch(`/api/conversations/${conversation.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: next }),
    }).catch(() => {});
  }, [conversation.id, updateConversation]);

  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const { uploads, addFiles, addAttachments, remove, clear, readyAttachments, isUploading } = useUploads(
    conversation.id,
  );
  const canAttach = features.storage;
  const { supported: speechSupported } = useSpeechRecognition();

  // The shared composer growth: one line at rest, eight before it scrolls.
  const autoresize = useComposerAutosize(textareaRef, draft);

  // First prompt handed off from the New session screen (device sessions only —
  // cloud sessions dispatch their task up front). Pre-fill the draft + staged
  // attachments and arm a one-shot auto-dispatch that fires the moment the Mac
  // is reachable; if it's offline the prompt simply waits, ready to send.
  //
  // PEEKED, NOT TAKEN. The hand-off stays in sessionStorage until `send`
  // returns accepted (see `submit`), so a reload while the Mac is offline
  // finds the instruction still here — which is what the composer's own copy
  // promises it will.
  const [autoSendArmed, setAutoSendArmed] = React.useState(false);
  const handoffDoneRef = React.useRef(false);
  React.useEffect(() => {
    if (handoffDoneRef.current) return;
    handoffDoneRef.current = true;
    const pending = peekPendingCodePrompt(conversation.id);
    if (pending) {
      setDraft(pending.text);
      if (pending.attachments.length) addAttachments(pending.attachments);
      setAutoSendArmed(true);
    }
    // Once, on mount for this conversation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id]);

  // Cloud sessions ignore device presence entirely — they run on a dispatched
  // machine, so the only gate is knowing the repo. Device sessions keep their
  // presence-based gating unchanged. Neither gate can be evaluated before the
  // session's own kind is known, so until then the answer is "not yet".
  const canTarget = resolving ? false : isCloud ? !!cloudRepoFull : presence.device != null;
  const sendBlockedReason = resolving
    ? "Getting this session ready…"
    : isCloud
    ? !cloudRepoFull
      ? "Preparing this cloud session…"
      : null
    : presence.state === "none"
      ? "No Mac has synced this project. Open the folder in the Juno app on your Mac and this session can run it."
      : presence.state === "error"
        ? "Can't reach the server to find your Mac. Your prompt is safe here — retry when you're ready."
        : presence.state === "checking"
          ? "Looking for the Mac that has this project…"
          : presence.state === "offline"
            ? "Your Mac is offline. Write the instruction now — it sends the moment the Mac reconnects."
            : !workspacePath
              ? "This session isn't linked to a synced project folder, so there is nowhere to run it."
              : null;

  const nameSessionFromFirstPrompt = React.useCallback(
    (text: string, attachments: ClientAttachment[]) => {
      const current = conversations.find((c) => c.id === conversation.id);
      if (current && current.titleSource === "default" && isDefaultCodeSessionTitle(current.title)) {
        const title =
          text.slice(0, 48) ||
          (attachments.length === 1 ? "1 attachment" : `${attachments.length} attachments`);
        updateConversation(conversation.id, { title });
      }
    },
    [conversation.id, conversations, updateConversation],
  );

  /** Optional override lets dictate-and-send ship the transcript without
   * waiting a render for draft state.
   *
   * Resolves to whether the words actually landed on a run, which the voice
   * panel's hand-off needs: a refusal has to leave the spoken line on screen
   * rather than swallow it. `session.send` already answers that question and
   * this only forwards the answer. */
  const submit = React.useCallback(
    async (overrideText?: string): Promise<boolean> => {
      const typed = (overrideText ?? draft).trim();
      /*
       * THE REVIEW GOES FIRST, AND IT IS ONE MESSAGE WITH WHAT WAS TYPED.
       *
       * Notes before prose: the notes name files and lines, and an agent reading
       * them wants the specifics before the covering sentence. Two separate
       * messages would have been the easier build and the worse outcome — a run
       * that took the notes and then took "and please be careful with the
       * migration" as a fresh instruction has already started acting on the
       * first when the second arrives.
       */
      const text = reviewNotes ? [reviewNotes, typed].filter(Boolean).join("\n\n") : typed;
      const attachments = readyAttachments;

      /*
       * A BUSY SESSION IS NOT A CLOSED ONE. While a run is going the words go
       * INTO it as its next instruction rather than starting a second task —
       * including while it is still queued, where the host folds them into the
       * prompt it opens with. Attachments ride along now: the steer route folds
       * their extracted text into what the agent reads exactly as the create
       * route does, so the only thing still gating this is an upload in flight.
       */
      if (session.isBusy) {
        if (!session.canSteer || (!text && attachments.length === 0) || isUploading) return false;
        const { accepted } = await session.steer(text, attachments);
        if (accepted) {
          setDraft("");
          setReviewNotes(null);
          clear();
          requestAnimationFrame(() => textareaRef.current?.focus());
        }
        return accepted;
      }

      if ((!text && attachments.length === 0) || isUploading) return false;

      if (isCloud) {
        if (!meta.repoOwner || !meta.repoName) return false;
        const { accepted } = await session.send(
          text,
          {
            mode: "cloud",
            repo: { owner: meta.repoOwner, name: meta.repoName },
            baseRef: meta.baseRef,
            workspaceName: conversation.codeWorkspaceName,
          },
          attachments,
          // The composer's own two controls, finally reaching the run.
          { model, reasoningEffort },
        );
        if (accepted) {
          setDraft("");
          setReviewNotes(null);
          clear();
          clearPendingCodePrompt(conversation.id);
          nameSessionFromFirstPrompt(text, attachments);
          meta.refresh(); // a follow-up run may open a new PR — pick it up
          requestAnimationFrame(() => textareaRef.current?.focus());
        }
        return accepted;
      }

      if (!presence.device) return false;
      // The device's workspace path is authoritative when the conversation only
      // carries a name (sessions created before the path was recorded).
      const path = workspacePath ?? null;
      if (!path) return false;
      const { accepted } = await session.send(
        text,
        {
          deviceId: presence.device.id,
          workspacePath: path,
          workspaceName: conversation.codeWorkspaceName,
          workspaceKey,
        },
        attachments,
        { model, reasoningEffort },
      );
      if (accepted) {
        setDraft("");
        setReviewNotes(null);
        clear();
        // The words have landed on a run: the hand-off has done its job.
        clearPendingCodePrompt(conversation.id);
        // First prompt of a fresh session names it (server does the same — this
        // mirrors POST /api/code/tasks so the sidebar updates without a refetch).
        nameSessionFromFirstPrompt(text, attachments);
        requestAnimationFrame(() => textareaRef.current?.focus());
      }
      return accepted;
    },
    [
      clear,
      conversation.codeWorkspaceName,
      conversation.id,
      draft,
      isCloud,
      isUploading,
      meta,
      model,
      nameSessionFromFirstPrompt,
      presence.device,
      readyAttachments,
      reasoningEffort,
      reviewNotes,
      session,
      workspaceKey,
      workspacePath,
    ],
  );

  // A queued review is a payload of its own: a reader who wrote six notes and
  // typed nothing still has something to send, and a disabled circle there
  // would strand the notes in the tray with no way out.
  const hasPayload = !!draft.trim() || readyAttachments.length > 0 || !!reviewNotes;
  const canSend =
    hasPayload &&
    canTarget &&
    (isCloud || !!workspacePath) &&
    !session.isBusy &&
    !isUploading;
  // Something to say, and nothing still uploading. A staged attachment counts:
  // the `+` menu is live while a run goes, so dropping a screenshot into one
  // has to be a thing the circle can then send — the steer route takes an empty
  // instruction when something is attached, exactly as the create route does.
  const steerReady =
    session.canSteer && (!!draft.trim() || !!reviewNotes || readyAttachments.length > 0) && !isUploading;

  // Dictate: drop the transcript into the draft, or merge + send immediately.
  // Same append semantics as chat — existing typed text is preserved. If the
  // session can't run yet (Mac offline / no repo), park the words for edit.
  const closeDictation = React.useCallback(
    (transcript: string, sendNow: boolean) => {
      setDictating(false);
      const merged = [draft.trim(), transcript.trim()].filter(Boolean).join(" ");
      const park = () => {
        setDraft(merged);
        requestAnimationFrame(() => {
          autoresize();
          textareaRef.current?.focus();
        });
      };
      if (!sendNow) {
        park();
        return;
      }
      if (!merged && readyAttachments.length === 0) {
        setDraft("");
        requestAnimationFrame(() => textareaRef.current?.focus());
        return;
      }
      const canFire = session.isBusy
        ? session.canSteer && !isUploading
        : (isCloud ? !!cloudRepoFull : !!presence.device && !!workspacePath) && !isUploading;
      if (!canFire) {
        park();
        return;
      }
      void submit(merged);
    },
    [
      autoresize,
      cloudRepoFull,
      draft,
      isCloud,
      isUploading,
      presence.device,
      readyAttachments.length,
      session.canSteer,
      session.isBusy,
      submit,
      workspacePath,
    ],
  );

  /*
   * Voice mode, which this surface has never had — the comment that used to sit
   * on the composer said "no voice mode here, only dictate", and dictation is a
   * different thing: it types for you, where this is a conversation about the
   * run.
   *
   * Deliberately NOT gated on whether the runner is reachable. An asleep Mac or
   * a repo still resolving is precisely the moment somebody wants to talk
   * through what happened, and the call needs no runner at all. What it IS
   * gated on is `resolving`: until the session's own kind is known the briefing
   * would name the wrong machine, and a voice session can never be re-briefed
   * properly (the relay seeds history exactly once).
   */
  const codeVoice = useCodeVoice({ disabled: dictating || resolving });

  const voiceBriefing = React.useMemo<CodeVoiceBriefingInput>(
    () => ({
      stage: "session",
      target: resolving ? null : isCloud ? "cloud" : "device",
      place: isCloud ? cloudRepoFull : workspaceName,
      baseRef: isCloud ? meta.baseRef : null,
      // Only what a person said and what Juno Code answered. The activity
      // stream — every tool call and file write — is deliberately left out: it
      // is the bulk of a code transcript, it would eat the whole history
      // budget, and the bounding passes drop from the FRONT, so paying for it
      // would cost the section that says which repo this is.
      //
      // Walked only while a call is open. `session.messages` is a new array on
      // every streamed token, and this memo's dependency on it would otherwise
      // pay for a full transcript walk on each one, for a briefing nobody has
      // asked for.
      turns: codeVoice.open
        ? session.messages
            .filter((m) => (m.role === "USER" || m.role === "ASSISTANT") && m.content.trim())
            .map((m) => ({ role: m.role === "ASSISTANT" ? ("assistant" as const) : ("user" as const), text: m.content }))
        : [],
      blocked: sendBlockedReason,
    }),
    [cloudRepoFull, codeVoice.open, isCloud, meta.baseRef, resolving, sendBlockedReason, session.messages, workspaceName],
  );

  const voiceSend = React.useMemo<CodeVoiceSend>(
    () => ({
      intent: "send",
      // The composer's own gate sentences, in the composer's own words — a
      // second wording for the same refusal reads as a second rule.
      blockedReason: sendBlockedReason
        ? sendBlockedReason
        : session.isBusy && !session.canSteer
          ? "Juno Code is working on this. Wait for it to finish, or stop it first."
          : isUploading
            ? "Still uploading the attached files."
            : null,
      sending: session.status === "submitting",
      // Merge, never replace. `submit(overrideText)` sends the override and
      // then clears `draft` regardless — so handing it the spoken text alone
      // sent the sentence you said and DESTROYED the one you had typed, with no
      // undo and nothing on screen to say it had happened. Same rule the
      // dictation path already follows: what you typed survives, the spoken
      // words are appended to it.
      onSend: (text: string) => submit([draft.trim(), text.trim()].filter(Boolean).join(" ")),
    }),
    [draft, isUploading, sendBlockedReason, session.canSteer, session.isBusy, session.status, submit],
  );

  // Fire the handed-off first prompt as soon as the session can send. Cloud
  // sessions were already dispatched on the New session screen, so this only
  // covers device — it waits out presence resolution, then sends exactly once.
  // Also wait out any staged-attachment uploads from the New session screen.
  React.useEffect(() => {
    if (!autoSendArmed) return;
    if (isCloud) {
      setAutoSendArmed(false);
      return;
    }
    if (!canSend || isUploading) return;
    setAutoSendArmed(false);
    void submit();
  }, [autoSendArmed, canSend, isCloud, isUploading, submit]);

  // MessageList's streaming label: "Writing" once prose lands, "Thinking" before.
  const listStatus: GenerationStatus =
    session.status === "running" || session.status === "awaiting_approval"
      ? session.messages[session.messages.length - 1]?.streaming && session.messages[session.messages.length - 1]?.content
        ? "writing"
        : "thinking"
      : session.status === "stopping"
        ? "stopping"
        : "idle";

  const hasMessages = session.messages.length > 0;
  const sessionTitle = isCloud ? cloudRepoFull ?? workspaceName : workspaceName;
  /*
   * Neither promise is safe to make before the session's kind is known — see
   * `resolving`. What both halves say is the half that is always true.
   *
   * The cloud half no longer says "opens a pull request", and that is a
   * correction rather than a rewording: a run inside a web session leaves the
   * pull request to its reader now (runner-context sends `openPullRequest:
   * "never"`), so a sentence promising one would be describing the behaviour
   * this session deliberately does not have.
   */
  const footerNote = resolving
    ? "Review the changes before you ship them."
    : isCloud
      ? "Runs in the cloud and pushes a branch — read the diff, then open the pull request yourself."
      : "Runs with Juno Code on your Mac — review the changes before you ship them.";

  /*
   * THE RUN TRACE HAD NO WAY TO OPEN.
   *
   * MessageItem → ActivityTimeline renders a full pressable row — hover fill,
   * sliding chevron, aria-expanded, "Open run details" — whose click calls
   * `panel.setOpenId`, where `panel` is `useThoughtPanel()`. Only chat-view
   * mounted the provider, so on this surface `panel` was null and the most
   * clicked control in a coding transcript was a guaranteed no-op. Everything
   * Juno Code actually did — every tool call, every file change, every approval
   * — is folded into that trace and was unreachable.
   *
   * The dock is a column, so its DOM must be a sibling of the transcript
   * column; ActivityTimeline portals the panel into `container`. Same contract
   * as chat-view, minus the drag-to-resize: the width that matters here is the
   * one chat-view uses undragged.
   */
  const [thoughtOpenId, setThoughtOpenId] = React.useState<string | null>(null);
  const [thoughtContainer, setThoughtContainer] = React.useState<HTMLDivElement | null>(null);
  const layoutRef = React.useRef<HTMLDivElement>(null);

  /*
   * THE REVIEW DOCK — the third column, and the one this session was missing.
   *
   * It streams the run's event log through `useRunDetail`, and ONLY while it is
   * open. That is not a nicety: the events endpoint holds a database poll open
   * for up to four minutes per connection, and this surface already has one of
   * those for the live session — a second, permanent one per open tab would
   * double the cost of every session anybody leaves open. Passing null when the
   * dock is shut tears it down (see the hook's own note on following at most one
   * run at a time).
   *
   * It reads the LATEST task rather than the live one. A session whose run
   * finished ten minutes ago has no active task and still has a diff worth
   * reading, and that is the commonest moment to want this open.
   */
  const [reviewOpen, setReviewOpen] = React.useState(false);
  const reviewTaskId = meta.latestTask?.id ?? null;
  /*
   * One expression for "the dock is on screen", used by the column AND by the
   * class that narrows the transcript beside it. Read separately they drift:
   * `reviewOpen` alone is true for a session that has no task to review yet, so
   * the transcript hid itself below 52rem to make room for a column that was
   * never rendered.
   */
  const reviewDocked = reviewOpen && !!reviewTaskId;
  const reviewDetail = useRunDetail(reviewDocked ? reviewTaskId : null);

  /*
   * THE CANVAS, WHICH THIS SURFACE HAD STUBBED OUT.
   *
   * `artifacts={[]}` plus `onOpenArtifact={() => {}}` meant MessageList could
   * never match an artifact card to its content and its press did nothing. The
   * rows exist — the page loads them with the thread — so the stub was the only
   * thing between an artifact in a code session and the workspace that opens it.
   *
   * State, not a derived id: `openArtifact` is DERIVED from `artifacts` below,
   * so anything that removes an artifact drops the canvas for free.
   */
  const [artifacts, setArtifacts] = React.useState<ClientArtifact[]>(initialArtifacts);
  const [openArtifactId, setOpenArtifactId] = React.useState<string | null>(null);
  const [artifactFullscreen, setArtifactFullscreen] = React.useState(false);
  React.useEffect(() => {
    setArtifacts(initialArtifacts);
    setOpenArtifactId(null);
    setArtifactFullscreen(false);
    // The review dock belongs to the run it was opened on. Left standing across
    // a navigation it would draw the next session's newest diff over a
    // transcript nobody had asked to read it against.
    setReviewOpen(false);
    // Session identity, exactly as the transcript reset above: `initialArtifacts`
    // is a new array on every parent render, and depending on it would slam the
    // canvas shut mid-read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id]);

  const openArtifact = React.useMemo(
    () => artifacts.find((a) => a.id === openArtifactId) ?? null,
    [artifacts, openArtifactId],
  );
  const closeArtifact = React.useCallback(() => {
    setOpenArtifactId(null);
    setArtifactFullscreen(false);
  }, []);
  const openArtifactByIdentifier = React.useCallback(
    (identifier: string, opts?: { fullscreen?: boolean }) => {
      const found = artifacts.find((a) => a.identifier === identifier);
      if (!found) return;
      setOpenArtifactId(found.id);
      setArtifactFullscreen(!!opts?.fullscreen);
      // COEXISTENCE RULE, the same one chat-view states, now over three
      // columns: the canvas, the thought dock and the review dock all want the
      // right-hand side, and transcript + any two of them does not fit. The
      // newest request wins.
      setThoughtOpenId(null);
      setReviewOpen(false);
    },
    [artifacts],
  );
  const handleArtifactUpdated = React.useCallback((updated: ClientArtifact) => {
    setArtifacts((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
    // Re-point, never re-open: a save can land from a fetch closure that
    // outlives the panel, and forcing the canvas back open would put both
    // docked columns in flow at once.
    setOpenArtifactId((prev) => (prev ? updated.id : prev));
  }, []);

  const openThoughtPanel = React.useCallback(
    (id: string | null) => {
      setThoughtOpenId(id);
      if (id) {
        closeArtifact();
        setReviewOpen(false);
      }
    },
    [closeArtifact],
  );

  const toggleReview = React.useCallback(() => {
    setReviewOpen((open) => {
      if (open) return false;
      closeArtifact();
      setThoughtOpenId(null);
      return true;
    });
  }, [closeArtifact]);
  const thoughtPanel = React.useMemo(
    () => ({
      openId: thoughtOpenId,
      setOpenId: openThoughtPanel,
      container: thoughtContainer,
      coversChat: () => !splitEngaged(layoutRef.current),
    }),
    [thoughtOpenId, openThoughtPanel, thoughtContainer],
  );
  // Self-heal, for the reason chat-view reconciles too: the dock is raw state
  // naming a message, and this surface swaps ids under it routinely — the live
  // streaming bubble is REPLACED by its persisted row when a run settles, which
  // unmounts the ActivityTimeline holding the panel and its only close button.
  // What would be left is an empty card column covering the whole screen below the split.
  React.useEffect(() => {
    if (!thoughtOpenId) return;
    if (!session.messages.some((m) => m.id === thoughtOpenId)) setThoughtOpenId(null);
  }, [session.messages, thoughtOpenId]);
  // Esc closes it — a docked, non-modal panel gets none of a dialog's dismissal
  // for free. Only if a nearer layer hasn't already claimed the key: the review
  // dock's own note composer and its Create PR menu are both nearer, and both
  // call preventDefault on the key they consume.
  React.useEffect(() => {
    if (!thoughtOpenId && !reviewOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      setThoughtOpenId(null);
      setReviewOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [thoughtOpenId, reviewOpen]);

  const fileChanges = useSessionFileChanges(session.messages, session.fileChanges);
  /*
   * +N −M FOR THE BANNER, read off what the session already has.
   *
   * Deliberately NOT a second stream and not a new server field. Every file
   * change this session has seen is already here — live events while a run goes,
   * and the persisted activity rows after a reload — and `totalChurn` is the
   * parser the changed-files card has always used for the same figures. A
   * server-side sum would have meant reading every `file_change` payload for
   * every row of a hundred-run list to answer a question one open session asks.
   */
  const churn = React.useMemo(() => totalChurn(fileChanges), [fileChanges]);
  const currentActivity = useCurrentActivity(
    session.messages,
    session.status === "running" || session.status === "awaiting_approval",
  );
  /*
   * THE CODING TRANSCRIPT'S OWN ROWS — commands with their output, files with
   * their diffs, approvals — placed under each turn through MessageList's one
   * slot for surface-owned nodes. See code-activity.tsx for what the chat
   * components still need to do for these to replace the thought strip.
   */
  const streamingId = React.useMemo(
    () => session.messages.find((m) => m.streaming)?.id ?? null,
    [session.messages],
  );
  const codeActivity = useCodeActivityContents(session.messages, streamingId);

  /*
   * WHAT CI SAYS, ONCE THERE IS A BRANCH TO ASK ABOUT.
   *
   * Gated on the branch rather than on the session being cloud, because that is
   * the thing that makes the question answerable: a device run writes to a
   * checkout on a Mac and pushes nothing, so there is no ref for GitHub to have
   * an opinion about, and the route refuses it for the same reason.
   */
  const checks = useCodeChecks(reviewTaskId, !!meta.latestTask?.branch);
  /*
   * And whether Juno answers what CI reports. Asked of the same task the checks
   * are asked about, because the pull request belongs to the session rather
   * than to one run — the route widens to the conversation to find it. The hook
   * answers `available: false` for a device session, for a deployment with no
   * webhook secret and for a session with no pull request yet, and the banner
   * draws no switch for any of them.
   */
  const autoFix = useCodeAutoFix(reviewTaskId);

  /*
   * A FAILED RUN WAS A DEAD END. MessageItem offers its "Try again" only when
   * `onRegenerate` is supplied, and this surface supplied neither that nor
   * `onEdit` — so the only way back from a failure was retyping the prompt,
   * which the composer cleared on send. One screen earlier, /code/new's own
   * dispatch failure has exactly this button.
   *
   * Re-dispatch when the session can run, and otherwise put the words back in
   * the composer — a Mac that went offline mid-run is the common case, and the
   * prompt waiting in the field is the honest outcome there.
   */
  const retryLastPrompt = React.useCallback(() => {
    const lastUser = [...session.messages].reverse().find((m) => m.role === "USER");
    const text = lastUser?.content.trim();
    if (!text) return;
    // A retry starts a NEW task — never a steer into a live one, which would
    // send the failed prompt into a run that is doing something else.
    const canFire = canTarget && (isCloud || !!workspacePath) && !session.isBusy && !isUploading;
    if (canFire) {
      void submit(text);
      return;
    }
    setDraft(text);
    requestAnimationFrame(() => {
      autoresize();
      textareaRef.current?.focus();
    });
  }, [autoresize, canTarget, isCloud, isUploading, session.isBusy, session.messages, submit, workspacePath]);

  /*
   * WHETHER TO SAY WHY, AND WHETHER TO OFFER A SECOND ASK.
   *
   * Two states are deliberately silent. `resolving` and a first presence check
   * are both "we do not know yet", and they last one round trip — a card that
   * appears and vanishes inside 300ms is a flicker, not an explanation, and it
   * would fire on every device session the moment it opens. The composer is
   * live throughout either way, so nothing is lost by waiting to be sure.
   *
   * The button appears only where a second ask could change the answer: an
   * asleep Mac, or a presence lookup that failed. A project no Mac has ever
   * synced will not have synced one round trip later, and a cloud session is
   * not waiting on a device poll at all.
   */
  const blockedNote = React.useMemo(() => {
    if (resolving || !sendBlockedReason) return null;
    if (isCloud) return { reason: sendBlockedReason };
    if (presence.state === "checking") return null;
    const recoverable = presence.state === "offline" || presence.state === "error";
    return { reason: sendBlockedReason, onRecheck: recoverable ? refreshPresence : undefined };
  }, [isCloud, presence.state, refreshPresence, resolving, sendBlockedReason]);

  /*
   * Keep/revert/undo, offered ONLY once the executing host has said it can act
   * on them.
   *
   * `announced` is the whole gate, and nothing here may widen it — not the run
   * being live, not the Mac being online. The control channel is
   * fire-and-forget (a control event handed to the host on its next events
   * POST), so a host that has never heard of these verbs swallows them and
   * answers nothing; without the announcement there is no way to tell that
   * apart from a host that is about to act. Every host in the field today
   * announces nothing, so this is null and no rollback control is drawn — which
   * is the correct behaviour, not a degraded one.
   */
  const rollbackControls = React.useMemo(
    () =>
      session.rollbackSupport.announced
        ? {
            paths: session.rollbackSupport.paths,
            requests: session.rollbacks,
            onRequest: (verb: CodeRollbackVerb, path?: string | null) => {
              void session.requestRollback(verb, path ?? null);
            },
          }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.rollbackSupport, session.rollbacks, session.requestRollback],
  );

  /*
   * Queue copy, and the same sentence the live region reads out.
   *
   * The cloud line says the wait is still a conversation, because it is: the
   * field used to go dark during the minute a machine takes to appear, so a
   * person who thought of the constraint they had left out could only cancel and
   * start over. Now runner-context hands the driver the backlog and it is folded
   * into the prompt the run opens with, which is what that sentence promises.
   *
   * The two device lines make no such promise, and must not: a Mac host reads
   * the control list but acts on `approval_response` and `cancel_request` only,
   * so words added to a queued device run would go nowhere. `canSteerRun` keeps
   * the field shut there; a sentence inviting the reader to type into it would
   * put the promise back by other means.
   */
  const queuedNote =
    session.status !== "queued"
      ? null
      : isCloud
        ? "Queued — starting a cloud machine (this can take a moment). Anything you add now goes in with the first instruction."
        : presence.state === "offline"
          ? "Queued — runs when your Mac reconnects."
          : "Queued — waiting for your Mac to pick this up.";

  const composer = (
    <CodeSessionComposer
      above={
        <>
          {reviewNotes && (
            <ReviewTray notes={reviewNotes} onDiscard={() => setReviewNotes(null)} onOpenDiff={toggleReview} />
          )}
          <CodeRunStack
            files={fileChanges}
            agents={session.agents}
            pendingApproval={session.pendingApproval}
            responding={session.responding}
            onRespond={(approve) => {
              const request = session.pendingApproval;
              if (request) void session.respond(request.requestId, approve);
            }}
            queuedNote={queuedNote}
            blocked={blockedNote}
            rollback={rollbackControls}
            isCloud={isCloud}
            steering={session.steering}
          />
        </>
      }
      voicePanel={
        codeVoice.open ? (
          <CodeVoicePanel briefing={voiceBriefing} send={voiceSend} onClose={codeVoice.close} />
        ) : null
      }
      resolving={resolving}
      isCloud={isCloud}
      workspaceName={workspaceName}
      workspacePath={workspacePath}
      cloudRepoFull={cloudRepoFull}
      baseRef={meta.baseRef}
      presenceState={presence.state}
      draft={draft}
      onDraftChange={setDraft}
      textareaRef={textareaRef}
      blockedReason={sendBlockedReason}
      canSend={canSend}
      onSubmit={() => void submit()}
      status={session.status}
      isBusy={session.isBusy}
      onCancel={() => void session.cancel()}
      canSteer={session.canSteer}
      steerReady={steerReady}
      onSteer={() => void submit()}
      model={model}
      onModelChange={handleModelChange}
      reasoningEffort={reasoningEffort}
      onReasoningChange={setReasoningEffort}
      attachments={{
        enabled: canAttach,
        uploads,
        onRemove: remove,
        onAddFiles: addFiles,
        onAddAttachments: addAttachments,
      }}
      dictation={{
        supported: speechSupported,
        active: dictating,
        onStart: () => setDictating(true),
        onCancel: () => setDictating(false),
        onStop: (t) => closeDictation(t, false),
        onSend: (t) => closeDictation(t, true),
      }}
      voice={{ open: codeVoice.open, onOpen: codeVoice.onOpenVoiceMode }}
    />
  );

  return (
    <ThoughtPanelProvider value={thoughtPanel}>
      {/* `@container/split` on the view's root rather than on the row below:
          the two have the same inline size, and a `container-type` box is also
          the containing block for `position: fixed` descendants, so the
          container has to sit ABOVE the banner or a fullscreened canvas would
          stop short of it. Same name as chat-view's mount, so the thought and
          canvas panels — portalled into either surface — carry one set of
          `@[50rem]/split:` classes. */}
      <div ref={layoutRef} className="@container/split relative flex h-full min-h-0 w-full flex-col overflow-hidden">
        <CodeSessionBanner
          resolving={resolving}
          isCloud={isCloud}
          title={sessionTitle}
          // The mono slot is a LOCAL PATH on the device side; a cloud session's
          // codeWorkspacePath is "owner/name", so it is never printed there.
          // The working branch once one exists — that is where the code is —
          // and the base until then.
          subtitle={
            resolving
              ? null
              : isCloud
                ? meta.branch
                  ? `on ${meta.branch}`
                  : meta.baseRef
                    ? `on ${meta.baseRef}`
                    : null
                : workspacePath
          }
          status={session.status}
          presence={presence}
          prUrl={meta.prUrl}
          activity={currentActivity}
          churn={churn}
          reviewOpen={reviewOpen}
          // No figures, no door: a session that has changed nothing has no diff
          // to open, and a control that opened an empty pane would be the
          // product asking a question it has no answer to.
          onToggleReview={churn && reviewTaskId ? toggleReview : null}
          checks={checks}
          autoFix={autoFix}
          menu={<CodeSessionMenu conversation={conversation} />}
        />

        {/* Transcript column ⇄ thought dock ⇄ review dock ⇄ canvas. Below its
            own step a dock replaces the transcript entirely, the precedent
            chat-view sets for both of its docked columns: a split there leaves
            the transcript narrower than a phone. Each has its own step, derived
            from its width plus the transcript's 320 floor (split-layout.ts):
            the 30rem thought dock from 50rem of mount, the 32rem review dock
            from 52rem, the 34rem canvas from 54rem. Derived, so the transcript
            can never be under 320 while split — which is why the column carries
            no floor of its own; a `min-w` beside `shrink-0` panes would only
            overflow the row. A fullscreened canvas takes the row at every
            width, which is what "fullscreen" means. One expression rather than
            stacked conditional classes: `hidden @[50rem]/split:flex` and
            `@[50rem]/split:hidden` land in the same cascade layer, so which won
            would depend on stylesheet order.

            At most ONE of the three is ever open — see the coexistence rule
            above — so the branches are exclusive rather than additive. */}
        <div className="flex min-h-0 flex-1">
          <div
            className={cn(
              "relative flex h-full min-h-0 min-w-0 flex-1 flex-col",
              openArtifact && artifactFullscreen
                ? "hidden"
                : thoughtOpenId
                  ? "hidden @[50rem]/split:flex"
                  : reviewDocked
                    ? "hidden @[52rem]/split:flex"
                    : openArtifact && "hidden @[54rem]/split:flex",
            )}
          >
            {hasMessages ? (
              <>
                <MessageList
                  messages={session.messages}
                  surface="code"
                  inlineRuns={codeActivity}
                  busy={session.isBusy}
                  status={listStatus}
                  artifacts={artifacts}
                  onOpenArtifact={openArtifactByIdentifier}
                  onFeedback={session.setFeedback}
                  // Live bubbles are client-side until the run's row comes back.
                  canFeedback={(m) => !isLiveId(m.id)}
                  // The transcript's only <h1>. Omitted, it fell back to the
                  // literal "Conversation" — on a surface where the workspace or
                  // repo IS what a reader is orienting by, and where the prop
                  // exists precisely to stop that.
                  conversationTitle={sessionTitle}
                  onRegenerate={retryLastPrompt}
                />
                <div className="w-full px-0 pb-1">{composer}</div>
                <p className="shrink-0 select-none pb-2 text-center text-caption text-muted-foreground">
                  {footerNote}
                </p>
              </>
            ) : (
              /*
               * THE RESTING STATE. A session that exists and has never been
               * asked for anything: its name, one sentence saying what happens
               * when you ask, and the composer. Anything that is wrong with the
               * session (an asleep Mac, a repo still being prepared) arrives in
               * the run stack directly above the field rather than as a
               * placeholder that vanishes the moment you start typing.
               */
              <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-y-auto">
                <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-center justify-center px-3 py-6 sm:px-5 md:py-10">
                  <div className="mb-5 flex w-full flex-col items-center text-center sm:mb-6">
                    {/* text-display alone: `text-3xl` is a raw Tailwind default
                        that is not on the product type scale, and pinning it
                        below sm defeated the token, whose clamp already does the
                        responsive work. */}
                    <h1 className="font-sans text-display font-normal tracking-tight text-foreground">
                      {sessionTitle}
                    </h1>
                    <p className="mt-2 max-w-md text-body-lg leading-6 text-muted-foreground">
                      {resolving
                        ? "Describe what to build or fix — Juno Code streams the work here."
                        : isCloud
                          ? "Describe what to build or fix — the run happens in the cloud and pushes a branch you can read here, then turn into a pull request."
                          : "Describe what to build or fix — Juno Code runs it on your Mac and streams the work here."}
                    </p>
                  </div>
                  <div className="z-10 w-full max-w-[44rem]">{composer}</div>
                </div>
                <p className="shrink-0 select-none pb-2 text-center text-caption text-muted-foreground">
                  {footerNote}
                </p>
              </div>
            )}
          </div>

          {/* The dock itself — a real column, not an overlay: the transcript
              narrows beside it and stays readable and typeable. ActivityTimeline
              portals the panel in here (see thought-panel-context). */}
          {thoughtOpenId && (
            <div
              ref={setThoughtContainer}
              // No z-index. `z-40` was a number picked outside the
              // z-popper/modal/toolbar/toast scale, and it bought nothing: this
              // is an in-flow flex sibling that already paints after the
              // transcript column. Naming a layer here would instead put the
              // dock over the composer's own portalled dropdowns, which sit at
              // z-popper.
              className="relative h-full w-full shrink-0 border-border bg-card duration-base ease-out-expo motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-4 @[50rem]/split:w-[30rem] @[50rem]/split:min-w-0 @[50rem]/split:border-l"
            />
          )}

          {/* The diff, on the same terms as the thought dock beside it: an
              in-flow flex sibling with no z-index (naming a layer here would
              put it over the composer's portalled dropdowns), and a width
              derived rather than picked — 32rem of diff plus the transcript's
              320px floor is the 52rem step above, so the transcript can never
              be narrower than a phone while the two are side by side.

              Keyed by task so the pane's per-run state — its persisted notes,
              its file selection — is re-read when a follow-up run becomes the
              latest one, which is the same rule the run list mounted it under. */}
          {reviewDocked && (
            <div className="relative h-full w-full shrink-0 border-border bg-card duration-base ease-out-expo motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-4 @[52rem]/split:w-[32rem] @[52rem]/split:min-w-0 @[52rem]/split:border-l">
              <RunReviewPane
                key={reviewTaskId}
                placement="dock"
                run={{ id: reviewTaskId, title: sessionTitle, conversationId: conversation.id }}
                detail={reviewDetail}
                onClose={() => setReviewOpen(false)}
                // The notes land in the tray above the composer rather than
                // dispatching themselves — see `reviewNotes`. Appended when
                // there is already a bundle waiting, because a reader who
                // reviewed two files in two passes wrote one review.
                onQueueNotes={(bundle) => {
                  setReviewNotes((prev) => (prev ? `${prev}\n\n${bundle}` : bundle));
                  requestAnimationFrame(() => textareaRef.current?.focus());
                }}
                pullRequest={{
                  taskId: reviewTaskId,
                  // THIS run's facts, because the route reads this run's row:
                  // a subject built from the conversation's branch would draw
                  // the control over a run that has pushed nothing.
                  subject: {
                    target: meta.latestTask?.target ?? "device",
                    repoOwner: meta.repoOwner,
                    repoName: meta.repoName,
                    branch: meta.latestTask?.branch ?? null,
                    prUrl: meta.prUrl,
                  },
                  // Straight back to the server for the row, rather than
                  // patching `meta` locally: the banner's PR chip reads the
                  // task rows, and a local guess that disagreed with them would
                  // put a link on screen that the next poll took away.
                  onOpened: () => meta.refresh(),
                }}
              />
            </div>
          )}

          {/* The canvas, on the same terms as the dock beside it: a real column,
              no z-index (an in-flow flex sibling already paints after the
              transcript, and naming a layer here would put it over the
              composer's portalled dropdowns), and no drag-to-resize — the width
              that matters on this surface is the one chat-view uses undragged.

              No `onQuote`: quoting a selection back into the prompt needs the
              composer's quote chip, which this composer does not have, and
              CanvasPanel hides every selection affordance when the prop is
              absent rather than offering a control that would go nowhere. */}
          {openArtifact && (
            <div
              className={cn(
                "relative h-full w-full min-w-0 bg-background duration-base ease-out-expo motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-4",
                artifactFullscreen ? "flex-1" : "shrink-0 border-border @[54rem]/split:w-[34rem] @[54rem]/split:border-l",
              )}
            >
              <CanvasPanel
                artifact={openArtifact}
                onClose={closeArtifact}
                onArtifactUpdated={handleArtifactUpdated}
                fullscreen={artifactFullscreen}
                onToggleFullscreen={() => setArtifactFullscreen((v) => !v)}
                // Code sessions are ordinary persisted conversations — there is
                // no incognito variant here, so there is always a row to share.
                shareable
              />
            </div>
          )}
        </div>
      </div>
    </ThoughtPanelProvider>
  );
}

/* ── The review tray ──────────────────────────────────────────────────────── */

/**
 * The notes written in the diff, waiting above the composer.
 *
 * It is a TRAY, not a message. Nothing here has been sent, and the sentence
 * says so in the verb — a card that read "Review sent" over text still sitting
 * in a buffer is the failure this whole arrangement replaced. It sits in
 * ComposerShell's `above` slot beside the attachment tray, which is the
 * established place for "this is riding out with your next message", and it
 * wears the same inset material and radius as the run stack under it.
 *
 * The body is folded to a few lines. A ten-note bundle is genuinely long, the
 * reader wrote every word of it moments ago, and the diff it came from is one
 * press away — so the tray's job is to prove the notes are still here, not to
 * be a second place to read them.
 */
function ReviewTray({
  notes,
  onDiscard,
  onOpenDiff,
}: {
  notes: string;
  onDiscard: () => void;
  onOpenDiff: () => void;
}) {
  const lines = notes.split("\n").filter((line) => line.trim());
  // Every line that starts a note, which is what the count is counting.
  const count = lines.filter((line) => line.startsWith("- ")).length;

  return (
    <div className="surface-inset mb-2 rounded-field px-3 py-2.5">
      <div className="flex items-center gap-2">
        <CodeIcons.file className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <p className="min-w-0 flex-1 truncate text-ui font-medium">
          {count === 0
            ? "Your review of the changes"
            : `${count} review ${count === 1 ? "note" : "notes"} from the changes`}
        </p>
        <Button variant="ghost" size="sm" className="shrink-0 gap-1.5" onClick={onOpenDiff}>
          <ActionIcons.edit className="size-3.5" aria-hidden="true" />
          Back to the diff
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-7 shrink-0"
          onClick={onDiscard}
          aria-label="Discard this review"
        >
          <ActionIcons.dismiss className="size-3.5" aria-hidden="true" />
        </Button>
      </div>
      <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap break-words text-caption text-muted-foreground">
        {notes}
      </p>
      <p className="mt-1.5 text-caption text-muted-foreground">
        Goes out with your next message — add anything else you want to say first.
      </p>
    </div>
  );
}
