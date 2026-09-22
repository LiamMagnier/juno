"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Archive,
  ArrowRight,
  Check,
  ChevronRight,
  Copy,
  Download,
  LayoutGrid,
  List as ListIcon,
  Pencil,
  Pin,
  Plug,
  Plus,
  RefreshCw,
  RotateCcw,
  Scan,
  Search,
  Settings,
  Star,
  Trash2,
  type IconComponent,
} from "@/components/ui/icons";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapse } from "@/components/ui/collapse";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { IconSwap } from "@/components/ui/icon-swap";
import { Input } from "@/components/ui/input";
import { Pressable } from "@/components/ui/pressable";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { ActionIcons, AppIcons, ComposerIcons, StatusIcons } from "@/lib/app-icons";
import { PlusMenu, PlusMenuRow, type PlusMenuSection } from "@/components/chat/composer-plus-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  MENU_W,
  MENU_W_WIDE,
  menuGlyphInkClass,
  menuRowClass,
  menuSeparatorClass,
  menuShellClass,
} from "@/components/ui/menu-recipe";
import { cn } from "@/lib/utils";

/**
 * THE STATIC MENUS, AND WHAT THEY ARE ALLOWED TO BE.
 *
 * A real dropdown portals to <body> and closes the moment focus moves to the
 * next one, so two of them cannot be on screen together — which is the one
 * thing this section exists to do. These are drawn from the recipe's own
 * classes instead: a change to `menu-recipe.ts` shows up here, and only the
 * portal and the focus management are missing.
 *
 * THE RULE THAT COST SOMETHING TO LEARN: the content has to be the shipped
 * content, drawn with the shipped icons from the registry. The first version
 * of this section invented a plausible `+` menu — "Add files" and "Add photos"
 * as two rows, no "Add from library", and Lucide's `Sparkles` for Deep
 * research. Every one of those is wrong about the product: the two attachment
 * rows were deliberately merged into one (`ACCEPT_ATTRIBUTE` has always taken
 * both), the library row exists, and `ComposerIcons.research` is a telescope,
 * "never binoculars" and certainly never a sparkle. It was read as a change to
 * the product and reported as a regression, which is exactly what a gallery
 * that paraphrases will always produce.
 *
 * So: icons come from the registry (`@/lib/app-icons`) wherever a concept has
 * an entry, never from a fresh pick out of the icon set, and the rows mirror
 * `composer.tsx` group for group. Anything this file cannot mirror honestly
 * belongs in the live section below it instead.
 */
function StaticMenu({ title, width, children }: { title: string; width: string; children: React.ReactNode }) {
  return (
    <figure className="m-0">
      <figcaption className="mb-2 font-mono text-caption text-muted-foreground">{title}</figcaption>
      <div className={cn(menuShellClass, width, "static")}>{children}</div>
    </figure>
  );
}

function MenuRow({
  icon: Icon,
  children,
  detail,
  description,
  ticked,
  chevron,
  destructive,
  indent,
}: {
  icon?: typeof Plus;
  children: React.ReactNode;
  detail?: string;
  description?: string;
  ticked?: boolean;
  chevron?: boolean;
  destructive?: boolean;
  indent?: boolean;
}) {
  return (
    <div
      className={cn(
        menuRowClass,
        destructive ? "text-destructive" : menuGlyphInkClass,
        description && "items-start py-2",
        indent && "pl-8 pr-2",
      )}
    >
      {ticked && indent && <StatusIcons.success className="absolute left-2 size-4 text-primary" />}
      {Icon && <Icon aria-hidden className={cn("shrink-0", description && "mt-0.5")} />}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{children}</span>
        {description && (
          <span className="mt-0.5 block truncate text-caption font-normal text-muted-foreground">{description}</span>
        )}
      </span>
      {detail && <span className="shrink-0 font-mono text-caption text-muted-foreground">{detail}</span>}
      {ticked && !indent && <StatusIcons.success className="size-3.5 shrink-0 text-primary" />}
      {chevron && <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" />}
    </div>
  );
}

function MenuHairline() {
  return <div className={menuSeparatorClass} />;
}

/**
 * The real `<PlusMenu>`, with the section shape composer.tsx builds — a merged
 * attachment row, the library, where the chat sits, and what is armed for the
 * message. Its handlers are no-ops; everything else is the shipped component,
 * including the submenus and the phone-width drill-in.
 */
function LivePlusMenu() {
  const [open, setOpen] = React.useState(false);
  const [research, setResearch] = React.useState(false);
  const [web, setWeb] = React.useState(true);
  const [project, setProject] = React.useState<string | null>(null);
  const noop = () => {};

  const sections: PlusMenuSection[] = [
    [
      { kind: "action", id: "files", label: "Add files or photos", icon: ComposerIcons.attach, detail: "⌘U", onSelect: noop },
      { kind: "action", id: "screenshot", label: "Take a screenshot", icon: Scan, onSelect: noop },
      { kind: "action", id: "library", label: "Add from library", icon: AppIcons.library, onSelect: noop },
    ],
    [
      {
        kind: "sub",
        id: "project",
        label: "Add to project",
        icon: AppIcons.projects,
        detail: project ?? undefined,
        render: () => (
          <>
            <PlusMenuRow selected={project === null} onSelect={() => setProject(null)}>No project</PlusMenuRow>
            {["Juno", "Thesis", "Invoices"].map((name) => (
              <PlusMenuRow key={name} icon={AppIcons.projects} selected={project === name} onSelect={() => setProject(name)}>
                {name}
              </PlusMenuRow>
            ))}
          </>
        ),
      },
      { kind: "sub", id: "connectors", label: "Connectors", icon: Plug, detail: "2", render: () => (
        <>
          <PlusMenuRow icon={Plug} checked onSelect={noop}>Gmail</PlusMenuRow>
          <PlusMenuRow icon={Plug} checked onSelect={noop}>Drive</PlusMenuRow>
          <PlusMenuRow icon={Plug} checked={false} onSelect={noop}>Notion</PlusMenuRow>
        </>
      ) },
    ],
    [
      { kind: "toggle", id: "research", label: "Deep research", icon: ComposerIcons.research, checked: research, detail: research ? "Standard" : undefined, onToggle: () => setResearch((v) => !v) },
      { kind: "toggle", id: "task", label: "Do this as a task", icon: ComposerIcons.task, checked: false, onToggle: noop },
      { kind: "toggle", id: "search", label: "Web search", icon: ComposerIcons.web, checked: web, onToggle: () => setWeb((v) => !v) },
      { kind: "toggle", id: "memory", label: "Memory", icon: ComposerIcons.memory, checked: true, onToggle: noop },
    ],
  ];

  return (
    <div className="flex items-center gap-3">
      <span className="font-mono text-caption text-muted-foreground">PlusMenu →</span>
      <PlusMenu open={open} onOpenChange={setOpen} label="Add to this message" tooltip="Add" sections={sections} />
    </div>
  );
}

/** The real kebab, with ConversationRow's rows — one hairline, before Delete. */
function LiveKebab() {
  return (
    <div className="flex items-center gap-3">
      <span className="font-mono text-caption text-muted-foreground">Kebab →</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Pressable kind="icon" size="md" aria-label="Conversation options">
            <ActionIcons.more className="size-4" />
          </Pressable>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className={MENU_W}>
          <DropdownMenuItem><ActionIcons.edit className="size-4" /> Rename</DropdownMenuItem>
          <DropdownMenuItem><Pin className="size-4" /> Pin</DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <AppIcons.projects className="size-4" /> Add to project
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className={MENU_W}>
              <DropdownMenuItem><StatusIcons.success className="size-4 text-primary" /> No project</DropdownMenuItem>
              <DropdownMenuItem><AppIcons.projects className="size-4" /> Juno</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem><Plus className="size-4" /> New project…</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem><ActionIcons.share className="size-4" /> Share</DropdownMenuItem>
          <DropdownMenuItem><Archive className="size-4" /> Archive</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive"><ActionIcons.delete className="size-4" /> Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * One mark from the registry, in a pressable tile so its hover articulation
 * plays exactly as it does in the product (the glyph moves only inside an
 * interactive element). The caption is the CONCEPT — the registry key — not
 * the export name, because the concept is what a call site imports.
 */
function GlyphTile({ icon: Icon, name }: { icon: IconComponent; name: string }) {
  return (
    <button
      type="button"
      className="pressable flex w-24 flex-col items-center gap-2 rounded-field border border-transparent px-2 py-3 text-muted-foreground hover:bg-accent hover:text-foreground motion-reduce:transition-none"
    >
      <Icon className="size-5" />
      <span className="max-w-full truncate font-mono text-micro">{name}</span>
    </button>
  );
}

function GlyphGroup({ title, icons }: { title: string; icons: Record<string, IconComponent> }) {
  return (
    <div className="w-full">
      <p className="mb-1 font-mono text-caption text-muted-foreground">{title}</p>
      <div className="flex flex-wrap gap-1">
        {Object.entries(icons).map(([name, icon]) => (
          <GlyphTile key={name} icon={icon} name={name} />
        ))}
      </div>
    </div>
  );
}

/** The seven gestures, one representative each (ICONS_AND_MOTION.md §1.3). */
const ARTICULATIONS: { icon: IconComponent; motion: string; label: string }[] = [
  { icon: ArrowRight, motion: "nudge", label: "Go there" },
  { icon: Plus, motion: "turn", label: "Make one more" },
  { icon: Settings, motion: "spin", label: "Configure" },
  { icon: RefreshCw, motion: "cw", label: "Run again" },
  { icon: RotateCcw, motion: "ccw", label: "Go back" },
  { icon: Pencil, motion: "tilt", label: "Pick up a tool" },
  { icon: Copy, motion: "lift", label: "Pick up an object" },
  { icon: Star, motion: "pop", label: "Set a mark" },
];

/** The icon ladder, left to right. 12px and under draw the bold cut. */
const LADDER = ["size-3", "size-3.5", "size-4", "size-4.5", "size-5", "size-6"] as const;

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-border py-8">
      <h2 className="text-ui font-medium">{title}</h2>
      {note && <p className="mt-1 max-w-prose text-caption text-muted-foreground">{note}</p>}
      <div className="mt-4 flex flex-wrap items-center gap-3">{children}</div>
    </section>
  );
}

export function ControlsGallery() {
  const [dark, setDark] = React.useState(false);
  const [filter, setFilter] = React.useState<"ALL" | "HTML" | "MARKDOWN">("ALL");
  const [chip, setChip] = React.useState("a");
  const [view, setView] = React.useState<"list" | "grid">("list");
  const [notify, setNotify] = React.useState(true);
  const [agree, setAgree] = React.useState<boolean | "indeterminate">(true);
  const [plan, setPlan] = React.useState("monthly");
  const [tab, setTab] = React.useState("overview");
  const [volume, setVolume] = React.useState([60]);
  const [saving, setSaving] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [pinned, setPinned] = React.useState(false);
  const [open, setOpen] = React.useState(false);

  // Dev-only demo timers: a save that takes a beat, a copy that resets.
  const save = () => {
    setSaving(true);
    window.setTimeout(() => setSaving(false), 1400);
  };
  const copy = () => {
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  // The gallery drives the theme itself so both halves can be checked without
  // leaving the page — the app's own toggle lives behind auth.
  React.useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  return (
    <div className="min-h-dvh bg-background px-8 py-10 text-foreground">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-page-title font-semibold tracking-tight">Controls</h1>
            <p className="mt-1 text-ui text-muted-foreground">
              Every control the product uses, rendered together.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setDark((d) => !d)}>
            {dark ? "Light" : "Dark"}
          </Button>
        </div>

        <Section
          title="The /artifacts toolbar"
          note="Search, one-of-N filter and the page action in one row — the exact composition the page ships."
        >
          <div className="flex w-full flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
            <div className="relative sm:min-w-48 sm:max-w-xs sm:flex-1">
              <Search
                aria-hidden
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input placeholder="Search artifacts…" aria-label="Search artifacts" className="h-9 pl-9" />
            </div>
            <SegmentedControl<"ALL" | "HTML" | "MARKDOWN">
              value={filter}
              onChange={setFilter}
              ariaLabel="Filter by type"
              className="w-fit max-w-full shrink-0"
              optionClassName="whitespace-nowrap"
              options={[
                { value: "ALL", label: "All" },
                { value: "HTML", label: "Sites" },
                { value: "MARKDOWN", label: "Documents" },
              ]}
            />
            <Button size="sm" variant="outline" className="gap-1.5">
              <AppIcons.design className="size-3.5" aria-hidden />
              New design
            </Button>
          </div>
        </Section>

        <Section
          title="The /artifacts toolbar · every type present"
          note="The worst case the page can actually produce: all seven ArtifactTypes have an artifact, so the filter carries eight segments."
        >
          <div className="flex w-full flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
            <div className="relative sm:min-w-48 sm:max-w-xs sm:flex-1">
              <Search
                aria-hidden
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input placeholder="Search artifacts…" aria-label="Search artifacts" className="h-9 pl-9" />
            </div>
            <SegmentedControl
              value="ALL"
              onChange={() => {}}
              ariaLabel="Filter by type (worst case)"
              className="w-fit max-w-full shrink-0"
              optionClassName="whitespace-nowrap"
              options={[
                { value: "ALL", label: "All" },
                { value: "HTML", label: "Sites" },
                { value: "REACT", label: "Components" },
                { value: "CODE", label: "Code" },
                { value: "MARKDOWN", label: "Documents" },
                { value: "SVG", label: "Graphics" },
                { value: "MERMAID", label: "Diagrams" },
                { value: "DESIGN", label: "Designs" },
              ]}
            />
            <Button size="sm" variant="outline" className="gap-1.5">
              <AppIcons.design className="size-3.5" aria-hidden />
              New design
            </Button>
          </div>
        </Section>

        <Section
          title="The /library toolbar"
          note="Two segmented controls in one bar — the type filter carries live counts, the view toggle is icon+label. They have to read as one set, which is the whole reason the filter is no longer a row of pills."
        >
          <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center">
            <SegmentedControl<"ALL" | "HTML" | "MARKDOWN">
              value={filter}
              onChange={setFilter}
              ariaLabel="Filter files"
              className="h-9 w-fit max-w-full shrink-0"
              options={[
                { value: "ALL", label: "All", count: 12 },
                { value: "HTML", label: "Images", count: 5 },
                { value: "MARKDOWN", label: "Files", count: 7 },
              ]}
            />
            <div className="flex min-w-0 flex-1 items-center gap-2 sm:justify-end">
              <div className="relative min-w-0 flex-1 sm:max-w-[16rem]">
                <Search
                  aria-hidden
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                />
                <Input placeholder="Search files" aria-label="Search files" className="h-9 pl-9" />
              </div>
              <SegmentedControl<"list" | "grid">
                value={view}
                onChange={setView}
                ariaLabel="File view"
                className="h-9 shrink-0"
                options={[
                  { value: "list", label: "List", icon: <ListIcon className="size-3.5" /> },
                  { value: "grid", label: "Grid", icon: <LayoutGrid className="size-3.5" /> },
                ]}
              />
            </div>
          </div>
        </Section>

        <Section title="Button · variants" note="All at size=sm, the size a toolbar uses.">
          <Button size="sm">Default</Button>
          <Button size="sm" variant="secondary">Secondary</Button>
          <Button size="sm" variant="outline">Outline</Button>
          <Button size="sm" variant="ghost">Ghost</Button>
          <Button size="sm" variant="destructive">Destructive</Button>
          <Button size="sm" variant="destructive-outline">Destructive outline</Button>
          <Button size="sm" variant="link">Link</Button>
        </Section>

        <Section title="Button · sizes">
          <Button size="sm">Small</Button>
          <Button>Default</Button>
          <Button size="lg">Large</Button>
          <Button size="icon-sm" aria-label="Add"><Plus className="size-4" /></Button>
          <Button size="icon" aria-label="Delete"><Trash2 className="size-4" /></Button>
          <Button size="sm" disabled>Disabled</Button>
        </Section>

        <Section
          title="SegmentedControl"
          note="The house idiom for a one-of-N filter or mode switch. Two, three and four segments. A tally goes in `count`, not concatenated into the label — that is what keeps it mono and tabular."
        >
          <SegmentedControl
            value={filter}
            onChange={(v) => setFilter(v as typeof filter)}
            ariaLabel="Two"
            className="w-fit"
            options={[
              { value: "ALL", label: "All apps" },
              { value: "HTML", label: "Connected", count: 3 },
            ]}
          />
          <SegmentedControl
            value={filter}
            onChange={(v) => setFilter(v as typeof filter)}
            ariaLabel="Three"
            className="w-fit"
            options={[
              { value: "ALL", label: "All" },
              { value: "HTML", label: "Sites" },
              { value: "MARKDOWN", label: "Documents" },
            ]}
          />
        </Section>

        <Section
          title="Pressable · chip"
          note="A chip is a token or a MULTI-select tag — not a one-of-N filter. That job belongs to the control above."
        >
          {["a", "b", "c"].map((k) => (
            <Pressable
              key={k}
              kind="chip"
              size="sm"
              selected={chip === k}
              role="radio"
              aria-checked={chip === k}
              onClick={() => setChip(k)}
            >
              Chip {k}
            </Pressable>
          ))}
          <Pressable kind="chip" size="lg">Large chip</Pressable>
        </Section>

        <Section title="Pressable · row / tile / icon">
          <div className="w-56">
            <Pressable kind="row">A row</Pressable>
            <Pressable kind="row" selected>A selected row</Pressable>
          </div>
          <Pressable kind="tile" className="w-40">Tile</Pressable>
          <Pressable kind="tile" selected className="w-40">Selected tile</Pressable>
          <Pressable kind="icon" size="md" aria-label="Add"><Plus className="size-4" /></Pressable>
          <Pressable kind="icon" size="md" selected aria-label="Add"><Plus className="size-4" /></Pressable>
        </Section>

        <Section title="Badge" note="Not a control — here so its weight can be compared to the chip beside it.">
          <Badge>Default</Badge>
          <Badge variant="secondary">Secondary</Badge>
          <Badge variant="muted">Muted</Badge>
          <Badge variant="soft">Soft</Badge>
          <Badge variant="success">Success</Badge>
          <Badge variant="outline">Outline</Badge>
        </Section>

        <Section
          title="Icons · the registry"
          note="Every concept the shell names, drawn from the one set (Phosphor geometry, regular weight). Hover a tile: a glyph plays its one articulation only inside something pressable, never on its own."
        >
          <GlyphGroup title="AppIcons — destinations" icons={AppIcons} />
          <GlyphGroup title="ActionIcons — verbs" icons={ActionIcons} />
          <GlyphGroup title="StatusIcons — what happened" icons={StatusIcons} />
          <GlyphGroup title="ComposerIcons — what + adds" icons={ComposerIcons} />
        </Section>

        <Section
          title="Icons · the articulation vocabulary"
          note="Seven gestures, each naming what the action does. Carets, spinners and status marks carry none. Keyboard focus plays them too; reduced motion and disabled controls never do."
        >
          {ARTICULATIONS.map(({ icon: Icon, motion, label }) => (
            <Button key={motion} variant="outline" size="sm">
              <Icon className="size-4" />
              {label}
              <span className="font-mono text-micro text-muted-foreground">{motion}</span>
            </Button>
          ))}
          <Button variant="outline" size="sm" disabled>
            <Settings className="size-4" />
            Disabled — still
          </Button>
        </Section>

        <Section
          title="Icons · size ladder and the on state"
          note="12 · 14 · 16 · 18 · 20 · 24. At 12px the set swaps to its bold cut on its own, so the line never thins out. `fill` is a state — pinned, starred — never decoration."
        >
          <div className="flex items-end gap-4 text-foreground">
            {LADDER.map((size) => (
              <div key={size} className="flex flex-col items-center gap-2">
                <Settings className={size} motion="none" />
                <span className="font-mono text-micro text-muted-foreground">{size}</span>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Pressable
                  kind="icon"
                  size="md"
                  selected={pinned}
                  aria-pressed={pinned}
                  aria-label={pinned ? "Unpin" : "Pin"}
                  onClick={() => setPinned((v) => !v)}
                >
                  <IconSwap
                    swapped={pinned}
                    from={<Pin className="size-4" />}
                    to={<Pin weight="fill" className="size-4" />}
                  />
                </Pressable>
              </TooltipTrigger>
              <TooltipContent>{pinned ? "Unpin" : "Pin"}</TooltipContent>
            </Tooltip>
            <span className="font-mono text-caption text-muted-foreground">regular ⇄ fill, cross-faded</span>
          </div>
        </Section>

        <Section
          title="Tooltips"
          note="Hover one, then slide along the row: the first waits out the delay, the rest open instantly inside the skip window. 2px of travel toward the trigger, 120ms, no spring."
        >
          {[
            { icon: ActionIcons.edit, label: "Rename" },
            { icon: ActionIcons.share, label: "Share" },
            { icon: Archive, label: "Archive" },
            { icon: ActionIcons.download, label: "Download" },
            { icon: ActionIcons.delete, label: "Delete" },
          ].map(({ icon: Icon, label }) => (
            <Tooltip key={label}>
              <TooltipTrigger asChild>
                <IconButton variant="ghost" size="sm" label={label} title="">
                  <Icon className="size-4" />
                </IconButton>
              </TooltipTrigger>
              <TooltipContent>{label}</TooltipContent>
            </Tooltip>
          ))}
        </Section>

        <Section
          title="Toggles"
          note="Every selection mark moves: the switch thumb travels and squashes, the tick and the radio dot spring in and leave on the accelerate, the tab key slides on the shared spring."
        >
          <div className="flex w-full flex-wrap items-center gap-6">
            <label className="flex items-center gap-2 text-ui">
              <Switch checked={notify} onCheckedChange={setNotify} />
              Notifications
            </label>
            <label className="flex items-center gap-2 text-ui text-muted-foreground">
              <Switch disabled />
              Disabled
            </label>
            <label className="flex items-center gap-2 text-ui">
              <Checkbox checked={agree} onCheckedChange={(v) => setAgree(v)} />
              Checked
            </label>
            <label className="flex items-center gap-2 text-ui">
              <Checkbox checked="indeterminate" />
              Indeterminate
            </label>
            <Slider aria-label="Volume" value={volume} onValueChange={setVolume} className="w-40" />
          </div>
          <RadioGroup value={plan} onValueChange={setPlan} className="flex gap-4">
            {["monthly", "yearly", "team"].map((v) => (
              <label key={v} className="flex items-center gap-2 text-ui capitalize">
                <RadioGroupItem value={v} />
                {v}
              </label>
            ))}
          </RadioGroup>
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              {["overview", "tasks", "code", "sources", "settings"].map((v) => (
                <TabsTrigger key={v} value={v} className="capitalize">
                  {v}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </Section>

        <Section
          title="Button · loading and state swaps"
          note="`loading` cross-fades the label to the spinner in place — the width never changes and the button is not dimmed. Copy cross-fades to a check rather than cutting."
        >
          <Button size="sm" loading={saving} onClick={save}>
            Save changes
          </Button>
          <Button size="sm" variant="outline" loading={saving} onClick={save}>
            <Download className="size-4" />
            Export
          </Button>
          <Button size="sm" variant="ghost" onClick={copy}>
            <IconSwap
              swapped={copied}
              from={<Copy className="size-4" />}
              to={<Check className="size-4 text-success-ink" />}
            />
            {copied ? "Copied" : "Copy link"}
          </Button>
        </Section>

        <Section
          title="Disclosure"
          note="One caret that turns on the symmetric curve, and content that unfolds on grid rows instead of appearing."
        >
          <div className="w-full max-w-md rounded-card border border-border">
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              className="flex w-full items-center gap-2 rounded-card px-3.5 py-2.5 text-left text-ui font-medium transition-colors duration-fast ease-out-soft hover:bg-accent/40"
            >
              <ChevronRight
                className={cn(
                  "size-4 text-muted-foreground transition-transform duration-base ease-in-out motion-reduce:transition-none",
                  open && "rotate-90"
                )}
              />
              Three delegated agents
            </button>
            <Collapse open={open} innerClassName="px-3.5 pb-3 text-ui text-muted-foreground">
              Researcher, Implementer and Reviewer are working in their own branches. Open one to inspect its
              changes.
            </Collapse>
          </div>
        </Section>

        <Section
          title="Toasts"
          note="The tier rides the glyph; the sentence stays in foreground ink. Arrival on the long-travel curve, exit on the accelerate."
        >
          <Button size="sm" variant="outline" onClick={() => toast.success("Project renamed")}>Success</Button>
          <Button size="sm" variant="outline" onClick={() => toast.error("Couldn’t reach GitHub", { description: "Check the connector and try again." })}>Error</Button>
          <Button size="sm" variant="outline" onClick={() => toast.warning("You’re near your monthly limit")}>Warning</Button>
          <Button size="sm" variant="outline" onClick={() => toast.info("Juno updated in the background")}>Info</Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => toast("Conversation archived", { action: { label: "Undo", onClick: () => {} } })}
          >
            With action
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              toast.promise(new Promise((resolve) => window.setTimeout(resolve, 1500)), {
                loading: "Exporting…",
                success: "Export ready",
                error: "Export failed",
              })
            }
          >
            Loading → success
          </Button>
        </Section>

        <Section
          title="Empty and error states"
          note="One muted glyph in a quiet tile, one sentence, one action."
        >
          <div className="grid w-full gap-3 sm:grid-cols-2">
            <EmptyState
              size="panel"
              icon={AppIcons.projects}
              title="No projects yet"
              description="Group chats, files and instructions under one name."
              action={<Button size="sm">New project</Button>}
            />
            <EmptyState
              size="panel"
              tone="error"
              icon={StatusIcons.error}
              title="Couldn’t load your projects"
              action={<Button size="sm" variant="outline">Try again</Button>}
            />
          </div>
        </Section>

        <Section title="Dialog" note="Scrim leads on open and trails on close; the panel springs in from 0.96 and leaves on the accelerate.">
          <Dialog>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline">Open dialog</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Rename project</DialogTitle>
                <DialogDescription>The new name shows everywhere the project does.</DialogDescription>
              </DialogHeader>
              <Input defaultValue="Juno" aria-label="Project name" />
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="ghost" size="sm">Cancel</Button>
                </DialogClose>
                <DialogClose asChild>
                  <Button size="sm">Rename</Button>
                </DialogClose>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </Section>

        <Section
          title="Menus — the recipe, opened side by side"
          note={
            "Every floating list in the product, drawn statically so they can be compared. " +
            "They are ONE recipe (menu-recipe.ts): 14px shell at p-1, 32px rows at 13px with a " +
            "16px muted glyph, a hairline at 10%, and two widths — never nine. This section is " +
            "the reason the drift is visible: the composer's + and a row kebab never appear on " +
            "screen together in the real product, so for months they were two different objects."
          }
        >
          <div className="flex flex-wrap items-start gap-6">
            {/* Mirrors ConversationRow in app-sidebar.tsx, row for row. */}
            <StaticMenu title="Row kebab (⋯)" width={MENU_W}>
              <MenuRow icon={ActionIcons.edit}>Rename</MenuRow>
              <MenuRow icon={Pin}>Pin</MenuRow>
              <MenuRow icon={AppIcons.projects} chevron>Add to project</MenuRow>
              <MenuRow icon={ActionIcons.share}>Share</MenuRow>
              <MenuRow icon={Archive}>Archive</MenuRow>
              <MenuHairline />
              <MenuRow icon={ActionIcons.delete} destructive>Delete</MenuRow>
            </StaticMenu>

            {/* Mirrors `plusSections` in composer.tsx: one merged attachment
                row that teaches ⌘U, the screenshot row where the browser has
                getDisplayMedia, the library row — then where the chat sits,
                then what is armed for the message. */}
            <StaticMenu title="Composer + menu" width={MENU_W_WIDE}>
              <MenuRow icon={ComposerIcons.attach} detail="⌘U">Add files or photos</MenuRow>
              <MenuRow icon={Scan}>Take a screenshot</MenuRow>
              <MenuRow icon={AppIcons.library}>Add from library</MenuRow>
              <MenuHairline />
              <MenuRow icon={AppIcons.projects} chevron>Add to project</MenuRow>
              <MenuRow icon={Plug} detail="2" chevron>Connectors</MenuRow>
              <MenuHairline />
              <MenuRow icon={ComposerIcons.research}>Deep research</MenuRow>
              <MenuRow icon={ComposerIcons.task}>Do this as a task</MenuRow>
              <MenuRow icon={ComposerIcons.web} ticked>Web search</MenuRow>
              <MenuRow icon={ComposerIcons.memory} ticked>Memory</MenuRow>
            </StaticMenu>

            <StaticMenu title="Select" width={MENU_W}>
              <MenuRow indent ticked>Automatic</MenuRow>
              <MenuRow indent>Always on</MenuRow>
              <MenuRow indent>Never</MenuRow>
            </StaticMenu>

            <StaticMenu title="With a label + a download row" width={MENU_W_WIDE}>
              <p className="px-2.5 pb-1 pt-1.5 text-caption font-medium text-muted-foreground">Juno on your desktop</p>
              <MenuHairline />
              <MenuRow icon={Download} description="Apple silicon · 21.9 MB">macOS</MenuRow>
              <MenuRow icon={Download} description="Not published yet">Windows</MenuRow>
            </StaticMenu>
          </div>
        </Section>

        <Section
          title="Menus — the real components, openable"
          note={
            "The static row above cannot be wrong about geometry but can be wrong about content, " +
            "and once was. These two are the shipped components — <PlusMenu> from " +
            "composer-plus-menu.tsx and a <DropdownMenu> kebab — with the real section shape, so " +
            "submenus, ticks, keyboard nav and the compact drill-in can be exercised rather than " +
            "described. Open them one at a time; a portalled menu closes when the next one opens."
          }
        >
          <LivePlusMenu />
          <LiveKebab />
        </Section>

        <Section
          title="Dialog footer"
          note="The pairing every confirm dialog in the product should use: ghost cancel, solid confirm."
        >
          <div className="flex justify-end gap-2 rounded-card border border-border bg-card p-4">
            <Button variant="ghost" size="sm">Cancel</Button>
            <Button size="sm">Rename</Button>
          </div>
          <div className="flex justify-end gap-2 rounded-card border border-border bg-card p-4">
            <Button variant="ghost" size="sm">Cancel</Button>
            <Button variant="destructive" size="sm">Delete</Button>
          </div>
        </Section>
      </div>
    </div>
  );
}
