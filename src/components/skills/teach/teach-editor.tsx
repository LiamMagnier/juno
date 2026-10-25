"use client";

import * as React from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, Check, ChevronDown, HelpCircle, ShieldCheck } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapse } from "@/components/ui/collapse";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { WorkStateNote } from "@/components/work/work-vocabulary";
import { useReducedMotion } from "@/lib/motion-preference";
import { staggerDelay, transition } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { skillSlugFromName, type WorkSkillContract } from "@/lib/work/skills";
import {
  MAX_TAUGHT_INPUTS,
  renderTaughtInstructions,
  type TaughtApp,
  type TaughtSkillSaved,
  type TaughtSource,
} from "@/lib/skills/teach";
import {
  LIST_LIMITS,
  acknowledgementFingerprint,
  formFromState,
  listPhrase,
  teachItemId,
  teachProblems,
  teachSavePayload,
  teachScan,
  teachSnapshot,
  teachSummary,
  type TeachEditorState,
} from "@/components/skills/teach/teach-model";
import { TeachListEditor } from "@/components/skills/teach/teach-list-editor";
import { TeachPermissions } from "@/components/skills/teach/teach-permissions";
import {
  revokeTaughtSkillRequest,
  saveTaughtSkillRequest,
  teachFailureMessage,
  type TeachContext,
} from "@/components/skills/teach/teach-transport";

/*
 * The review: everything a taught skill is, laid out to be read and changed
 * before anything runs.
 *
 *   01 Name it            name, the slash name it gets, when it applies
 *   02 Steps              the method, in order (and what it asks you for,
 *                         when it's done, its rules — folded until wanted)
 *   03 What it may use    tools and apps, each removable, evidence marked
 *   04 Where it applies   everywhere, or one project
 *   05 Review             one sentence of what you're saving, the safety
 *                         check, the exact text it will read, and the
 *                         confirmation that is the only way it switches on
 *
 * CONSENT IS CHECKED, NOT ASSUMED. Ticking "I've reviewed" records the
 * permission fingerprint on screen at that moment; Save sends it, and the
 * server switches the skill on only if it is the fingerprint being saved.
 * Change what it may use after ticking and the tick clears itself.
 */

export type TeachEditorMode =
  | { kind: "new"; key: string | null; source: TaughtSource }
  | {
      kind: "reteach";
      skillId: string;
      slug: string;
      enabled: boolean;
      currentVersion: number;
      base: WorkSkillContract;
      source: TaughtSource;
    };

function TeachSection({
  index,
  title,
  caption,
  children,
  delay,
  id,
}: {
  index: number;
  title: string;
  caption?: React.ReactNode;
  children: React.ReactNode;
  delay: number;
  id?: string;
}) {
  const headingId = React.useId();
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      style={staggerDelay(delay)}
      className="border-t border-border/70 pt-6 motion-safe:animate-rise-in [animation-fill-mode:backwards] first:border-t-0 first:pt-0"
    >
      <header className="mb-3 flex items-baseline gap-3">
        <span aria-hidden="true" className="font-mono text-micro tabular-nums text-muted-foreground">
          {String(index).padStart(2, "0")}
        </span>
        <div className="min-w-0">
          <h2 id={headingId} className="text-body font-semibold text-foreground">
            {title}
          </h2>
          {caption ? <p className="mt-0.5 text-caption leading-relaxed text-muted-foreground">{caption}</p> : null}
        </div>
      </header>
      <div className="sm:pl-8">{children}</div>
    </section>
  );
}

export function TeachEditor({
  initial,
  mode,
  context,
  observed,
  draftNotes,
  autoFocusSteps = false,
  onSaved,
  onRevoked,
}: {
  initial: TeachEditorState;
  mode: TeachEditorMode;
  context: TeachContext | null;
  observed?: { tools: readonly string[]; apps: readonly string[] };
  draftNotes?: { dropped: string[]; missingApps: string[]; fromOutsideContent: boolean };
  autoFocusSteps?: boolean;
  onSaved: (saved: TaughtSkillSaved) => void;
  onRevoked?: () => void;
}) {
  const reduce = useReducedMotion() ?? false;
  const fieldId = React.useId();
  const [state, setState] = React.useState<TeachEditorState>(initial);
  const [ackFingerprint, setAckFingerprint] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState<null | "on" | "off">(null);
  const [refusal, setRefusal] = React.useState<string | null>(null);
  const [showProblems, setShowProblems] = React.useState(false);
  const [moreOpen, setMoreOpen] = React.useState(
    initial.inputs.length > 0 || initial.rules.length > 0 || initial.notes.length > 0 || initial.doneWhen.trim() !== ""
  );
  const [showText, setShowText] = React.useState(false);
  const [revoking, setRevoking] = React.useState(false);
  const savedSnapshot = React.useRef(teachSnapshot(initial));

  const apps: readonly TaughtApp[] = context?.apps ?? [];
  const projects = context?.projects ?? [];
  const base = mode.kind === "reteach" ? mode.base : undefined;
  const fingerprint = acknowledgementFingerprint(state, base);
  const acknowledged = ackFingerprint !== null && ackFingerprint === fingerprint;
  const problems = teachProblems(state);
  const scan = React.useMemo(() => teachScan(state, base), [state, base]);
  const blocked = scan.status === "blocked";
  const slug = skillSlugFromName(state.name.trim());
  const summary = teachSummary(state, { apps, projects });
  const dirty = teachSnapshot(state) !== savedSnapshot.current;
  const instructions = showText ? renderTaughtInstructions(formFromState(state)) : "";

  // Leaving with unsaved changes asks first: a walkthrough is typed once.
  React.useEffect(() => {
    if (!dirty || saving) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, saving]);

  const patch = (next: Partial<TeachEditorState>) => {
    setRefusal(null);
    setState((current) => ({ ...current, ...next }));
  };

  const save = async (enable: boolean) => {
    if (saving) return;
    if (problems.length > 0) {
      setShowProblems(true);
      return;
    }
    if (enable && !acknowledged) {
      setRefusal("Tick “I’ve reviewed it” to switch it on, or save it switched off.");
      return;
    }
    setSaving(enable ? "on" : "off");
    setRefusal(null);
    const payload = teachSavePayload(state, {
      key: mode.kind === "new" ? mode.key : null,
      skillId: mode.kind === "reteach" ? mode.skillId : null,
      source: mode.source,
      enable,
      acknowledged: enable ? ackFingerprint : null,
    });
    const result = await saveTaughtSkillRequest(payload);
    setSaving(null);
    if (result.kind === "ok") {
      savedSnapshot.current = teachSnapshot(state);
      onSaved(result.value);
      return;
    }
    setRefusal(teachFailureMessage(result, "Couldn’t save this skill. Nothing was changed, so trying again is safe."));
  };

  const revoke = async () => {
    if (mode.kind !== "reteach" || revoking) return;
    setRevoking(true);
    const result = await revokeTaughtSkillRequest(mode.skillId);
    setRevoking(false);
    if (result.kind === "ok") {
      onRevoked?.();
      return;
    }
    setRefusal(teachFailureMessage(result, "Couldn’t turn it off. Try again in a moment."));
  };

  const invalidSteps = new Set(
    showProblems ? state.steps.filter((s) => s.text.trim().length > 600).map((s) => s.id) : []
  );
  const nameProblem = showProblems ? problems.find((p) => p.field === "name") : undefined;
  const stepsProblem = showProblems ? problems.find((p) => p.field === "steps") : undefined;
  const busy = saving !== null || revoking;
  const reteachOn = mode.kind === "reteach" && mode.enabled;

  return (
    <div className="space-y-8">
      {draftNotes?.fromOutsideContent ? (
        <WorkStateNote tone="warning">
          {PRODUCT_NAME} drafted this while reading content from outside the conversation (a page, a file or an app). Read
          every step before you switch it on.
        </WorkStateNote>
      ) : null}

      <TeachSection index={1} title="Name it" delay={0}>
        <div className="space-y-4">
          <div>
            <Label htmlFor={`${fieldId}-name`}>Name</Label>
            <Input
              id={`${fieldId}-name`}
              value={state.name}
              onChange={(event) => patch({ name: event.target.value })}
              placeholder="File the monthly invoices"
              aria-invalid={nameProblem ? true : undefined}
              aria-describedby={`${fieldId}-slug`}
              disabled={busy}
              maxLength={80}
              className="mt-1.5 text-body"
            />
            <p id={`${fieldId}-slug`} className="mt-1.5 text-caption text-muted-foreground" aria-live="polite">
              {nameProblem ? (
                <span className="text-destructive">{nameProblem.message}</span>
              ) : slug ? (
                <>
                  {mode.kind === "reteach" && mode.slug !== slug ? "Keeps its slash name " : "Type "}
                  <span className="font-mono text-foreground" translate="no">
                    /{mode.kind === "reteach" ? mode.slug : slug}
                  </span>
                  {" in any chat to use it."}
                </>
              ) : (
                "Use at least one letter or number."
              )}
            </p>
          </div>
          <div>
            <Label htmlFor={`${fieldId}-when`}>When should it be used?</Label>
            <Textarea
              id={`${fieldId}-when`}
              value={state.whenToUse}
              onChange={(event) => patch({ whenToUse: event.target.value })}
              placeholder="When I ask to file or sort invoices for a month."
              rows={2}
              disabled={busy}
              maxLength={400}
              className="mt-1.5 min-h-0 resize-none [field-sizing:content]"
            />
            <p className="mt-1.5 text-caption text-muted-foreground">
              {PRODUCT_NAME} reads this to tell when the skill fits a request.
            </p>
          </div>
        </div>
      </TeachSection>

      <TeachSection
        index={2}
        title="Steps"
        delay={1}
        caption="In the order you do them, in your own words. Enter starts the next step."
      >
        {state.questions.length > 0 ? (
          <div className="mb-4 space-y-2">
            {state.questions.map((question) => (
              <div key={question.id} className="rounded-field bg-[hsl(var(--attention)/0.07)] px-3.5 py-3">
                <p className="flex items-start gap-2 text-ui text-foreground">
                  <HelpCircle className="mt-0.5 size-4 shrink-0 text-[hsl(var(--attention))]" aria-hidden="true" />
                  <span>
                    <span className="font-medium">{PRODUCT_NAME} wasn’t sure: </span>
                    {question.question}
                  </span>
                </p>
                <Input
                  value={question.answer}
                  onChange={(event) =>
                    patch({
                      questions: state.questions.map((q) => (q.id === question.id ? { ...q, answer: event.target.value } : q)),
                    })
                  }
                  placeholder="Answer, or leave it and it will ask you each time"
                  aria-label={`Answer: ${question.question}`}
                  disabled={busy}
                  className="mt-2 bg-background"
                />
              </div>
            ))}
          </div>
        ) : null}

        <TeachListEditor
          items={state.steps}
          onChange={(steps) => patch({ steps })}
          numbered
          label="Step"
          addLabel="Add a step"
          placeholderFor={(index) => (index === 0 ? "What do you do first?" : "Then what?")}
          max={LIST_LIMITS.steps}
          disabled={busy}
          invalidIds={invalidSteps}
          autoFocusFirst={autoFocusSteps}
        />
        {stepsProblem ? (
          <p role="alert" className="mt-1 pl-1 text-caption text-destructive">
            {stepsProblem.message}
          </p>
        ) : null}

        <button
          type="button"
          onClick={() => setMoreOpen((open) => !open)}
          aria-expanded={moreOpen}
          className="mt-4 inline-flex items-center gap-1.5 rounded-control text-ui text-muted-foreground transition-colors duration-fast ease-out-soft hover:text-foreground motion-reduce:transition-none coarse:min-h-11"
        >
          <ChevronDown
            className={cn("size-3.5 transition-transform duration-base ease-in-out motion-reduce:transition-none", moreOpen && "rotate-180")}
            aria-hidden="true"
          />
          {moreOpen ? "Less detail" : "Add detail: what it asks for, when it’s done, rules"}
        </button>
        <Collapse open={moreOpen} innerClassName="space-y-6 pt-4">
          <div>
            <p className="text-ui font-medium text-foreground">What it asks you for each time</p>
            <p className="text-caption text-muted-foreground">A month, a folder, a client name. Optional.</p>
            <div className="mt-2 space-y-2">
              <AnimatePresence initial={false}>
                {state.inputs.map((input) => (
                  <motion.div
                    key={input.id}
                    layout={reduce ? false : "position"}
                    initial={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0, transition: transition.base }}
                    exit={{ opacity: 0, transition: transition.exit }}
                    className="flex flex-wrap items-center gap-2"
                  >
                    <Input
                      value={input.name}
                      onChange={(event) =>
                        patch({ inputs: state.inputs.map((i) => (i.id === input.id ? { ...i, name: event.target.value } : i)) })
                      }
                      placeholder="Month"
                      aria-label="What it asks for"
                      disabled={busy}
                      maxLength={60}
                      className="w-40"
                    />
                    <Input
                      value={input.description}
                      onChange={(event) =>
                        patch({
                          inputs: state.inputs.map((i) => (i.id === input.id ? { ...i, description: event.target.value } : i)),
                        })
                      }
                      placeholder="Which month to file, like March 2026"
                      aria-label={`What ${input.name || "it"} means`}
                      disabled={busy}
                      maxLength={200}
                      className="min-w-48 flex-1"
                    />
                    <label className="flex items-center gap-2 text-caption text-muted-foreground">
                      <Checkbox
                        checked={!input.required}
                        onCheckedChange={(checked) =>
                          patch({ inputs: state.inputs.map((i) => (i.id === input.id ? { ...i, required: checked !== true } : i)) })
                        }
                        disabled={busy}
                      />
                      Optional
                    </label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => patch({ inputs: state.inputs.filter((i) => i.id !== input.id) })}
                      disabled={busy}
                      className="font-normal text-muted-foreground hover:text-foreground"
                    >
                      Remove
                    </Button>
                  </motion.div>
                ))}
              </AnimatePresence>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy || state.inputs.length >= MAX_TAUGHT_INPUTS}
                onClick={() =>
                  patch({ inputs: [...state.inputs, { id: teachItemId(), name: "", description: "", required: true }] })
                }
                className="gap-1.5 font-normal text-muted-foreground hover:text-foreground"
              >
                + Something it asks for
              </Button>
            </div>
          </div>
          <div>
            <Label htmlFor={`${fieldId}-done`}>Done when</Label>
            <Input
              id={`${fieldId}-done`}
              value={state.doneWhen}
              onChange={(event) => patch({ doneWhen: event.target.value })}
              placeholder="Every invoice is in the month’s folder and renamed."
              disabled={busy}
              maxLength={400}
              className="mt-1.5"
            />
          </div>
          <div>
            <p className="text-ui font-medium text-foreground">Rules</p>
            <p className="mb-1 text-caption text-muted-foreground">What it must always or never do.</p>
            <TeachListEditor
              items={state.rules}
              onChange={(rules) => patch({ rules })}
              label="Rule"
              addLabel="Add a rule"
              placeholderFor={() => "Never delete an email."}
              max={LIST_LIMITS.rules}
              disabled={busy}
            />
          </div>
          {state.notes.length > 0 ? (
            <div>
              <p className="text-ui font-medium text-foreground">Notes</p>
              <TeachListEditor
                items={state.notes}
                onChange={(notes) => patch({ notes })}
                label="Note"
                addLabel="Add a note"
                placeholderFor={() => "Something worth knowing."}
                max={LIST_LIMITS.notes}
                disabled={busy}
              />
            </div>
          ) : null}
        </Collapse>
      </TeachSection>

      <TeachSection
        index={3}
        title="What it may use"
        delay={2}
        caption={draftNotes?.dropped.length ? undefined : "Only what the method needs."}
      >
        {draftNotes && (draftNotes.dropped.length > 0 || draftNotes.missingApps.length > 0) ? (
          <p className="mb-3 text-caption leading-relaxed text-muted-foreground">
            {draftNotes.dropped.length > 0
              ? `Left out because a skill can’t ask for it: ${listPhrase(draftNotes.dropped)}. `
              : ""}
            {draftNotes.missingApps.length > 0 ? (
              <>
                {`Not connected: ${listPhrase(draftNotes.missingApps)}. `}
                <Link href="/connections" className="underline underline-offset-2 hover:text-foreground">
                  Connect
                </Link>
              </>
            ) : null}
          </p>
        ) : null}
        <TeachPermissions
          tools={state.tools}
          connectors={state.connectors}
          domains={state.domains}
          apps={apps}
          observed={observed}
          onChange={(next) => patch(next)}
          disabled={busy}
        />
      </TeachSection>

      <TeachSection index={4} title="Where it applies" delay={3}>
        <SegmentedControl
          value={state.projectId ? "project" : "everywhere"}
          onChange={(value) => patch({ projectId: value === "everywhere" ? null : (projects[0]?.id ?? null) })}
          options={[
            { value: "everywhere", label: "Everywhere" },
            { value: "project", label: "One project", disabled: projects.length === 0 },
          ]}
          ariaLabel="Where it applies"
          optionClassName="px-3 py-1 text-ui"
          className="max-w-xs"
        />
        <Collapse open={state.projectId !== null} innerClassName="pt-3">
          <Select value={state.projectId ?? undefined} onValueChange={(projectId) => patch({ projectId })} disabled={busy}>
            <SelectTrigger className="max-w-sm" aria-label="Project">
              <SelectValue placeholder="Choose a project" />
            </SelectTrigger>
            <SelectContent>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Collapse>
        <p className="mt-2 text-caption leading-relaxed text-muted-foreground">
          {state.projectId
            ? "It’s offered only in that project’s chats and tasks."
            : projects.length === 0
              ? "It’s offered in every chat. Projects appear here once you have one."
              : "It’s offered in every chat."}
        </p>
      </TeachSection>

      <TeachSection index={5} title="Review" delay={4} id="teach-review">
        <div className="rounded-card bg-muted/70 p-4 contrast-more:border contrast-more:border-border sm:p-5">
          <p className="text-body text-foreground" aria-live="polite">
            {summary}
            {mode.kind === "reteach" ? (
              <span className="text-muted-foreground">{` · saves version ${mode.currentVersion + 1}`}</span>
            ) : null}
          </p>

          <div className="mt-3 flex items-start gap-2 text-ui">
            {scan.status === "clear" ? (
              <>
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-[hsl(var(--success-ink))]" aria-hidden="true" />
                <span className="text-muted-foreground">Safety check: nothing flagged.</span>
              </>
            ) : (
              <>
                <AlertTriangle
                  className={cn("mt-0.5 size-4 shrink-0", blocked ? "text-destructive" : "text-warning-foreground")}
                  aria-hidden="true"
                />
                <span className={blocked ? "text-destructive" : "text-foreground"}>
                  {blocked ? "The safety check refuses this. " : "The safety check flagged: "}
                  {scan.findings.map((finding) => finding.message).join(" ")}
                </span>
              </>
            )}
          </div>

          <button
            type="button"
            onClick={() => setShowText((open) => !open)}
            aria-expanded={showText}
            className="mt-3 inline-flex items-center gap-1.5 rounded-control text-caption text-muted-foreground underline-offset-2 hover:text-foreground hover:underline coarse:min-h-11"
          >
            <ChevronDown
              className={cn("size-3.5 transition-transform duration-base ease-in-out motion-reduce:transition-none", showText && "rotate-180")}
              aria-hidden="true"
            />
            {showText ? "Hide the text" : `See exactly what ${PRODUCT_NAME} will read`}
          </button>
          <Collapse open={showText} innerClassName="pt-2">
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-field bg-background p-3.5 font-mono text-caption leading-relaxed text-foreground">
              {instructions || "Nothing yet."}
            </pre>
          </Collapse>

          <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-field bg-background px-3.5 py-3 text-ui leading-relaxed text-foreground">
            <Checkbox
              checked={acknowledged}
              onCheckedChange={(checked) => setAckFingerprint(checked === true ? fingerprint : null)}
              disabled={busy || blocked}
              className="mt-0.5"
            />
            <span>
              I’ve reviewed these steps and what it may use.
              <span className="block text-caption text-muted-foreground">
                {ackFingerprint !== null && !acknowledged
                  ? "What it may use changed since you ticked this. Check it again."
                  : "Needed to switch it on. You can switch it off or delete it any time."}
              </span>
            </span>
          </label>

          <AnimatePresence>
            {refusal ? (
              <motion.p
                key="refusal"
                role="alert"
                initial={{ opacity: 0, y: reduce ? 0 : -2 }}
                animate={{ opacity: 1, y: 0, transition: transition.base }}
                exit={{ opacity: 0, transition: transition.exit }}
                className="mt-3 text-ui leading-relaxed text-destructive"
              >
                {refusal}
              </motion.p>
            ) : null}
          </AnimatePresence>
          {showProblems && problems.length > 0 ? (
            <p role="alert" className="mt-3 text-ui text-destructive">
              {problems.map((p) => p.message).join(" ")}
            </p>
          ) : null}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              onClick={() => void save(true)}
              loading={saving === "on"}
              disabled={busy || blocked || !acknowledged}
              className="gap-1.5"
            >
              <Check className="size-4" aria-hidden="true" />
              {reteachOn ? `Save version ${mode.kind === "reteach" ? mode.currentVersion + 1 : 1}` : "Save and turn on"}
            </Button>
            <Button type="button" variant="outline" onClick={() => void save(false)} loading={saving === "off"} disabled={busy}>
              {reteachOn ? "Save and turn off" : "Save, keep it off"}
            </Button>
            {reteachOn ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void revoke()}
                loading={revoking}
                disabled={busy}
                className="font-normal text-muted-foreground hover:text-destructive"
              >
                Turn it off now
              </Button>
            ) : null}
          </div>
          <p className="mt-3 text-caption leading-relaxed text-muted-foreground">
            Nothing runs until it’s on. Every save is kept as a version you can go back to, and you can turn it off or
            delete it from Skills at any time.
          </p>
        </div>
      </TeachSection>
    </div>
  );
}
