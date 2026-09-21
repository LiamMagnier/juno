"use client";

import * as React from "react";
import {
  Archive,
  ChevronRight,
  Download,
  LayoutGrid,
  List as ListIcon,
  Pin,
  Plug,
  Plus,
  Scan,
  Search,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pressable } from "@/components/ui/pressable";
import { SegmentedControl } from "@/components/ui/segmented-control";
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
 * So: icons come from the registry, never from a fresh `lucide-react` import,
 * and the rows mirror `composer.tsx` group for group. Anything this file
 * cannot mirror honestly belongs in the live section below it instead.
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
