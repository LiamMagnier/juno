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
  FileUp,
  Library,
  Loader2,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ConnectorStatus } from "@/components/connections/types";
import { LibraryPicker } from "@/components/chat/library-picker";
import { ModelSelector } from "@/components/chat/model-selector";
import { ReasoningSlider } from "@/components/chat/reasoning-slider";
import { useApp } from "@/components/app/app-provider";
import { useUploads } from "@/hooks/use-uploads";
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
  WORK_APPROVAL_MODE_LABEL,
  WORK_APPROVAL_MODE_SUMMARY,
  WORK_PERMISSION_POLICIES,
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
import {
  appendClarifications,
  derivePreflightQuestions,
} from "@/components/work/clarify/preflight";
import { WorkPreflightCard } from "@/components/work/clarify/preflight-card";
import { WorkRunDisclosure } from "@/components/work/clarify/run-disclosure";
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
 * The Apps chip that replaced them is not the same kind of question, which is
 * the only reason it is allowed to be here. It asks which of the reader's own
 * connected apps this errand is about — a question about their work rather than
 * about Juno's internals, answerable by anyone who linked the app — and every
 * switch starts off, so a task reaches what it was handed and nothing else. It
 * is also a control that does something: the selection is stored on the session
 * and `scripts/work-runner.ts` narrows the run's connector set by it, which is
 * the bar a permission control has to clear before it is worth drawing.
 *
 * The approval mode below the surface — Manual, Auto, Skip — is here on the
 * same terms and is the second control to clear that bar. `approvalRuling` in
 * src/lib/work/domain.ts is what the three modes differ in, the session stores
 * the choice, dispatch narrows it against any Mac's advertised floor, and both
 * executors gate on the result. It is drawn now for exactly that reason and
 * would not have been drawn a week ago, when the three modes were the same
 * mode wearing three names.
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
  const [projectId, setProjectId] = React.useState<string | null>(null);
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
  const [model, setModel] = React.useState<ModelId>(defaultWorkModelId);
  const [submitting, setSubmitting] = React.useState(false);
  const [blocked, setBlocked] = React.useState<WorkBlocked | null>(null);
  const [draft, setDraft] = React.useState<ClientWorkSession | null>(null);
  const [failure, setFailure] = React.useState<StartFailure | null>(null);
  const [plusOpen, setPlusOpen] = React.useState(false);
  const [libraryOpen, setLibraryOpen] = React.useState(false);
  const [removingIds, setRemovingIds] = React.useState<string[]>([]);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
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
  const runLine = executorsUnknown
    ? null
    : loadingHosts
      ? "Checking where this can run…"
      : blocked !== null || selection.target === null
        ? null
        : selection.explanation;

  return (
    <div className="w-full">
      <div className="composer-surface relative flex w-full flex-col rounded-composer border border-border/65 bg-card/95 backdrop-blur transition-[border-color,box-shadow] duration-base ease-spring focus-within:border-foreground/15 sm:rounded-lg">
        <div className="flex flex-wrap items-center gap-1.5 px-3 pb-0 pt-3 sm:px-3.5 sm:pt-3.5">
          <ProjectChip value={projectId} onChange={setProjectId} disabled={submitting} />
          <AppsChip
            value={connectorIds}
            onChange={setConnectorIds}
            disabled={submitting}
            connectors={apps.connectors}
            failed={apps.failed}
            onRetry={apps.reload}
          />
        </div>

        {canAttach && (
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
                      "group relative flex items-center gap-2 rounded-md border bg-background px-2.5 py-2 text-xs shadow-soft",
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
                        className="h-8 w-8 rounded object-cover"
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
                    <button
                      type="button"
                      onClick={() => removeUpload(upload.localId)}
                      className="absolute -right-1.5 -top-1.5 rounded-full bg-foreground p-0.5 text-background opacity-0 shadow-soft transition-opacity duration-fast group-hover:opacity-100 focus-visible:opacity-100 coarse:-right-2.5 coarse:-top-2.5 coarse:p-1.5 coarse:opacity-100"
                      aria-label="Remove attachment"
                    >
                      <X className="h-3 w-3 coarse:h-4 coarse:w-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          disabled={submitting}
          placeholder="Describe the task — what you want done, and what “done” looks like"
          aria-label="Describe the task for Juno to carry out"
          className="max-h-[220px] min-h-[64px] w-full resize-none bg-transparent px-4 pb-3 pt-4 text-[1rem] leading-relaxed outline-none transition-[height] duration-fast ease-out-soft placeholder:text-muted-foreground/70 disabled:opacity-70 sm:px-[18px] sm:pt-[17px]"
        />

        {/* Toolbar — attach, model, thinking, send. The same row, in the same
            order, at the same sizes as the chat and Code composers. */}
        <div className="flex flex-nowrap items-center gap-1.5 px-2 pb-2 pt-0.5 sm:px-2.5 sm:pb-2.5">
          <div className="flex min-w-0 flex-1 items-center gap-1">
            {canAttach && (
              <>
                {/* One menu, two destinations, no submenu. The chat composer
                    nests these under "Attach" because its + also holds canvas,
                    projects and tools; here that parent would contain a single
                    child, which is a click that buys nothing. */}
                <DropdownMenu open={plusOpen} onOpenChange={setPlusOpen}>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Attach a document"
                      disabled={submitting}
                      className={cn(
                        "composer-add-button group shrink-0 rounded-composer-control coarse:h-11 coarse:w-11 max-[359px]:coarse:!w-9",
                        plusOpen && "bg-accent"
                      )}
                    >
                      <Plus
                        aria-hidden="true"
                        strokeWidth={1.75}
                        className="composer-add-icon size-4 transition-transform duration-base ease-spring group-hover:rotate-90 motion-reduce:transform-none motion-reduce:transition-none"
                      />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" side="top" sideOffset={8} className="w-56">
                    {/* "Attach a document", not "Attach": the heading is the only
                        place left that says what this menu is for now that
                        Photos is gone, and "Attach" over a list with no images
                        in it reads as a list that failed to load. */}
                    <DropdownMenuLabel className="font-mono text-label">
                      Attach a document
                    </DropdownMenuLabel>
                    <DropdownMenuItem onSelect={() => fileInputRef.current?.click()}>
                      <FileUp className="text-muted-foreground" />
                      <span className="flex-1">Files</span>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => setLibraryOpen(true)}>
                      <Library className="text-muted-foreground" />
                      <span className="flex-1">From your library</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>

                <span
                  className="mx-0.5 hidden h-5 w-px shrink-0 bg-border/60 min-[420px]:block"
                  aria-hidden="true"
                />
              </>
            )}

            <div
              className={cn("min-w-0 flex-1 sm:flex-none", submitting && "pointer-events-none opacity-60")}
            >
              {/* Only the models the Work runner can actually drive. Plan-locked
                  ones stay, wearing their lock — see the prop's own note.

                  `showReasoning` is on now that the executor carries an effort,
                  so the picker's own slider and the button beside it are the
                  same control seen twice rather than two ideas — which is the
                  arrangement chat has always had. */}
              <ModelSelector
                value={model}
                onChange={changeModel}
                reasoningEffort={reasoningEffort}
                onReasoningChange={setReasoningEffort}
                filter={isWorkCapableModel}
              />
            </div>

            {/* Thinking effort, presented exactly as chat and /code/new present
                it: a fixed-width button naming the current tier, opening onto
                the same slider. Same component, same widths, same wording — a
                reader who has set this once anywhere in the product has set it
                everywhere, and a third arrangement of the same choice would be
                a second thing to learn for no new fact. */}
            {isAutoModelId(model) ? (
              <>
                <span
                  className="mx-0.5 hidden h-4 w-px shrink-0 bg-border/60 min-[380px]:block"
                  aria-hidden="true"
                />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className="inline-flex h-8 shrink-0 items-center gap-1 rounded-control px-2 font-mono text-[12px] text-muted-foreground min-[480px]:text-[13px]"
                      aria-label="Thinking effort: Auto — chosen with the model"
                    >
                      <span className="truncate">Auto</span>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>Thinking depth is chosen automatically with the model</TooltipContent>
                </Tooltip>
              </>
            ) : (
              effortOptions.length > 0 &&
              (() => {
                // Matched against the clamped value, never the raw preference.
                // The two disagree whenever a tier chosen elsewhere is wider
                // than this model offers, and matching the raw one falls
                // through to `effortOptions[0]` — the LOWEST tier — while the
                // run goes out at the highest tier at or below it. The label
                // would read "Instant" for a task that thought hard.
                const current =
                  effortOptions.find((option) => option.value === effort) ?? effortOptions[0];
                const compact = current.label === "Extra high" ? "X-high" : current.label;
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
                                "group h-8 w-[4.75rem] shrink-0 justify-between gap-1 rounded-control px-2 font-mono text-[12px] tracking-tight hover:text-foreground focus-visible:bg-accent focus-visible:ring-0 focus-visible:ring-offset-0 data-[state=open]:bg-accent data-[state=open]:text-foreground min-[360px]:w-[5.5rem] min-[480px]:w-[7.25rem] min-[480px]:text-[13px]",
                                atTopTier ? "text-ultra" : "text-foreground/80"
                              )}
                            >
                              <span className="min-w-0 flex-1 truncate text-center min-[480px]:hidden">
                                {compact}
                              </span>
                              <span className="hidden min-w-0 flex-1 truncate text-center min-[480px]:inline">
                                {current.label}
                              </span>
                              <ChevronDown className="h-3 w-3 shrink-0 opacity-50 transition-transform duration-base ease-out-soft group-data-[state=open]:rotate-180" />
                            </Button>
                          </TooltipTrigger>
                        </PopoverTrigger>
                        <PopoverContent align="start" sideOffset={10} className="w-[264px] origin-popper p-3">
                          {/* No Flash-mode switch, unlike chat's. That toggle
                              swaps the transport for a lower-latency one the
                              Work runner does not use, so offering it would be
                              a control with nothing behind it — the exact
                              mistake this whole surface was carrying until the
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
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="shrink-0">
                  <Button
                    type="button"
                    size="icon"
                    onClick={() => void submit()}
                    disabled={!canStart}
                    aria-label={selection.target === null ? selection.explanation : "Start this task"}
                    className="composer-primary-action h-9 w-9 rounded-composer-action coarse:h-11 coarse:w-11"
                  >
                    {submitting ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <ArrowUp className="composer-send-icon h-4 w-4" aria-hidden="true" />
                    )}
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>Start task</TooltipContent>
            </Tooltip>
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
       * How often this task stops to ask.
       *
       * Below the surface rather than in the toolbar, and with its sentence
       * under it, because it is the one control here whose options are not
       * self-explanatory from their names. "Skip" alone reads as a promise
       * never to be interrupted, which is false in four cases and would be
       * discovered as a prompt somebody was told would not come; the sentence
       * is what makes the three legible before the task starts rather than
       * after it has done something.
       *
       * Only the mode is offered, never a per-action list. The four things
       * that ask under every mode are the floor — `ALWAYS_CONFIRM_ACTIONS` —
       * and a control that appeared to negotiate them would be a control
       * promising something `approvalRuling` refuses to deliver.
       */}
      <div className="mt-3 px-1.5">
        <SegmentedControl
          value={approvalMode}
          onChange={setApprovalMode}
          options={WORK_PERMISSION_POLICIES.map((policy) => ({
            value: policy,
            label: WORK_APPROVAL_MODE_LABEL[policy],
          }))}
          ariaLabel="How often this task asks before it acts"
          className="w-full max-w-[19rem]"
          optionClassName="h-8 coarse:h-10"
        />
        <p
          // Announced when it changes: the segments are the control and this is
          // the only place their difference is stated, so a reader moving
          // between them with a screen reader would otherwise hear three words
          // and no meaning.
          aria-live="polite"
          className="mt-2 text-caption leading-relaxed text-muted-foreground"
        >
          {WORK_APPROVAL_MODE_SUMMARY[approvalMode]}
        </p>
      </div>

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
          connectorLabels={(apps.connectors ?? [])
            .filter((connector) => connectorIds.includes(connector.id))
            .map((connector) => connector.label)}
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
          <div className="mt-2.5 rounded-xl border border-warning/35 bg-warning/5 px-3.5 py-2.5 motion-safe:animate-rise-in">
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

/**
 * The shared shape of every state this chip can be in.
 *
 * The trigger and the "New project" button are the same 32px box wearing the
 * same nothing-at-rest treatment, so the row does not resize as the project
 * list resolves under it — a control that changes width the moment a fetch
 * lands is a control that moves out from under the pointer heading for it.
 */
const CHIP_CLASS =
  "group inline-flex h-8 min-w-0 max-w-[13rem] items-center gap-1.5 rounded-control px-2 font-mono text-[12px] font-medium text-foreground/80 transition-[background-color,color,transform] duration-fast ease-out-soft hover:bg-accent hover:text-foreground active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-[state=open]:bg-accent data-[state=open]:text-foreground min-[480px]:text-[13px] coarse:h-11";

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
  onChange: (projectId: string | null) => void;
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
      onChange(data.id);
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
      <button type="button" disabled className={CHIP_CLASS} aria-hidden="true" tabIndex={-1}>
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
        className={CHIP_CLASS}
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
          className={CHIP_CLASS}
        >
          <AppIcons.projects
            className={cn("size-3.5 shrink-0", selected ? "text-primary" : "text-muted-foreground")}
            aria-hidden="true"
          />
          <span className={cn("truncate", !selected && "text-muted-foreground")}>
            {selected?.name ?? "Project"}
          </span>
          <ChevronDown
            className="h-3 w-3 shrink-0 text-muted-foreground transition-transform duration-base ease-out-soft group-data-[state=open]:rotate-180"
            aria-hidden="true"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="bottom"
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
                  onSelect={() => onChange(active ? null : project.id)}
                >
                  <AppIcons.projects className={cn(active ? "text-primary" : "text-muted-foreground")} />
                  <span className="flex-1 truncate">{project.name}</span>
                  {active ? (
                    <Check className="!size-3.5 text-primary" />
                  ) : (
                    <span className="font-mono text-caption text-muted-foreground/60">
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

/**
 * Which of the reader's connected apps this task may reach.
 *
 * Off by default, all of them, and that is the whole design rather than a
 * cautious default someone can relax later. A linked app is an account-wide
 * fact — the mailbox stays connected whether or not this errand needs it — and
 * a task that inherited every one of them would be handed a mailbox, a
 * repository and a calendar to do something that needed none of the three. The
 * reader switches on what the errand is about; everything else is simply not
 * there, and `evaluateConnector` in src/lib/work/connectors.ts refuses it with
 * `not_selected_for_task` rather than the run discovering it can reach further
 * than anyone intended.
 *
 * This is not a connection setting and does not pretend to be one. Nothing here
 * links, unlinks or re-authorises anything: it narrows one task inside what the
 * account already permits, which is why the empty state sends the reader to
 * /connections rather than offering to connect an app from a composer.
 *
 * The list is loaded on mount from the same `/api/connectors` the toolbox and
 * the connections page read. A second endpoint written for Work would be a
 * second answer to "is Gmail linked", and the two would disagree the first time
 * somebody disconnected it from the other page.
 *
 * The load itself is `useConnectedApps` above rather than state in here, for the
 * same argument one rung down: the pre-flight card and the run disclosure both
 * need this list, and three copies of it would be three answers to the same
 * question. The chip still owns everything else about the control — what it
 * says, when it is drawn at all, and what an empty account sees.
 */
function AppsChip({
  value,
  onChange,
  disabled,
  connectors,
  failed,
  onRetry,
}: {
  value: string[];
  onChange: (connectorIds: string[]) => void;
  disabled: boolean;
  /** Null while the list is still in flight. */
  connectors: ConnectorStatus[] | null;
  failed: boolean;
  onRetry: () => void;
}) {
  const [open, setOpen] = React.useState(false);

  const toggle = React.useCallback(
    (connectorId: string) => {
      onChange(
        value.includes(connectorId)
          ? value.filter((id) => id !== connectorId)
          : [...value, connectorId]
      );
    },
    [onChange, value]
  );

  /*
   * Nothing is rendered for an account with no linked apps, and nothing needs to
   * be. A chip reading "Apps" that opens onto "you have none" is a control
   * offering a choice that does not exist; the toolbox on the task page is where
   * the account's connections are explained, and it links to the page that can
   * do something about it. The empty selection still goes to the server either
   * way, so the task is recorded as reaching nothing.
   *
   * The chip is also absent while the list is still in flight. It appears rather
   * than changes width, so the row settles once instead of reflowing under a
   * pointer already on its way to the Project chip beside it.
   */
  if (connectors === null && !failed) return null;
  if (connectors !== null && connectors.length === 0) return null;

  const chosen = (connectors ?? []).filter((connector) => value.includes(connector.id));
  const label =
    chosen.length === 0
      ? "Apps"
      : chosen.length === 1
        ? chosen[0].label
        : `${chosen.length} apps`;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={
            chosen.length === 0
              ? "Choose which connected apps this task may use. None yet"
              : `This task may use ${chosen.map((connector) => connector.label).join(", ")}. Change it`
          }
          className={CHIP_CLASS}
        >
          <AppIcons.connections
            className={cn("size-3.5 shrink-0", chosen.length > 0 ? "text-primary" : "text-muted-foreground")}
            aria-hidden="true"
          />
          <span className={cn("truncate", chosen.length === 0 && "text-muted-foreground")}>{label}</span>
          <ChevronDown
            className="h-3 w-3 shrink-0 text-muted-foreground transition-transform duration-base ease-out-soft group-data-[state=open]:rotate-180"
            aria-hidden="true"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="bottom"
        sideOffset={8}
        className="flex max-h-[min(22rem,60vh)] w-64 flex-col p-0"
      >
        <DropdownMenuLabel className="px-3 pt-2.5 font-mono text-label">
          Apps this task may use
        </DropdownMenuLabel>
        <ScrollFade className="min-h-0 flex-1" viewportClassName="p-1.5">
          {failed ? (
            <div className="space-y-2 px-2 py-4 text-center">
              <p className="text-caption leading-relaxed text-muted-foreground">
                Couldn’t read your connected apps. This task will reach none of them until it can.
              </p>
              <Button variant="outline" size="sm" onClick={onRetry} className="gap-1.5">
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Retry
              </Button>
            </div>
          ) : (
            (connectors ?? []).map((connector) => {
              const active = value.includes(connector.id);
              return (
                <DropdownMenuItem
                  key={connector.id}
                  // Held open on select: turning two apps on is one decision, and
                  // a menu that closed after the first would make the reader
                  // reopen it to finish the sentence they were in the middle of.
                  onSelect={(event) => {
                    event.preventDefault();
                    toggle(connector.id);
                  }}
                >
                  <AppIcons.connections
                    className={cn(active ? "text-primary" : "text-muted-foreground")}
                  />
                  <span className="flex-1 truncate">{connector.label}</span>
                  {active && <Check className="!size-3.5 text-primary" />}
                </DropdownMenuItem>
              );
            })
          )}
        </ScrollFade>
        {/* The rule, said once, where the decision is made. Neither sentence is
            decoration: the first is why an app being linked is not enough on its
            own, and the second is what stops a reader reading this as a switch
            that disconnects things. */}
        <div className="shrink-0 border-t border-border/60 px-3 py-2">
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            Off means this task cannot reach it. Your connections are unchanged —{" "}
            <Link href="/connections" className="underline underline-offset-2 hover:text-foreground">
              manage them
            </Link>
            .
          </p>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
