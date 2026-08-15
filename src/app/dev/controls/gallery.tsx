"use client";

import * as React from "react";
import { Search, PenTool, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pressable } from "@/components/ui/pressable";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Badge } from "@/components/ui/badge";

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-border py-8">
      <h2 className="text-sm font-medium">{title}</h2>
      {note && <p className="mt-1 max-w-prose text-xs text-muted-foreground">{note}</p>}
      <div className="mt-4 flex flex-wrap items-center gap-3">{children}</div>
    </section>
  );
}

export function ControlsGallery() {
  const [dark, setDark] = React.useState(false);
  const [filter, setFilter] = React.useState<"ALL" | "HTML" | "MARKDOWN">("ALL");
  const [chip, setChip] = React.useState("a");

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
            <h1 className="text-2xl font-semibold tracking-tight">Controls</h1>
            <p className="mt-1 text-sm text-muted-foreground">
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
                className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
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
              <PenTool className="size-3.5" aria-hidden />
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
                className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
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
              <PenTool className="size-3.5" aria-hidden />
              New design
            </Button>
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
          note="The house idiom for a one-of-N filter or mode switch. Two, three and four segments."
        >
          <SegmentedControl
            value={filter}
            onChange={(v) => setFilter(v as typeof filter)}
            ariaLabel="Two"
            className="w-fit"
            options={[
              { value: "ALL", label: "All apps" },
              { value: "HTML", label: "Connected · 3" },
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
          <Badge variant="outline">Outline</Badge>
          <Badge variant="destructive">Destructive</Badge>
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
