"use client";

import * as React from "react";
import { AgentFace } from "@/components/agents/agent-face";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { IconButton } from "@/components/ui/icon-button";
import {
  CheckCircle2,
  Folder,
  FolderInput,
  Pencil,
  Pin,
  Plus,
  Settings2,
  Share2,
  Trash2,
  X,
} from "@/components/ui/icons";
import { menuGlyphInkClass, menuRowClass, menuSeparatorClass } from "@/components/ui/menu-recipe";
import { Pressable } from "@/components/ui/pressable";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { ContextToken } from "./composer";
import { MIRA, PRESENCE, PRESENCE_ORDER } from "./fixtures";
import { SignatureGlyph } from "./glyphs";
import { Suggestions } from "./scenes";
import { ROW, rowState } from "./shell";
import { DIRECTIONS, contrast, type ColorToken, type DirectionId } from "./tokens";

/*
 * The component sheet: every primitive the scenes use, in every state, in
 * this direction's tokens. Real components throughout; forced hover and
 * pressed states are the variant's own hover/active styles applied as a
 * class or `data-force` (directions.css), so a static screenshot shows them.
 */

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-border py-10">
      <h2 className="text-heading text-foreground">{title}</h2>
      {note && <p className="mt-1 max-w-prose text-ui text-muted-foreground">{note}</p>}
      <div className="mt-6">{children}</div>
    </section>
  );
}

function Caption({ children }: { children: React.ReactNode }) {
  return <p className="mb-2 text-caption text-muted-foreground">{children}</p>;
}

/* ———————————————————————————————— Colour ———————————————————————————————— */

const SWATCHES: { group: string; tokens: ColorToken[] }[] = [
  {
    group: "Grounds and fills",
    tokens: ["background", "card", "popover", "secondary", "accent", "selected", "sidebar", "sidebar-hover", "sidebar-selected"],
  },
  { group: "Edges", tokens: ["border", "input", "ring"] },
  {
    group: "Inks",
    tokens: ["foreground", "muted-foreground", "sidebar-foreground", "primary-ink", "warning-foreground", "destructive-ink", "success-ink"],
  },
  { group: "Actions and identity", tokens: ["primary", "brand", "destructive", "success"] },
  { group: "Crew tones", tokens: ["agent-coral", "agent-juniper", "agent-teal", "agent-violet", "agent-amber", "agent-sage"] },
];

const PAIRS: { ink: ColorToken; ground: ColorToken; min: number; note?: string }[] = [
  { ink: "foreground", ground: "background", min: 4.5 },
  { ink: "foreground", ground: "card", min: 4.5 },
  { ink: "foreground", ground: "selected", min: 4.5 },
  { ink: "muted-foreground", ground: "background", min: 4.5 },
  { ink: "muted-foreground", ground: "card", min: 4.5 },
  { ink: "muted-foreground", ground: "secondary", min: 4.5 },
  { ink: "muted-foreground", ground: "selected", min: 4.5 },
  { ink: "muted-foreground", ground: "sidebar", min: 4.5 },
  { ink: "sidebar-foreground", ground: "sidebar-selected", min: 4.5 },
  { ink: "primary-ink", ground: "background", min: 4.5 },
  { ink: "primary-ink", ground: "secondary", min: 4.5 },
  { ink: "primary-foreground", ground: "primary", min: 4.5 },
  { ink: "warning-foreground", ground: "background", min: 4.5, note: "signal" },
  { ink: "warning-foreground", ground: "card", min: 4.5, note: "signal" },
  { ink: "warning-foreground", ground: "sidebar-selected", min: 4.5, note: "signal" },
  { ink: "destructive-ink", ground: "card", min: 4.5 },
  { ink: "destructive-foreground", ground: "destructive", min: 4.5 },
  { ink: "success-ink", ground: "card", min: 4.5 },
  { ink: "ring", ground: "background", min: 3, note: "focus" },
  { ink: "ring", ground: "card", min: 3, note: "focus" },
  { ink: "brand", ground: "sidebar", min: 3, note: "mark" },
  { ink: "input", ground: "background", min: 3, note: "field edge" },
  { ink: "input", ground: "card", min: 3, note: "field edge" },
];

function Ratio({ value, min }: { value: number; min: number }) {
  const pass = value >= min;
  return (
    <span className={cn("font-mono tabular-nums", pass ? "text-foreground" : "text-destructive")}>
      {value.toFixed(2)}
      <span className={cn("ml-1.5 font-sans text-caption", pass ? "text-muted-foreground" : "text-destructive")}>{pass ? "pass" : "below"}</span>
    </span>
  );
}

function ColourSection({ direction }: { direction: DirectionId }) {
  const spec = DIRECTIONS[direction];
  return (
    <Section
      title="Colour"
      note="Swatches paint the live token; each lists its light and dark value. Ratios are WCAG 2, computed from the same table the stylesheet is generated from."
    >
      <div className="space-y-6">
        {SWATCHES.map(({ group, tokens }) => (
          <div key={group}>
            <Caption>{group}</Caption>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {tokens.map((token) => (
                <div key={token} className="min-w-0">
                  <div className="h-12 rounded-control border border-border" style={{ backgroundColor: `hsl(var(--${token}))` }} />
                  <p className="mt-1.5 truncate font-mono text-micro text-foreground">{token}</p>
                  <p className="font-mono text-micro text-muted-foreground">
                    {spec.palette.light[token]} / {spec.palette.dark[token]}
                  </p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-8 overflow-x-auto">
        <table className="w-full min-w-[34rem] text-left text-ui">
          <caption className="sr-only">Contrast of text and interface pairs</caption>
          <thead>
            <tr className="border-b border-border text-caption text-muted-foreground">
              <th className="py-2 pr-4 font-medium">Ink on ground</th>
              <th className="py-2 pr-4 font-medium">Specimen</th>
              <th className="py-2 pr-4 font-medium">Needs</th>
              <th className="py-2 pr-4 font-medium">Light</th>
              <th className="py-2 font-medium">Dark</th>
            </tr>
          </thead>
          <tbody>
            {PAIRS.map((pair) => (
              <tr key={`${pair.ink}-${pair.ground}`} className="border-b border-border/60 last:border-b-0">
                <td className="py-2 pr-4 font-mono text-micro text-foreground">
                  {pair.ink} / {pair.ground}
                  {pair.note && <span className="ml-1.5 font-sans text-caption text-muted-foreground">{pair.note}</span>}
                </td>
                <td className="py-2 pr-4">
                  <span
                    className="inline-flex h-7 items-center whitespace-nowrap rounded-xs border border-border px-2 text-ui font-medium"
                    style={{ backgroundColor: `hsl(var(--${pair.ground}))`, color: `hsl(var(--${pair.ink}))` }}
                  >
                    {pair.min === 3 ? "Edge" : "Aa text"}
                  </span>
                </td>
                <td className="py-2 pr-4 font-mono tabular-nums text-muted-foreground">{pair.min.toFixed(1)}</td>
                <td className="py-2 pr-4">
                  <Ratio value={contrast(spec.palette.light[pair.ink], spec.palette.light[pair.ground])} min={pair.min} />
                </td>
                <td className="py-2">
                  <Ratio value={contrast(spec.palette.dark[pair.ink], spec.palette.dark[pair.ground])} min={pair.min} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {spec.adjustments.length > 0 && (
        <div className="mt-4 space-y-1 text-ui text-muted-foreground">
          {spec.adjustments.map((a) => (
            <p key={a}>Adjusted: {a}</p>
          ))}
          <p>The field edge (--input) is the brief&apos;s value and stays under 3:1; a field is found by its label, its placeholder and the focus ring.</p>
        </div>
      )}
    </Section>
  );
}

/* ———————————————————————————————— Type and shape ———————————————————————————————— */

const RAMP: { rung: string; cls: string; text: string; spec: string }[] = [
  { rung: "page-title", cls: "text-page-title", text: "Good afternoon, Liam", spec: "26 to 32, 600, display" },
  { rung: "title", cls: "text-title", text: "Renewal risk this quarter", spec: "22, 600, display" },
  { rung: "heading", cls: "text-heading", text: "Mira needs you", spec: "18, 600" },
  { rung: "reading", cls: "text-reading", text: "Stripe shows €412,000 of the €438,000 the forecast expects.", spec: "16 on 1.7" },
  { rung: "body", cls: "text-body", text: "Halvorsen moved to monthly billing in August.", spec: "15 on 1.6" },
  { rung: "nav", cls: "text-nav", text: "Atlas launch plan", spec: "14 on 20" },
  { rung: "ui", cls: "text-ui", text: "Matching Stripe customers to accounts", spec: "13" },
  { rung: "label", cls: "text-label font-medium", text: "Needs you", spec: "12, 500" },
  { rung: "caption", cls: "text-caption", text: "Edited today", spec: "11" },
  { rung: "mono", cls: "font-mono text-micro", text: "stripe-subscriptions-september.csv", spec: "10.5 mono" },
];

function TypeSection({ direction }: { direction: DirectionId }) {
  const spec = DIRECTIONS[direction];
  return (
    <Section title="Type" note={`${spec.type.sans} for the interface and display (${spec.type.display}), ${spec.type.mono} for code and ids. No serif anywhere.`}>
      <div className="divide-y divide-border/60">
        {RAMP.map((r) => (
          <div key={r.rung} className="grid grid-cols-1 items-baseline gap-1 py-3 sm:grid-cols-[8rem_minmax(0,1fr)_10rem] sm:gap-4">
            <span className="font-mono text-micro text-muted-foreground">{r.rung}</span>
            <span className={cn(r.cls, "min-w-0 truncate text-foreground")}>{r.text}</span>
            <span className="text-caption text-muted-foreground sm:text-right">{r.spec}</span>
          </div>
        ))}
        <div className="grid grid-cols-1 items-baseline gap-1 py-3 sm:grid-cols-[8rem_minmax(0,1fr)_10rem] sm:gap-4">
          <span className="font-mono text-micro text-muted-foreground">coverage</span>
          <span className="text-body text-foreground">Renewal risk. Риск продления. Rủi ro gia hạn.</span>
          <span className="text-caption text-muted-foreground sm:text-right">Latin, Cyrillic, Vietnamese</span>
        </div>
      </div>
    </Section>
  );
}

function ShapeSection({ direction }: { direction: DirectionId }) {
  const r = DIRECTIONS[direction].radii;
  const rungs: { name: string; px: number; cls: string }[] = [
    { name: "token", px: r.token, cls: "rounded-xs" },
    { name: "control", px: r.control, cls: "rounded-control" },
    { name: "field", px: r.field, cls: "rounded-field" },
    { name: "menu", px: r.menu, cls: "rounded-menu" },
    { name: "card", px: r.card, cls: "rounded-card" },
    { name: "panel", px: r.panel, cls: "rounded-panel" },
    { name: "composer", px: r.composer, cls: "rounded-composer" },
  ];
  return (
    <Section
      title="Shape"
      note={`One ladder, nested concentrically: a box inside another takes the outer radius minus the padding between them. Menu ${r.menu} with 4 of padding holds ${r.menu - 4} (control); composer ${r.composer} holds its controls at ${r.composerControl}.`}
    >
      <div className="grid grid-cols-3 gap-4 sm:grid-cols-7">
        {rungs.map((rung) => (
          <div key={rung.name}>
            <div className={cn("h-16 border border-input bg-card", rung.cls)} />
            <p className="mt-2 text-ui text-foreground">{rung.name}</p>
            <p className="font-mono text-micro text-muted-foreground">{rung.px}px</p>
          </div>
        ))}
      </div>
    </Section>
  );
}

/* ———————————————————————————————— Controls ———————————————————————————————— */

const STATES = ["Rest", "Hover", "Pressed", "Focus", "Disabled"] as const;
type ForcedState = (typeof STATES)[number];

function forced(variant: "default" | "secondary" | "ghost" | "destructive", state: ForcedState) {
  const props: { className?: string; disabled?: boolean; "data-force"?: string } = {};
  if (state === "Disabled") props.disabled = true;
  if (state === "Focus") props["data-force"] = "focus";
  if (state === "Hover" || state === "Pressed") {
    if (variant === "default" || variant === "secondary") props["data-force"] = state.toLowerCase();
    if (variant === "ghost") props.className = state === "Hover" ? "bg-accent text-foreground" : "bg-selected text-foreground";
    if (variant === "destructive") props.className = state === "Hover" ? "brightness-[1.06]" : "brightness-[.94] scale-[0.98]";
  }
  return props;
}

const VARIANTS: { variant: "default" | "secondary" | "ghost" | "destructive"; name: string; label: string }[] = [
  { variant: "default", name: "Primary", label: "Allow once" },
  { variant: "secondary", name: "Secondary", label: "Add to crew" },
  { variant: "ghost", name: "Ghost", label: "Cancel" },
  { variant: "destructive", name: "Destructive", label: "Remove" },
];

function ButtonsSection() {
  return (
    <Section title="Buttons" note="Hover is a tonal step; pressed is one step further. Only the primary dips, to 0.98. Focus is a 2px ring in the brand, offset 2px.">
      <div className="-m-1 overflow-x-auto p-1">
        <div className="grid min-w-[40rem] grid-cols-[6rem_repeat(5,minmax(0,1fr))] items-center gap-x-3 gap-y-4">
          <span />
          {STATES.map((s) => (
            <span key={s} className="text-caption text-muted-foreground">
              {s}
            </span>
          ))}
          {VARIANTS.map(({ variant, name, label }) => (
            <React.Fragment key={variant}>
              <span className="text-ui text-muted-foreground">{name}</span>
              {STATES.map((s) => {
                const { className, ...rest } = forced(variant, s);
                return (
                  <div key={s}>
                    <Button type="button" variant={variant} className={className} {...rest}>
                      {label}
                    </Button>
                  </div>
                );
              })}
            </React.Fragment>
          ))}
        </div>
      </div>

      <div className="mt-8 grid gap-6 sm:grid-cols-2">
        <div>
          <Caption>Sizes: small, default, large</Caption>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm">Allow once</Button>
            <Button>Allow once</Button>
            <Button size="lg">Allow once</Button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button size="sm" variant="secondary">Add to crew</Button>
            <Button variant="secondary">Add to crew</Button>
            <Button size="lg" variant="secondary">Add to crew</Button>
          </div>
        </div>
        <div>
          <Caption>Icon buttons: default, ghost, primary; small and medium</Caption>
          <div className="flex flex-wrap items-center gap-3">
            <IconButton label="Setup" size="sm"><Settings2 className="size-4" aria-hidden="true" /></IconButton>
            <IconButton label="Setup"><Settings2 className="size-4" aria-hidden="true" /></IconButton>
            <IconButton label="Share" variant="ghost" size="sm"><Share2 className="size-4" aria-hidden="true" /></IconButton>
            <IconButton label="Share" variant="ghost"><Share2 className="size-4" aria-hidden="true" /></IconButton>
            <IconButton label="New" variant="primary" size="sm"><Plus className="size-4" aria-hidden="true" /></IconButton>
            <IconButton label="New" variant="primary"><Plus className="size-4" aria-hidden="true" /></IconButton>
            <IconButton label="Pinned" variant="ghost" aria-pressed="true"><Pin className="size-4" aria-hidden="true" /></IconButton>
            <IconButton label="Setup" disabled><Settings2 className="size-4" aria-hidden="true" /></IconButton>
          </div>
        </div>
      </div>
    </Section>
  );
}

function FieldsSection() {
  const [web, setWeb] = React.useState(true);
  const [memory, setMemory] = React.useState(false);
  const [effort, setEffort] = React.useState<"light" | "standard" | "deep">("standard");
  return (
    <Section title="Fields and toggles">
      <div className="grid gap-8 md:grid-cols-3">
        <Field id="dir-name" label="Name" hint="Shown in chats and notifications." defaultValue="Mira" />
        <Field id="dir-focus" label="Role" hint="One line. Focus shown." defaultValue="Accounts" data-force="focus" />
        <Field
          id="dir-error"
          label="Slack channel"
          defaultValue="design-team"
          error="There is no channel called #design-team. Check the name in Slack."
        />
      </div>
      <div className="mt-8 grid gap-8 md:grid-cols-3">
        <div>
          <Caption>Switch</Caption>
          <div className="space-y-3">
            <label className="flex items-center justify-between gap-4 text-body text-foreground">
              Web search <Switch checked={web} onCheckedChange={setWeb} />
            </label>
            <label className="flex items-center justify-between gap-4 text-body text-foreground">
              Memory <Switch checked={memory} onCheckedChange={setMemory} />
            </label>
            <label className="flex items-center justify-between gap-4 text-body text-muted-foreground">
              Computer use <Switch checked={false} disabled />
            </label>
          </div>
        </div>
        <div>
          <Caption>Segmented control</Caption>
          <SegmentedControl
            ariaLabel="Effort"
            value={effort}
            onChange={setEffort}
            options={[
              { value: "light", label: "Light" },
              { value: "standard", label: "Standard" },
              { value: "deep", label: "Deep" },
            ]}
          />
        </div>
        <div>
          <Caption>Tabs</Caption>
          <Tabs defaultValue="activity">
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
              <TabsTrigger value="setup">Setup</TabsTrigger>
            </TabsList>
            <TabsContent value="activity" className="mt-3 text-ui text-muted-foreground">
              Mira checked 3 accounts today.
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </Section>
  );
}

function NavigationSection() {
  return (
    <Section title="Sidebar rows, suggestions and context tokens">
      <div className="grid gap-8 md:grid-cols-2">
        <div>
          <Caption>Rest, hover, selected</Caption>
          <div className="app-sidebar-frame dir-sidebar max-w-full rounded-card p-2">
            <div className={cn(ROW, rowState(false))}>
              <span className="min-w-0 flex-1 truncate">Pricing page copy, second pass</span>
            </div>
            <div className={cn(ROW, "bg-sidebar-hover text-foreground")}>
              <span className="min-w-0 flex-1 truncate">Lisbon offsite venues under €4k</span>
            </div>
            <div className={cn(ROW, rowState(true))}>
              <span className="min-w-0 flex-1 truncate">Q3 forecast against Stripe revenue</span>
            </div>
          </div>
        </div>
        <div>
          <Caption>Suggestions: rows rather than chips, so each can say who and when. At most three, from the account&apos;s own state.</Caption>
          <Suggestions className="-mx-4" />
        </div>
      </div>

      <div className="mt-8">
        <Caption>Context tokens: file, app, crew member, project, skill</Caption>
        <p className="text-reading text-foreground">
          <ContextToken kind="file" name="Q3 Forecast.xlsx" /> <ContextToken kind="app" name="Stripe" /> <ContextToken kind="crew" name="Mira" />{" "}
          <ContextToken kind="project" name="Atlas launch" /> <ContextToken kind="skill" name="Renewal review" />
        </p>
        <Caption>
          <span className="mt-4 block">Normal, selected, needs connection</span>
        </Caption>
        <p className="text-reading text-foreground">
          Post it with <ContextToken kind="app" name="Slack" /> and file it in <ContextToken kind="app" name="Linear" state="needs-connection" /> for{" "}
          <ContextToken kind="crew" name="Scout" state="selected" />
        </p>
      </div>
    </Section>
  );
}

function LayersSection() {
  return (
    <Section title="Layers" note="The only surfaces with a shadow: they leave the page. Menus arrive in 120ms with a 3px travel and no scale.">
      <div className="grid items-start gap-8 lg:grid-cols-[14rem_minmax(0,1.3fr)_minmax(0,1fr)]">
        <div>
          <Caption>Menu</Caption>
          <div role="menu" aria-label="Chat" className="surface-float w-56 rounded-menu p-1">
            <div role="menuitem" className={cn(menuRowClass, menuGlyphInkClass, "hover:bg-accent")}>
              <Pencil className="size-4" aria-hidden="true" />
              Rename
            </div>
            <div role="menuitem" className={cn(menuRowClass, menuGlyphInkClass, "hover:bg-accent")}>
              <Pin className="size-4" aria-hidden="true" />
              Pin
            </div>
            <div role="menuitem" data-highlighted="" className={cn(menuRowClass, menuGlyphInkClass, "bg-accent text-accent-foreground")}>
              <FolderInput className="size-4" aria-hidden="true" />
              Move to project
            </div>
            <div className={menuSeparatorClass} />
            <div role="menuitem" className={cn(menuRowClass, "text-destructive hover:bg-destructive/10")}>
              <Trash2 className="size-4" aria-hidden="true" />
              Delete
            </div>
          </div>
        </div>
        <div>
          <Caption>Dialog</Caption>
          <div role="dialog" aria-labelledby="dir-dialog-title" className="surface-float relative w-full max-w-md rounded-panel p-5 sm:p-6">
            <Pressable kind="icon" size="lg" className="absolute right-4 top-4" aria-label="Close">
              <X className="size-4" aria-hidden="true" />
            </Pressable>
            <h3 id="dir-dialog-title" className="pr-10 text-heading text-foreground">
              Remove Ines from your crew?
            </h3>
            <p className="mt-1.5 text-body text-muted-foreground">Her chats and finished work stay in your history. Routines she owns stop.</p>
            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="secondary">Cancel</Button>
              <Button variant="destructive">Remove Ines</Button>
            </div>
          </div>
        </div>
        <div>
          <Caption>Toast</Caption>
          <div role="status" className="surface-float flex w-full max-w-sm items-center gap-3 rounded-card py-3 pl-4 pr-3 text-ui">
            <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden="true" />
            <span className="min-w-0 flex-1 text-foreground">Summary posted to #design</span>
            <Button variant="ghost" size="sm">
              View
            </Button>
          </div>
        </div>
      </div>
    </Section>
  );
}

function StatesSection() {
  return (
    <Section title="Empty and loading">
      <div className="grid gap-8 md:grid-cols-2">
        <EmptyState
          size="panel"
          icon={Folder}
          title="No projects yet"
          description="A project keeps chats, files and instructions together. Start one from any chat."
          action={<Button variant="secondary">New project</Button>}
        />
        <div aria-busy="true" aria-label="Loading" className="space-y-3 rounded-card border border-border p-4">
          <div className="flex items-center gap-3">
            <Skeleton className="size-8 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3 w-1/3" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          </div>
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-5/6" />
          <Skeleton className="h-3 w-3/5" />
        </div>
      </div>
    </Section>
  );
}

function SignatureSection({ direction }: { direction: DirectionId }) {
  const spec = DIRECTIONS[direction];
  return (
    <Section title={`Signature: ${spec.signature.name}`} note={`${spec.signature.mark} ${spec.signature.thinking} Under reduced motion it holds one frame and the words carry the state.`}>
      <div className="grid gap-8 sm:grid-cols-3">
        <div>
          <Caption>Idle</Caption>
          <div className={cn("flex items-end gap-6", direction === "graphite" ? "text-foreground" : "dir-text-brand")}>
            <SignatureGlyph direction={direction} size={16} />
            <SignatureGlyph direction={direction} size={24} />
            <SignatureGlyph direction={direction} size={56} label={`${spec.signature.name} mark`} />
          </div>
        </div>
        <div>
          <Caption>Thinking</Caption>
          <div className="flex items-end gap-6 dir-text-brand">
            <SignatureGlyph direction={direction} state="thinking" size={16} />
            <SignatureGlyph direction={direction} state="thinking" size={56} label="Thinking" />
          </div>
        </div>
        <div>
          <Caption>Reduced motion</Caption>
          <div className="dir-glyph-static flex items-end gap-4">
            <SignatureGlyph direction={direction} state="thinking" size={56} className="dir-text-brand" />
            <span className="pb-4 text-body text-muted-foreground">Thinking</span>
          </div>
        </div>
      </div>

      <div className="mt-8">
        <Caption>Presence, in the face and in words</Caption>
        <ul className="grid grid-cols-3 gap-4 sm:grid-cols-6">
          {PRESENCE_ORDER.map((p) => (
            <li key={p} className="flex items-center gap-2">
              <span className={cn("flex size-7 items-center justify-center", p === "offline" && "dir-face-offline")}>
                <AgentFace avatar={MIRA.avatar} state={PRESENCE[p].face} size={24} live={false} />
              </span>
              <span className={cn("text-ui", p === "waiting" ? "text-warning" : "text-foreground")}>{PRESENCE[p].label}</span>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}

export function SystemScene({ direction }: { direction: DirectionId }) {
  const spec = DIRECTIONS[direction];
  const r = spec.radii;
  return (
    <main className="app-main-canvas page-gutter min-h-dvh py-10 md:py-14">
      <div className="mx-auto w-full max-w-5xl">
        <header className="pb-10">
          <p className={cn("flex items-center gap-2.5", direction === "graphite" ? "text-foreground" : "dir-text-brand")}>
            <SignatureGlyph direction={direction} size={24} />
            <span className="text-label font-medium text-muted-foreground">Direction</span>
          </p>
          <h1 className="mt-3 text-page-title text-foreground">{spec.name}</h1>
          <p className="mt-2 max-w-prose text-body-lg text-muted-foreground">{spec.line}</p>
          <dl className="mt-6 grid gap-x-8 gap-y-3 text-ui sm:grid-cols-3">
            <div>
              <dt className="text-caption text-muted-foreground">Faces</dt>
              <dd className="text-foreground">
                {spec.type.sans}, {spec.type.mono}
              </dd>
            </div>
            <div>
              <dt className="text-caption text-muted-foreground">Radius ladder</dt>
              <dd className="font-mono text-micro text-foreground">
                {[r.control, r.field, r.menu, r.card, r.panel, r.composer].join(", ")}
              </dd>
            </div>
            <div>
              <dt className="text-caption text-muted-foreground">Reading column</dt>
              <dd className="text-foreground">
                {spec.measure.column}px, {spec.measure.turnGap}px between turns
              </dd>
            </div>
          </dl>
        </header>
        <ColourSection direction={direction} />
        <TypeSection direction={direction} />
        <ShapeSection direction={direction} />
        <ButtonsSection />
        <FieldsSection />
        <NavigationSection />
        <LayersSection />
        <StatesSection />
        <SignatureSection direction={direction} />
      </div>
    </main>
  );
}
