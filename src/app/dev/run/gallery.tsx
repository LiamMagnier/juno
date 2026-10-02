"use client";

import * as React from "react";
import { useTheme } from "next-themes";

import { Markdown } from "@/components/chat/markdown";
import { RunAnnouncer } from "@/components/chat/run/run-announcer";
import { RunBlock } from "@/components/chat/run/run-block";
import { RunGlyph } from "@/components/chat/run/run-glyph";
import { ACCENT_IDS, type AccentId } from "@/lib/accents";
import type { LiveMessage } from "@/lib/chat/live-message";
import { UiLocaleOverride } from "@/lib/i18n-format";
import { loadCatalog, translationStore } from "@/lib/i18n-phrase";
import { RUN_COPY, type RunCopyKey } from "@/lib/run/presentation";
import { liveAnswerText } from "@/lib/run/provisional-text";
import { useLiveAnswerState } from "@/lib/run/store";
import { cn } from "@/lib/utils";

import { RUN_PHRASES_DE } from "./copy-de";
import { runFixtures, type FixtureResult, type RunFixture } from "./fixtures";
import { RunPanelStates } from "./panel-states";
import { PLAYER_SPEEDS, createPlayer, restingMessage, type Player, type PlayerSnapshot } from "./player";

/*
 * `/dev/run`: every fixture of SPEC §11.1 on the real run block.
 *
 * The frames come from the server's `TurnStream` (fixtures.ts) and are applied
 * by the client's reducer (player.ts), so what plays here is what the
 * transcript would show. In wave 1 the block renders under a minimal
 * transcript stub: a user line, the run block, the answer body reading the
 * live-answer store. The "real MessageList" mode, which fixture 21 needs,
 * comes with the client integration (WS9b).
 *
 * The assertions are measured, not asserted in code: the number of running
 * animations (≤ 20), the number of `[data-run-loop-owner]` elements (exactly
 * one while anything works), and the layout shift after the first answer
 * text (0 expected).
 */

type Width = 375 | 800 | 1440;

const WIDTHS: Width[] = [375, 800, 1440];

/** Only fixtures that can be played in the wave-1 mount; 21 waits for the MessageList mode. */
function fixtureLabel(result: FixtureResult): string {
  const number = result.ok ? result.fixture.number : result.number;
  const title = result.ok ? result.fixture.title : result.title;
  return `${number}. ${title}`;
}

function useDocumentAttribute(name: "data-accent", value: string | null) {
  React.useEffect(() => {
    if (value === null) return;
    const root = document.documentElement;
    const previous = root.getAttribute(name);
    root.setAttribute(name, value);
    return () => {
      if (previous === null) root.removeAttribute(name);
      else root.setAttribute(name, previous);
    };
  }, [name, value]);
}

function useRootFontSize(px: number) {
  React.useEffect(() => {
    const root = document.documentElement;
    const previous = root.style.fontSize;
    root.style.fontSize = `${px}px`;
    return () => {
      root.style.fontSize = previous;
    };
  }, [px]);
}

/** Seeds the translation store with the checked-in German, under the catalog's ids. */
function useGermanFixtures(active: boolean) {
  React.useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void loadCatalog().then(({ sourceCatalog }) => {
      if (cancelled) return;
      const entries: Record<string, string> = {};
      for (const [key, german] of Object.entries(RUN_PHRASES_DE) as Array<[RunCopyKey, string]>) {
        const item = sourceCatalog.get(RUN_COPY[key]);
        if (item) entries[item.id] = german;
      }
      translationStore.seed("de", entries);
    });
    return () => {
      cancelled = true;
    };
  }, [active]);
}

/** Live counters for the three on-screen assertions. */
function useAssertions(resetKey: string, answerVisible: boolean) {
  const [animations, setAnimations] = React.useState(0);
  const [owners, setOwners] = React.useState(0);
  const [shift, setShift] = React.useState(0);
  React.useEffect(() => {
    const sample = () => {
      setAnimations(typeof document.getAnimations === "function" ? document.getAnimations().length : 0);
      setOwners(document.querySelectorAll("[data-run-loop-owner]").length);
    };
    sample();
    const timer = setInterval(sample, 500);
    return () => clearInterval(timer);
  }, []);
  React.useEffect(() => {
    setShift(0);
    if (!answerVisible || typeof PerformanceObserver === "undefined") return;
    let total = 0;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Array<PerformanceEntry & { value?: number; hadRecentInput?: boolean }>) {
        if (!entry.hadRecentInput) total += entry.value ?? 0;
      }
      setShift(total);
    });
    try {
      observer.observe({ type: "layout-shift", buffered: false });
    } catch {
      return;
    }
    return () => observer.disconnect();
  }, [answerVisible, resetKey]);
  return { animations, owners, shift };
}

function AnswerBody({ message, streaming }: { message: LiveMessage; streaming: boolean }) {
  const renderKey = message.renderKey ?? message.id;
  const state = useLiveAnswerState(renderKey);
  const text = streaming ? liveAnswerText(message, state) : message.content;
  if (!text) return null;
  return <Markdown content={text} streaming={streaming} sources={message.sources} />;
}

/** A live Research row stand-in (fixture 25): WS8's row claims the loop at priority 4 the same way. */
function ResearchRowStub() {
  return (
    <div className="flex min-h-9 items-center gap-2.5 rounded-card border border-border/60 px-3 text-ui text-muted-foreground">
      <RunGlyph phase="searching" loopId="dev-run:research-row" claim={4} />
      <span>Research row stand-in, searching</span>
    </div>
  );
}

function Toggle<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-caption text-muted-foreground">
      <span>{label}</span>
      <select
        className="rounded-field border border-border bg-background px-1.5 py-0.5 text-caption text-foreground"
        value={String(value)}
        onChange={(event) => {
          const next = options.find((option) => String(option) === event.target.value);
          if (next !== undefined) onChange(next);
        }}
      >
        {options.map((option) => (
          <option key={String(option)} value={String(option)}>
            {String(option)}
          </option>
        ))}
      </select>
    </label>
  );
}

function ControlButton({ onClick, children, disabled }: { onClick: () => void; children: React.ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-field border border-border px-2 py-1 text-caption text-foreground hover:bg-accent disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function Transcript({
  fixture,
  snapshot,
  earlier,
  researchRow,
  onOpenPanel,
}: {
  fixture: RunFixture;
  snapshot: PlayerSnapshot;
  earlier: LiveMessage | null;
  researchRow: boolean;
  onOpenPanel: () => void;
}) {
  const { message, streaming } = snapshot;
  const renderKey = message.renderKey ?? message.id;
  return (
    // `--fav-ring` is the ground the favicon stack sits on: the transcript's background.
    <div className="flex flex-col gap-6" style={{ "--fav-ring": "var(--background)" } as React.CSSProperties}>
      {earlier ? (
        <article data-message-id={earlier.id} className="flex flex-col gap-2">
          <RunBlock message={earlier} renderKey={earlier.renderKey ?? earlier.id} streaming={false} status="idle" onOpenPanel={onOpenPanel} />
          <AnswerBody message={earlier} streaming={false} />
        </article>
      ) : null}
      {researchRow ? <ResearchRowStub /> : null}
      <div className="ms-auto max-w-[80%] rounded-card bg-secondary px-4 py-2.5 text-body">{fixture.title}</div>
      <article data-message-id={message.id} aria-busy={streaming || undefined} className="flex flex-col gap-2">
        <RunBlock message={message} renderKey={renderKey} streaming={streaming} status={streaming ? "thinking" : "idle"} onOpenPanel={onOpenPanel} />
        <AnswerBody message={message} streaming={streaming} />
        {!streaming && message.error ? (
          <p role="alert" className="rounded-card border border-warning/50 bg-warning/10 px-3 py-2 text-ui text-warning-foreground">
            {message.errorMessage ?? message.content}
          </p>
        ) : null}
      </article>
    </div>
  );
}

export function RunGallery({ initialFixture }: { initialFixture: number }) {
  const fixtures = React.useMemo(() => runFixtures(), []);
  const [selected, setSelected] = React.useState(initialFixture);
  const [width, setWidth] = React.useState<Width>(800);
  const [locale, setLocale] = React.useState<"en" | "de">("en");
  const [dir, setDir] = React.useState<"ltr" | "rtl">("ltr");
  const [accent, setAccent] = React.useState<AccentId>("coral");
  const [rootSize, setRootSize] = React.useState<16 | 20>(16);
  const [reduced, setReduced] = React.useState(false);
  const [panelOpen, setPanelOpen] = React.useState(false);
  const { resolvedTheme, setTheme } = useTheme();

  useDocumentAttribute("data-accent", accent);
  useRootFontSize(rootSize);
  useGermanFixtures(locale === "de");

  const result = fixtures.find((candidate) => (candidate.ok ? candidate.fixture.number : candidate.number) === selected) ?? fixtures[0];
  const fixture = result.ok ? result.fixture : null;

  const [snapshot, setSnapshot] = React.useState<PlayerSnapshot | null>(null);
  const player = React.useRef<Player | null>(null);
  React.useEffect(() => {
    if (!fixture) {
      setSnapshot(null);
      return;
    }
    const created = createPlayer(fixture, setSnapshot);
    player.current = created;
    // Fixture 20 opens on the panel: the live run's panel row owns the loop.
    setPanelOpen(fixture.number === 20 || fixture.number === 26);
    return () => {
      created.dispose();
      player.current = null;
    };
  }, [fixture]);

  // Fixture 20: an earlier, finished run in the same list.
  const earlier = React.useMemo(() => {
    if (!fixture || fixture.number !== 20) return null;
    const four = fixtures.find((candidate) => candidate.ok && candidate.fixture.number === 4);
    return four?.ok ? { ...restingMessage(four.fixture), id: "msg_earlier", renderKey: "run-fixture-earlier" } : null;
  }, [fixture, fixtures]);

  const renderKey = snapshot ? snapshot.message.renderKey ?? snapshot.message.id : null;
  const answerVisible = Boolean(snapshot?.streaming && snapshot.message.content.trim());
  const assertions = useAssertions(`${selected}:${snapshot?.mode === "reloaded"}`, answerVisible);
  const working = Boolean(snapshot?.streaming);

  return (
    <UiLocaleOverride.Provider value={locale}>
      <div className="mx-auto flex max-w-[1600px] flex-col gap-4 p-4" data-motion={reduced ? "reduce" : undefined} dir={dir}>
        <header className="flex flex-wrap items-center gap-3">
          <h1 className="font-sans text-heading text-foreground">Run UI</h1>
          <select
            className="rounded-field border border-border bg-background px-2 py-1 text-ui"
            value={selected}
            onChange={(event) => setSelected(Number(event.target.value))}
          >
            {fixtures.map((candidate) => {
              const number = candidate.ok ? candidate.fixture.number : candidate.number;
              return (
                <option key={number} value={number}>
                  {fixtureLabel(candidate)}
                </option>
              );
            })}
          </select>
          <ControlButton onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}>
            {resolvedTheme === "dark" ? "Light" : "Dark"}
          </ControlButton>
          <Toggle label="Width" value={width} options={WIDTHS} onChange={setWidth} />
          <Toggle label="Locale" value={locale} options={["en", "de"] as const} onChange={setLocale} />
          <Toggle label="Direction" value={dir} options={["ltr", "rtl"] as const} onChange={setDir} />
          <Toggle label="Accent" value={accent} options={ACCENT_IDS} onChange={setAccent} />
          <Toggle label="Text size" value={rootSize} options={[16, 20] as const} onChange={setRootSize} />
          <label className="flex items-center gap-1.5 text-caption text-muted-foreground">
            <input type="checkbox" checked={reduced} onChange={(event) => setReduced(event.target.checked)} />
            <span>Simulate reduced motion</span>
          </label>
          <label className="flex items-center gap-1.5 text-caption text-muted-foreground">
            <input type="checkbox" checked={panelOpen} onChange={(event) => setPanelOpen(event.target.checked)} />
            <span>Panel</span>
          </label>
        </header>

        {fixture && snapshot ? (
          <div className="flex flex-wrap items-center gap-2">
            <ControlButton onClick={() => player.current?.play()} disabled={snapshot.mode === "playing" || snapshot.index >= snapshot.total}>
              Play
            </ControlButton>
            <ControlButton onClick={() => player.current?.pause()} disabled={snapshot.mode !== "playing"}>
              Pause
            </ControlButton>
            <ControlButton onClick={() => player.current?.step()} disabled={snapshot.index >= snapshot.total}>
              Step
            </ControlButton>
            <Toggle label="Speed" value={snapshot.speed} options={PLAYER_SPEEDS} onChange={(speed) => player.current?.setSpeed(speed)} />
            <input
              type="range"
              aria-label="Frame"
              min={0}
              max={snapshot.total}
              value={snapshot.index}
              onChange={(event) => player.current?.scrub(Number(event.target.value))}
              className="w-56"
            />
            <span className="font-mono text-micro tabular-nums text-muted-foreground">
              {snapshot.index}/{snapshot.total}
            </span>
            <ControlButton onClick={() => player.current?.burst()} disabled={snapshot.index >= snapshot.total}>
              Burst
            </ControlButton>
            <ControlButton onClick={() => player.current?.stress()} disabled={snapshot.index >= snapshot.total}>
              100 frames/s
            </ControlButton>
            <ControlButton onClick={() => player.current?.reload()}>Reload</ControlButton>
          </div>
        ) : null}

        <dl className="flex flex-wrap gap-x-6 gap-y-1 font-mono text-micro text-muted-foreground">
          <div className={cn(assertions.animations > 20 && "text-warning-foreground")}>
            <dt className="inline">animations </dt>
            <dd className="inline tabular-nums">{assertions.animations} / 20</dd>
          </div>
          <div className={cn(working && assertions.owners !== 1 && "text-warning-foreground")}>
            <dt className="inline">loop owners </dt>
            <dd className="inline tabular-nums">{assertions.owners}</dd>
          </div>
          <div className={cn(assertions.shift > 0 && "text-warning-foreground")}>
            <dt className="inline">layout shift after the first answer text </dt>
            <dd className="inline tabular-nums">{assertions.shift.toFixed(4)}</dd>
          </div>
        </dl>

        <div className="flex min-w-0 gap-4">
          <div
            className="@container/split min-w-0 rounded-card border border-border/60 bg-background p-4"
            style={{ inlineSize: width, maxInlineSize: "100%" }}
          >
            {!result.ok ? (
              <p className="text-ui text-warning-foreground">
                This fixture cannot play yet: {result.error}. Its frames come from the server&apos;s TurnStream, which lands with WS4.
              </p>
            ) : fixture?.needsMessageList ? (
              <p className="text-ui text-muted-foreground">
                The research hand-off needs the real MessageList mode, which comes with the client integration (WS9b).
              </p>
            ) : fixture && snapshot ? (
              <Transcript
                fixture={fixture}
                snapshot={snapshot}
                earlier={earlier}
                researchRow={fixture.number === 25}
                onOpenPanel={() => setPanelOpen(true)}
              />
            ) : null}
            <RunAnnouncer streamingRenderKey={working ? renderKey : null} panelCoversChat={panelOpen && width < 800} />
          </div>
          <RunPanelStates
            open={panelOpen}
            renderKey={renderKey}
            mode={width < 800 ? "sheet" : "column"}
            onClose={() => setPanelOpen(false)}
          />
        </div>
      </div>
    </UiLocaleOverride.Provider>
  );
}
