"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowUp, Loader2, Mic } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ComposerShell } from "@/components/ui/composer-shell";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LibraryPicker } from "@/components/chat/library-picker";
import { ModelSelector } from "@/components/chat/model-selector";
import { useApp } from "@/components/app/app-provider";
import { useUploads } from "@/hooks/use-uploads";
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";
import {
  clampReasoningEffort,
  defaultReasoning,
  reasoningOptions,
  type ReasoningEffort,
} from "@/lib/model-metrics";
import { resolveModel, type ModelId } from "@/lib/models";
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
} from "@/components/work/work-transport";
import { ComposerAddMenu } from "@/components/work/composer-home/composer-add-menu";
import { WorkConnectorsChip } from "@/components/work/composer-home/connectors-chip";
import { WorkPermissionChip } from "@/components/work/composer-home/permission-chip";
import {
  WORK_ACCEPT_ATTRIBUTE,
  WorkComposerAttachments,
} from "@/components/work/composer-home/composer-attachments";
import { WorkDictationLayer } from "@/components/work/composer-home/dictation-layer";
import { WorkEffortChip } from "@/components/work/composer-home/effort-chip";
import { ProjectChip } from "@/components/work/composer-home/project-chip";
import { WorkStartNotes } from "@/components/work/composer-home/start-notes";
import {
  describeFailure,
  type StartAttempt,
  type StartFailure,
} from "@/components/work/composer-home/start-attempt";
import { useConnectedApps } from "@/components/work/composer-home/use-connected-apps";
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
import { cn } from "@/lib/utils";

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
 * unchanged, which is what `StartAttempt` is about — see
 * `composer-home/start-attempt.ts`.
 *
 * ── WHAT THIS FILE IS, AND WHAT IT IS NOT ──────────────────────────────────
 *
 * It is the arrangement: which controls exist, which tier each sits in, what a
 * press does, and what is said when the press produces nothing. Everything that
 * can be described without reference to that arrangement now lives beside it in
 * `composer-home/`, because a two-thousand-line component is one where nobody
 * can see the arrangement for the parts:
 *
 *   start-attempt.ts          what one press IS, and what to say when it failed
 *   use-connected-apps.ts     the account's linked apps, fetched once
 *   project-chip.tsx          the Project control, with its own list and create
 *   composer-attachments.tsx  the document chips above the field, and the
 *                             accept list the picker is opened with
 *   effort-chip.tsx           the thinking-depth control and its Auto twin
 *   dictation-layer.tsx       the capsule/composer cross-fade and its geometry
 *   start-notes.tsx           every reason this will not run, newest last
 *
 * None of them was rewritten on the way out. The split is by QUESTION — each
 * file answers one a reader might arrive with — rather than by size, which is
 * why the pre-flight card, the run disclosure and the voice panel stay where
 * they are: they already had files, under `clarify/` and `voice/`.
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

export function WorkComposer({
  hosts,
  hostsFailed,
  onRetryHosts,
  seed = null,
}: {
  /** Null while the host list is still loading. */
  hosts: ClientWorkHost[] | null;
  hostsFailed: boolean;
  onRetryHosts: () => void;
  /**
   * Text to write into the field on the caller's behalf, once per `nonce`.
   *
   * This exists so the empty state's suggestions can be real controls. They used
   * to be inert prose, and the note explaining why said "the composer owns its
   * own text and there is no honest way to put words in it from here" — which
   * was true, and was a component boundary the reader was paying for: they read
   * three examples of what to ask for and then had to retype one.
   *
   * The `nonce` is what makes it a one-shot rather than a controlled value.
   * Without it, seeding the same string twice — press a suggestion, edit it,
   * press the same suggestion again — would either do nothing or fight the
   * user's typing on every render. With it the effect fires exactly when the
   * caller says something new happened.
   *
   * It writes and focuses. It deliberately does NOT submit: the reader has to
   * see what they are about to ask for and press the button themselves, which
   * is the difference between a suggestion and an accident.
   */
  seed?: { text: string; nonce: number } | null;
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

  /*
   * A suggestion pressed elsewhere on the page, written into the field.
   *
   * Keyed on the nonce alone, deliberately: the text is read out of the ref-free
   * prop inside the effect, so pressing the same suggestion twice still fires
   * (two nonces) and a re-render that changes nothing else does not (same
   * nonce). Focus goes to the end of what was written rather than the start,
   * because the reader's next move is almost always to add a detail to it.
   */
  const seedNonce = seed?.nonce ?? null;
  React.useEffect(() => {
    if (seedNonce === null || seed === null) return;
    setGoal(seed.text);
    const element = textareaRef.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(seed.text.length, seed.text.length);
    // `seed` is intentionally absent from the deps: only a new nonce is a new
    // instruction, and including the object would re-seed on every parent
    // render that happened to rebuild it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedNonce]);

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

        {/* Dictation and the composer share one grid cell and cross-fade — see
            `composer-home/dictation-layer.tsx` for why the capsule is a sibling
            of the shell rather than a child of it. */}
        <WorkDictationLayer
          active={dictating}
          onCancel={() => setDictating(false)}
          onClose={closeDictation}
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
                <WorkComposerAttachments uploads={uploads} onRemove={remove} />
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
                  <WorkEffortChip
                    auto={isAutoModelId(model)}
                    options={effortOptions}
                    value={effort}
                    onChange={setReasoningEffort}
                    disabled={submitting}
                  />
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
                          className="composer-mic-button shrink-0 rounded-composer-control coarse:size-11"
                        >
                          <Mic className="composer-mic-icon size-4" aria-hidden="true" />
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
                            "composer-primary-action size-9 rounded-composer-action coarse:size-11",
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
                              className="size-4 animate-spin motion-safe:animate-fade-in"
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
                              className="composer-send-icon size-4 motion-safe:animate-fade-in"
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
        </WorkDictationLayer>

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

      {/* Every reason this might not run, in `start-notes.tsx`: what the browser
          worked out for itself, then what the server said when it disagreed. */}
      <WorkStartNotes
        executorsUnknown={executorsUnknown}
        loadingHosts={loadingHosts}
        onRetryHosts={onRetryHosts}
        targetFound={selection.target !== null}
        targetExplanation={selection.explanation}
        degradation={selection.degradation}
        blocked={blocked}
        failure={failure}
        draft={draft}
        canStart={canStart}
        submitting={submitting}
        onConfirmExpensive={confirmExpensiveAndSubmit}
        onRetryStart={() => void submit()}
      />
    </div>
  );
}
