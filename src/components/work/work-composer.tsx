"use client";

import * as React from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowUp,
  Check,
  ChevronDown,
  FileText,
  Loader2,
  Mic,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ComposerShell } from "@/components/ui/composer-shell";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Pressable } from "@/components/ui/pressable";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ConnectorStatus } from "@/components/connections/types";
import { LibraryPicker } from "@/components/chat/library-picker";
import { ComposerDictation } from "@/components/chat/composer-dictation";
import { ModelSelector } from "@/components/chat/model-selector";
import { ReasoningSlider } from "@/components/chat/reasoning-slider";
import { useApp } from "@/components/app/app-provider";
import { useUploads } from "@/hooks/use-uploads";
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";
import { AppIcons } from "@/lib/app-icons";
import { requiresViewerCredentials } from "@/lib/image-source";
import {
  clampReasoningEffort,
  defaultReasoning,
  reasoningOptions,
  type ReasoningEffort,
} from "@/lib/model-metrics";
import { resolveModel, type ModelId } from "@/lib/models";
import { DOC_MIME } from "@/lib/uploads";
import {
  DEFAULT_WORK_PERMISSION_POLICY,
  WORK_APPROVAL_MODE_SUMMARY,
  describeCapability,
  type HostCapabilityView,
  type WorkPermissionPolicy,
} from "@/lib/work/domain";
import { describeInference, inferCapabilities, selectForInferred } from "@/lib/work/inference";
import {
  AUTO_MODEL_ID,
  defaultWorkModelId,
  isAutoModelId,
  isWorkCapableModel,
} from "@/lib/work/models";
import type { ClientWorkHost, ClientWorkSession } from "@/lib/work/serializers";
import {
  WORK_SYNC_EVENT,
  createWorkSession,
  hostCapabilities,
  hostIsReachable,
  startWorkRun,
  workIdempotencyKey,
  type WorkBlocked,
  type WorkTransportFailure,
} from "@/components/work/work-transport";
import { DegradationNotes, WorkStateNote } from "@/components/work/work-vocabulary";
import { ComposerAddMenu } from "@/components/work/composer-home/composer-add-menu";
import { COMPOSER_CHIP_CLASS } from "@/components/work/composer-home/composer-chip";
import { WorkConnectorsChip } from "@/components/work/composer-home/connectors-chip";
import { WorkPermissionChip } from "@/components/work/composer-home/permission-chip";
import {
  WorkComposerVoicePanel,
  useWorkVoice,
  type WorkVoiceSend,
} from "@/components/work/voice";
import {
  applySkillInvocation,
  invokedSkill,
} from "@/components/work/composer-home/skill-invocation";
import { useWorkSkills } from "@/components/work/composer-home/use-work-skills";
import {
  appendClarifications,
  derivePreflightQuestions,
} from "@/components/work/clarify/preflight";
import { WorkPreflightCard } from "@/components/work/clarify/preflight-card";
import {
  WorkRunDisclosure,
  WorkRunTarget,
  runTargetLabel,
} from "@/components/work/clarify/run-disclosure";
import type { PreflightClarificationAnswer } from "@/lib/preflight-clarification";
import { cn, formatBytes } from "@/lib/utils";

/*
 * "Give Juno a task" — the Work home composer.
 *
 * This used to open with two chips: where the task should run, and what it was
 * allowed to need. Between them they made a person answer two questions about
 * Juno's architecture before they were allowed to describe their own errand,
 * and one of the two — a checklist of Juno's internal capability names — was a
 * question nobody outside this repository can answer. Both are gone. The
 * browser now always asks for `automatic` and sends no capability list at all;
 * the server reads the goal and decides.
 *
 * The apps question that replaced them is not the same kind of question, which
 * is the only reason it is allowed to be here. It asks which of the reader's own
 * connected apps this errand is about — a question about their work rather than
 * about Juno's internals, answerable by anyone who linked the app — and every
 * switch starts off, so a task reaches what it was handed and nothing else. It
 * is also a control that does something: the selection is stored on the session
 * and `scripts/work-runner.ts` narrows the run's connector set by it, which is
 * the bar a permission control has to clear before it is worth drawing.
 *
 * The approval mode — Manual, Auto, Skip — is here on the same terms and is the
 * second control to clear that bar. `approvalRuling` in src/lib/work/domain.ts
 * is what the three modes differ in, the session stores the choice, dispatch
 * narrows it against any Mac's advertised floor, and both executors gate on the
 * result. It is drawn now for exactly that reason and would not have been drawn
 * a week ago, when the three modes were the same mode wearing three names. It is
 * `WorkPermissionChip`, the same control in the same shape the thread composer
 * carries, rather than the three-segment control this file used to draw for it —
 * one surface asking one question two ways is how a reader concludes they are
 * two questions.
 *
 * ── TWO TIERS, AND WHICH CONTROL BELONGS IN WHICH ──────────────────────────
 *
 * The surface is `ComposerShell`, so the controls are split by a hairline into
 * what you do to THIS message and what stays true after you press Start. That
 * line moved three controls, and each move fixes a specific misreading:
 *
 *   - the project and the approval mode were a chip strip ABOVE the field. A
 *     strip above the field reads as part of the message being composed, which
 *     is the exact opposite of what those two are.
 *   - the apps were the third section of the [+], two gestures deep inside a
 *     menu that opens upward over the text. They are the standing reach of the
 *     run, not something spent on this sentence, and they now wear
 *     `WorkConnectorsChip` on the strip. The [+]'s dot badge went with them: it
 *     existed only because a granted app had no other trace on the surface.
 *   - the executor joined them as `WorkRunTarget`. It is the one item on the
 *     strip that is not a control, because Work has none to offer —
 *     `selectForInferred` decides and the dispatch route runs the same function
 *     over the same list — but "where is this going to run" is the third
 *     standing fact about a run and a reader is owed it before the press.
 *
 * What stayed above the line: the [+] (files and the skill), the model, the
 * thinking depth, dictation and the primary action. Every one of them is spent
 * on the sentence in the field and starts over on the next task.
 *
 * ── TALKING IT THROUGH ─────────────────────────────────────────────────────
 *
 * The primary action is also the voice launcher while the box is empty, which is
 * chat's arrangement (`showVoiceButton` in `chat/composer.tsx`) and the thread
 * composer's. What a spoken line does here is deliberately narrower than
 * anywhere else in the product: it goes into the goal field, and nothing starts.
 * See `voiceSend` below — `WorkSession.goal` is the sentence the plan is
 * validated against, so the only honest way for a conversation to reach it is in
 * front of the reader, where they can edit it and take it back out.
 *
 * What survived the deletion is the honesty architecture that surrounded them,
 * because it is the point of this surface. `selectForInferred`
 * (src/lib/work/inference.ts) is the same function the dispatch route runs over
 * the same inferred list, and running it here as well is what lets the composer
 * say what will happen BEFORE the task is created, rather than creating one that
 * sits queued at an executor that does not exist. It is fed
 * `inferCapabilities(goal).capabilities` instead of a user-chosen list, so the
 * preview follows the sentence as it is typed.
 *
 * It is deliberately not `selectTarget`, which this file used to call. The two
 * disagree in exactly one case and it is the case that matters here:
 * `selectTarget` refuses outright when a required local capability has no Mac to
 * serve it, and the dispatch route stopped doing that for a list it inferred —
 * it drops the guessed local capabilities, runs what the cloud can serve, and
 * says which parts will not happen. Previewing with `selectTarget` therefore
 * greyed out the button over a dead end the server would no longer produce, on
 * the strength of a regex reading of the reader's own prose. A preview that
 * disagrees with the dispatch is worse than no preview, because it is believed.
 *
 * The website deliberately shows no fleet of Macs. It used to list every host,
 * its display name, its state and what it had been granted — a status board for
 * machines the reader cannot see, reach or wake from this page. The host list is
 * still loaded and still fed to the preview, because "no Mac is switched on for
 * Juno Work" is a real answer to "why will this not start"; it is simply
 * delivered as that one sentence rather than as an inventory.
 *
 * The pre-flight card below the surface is the third control to clear the bar
 * the Apps chip and the approval mode set, and it clears it in the one way this
 * surface had left uncovered. Everything above tells the reader what Juno read
 * into their sentence; nothing asked them about the parts it could not read. A
 * run holds a $2, 600,000-token, twenty-minute ceiling and nobody is watching
 * it, so a misread goal is not a paragraph to ask again for — it is the whole
 * ceiling spent on the wrong errand, discovered at the end.
 *
 * It is offered rather than imposed, and the send control never stops working
 * while it is open: skipping it is the same key that has always started a task,
 * which is the only arrangement under which "skip" is not the slow path. Its
 * questions come from `derivePreflightQuestions`, which is regexes over the
 * same goal text for the same reason `inferCapabilities` is — no round trip
 * before the button works, no cost on a card the reader may ignore, and no
 * failure mode where the feature is quietly absent on the day the provider is
 * struggling. The answers land in the textarea in front of the reader rather
 * than being posted behind it: `WorkSession.goal` is documented as verbatim and
 * is what the plan is checked against, so the only honest way to add to it is
 * to add to it where the reader can see it and take it back out.
 *
 * Starting is two requests, because the server splits them: POST /sessions
 * writes a draft that costs nothing and holds no executor, and POST
 * /sessions/[id]/runs is the only thing that dispatches and the only thing that
 * can refuse. Both are sent with idempotency keys held across retries, so
 * pressing the button again after a refusal reuses the draft instead of leaving
 * a trail of abandoned ones — for exactly as long as what the draft carries is
 * unchanged, which is what `StartAttempt` below is about.
 */

/**
 * Where the reader's model choice is kept.
 *
 * `localStorage` rather than the account settings for the same reason
 * `/code/new` keeps its target there: this is a per-browser habit, not a
 * preference the Mac app should inherit. It is read in a mount effect and never
 * in `useState`'s initialiser — the server renders this component too, and a
 * first render that consulted `localStorage` would disagree with the HTML that
 * arrived.
 */
const MODEL_KEY = "juno:work:model";

/**
 * What the file picker offers, which is deliberately narrower than the chat
 * composer's `ACCEPT_ATTRIBUTE`: the same list with every image type removed.
 *
 * A Work run is handed its attachments by `attachedSources` in
 * scripts/work-runner.ts, which reads `Attachment.extractedText` and nothing
 * else. That column is null for an image, so a photo reached the model as a file
 * name with no content behind it — the reader saw a thumbnail in the composer
 * and got an agent that had never seen the picture. Offering the picker and
 * then reporting that nothing could be read out of the file is a worse answer
 * than not offering it, because nothing in the menu distinguishes the two.
 *
 * The document types stay, PDFs included, even though a PDF has no extracted
 * text either. The difference is what is being promised: a document is handed
 * over to be worked from, the run now says out loud when it could not read one,
 * and the reader can act on that. "Photos" promised Juno would look at a
 * picture, which is the one thing this path can never do.
 *
 * The Code composer keeps its Photos entry. That path sends attachments to a
 * different runtime and is not affected by any of this.
 */
const WORK_ACCEPT_ATTRIBUTE = [
  ...DOC_MIME,
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".ts",
  ".tsx",
  ".js",
  ".py",
].join(",");

/**
 * One attempt at starting, carried across retries.
 *
 * The two keys are minted once per attempt rather than per press. A press that
 * created the draft and then failed to dispatch must, on the next press, land on
 * the same draft — `POST /sessions` replays an existing id for a repeated key —
 * or every refused start leaves another orphan in the user's task list. Changing
 * the model between presses is safe despite the replay: the model rides the run
 * as well as the session, and the run is dispatched fresh each time.
 *
 * `inputs` is everything the create writes and the dispatch cannot: the goal,
 * the project and the attachment ids. It was the goal alone, and the replay is
 * what turned that into a bug. A file attached after a refused press — or a
 * project picked, or an attachment taken back off — changed nothing the second
 * press sent, because the second press skips the create and the draft still held
 * the first press's list; and then `clear()` wiped the chips on success as
 * though they had been sent. There is no route that edits a session's grants
 * afterwards — `POST /sessions` refuses to re-grant on a replay, on purpose, so
 * that a retry cannot rewrite the grants of a session somebody is already
 * running — so a fresh key, and with it a fresh draft, is the only way to send
 * what is on the screen.
 */
interface StartAttempt {
  inputs: string;
  sessionKey: string;
  runKey: string;
  session: ClientWorkSession | null;
  confirmExpensive?: boolean;
}

/** A press that started nothing, and whether pressing again could. */
interface StartFailure {
  message: string;
  /** False for a wall — a state where the button would ask the same question. */
  retryable: boolean;
}

/**
 * What to say about a failed request, and whether to offer a button at all.
 *
 * `work-transport.tsx` separates 400 and 401/403 from `server` so that, in its
 * own words, "the UI can stop offering a button that cannot work"; this is the
 * half that honours it. A 400 is a client this deployment no longer agrees with,
 * a 403 is a plan, a 404 is something the task points at that is gone, and none
 * of the three answer differently the second time. Only a dropped connection and
 * a 5xx get a Try again, because only those two are about the moment rather than
 * the request.
 *
 * The server's sentence wins wherever there is one. It is the only thing in this
 * exchange that knows which model, which plan or which file, and the fallbacks
 * below exist for the routes that answer with a bare code — `requireUser`'s 401
 * is the common one. They say what is known and stop; a fallback that guessed at
 * the cause would be a second, quieter way of getting it wrong.
 */
function describeFailure(failure: WorkTransportFailure, phase: "save" | "start"): StartFailure {
  if (failure.cause === "offline") {
    return {
      retryable: true,
      message:
        phase === "save"
          ? "Couldn’t reach Juno to save this task. Check your connection."
          : "Couldn’t reach Juno to start this task. Check your connection.",
    };
  }
  if (failure.cause === "server") {
    return {
      retryable: true,
      message:
        phase === "save"
          ? "Couldn’t save this task, so nothing was started."
          : "Couldn’t start this task, so nothing is running.",
    };
  }
  if (failure.message !== null) return { retryable: false, message: failure.message };
  if (failure.cause === "not_found") {
    return {
      retryable: false,
      message:
        "Something this task points at is no longer there — an attachment, the project, or the draft itself. Nothing was started.",
    };
  }
  if (failure.cause === "rejected") {
    return {
      retryable: false,
      message:
        "Juno wouldn’t accept this request, and pressing the button again sends the same one. Reloading the page may help.",
    };
  }
  return {
    retryable: false,
    message:
      "Juno turned this down without saying why. You may have been signed out — reload the page to check.",
  };
}

export function WorkComposer({
  hosts,
  hostsFailed,
  onRetryHosts,
}: {
  /** Null while the host list is still loading. */
  hosts: ClientWorkHost[] | null;
  hostsFailed: boolean;
  onRetryHosts: () => void;
}) {
  const router = useRouter();
  const { features, composerPrefs, setComposerPrefs } = useApp();
  const [goal, setGoal] = React.useState("");
  /**
   * The project this task is filed in, held as id AND name.
   *
   * The id is all the wire wants; the name is what the voice briefing has to say
   * out loud, because a spoken conversation that reported "not filed in a
   * project" about a task that is filed in one would be the model asserting
   * something the screen contradicts. The chip is the only thing on this page
   * that ever loads the project list, so it is the only thing that can supply
   * the name, and it hands both back at the moment of the press rather than the
   * composer keeping a second copy of the list to look one up in.
   */
  const [project, setProject] = React.useState<{ id: string; name: string } | null>(null);
  const projectId = project?.id ?? null;
  /**
   * The connected apps this task may reach. Empty, and empty is a real answer.
   *
   * Every switch starts off and the list is sent on every create, including when
   * it is empty, so a task reaches exactly what the reader handed it and nothing
   * else. Sending it unconditionally is also what removes the race: a list that
   * were only sent "once the account's apps have loaded" would quietly fall back
   * to the account's own rules for anyone who pressed the button early, which is
   * the one outcome the default exists to prevent.
   */
  const [connectorIds, setConnectorIds] = React.useState<string[]>([]);
  /**
   * The account's linked apps, loaded once and shared.
   *
   * Hoisted out of the Apps chip because two surfaces now need the same list
   * and neither may have its own copy of it: the chip draws the switches, and
   * the pre-flight card has to know that an app named in the goal is one this
   * account has actually connected before it offers to switch it on. A second
   * fetch would be a second answer to "is GitHub linked", and the two would
   * disagree the first time somebody disconnected it in another tab.
   */
  const apps = useConnectedApps();
  /**
   * The skills this task could name.
   *
   * The home composer had no skill picker at all: the only way to run a task
   * under a skill from here was to type `/slug` from memory, while the thread
   * composer one click away offered the account's own list. Same hook, same
   * endpoint, same `enabled=true` filter as the thread panel — a second fetch
   * written for this surface would be a second answer to "which skills do I
   * have".
   */
  const skills = useWorkSkills();
  const [model, setModel] = React.useState<ModelId>(defaultWorkModelId);
  const [submitting, setSubmitting] = React.useState(false);
  const [blocked, setBlocked] = React.useState<WorkBlocked | null>(null);
  const [draft, setDraft] = React.useState<ClientWorkSession | null>(null);
  const [failure, setFailure] = React.useState<StartFailure | null>(null);
  const [libraryOpen, setLibraryOpen] = React.useState(false);
  const [removingIds, setRemovingIds] = React.useState<string[]>([]);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const [dictating, setDictating] = React.useState(false);
  /** Set when dictation ends with "send"; consumed once the new goal is in state. */
  const pendingSendRef = React.useRef(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const attemptRef = React.useRef<StartAttempt | null>(null);

  const canAttach = features.storage;
  // `null` conversation: these files belong to a Work task, not to a chat. The
  // upload route accepts that and the ids are handed to the session on create.
  const { uploads, addFiles, addAttachments, remove, clear, readyAttachments, isUploading } =
    useUploads(null);

  // Thinking effort, read from the same account-wide preference chat and
  // /code/new write to, so a Work task opens on whatever the reader last chose
  // rather than inventing a second answer to the same question.
  //
  // It is now editable here, and that is a change of fact rather than of taste.
  // This composer showed no effort control for as long as the Work executor
  // could not carry one: `WorkSessionOptions` had no field for a thinking
  // budget and no provider adapter could send one, so a dial here would have
  // been a promise the run ignored. Both ends exist now —
  // `ProviderRequest.reasoningEffort` reaches the Anthropic adapter as
  // `thinking` + `output_config` and the OpenAI-compatible ones as
  // `reasoning_effort`, and `reasoningEffortFor` in scripts/work-runner.ts
  // resolves what this composer sends — so the control is drawn.
  const reasoningEffort = composerPrefs.reasoningEffort;
  const setReasoningEffort = React.useCallback(
    (next: ReasoningEffort) => setComposerPrefs({ reasoningEffort: next }),
    [setComposerPrefs]
  );
  const resolved = resolveModel(model);
  /**
   * The effort this model would honour, not the one the preference happens to
   * hold.
   *
   * The preference is shared across every composer, so it can arrive here set to
   * a tier this model has never offered — Max chosen in chat on a flagship, then
   * a Work task started on a model that stops at High. Clamping is what keeps
   * the value on the wire describing a run this model could actually have had.
   */
  const effort: ReasoningEffort = React.useMemo(
    () => (resolved ? clampReasoningEffort(resolved, reasoningEffort) : reasoningEffort),
    [resolved, reasoningEffort]
  );
  /**
   * The tiers this model offers, and the gate on whether a control is drawn.
   *
   * Empty for Auto, because Auto picks the depth with the model and a dial over
   * a routing decision would be a setting the router is entitled to ignore —
   * the chat composer says the same thing in the same place. Empty too for a
   * model that exposes no tiers at all, where a one-stop slider is a question
   * with one answer.
   */
  const effortOptions = React.useMemo(
    () => (isAutoModelId(model) || !resolved ? [] : reasoningOptions(resolved)),
    [model, resolved]
  );

  /**
   * How often this task stops to ask, before it starts.
   *
   * Auto by default, which is `DEFAULT_WORK_PERMISSION_POLICY` and the value
   * the column has always held — so the control changes what a reader can see
   * and decide, not what an unattended default does. Local state rather than a
   * remembered preference: unlike the model, the right answer here is a
   * property of the errand rather than a habit, and a Skip carried forward from
   * "tidy my Downloads" onto "reply to these six emails" would be the composer
   * granting one task's licence to another.
   */
  const [approvalMode, setApprovalMode] = React.useState<WorkPermissionPolicy>(
    DEFAULT_WORK_PERMISSION_POLICY
  );

  React.useEffect(() => {
    try {
      const saved = localStorage.getItem(MODEL_KEY);
      if (!saved) return;
      if (isAutoModelId(saved)) {
        setModel(AUTO_MODEL_ID);
        return;
      }
      // A model the runner cannot drive is dropped rather than restored. The
      // catalog moves — a model that was fine in March can be deprecated by
      // August — and restoring one would show the reader a picked model that
      // the picker itself no longer offers, with no way to tell why.
      const restored = resolveModel(saved);
      if (restored && isWorkCapableModel(restored)) setModel(restored.id);
    } catch {
      // A browser that refuses storage is a browser with no saved choice.
    }
  }, []);

  // The same guard the chat and Code composers apply, and it belongs here now
  // that the effort is on screen: switching to a model that does not offer the
  // tier the shared preference holds drops it to that model's default rather
  // than leaving a label naming a depth the picker below it does not list. This
  // file used to refuse the write on the grounds that a Work task must not
  // silently lower the thinking tier of the next chat turn from a control
  // nobody could see — the control is visible, so the objection has gone with
  // it. `effort` is still clamped for the wire, which covers the case no model
  // change ever happens: a preference set to Max in chat and brought straight
  // here on a model that stops at High.
  const changeModel = React.useCallback(
    (next: ModelId) => {
      setModel(next);
      const info = resolveModel(next);
      if (info) {
        const options = reasoningOptions(info);
        if (!options.some((option) => option.value === reasoningEffort)) {
          setReasoningEffort(defaultReasoning(info));
        }
      }
      try {
        localStorage.setItem(MODEL_KEY, next);
      } catch {
        // Not being able to remember the choice does not stop them making it.
      }
    },
    [reasoningEffort, setReasoningEffort]
  );

  const autoresize = React.useCallback(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
  }, []);
  React.useEffect(() => {
    autoresize();
  }, [goal, autoresize]);

  const removeUpload = React.useCallback(
    (localId: string) => {
      setRemovingIds((prev) => [...prev, localId]);
      window.setTimeout(() => {
        remove(localId);
        setRemovingIds((prev) => prev.filter((id) => id !== localId));
      }, 180);
    },
    [remove]
  );

  /**
   * The skill the goal currently names, matched against the account's library.
   *
   * Matched rather than merely parsed — see `invokedSkill`. A goal opening
   * `/tmp is full of junk` is not an invocation of a skill called `tmp`, and
   * treating it as one would have the menu replace the reader's first three
   * characters when they picked a real one.
   */
  const invoked = invokedSkill(goal, skills.skills);
  const invokeSkill = React.useCallback(
    (slug: string | null) => {
      setGoal((current) => applySkillInvocation(current, slug, invokedSkill(current, skills.skills)));
      // Back to the field: the reader is about to watch text appear in their own
      // textarea, and leaving focus on a menu that has closed puts the one thing
      // that changed off-screen on a phone.
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
    [skills.skills]
  );

  const toggleConnector = React.useCallback((connectorId: string) => {
    setConnectorIds((prev) =>
      prev.includes(connectorId)
        ? prev.filter((id) => id !== connectorId)
        : [...prev, connectorId]
    );
  }, []);

  /** What the goal looks like it will need, re-read on every keystroke. */
  const inference = React.useMemo(() => inferCapabilities(goal), [goal]);

  /**
   * The exact goal text the reader last settled the pre-flight card on, whether
   * by answering it or by dismissing it.
   *
   * Compared against the whole string rather than held as a boolean, so the
   * card comes back when the task changes and stays gone when it does not.
   * A boolean would mean a reader who dismissed the questions for one errand,
   * cleared the field and typed a different one would never be asked again;
   * clearing on every keystroke would mean a dismissed card reappearing on the
   * next character, which is a dismissal that does not dismiss.
   */
  const [preflightSettled, setPreflightSettled] = React.useState<string | null>(null);

  const preflightQuestions = React.useMemo(
    () =>
      derivePreflightQuestions({
        goal,
        // The composer's own reading, not a second one. `inferCapabilities` has
        // already been run for the caption below; a question that disagreed
        // with the sentence directly under it would be two readings of the same
        // text presented as one.
        inferred: inference.capabilities,
        connectors: (apps.connectors ?? []).map((connector) => ({
          id: connector.id,
          label: connector.label,
        })),
        selectedConnectorIds: connectorIds,
      }),
    [goal, inference.capabilities, apps.connectors, connectorIds]
  );

  const showPreflight =
    !submitting && preflightQuestions.length > 0 && preflightSettled !== goal;

  /**
   * Writes the answers into the task and grants what they granted.
   *
   * The text goes into the textarea rather than onto the wire as a second
   * field: `WorkSession.goal` is the sentence the plan is validated against and
   * is documented as what the user actually asked for, so the answers have to
   * arrive as something the reader watched appear and can still delete. The
   * connector grants cannot travel that way — a sentence saying "reach GitHub"
   * grants nothing, `evaluateConnector` reads the grant rows — so those are
   * applied to the Apps chip in the same action, and the two cannot disagree
   * because they are set from the same answer.
   */
  const acceptPreflight = React.useCallback(
    (answers: PreflightClarificationAnswer[], grantConnectorIds: string[]) => {
      const next = appendClarifications(goal, answers);
      setGoal(next);
      setPreflightSettled(next);
      if (grantConnectorIds.length > 0) {
        setConnectorIds((prev) => [
          ...prev,
          ...grantConnectorIds.filter((connectorId) => !prev.includes(connectorId)),
        ]);
      }
      // Back to the field, where the reader can now see what was added and take
      // any of it out again. Landing focus on a button they have just used
      // would leave the one thing that changed off-screen on a phone.
      textareaRef.current?.focus();
    },
    [goal]
  );

  const skipPreflight = React.useCallback(() => setPreflightSettled(goal), [goal]);

  const attachmentIds = React.useMemo(
    () => readyAttachments.map((attachment) => attachment.id),
    [readyAttachments]
  );
  /**
   * Everything a draft is created with, as one comparable string.
   *
   * The ids are joined in order rather than sorted: the create route builds the
   * grants in the order they arrive, and that is the order the files are listed
   * back and put in front of the agent, so a reordering is a different request.
   * A count, or a check for ids that are new, would have missed the removal —
   * take a file back off and the shorter list still looked like the attempt that
   * was already granted it.
   *
   * The connector selection is in here for the same reason a file is: switching
   * an app off between two presses is a narrowing that has to reach the server,
   * and an attempt that reused its key would send the first press's permissions
   * under the second press's button. The approval mode is the same argument
   * again and the sharpest instance of it — a reader who is refused, moves the
   * task from Skip to Manual and presses again is asking for a different thing
   * to happen, and a replayed draft would run it under the mode they just
   * changed their mind about.
   */
  const inputsKey = React.useMemo(
    () => JSON.stringify([goal.trim(), projectId, attachmentIds, connectorIds, approvalMode]),
    [goal, projectId, attachmentIds, connectorIds, approvalMode]
  );

  /*
   * A note below is about the press that produced it, and that press was about
   * these inputs. Both were cleared only at the top of `submit`, so a refusal
   * outlived the goal it was about: the server's sentence about the previous
   * task sat under a freshly typed one, and — because the live preview is
   * suppressed while `blocked` is set — the new goal got no preview at all until
   * the button was pressed again. The draft link goes with them, since it points
   * at the session the old press created and not at anything this one will.
   */
  React.useEffect(() => {
    setBlocked(null);
    setFailure(null);
    setDraft(null);
  }, [inputsKey]);

  const candidateHosts: HostCapabilityView[] = React.useMemo(
    () =>
      (hosts ?? []).filter(hostIsReachable).map((host) => ({
        hostId: host.id,
        displayName: host.displayName,
        state: host.state,
        enabled: host.enabled,
        revoked: host.revokedAt !== null,
        capabilities: hostCapabilities(host),
      })),
    [hosts]
  );

  const selection = React.useMemo(
    () =>
      selectForInferred({
        requested: "automatic",
        inferred: inference.capabilities,
        hosts: candidateHosts,
        // The browser has no way to observe whether the cloud executor is
        // accepting work — `/api/work/hosts` describes Macs and nothing else —
        // so the preview assumes it is and lets the dispatch be the authority.
        // Assuming the other way would grey out the primary action on the basis
        // of a fact nobody established. When the cloud really is paused the
        // dispatch answers 409 with the server's own sentence, which is shown
        // below in place of this preview.
        cloudAvailable: true,
      }),
    [inference.capabilities, candidateHosts]
  );

  const loadingHosts = hosts === null && !hostsFailed;
  // A failed host load is not the same as "nothing is available": Juno simply
  // does not know. A local task previewed against an empty host list would be
  // told its local part is not going to run — a statement about the fleet, made
  // on the strength of a request this page never got an answer to, and about
  // nothing the reader could act on.
  const executorsUnknown = hostsFailed && hosts === null;
  const canStart =
    goal.trim().length > 0 &&
    !submitting &&
    !isUploading &&
    !loadingHosts &&
    !executorsUnknown &&
    selection.target !== null;

  const submit = React.useCallback(async () => {
    const text = goal.trim();
    if (!text || submitting || isUploading || selection.target === null) return;

    // A new attempt whenever anything the draft carries has changed. Re-pressing
    // after a refusal with the same inputs keeps the keys, so the draft created
    // by the first press is the one dispatched by the second rather than a
    // sibling of it; a changed goal, project or file list mints a new pair,
    // because the create is skipped on the second press and replaying the first
    // key would send the first press's inputs under the second press's button.
    let attempt = attemptRef.current;
    if (attempt === null || attempt.inputs !== inputsKey) {
      attempt = {
        inputs: inputsKey,
        sessionKey: workIdempotencyKey(),
        runKey: workIdempotencyKey(),
        session: null,
      };
      attemptRef.current = attempt;
    }

    setSubmitting(true);
    setBlocked(null);
    setFailure(null);

    let session = attempt.session;
    if (session === null) {
      const created = await createWorkSession({
        goal: text,
        requestedTarget: "automatic",
        preferredHostId: null,
        projectId,
        model,
        reasoningEffort: effort,
        // Sent on every create, including when it is the default. A session
        // records what its owner was shown and chose; "they left it on Auto"
        // and "this client never asked" are different facts and the route
        // reads the silence as the second.
        permissionPolicy: approvalMode,
        attachmentIds,
        connectorIds,
        idempotencyKey: attempt.sessionKey,
      });
      if (created.kind !== "ok") {
        setSubmitting(false);
        if (created.kind === "blocked") {
          setBlocked(created);
          return;
        }
        const described = describeFailure(created, "save");
        setFailure(described);
        toast.error(described.message);
        return;
      }
      session = created.value;
      attempt.session = session;
      setDraft(session);
      // The sidebar mounts once and polls on its own clock, so without this the
      // draft the user just created is missing from the list beside them.
      window.dispatchEvent(new CustomEvent(WORK_SYNC_EVENT));
    }

    // No `requiredCapabilities`: the server infers them from the goal it was
    // given. Sending the local preview's list would look like agreement and act
    // like an override — a regex run in this bundle would silently outrank
    // whatever the dispatch route knows.
    const started = await startWorkRun(session.id, {
      origin: "manual",
      requestedTarget: "automatic",
      model,
      reasoningEffort: effort,
      confirmExpensive: attempt.confirmExpensive === true,
      idempotencyKey: attempt.runKey,
    });
    setSubmitting(false);

    if (started.kind === "ok") {
      setGoal("");
      // The next task gets asked its own questions. Left set, this would hold
      // the empty string and match the empty field, so the first errand typed
      // after a successful start would silently get no pre-flight at all.
      setPreflightSettled(null);
      clear();
      // The next task starts from off, like this one did. Carrying the selection
      // forward would be the composer granting an app to a task nobody has
      // written yet, on the strength of a decision made about a different one.
      setConnectorIds([]);
      // Back to Auto for the same reason, and it is the stronger case: a Skip
      // chosen for one errand is a licence granted to that errand, not a
      // setting the reader turned on.
      setApprovalMode(DEFAULT_WORK_PERMISSION_POLICY);
      setDraft(null);
      attemptRef.current = null;
      window.dispatchEvent(new CustomEvent(WORK_SYNC_EVENT));
      router.push(`/work/${session.id}`);
      return;
    }
    if (started.kind === "blocked") {
      // The server re-ran the same selection against fresher facts and refused.
      // Its sentence replaces the preview rather than sitting beside it, and the
      // draft it refused to run is linked so the task is not simply lost.
      setBlocked(started);
      return;
    }
    // A dispatch that 404s means the draft is gone — deleted from the list beside
    // this composer, or from another tab. The attempt goes with it: replaying its
    // session key would land on a session that no longer exists, and the link
    // below would offer to open one. The next press starts clean.
    if (started.cause === "not_found") {
      attemptRef.current = null;
      setDraft(null);
    }
    const described = describeFailure(started, "start");
    setFailure(described);
    toast.error(described.message);
  }, [
    goal,
    submitting,
    isUploading,
    selection.target,
    projectId,
    model,
    effort,
    approvalMode,
    attachmentIds,
    connectorIds,
    inputsKey,
    clear,
    router,
  ]);

  const { supported: speechSupported } = useSpeechRecognition();

  /**
   * Leave dictation, with the words.
   *
   * Appends rather than replaces: the reader may well have typed half the task,
   * hit the mic for the rest, and losing the typed half is not a tradeoff
   * anyone accepted. Same rule as the Code composer's `closeDictation`.
   *
   * `sendNow` still goes through `canStart`, not straight to `submit()`. Work
   * refuses to start without an executor, and a spoken task that vanished
   * because no host was reachable would be the worst possible place to discover
   * that — so it parks the transcript in the field instead, where the reader can
   * finish setting up and press Start with their words still in front of them.
   */
  const closeDictation = React.useCallback(
    (transcript: string, sendNow: boolean) => {
      setDictating(false);
      const merged = [goal.trim(), transcript.trim()].filter(Boolean).join(" ");
      setGoal(merged);
      if (!sendNow || !merged) {
        requestAnimationFrame(() => textareaRef.current?.focus());
        return;
      }
      if (!canStart) {
        toast.message("Saved to the task", {
          description: selection.target === null ? selection.explanation : "Finish setting up, then press Start.",
        });
        requestAnimationFrame(() => textareaRef.current?.focus());
        return;
      }
      // Deferred to an effect, NOT to a rAF. `submit` closes over `goal` from
      // the render it was built in, so calling it from here — or from a frame
      // callback scheduled here — starts the task with the PRE-merge text and
      // silently drops everything that was just dictated. The effect below runs
      // after the new goal has landed, with the submit that can see it.
      pendingSendRef.current = true;
    },
    [goal, canStart, selection.target, selection.explanation],
  );

  /** Fires the send that `closeDictation` deferred, once `goal` has updated. */
  React.useEffect(() => {
    if (!pendingSendRef.current) return;
    pendingSendRef.current = false;
    if (canStart) void submit();
  }, [goal, canStart, submit]);

  /* ─────────────────────────── talking it through ─────────────────────────── */

  /**
   * The spoken conversation, gated exactly as chat gates its own.
   *
   * `useWorkVoice` returns `undefined` rather than a no-op when this deployment
   * has no relay or the account's plan has no voice, and the primary button
   * below reads that exact absence to decide whether it is a launcher or a plain
   * Start. It is the same hook the thread composer uses, so the two surfaces
   * cannot drift on when voice is offered.
   */
  const voice = useWorkVoice();

  /** The apps switched on, in the words the reader chose them by. */
  const connectorLabels = React.useMemo(
    () =>
      (apps.connectors ?? [])
        .filter((connector) => connectorIds.includes(connector.id))
        .map((connector) => connector.label),
    [apps.connectors, connectorIds]
  );

  /**
   * What a spoken line does here: it goes in the box.
   *
   * Not `submit()`. A voice call is thinking out loud and the sentence somebody
   * lands on is a draft, not a decision to spend a run — and `WorkSession.goal`
   * is documented as the words the user actually asked for, checked against the
   * plan, so a transcript posted as the goal would be a task nobody wrote. This
   * is the same rule `acceptPreflight` follows for the same reason: text the
   * reader can see, edit and delete before anything is started.
   *
   * Appended rather than replacing, on a blank line, because the reader may well
   * have typed half the errand before reaching for the microphone — the same
   * merge `closeDictation` does, and losing the typed half is not a trade anyone
   * agreed to. It refuses while a start is in flight: the field is disabled then,
   * so words dropped into it would land somewhere the reader cannot see or undo,
   * and `false` leaves them on screen in the call to be sent again.
   */
  const voiceSend = React.useMemo<WorkVoiceSend>(
    () => ({
      intent: { kind: "compose" },
      sending: submitting,
      onSend: async (text: string) => {
        if (submitting) return false;
        setGoal((current) => [current.trimEnd(), text.trim()].filter(Boolean).join("\n\n"));
        return true;
      },
    }),
    [submitting]
  );

  /**
   * When the primary button is the voice launcher instead of Start.
   *
   * Chat's rule in chat's shape — nothing to send, voice available — with one
   * deliberate difference. Chat reads `!canSend`; this reads the DRAFT rather
   * than `canStart`, because `canStart` is also false while the host list is in
   * flight and while no executor can serve the task. Keyed off `canStart`, a
   * reader with a written task and a slow `/api/work/hosts` would watch the
   * Start button they were reaching for turn into a phone call.
   */
  const showVoiceButton =
    !submitting && goal.trim().length === 0 && !!voice.onOpenVoiceMode;

  const confirmExpensiveAndSubmit = React.useCallback(() => {
    if (attemptRef.current === null) return;
    attemptRef.current.confirmExpensive = true;
    setBlocked(null);
    void submit();
  }, [submit]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (canStart) void submit();
    }
  };

  const draftLink =
    draft === null ? null : (
      <Link
        href={`/work/${draft.id}`}
        className="font-medium underline underline-offset-2 hover:text-foreground"
      >
        Open the draft
      </Link>
    );

  /*
   * The caption under the surface, at most two lines: what Juno read into the
   * goal, then what it will do about it. Each is suppressed rather than padded
   * out when it has nothing to say — an inference that found nothing is a
   * normal answer, and a line reserved for it would be a permanent blank strip
   * under the composer. The second line stands down entirely when a note below
   * is about to carry the same sentence in a louder tone; saying it twice reads
   * as two separate problems.
   */
  const inferenceLine = describeInference(inference, describeCapability);
  // No "Checking where this can run…" branch any more: the utility strip spins
  // and says "Checking…" in the same moment, and one wait reported twice reads
  // as two things being waited on.
  const runLine =
    executorsUnknown || loadingHosts || blocked !== null || selection.target === null
      ? null
      : selection.explanation;

  return (
    <div className="w-full">
      {/*
       * `composer-aura-host` + `isolate`, so the voice field can light this
       * composer the way it lights chat's. The aura paints at `z-index: -1` and
       * therefore needs a stacking context here to mean "behind the composer"
       * rather than "behind whichever distant ancestor happens to make one".
       * Both are inert until the panel mounts something that reads them, which
       * is why the wrapper is unconditional.
       *
       * The panel is a SIBLING of the shell rather than a wrapper around it, for
       * the same reason: its first child is the aura, and an aura nested inside
       * a box paints behind that box instead of behind the composer.
       */}
      <div className="composer-aura-host relative isolate w-full">
        {voice.open && (
          <WorkComposerVoicePanel
            briefing={{
              goal,
              projectName: project?.name ?? null,
              connectorLabels,
              approvalSummary: WORK_APPROVAL_MODE_SUMMARY[approvalMode],
              where:
                loadingHosts || executorsUnknown || selection.target === null
                  ? null
                  : runTargetLabel(
                      selection.target,
                      (hosts ?? []).find((host) => host.id === selection.hostId)?.displayName ?? null
                    ),
            }}
            send={voiceSend}
            onClose={voice.close}
          />
        )}

        {/*
         * Dictation and the composer share one grid cell and cross-fade, which
         * is how the chat, thread and Code composers all do it and is a change
         * of arrangement here: this surface used to render the dictation capsule
         * INSIDE the shell, above the field, so the shell grew and shrank around
         * it. That was tolerable while the shell had one tier. With a utility
         * strip attached underneath, a capsule pushing the field down also
         * pushes the strip down, and the one element on the page that is
         * supposed to sit still — the standing context of the run — moves every
         * time somebody reaches for the microphone.
         *
         * `min-height` is the only animated layout property. The transcript
         * preview floats above the capsule and needs the headroom; the two
         * layers themselves move on opacity and transform, which stay on the
         * compositor.
         */}
        <div
          className={cn(
            "relative grid w-full grid-cols-1 grid-rows-1 items-end justify-items-center",
            "transition-[min-height] duration-slow ease-out-strong motion-reduce:transition-none",
            dictating ? "min-h-[170px]" : "min-h-0"
          )}
        >
          <div
            // `inert` is what actually takes this half of the cross-fade out of the
            // page. `opacity-0 pointer-events-none` hides it from the eye and the
            // mouse and leaves it in the tab order and the accessibility tree, so a
            // keyboard or screen-reader user could reach a composer that is not on
            // screen — and, mid-dictation, type into it. Same defect the chat
            // transcript's jump-to-latest button had.
            inert={!dictating}
            className={cn(
              "col-start-1 row-start-1 z-30 flex w-full justify-center transition-[opacity,transform] duration-base ease-out-strong motion-reduce:transition-none",
              dictating
                ? "translate-y-0 scale-100 opacity-100"
                : "pointer-events-none translate-y-1 scale-95 opacity-0"
            )}
          >
            {/* Mounted only while active — ComposerDictation holds a microphone
                stream and a recognition session for its whole life. */}
            {dictating && (
              <ComposerDictation
                onCancel={() => setDictating(false)}
                onStop={(t) => closeDictation(t, false)}
                onSend={(t) => closeDictation(t, true)}
              />
            )}
          </div>

          {/* The fade is on a wrapper rather than on the shell: `ComposerShell`
              already declares `transition-[border-color,box-shadow]`, and a
              second arbitrary `transition-[…]` on the same element is resolved
              by stylesheet order rather than by class order — so one of the two
              would silently win, and which one is not something this file gets
              to decide. */}
          <div
            // `inert` is what actually takes this half of the cross-fade out of the
            // page. `opacity-0 pointer-events-none` hides it from the eye and the
            // mouse and leaves it in the tab order and the accessibility tree, so a
            // keyboard or screen-reader user could reach a composer that is not on
            // screen — and, mid-dictation, type into it. Same defect the chat
            // transcript's jump-to-latest button had.
            inert={dictating}
            className={cn(
              "col-start-1 row-start-1 w-full transition-[opacity,transform] duration-base ease-out-strong motion-reduce:transition-none",
              dictating && "pointer-events-none translate-y-1 scale-[0.98] opacity-0"
            )}
          >
            <ComposerShell
              utilityLabel="What this task is filed under and where it runs"
              /*
               * ── Above the field ────────────────────────────────────────────
               * The documents this task is handed, as chips, so they are visible
               * without opening anything.
               */
              above={
                canAttach ? (
                  <div
                    className={cn(
                      "grid transition-[grid-template-rows] duration-base ease-out-soft",
                      uploads.length > 0 ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
                    )}
                  >
                    <div className="min-h-0 overflow-hidden">
                      <div className="flex flex-wrap gap-2 px-3 pb-0 pt-2.5 sm:px-3.5">
                        {uploads.map((upload) => (
                          <div
                            key={upload.localId}
                            className={cn(
                              // `rounded-control`, the same rung the thread
                              // composer's attachment rows sit on — these were
                              // 8px there and 24px here for the same object in
                              // the same product.
                              // `bg-secondary`, not `bg-background` + `shadow-soft`.
                              // The shell around this chip is `bg-card`; on a pure-
                              // black ground `bg-background` made the chip darker
                              // than the surface holding it, and `--shadow-soft` in
                              // dark is black ink, so the elevation cue did nothing
                              // at all. On black the lift has to come from lightness.
                              "flex items-center gap-2 rounded-control border border-border/60 bg-secondary px-2.5 py-2 text-xs",
                              removingIds.includes(upload.localId)
                                ? "pointer-events-none motion-safe:animate-pop-out"
                                : "motion-safe:animate-rise-in"
                            )}
                          >
                            {upload.attachment?.kind === "IMAGE" ? (
                              <Image
                                src={upload.attachment.url}
                                unoptimized={requiresViewerCredentials(upload.attachment.url)}
                                alt={upload.fileName}
                                width={32}
                                height={32}
                                className="h-8 w-8 rounded-sm object-cover"
                              />
                            ) : (
                              <FileText className="h-5 w-5 text-muted-foreground" />
                            )}
                            <div className="max-w-[140px]">
                              <p className="truncate font-medium">{upload.fileName}</p>
                              <p className="text-muted-foreground">
                                {upload.status === "uploading"
                                  ? `${upload.progress}%`
                                  : upload.status === "error"
                                    ? "Failed"
                                    : formatBytes(upload.size)}
                              </p>
                            </div>
                            {upload.status === "uploading" && (
                              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                            )}
                            {/* Taking a file back off is one affordance in both
                                Work composers: a circular `Pressable kind="icon"`
                                at one hit size, inline. This was an inverted
                                badge floated outside the chip and hidden until
                                hover, against an ~18px square glyph in the
                                thread — two shapes and two target sizes for the
                                same act. */}
                            <Pressable
                              kind="icon"
                              size="sm"
                              onClick={() => removeUpload(upload.localId)}
                              className="-mr-1 shrink-0"
                              aria-label={`Remove ${upload.fileName}`}
                            >
                              <X className="h-3.5 w-3.5" aria-hidden="true" />
                            </Pressable>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : null
              }
              field={
                <textarea
                  ref={textareaRef}
                  value={goal}
                  onChange={(event) => setGoal(event.target.value)}
                  onKeyDown={onKeyDown}
                  rows={1}
                  disabled={submitting}
                  placeholder="Describe the task — what you want done, and what “done” looks like"
                  aria-label="Describe the task for Juno to carry out"
                  // `text-body` and 4px-grid padding. The field carried three
                  // arbitrary values — text-[1rem], sm:px-[18px], sm:pt-[17px] —
                  // and that 17/18px half-step matched nothing else in the shell,
                  // whose controls row sits on px-2/2.5 and its chip strip on px-3/3.5.
                  className="max-h-[220px] min-h-[64px] w-full resize-none bg-transparent px-4 pb-3 pt-4 text-body outline-none transition-[height] duration-fast ease-out-soft placeholder:text-muted-foreground/70 disabled:opacity-70 sm:px-4 sm:pt-4"
                />
              }
              /*
               * ── The inline row: what you do to THIS message ────────────────
               * Attach, name a skill, pick the model, set the thinking depth,
               * dictate, start. Every one of them is spent on the sentence in
               * the field. The same row, in the same order, at the same sizes as
               * the chat and Code composers.
               */
              controls={
                <>
                  <div className="flex min-w-0 flex-1 items-center gap-1">
                    {/* `ComposerAddMenu` rather than a third hand-rolled [+]. It
                        holds the two things that are spent on this message — the
                        documents and the skill — now that the apps it used to
                        carry are on the strip below, where standing scope
                        belongs. */}
                    <ComposerAddMenu
                      disabled={submitting}
                      attach={
                        canAttach
                          ? {
                              onFiles: () => fileInputRef.current?.click(),
                              onLibrary: () => setLibraryOpen(true),
                            }
                          : undefined
                      }
                      skills={{
                        skills: skills.skills,
                        failed: skills.failed,
                        onRetry: skills.reload,
                        invokedSlug: invoked?.slug ?? null,
                        onInvoke: invokeSkill,
                      }}
                    />

                    {/* One divider class, one height, one breakpoint — the form
                        chat settled on after shipping two of each, which showed
                        two different separators at once between 380 and 420px.
                        Gated on `canAttach` still: the menu can render for
                        skills alone, but a hairline with nothing on its left is
                        worse than no hairline. */}
                    {canAttach && (
                      <span
                        className="mx-0.5 hidden h-4 w-px shrink-0 bg-border/60 min-[380px]:block"
                        aria-hidden="true"
                      />
                    )}

                    <div
                      className={cn(
                        "min-w-0 flex-1 sm:flex-none",
                        submitting && "pointer-events-none opacity-60"
                      )}
                    >
                      {/* Only the models the Work runner can actually drive.
                          Plan-locked ones stay, wearing their lock — see the
                          prop's own note.

                          `showReasoning` is on now that the executor carries an
                          effort, so the picker's own slider and the button
                          beside it are the same control seen twice rather than
                          two ideas — which is the arrangement chat has always
                          had. */}
                      <ModelSelector
                        value={model}
                        onChange={changeModel}
                        reasoningEffort={reasoningEffort}
                        onReasoningChange={setReasoningEffort}
                        filter={isWorkCapableModel}
                      />
                    </div>

                    {/* Thinking effort, presented exactly as chat and /code/new
                        present it: a fixed-width button naming the current tier,
                        opening onto the same slider. Same component, same
                        widths, same wording — a reader who has set this once
                        anywhere in the product has set it everywhere, and a
                        third arrangement of the same choice would be a second
                        thing to learn for no new fact. */}
                    {isAutoModelId(model) ? (
                      <>
                        <span
                          className="mx-0.5 hidden h-4 w-px shrink-0 bg-border/60 min-[380px]:block"
                          aria-hidden="true"
                        />
                        <Tooltip>
                          <TooltipTrigger asChild>
                            {/* The disabled twin of the trigger below, at that
                                trigger's exact metrics — `rounded-composer-control`
                                (the inline row's rung, which the mic and the [+]
                                beside it already sit on), `coarse:h-11`, and the
                                same three widths. It was `rounded-control` and
                                auto-width, so switching the model to Auto both
                                changed the corner radius of one chip in the row
                                and resized the row under the reader's pointer. */}
                            <span
                              className="inline-flex h-8 w-[4.75rem] shrink-0 items-center justify-center gap-1 rounded-composer-control px-2 font-mono text-[12px] text-muted-foreground coarse:h-11 min-[360px]:w-[5.5rem] min-[480px]:w-[7.25rem] min-[480px]:text-[13px]"
                              aria-label="Thinking effort: Auto — chosen with the model"
                            >
                              <span className="truncate">Auto</span>
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>
                            Thinking depth is chosen automatically with the model
                          </TooltipContent>
                        </Tooltip>
                      </>
                    ) : (
                      effortOptions.length > 0 &&
                      (() => {
                        // Matched against the clamped value, never the raw
                        // preference. The two disagree whenever a tier chosen
                        // elsewhere is wider than this model offers, and matching
                        // the raw one falls through to `effortOptions[0]` — the
                        // LOWEST tier — while the run goes out at the highest
                        // tier at or below it. The label would read "Instant" for
                        // a task that thought hard.
                        const current =
                          effortOptions.find((option) => option.value === effort) ??
                          effortOptions[0];
                        const compact =
                          current.label === "Extra high" ? "X-high" : current.label;
                        const atTopTier =
                          effortOptions.length > 1 &&
                          current.value === effortOptions[effortOptions.length - 1].value;
                        return (
                          <>
                            <span
                              className="mx-0.5 hidden h-4 w-px shrink-0 bg-border/60 min-[380px]:block"
                              aria-hidden="true"
                            />
                            <Tooltip>
                              <Popover>
                                <PopoverTrigger asChild>
                                  <TooltipTrigger asChild>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      disabled={submitting}
                                      aria-label={`Thinking effort: ${current.label}`}
                                      className={cn(
                                        // `.composer-chip` + `rounded-composer-control`
                                        // + `coarse:h-11`, which is verbatim what
                                        // chat's identical trigger carries. The
                                        // claim above — same component, same
                                        // widths — was true of the widths and of
                                        // nothing else: this was a bare ghost at
                                        // `rounded-control` (9px) in a row whose
                                        // [+] and mic are both 12px, and it topped
                                        // out at 32px on touch beside two
                                        // neighbours that grow to 44.
                                        //
                                        // The two `ring-0`s went with it: Button
                                        // declares no ring at all — globals.css's
                                        // `:focus-visible` outline is what draws
                                        // keyboard focus here — so they cancelled
                                        // nothing, while `focus-visible:bg-accent`
                                        // beside them painted focus in the same
                                        // fill as hover and as open, leaving the
                                        // three states indistinguishable.
                                        "composer-chip group h-8 w-[4.75rem] shrink-0 justify-between gap-1 rounded-composer-control px-2 font-mono text-[12px] tracking-tight focus-visible:ring-offset-card coarse:h-11 min-[360px]:w-[5.5rem] min-[480px]:w-[7.25rem] min-[480px]:text-[13px]",
                                        // Full strength, matching the model name
                                        // beside it. `/80` put one of the two most
                                        // consequential values on the row below
                                        // the ink of everything around it.
                                        atTopTier ? "text-ultra" : "text-foreground"
                                      )}
                                    >
                                      <span className="min-w-0 flex-1 truncate text-center min-[480px]:hidden">
                                        {compact}
                                      </span>
                                      <span className="hidden min-w-0 flex-1 truncate text-center min-[480px]:inline">
                                        {current.label}
                                      </span>
                                      <ChevronDown className="h-3 w-3 shrink-0 opacity-50 transition-transform duration-base ease-in-out group-data-[state=open]:rotate-180" />
                                    </Button>
                                  </TooltipTrigger>
                                </PopoverTrigger>
                                <PopoverContent
                                  align="start"
                                  sideOffset={10}
                                  className="w-[264px] origin-popper p-3"
                                >
                                  {/* No Flash-mode switch, unlike chat's. That
                                      toggle swaps the transport for a
                                      lower-latency one the Work runner does not
                                      use, so offering it would be a control with
                                      nothing behind it — the exact mistake this
                                      whole surface was carrying until the
                                      executor learned to carry an effort. */}
                                  <ReasoningSlider
                                    options={effortOptions}
                                    value={effort}
                                    onChange={setReasoningEffort}
                                    disabled={submitting}
                                  />
                                </PopoverContent>
                              </Popover>
                              <TooltipContent>Thinking effort</TooltipContent>
                            </Tooltip>
                          </>
                        );
                      })()
                    )}
                  </div>

                  <div className="ml-auto flex shrink-0 items-center gap-1">
                    {/* Dictate. Sits immediately left of the primary action, the
                        same place it occupies in the chat and Code composers — a
                        control that means the same thing in three surfaces
                        should not be in three positions. Hidden rather than
                        disabled where the browser has no recognition: a
                        permanently dead mic explains nothing. */}
                    {speechSupported && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => setDictating(true)}
                            // Dictation and the voice conversation want the same
                            // microphone, and the browser hands it to whoever
                            // asked last — so opening one while the other is live
                            // steals the input stream from a session still
                            // holding it. Chat and the thread composer lock the
                            // same pair the same way.
                            disabled={submitting || dictating || voice.open}
                            aria-label="Dictate the task"
                            aria-pressed={dictating}
                            className="composer-mic-button shrink-0 rounded-composer-control coarse:h-11 coarse:w-11"
                          >
                            <Mic className="composer-mic-icon h-4 w-4" aria-hidden="true" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Dictate</TooltipContent>
                      </Tooltip>
                    )}

                    {/* One primary button, morphing in place: with nothing
                        written and a voice session available it IS the launcher,
                        and the first character typed turns it back into Start.
                        Chat's `showVoiceButton` rule, in chat's shape.

                        Gated on the DRAFT rather than on `canStart`, which is the
                        one place this surface cannot copy chat verbatim: Work
                        also refuses to start without an executor, so keying the
                        morph off `canStart` would put wave bars on a composer
                        with a written task in it the moment the host list was
                        slow — offering a phone call in place of the Start button
                        the reader was reaching for. */}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="shrink-0">
                          <Button
                            type="button"
                            size="icon"
                            onClick={
                              showVoiceButton ? voice.onOpenVoiceMode : () => void submit()
                            }
                            disabled={showVoiceButton ? false : !canStart}
                            aria-label={
                              showVoiceButton
                                ? "Talk to Juno about the task you are writing"
                                : selection.target === null
                                  ? selection.explanation
                                  : "Start this task"
                            }
                            className={cn(
                              "composer-primary-action h-9 w-9 rounded-composer-action coarse:h-11 coarse:w-11",
                              // The same property list and easing chat morphs on.
                              // `width` and `border-radius` are in it even though
                              // this composer holds both fixed: dropping them
                              // here is how the lists drift and a later shape
                              // change animates on one surface only.
                              "transition-[width,border-radius,color,background-color,border-color,box-shadow,transform] duration-base ease-out-strong"
                            )}
                          >
                            {submitting ? (
                              <Loader2
                                key="starting"
                                className="h-4 w-4 animate-spin motion-safe:animate-fade-in"
                                aria-hidden="true"
                              />
                            ) : showVoiceButton ? (
                              <span
                                key="voice"
                                className="composer-voice-wave motion-safe:animate-fade-in"
                                aria-hidden="true"
                              >
                                <span />
                                <span />
                                <span />
                                <span />
                                <span />
                              </span>
                            ) : (
                              <ArrowUp
                                key="start"
                                className="composer-send-icon h-4 w-4 motion-safe:animate-fade-in"
                                aria-hidden="true"
                              />
                            )}
                          </Button>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        {showVoiceButton ? "Voice conversation" : "Start task"}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </>
              }
              /*
               * ── The utility strip: the standing context of the run ─────────
               *
               * Everything here is still true after the task starts, and true of
               * the task after that. Two of the three arrived from somewhere
               * worse: the project and the approval mode were a chip strip ABOVE
               * the field, which reads as part of the message being composed
               * when it is the opposite of that, and the apps were two gestures
               * deep inside a [+] that opens upward over the text.
               *
               * The executor is the odd one out and is not a control, because
               * Work has no executor to choose — `selectForInferred` reads the
               * goal and decides, and the dispatch route runs the same function
               * over the same list. It is here because it answers the third
               * question the strip exists to answer, and a reader is owed it
               * before they press Start rather than after.
               */
              utility={
                <>
                  <ProjectChip value={projectId} onChange={setProject} disabled={submitting} />
                  <WorkPermissionChip
                    value={approvalMode}
                    onChange={setApprovalMode}
                    disabled={submitting}
                  />
                  <WorkConnectorsChip
                    connectors={apps.connectors}
                    failed={apps.failed}
                    onRetry={apps.reload}
                    selected={connectorIds}
                    onToggle={toggleConnector}
                    disabled={submitting}
                  />
                  {/* Last and pushed right, so it is the item that gives up room
                      first when the strip runs out of it: it is the only one of
                      the four a reader can also get in full elsewhere, by
                      opening the disclosure under the composer. */}
                  <span className="ml-auto flex min-w-0 justify-end">
                    <WorkRunTarget
                      target={selection.target}
                      hostName={
                        (hosts ?? []).find((host) => host.id === selection.hostId)?.displayName ??
                        null
                      }
                      loading={loadingHosts}
                      unknown={executorsUnknown}
                    />
                  </span>
                </>
              }
            />
          </div>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={WORK_ACCEPT_ATTRIBUTE}
          className="hidden"
          onChange={(event) => {
            if (event.target.files?.length) addFiles(event.target.files);
            event.target.value = "";
          }}
        />
        {/* The library dialog is shared with chat and still lists images under
            its own Images tab, which this file does not own. One picked there
            arrives as a chip like any other and the run reports that it could
            not read it — the honest outcome, rather than the silent one the
            Photos entry produced. */}
        {canAttach && (
          <LibraryPicker
            open={libraryOpen}
            onOpenChange={setLibraryOpen}
            onAttach={addAttachments}
            existingCount={uploads.length}
          />
        )}
      </div>

      {/*
       * The questions Juno would otherwise answer for itself.
       *
       * Between the surface and the approval control, because it is about this
       * particular errand rather than about how the account likes tasks run,
       * and because the reader's eye leaves the textarea downwards. It never
       * gates `canStart`: pressing send with the card open starts the task on
       * Juno's own answers, which is the same outcome as accepting it and one
       * press cheaper — that is what makes skipping the fast path rather than
       * the penalised one.
       */}
      {showPreflight && (
        <WorkPreflightCard
          questions={preflightQuestions}
          disabled={submitting}
          onAccept={acceptPreflight}
          onSkip={skipPreflight}
        />
      )}

      {/*
       * What the chosen approval mode means, for the reader who never opens
       * the chip.
       *
       * The CONTROL is `WorkPermissionChip` on the strip above, which is the
       * arrangement the chip was extracted for: one shape and one position for
       * "how often this task asks", instead of a three-segment control here and
       * a dropdown chip in the thread toolbar for the same three
       * `WORK_PERMISSION_POLICIES`. Only the sentence stays behind, because the
       * argument that put it here is unchanged — "Skip" alone reads as a promise
       * never to be interrupted, which is false in four cases and would be
       * discovered as a prompt somebody was told would not come. The chip's menu
       * carries the same line per row from the same record, so there is one
       * sentence per mode in the product rather than two that can drift.
       */}
      <p
        // Announced when it changes: the chip above says only the mode's name,
        // and a reader moving between the three with a screen reader would
        // otherwise hear three words and no meaning.
        aria-live="polite"
        className="mt-3 px-1.5 text-caption leading-relaxed text-muted-foreground"
      >
        {WORK_APPROVAL_MODE_SUMMARY[approvalMode]}
      </p>

      {/* What the run commits to, from the values that will be sent rather than
          from a second computation of them: `selection` is the same object the
          caption below reads, and the connector labels are the ones the reader
          switched on in the chip above. Suppressed while the host list is in
          flight, for the reason the degradation note below is: a "runs on
          Juno's cloud" that corrects itself two hundred milliseconds later is
          the one line here nobody can check. */}
      {!loadingHosts && !executorsUnknown && blocked === null && (
        <WorkRunDisclosure
          target={selection.target}
          hostName={
            (hosts ?? []).find((host) => host.id === selection.hostId)?.displayName ?? null
          }
          connectorLabels={connectorLabels}
        />
      )}

      {(inferenceLine !== null || runLine !== null) && (
        <div className="mt-2.5 space-y-0.5 px-1.5">
          {inferenceLine !== null && (
            <p className="text-caption leading-relaxed text-muted-foreground">{inferenceLine}</p>
          )}
          {runLine !== null && (
            <p className="text-caption leading-relaxed text-muted-foreground">{runLine}</p>
          )}
        </div>
      )}

      {/* Everything below is the honest answer to "will this actually run",
          newest fact last: the local preview, then whatever the server said when
          it disagreed. */}
      {executorsUnknown && (
        <WorkStateNote
          tone="error"
          className="mt-2.5 motion-safe:animate-rise-in"
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={onRetryHosts}
              className="gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Retry
            </Button>
          }
        >
          Juno couldn’t check what is available to run this, so it can’t tell you whether anything
          would pick it up. Starting is held back rather than queued into the dark.
        </WorkStateNote>
      )}
      {blocked === null && !executorsUnknown && selection.target === null && !loadingHosts && (
        <WorkStateNote tone="blocked" className="mt-2.5 motion-safe:animate-rise-in">
          {selection.explanation}
        </WorkStateNote>
      )}
      {/* `!loadingHosts` matters here now that the preview yields rather than
          refuses: with the host list still in flight there is no Mac to serve a
          local guess, so the selection carries a "the local part will not run"
          degradation that a Mac two hundred milliseconds away would have
          answered. Showing it and then withdrawing it is a warning the reader
          cannot act on. */}
      {blocked === null &&
        !executorsUnknown &&
        !loadingHosts &&
        selection.target !== null &&
        selection.degradation.length > 0 && (
          // `bg-warning/10` and not `/5` — the same fill `WorkStateNote`'s
          // warning tone uses, which is the box this one sits directly above in
          // several states. `/5` composited to ~2.9% over the black ground, so
          // two warning boxes in one column were drawn at visibly different
          // weights for no difference in what they were saying.
          <div className="mt-2.5 rounded-field border border-warning/35 bg-warning/10 px-3.5 py-2.5 motion-safe:animate-rise-in">
            <DegradationNotes degradation={selection.degradation} />
          </div>
        )}
      {blocked !== null && (
        <WorkStateNote tone="blocked" className="mt-2.5 motion-safe:animate-rise-in">
          <p>{blocked.explanation}</p>
          <DegradationNotes degradation={blocked.degradation} className="mt-2" />
          {blocked.confirmation?.kind === "expensive_work" && (
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={confirmExpensiveAndSubmit}
                disabled={submitting || !canStart}
                className="border-warning/40 text-foreground hover:bg-warning/10"
              >
                Confirm and start
              </Button>
              <span className="text-[12px] text-muted-foreground">
                Estimate: ${(blocked.confirmation.estimatedCostMicroUsd / 1_000_000).toFixed(2)}
              </span>
            </div>
          )}
          {draftLink !== null && (
            <p className="mt-2 text-[12.5px]">
              Nothing was queued. The task is saved as a draft. {draftLink}
            </p>
          )}
        </WorkStateNote>
      )}
      {/* The failed press. The button appears only where it could work: a wall —
          a 400, a plan that admits no model, something that is gone — answers
          the same way every time, and a Try again beside it costs the reader a
          press to learn what the sentence already told them. */}
      {failure !== null && (
        <WorkStateNote
          tone="error"
          className="mt-2.5 motion-safe:animate-rise-in"
          action={
            failure.retryable ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void submit()}
                disabled={!canStart}
                className="gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Try again
              </Button>
            ) : undefined
          }
        >
          <p>{failure.message}</p>
          {/* No "nothing was queued" here, unlike the refusal above. A refusal
              is the server saying so; a failed request may have arrived and lost
              only its answer, and the idempotency key is what makes the next
              press safe rather than any claim this line could make. */}
          {draftLink !== null && (
            <p className="mt-2 text-[12.5px]">The task is saved as a draft. {draftLink}</p>
          )}
        </WorkStateNote>
      )}
    </div>
  );
}

/**
 * The account's connected apps, loaded once for everything on this surface that
 * needs them.
 *
 * Three things do now — the Apps chip that switches them on, the pre-flight
 * question that offers to switch one on because the goal named it, and the
 * disclosure that lists what the run will reach — and each of them asking
 * `/api/connectors` for itself would be three answers to one question, arriving
 * at three different moments. Only connected apps are kept: everything here is
 * about narrowing what one task may reach inside what the account already
 * permits, and an app nobody has linked is not a choice this surface can offer.
 *
 * A failed load is carried rather than swallowed, because "you have no
 * connected apps" and "Juno could not find out" are different sentences and
 * only the second one deserves a Retry.
 */
function useConnectedApps(): {
  connectors: ConnectorStatus[] | null;
  failed: boolean;
  reload: () => void;
} {
  const [connectors, setConnectors] = React.useState<ConnectorStatus[] | null>(null);
  const [failed, setFailed] = React.useState(false);

  const load = React.useCallback(async () => {
    setFailed(false);
    try {
      const response = await fetch("/api/connectors");
      if (!response.ok) throw new Error("connectors");
      const data = (await response.json()) as { connectors?: ConnectorStatus[] };
      setConnectors((data.connectors ?? []).filter((connector) => connector.connected));
    } catch {
      setFailed(true);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const reload = React.useCallback(() => {
    void load();
  }, [load]);

  return { connectors, failed, reload };
}

/* ──────────────────────────────── the chips ──────────────────────────────── */

/** As much of `GET /api/projects` as a chip has any use for. */
interface ComposerProject {
  id: string;
  name: string;
  conversationCount: number;
}

/*
 * The chip shape lives in `composer-home/composer-chip.tsx`.
 *
 * There was a local `CHIP_CLASS` here — h-8 / px-2 / 12px / foreground-80 —
 * beside a `COMPOSER_CHIP_CLASS` that was extracted from this very file and is
 * h-7 / px-1.5 / 11.5px / muted. Both dressed the Project chip: this one on the
 * home composer, the shared one on the thread's. The extraction happened; the
 * fork stayed. There is now one height.
 */

/**
 * Files this task into a Project, so the project's instructions and files apply.
 *
 * An account with no projects gets a "New project" button rather than a chip
 * that opens onto an empty menu and an apology. The two are the same click
 * either way — the only thing a reader with no projects can usefully do here is
 * make one — and an empty dropdown is a promise of a list that does not exist.
 *
 * The list is loaded on mount rather than on open. It is one small GET against
 * a page that is already making two, and knowing whether the account has any
 * projects is what decides which of the two controls above is even rendered;
 * deferring it would mean rendering a dropdown first and swapping it out under
 * the reader's hand.
 */
function ProjectChip({
  value,
  onChange,
  disabled,
}: {
  value: string | null;
  /**
   * The name travels with the id because this chip is the only holder of the
   * project list on the page, and two other things now need the name: the voice
   * briefing, which must not tell the model a filed task is unfiled. Handing it
   * over at the press is cheaper and less fallible than a second fetch.
   */
  onChange: (project: { id: string; name: string } | null) => void;
  disabled: boolean;
}) {
  const [projects, setProjects] = React.useState<ComposerProject[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [open, setOpen] = React.useState(false);

  const load = React.useCallback(async () => {
    setFailed(false);
    try {
      const response = await fetch("/api/projects");
      if (!response.ok) throw new Error("projects");
      const data = (await response.json()) as { projects?: ComposerProject[] };
      setProjects(data.projects ?? []);
    } catch {
      setFailed(true);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  // A brand-new project is created unnamed — the API calls it "Untitled
  // project" and renames it from its first conversation — and filed against
  // this task straight away, so it behaves exactly like picking an existing one.
  const createAndPick = React.useCallback(async () => {
    if (creating) return;
    setCreating(true);
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = (await response.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!response.ok || !data.id) throw new Error(data.error ?? "Could not create the project.");
      setProjects((prev) => [{ id: data.id!, name: "New project", conversationCount: 0 }, ...(prev ?? [])]);
      window.dispatchEvent(new CustomEvent("projects:sync"));
      onChange({ id: data.id, name: "New project" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create the project.");
    } finally {
      setCreating(false);
      setOpen(false);
    }
  }, [creating, onChange]);

  const selected = projects?.find((project) => project.id === value) ?? null;

  if (projects === null && !failed) {
    return (
      <button type="button" disabled className={COMPOSER_CHIP_CLASS} aria-hidden="true" tabIndex={-1}>
        <AppIcons.projects className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="truncate text-muted-foreground">Project</span>
      </button>
    );
  }

  if (projects !== null && projects.length === 0) {
    return (
      <button
        type="button"
        onClick={() => void createAndPick()}
        disabled={disabled || creating}
        className={COMPOSER_CHIP_CLASS}
      >
        {creating ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
        ) : (
          <Plus className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        <span className="truncate">New project</span>
      </button>
    );
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={selected ? `Project: ${selected.name}. Change it` : "File this task in a project"}
          className={COMPOSER_CHIP_CLASS}
        >
          <AppIcons.projects
            className={cn("size-3.5 shrink-0", selected ? "text-primary" : "text-muted-foreground")}
            aria-hidden="true"
          />
          <span className={cn("truncate", !selected && "text-muted-foreground")}>
            {selected?.name ?? "Project"}
          </span>
          <ChevronDown
            className="h-3 w-3 shrink-0 text-muted-foreground transition-transform duration-base ease-in-out group-data-[state=open]:rotate-180"
            aria-hidden="true"
          />
        </button>
      </DropdownMenuTrigger>
      {/* `side="top"`. The chip used to sit ABOVE the field, where opening
          downward landed the menu over the textarea the reader was heading for;
          it is now on the strip along the composer's bottom edge, so the same
          direction would push the list down over the task list below. Every
          other control on this strip opens upward for the same reason. */}
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={8}
        className="flex max-h-[min(22rem,60vh)] w-60 flex-col p-0"
      >
        <ScrollFade className="min-h-0 flex-1" viewportClassName="p-1.5">
          {failed ? (
            <div className="space-y-2 px-2 py-4 text-center">
              <p className="text-caption leading-relaxed text-muted-foreground">
                Couldn’t load your projects. This is empty because the request failed, not because
                you have none.
              </p>
              <Button variant="outline" size="sm" onClick={() => void load()} className="gap-1.5">
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Retry
              </Button>
            </div>
          ) : (
            (projects ?? []).map((project) => {
              const active = project.id === value;
              return (
                <DropdownMenuItem
                  key={project.id}
                  onSelect={() =>
                    onChange(active ? null : { id: project.id, name: project.name })
                  }
                >
                  <AppIcons.projects className={cn(active ? "text-primary" : "text-muted-foreground")} />
                  <span className="flex-1 truncate">{project.name}</span>
                  {active ? (
                    <Check className="!size-3.5 text-primary" />
                  ) : (
                    <span className="font-mono text-caption text-muted-foreground">
                      {project.conversationCount}
                    </span>
                  )}
                </DropdownMenuItem>
              );
            })
          )}
        </ScrollFade>
        {/* Pinned below the hairline so the list scrolls beneath it and starting
            a new project never falls off the bottom of a long one. */}
        <div className="shrink-0 border-t border-border/60 p-1.5">
          <DropdownMenuItem
            disabled={creating}
            onSelect={(event) => {
              // Hold the menu open through the create; `createAndPick` closes it
              // when it settles, whichever way it settles.
              event.preventDefault();
              void createAndPick();
            }}
          >
            {creating ? (
              <Loader2 className="animate-spin text-muted-foreground" />
            ) : (
              <Plus className="text-muted-foreground" />
            )}
            <span className="flex-1">New project</span>
          </DropdownMenuItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

