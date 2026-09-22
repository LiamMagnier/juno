"use client";

import * as React from "react";
import Link from "next/link";
import { Upload } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { LibraryBrowserSkeleton, LibraryGrid, LibraryList } from "@/components/library/library-browser";
import { LibraryDropOverlay } from "@/components/library/library-drop-zone";
import { LibraryStorageCaption, LibraryToolbar } from "@/components/library/library-toolbar";
import type {
  LibraryItem,
  LibraryKind,
  LibrarySort,
  LibraryUpload,
  LibraryView,
} from "@/components/library/library-types";
import { ModelQuickMenu } from "@/components/chat/model-selector";
import { ReasoningSlider } from "@/components/chat/reasoning-slider";
import { MODELS, type ModelId } from "@/lib/models";
import { AUTO_MODEL_ID } from "@/lib/auto-model";
import { reasoningOptions, type ReasoningEffort } from "@/lib/model-metrics";
import { ActionIcons, AppIcons } from "@/lib/app-icons";

/* ── Fixtures ─────────────────────────────────────────────────────────── */

const DAY = 86_400_000;
// Rounded to the hour so the server render and the client's hydration compute
// the same timestamps; a millisecond apart, every `dateTime` would mismatch.
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

/** A flat picture as an SVG data URL, so image rows have something to show without a network. */
function picture(from: string, to: string, shape: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 320 320"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="320" height="320" fill="url(#g)"/>${shape}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const base = {
  version: 1,
  versionCount: 0,
  origin: "upload",
  parserState: "ready",
  parserVersion: null,
  deletedAt: null,
  knowledge: null,
  conversationId: null,
} satisfies Partial<LibraryItem>;

const ITEMS: LibraryItem[] = [
  {
    ...base,
    id: "fx-1",
    kind: "IMAGE",
    fileName: "Kitchen moodboard.png",
    mimeType: "image/png",
    size: 2_480_000,
    url: picture("#d9c7ae", "#8f7a64", '<circle cx="210" cy="120" r="54" fill="#f4ede3" opacity=".8"/><rect x="40" y="200" width="240" height="80" rx="8" fill="#5b4a3a" opacity=".5"/>'),
    createdAt: ago(0.2),
    conversationId: "c-1",
  },
  {
    ...base,
    id: "fx-2",
    kind: "FILE",
    fileName: "Q3 board report.pdf",
    mimeType: "application/pdf",
    size: 4_120_000,
    url: "#",
    createdAt: ago(1),
    versionCount: 2,
    conversationId: "c-2",
  },
  {
    ...base,
    id: "fx-3",
    kind: "FILE",
    fileName: "Scanned lease agreement.pdf",
    mimeType: "application/pdf",
    size: 9_870_000,
    url: "#",
    createdAt: ago(2),
    knowledge: {
      state: "failed",
      error: "This PDF has no text layer, so it can’t be searched.",
      blockCount: 0,
      pageCount: 12,
    },
  },
  {
    ...base,
    id: "fx-4",
    kind: "FILE",
    fileName: "pricing_model_v4.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: 312_000,
    url: "#",
    createdAt: ago(3),
    knowledge: { state: "indexing", error: null, blockCount: 0, pageCount: null },
  },
  {
    ...base,
    id: "fx-5",
    kind: "FILE",
    fileName: "stream-parser.ts",
    mimeType: "text/plain",
    size: 18_400,
    url: "#",
    createdAt: ago(6),
    conversationId: "c-3",
  },
  {
    ...base,
    id: "fx-6",
    kind: "IMAGE",
    fileName: "Onboarding flow, step 2.jpg",
    mimeType: "image/jpeg",
    size: 1_160_000,
    url: picture("#b8c4c9", "#56666e", '<rect x="70" y="50" width="180" height="220" rx="18" fill="#eef2f3"/><rect x="92" y="82" width="136" height="12" rx="6" fill="#56666e" opacity=".5"/><rect x="92" y="106" width="96" height="12" rx="6" fill="#56666e" opacity=".3"/>'),
    createdAt: ago(9),
  },
  {
    ...base,
    id: "fx-7",
    kind: "FILE",
    fileName: "Interview notes, product research.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    size: 86_000,
    url: "#",
    createdAt: ago(21),
    knowledge: {
      state: "degraded",
      error: "Two embedded tables couldn’t be read.",
      blockCount: 40,
      pageCount: 6,
    },
  },
  {
    ...base,
    id: "fx-8",
    kind: "FILE",
    fileName: "customers-2026.csv",
    mimeType: "text/csv",
    size: 2_200_000,
    url: "#",
    createdAt: ago(64),
  },
];

const UPLOADS: LibraryUpload[] = [
  { localId: "up-1", fileName: "Brand guidelines 2026.pdf", size: 14_600_000, kind: "FILE", progress: 42, status: "uploading" },
  {
    localId: "up-2",
    fileName: "Team offsite.jpg",
    size: 3_400_000,
    kind: "IMAGE",
    progress: 100,
    status: "uploading",
    previewUrl: picture("#c9b59a", "#6c7a5a", '<path d="M0 230 L110 150 L190 210 L320 120 L320 320 L0 320 Z" fill="#3f4a35" opacity=".6"/>'),
  },
  {
    localId: "up-3",
    fileName: "Recording.mov",
    size: 212_000_000,
    kind: "FILE",
    progress: 0,
    status: "failed",
    error: "This file is larger than your plan allows.",
    retryable: false,
  },
  {
    localId: "up-4",
    fileName: "Research summary.md",
    size: 22_000,
    kind: "FILE",
    progress: 0,
    status: "failed",
    error: "Couldn’t reach Juno. Check your connection.",
    retryable: true,
  },
];

const STORAGE = { usedBytes: 1_240_000_000, quotaBytes: 10_737_418_240, remainingBytes: 9_497_418_240 };

const FAVORITE_MODELS: ModelId[] = ["anthropic:claude-opus-5-5", "openai:gpt-6-sol"];
const RECENT_MODELS: ModelId[] = ["anthropic:claude-sonnet-5", "google:gemini-3.8-flash"];

/* ── Gallery ──────────────────────────────────────────────────────────── */

function Section({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-border pt-6">
      <h2 className="text-heading">{title}</h2>
      <p className="mt-1 max-w-prose text-body text-muted-foreground">{note}</p>
      <div className="mt-6">{children}</div>
    </section>
  );
}

function useFixtureLibrary() {
  const [items, setItems] = React.useState(ITEMS);
  const [uploads, setUploads] = React.useState(UPLOADS);
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set(["fx-6"]));
  const toggle = (id: string) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return {
    items,
    uploads,
    selected,
    deletedView: false,
    stagger: false,
    onToggleSelect: toggle,
    onToggleAll: () =>
      setSelected((previous) => (previous.size === items.length ? new Set() : new Set(items.map((item) => item.id)))),
    onRename: () => undefined,
    onDelete: (item: LibraryItem) => setItems((previous) => previous.filter((row) => row.id !== item.id)),
    onRestore: () => undefined,
    onVersions: () => undefined,
    onRetryUpload: (localId: string) =>
      setUploads((previous) =>
        previous.map((upload) =>
          upload.localId === localId ? { ...upload, status: "uploading", progress: 8, error: undefined } : upload,
        ),
      ),
    onDismissUpload: (localId: string) => setUploads((previous) => previous.filter((upload) => upload.localId !== localId)),
  };
}

function ModelMenuFixture({ favorites, recent, value }: { favorites: ModelId[]; recent: ModelId[]; value: ModelId }) {
  const [current, setCurrent] = React.useState<ModelId>(value);
  const [effort, setEffort] = React.useState<ReasoningEffort | null>(null);
  const models = [...favorites, ...recent, current]
    .filter((id, index, all) => all.indexOf(id) === index)
    .map((id) => MODELS[id])
    .filter((model) => !!model);
  const currentModel = MODELS[current];
  const options = currentModel ? reasoningOptions(currentModel) : [];
  return (
    // The popover's own shell, drawn in place: the real one is portalled and
    // anchored to a composer chip this page does not have.
    <div className="surface-float overlay-glass w-72 rounded-menu p-1">
      <ModelQuickMenu
        models={models}
        showAuto
        value={current}
        isLocked={(model) => model.minPlan === "MAX"}
        onPick={(model) => setCurrent(model.id)}
        onMore={() => undefined}
        initialFocus="none"
        thinking={
          options.length > 1 ? (
            <ReasoningSlider options={options} value={effort ?? options[Math.min(2, options.length - 1)].value} onChange={setEffort} />
          ) : undefined
        }
      />
    </div>
  );
}

export function LibraryGallery() {
  const library = useFixtureLibrary();
  const [query, setQuery] = React.useState("");
  const [kind, setKind] = React.useState<LibraryKind>("all");
  const [sort, setSort] = React.useState<LibrarySort>("newest");
  const [view, setView] = React.useState<LibraryView>("list");
  const allSelected = library.items.length > 0 && library.items.every((item) => library.selected.has(item.id));

  return (
    // `app-main-canvas` is what makes the `@container page` queries resolve,
    // exactly as they do inside the app shell.
    <main className="app-main-canvas min-h-dvh">
      <AppPage measure="wide" scroll={false} contentClassName="space-y-12">
        <div>
          <AppPageHeader
            heading="Files"
            lede="Everything you upload or share in chats."
            actions={
              <>
                <LibraryStorageCaption storage={STORAGE} className="hidden sm:block" />
                <Button variant="secondary" size="sm">
                  <ActionIcons.delete className="size-3.5" />
                  Recently deleted
                </Button>
                <Button size="sm">
                  <Upload className="size-3.5" />
                  Upload
                </Button>
              </>
            }
          />
          <LibraryToolbar
            query={query}
            onQueryChange={setQuery}
            searching={query.length > 0}
            kind={kind}
            onKindChange={setKind}
            counts={{ all: 128, IMAGE: 41, FILE: 87 }}
            sort={sort}
            onSortChange={setSort}
            view={view}
            onViewChange={setView}
            selectToggle={view === "grid" ? { allSelected, onToggle: library.onToggleAll } : undefined}
          />
          <div className="mt-5">
            {view === "grid" ? <LibraryGrid {...library} /> : <LibraryList {...library} />}
          </div>
        </div>

        <Section title="Grid" note="The same rows as tiles: a picture and a caption, no card. The selected tile carries the accent ring.">
          <LibraryGrid {...library} />
        </Section>

        <Section title="Drop overlay" note="Shown while files are held over the page. Depth-counted, so crossing between rows does not blink it.">
          <div className="relative h-[26rem] overflow-hidden">
            <LibraryList {...library} uploads={[]} />
            <LibraryDropOverlay open />
          </div>
        </Section>

        <Section title="Empty and loading" note="The first run, and the list's placeholder while the first page is out.">
          <EmptyState
            icon={AppIcons.library}
            title="No files yet"
            description="Upload files here, or drop them anywhere on this page. Files you share in chats are kept here too."
            action={
              <>
                <Button size="sm">
                  <Upload className="size-3.5" />
                  Upload files
                </Button>
                <Button variant="ghost" size="sm" asChild className="text-muted-foreground">
                  <Link href="/chat">Go to chat</Link>
                </Button>
              </>
            }
          />
          <div className="mt-8">
            <LibraryBrowserSkeleton view="list" />
          </div>
        </Section>

        <Section title="Model picker, stage one" note="Auto, favourites, recents and the current model, then More models, then thinking. Arrow keys, Home, End and typeahead move the highlight.">
          <div className="flex flex-wrap items-start gap-8">
            <ModelMenuFixture favorites={FAVORITE_MODELS} recent={RECENT_MODELS} value="anthropic:claude-opus-5-5" />
            <ModelMenuFixture favorites={[]} recent={[]} value={AUTO_MODEL_ID} />
          </div>
        </Section>
      </AppPage>
    </main>
  );
}
