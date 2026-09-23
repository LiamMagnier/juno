import type { CSSProperties, ReactNode } from "react";

import { SETTINGS_SECTIONS } from "@/components/settings/settings-sections";
import { Cpu, JunoChat, JunoCode, JunoDesign, JunoLibrary, type IconComponent } from "@/components/ui/icons";
import { menuGlyphInkClass, menuRowClass } from "@/components/ui/menu-recipe";
import { AppIcons, ComposerIcons, SettingsIcons } from "@/lib/app-icons";
import { cn } from "@/lib/utils";

/** Holds a glyph's hover articulation on, the value the trigger rule in
 *  globals.css sets on a hovered row. */
const HOVER = { "--icon-on": 1 } as CSSProperties;

/** The icon ladder plus the two empty-state sizes. 12px draws the bold cut. */
const SIZES = [
  { px: 12, className: "size-3" },
  { px: 14, className: "size-3.5" },
  { px: 16, className: "size-4" },
  { px: 18, className: "size-4.5" },
  { px: 20, className: "size-5" },
  { px: 24, className: "size-6" },
  { px: 48, className: "size-12" },
] as const;

/**
 * Phosphor's Books, the drawing `JunoLibrary` replaced, kept here as reference
 * art so the two can be compared. It is not in the icon set any more, and this
 * page may not import the glyph library, so the regular and bold paths are
 * copied from Phosphor (MIT).
 */
const BOOKS_REGULAR =
  "M231.65,194.55,198.46,36.75a16,16,0,0,0-19-12.39L132.65,34.42a16.08,16.08,0,0,0-12.3,19l33.19,157.8A16,16,0,0,0,169.16,224a16.25,16.25,0,0,0,3.38-.36l46.81-10.06A16.09,16.09,0,0,0,231.65,194.55ZM136,50.15c0-.06,0-.09,0-.09l46.8-10,3.33,15.87L139.33,66Zm6.62,31.47,46.82-10.05,3.34,15.9L146,97.53Zm6.64,31.57,46.82-10.06,13.3,63.24-46.82,10.06ZM216,197.94l-46.8,10-3.33-15.87L212.67,182,216,197.85C216,197.91,216,197.94,216,197.94ZM104,32H56A16,16,0,0,0,40,48V208a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V48A16,16,0,0,0,104,32ZM56,48h48V64H56Zm0,32h48v96H56Zm48,128H56V192h48v16Z";
const BOOKS_BOLD =
  "M235.57,193.73,202.38,35.93a20,20,0,0,0-23.76-15.48L131.81,30.51a19.82,19.82,0,0,0-11,6.65A20,20,0,0,0,104,28H56A20,20,0,0,0,36,48V208a20,20,0,0,0,20,20h48a20,20,0,0,0,20-20V90.25l25.62,121.82A20,20,0,0,0,169.15,228a20.27,20.27,0,0,0,4.23-.45l46.81-10.06A20.1,20.1,0,0,0,235.57,193.73ZM148.19,88.65l39-8.38,2.53,12-39,8.38Zm7.46,35.5,39-8.38,9.16,43.58-39,8.38Zm24.06-79.39,2.53,12-39,8.38-2.53-12ZM60,88h40v80H60Zm40-36V64H60V52ZM60,204V192h40v12Zm112.29-.76-2.53-12,39-8.38,2.53,12Z";

function BooksBefore({ className, bold = false }: { className?: string; bold?: boolean }) {
  return (
    <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" className={cn("shrink-0", className)}>
      <path d={bold ? BOOKS_BOLD : BOOKS_REGULAR} />
    </svg>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="border-t border-border py-10">
      <h2 className="text-heading font-semibold tracking-tight">{title}</h2>
      {note && <p className="mt-1.5 max-w-prose text-ui text-muted-foreground">{note}</p>}
      <div className="mt-6">{children}</div>
    </section>
  );
}

/** A column heading over one panel of a before and after pair. */
function Caption({ children }: { children: ReactNode }) {
  return <p className="mb-2 text-caption text-muted-foreground">{children}</p>;
}

// ---------------------------------------------------------------------------
// Sizes
// ---------------------------------------------------------------------------

type SizeRow = { label: string; render: (className: string, px: number) => ReactNode };

const SIZE_ROWS: SizeRow[] = [
  { label: "Library", render: (className) => <JunoLibrary className={className} /> },
  { label: "Books, before", render: (className, px) => <BooksBefore className={className} bold={px <= 12} /> },
  { label: "Chat", render: (className) => <JunoChat className={className} /> },
  { label: "Code", render: (className) => <JunoCode className={className} /> },
  { label: "Design", render: (className) => <JunoDesign className={className} /> },
];

function SizeGrid() {
  return (
    // The 48px column makes the grid wider than a phone; it scrolls inside its
    // own box so the page never does.
    <div className="-mx-4 overflow-x-auto px-4">
      <div className="grid min-w-[36rem] grid-cols-[7.5rem_repeat(7,minmax(0,1fr))] items-center">
        <span />
        {SIZES.map((s) => (
          <span key={s.px} className="pb-3 text-center text-caption tabular-nums text-muted-foreground">
            {s.px}
          </span>
        ))}
        {SIZE_ROWS.map((row) => (
          <div key={row.label} className="contents">
            <span className="flex h-full items-center border-t border-border py-4 text-ui text-muted-foreground">
              {row.label}
            </span>
            {SIZES.map((s) => (
              <span
                key={s.px}
                className="flex h-full items-center justify-center border-t border-border py-4 text-foreground"
              >
                {row.render(s.className, s.px)}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Weights and the hover articulation
// ---------------------------------------------------------------------------

const WEIGHTS = [
  { label: "Thin", weight: "thin" },
  { label: "Light", weight: "light" },
  { label: "Regular", weight: "regular" },
  { label: "Bold", weight: "bold" },
  { label: "Fill", weight: "fill" },
] as const;

function WeightStrip() {
  return (
    <div className="grid grid-cols-4 gap-x-4 gap-y-8 sm:grid-cols-7">
      {WEIGHTS.map((w) => (
        <figure key={w.weight} className="flex flex-col items-center gap-3">
          <JunoLibrary weight={w.weight} className="size-12" />
          <JunoLibrary weight={w.weight} className="size-4.5" />
          <figcaption className="text-caption text-muted-foreground">{w.label}</figcaption>
        </figure>
      ))}
      <figure className="flex flex-col items-center gap-3">
        <JunoLibrary className="size-12" style={HOVER} />
        <JunoLibrary className="size-4.5" style={HOVER} />
        <figcaption className="text-caption text-muted-foreground">Hover</figcaption>
      </figure>
      <figure className="flex flex-col items-center gap-3">
        <JunoLibrary weight="fill" className="size-12" style={HOVER} />
        <JunoLibrary weight="fill" className="size-4.5" style={HOVER} />
        <figcaption className="text-caption text-muted-foreground">Fill, hover</figcaption>
      </figure>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The sidebar: the nav rows' own recipe (app-sidebar.tsx navRowClass / NavRow)
// ---------------------------------------------------------------------------

type NavState = "rest" | "hover" | "selected";

function NavRow({ icon, label, state = "rest" }: { icon: ReactNode; label: string; state?: NavState }) {
  return (
    <div
      data-icon-trigger
      className={cn(
        "group relative flex h-8 w-full items-center gap-2.5 rounded-control px-2 text-nav transition-colors duration-fast ease-out-soft",
        state === "rest" && "text-sidebar-foreground hover:bg-sidebar-hover hover:text-foreground",
        state === "hover" && "bg-sidebar-hover text-foreground",
        state === "selected" && "text-foreground"
      )}
    >
      {state === "selected" && (
        <span aria-hidden="true" className="sidebar-row-selected absolute inset-0 -z-10 rounded-control" />
      )}
      <span
        className={cn(
          "flex size-5 shrink-0 items-center justify-center [&_svg]:size-4.5",
          state === "rest" ? "text-sidebar-foreground group-hover:text-foreground" : "text-foreground"
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </div>
  );
}

function SidebarPanel({ library, state }: { library: ReactNode; state?: NavState }) {
  return (
    <div className="isolate w-full rounded-card bg-sidebar p-2 sm:w-56">
      <NavRow icon={library} label="Library" state={state} />
      <NavRow icon={<AppIcons.projects motion="none" />} label="Projects" />
      <NavRow icon={<AppIcons.artifacts />} label="Artifacts" />
      <NavRow icon={<AppIcons.design />} label="Design" />
    </div>
  );
}

function RailPanel() {
  const cell = "flex size-11 items-center justify-center rounded-control [&_svg]:size-4.5";
  return (
    <div className="isolate flex w-fit flex-col gap-1 rounded-card bg-sidebar p-1.5 text-sidebar-foreground">
      <span className={cn(cell, "sidebar-row-selected text-foreground")}>
        <JunoLibrary />
      </span>
      <span className={cell}>
        <AppIcons.projects motion="none" />
      </span>
      <span className={cell}>
        <AppIcons.artifacts />
      </span>
      <span className={cell}>
        <AppIcons.design />
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A menu: the shared recipe (menu-recipe.ts) at its 16px glyph
// ---------------------------------------------------------------------------

function MenuPanel({ library }: { library: ReactNode }) {
  const rows: { icon: ReactNode; label: string; highlighted?: boolean }[] = [
    { icon: <ComposerIcons.files />, label: "Add photos and files" },
    { icon: library, label: "Add from library", highlighted: true },
    { icon: <ComposerIcons.research />, label: "Deep research" },
    { icon: <ComposerIcons.web />, label: "Web search" },
  ];
  return (
    <div className="surface-float w-full rounded-menu p-1 sm:w-60">
      {rows.map((row) => (
        <div
          key={row.label}
          data-highlighted={row.highlighted ? "" : undefined}
          className={cn(menuRowClass, menuGlyphInkClass, "hover:bg-accent data-[highlighted]:bg-accent")}
        >
          {row.icon}
          <span className="truncate">{row.label}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The settings rail: its row recipe (settings-rail.tsx) with Models selected
// ---------------------------------------------------------------------------

function SettingsPanel({ models }: { models: IconComponent }) {
  return (
    <div className="surface-inset flex w-full flex-col gap-1 rounded-card p-1.5 sm:w-56">
      {SETTINGS_SECTIONS.map((section) => {
        const selected = section.id === "models";
        const Icon = section.id === "models" ? models : section.icon;
        return (
          <div
            key={section.id}
            data-icon-trigger
            className={cn(
              "group relative flex h-8 items-center gap-2.5 rounded-control px-2.5 text-ui transition-colors duration-fast ease-out-soft",
              selected ? "bg-accent text-foreground" : "text-foreground hover:bg-accent"
            )}
          >
            <span className={cn("flex shrink-0", selected ? "text-foreground" : "text-muted-foreground")}>
              <Icon className="size-4" />
            </span>
            <span className="truncate">{section.label}</span>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function GlyphsGallery() {
  return (
    <div className="min-h-dvh bg-background px-4 py-10 text-foreground sm:px-8">
      <div className="mx-auto max-w-4xl">
        <header className="pb-10">
          <h1 className="text-page-title font-semibold tracking-tight">Library glyph</h1>
          <p className="mt-2 max-w-prose text-body text-muted-foreground">
            Juno&apos;s own Library mark beside the marks it sits with, at every size the product draws it. Hover a
            row to play its gesture; the panels marked hover hold it on.
          </p>
        </header>

        <Section
          title="Sizes"
          note="The house line at 14px and up, the bold cut at 12px. The old Books is shown in its own two weights."
        >
          <SizeGrid />
        </Section>

        <Section
          title="Weights"
          note="Every weight is the same drawing at a different line. Fill is the selected drawing, with each band as a slot."
        >
          <WeightStrip />
        </Section>

        <Section title="Sidebar" note="18px in a 20px box beside a 14px label, the nav row's own recipe.">
          <div className="flex flex-col gap-6 sm:flex-row sm:flex-wrap sm:items-start">
            <div>
              <Caption>Before</Caption>
              <SidebarPanel library={<BooksBefore />} />
            </div>
            <div>
              <Caption>After</Caption>
              <SidebarPanel library={<JunoLibrary />} />
            </div>
            <div>
              <Caption>Hover</Caption>
              <SidebarPanel library={<JunoLibrary style={HOVER} />} state="hover" />
            </div>
            <div>
              <Caption>Selected</Caption>
              <SidebarPanel library={<JunoLibrary />} state="selected" />
            </div>
            <div>
              <Caption>Rail</Caption>
              <RailPanel />
            </div>
          </div>
        </Section>

        <Section title="Menu" note="16px glyphs in the shared menu recipe. The Library row is highlighted.">
          <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
            <div>
              <Caption>Before</Caption>
              <MenuPanel library={<BooksBefore className="size-4" />} />
            </div>
            <div>
              <Caption>After</Caption>
              <MenuPanel library={<JunoLibrary />} />
            </div>
          </div>
        </Section>

        <Section
          title="Settings rail"
          note="Models moves from a processor to a cube: one outline and a Y instead of a square fringed with pins."
        >
          <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
            <div>
              <Caption>Before</Caption>
              <SettingsPanel models={Cpu} />
            </div>
            <div>
              <Caption>After</Caption>
              <SettingsPanel models={SettingsIcons.models} />
            </div>
          </div>
        </Section>
      </div>
    </div>
  );
}
