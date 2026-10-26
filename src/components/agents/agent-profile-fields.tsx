"use client";

import * as React from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { ChevronDown } from "@/components/ui/icons";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/segmented-control";
import { useApp } from "@/components/app/app-provider";
import { JunoMark } from "@/components/brand/logo";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { choiceTriggerClass } from "@/components/settings/choice-menu";
import { ModelCombobox } from "@/components/settings/model-picker";
import { AUTO_MODEL_ID_SETTING, chatModels } from "@/components/settings/model-list";
import { AgentFace } from "@/components/agents/agent-face";
import {
  AGENT_EYES,
  AGENT_EYES_LABEL,
  AGENT_SHAPES,
  AGENT_SHAPE_LABEL,
  AGENT_TONES,
  AGENT_TONE_LABEL,
  type AgentAvatar,
} from "@/lib/agents/avatar";
import { AGENT_STYLES, AGENT_STYLE_LABEL, AGENT_STYLE_SUMMARY, type AgentState, type AgentStyle } from "@/lib/agents/domain";
import {
  WORK_APPROVAL_MODE_LABEL,
  WORK_APPROVAL_MODE_SUMMARY,
  WORK_PERMISSION_POLICIES,
  type WorkPermissionPolicy,
} from "@/lib/work/domain";
import { resolveModel, type ModelInfo } from "@/lib/models";
import { reasoningOptions } from "@/lib/model-metrics";
import { cn } from "@/lib/utils";
import { PRODUCT_NAME } from "@/lib/brand/names";

/**
 * The controls an agent is described with, shared by hiring (`/agents/new`) and
 * the Profile tab, so the two can never offer different choices for the same
 * field.
 *
 * Every picker is a radiogroup with one tab stop and arrow keys (the house
 * idiom — see SegmentedControl), drawn as flat tiles: the chosen one takes the
 * `--selected` fill and a darker edge, never a shadow (FLAT_UI.md §2).
 */

const tileClass =
  "rounded-card border border-border bg-card text-left transition-colors duration-fast ease-out-soft hover:bg-accent aria-checked:border-foreground/40 aria-checked:bg-selected";

function useRovingRadio<T extends string>(values: readonly T[], value: T, onChange: (next: T) => void) {
  const refs = React.useRef<Partial<Record<T, HTMLButtonElement | null>>>({});
  const onKeyDown = (event: React.KeyboardEvent) => {
    const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
    const back = event.key === "ArrowLeft" || event.key === "ArrowUp";
    if (!forward && !back) return;
    event.preventDefault();
    const index = values.indexOf(value);
    const next = values[(index + (forward ? 1 : -1) + values.length) % values.length];
    onChange(next);
    refs.current[next]?.focus();
  };
  const props = (option: T) => ({
    ref: (node: HTMLButtonElement | null) => {
      refs.current[option] = node;
    },
    type: "button" as const,
    role: "radio" as const,
    "aria-checked": option === value,
    tabIndex: option === value ? 0 : -1,
    onClick: () => onChange(option),
  });
  return { onKeyDown, props };
}

// ---------------------------------------------------------------------------
// The face
// ---------------------------------------------------------------------------

/**
 * The states a face can be tried in, in the order they happen, the one an
 * agent enters most (thinking) included. Short labels, so the switcher is one
 * row in the studio's and the hire flow's narrow columns.
 */
const PREVIEW_STATES: ReadonlyArray<SegmentedOption<AgentState>> = [
  { value: "idle", label: "Ready" },
  { value: "thinking", label: "Thinking" },
  { value: "working", label: "Working" },
  { value: "waiting", label: "Needs you" },
  { value: "done", label: "Done" },
];

/**
 * The one state switcher for a face preview, shared by the face studio and
 * the hire flow: the house segmented control (one tab stop, arrows move),
 * set tight so all five fit one row, unwrapped, in a 19rem column (about
 * 295 px).
 */
export function FaceStatePicker({ value, onChange, className }: { value: AgentState; onChange: (next: AgentState) => void; className?: string }) {
  return (
    <SegmentedControl
      value={value}
      onChange={onChange}
      options={PREVIEW_STATES}
      ariaLabel="Preview a state"
      size="sm"
      columns="content"
      optionClassName="whitespace-nowrap px-[5px] text-caption"
      className={cn("gap-0.5", className)}
    />
  );
}

/**
 * The face at size, with the states it will show once it is working.
 *
 * Grok's avatar studio lets you check every state before you commit to a face;
 * this is the same idea at the size of one control. The person sees the
 * character move before they hire it — which is what the face is for — so it
 * is alive as in the studio: it blinks, glances now and then and looks toward
 * the pointer.
 */
export function FacePreview({ avatar, name, caption }: { avatar: AgentAvatar; name: string; caption?: React.ReactNode }) {
  const [state, setState] = React.useState<AgentState>("idle");
  return (
    <div className="flex flex-col items-center">
      {/* The column is as wide as the picker, so the face card and the picker
          share their edges. Flex, not grid: a grid made the panel radius's
          ::after a second row and set the face 15 px above centre. `direct`:
          a state picked here plays at once, never held like an agent loop's. */}
      <div className="flex w-fit max-w-full flex-col items-stretch gap-4">
        <div data-face-trigger className="flex h-40 items-center justify-center rounded-panel border border-border bg-card after:hidden">
          <AgentFace avatar={avatar} state={state} size="lg" name={name || "New agent"} live look direct />
        </div>
        {/* Who it is sits with its face, as in the studio: then the states to try. */}
        {/* `w-0 min-w-full`: a long name or role wraps inside the column rather than widening it. */}
        {caption ? <div className="-mt-1 w-0 min-w-full text-pretty break-words text-center">{caption}</div> : null}
        <FaceStatePicker value={state} onChange={setState} />
      </div>
    </div>
  );
}

/**
 * One row of look choices, shared by the face studio and the hire flow: flat
 * tiles, the chosen one in the `--selected` fill with a darker edge.
 * `className` lays the tiles out (the studio keeps nine shapes in one row,
 * or five and four, never eight and an orphan).
 */
export function SwatchRow<T extends string>({
  label,
  values,
  value,
  onChange,
  render,
  name,
  className,
}: {
  label: string;
  values: readonly T[];
  value: T;
  onChange: (next: T) => void;
  render: (option: T) => React.ReactNode;
  name: (option: T) => string;
  className?: string;
}) {
  const radio = useRovingRadio(values, value, onChange);
  return (
    <div>
      <p className="mb-1.5 font-mono text-label text-muted-foreground">{label}</p>
      <div role="radiogroup" aria-label={label} className={className ?? "flex flex-wrap gap-1.5"} onKeyDown={radio.onKeyDown}>
        {values.map((option) => (
          <button
            key={option}
            {...radio.props(option)}
            aria-label={`${label}: ${name(option)}`}
            title={name(option)}
            className={cn(tileClass, "grid size-11 place-items-center rounded-control p-0 active:scale-95 motion-reduce:active:scale-100")}
          >
            {render(option)}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The colour swatch, the shape's face and the eyes' crop, as both look pickers draw them. */
export const lookSwatch = {
  tone: (tone: AgentAvatar["tone"]) => <span aria-hidden="true" className="size-5 rounded-full" style={{ background: `hsl(var(--agent-${tone}))` }} />,
  shape: (avatar: AgentAvatar, shape: AgentAvatar["shape"]) => <AgentFace avatar={{ ...avatar, shape, mark: "none" }} size={30} still />,
  // The middle of a 44 px face facing straight out, so the cut itself shows:
  // a whole 30 px face draws eyes a few pixels tall and the four look alike,
  // and at the rest turn the far eye is foreshortened.
  eyes: (avatar: AgentAvatar, eyes: AgentAvatar["eyes"]) => (
    <span aria-hidden="true" className="grid size-[30px] place-items-center overflow-hidden rounded-full">
      <AgentFace avatar={{ ...avatar, eyes, mark: "none" }} size={44} still pose="front" className="-m-[7px]" />
    </span>
  ),
};

export function FaceBuilder({ avatar, onChange }: { avatar: AgentAvatar; onChange: (next: AgentAvatar) => void }) {
  const set = <K extends keyof AgentAvatar>(key: K) => (next: AgentAvatar[K]) => onChange({ ...avatar, [key]: next });
  return (
    <div className="space-y-4">
      {/* Colour, Shape, Eyes: the face studio's order. */}
      <SwatchRow label="Colour" values={AGENT_TONES} value={avatar.tone} onChange={set("tone")} name={(option) => AGENT_TONE_LABEL[option]} render={lookSwatch.tone} />
      <SwatchRow
        label="Shape"
        values={AGENT_SHAPES}
        value={avatar.shape}
        onChange={set("shape")}
        name={(option) => AGENT_SHAPE_LABEL[option]}
        render={(option) => lookSwatch.shape(avatar, option)}
      />
      <SwatchRow
        label="Eyes"
        values={AGENT_EYES}
        value={avatar.eyes}
        onChange={set("eyes")}
        name={(option) => AGENT_EYES_LABEL[option]}
        render={(option) => lookSwatch.eyes(avatar, option)}
      />
      {/* No Mark row: the stored mark is no longer drawn (it only tunes how
          the face blinks and glances, face-rig.ts), so six swatches would
          all look the same. The value is kept as it is (docs/design/AGENTS.md §4). */}
    </div>
  );
}

// ---------------------------------------------------------------------------
// How it talks, and what it may do
// ---------------------------------------------------------------------------

export function StylePicker({ value, onChange }: { value: AgentStyle; onChange: (next: AgentStyle) => void }) {
  const radio = useRovingRadio(AGENT_STYLES, value, onChange);
  return (
    <div role="radiogroup" aria-label="How it talks" className="grid grid-cols-1 gap-2 @[32rem]:grid-cols-2" onKeyDown={radio.onKeyDown}>
      {AGENT_STYLES.map((option) => (
        <button key={option} {...radio.props(option)} className={cn(tileClass, "p-3")}>
          <span className="block text-ui font-medium text-foreground">{AGENT_STYLE_LABEL[option]}</span>
          <span className="mt-0.5 block text-ui text-muted-foreground">{AGENT_STYLE_SUMMARY[option]}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * The three Work modes by their promise labels, with the floor spelled out
 * beneath — under every mode, not as a caveat on the last one, for the reason
 * `WORK_APPROVAL_MODE_SUMMARY` gives: finding out from a prompt you were
 * promised would not come is how a person concludes the setting does nothing.
 */
export function AutonomyPicker({
  value,
  onChange,
}: {
  value: WorkPermissionPolicy;
  onChange: (next: WorkPermissionPolicy) => void;
}) {
  const radio = useRovingRadio(WORK_PERMISSION_POLICIES, value, onChange);
  return (
    <div>
      <div role="radiogroup" aria-label="Autonomy" className="space-y-2" onKeyDown={radio.onKeyDown}>
        {WORK_PERMISSION_POLICIES.map((option) => (
          <button key={option} {...radio.props(option)} className={cn(tileClass, "block w-full p-3")}>
            <span className="block text-ui font-medium text-foreground">{WORK_APPROVAL_MODE_LABEL[option]}</span>
            <span className="mt-0.5 block text-ui text-muted-foreground">
              {WORK_APPROVAL_MODE_SUMMARY[option].replace(`${PRODUCT_NAME} `, "It ")}
            </span>
          </button>
        ))}
      </div>
      <p className="mt-3 text-ui text-muted-foreground">
        Whatever you choose, it always asks before it sends a message, publishes, pays or buys anything, deletes
        something for good, or changes an account or security setting.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// What it thinks with
// ---------------------------------------------------------------------------

const DEFAULT_EFFORT = "default";

/** The efforts a person can set for this model. Empty for Auto and for a model with nothing to choose. */
function agentEfforts(model: ModelInfo | null): { value: string; label: string }[] {
  if (!model) return [];
  return reasoningOptions(model).flatMap((option) => (option.value ? [{ value: option.value, label: option.label }] : []));
}

/**
 * The model its thread and its tasks use, and how hard it thinks.
 *
 * Unset is the account's default, the model a new chat starts on, and the
 * control says so rather than naming a model the agent was never set to. The
 * list is the one Settings uses (grouped by lab, searchable, locked past the
 * plan), so an agent is never offered a model the account could not pick for
 * itself. Effort is offered only when there is one to choose: Auto picks its
 * own, and some models think at one depth only. Its Default is the effort the
 * chat composer sends.
 */
export function ModelPicker({
  model,
  reasoningEffort,
  onChange,
}: {
  model: string | null;
  reasoningEffort: string | null;
  onChange: (next: { model: string | null; reasoningEffort: string | null }) => void;
}) {
  const { models, quota } = useApp();
  const chat = React.useMemo(() => chatModels(models), [models]);
  const find = React.useCallback(
    (id: string | null) =>
      id && id !== AUTO_MODEL_ID_SETTING ? (chat.find((option) => option.id === id) ?? resolveModel(id)) : null,
    [chat]
  );
  const chosen = find(model);
  const selected = React.useMemo(() => new Set(model ? [model] : []), [model]);
  const efforts = agentEfforts(chosen);

  // A new model keeps the effort only when it offers the same one.
  const choose = (next: string) => {
    const keeps = agentEfforts(find(next)).some((option) => option.value === reasoningEffort);
    onChange({ model: next, reasoningEffort: keeps ? reasoningEffort : null });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <ModelCombobox
          models={chat}
          plan={quota.plan}
          mode="single"
          includeAuto
          selected={selected}
          label="Model"
          onSelect={choose}
        >
          <button type="button" className={cn(choiceTriggerClass, "justify-start @[28rem]:w-72")}>
            <span className="sr-only">Model </span>
            {chosen ? (
              <ProviderLogo provider={chosen.provider} className="size-4 text-foreground" />
            ) : (
              <JunoMark className="size-4 shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate">
              {chosen ? <span translate="no">{chosen.name}</span> : model ? "Auto" : "Your default"}
            </span>
            <ChevronDown
              className="size-4 shrink-0 opacity-60 transition-transform duration-base ease-in-out motion-reduce:transition-none group-data-[state=open]:rotate-180"
              aria-hidden="true"
            />
          </button>
        </ModelCombobox>
        {model ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => onChange({ model: null, reasoningEffort: null })}>
            Use your default
          </Button>
        ) : null}
      </div>
      {efforts.length > 0 ? (
        <div>
          <p className="mb-2 font-mono text-label text-muted-foreground">Thinking effort</p>
          <Select
            value={reasoningEffort ?? DEFAULT_EFFORT}
            onValueChange={(value) => onChange({ model, reasoningEffort: value === DEFAULT_EFFORT ? null : value })}
          >
            <SelectTrigger aria-label="Thinking effort" className="w-full @[28rem]:w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_EFFORT}>Default</SelectItem>
              {efforts.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
    </div>
  );
}

export interface ConnectorOption {
  id: string;
  label: string;
  connected: boolean;
}

/** Only apps the account has linked are offered: a suggestion is never a grant. */
export function useLinkedConnectors(): ConnectorOption[] | null {
  const [options, setOptions] = React.useState<ConnectorOption[] | null>(null);
  React.useEffect(() => {
    let live = true;
    fetch("/api/connectors")
      .then((res) => (res.ok ? res.json() : { connectors: [] }))
      .then((data: { connectors?: unknown }) => {
        if (!live) return;
        const list = Array.isArray(data.connectors) ? data.connectors : [];
        setOptions(
          list
            .filter((item): item is ConnectorOption =>
              !!item && typeof item === "object" && typeof (item as ConnectorOption).id === "string"
            )
            .filter((item) => item.connected)
            .map((item) => ({ id: item.id, label: item.label, connected: true }))
        );
      })
      .catch(() => {
        if (live) setOptions([]);
      });
    return () => {
      live = false;
    };
  }, []);
  return options;
}

export function ConnectorPicker({
  options,
  value,
  onChange,
}: {
  options: ConnectorOption[] | null;
  value: readonly string[];
  onChange: (next: string[]) => void;
}) {
  if (options === null) return <p className="text-ui text-muted-foreground">Looking for your connected apps…</p>;
  if (options.length === 0) {
    return (
      <p className="text-ui text-muted-foreground">
        No apps are connected yet. Connect one in Settings › Connectors and give it to this agent later.
      </p>
    );
  }
  const chosen = new Set(value);
  return (
    <ul className="space-y-1">
      {options.map((option) => {
        const id = `agent-app-${option.id}`;
        return (
          <li key={option.id}>
            <label
              htmlFor={id}
              className="flex cursor-pointer items-center gap-3 rounded-control px-2 py-2 transition-colors duration-fast ease-out-soft hover:bg-accent"
            >
              <Checkbox
                id={id}
                checked={chosen.has(option.id)}
                onCheckedChange={(checked) => {
                  const next = new Set(chosen);
                  if (checked === true) next.add(option.id);
                  else next.delete(option.id);
                  onChange([...next]);
                }}
              />
              <span className="text-ui text-foreground">{option.label}</span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}
