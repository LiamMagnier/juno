"use client";

/**
 * Prototyping: what the selected layer does when someone touches it.
 *
 * This is the right rail's second tab, beside the inspector, because an
 * interaction belongs to a layer the same way its fill does — it is authored
 * while looking at the thing that reacts, not in a separate mode. Every control
 * writes a whole `PrototypeInteraction` back through `createInteraction` under
 * its own id: the operation replaces what was there and inverts to it, so
 * changing a trigger is one undo step rather than a delete and an add that undo
 * would take apart in the wrong order.
 *
 * Actions are offered only where the document can express them. A "set variant"
 * with no components that have variants, or a "set variable" with no variables,
 * would be a menu item that leads to a form with nothing in it — so those rows
 * are absent until the document has something for them to name. What is offered
 * is fully editable; nothing here is a stub.
 *
 * One honesty note the panel makes out loud rather than hiding: the editor has
 * no prototype player. Triggers are authored data. The HTML export wires up
 * `navigate` and `open-url`, the handoff bundle carries the whole interaction
 * graph, and `play-animation` can be watched in the timeline dock — but clicking
 * a layer on this canvas will not fire its own trigger, and pretending otherwise
 * with a "Preview" button that did nothing would be worse than saying so.
 */

import * as React from "react";
import { Plus, X } from "lucide-react";
import { EasingEditor, InlineNumber, SmallSelect, fieldClass } from "@/components/design/motion-panel";
import { hexToRgba, rgbaToHex } from "@/lib/design/variables";
import {
  isContainer,
  type DesignDocument,
  type DesignVariable,
  type InstanceNode,
  type InteractionAction,
  type InteractionTrigger,
  type NodeId,
  type PrototypeInteraction,
  type Transition,
  type VariableValue,
} from "@/lib/design/types";
import type { DesignOperation } from "@/lib/design/operations";
import { cn } from "@/lib/utils";

let interactionCounter = 0;
const nextInteractionId = () => `int-${Date.now().toString(36)}-${(interactionCounter++).toString(36)}`;

/** What a fresh interaction starts as: a click that goes somewhere, dissolving
 *  over the duration the rest of the product uses for a screen change. */
const DEFAULT_TRANSITION: Transition = {
  kind: "dissolve",
  durationMs: 220,
  delayMs: 0,
  easing: { type: "ease-in-out" },
  matchStableIds: true,
};

const TRIGGER_LABELS: { value: InteractionTrigger["type"]; label: string }[] = [
  { value: "click", label: "On click" },
  { value: "hover", label: "While hovering" },
  { value: "press", label: "While pressed" },
  { value: "drag", label: "On drag" },
  { value: "key", label: "On key" },
  { value: "delay", label: "After a delay" },
  { value: "scroll-into-view", label: "On scroll into view" },
];

export function InteractionsPanel({
  document: doc,
  selection,
  onApply,
  readOnly,
}: {
  document: DesignDocument;
  selection: NodeId[];
  onApply: (operations: DesignOperation[], summary: string) => void;
  readOnly?: boolean;
}) {
  const nodeId = selection.length === 1 ? selection[0] : null;
  const node = nodeId ? doc.nodes[nodeId] : null;

  const interactions = React.useMemo(
    () => (nodeId ? Object.values(doc.interactions).filter((interaction) => interaction.sourceNodeId === nodeId) : []),
    [doc.interactions, nodeId]
  );

  /** Frames and groups are what a prototype navigates between; offering every
   *  rectangle on the page as a destination would bury the two that mean
   *  anything. */
  const destinations = React.useMemo(
    () =>
      Object.values(doc.nodes)
        .filter((candidate) => isContainer(candidate))
        .map((candidate) => ({ value: candidate.id, label: candidate.name })),
    [doc.nodes]
  );

  const animations = React.useMemo(
    () => Object.values(doc.animations).map((animation) => ({ value: animation.id, label: animation.name })),
    [doc.animations]
  );

  if (selection.length !== 1 || !node) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center">
        <p className="text-caption text-muted-foreground">
          {selection.length === 0 ? "Select a layer to give it a trigger." : "Interactions are authored one layer at a time."}
        </p>
      </div>
    );
  }

  const write = (interaction: PrototypeInteraction, summary: string) => {
    if (readOnly) return;
    onApply([{ op: "createInteraction", interaction }], summary);
  };

  const add = () => {
    if (readOnly) return;
    write(
      {
        id: nextInteractionId(),
        sourceNodeId: node.id,
        trigger: { type: "click" },
        // "Back" is the one action that needs nothing named and cannot dangle,
        // which makes it the only honest default on a document that may have no
        // second frame and no animations yet.
        action: { type: "back" },
        transition: DEFAULT_TRANSITION,
      },
      "Add interaction"
    );
  };

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
      <div className="flex items-center justify-between">
        <h3 className="truncate font-mono text-micro text-muted-foreground">{node.name}</h3>
        <button
          type="button"
          disabled={readOnly}
          onClick={add}
          aria-label="Add an interaction"
          className="pressable rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        >
          <Plus className="size-3" aria-hidden />
        </button>
      </div>

      {interactions.length === 0 && (
        <p className="text-caption text-muted-foreground">
          Nothing happens when someone touches this layer yet.
        </p>
      )}

      {interactions.map((interaction) => (
        <InteractionCard
          key={interaction.id}
          interaction={interaction}
          document={doc}
          destinations={destinations}
          animations={animations}
          readOnly={readOnly}
          onChange={(next, summary) => write(next, summary)}
          onRemove={() => onApply([{ op: "deleteInteraction", interactionId: interaction.id }], "Remove interaction")}
        />
      ))}

      <p className="border-t border-border/60 pt-2 font-mono text-micro leading-relaxed text-muted-foreground">
        The editor does not play prototypes. Triggers reach the HTML export and the handoff bundle; an animation an
        interaction plays can be watched in the timeline below the canvas.
      </p>
    </div>
  );
}

function InteractionCard({
  interaction,
  document: doc,
  destinations,
  animations,
  readOnly,
  onChange,
  onRemove,
}: {
  interaction: PrototypeInteraction;
  document: DesignDocument;
  destinations: { value: string; label: string }[];
  animations: { value: string; label: string }[];
  readOnly?: boolean;
  onChange: (interaction: PrototypeInteraction, summary: string) => void;
  onRemove: () => void;
}) {
  /**
   * "Open a link" chosen, but no link given yet.
   *
   * Every other action can be filled in from the document — a frame to navigate
   * to, an animation to play — and is committed the moment it is chosen. A link
   * cannot: only the author knows it. Seeding one with a placeholder domain
   * would put a third-party address nobody chose into the document, ship it in
   * the HTML export, and bake that domain into the offline Mac bundle, where
   * the editor's self-containment test correctly refuses it. So the action
   * waits here until the link is real.
   */
  const [awaitingUrl, setAwaitingUrl] = React.useState(false);

  const patch = (partial: Partial<PrototypeInteraction>, summary: string) => onChange({ ...interaction, ...partial }, summary);
  const setTransition = (partial: Partial<Transition>, summary: string) =>
    patch({ transition: { ...interaction.transition, ...partial } }, summary);

  const variables = Object.values(doc.variables);
  const collections = Object.values(doc.collections);
  const instances = Object.values(doc.nodes).filter(
    (node): node is InstanceNode =>
      node.type === "instance" && (doc.components[node.componentId]?.properties ?? []).some((property) => property.type === "variant")
  );

  /** Only the actions this document can actually describe. An action whose form
   *  would have nothing to pick from is worse than a shorter menu. */
  const actionOptions = [
    { value: "navigate", label: "Navigate to" },
    { value: "back", label: "Go back" },
    { value: "open-overlay", label: "Open overlay" },
    { value: "close-overlay", label: "Close overlay" },
    { value: "scroll-to", label: "Scroll to" },
    { value: "open-url", label: "Open a link" },
    ...(animations.length > 0 ? [{ value: "play-animation", label: "Play animation" }] : []),
    ...(variables.length > 0 ? [{ value: "set-variable", label: "Set a variable" }] : []),
    ...(collections.length > 0 ? [{ value: "set-variable-mode", label: "Switch variable mode" }] : []),
    ...(instances.length > 0 ? [{ value: "set-variant", label: "Set a variant" }] : []),
  ];

  return (
    <section className="space-y-2 rounded-field border border-border/60 p-2">
      <div className="flex items-start gap-1.5">
        <div className="min-w-0 flex-1 space-y-2">
          <SmallSelect
            label="Trigger"
            value={interaction.trigger.type}
            disabled={readOnly}
            options={TRIGGER_LABELS}
            onChange={(type) => patch({ trigger: defaultTrigger(type as InteractionTrigger["type"]) }, "Set trigger")}
          />
          {interaction.trigger.type === "key" && (
            <DraftText
              label="Key"
              value={interaction.trigger.key}
              maxLength={40}
              disabled={readOnly}
              validate={(draft) => draft.trim().length > 0}
              onCommit={(key) => patch({ trigger: { type: "key", key } }, "Set trigger key")}
            />
          )}
          {interaction.trigger.type === "delay" && (
            <InlineNumber
              label="Delay"
              value={interaction.trigger.ms}
              min={0}
              max={600_000}
              step={100}
              suffix="ms"
              disabled={readOnly}
              onCommit={(value) => patch({ trigger: { type: "delay", ms: Math.max(0, value) } }, "Set trigger delay")}
            />
          )}
        </div>
        <button
          type="button"
          disabled={readOnly}
          onClick={onRemove}
          aria-label="Remove this interaction"
          className="pressable mt-3 shrink-0 rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
        >
          <X className="size-3" aria-hidden />
        </button>
      </div>

      <SmallSelect
        label="Action"
        value={awaitingUrl ? "open-url" : interaction.action.type}
        disabled={readOnly}
        options={actionOptions}
        onChange={(value) => {
          const type = value as InteractionAction["type"];
          if (type === "open-url") {
            setAwaitingUrl(true);
            return;
          }
          setAwaitingUrl(false);
          patch(
            {
              action: defaultAction(type, {
                destinationId: destinations[0]?.value ?? null,
                animationId: animations[0]?.value ?? null,
                variable: variables[0] ?? null,
                collection: collections[0] ?? null,
                instance: instances[0] ?? null,
              }),
            },
            "Set action"
          );
        }}
      />

      {awaitingUrl ? (
        <div>
          <DraftText
            label="Link"
            value={interaction.action.type === "open-url" ? interaction.action.url : ""}
            placeholder="https://"
            maxLength={2_000}
            disabled={readOnly}
            validate={isHttpUrl}
            onCommit={(url) => {
              setAwaitingUrl(false);
              patch({ action: { type: "open-url", url } }, "Set link");
            }}
          />
          <span className="block pt-0.5 font-mono text-micro text-muted-foreground">
            Nothing is saved until this is a whole http:// or https:// link.
          </span>
        </div>
      ) : (
        <ActionFields
          action={interaction.action}
          document={doc}
          destinations={destinations}
          animations={animations}
          readOnly={readOnly}
          onChange={(action, summary) => patch({ action }, summary)}
        />
      )}

      <div className="space-y-2 border-t border-border/60 pt-2">
        <SmallSelect
          label="Transition"
          value={interaction.transition.kind}
          disabled={readOnly}
          options={[
            { value: "instant", label: "Instant" },
            { value: "dissolve", label: "Dissolve" },
            { value: "slide", label: "Slide" },
            { value: "push", label: "Push" },
            { value: "move", label: "Move" },
          ]}
          onChange={(kind) => setTransition({ kind: kind as Transition["kind"] }, "Set transition")}
        />
        {(interaction.transition.kind === "slide" || interaction.transition.kind === "push" || interaction.transition.kind === "move") && (
          <SmallSelect
            label="Direction"
            value={interaction.transition.direction ?? "left"}
            disabled={readOnly}
            options={[
              { value: "left", label: "Left" },
              { value: "right", label: "Right" },
              { value: "up", label: "Up" },
              { value: "down", label: "Down" },
            ]}
            onChange={(direction) => setTransition({ direction: direction as Transition["direction"] }, "Set transition direction")}
          />
        )}
        {interaction.transition.kind !== "instant" && (
          <>
            <div className="flex gap-1.5">
              <InlineNumber
                label="Duration"
                value={interaction.transition.durationMs}
                min={0}
                max={60_000}
                step={20}
                suffix="ms"
                disabled={readOnly}
                onCommit={(value) => setTransition({ durationMs: Math.max(0, value) }, "Set transition duration")}
              />
              <InlineNumber
                label="Delay"
                value={interaction.transition.delayMs}
                min={0}
                max={60_000}
                step={20}
                suffix="ms"
                disabled={readOnly}
                onCommit={(value) => setTransition({ delayMs: Math.max(0, value) }, "Set transition delay")}
              />
            </div>
            <EasingEditor
              label="Easing"
              easing={interaction.transition.easing}
              disabled={readOnly}
              onChange={(easing) => setTransition({ easing }, "Set transition easing")}
            />
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={interaction.transition.matchStableIds}
                disabled={readOnly}
                onChange={(event) => setTransition({ matchStableIds: event.target.checked }, "Set layer matching")}
              />
              Match layers by id
            </label>
          </>
        )}
      </div>
    </section>
  );
}

function ActionFields({
  action,
  document: doc,
  destinations,
  animations,
  readOnly,
  onChange,
}: {
  action: InteractionAction;
  document: DesignDocument;
  destinations: { value: string; label: string }[];
  animations: { value: string; label: string }[];
  readOnly?: boolean;
  onChange: (action: InteractionAction, summary: string) => void;
}) {
  switch (action.type) {
    case "navigate":
    case "open-overlay":
    case "scroll-to":
      return (
        <SmallSelect
          label="Destination"
          value={action.targetNodeId}
          disabled={readOnly}
          options={destinations}
          onChange={(targetNodeId) => onChange({ ...action, targetNodeId }, "Set destination")}
        />
      );

    case "open-url":
      return (
        <div>
          {/* Committed on blur and only when it parses. The operation layer
              validates the URL, so writing on every keystroke would raise a
              refusal toast for "h", "ht", "htt" — the schema refuses anything
              but http(s) on purpose, because a prototype link is user content
              and whatever opens the export would run a `javascript:` one. */}
          <DraftText
            label="Link"
            value={action.url}
            placeholder="https://"
            maxLength={2_000}
            disabled={readOnly}
            validate={isHttpUrl}
            onCommit={(url) => onChange({ type: "open-url", url }, "Set link")}
          />
          <span className="block pt-0.5 font-mono text-micro text-muted-foreground">http:// or https:// only</span>
        </div>
      );

    case "play-animation":
      return (
        <div className="space-y-1.5">
          <SmallSelect
            label="Animation"
            value={action.animationId}
            disabled={readOnly}
            options={animations}
            onChange={(animationId) => onChange({ ...action, animationId }, "Set animation")}
          />
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={action.reverse}
              disabled={readOnly}
              onChange={(event) => onChange({ ...action, reverse: event.target.checked }, "Set playback direction")}
            />
            Play in reverse
          </label>
        </div>
      );

    case "set-variable": {
      const variable = doc.variables[action.variableId];
      return (
        <div className="space-y-1.5">
          <SmallSelect
            label="Variable"
            value={action.variableId}
            disabled={readOnly}
            options={Object.values(doc.variables).map((entry) => ({ value: entry.id, label: entry.name }))}
            onChange={(variableId) => {
              const next = doc.variables[variableId];
              // The value has to change type with the variable, or the action
              // would carry a colour for a number and be refused on save.
              onChange({ type: "set-variable", variableId, value: next ? blankValue(next.type) : action.value }, "Set variable");
            }}
          />
          {variable && (
            <VariableValueField
              value={action.value}
              variables={Object.values(doc.variables)}
              readOnly={readOnly}
              onChange={(value) => onChange({ ...action, value }, "Set variable value")}
            />
          )}
        </div>
      );
    }

    case "set-variable-mode": {
      const collection = doc.collections[action.collectionId];
      return (
        <div className="space-y-1.5">
          <SmallSelect
            label="Collection"
            value={action.collectionId}
            disabled={readOnly}
            options={Object.values(doc.collections).map((entry) => ({ value: entry.id, label: entry.name }))}
            onChange={(collectionId) =>
              onChange(
                { type: "set-variable-mode", collectionId, modeId: doc.collections[collectionId]?.modes[0]?.id ?? action.modeId },
                "Set collection"
              )
            }
          />
          {collection && (
            <SmallSelect
              label="Mode"
              value={action.modeId}
              disabled={readOnly}
              options={collection.modes.map((mode) => ({ value: mode.id, label: mode.name }))}
              onChange={(modeId) => onChange({ ...action, modeId }, "Set mode")}
            />
          )}
        </div>
      );
    }

    case "set-variant": {
      const instance = doc.nodes[action.instanceNodeId];
      const component = instance && instance.type === "instance" ? doc.components[instance.componentId] : null;
      const variantProperties = (component?.properties ?? []).filter((property) => property.type === "variant");
      return (
        <div className="space-y-1.5">
          <SmallSelect
            label="Instance"
            value={action.instanceNodeId}
            disabled={readOnly}
            options={Object.values(doc.nodes)
              .filter((candidate) => candidate.type === "instance")
              .map((candidate) => ({ value: candidate.id, label: candidate.name }))}
            onChange={(instanceNodeId) => onChange({ type: "set-variant", instanceNodeId, variantProperties: {} }, "Set instance")}
          />
          {variantProperties.map((property) => (
            <SmallSelect
              key={property.name}
              label={property.name}
              value={action.variantProperties[property.name] ?? String(property.defaultValue)}
              disabled={readOnly}
              options={(property.options ?? [String(property.defaultValue)]).map((option) => ({ value: option, label: option }))}
              onChange={(value) =>
                onChange({ ...action, variantProperties: { ...action.variantProperties, [property.name]: value } }, "Set variant")
              }
            />
          ))}
        </div>
      );
    }

    default:
      // `back` and `close-overlay` name nothing and need no form.
      return null;
  }
}

function VariableValueField({
  value,
  variables,
  readOnly,
  onChange,
}: {
  value: VariableValue;
  variables: DesignVariable[];
  readOnly?: boolean;
  onChange: (value: VariableValue) => void;
}) {
  switch (value.kind) {
    case "color":
      return (
        <label className="block">
          <span className="block pb-0.5 font-mono text-micro text-muted-foreground">Value</span>
          <input
            type="color"
            aria-label="Variable colour"
            value={rgbaToHex(value.value).slice(0, 7)}
            disabled={readOnly}
            onChange={(event) => {
              const color = hexToRgba(event.target.value);
              if (color) onChange({ kind: "color", value: color });
            }}
            className="size-6 cursor-pointer rounded-xs border border-border/60 bg-transparent p-0.5 disabled:opacity-50"
          />
        </label>
      );
    case "number":
      return <InlineNumber label="Value" value={value.value} disabled={readOnly} onCommit={(next) => onChange({ kind: "number", value: next })} />;
    case "boolean":
      return (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={value.value}
            disabled={readOnly}
            onChange={(event) => onChange({ kind: "boolean", value: event.target.checked })}
          />
          On
        </label>
      );
    case "alias":
      // An alias holds a variable id, not text. A free-text field here would let
      // someone type an id that does not exist and store a dangling reference.
      return (
        <SmallSelect
          label="Value"
          value={value.value}
          disabled={readOnly}
          options={variables.map((entry) => ({ value: entry.id, label: entry.name }))}
          onChange={(next) => onChange({ kind: "alias", value: next })}
        />
      );
    default:
      return (
        <DraftText
          label="Value"
          value={value.value}
          maxLength={500}
          disabled={readOnly}
          onCommit={(next) => onChange({ kind: "string", value: next })}
        />
      );
  }
}

/**
 * A text field that commits on blur rather than on every keystroke.
 *
 * Everything in this panel writes a validated operation, so a field that wrote
 * as you typed would send `h`, `ht`, `htt` at a schema that refuses all three
 * and raise a toast for each. `validate` decides whether the draft is worth
 * committing; a draft that never becomes valid is simply discarded.
 */
function DraftText({
  label,
  value,
  placeholder,
  maxLength,
  disabled,
  validate,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder?: string;
  maxLength: number;
  disabled?: boolean;
  validate?: (draft: string) => boolean;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = React.useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft !== value && (!validate || validate(draft))) onCommit(draft.slice(0, maxLength));
    setDraft(null);
  };
  return (
    <label className="block">
      <span className="block pb-0.5 font-mono text-micro text-muted-foreground">{label}</span>
      <input
        type="text"
        className={cn(fieldClass, "h-6 py-0")}
        value={draft ?? value}
        placeholder={placeholder}
        maxLength={maxLength}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") (event.target as HTMLInputElement).blur();
          if (event.key === "Escape") {
            setDraft(null);
            (event.target as HTMLInputElement).blur();
          }
          event.stopPropagation();
        }}
      />
    </label>
  );
}

/** The same test the schema applies, so the field refuses what the operation
 *  would refuse instead of finding out after the toast. */
function isHttpUrl(candidate: string): boolean {
  try {
    return /^https?:$/i.test(new URL(candidate).protocol);
  } catch {
    return false;
  }
}

function blankValue(type: "color" | "number" | "string" | "boolean"): VariableValue {
  switch (type) {
    case "color":
      return { kind: "color", value: { r: 0, g: 0, b: 0, a: 1 } };
    case "number":
      return { kind: "number", value: 0 };
    case "boolean":
      return { kind: "boolean", value: false };
    default:
      return { kind: "string", value: "" };
  }
}

function defaultTrigger(type: InteractionTrigger["type"]): InteractionTrigger {
  if (type === "key") return { type: "key", key: "Enter" };
  if (type === "delay") return { type: "delay", ms: 1000 };
  return { type } as InteractionTrigger;
}

/**
 * A newly chosen action, filled in with something the document can actually
 * name. Every branch that cannot be filled in falls back to `back` rather than
 * writing an id that points at nothing: a dangling action would pass the schema
 * (it only checks shape) and fail in whatever played the prototype.
 */
function defaultAction(
  type: InteractionAction["type"],
  context: {
    destinationId: NodeId | null;
    animationId: string | null;
    variable: DesignVariable | null;
    collection: { id: string; modes: { id: string }[] } | null;
    instance: InstanceNode | null;
  }
): InteractionAction {
  switch (type) {
    case "navigate":
    case "open-overlay":
    case "scroll-to":
      return context.destinationId ? { type, targetNodeId: context.destinationId } : { type: "back" };
    // `open-url` is deliberately absent: only the author knows the link, so the
    // card holds the choice until one is typed rather than inventing a domain.
    case "play-animation":
      return context.animationId ? { type: "play-animation", animationId: context.animationId, reverse: false } : { type: "back" };
    case "set-variable":
      return context.variable
        ? { type: "set-variable", variableId: context.variable.id, value: blankValue(context.variable.type) }
        : { type: "back" };
    case "set-variable-mode": {
      const modeId = context.collection?.modes[0]?.id;
      return context.collection && modeId ? { type: "set-variable-mode", collectionId: context.collection.id, modeId } : { type: "back" };
    }
    case "set-variant":
      return context.instance ? { type: "set-variant", instanceNodeId: context.instance.id, variantProperties: {} } : { type: "back" };
    case "close-overlay":
      return { type: "close-overlay" };
    default:
      return { type: "back" };
  }
}
