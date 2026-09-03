# Juno — Complete Documentation

Juno is a production-grade, multimodal AI chat website: streaming chat across a
large catalog of models, durable conversation history, long-term memory, a Canvas
for live artifacts, file/image/PDF uploads, tool connectors (MCP), read-aloud +
dictation + realtime speech-to-speech voice, cloud & device "Code" agent sessions,
agentic "Work" tasks that plan themselves and stop to ask,
an interface that auto-translates itself, and Stripe billing with server-side plan
gating.

This is the single source of truth for how the **website** works — design,
front-end, back-end, data model, security, configuration, and deployment. It also
documents the versioned `/api/v1` backend contract that the separate native apps
consume, because that contract is part of this repo's backend; it does **not**
document the native clients themselves.

> **Stack:** Next.js 15 (App Router) · TypeScript · Tailwind CSS v3.4 · shadcn/ui ·
> Prisma 6 + PostgreSQL · NextAuth v5 (Auth.js) · Anthropic SDK + 13
> OpenAI-compatible providers · Stripe · AWS SDK v3 (S3-compatible storage) · a
> standalone WebSocket voice relay (`relay/`) · a vendored agent core for cloud
> Code (`runner/`).

---

## Table of contents

1. [Architecture at a glance](#1-architecture-at-a-glance)
2. [Repository layout](#2-repository-layout)
3. [Design system](#3-design-system)
4. [Front-end architecture](#4-front-end-architecture)
5. [The chat / generation pipeline](#5-the-chat--generation-pipeline)
6. [Models & generation](#6-models--generation)
7. [Memory](#7-memory)
8. [Tool connectors (MCP)](#8-tool-connectors-mcp)
9. [Code: device sessions, remote control & cloud runs](#9-code-device-sessions-remote-control--cloud-runs)
10. [Voice](#10-voice)
11. [Billing, plans, usage & rate limiting](#11-billing-plans-usage--rate-limiting)
12. [Moderation & admin](#12-moderation--admin)
13. [Storage & uploads](#13-storage--uploads)
14. [Product features](#14-product-features)
15. [Authentication & accounts](#15-authentication--accounts)
16. [Native sync API (`/api/v1`)](#16-native-sync-api-apiv1)
17. [Data model](#17-data-model)
18. [Security](#18-security)
19. [Configuration & environment variables](#19-configuration--environment-variables)
20. [Deployment & operations](#20-deployment--operations)
21. [Development: scripts & tests](#21-development-scripts--tests)

Plus **[§9b Work: tasks, runs, plans & approvals](#9b-work-tasks-runs-plans--approvals)**,
which sits between 9 and 10. It carries a letter rather than a number for the same reason
§3.4b and §20.2b do: it was written after the numbering was set, and renumbering twelve
sections would break every anchor anyone has linked to.

---

## 1. Architecture at a glance

Juno is a single Next.js application. Every API route is a Next.js **route handler**
under `src/app/api`; almost all run on the Node.js runtime (`export const runtime =
"nodejs"`). There is **no separate API service** — the same process serves the UI
(React Server Components + client components) and the JSON/SSE API.

Two long-running side services accompany it, both managed by PM2 in production:

- **Voice relay** (`relay/`) — a standalone WebSocket server on `:8787` that holds
  the realtime speech-to-speech provider sessions. It cannot run on serverless
  (long-lived sockets), so it lives beside the app.
- **Scheduled-task runner** (`scripts/scheduled-task-runner.ts`) — a worker that
  claims due `ScheduledTask` rows every 60 s and runs them through the model.

```
                         ┌─────────────────────────────────────────────┐
   Browser / native app  │  nginx (443, TLS)                            │
        │                │   ├── /voice-relay  → ws://127.0.0.1:8787    │
        ▼                │   └── /            → http://127.0.0.1:3000   │
  Vercel/Cloudflare      │                                              │
  (optional UI front) ── │  PM2:                                        │
   /api/* rewrite ─────► │   • juno-backend   (Next.js, :3000)          │
                         │   • juno-voice-relay (relay/, :8787)         │
                         │   • juno-scheduler (tasks:runner)            │
                         └───────────────┬──────────────────────────────┘
                                         │
             ┌───────────────────────────┼─────────────────────────────┐
             ▼                           ▼                             ▼
      PostgreSQL (Neon/Supabase)   S3-compatible bucket        AI providers
      Prisma 6                     (R2 / S3 / Supabase /        (Anthropic native +
      change-capture triggers      MinIO) or local .uploads     13 OpenAI-compat
                                                                over server keys)
```

**Two deployment shapes** are supported (see §20):

1. **UI on Vercel/Cloudflare, API on a VM.** `next.config.mjs` rewrites `/api/*`
   to `RENDER_BACKEND_URL` (the VM), so long reasoning streams bypass serverless
   request timeouts. Cookies are shared cross-subdomain via `COOKIE_DOMAIN`, or
   the whole `/api/` path is routed to the VM via Cloudflare (zero-CORS).
2. **Everything on the VM** (Oracle Cloud / GCP always-free), with nginx →
   Next.js. This is the reference production setup (`chat.liams.dev`).

Because the VM has no per-request timeout, the chat SSE stream can run for as long
as a max-effort reasoning run needs; a 15 s heartbeat keeps nginx's
`proxy_read_timeout` (3600 s) from closing the connection.

---

## 2. Repository layout

```
prisma/schema.prisma        Data model (48 models, 13 enums) + migrations/
src/
  app/
    (auth)/                 sign-in, sign-up, forgot/reset-password
    (app)/                  authenticated shell: chat, projects, memory, code,
                            connections, compare, library, artifacts, tasks,
                            roadmap, profile, settings, upgrade, admin/*
    (legal)/                CGU, privacy, legal notices (French)
    api/                    127 route handlers (see per-section endpoint tables)
    app-auth/               browser side of the native PKCE device-authorization flow
    share/[token]/          public read-only share pages (no auth)
    suspended/              banned-account landing
    layout.tsx globals.css  root layout + all design tokens
  components/
    ui/                     shadcn-style primitives (button, dialog, select, …)
    app/                    shell, sidebar, provider/useApp, command palette
    chat/                   composer, message list/item, markdown, thought panel,
      learning/             inline learning-block renderers
    canvas/                 canvas panel + sandboxed artifact renderer
    voice/                  realtime voice dock
    work/                   Work threads: composer, plan/timeline, decisions,
      voice/                a voice session briefed on one Work task (§9b, §10.2)
    signature/              dot/ASCII brand system (DotField, ThinkingDots, …)
    connections/ memory/ tasks/ roadmap/ compare/ share/ admin/ settings/ landing/ brand/ i18n/
  hooks/                    use-chat, use-uploads, use-realtime-voice, use-tts,
                            use-speech-recognition, use-code-session
  lib/                      all backend logic (see below)
  types/                    shared TS types (chat stream, etc.)
relay/                      standalone realtime-voice WebSocket service
runner/agent-core/          vendored @juno/agent-core for the cloud Code runner
scripts/                    model sync, benchmarks, task runner, sync pruning, tests
deploy/                     deploy.sh, ecosystem.config.js (PM2), nginx template, VM guides
contracts/openapi/          juno-native-v1.yaml — the /api/v1 OpenAPI contract
docs/JUNO.md                this document
```

Key `src/lib` modules: `auth.ts` / `session.ts` / `native-auth*.ts` (auth),
`anthropic.ts` / `llm.ts` / `openai-compat.ts` / `openai-responses.ts` (providers),
`models.ts` / `model-metrics.ts` / `pricing.ts` / `auto-model.ts` (model registry),
`memory.ts`, `connectors.ts` / `mcp.ts` / `mcp-oauth.ts`, `code-remote*.ts` /
`cloud-code*.ts` / `github-oidc.ts` (Code), `work/*` (the Work vocabulary, store, relay,
skills, connectors and approvals — §9b), `plans.ts` / `usage.ts` / `spend.ts` /
`stripe.ts` / `rate-limit.ts` (billing), `moderation*.ts`, `storage.ts`,
`message-crypto.ts` (at-rest encryption), `sync-*.ts` (native sync).

---

## 3. Design system

Juno's identity is **Soft UI** — one warm material cut to three depths, calm and
tactile — with a monospace **dot/ASCII** signature layer. The brief is
`docs/design/SOFT_UI.md` and it is authoritative where this section is silent.
All tokens are CSS variables in `src/app/globals.css`; Tailwind maps them in
`tailwind.config.ts`; `npm run design:tokens` projects colour, motion and radius
onto `src/lib/design/tokens.generated.ts` and the Swift package, and
`design:tokens:check` fails CI when a client drifts. Never hardcode hex in
components.

### 3.1 Color (HSL, theme-aware)

Defined for `:root` (light) and `.dark`. Values below are the live tokens.

| Token | Light | Dark | Role |
|---|---|---|---|
| `--background` | `50 22% 96%` | `30 7% 9%` | Page — warm paper / warm charcoal (never true black: dual shadows need a ground) |
| `--foreground` | `48 3% 12%` | `45 12% 96%` | Text |
| `--card` | `50 30% 98%` | `30 7% 12%` | Raised surfaces |
| `--popover` | `50 30% 98.5%` | `30 7% 14%` | Floating surfaces |
| `--secondary` / `--muted` | `48 22% 93%` | `30 6% 15%` | Recessed fills |
| `--accent` | `48 24% 90%` | `30 6% 18%` | Hover fill |
| `--primary` | `15 54% 46%` | `15 54% 46%` | **Coral** accent (`--primary-ink` is the AA text ramp) |
| `--muted-foreground` | `48 4% 40%` | `40 6% 66%` | Secondary labels (≥ 4.5:1 on every reading ground) |
| `--destructive` | `11 51% 48%` | `11 51% 49.5%` | Error (`--destructive-ink` for text) |
| `--success` | `140 33% 46%` | `140 33% 53%` | Success (`--success-ink` for text; dark `--success-foreground` is the ground) |
| `--warning` | `40 57% 45%` | `40 60% 58%` | Warning fill; `--warning-foreground` (`40 57% 33%` / `40 70% 72%`) is the text ramp |
| `--source` | `187 62% 34%` | `187 58% 49%` | Source / info (teal) |
| `--border` | `46 18% 86%` | `30 6% 20%` | Hairlines |
| `--ring` | `15 54% 46%` | `45 6% 80%` | Focus ring |
| `--sidebar` | `48 20% 94%` | `30 7% 8%` | The sidebar well (a step below the page) |

**Six swappable accents** set via `[data-accent]` on `<html>` (drive `--primary`,
`--ring`, `--primary-foreground`, `--primary-ink`): `coral` (default), `juniper`,
`teal`, `violet`, `amber`, `sage`. Custom `#hex` accents are converted to HSL and
lightness-clamped per theme, then written as inline CSS vars (see
`app-provider.tsx`). Texture atoms: primary-tinted **text selection**
(`hsl(var(--primary)/0.25)`, `/0.4` on dark) and a fixed **film grain** overlay
(`body::after`, `opacity 0.022`, SVG fractal noise, light theme only).

**The depth kit.** Light comes from the top-left. Two inks — `--neu-light`
(`0 0% 100% / .9` light, `45 20% 96% / .07` dark) and `--neu-dark`
(`46 18% 20% / .14` light, `0 0% 0% / .6` dark; the large throw uses the
denser `--neu-dark-lg`, `.2` / `.72`) — make five shadows. Dark raised
surfaces also carry `--sheen` as a 1px rim light along the top edge:

| Token | Recipe | Tailwind |
|---|---|---|
| `--shadow-raised` | `-2 -2 6` light, `3 4 10` dark | `shadow-raised` |
| `--shadow-raised-lg` | `-4 -4 12` light, `6 8 20` dark | `shadow-raised-lg` |
| `--shadow-inset` | inset `2 2 5` dark, inset `-2 -2 5` light | `shadow-inset` |
| `--shadow-pressed` | inset `1 1 3` dark, inset `-1 -1 3` light | `shadow-pressed` |
| `--shadow-float` | `0 1 2` contact + `0 16 40 -20` throw + sheen | `shadow-float` |

Throws are low on purpose (2–6px offsets, 6–20px blur). A neumorphic edge alone
is under 3:1 and fails WCAG 1.4.11, so every surface also draws a hairline in
`--border` at 50–70% alpha, and the primary action keeps real colour.

**Composed surfaces** (`@layer components`, globals.css) are the only way a
component may express depth — a raw `shadow-[…]`, `shadow-2xl` or hand-typed
rgba is a fork of the system:

| Class | Meaning | Used by |
|---|---|---|
| `.surface-raised` | `--card` + `--shadow-raised` + hairline | cards, composer shell, tiles, sidebar active row |
| `.surface-raised-lg` | bigger throw | hero cards, pricing, project tiles |
| `.surface-inset` | `--background` + `--shadow-inset` + hairline | inputs, textareas, search, segmented tracks, sidebar frame, user bubbles, empty states |
| `.surface-float` | `--popover` + `--shadow-float` + sheen | popovers, dropdowns, dialogs, toasts, tooltips, sheets |
| `.overlay-glass` | composes with `.surface-float`: `--popover/.86` + 12px blur; solid under `prefers-reduced-transparency` | menus, popovers, the command palette — chrome only |
| `.control-neu` | raised at rest → pressed inset on `:active` / `[data-state=on]` / `[aria-pressed]` / `[data-selected]` | secondary buttons, icon buttons, toggles, chips, tiles |
| `.control-primary` | flat coral fill + `--shadow-raised` (no tinted glow) | primary buttons, send |
| `.composer-surface` | the composer's one quiet surface: card fill, hairline, one low shadow; focus darkens the edge and lifts it a notch | every composer, via `ComposerShell` |
| `.shimmer-text` | ChatGPT-style thinking shimmer; static muted text under reduced motion | status lines |
| `.check-morph` | copy → check spring | action rows |

`.field-well` and `.glass-raised` survive as aliases of the inset and float
recipes for older call sites. Every primitive in `src/components/ui` is built
on these: Button (`default` = `.control-primary`, `secondary` = `.control-neu`,
`ghost`/`outline` = flat → raised on hover → pressed), Card, Input/Textarea/
Select trigger (inset; focus is the border darkening, no ring), Tabs and
SegmentedControl (inset track, raised thumb), Switch/Checkbox/RadioGroup/Slider/
Progress (inset track, raised coral), Dialog/Popover/DropdownMenu/Select/
Tooltip/Sheet/Sonner (float), Badge, Kbd (inset keycap), IconButton (44px
coarse target on `.control-neu`), Avatar, Separator, ScrollArea, Toggle,
Skeleton, EmptyState (inset dashed well), Pressable (row/tile/chip/icon on
`.control-neu` semantics) and the `AppPage` frame (`measure="reading" 48rem |
"wide" 64rem | "full"`, exported with `AppPageHeader` from
`components/app/app-page.tsx`).

### 3.2 Typography

**Archivo** (`next/font/google`, `--font-sans`) is the whole interface —
controls, headings and the transcript prose — and **JetBrains Mono**
(`--font-mono`) is labels, metadata, ids and code. **Newsreader**
(`--font-serif`, Tailwind `font-serif`, roman + italic) is reserved for the
human moments — the empty-chat greeting, where the name is set in italic — and
never appears at UI size. Hierarchy otherwise comes from size, weight, measure
and spacing, not from switching faces. The scale:
`text-hero`, `text-display`, `text-page-title` (the app `<h1>`), `text-title`
(22px), `text-heading` (18px), `text-body-lg` (17px), `text-body` (15px),
`text-ui` (13px, dense rows and chips), `text-label` (12px eyebrow, 0.10em),
`text-caption` (11px), `text-micro` (10.5px, the mono metadata floor). Eyebrows
pair `text-label`/`text-caption` with `font-mono` in **sentence case** (e.g.
`Memory`, `Thinking`, `Source`, `Tokens`).

**No all-caps anywhere in the UI.** The `uppercase` utility and the wide
letter-spacing that propped it up (`tracking-[0.14em]` and friends) are gone from
every component, page and email template — mono, size and color already separate
a label from body text, and shouting on top of that just made the interface
loud. Mono keeps its wide tracking in exactly one place: the `AsciiWordmark`
logotype. Acronyms that are genuinely capitalized (file extensions, `CGU`,
provider names) are literal strings, not a text transform.

### 3.3 Motion, radius, elevation

- **Motion is physical.** Easings (`--ease-*` in globals.css, mirrored as
  `ease-*` utilities and as `ease.*` in `src/lib/motion.ts`): `spring`
  (`0.34, 1.16, 0.64, 1` — entrances, a ~2% overrun), `drawer` (sheets),
  `out-soft` (the default decelerate), `out-strong`, `out-expo`, `in` (exits),
  `in-out` (A-to-B moves), `breathe` (loops), `out-back` (mass). The duration
  ladder is `press 70` · `fast 120` · `exit 160` · `base 220` · `slow 360` ·
  `emphasis 560` — nothing over 360ms except a deliberate one-shot. Named
  animations: `pop-in/out` (scale .96→1 + fade on the spring — menus, popovers,
  dialogs via `modal-in/out`), `rise-in` (6px + fade), `sheet-in/out` (drawer
  easing, side set by `--sheet-from`), `overlay-in/out` (scrims),
  `shimmer-text`, `check-morph`, `fade-in`, and the `thinking-matrix` reasoning
  cluster. A press dips to 0.97 in 70ms (`.pressable`). Lists stagger with
  `staggerDelay()` at 30–60ms, capped at ten. Reduced motion is tiered
  (globals.css): opacity and colour keep their timing, transforms collapse via
  `--motion-shift` / `--motion-scale-from`, decorative loops stop. `framer-motion`
  (`src/lib/motion.ts`) is for interruptible, physical and layout motion; its
  numbers are derived from the same tokens.
- **Radius ladder** (single source, `tailwind.config.ts`; enforced by
  `design-system/no-arbitrary-radius`): `control 10` · `field 12` · `menu 14` ·
  `card 16` (= `lg` = `surface` = `popover`) · `panel 20` (= `composer`) ·
  `full`. Concentric: outer = inner + padding. `micro 2`, `xs 6`, `md 8` are
  the sub-control steps.
- **Depth** is the kit in §3.1: five shadows, six composed surfaces. The
  transcript stays flat (§3.5). `.skeleton` is a pressed well with a slow
  shimmer; `.scroll-fade-y` and `<ScrollFade>` soften scroll edges.
- **Scroll edges.** Any capped, scrollable region should signal "more this way"
  with a soft edge rather than a hard clip. Two tools: `.scroll-fade-y` (a
  static opacity mask, for reading surfaces like the transcript) and
  `<ScrollFade>` (`components/ui/scroll-fade.tsx`) — a wrapper that renders
  **progressive-blur** bands (`.scroll-fade-edge`, two stacked backdrop-blur
  layers) at the top and bottom, each fading in only when there is more to
  scroll that way. Use `<ScrollFade className="flex-1 min-h-0" viewportClassName="…">`
  as a drop-in for an `overflow-y-auto` child of a flex column (project picker,
  model picker). It gates on `prefers-reduced-transparency` / `-motion`.

Glass is for **chrome only** (menus, popovers, the command palette) — never on
reading surfaces, and never on a dialog, which holds content to be read.
`.overlay-glass` carries the warm `--popover` tint and Juno's own `--sheen` rim
light, never a cool system rim.

**One surface per layer type.** Every floating layer is `.surface-float`:
dialogs at `rounded-panel` (20), popovers/dropdowns/selects at `rounded-popover`
(16, with `.overlay-glass`), toasts at `rounded-card` (16), tooltips at
`rounded-control` (10), sheets with `rounded-panel` on the inner edge. Callers
pass size, padding and position only — a `border-*`, `bg-*`, `shadow-*` or
`backdrop-blur-*` utility on a floating layer is a fork and silently beats the
material. The close button is `<DialogCloseButton>` (a `<Pressable kind="icon">`)
and only its position varies.

### 3.4 Signature language

The dot/ASCII constellation (`src/components/signature/`): `DotField` (interactive
cursor-reactive background grid), `DotMatrixMark` (5×5 logo), `ThinkingDots` (3×3
grid with one moving dark point — the "Juno is thinking" affordance),
`DotIdenticon`-style deterministic avatars, dot-fill quota bars, `DottedDivider`,
and the particle `VoiceOrb`. The new-chat empty state is a serif `EmptyGreeting`
(personalized) and the composer — nothing else. It used to carry a row of
Write/Learn/Build/Decide starter pills that expanded into three canned prompts
each; they were removed, along with their bespoke icon-animation CSS. Compare
still has a home in the command palette. Dots breathe at rest; coral is the only
saturated color in the dot systems.

### 3.4b Streaming motion

A reply arriving is two things: the page following it and the words appearing.

**The follow** (`message-list.tsx`). Auto-scroll with one rule — when new
content arrives, follow the bottom **only if the reader was already at the
bottom before it arrived**. Scroll up and the transcript holds still; return to
within `ATTACH_SLOP_PX` (24px) of the bottom and it resumes. That "was at the
bottom" is measured from the *previous* layout (`prevRef`), captured in a
`useLayoutEffect` and on every scroll — not tracked as a flag by the scroll
handler, because that made following depend on the scroll event firing before
the content render, and a chunk landing in the same tick yanked the view back
onto a reader who had just scrolled away.

Two earlier attempts are worth not repeating. An eased rAF loop (chase the
bottom, close a fraction per frame) looked smoother but put the code and the
reader in a tug-of-war over one `scrollTop`: it needed to know which movements
were its own, that state had to survive a hidden tab where rAF never fires, and
once stuck the transcript stopped following for the rest of the session. And the
re-attach window was once 120px — about one wheel notch — so a reader's own
scroll-up produced a scroll event that landed inside it and re-stuck instantly;
that was the literal "can't scroll up". A reply grows a few pixels per update, so
pinning to the bottom is already smooth with no easing at all. `overflow-anchor:
none` keeps the browser's scroll anchoring from shifting the view under a reader
who has scrolled up. The one animated scroll is "jump to latest" — discrete,
user-initiated, racing nothing — which keeps `behavior: "smooth"`.

**The words** (`.stream-tail`). The line being written sits under a one-line
gradient that bottoms out at 30% alpha, so it arrives soft and firms up as later
lines push it clear. It masks the prose only — over the whole answer body it
would dim the bottom edge of a message ending in an image. It is gated on ~140
characters (past the first wrap at every width): below that the gradient spans
the whole answer, so a short reply would sit dimmed for its life. Fading to zero
rather than 30% ran a gradient through the letterforms, which reads as broken
text. A mask beats animating the tokens — react-markdown rebuilds the trailing
block every chunk, so anything keyed to those nodes restarts dozens of times a
second. There is **no trailing caret/orb**: a coral dot parked under the text was
the loudest thing on the page while a reply arrived, and the fade plus the
composer's stop button already say "still writing".

### 3.5 The flat-transcript law

**Depth, gloss, and glass are for chrome and controls only. The chat transcript
stays flat and calm** (`src/components/chat/message-list.tsx`,
`message-item.tsx`). One centered `max-w-3xl` column: user messages are right-aligned
gently **inset** wells (`USER_BUBBLE_CLASS` in `chat/user-bubble.ts` — `.surface-inset`
at `rounded-card`, shared with the public share page); assistant messages are
full-width markdown prose with no card wrapper. Every embedded structure — code blocks, inline learning
blocks, source pills, artifact cards — uses sparse hairline chrome, "figures set into
a printed article." This keeps the constantly-scrolling list legible and
`backdrop-filter`-free (performance).

### 3.6 Accessibility

Focus ring `2px solid hsl(var(--ring))` at 2px offset for buttons and links.

**Text fields are the exception: no accent, no ring — the border just darkens.**
`Input`, `Textarea` and `SelectTrigger` opt out of the global outline and focus
with `border-foreground/70` and nothing else. They used to carry `ring-[3px]
ring-ring/25` over `border-primary/60`; because browsers grant `:focus-visible`
to text inputs on *pointer* focus and not only keyboard, merely clicking a field
bloomed a wide coral wash that read as an overlay stuck on the box. The same
rule covers the composer's model search and onboarding's memory textarea, and
the Compare composer shell focuses to `border-border` instead of coral.

> That opt-out was first written as `border-foreground/30`, which computes to
> **1.89:1** against `--background` in light and 2.52:1 in dark — below the 3:1
> WCAG 1.4.11 needs for a focus indicator, and *worse* than the 4.08:1 ring it
> replaced. The diagnosis was right and the value overshot. `/70` is 5.95:1
> light and 8.11:1 dark, keeps the no-ring/no-accent decision intact, and cannot
> bloom on pointer focus because it is only a border colour.

**Coral is for state, not for furniture.** The sidebar's resize handle painted a
full-height `bg-primary/60` bar while dragging — the loudest thing on screen for
what is only a drag affordance. It is `bg-foreground/25` now, matching the
canvas and thought-dock grips, which were already neutral.

`coarse:` variants bump touch targets to ≥44px; `pt-safe`/`pb-safe` for iOS insets; every glass surface gates on
`prefers-reduced-transparency` (→ solid warm fill), `prefers-contrast` (→ stronger
borders), and `prefers-reduced-motion` (→ no shimmer). Baseline HTTP security
headers are set in `next.config.mjs` (`X-Content-Type-Options`, `X-Frame-Options:
SAMEORIGIN`, `Referrer-Policy`, `Permissions-Policy` with `microphone=(self)`, HSTS).

---

## 4. Front-end architecture

### 4.1 App Router & providers

Route groups: `(auth)` (sign-in/up, password recovery), `(app)` (the authenticated
shell), `(legal)`. The root `layout.tsx` wraps everything in `Providers`
(`src/components/providers.tsx`): NextAuth `SessionProvider`, `next-themes`
`ThemeProvider` (`attribute="class"`, system default), `TooltipProvider`, the
`Toaster` (sonner), and `AutoTranslate` (i18n).

The authenticated shell is driven by **`AppProvider` / `useApp()`**
(`components/app/app-provider.tsx`): a client context seeded from a server-rendered
`bootstrap` payload. It holds `user`, `settings`, `features`, `quota`, `spend`,
`conversations` (+ optimistic upsert/update/remove), `folders`, `models` (seeded from
the static registry, refreshed from `/api/models`), `activeConversationId`,
`sidebarOpen`, and sticky **composer prefs** (reasoning effort, web search, canvas,
fast mode) persisted to `localStorage`. It also applies the accent CSS vars and reads
the theme.

`AppShell` (`components/app/app-shell.tsx`) renders the fixed `DotField` background, a
resizable desktop sidebar (width/collapse persisted), a mobile sheet drawer, the main
column with `PageTransition` (opacity-only route fades keyed on the first path
segment so `/chat` → `/chat/[id]` never remounts mid-stream), and globally mounts
`Onboarding`, `AnnouncementPopup`, and the `CommandPalette`.

**Sidebar** (`app-sidebar.tsx`) has a `SegmentedControl` **Home/Code** mode toggle
that swaps the nav set, plus recents, projects, code workspaces, code-task status
rows, and the `UserMenu`. **Command palette** (`command-palette.tsx`) is two Radix
dialogs sharing one shell: a search palette (`juno:search` event) and a ⌘K command
menu.

### 4.2 Chat UI

`ChatView` (`chat/chat-view.tsx`, ~1800 lines) orchestrates the whole surface: the
message list, the composer, an optional right **canvas** column, a docked **thought
process** column (mutually exclusive with canvas — two right columns don't fit), the
realtime-voice dock, and the top-right action cluster (Share, model params, private
toggle).

- **`Composer`** (`chat/composer.tsx`) — auto-resizing textarea with a morphing
  Voice → Send → Stop action; attachments (drag/paste/library, via `useUploads`);
  a `/` slash + `@` mention command palette (`/artifact`, `/voice`, `/memory`,
  study mode, web search, deep research, canvas); a "+" menu with connectors
  (auto-detected from the prompt), image upload, and the prompt library;
  `ModelSelector`; `ReasoningSlider` + fast mode; and `ComposerDictation`.
- **`MessageItem`** enforces the flat-transcript law and splits assistant content via
  `splitMessageContent` into ordered text → `Markdown`, artifact → `ArtifactInlineCard`,
  and learning → `VisualLearningBlockRenderer` parts. It renders the `ActivityTimeline`
  run strip, `SourcesPill` bibliography, a model/token/cost footer, and the
  `VersionPager` (‹ 2/3 ›) for edited/regenerated turns.
- **`Markdown`** (`chat/markdown.tsx`) uses `react-markdown` with `remark-gfm`,
  `remark-math`, `rehype-highlight`, `rehype-katex`, plus a custom citation plugin
  that turns positional `[n]` markers into favicon source chips (only for
  deep-research's numbered corpus). It splits content into stable blocks and
  auto-closes dangling fences so streaming re-parses only the last block.
- **Thought panel** — `ActivityTimeline` owns the run clock and portals
  `ThoughtProcessPanel` into a sibling dock column. The panel is designed so "the form
  cannot lie": events split into **PROFILE** (real durations) vs **FACTS**
  (zero-duration), showing phases, searches/sources, and the raw provider reasoning.
- **Learning blocks** (`chat/learning/`) — `:::step-lab`, `:::learning-card`,
  `:::process-timeline`, `:::comparison`, `:::quiz`, `:::deep-dive` fenced regions
  parsed by `findLearningBlocks`, plus a ```juno-visual``` JSON path
  (`InlineVisualBlock`). All render as calm, ruled "figures" inside the transcript.

### 4.3 Canvas (artifacts)

`CanvasPanel` (`canvas/canvas-panel.tsx`) opens beside the chat with Preview /
Console / Code tabs, an always-writable Code tab (dirty-draft + stale-write guard),
version history + diff, run controls, an element inspector, quote-to-composer,
fullscreen, Office export (for Markdown artifacts), and share. It hosts:

- **`SandboxFrame`** (`canvas/sandbox-frame.tsx`) — the security-critical renderer.
  Artifacts run in an **opaque-origin iframe**: `sandbox="allow-scripts allow-popups
  allow-forms allow-modals"` with **no `allow-same-origin`**, so artifact code can
  never reach the app's cookies, storage, or DOM. `buildSandboxDoc` builds an
  `srcDoc` per artifact type: React/JSX (React + Babel + Tailwind CDN, ESM imports
  stripped, lucide shimmed), HTML/SVG/CSS, Mermaid (Mermaid CDN), a JS/Python console
  runtime (Pyodide), or an escaped `<pre>`. Parent↔frame communication is
  `postMessage` only, trusting solely the frame's own `contentWindow`.
- **`CodeSurface`** — a flat, line-numbered code editor/viewer with theme-aware
  `highlight.js` highlighting.

The same `SandboxFrame` powers inline Mermaid blocks and the public share viewer.

### 4.4 Hooks & i18n

Hooks (`src/hooks/`): `use-chat` (chat state + streaming), `use-uploads`,
`use-realtime-voice`, `use-tts`, `use-speech-recognition`, `use-code-session`.

**Automatic interface language.** The server resolves the browser/OS language from
`Accept-Language` (falling back to `navigator.languages`). Static UI copy is extracted
at build time (`npm run i18n:extract` → `scripts/generate-i18n-catalog.mjs`); for
non-English locales only **opaque catalog IDs** are sent to `/api/i18n/translations`,
which translates the fixed UI strings with the configured Anthropic model and caches
them (browser + CDN + warm server). **User content — conversations, typed text,
account data — is never sent for interface translation.** RTL direction is set
automatically. `components/i18n/auto-translate.tsx` drives it client-side. The route is
rate-limited (`i18n:global` 4000/h, `i18n:ip` 200/h). If translation is unavailable,
the original English remains usable.

---

## 5. The chat / generation pipeline

`POST /api/chat` (`src/app/api/chat/route.ts`, ~2600 lines) is the heart of the
product. `runtime = "nodejs"` with no `maxDuration` (the VM has no wall; nginx +
heartbeat govern the ceiling).

### 5.1 Request & SSE protocol

The Zod body accepts (among others): `message`, `conversationId?`, `projectId?`,
`model?`, `regenerate?`, `attachmentIds?`, `reasoningEffort?`, `webSearch?`,
`deepResearch?`, `canvasEnabled?`, `fastMode?`, `voiceMode?`, `privateMode?` +
`privateHistory?`, `connectors?` (≤5), `clarification?` / `preflightClarification?`,
`artifactEdit?`, `origin?`, and the idempotency pair `clientRequestId` +
`clientMessageId`. There is **no character cap** on the prompt — model context is the
only limit.

The response is an **SSE stream** (`text/event-stream`, `X-Accel-Buffering: no`).
Each frame is `data: {json}\n\n`. Event `type` values:

| type | meaning |
|---|---|
| `meta` | first frame — `conversationId`, `userMessageId`, `title`, `generationId`, `receiptState` |
| `activity` | live timeline entry (context / model / reasoning / search / visit / write / usage / done / warning / tool) |
| `delta` | streamed answer text |
| `reasoning` | streamed thinking (with a `part` ordinal for discrete summary parts) |
| `sources` | cumulative web-search citations `[{title,url,snippet}]` |
| `ping` | 15 s heartbeat (keeps nginx + native clients alive) |
| `done` | terminal success — final `message`, `artifacts`, `memoryUpdated`, `quota`, `finishReason`, `title?` |
| `error` | terminal failure — `message`, `failureCode`, `receiptState:"failed"`, stable ids, `preservePartial?` |

Native clients authenticate these existing routes with the same short-lived bearer
used by `/api/v1`; `getCurrentUser()` treats an Authorization header as authoritative.
For an existing saved conversation, the native client first idempotently appends the
USER turn to `POST /api/conversations/{conversationId}/messages` using its stable
`clientId`, then calls `POST /api/chat` with `regenerate:true` and no `message`. This
generates from the authoritative persisted final user row. A lost stream is reconciled
through `/api/v1/changes`; the client never automatically repeats the ambiguous chat
POST, preventing duplicate generations and billing. This bearer flow, cancellation,
receipt lookup and the SSE event union are published in the native OpenAPI contract.

Artifacts and quota ride on `done`/`error` (not separate events); the client detects
a streaming artifact from accumulated `delta` text. `send()` swallows enqueue errors
so **generation and persistence continue after the client disconnects** (the provider
stream is bound to a generation-scoped `AbortController`, not the request signal).

### 5.2 System prompt

`buildSystemPrompt` (`src/lib/anthropic.ts`) assembles a deliberately **date-free**
prefix (so the provider's cached prefix stays byte-identical; the date travels in a
separate second system block). Ordered sections: base identity → clarification /
reply-intent / inline learning-block grammar (non-voice) → Canvas artifact grammar
(when canvas on) → **memory** (the `<juno:memory>` save instruction + the consolidated
summary + recent facts) → project context → personality preset → the user's custom
instructions (after the preset, so the user always wins) → response language → voice
no-markdown rule. A web-search nudge and either the targeted artifact-edit prompt or a
selection anchor are appended per turn.

### 5.3 Model routing, Auto & thinking

There is **no BYOK** — every model call uses a platform provider key from the
environment. The requested model id is validated (`getModel`); `comingSoon`,
unconfigured-provider, and plan-disallowed ids fall back to the first eligible chat
model, or 503 if none. **Auto mode** (`juno:auto`, `src/lib/auto-model.ts`)
classifies prompt complexity with deterministic heuristics (simple/medium/hard/expert
with intelligence floors), filters eligible chat models, prefers the current
generation, then ranks **cheapest-first** by average request cost — and picks the
thinking effort to match (simple → Instant … expert → max). Auto stays **sticky** on
the conversation while each generation records the concrete model. Reasoning effort
(`minimal…max`, or `null` = Instant) is clamped to each model's caps; Anthropic uses
adaptive (`output_config.effort`) or manual (`budget_tokens`) thinking depending on
the model (see §6.3).

### 5.4 Clarify & follow-ups (both fail-open)

- **`POST /api/chat/clarify`** decides whether to ask **one** clarifying question
  before answering. It **fails open everywhere** — deterministic skip gates (short
  prompts, attachments, code, "don't ask" phrasing), rate limit, budget exhaustion,
  or any exception all return "no clarification." A fast, free triage model with a
  short deadline (and dead-model cooldowns) does the actual triage.
- **`POST /api/chat/follow-ups`** proposes exactly three next-question pills after a
  reply; any error returns `[]`.

### 5.5 Quota, budget & moderation gates

- **Message quota:** enforced by `consumeMessage` as a single atomic conditional
  increment (no TOCTOU). **FREE = 0 messages** (browse/history only); paid plans are
  effectively unlimited on count and governed by the € **budget** instead. Over quota
  → **402** `QUOTA_EXCEEDED`.
- **Budget:** `checkBudget` before the stream → **402** `budget_exceeded`; a hard
  **mid-stream** `enforceStreamBudget` aborts the provider the instant projected cost
  would exceed the remaining budget, keeping/billing the partial as a user-stop.
  Failed generations `refundMessage`.
- **Moderation:** a synchronous deterministic `quickScreen` runs before generation;
  a `high`/`critical` hit records a flag and returns **403** `policy_violation`. A
  fire-and-forget LLM classifier runs after the response (fails open). See §12.

### 5.6 Attachments, web search, private mode, artifacts

- **Attachments** referenced by `attachmentIds` are claimed onto the created user
  message and converted to multimodal blocks (`toAnthropicMessages`): images →
  base64 image blocks, PDFs → document blocks, other → extracted text. Only the most
  recent 8 messages re-embed heavy binaries (block-anchored so the cache prefix stays
  stable); older ones degrade to text placeholders. Attachment claim mismatch → **409**
  `ATTACHMENT_CLAIM_FAILED`.
- **Web search** has three modes: native provider search (Anthropic
  `web_search_20250305`, Google grounding, Grok Live Search), **deep research**
  (durable plan → parallel investigation rounds → lead review → synthesis → citation
  validation, needs `TAVILY_API_KEY`), and source capture/dedup into the streamed
  `sources` event. Research tiers are `quick` (1×1, 20 pages, 5 min), `standard`
  (4×2, 80 pages, 12 min), `deep` (8×3, 320 pages, 30 min) and `max` (12×3,
  480 pages, 60 min). Chat defaults to `deep` with an $8 ceiling; set
  `RESEARCH_CHAT_BUDGET_USD` to tune it, capped at $40. Sources deduplicate on
  canonical URL and page text remains untrusted when sent to any model.
- **Private/incognito mode** is a separate branch: nothing persists (`conversationId:
  "private"`), no memory, no attachments (**400** `PRIVATE_ATTACHMENTS_UNSUPPORTED`),
  no connectors, no regenerate; but budget, quota, and moderation still apply and
  spend is still recorded.
  Visually it is a **cross-fade, not a re-render**: the greeting and the incognito
  heading occupy the same grid cell (`modeLayer()` in `chat-view.tsx`), the
  outgoing layer leaves on `duration-fast` and the incoming one arrives on
  `duration-slow` 90 ms later so the two are never both at half opacity. Every
  layer animates `opacity`/`transform` only and gates on `motion-reduce`. The
  inset dashed card is the single exception that touches layout, so its margin
  runs on `duration-base`; it used to be `transition-all duration-500`, which
  dragged the flex sizing into the animation and stuttered the whole transcript.
  The heading, the header bar and the toggle all use the same ghost mark.
- **Artifacts** are emitted by the model as `<juno:artifact …>…</juno:artifact>` tags
  and persisted on completion (`persistArtifacts`); reusing an identifier appends a new
  version. Targeted canvas edits use an optimistic compare-and-bump patch protocol.

### 5.7 Idempotency & durable receipts

The first saved submission of a new conversation carries `clientRequestId` +
`clientMessageId` (opaque 8–120 char keys, valid only for a new non-private,
non-regenerate conversation). A `ChatFirstSubmissionReceipt` binds a SHA-256 hash of
the generation-affecting envelope to **one** server-generated `generationId`. Recovery
happens before rate limiting and returns precise 409s:

- same request already accepted → **409** `REQUEST_ALREADY_SUBMITTED` (with canonical ids)
- key reused with a different body → **409** `IDEMPOTENCY_KEY_REUSED`
- claim in progress → **409** `REQUEST_IN_PROGRESS`

Acceptance (conversation + first message + attachment claim + quota + receipt) commits
in one locked transaction. The receipt holds a **5-minute lease** renewed on the 15 s
heartbeat; a lost/expired lease produces `failureCode: GENERATION_LEASE_EXPIRED`.
Native clients poll **`GET /api/chat/receipt`** (exactly one of `clientRequestId` /
`generationId`) to recover state — it returns only ids + `receiptState` + `finishReason`
+ `failureCode`, never prompt content. Receipts survive conversation deletion, so a
deleted chat can never make an old idempotency key reusable. `POST /api/chat/cancel`
aborts a live generation by `generationId` (ownership-checked, in-memory registry).

**Origin/spend tagging:** `origin` (`web` / `main_macos` / `main_ios` /
`main_windows` / `quick_macos` / `quick_windows`) is durable conversation metadata;
the legacy `client` tag (`web`/`app`) splits website vs native spend in the admin view.

---

## 6. Models & generation

### 6.1 Registry

`src/lib/models.ts` is the single source of truth. `CURATED` holds chat models,
`GENERATIVE` holds image/video models (run through `/api/generate`, not the chat
stream), `RETIRED_MODELS` maps dead ids to replacements (`migrateModelId` silently
remaps stored ids so they never dangle), and `models.generated.ts` (machine-written by
`sync-models.ts`) merges `DISCOVERED`/`UNAVAILABLE` entries. Model ids are
`provider:providerModel`. The default chat model is **`anthropic:claude-sonnet-5`**.
`npm run validate:models` enforces the invariants (unique ids, exactly one *current*
per provider/family/modality, defaults, migrations resolve).

### 6.2 Providers

14 providers (`src/lib/providers.ts`). **Anthropic** uses the native SDK; **Google** uses
the native Google Generative Language REST adapter (`src/lib/gemini.ts`); **all
others are OpenAI-compatible** with a per-provider base URL and share
`openai-compat.ts`. A provider is "configured" iff its API-key env var is set.

| Provider | Label | Key env | Status |
|---|---|---|---|
| anthropic | Anthropic · Claude | `ANTHROPIC_API_KEY` | active (native SDK) |
| openai | OpenAI · GPT | `OPENAI_API_KEY` | active (chat + Responses API) |
| google | Google · Gemini | `GOOGLE_API_KEY` | active (native Gemini adapter) |
| zhipu | Zhipu · GLM | `ZHIPU_API_KEY` | active |
| moonshot | Moonshot · Kimi | `MOONSHOT_API_KEY` | active |
| deepseek | DeepSeek | `DEEPSEEK_API_KEY` | active |
| mistral | Mistral | `MISTRAL_API_KEY` | active |
| xai | **SpaceXAI · Grok** | `XAI_API_KEY` | active |
| minimax | MiniMax | `MINIMAX_API_KEY` | active |
| mimo | MiMo · Xiaomi | `MIMO_API_KEY` | active |
| qwen | Alibaba · Qwen | `DASHSCOPE_API_KEY` | active |
| seedance | ByteDance · Seedance | `SEEDANCE_API_KEY` | active (video only) |
| longcat | Meituan · LongCat | `LONGCAT_API_KEY` | active (only model is `comingSoon`) |
| meta | Meta · Muse | `META_API_KEY` (alias `LLAMA_API_KEY`) | active — recommissioned 2026-08-06 on the Meta Model API (`api.meta.ai`) after the Llama API's 2026-07-06 shutdown. Serves Muse Spark 1.2; the `meta:Llama-*` ids stay retired and still migrate to `claude-sonnet-5` |

**Current selectable chat models** (as of this writing — the registry is the live
truth): Anthropic Fable 5, Opus 4.8, **Sonnet 5** (default, FREE-eligible), Haiku 4.5;
OpenAI GPT-5.6 Sol/Terra/Luna, GPT-5.5 Pro, GPT-5.4 Mini/Nano, GPT-5.3 Codex;
Google Gemini 3.7 Flash (canonical native adapter with streaming, thinking effort, MCP tool calling, and search grounding), 3.5 Flash Lite, 3.1 Pro; Zhipu GLM-5.2 + turbo/vision/flash
tiers; Moonshot Kimi K3 (flagship), K2.6, K2.7 Code (+ high-speed); DeepSeek V4
Flash/Pro; Mistral Medium 3.5 / Large 3 / Small 4 / Codestral / Ministral;
xAI Grok 4.5 (+ Build 0.1, Multi-Agent); MiniMax M3 / M2.7 Highspeed;
MiMo V2.5 Pro / V2 Flash; Qwen 3.8 Max / 3.7 Plus / 3.6 Flash / Long.
Image/video generation models (GPT Image, Nano Banana, Grok Imagine, GLM Image,
MiniMax Image-01, Veo 3.1, Gemini Omni, Seedance, Hailuo, CogVideoX) require the
**MAX** plan for video.

### 6.3 Adapters & thinking

`streamChat` (`src/lib/llm.ts`) dispatches: Anthropic → `streamAnthropic`; OpenAI
`api:"responses"` (the Pro/Codex line) → `streamOpenAIResponses`; everything else →
`streamOpenAICompat`.

- **Anthropic** (`anthropic.ts`): native SDK, 1 h prompt-cache TTL, a conversation
  cache breakpoint, native `web_search` and MCP connector support, and a **fast mode**
  (`speed:"fast"` beta) with automatic fallback on capacity errors. Thinking
  (`anthropic-thinking.ts`) is **adaptive** (`type:"adaptive"` + `output_config.effort`)
  for the newest models (Fable, Opus 4.6+, Sonnet 5) or **manual**
  (`type:"enabled"` + `budget_tokens`) for older ones; some models default thinking on
  and need an explicit disable for Instant.
- **OpenAI-compatible** (`openai-compat.ts`): one client per provider; reasoning is
  expressed per provider dialect — `reasoning_effort` (OpenAI, Google shim, DeepSeek,
  xAI, Mistral, GLM-5.2, Kimi K3), a `thinking` object (other GLM/MiniMax/older Kimi/
  MiMo/LongCat), or `enable_thinking` + `thinking_budget` (Qwen). Includes an
  MCP tool loop (≤6 rounds) and xAI Live Search.
- **`reasoningCaps`** in `model-metrics.ts` is the source of truth for per-model
  thinking tiers; `clampReasoningEffort` prevents sending unsupported tiers.

### 6.4 Image & video generation — `/api/generate`

`POST /api/generate` streams progress over SSE. Image paths: Google native (Nano
Banana), MiniMax, and OpenAI-compatible `/images/generations` + `/images/edits`
(mask-based, PNG ≤8 MB). Video adapters are all async start→poll→download: Google Veo,
Gemini Omni (Interactions API), MiniMax Hailuo, Zhipu CogVideoX, ByteDance Seedance
(Ark). Grok Imagine video remains hidden until its adapter is wired. The route rejects
chat-modality and `comingSoon` ids, checks plan/budget/quota, and records **flat** media spend
(`recordSpend({kind:"image"|"video"})`).

### 6.5 Pricing, metrics & spend

`pricing.ts` reconciles the differing usage conventions (Anthropic input excludes
cache; OpenAI-compat prompt tokens include it), applies cache multipliers (Anthropic
read 0.1×, **1 h write 2×** — Juno always writes 1 h) and web-search tool fees
(Anthropic/OpenAI $10/1k, xAI $5/1k). `model-metrics.ts` scores intelligence (1–10,
from Artificial Analysis) and speed, with a live benchmark overlay
(`benchmarks.generated.ts`). Every billable call appends an **`ApiSpend`** ledger row
(integer micro-USD); chat/code recompute cost from tokens and take
`max(fromTokens, callerEstimate)` so nothing under-bills.

### 6.6 Model catalog endpoints & sync

`GET /api/models` returns the display-sorted `ModelInfo[]` + a `manifestVersion`.
`GET /api/v1/models` returns the richer native `nativeModelCatalog` (lifecycle,
availability, minimum plan, modalities, pricing, reasoning capabilities). Neither
applies server-side plan gating (that's client + enforced at chat/generate). Tooling:
`npm run sync:models` (dry) / `sync:models:write` (regenerate `models.generated.ts`
from live provider `/models`), `radar:models` (diff OpenRouter's catalog for new
industry models), `sync:benchmarks` (Artificial Analysis, needs `AA_API_KEY`),
`validate:models`.

---

## 7. Memory

Memory lets Juno remember durable facts about a user across conversations. Three
Prisma models: **`MemoryEntry`** (a `content` string with `kind` = `FACT` or
`SUPPRESSION`, `source` = `AUTO`/`MANUAL`, `sourceRef`), **`ConversationMemory`** (a
per-chat high-water mark `processedAt` + one-line `digest` + `factCount`, making
extraction incremental and resumable), and **`MemorySummary`** (a periodically
regenerated, deduped markdown summary). `User.memoryEnabled` is the master toggle.

**Extraction** (`src/lib/memory.ts`) has two paths: inline `<juno:memory>…</juno:memory>`
tags the model emits during a reply, and a background distillation
(`extractConversationMemory`) that runs after the answer persists, chunking user
messages, running a free utility model, and advancing the high-water mark per chunk.
**Dedup** is deterministic exact-normalized-string matching plus a suppression filter
(there are **no embeddings / semantic retrieval** — retrieval injects the whole
consolidated summary plus recent facts every turn). **Suppression** (`SUPPRESSION`
entries) filters both ingestion and the summary and is never injected, so "forgotten"
facts never resurface; a global reset stamps every conversation processed so backfill
can't re-learn them.

**API/UI** (`/api/memory`, `src/app/(app)/memory/page.tsx`): `GET` (facts + summary,
optional `?q=` search), `POST` (add a manual fact), `DELETE` (full reset in a
transaction), `PATCH`/`DELETE /[id]`, `/backfill` (resumable batch distillation of
past chats), `/consolidate` (regenerate the summary), and `/edit` + `/edit/apply`
(translate a natural-language instruction — "forget my old job" — into a reviewable,
undoable set of add/suppress/update/remove operations with a staleness guard). The
Memory page shows the readable summary, an undo ledger, and a privacy strip
(pause / export / reset); raw facts are intentionally not listed.

---

## 8. Tool connectors (MCP)

A connector links an external tool; once linked, the stored (encrypted) token is
handed to the model as a **remote MCP server**, so the model can call that provider's
tools with the user's own permissions. The Connections page shows one unified
directory (`connections/connector-directory.tsx`) merging two backends; where both
offer the same app, the **native connector wins** and the Composio duplicate is
filtered out.

**Native connectors** (`src/lib/connectors.ts`):

| Connector | Kind | Pre-registration | MCP endpoint |
|---|---|---|---|
| GitHub | `oauth_app` | OAuth app (id + secret) | `https://api.githubcopilot.com/mcp/` |
| Figma | `oauth_app` | OAuth app (id + secret) | `FIGMA_MCP_URL` |
| Notion | `mcp_oauth` | none (self-registers via OAuth 2.1 + PKCE + DCR) | `https://mcp.notion.com/mcp` |
| Apple Calendar | `credentials` | none | `/api/mcp/apple-calendar` |
| Apple Mail | `credentials` | none | `/api/mcp/apple-mail` |
| Apple Music | `credentials` | MusicKit `.p8` key | `/api/mcp/apple-music` |

- **`oauth_app`** — classic OAuth 2.0; the Connect button appears only when its
  `*_OAUTH_CLIENT_ID`/`*_OAUTH_CLIENT_SECRET` are set.
- **`mcp_oauth`** — a hosted remote MCP server that self-registers via OAuth 2.1 +
  PKCE + Dynamic Client Registration (`src/lib/mcp-oauth.ts`); nothing to pre-register.
  Notion tokens are short-lived and auto-refreshed with the dynamically-registered
  client (persisted on the `Connection` row).
- **`credentials`** — no OAuth. The user hands over an iCloud app-specific password
  (Apple Calendar/Mail, validated live against CalDAV/IMAP before saving) or a MusicKit
  user token; it is stored AES-256-GCM-encrypted and the provider's tools are served by
  **our own MCP route** (`/api/mcp/[connector]`), which the model authenticates to with a
  short-lived HMAC token (`connector-token.ts`) — the raw credential never leaves the
  server. Apple libs live in `src/lib/apple/` (caldav, mail, music).

**Composio** (`COMPOSIO_API_KEY`) is the managed catalog (Gmail, Slack, Linear, …). Juno
stores an encrypted, app-scoped session reference under `composio:<slug>` and proxies MCP
requests server-side (`/api/connectors/composio/[slug]`, `/api/mcp/composio/[slug]`) so
Composio's API headers never reach the browser or the model provider. Connectors are
resolved into live MCP endpoints at generation time (`src/lib/mcp.ts`), refreshing
expiring tokens. Connectors can be auto-enabled when the prompt mentions the app.

The connect/callback flow (`/api/connectors/[id]/connect` + `/callback`) uses a signed,
single-use `state` cookie (and, for `mcp_oauth`, an encrypted per-flow cookie holding the
PKCE verifier + registered client) and stores tokens encrypted on a `Connection` row.
Apple MCP routes are dialed by Anthropic's MCP infrastructure from outside, so
`NEXT_PUBLIC_APP_URL` must be the public origin.

**Setup per connector** (each is hidden until its credentials are set; all callback
URLs resolve against `NEXT_PUBLIC_APP_URL`):

- **GitHub** — register an OAuth App (GitHub → Settings → Developer settings → OAuth
  Apps), callback `https://<app>/api/connectors/github/callback`; set
  `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET`. The same GitHub connector's
  `repo` token is what cloud Code uses to clone + open PRs (§9.3).
- **Figma** — create an app (Figma → Settings → Developer → Apps), callback
  `https://<app>/api/connectors/figma/callback`, enable the scopes you want; set
  `FIGMA_OAUTH_CLIENT_ID` / `_SECRET` / `FIGMA_OAUTH_SCOPE` and `FIGMA_MCP_URL`.
- **Notion** — nothing to register (Dynamic Client Registration). Just ensure
  `NEXT_PUBLIC_APP_URL` is correct; `NOTION_MCP_URL` defaults to the hosted server.
- **Apple Calendar / Mail** — always available; the user pastes an iCloud
  **app-specific password** (Apple ID → Sign-In & Security → App-Specific Passwords;
  2FA required). Validated live against CalDAV/IMAP before saving.
- **Apple Music** — needs a MusicKit key: Apple Developer → Keys → enable Media
  Services (MusicKit), download the `.p8`; set `APPLE_MUSIC_TEAM_ID` /
  `APPLE_MUSIC_KEY_ID` / `APPLE_MUSIC_PRIVATE_KEY`.
- **Composio** — set `COMPOSIO_API_KEY` (free at composio.dev); the managed catalog
  then appears in the directory and each app has its own consent flow.

---

## 9. Code: device sessions, remote control & cloud runs

Juno "Code" runs agentic coding sessions. Three cooperating surfaces share the
`/api/code/*` namespace and the `CodeDevice`/`CodeTask`/`CodeTaskEvent` core.

### 9.1 Device task queue

A Mac/Windows host running the agent registers/heartbeats via `POST /api/code/devices`
(a device is `online` if seen within 120 s). A client queues a task with `POST
/api/code/tasks` (`queued`); the host long-polls `GET /api/code/queue?deviceId=`
(≤25 s), claims it (`queued → running`), and streams batched events to
`POST /api/code/tasks/[id]/events` (server assigns monotone `seq`; returns pending
control events). When it needs permission it appends an `approval_request` and sets
`awaiting_approval`; the client answers via `/respond`. Web clients render via the SSE
`GET /api/code/tasks/[id]/events`. Event kinds: `status`, `user`, `text`, `tool`,
`file_change`, `approval_request`/`response`, `cancel_request`, `error`, `done`, and
**`agent`** (subagent lifecycle cards). Statuses: `queued → running ↔ awaiting_approval
→ done | failed | cancelled`.

### 9.2 Remote sessions (phone ↔ Mac)

A newer layer (`CodeRemoteSession` / `CodeRemoteSessionEvent` / `CodeSessionCommand`,
`src/lib/code-remote-sessions.ts`) lets a phone/web client **discover, read, and remote-control
the Mac's live local Code sessions**. The Mac is authoritative; the server is a
versioned, replaceable **snapshot + index** plus an **idempotent command channel** the
Mac polls and acks. Two-tier sync under `/api/code/devices/[deviceId]/sessions`: a
list/summary `PUT` (keyset-paginated `GET`, explicit tombstones — missing rows are
never inferred deletes) and a detail `PUT` per session carrying rich JSON blobs
(transcript, changes, terminal, tests, git, approvals, subagents, usage) with
optimistic `snapshotVersion`/`lastEventSequence` concurrency. Events append with a pure
ordering planner (replay-skip, first-gap reject). Phone→Mac commands (`message`, `stop`,
`approval`, `patch`, `delete`, …) upsert idempotently by `(userId, idempotencyKey)` and
the host claims them with a CAS `pending → claimed → completed`. A **transcript policy**
(`metadata` / `recent` / `full`) controls whether the server keeps content the phone can
read while the Mac is offline; under `metadata` the server forcibly nulls all rich blobs.
Everything here is scoped to the logged-in user's own devices (plain session auth).

### 9.3 Cloud runs (GitHub Actions)

Cloud Code runs a session with no local machine: pick a repo, describe a task, the agent
runs in GitHub Actions and opens a PR. `POST /api/code/tasks` with `target:"cloud"` +
`repo:{owner,name}` requires a linked GitHub connector and `GITHUB_DISPATCH_TOKEN`;
it rate-limits (10/min/user) and caps concurrency (≤3 active, under a Postgres advisory
lock), then `workflow_dispatch`es `.github/workflows/code-runner.yml` with **non-secret**
inputs only. The runner (`scripts/cloud-code-runner.mjs`):

1. fetches its **GitHub Actions OIDC JWT** at runtime (audience `juno-cloud-code`);
2. calls `GET /api/code/tasks/[id]/runner-context` with `Authorization: Bearer <oidc>` —
   verified by `src/lib/github-oidc.ts` (RS256, issuer, audience, `repository` +
   `job_workflow_ref` allowlist). The route is **single-use** (stamps `runnerClaimedAt`),
   rejects browser sessions with 403 (so the clone token never reaches a browser), and
   returns the clone token + a fresh **task token** (`cct_…`, HMAC over `{taskId,exp}`
   with `CLOUD_CODE_SECRET`, 30 min);
3. claims (task-token), clones via a transient git askpass (token never in argv/config),
   scrubs its environment, runs the vendored agent-core against the prompt with the
   backend proxy pointed at **`/api/agent`** (so all provider calls + billing go through
   Juno — no provider key ever reaches Actions), streams events, and on completion commits
   to a branch and opens a PR.

`requireTaskAuth` lets the claim/events/respond/cancel routes and the `/api/agent` proxy
accept either a real session **or** a valid task token for that exact task, and refuse a
task-token caller once the task is terminal. `runner/agent-core/` is a vendored,
byte-for-byte copy of `@juno/agent-core` (only its `tsconfig.json` diverges) including the
**subagent orchestration** layer (`subagents.ts` / `loop.ts`): roles explorer/architect/
builder/reviewer/tester/designer/refactorer/docs, up to 3 concurrent, writers isolated in
git worktrees, surfaced to the web UI as `agent` events.

---

## 9b. Work: tasks, runs, plans & approvals

Juno **Work** is the agentic surface for everything that is not code: you write a goal,
Juno plans it, works it, stops to ask when only you can decide, and hands back a
deliverable. It shares nothing with Code except the idea of a remote executor — its own
vocabulary lives in `src/lib/work/domain.ts` (statuses, event kinds, capabilities, risk
levels, command kinds), is mirrored to the native clients through
`contracts/work/juno-work-v1.json`, and `src/lib/work/contract.ts` asserts at runtime that
the two still agree. **A value that is not in `domain.ts` is not a value Work has.**

Sixteen `Work*` Prisma models back it. The ones that carry the flow: `WorkSession` (the
task: goal, target, model, reasoning effort, permission policy), `WorkRun` (one *attempt*
at it), `WorkEvent` (the append-only log, `seq`-ordered, with a per-kind `visibility` of
user / operator / internal), `WorkApproval`, `WorkRunIO` (an attempt's input manifest),
`WorkFileGrant` + `WorkSessionConnector` (what the task may reach), `WorkHost` +
`WorkCommand` (a paired Mac and the commands sent to it), `WorkSkill*`, `WorkSchedule` /
`WorkTrigger`, `WorkArtifact*`, `WorkAuditEvent`.

### 9b.1 A task, and its attempts

`POST /api/work/sessions` creates a session in `draft`. `POST /api/work/sessions/[id]/runs`
dispatches an attempt. A session is the task; a run is one try at it, numbered by
`attempt`, and the run — never the session — is what an executor claims.

Statuses (`WORK_LIVE_STATUSES` / `WORK_TERMINAL_STATUSES`):

```
draft → queued → preparing → running ⇄ waiting_input | waiting_approval | paused
                                     → completed | failed | cancelled | interrupted
                                     | host_offline | budget_exceeded | timed_out
```

`interrupted` is distinct from `failed` on purpose (the run itself decided `failed`; nobody
decided `interrupted`), and `host_offline` is terminal but still counts as *needs
attention*, because the user has a decision left to make. `WorkRun.terminalReason` adds
`superseded` for an attempt a newer one took over.

Dispatch decides four things: **where**, **on what**, **under which permission mode**, and
**within what ceilings**. Target selection (`selectTarget`) matches the capabilities the
goal implies (`inferCapabilities`) against what a paired Mac has actually advertised —
nothing is assumed about a host — and `automatic` may legitimately move a task off the
Mac. Model choice (`src/lib/work/models.ts`) reads back over at most the last 4 failures so
a retry does not pick the model that just failed. Approval mode is
`conservative | balanced | permissive`, defaulting to `balanced`, and a Mac may narrow it
further (`approvalModeNarrowedByHost`). Ceilings are **$2 · 600,000 tokens · 20 minutes of
running time** (`DEFAULT_RUN_BUDGET`); the clock suspends while the run waits on a person,
so a question answered the next morning costs no runtime. A skill, schedule or host may
lower any ceiling; nothing may raise one. Abuse controls: 10 dispatches/min/user and at
most 3 live runs per user across all sessions.

Two executors run the work and write the same events. The **cloud runner**
(`scripts/work-runner.ts`) drives the vendored `runner/agent-core` Work session against
`/api/agent`. A **Mac** claims a `start` command over the host command channel
(`WORK_COMMAND_KINDS`: start, pause, resume, stop, answer, steer, approve, deny, undo,
grant_folder, revoke_grant, refresh_capabilities, ping) and runs it locally. Clients read
either the same way: `GET /api/work/sessions/[id]/events` is SSE with three frame types —
`snapshot` on connect (and again when the run changes), `events` as the log grows, `done`
at a terminal status — each carrying `{ session, run, events, approvals }`.
`POST /api/work/runs/[id]/control` takes `pause | resume | cancel`.

### 9b.2 The plan the model writes

The plan is not a scratchpad. It is a small explicit state machine
(`runner/agent-core/src/work/plan.ts`) with id-stable steps that survives a pause, a host
going offline and a resume on a different executor, because it is what a person reads to
understand a run they were not watching.

A run starts with a generic three-step seed and the model is told, before any other tool,
to replace it with `write_plan` — real steps, in the user's terms, not tool names. From
then on `update_plan` moves each step through `pending → active → done | skipped | failed`,
emitted as `plan_created` / `plan_updated` / `step_started` / `step_finished`. The UI
rebuilds the plan from the **newest** plan event and then replays the step events after it
(`derivePlan` in `src/components/work/work-timeline.tsx`) — never by patching the previous
version, since a re-plan can drop or rename steps and a merge produces a list that was
nobody's plan. A step still `active` when the run stopped is shown as `unreported`, a state
only the reader can conclude and no executor may claim.

Before a run may report success it faces `structuralValidation` (`work/session.ts`), a
`validation_result` event with three checks: every planned step reached a conclusion; every
step that was skipped or failed says *why*; and the run produced an artifact or a written
answer. It is deliberately structural — it cannot judge whether a document is any good, and
a check that claimed to would be worse than none.

Progress is also policed: `DEFAULT_STALL_THRESHOLD = 6` consecutive tool calls that told
the run *nothing new* (a repeat of a call signature it has already made), and
`DEFAULT_REPETITION_THRESHOLD = 3` identical calls, mark it as going in circles.

### 9b.3 Questions, steering and approvals

**Questions.** `question_asked` puts the run in `waiting_input` and it stops.
`POST /api/work/sessions/[id]/answer` with a `questionId` answers it; questions are matched
by id, because two can be open at once.

**Steering.** The same route *without* a `questionId` records a `user_message` — an
instruction the run never asked for. Both executors read it: the cloud runner drains
unconsumed steering events between turns and appends them as a user turn, and a Mac is
handed a `steer` command it queues for the top of its next turn. Neither aborts the turn in
flight, so the honest sentence is the one the route returns: *Juno reads this before its
next step and works to it from there. What it has already done stands.* A run that is
`waiting_input` refuses an instruction — it is stopped, and accepting one would tell the
user their words were delivered to something that had not moved.

**Approvals.** When a run wants to do something the permission mode does not cover it emits
`approval_requested`, writes a `WorkApproval` and enters `waiting_approval`. The row carries
an `actionDigest` (so a client can prove the card it drew is the row it is answering), a
`policyDigest` (the mode in force when it was asked), and an `expiresAt`.
`POST /api/work/approvals/[id]/decision` refuses five ways, each with its own sentence:
`digest_mismatch`, `policy_changed` (the mode was narrowed after you were asked — Juno asks
again), `expired`, `already_decided`, `not_standing_allowable` (an irreversible action can
be allowed *this time* but never made standing). An expired approval is dropped from the
read paths entirely rather than rendered with two buttons guaranteed to fail. A decision is
then dispatched to the Mac over the command channel, because a decision that only lands in
Postgres leaves a host holding a tool call forever.

### 9b.4 A task's context, and when a change to it takes effect

The goal, the files, the connectors and the skill are **fixed at dispatch**. The product
rule that follows is worth stating plainly, because a control that implies otherwise is a
progress bar that completes while the run never sees the file:

> **A change made during an attempt takes effect on the NEXT attempt — except a message,
> which the attempt in flight reads before its next step.**

| Part of the context | Where it is fixed | When a change lands |
|---|---|---|
| **Goal** | `WorkSession.goal`, written once. `PATCH /api/work/sessions/[id]` accepts `title \| pinned \| archived` **only** | Never — it is what the plan is validated against. Say more by sending a message, or start a new task |
| **Files** | `WorkRunIO` rows written once at dispatch by `recordRunInputsFromGrants` from the session's live `WorkFileGrant` rows | Next attempt. The manifest is a snapshot on purpose: revoking a grant mid-run must not rewrite what the run actually read |
| **Connectors** | `WorkSessionConnector`, chosen at session creation; `evaluateConnector` refuses anything else with `not_selected_for_task` | Next attempt |
| **Skill** | `applySkill` parses a `/slug` out of the goal at run start (or matches one at ≥ 0.75 confidence) | Next attempt |
| **Model, reasoning effort, permission policy** | `POST …/runs` accepts all three, but they bind when the loop is constructed | Next attempt. Target and permission policy are attempt-scoped overrides; they do not edit the session |
| **An answer or an instruction** | `POST …/answer` → `question_answered` / `user_message` | **This attempt**, at its next step. Nothing already done is undone |

Two consequences worth remembering. A skill cannot widen a run: `resolveSkillPermissions`
intersects what the skill asks for with what the run already had, so a shared or pasted
skill can never add a tool. And the goal is deliberately left un-stripped of its `/slug`
invocation — it is what the user actually wrote, and validating a run against an edited
goal would validate it against something nobody asked for.

---

## 10. Voice

### 10.1 Read-aloud & dictation

Separate from the realtime relay and degrading **silently** to the browser Web Speech API
when unconfigured:

| Feature | Route | Default model | Fallback |
|---|---|---|---|
| Read aloud | `POST /api/voice/tts` | `gpt-4o-mini-tts` | `speechSynthesis` |
| Dictation | `POST /api/voice/stt` | `gpt-4o-transcribe` | Web Speech recognition |

Set `OPENAI_API_KEY` + `STT_PROVIDER`/`TTS_PROVIDER` to enable server-side quality.
Dictation records with `MediaRecorder` alongside Web Speech (live preview only; the final
transcript is always re-transcribed server-side with the browser locale as a language
hint — the biggest accuracy win for non-English). Overrides: `STT_MODEL`, `TTS_MODEL`,
`TTS_VOICE`, plus `DEEPGRAM_API_KEY` / `ELEVENLABS_API_KEY`+`ELEVENLABS_VOICE_ID`.
`/api/voice/transcript` persists a `VoiceTranscriptSession`.

### 10.2 Realtime speech-to-speech relay

`relay/` is a standalone WebSocket service. Both web and native clients speak **one** WS
protocol (`relay/src/protocol.ts`, mirrored in `src/lib/voice-relay-protocol.ts`); the
relay holds the provider session and every provider key. Binary frames carry mic PCM16LE
mono 16 kHz up and model speech PCM16LE mono 24 kHz down; JSON frames carry everything
else.

Providers (`relay/src/providers/`): **OpenAI Realtime**, **Gemini Live**
(auto-reconnect via resumption handles), **Qwen Omni Realtime** (an OpenAI-Realtime
dialect over DashScope), **MiniMax composed** (client STT → LLM → TTS, honestly labeled
`trueS2S:false`), plus a keyless **mock** for local testing. The client mints a
short-lived token at `POST /api/voice/relay-token` (HMAC over `AUTH_SECRET`, which must
match the relay's), which also polls the relay `/healthz` to report per-provider
availability. Per-provider session ceilings (OpenAI 60 min, Gemini 15 min transparently
extended, Qwen/MiniMax 120 min) surface as clean `session.closed` events. Gemini Live
needs a **classic** AI Studio key (`AIza…`). The web voice button is gated at build time
by `NEXT_PUBLIC_VOICE_RELAY_URL`.

> **GDPR note:** selecting Qwen sends user audio to Alibaba Cloud (Singapore). Disclose it
> in the privacy policy and consider a consent notice when a user picks Qwen.

**Voice about a Work task.** `src/components/work/voice/` opens the *same* session against
one Work task instead of a chat: `buildWorkVoiceBriefing` turns the task's goal, status,
plan, open questions, pending approvals and latest activity into the `history` array that
`session.start` already accepts, and `WorkVoiceButton` mounts it. What that can and cannot
be is set by the relay, not by the UI: providers are built from `seed.instructions` +
`seed.transcript` and **no tools**, and `RelaySession` holds a user id and a socket and no
database handle — so the voice knows exactly what the briefing said and can do nothing to
the task. It therefore says so on screen while it is open; spoken words reach the task only
through the thread's own send path, pressed deliberately; and because the relay seeds
history once (`historySeeded`), a task that moves on is re-briefed by an explicit *bring
Juno up to date* control that sends one labelled `input.text` turn rather than silently.
The component is exported and not yet mounted by the thread composer.

---

## 11. Billing, plans, usage & rate limiting

### 11.1 Plans (`src/lib/plans.ts`)

Prices below are the numbers rendered on `/upgrade`, in **EUR**. Note that
`src/lib/plans.ts` comments its `price` field as USD while the UI renders `€`, and
`src/lib/spend.ts` defines the real ceilings in EUR — reconcile these before launch.

| Plan | Price | Monthly messages | Upload MB | Voice / Canvas / Web search |
|---|---|---|---|---|
| FREE | 0 | **0** (browse/history only) | 5 | – / ✓ / – |
| PRO | 20 | unlimited | 20 | ✓ / ✓ / ✓ |
| MAX ("Max x5") | 100 | unlimited | 50 | ✓ / ✓ / ✓ |
| MAX20 ("Max x20") | 200 | unlimited | 50 | ✓ / ✓ / ✓ |
| OWNER | – | unlimited | 1000 | ✓ / ✓ / ✓ (env `OWNER_EMAILS`, not purchasable) |

**Every model is floored to a PRO minimum** (`effectiveMinPlan`) — no model is usable on
FREE. Video generation requires MAX. Gating is enforced server-side at the chat/generate
routes and on upload size.

### 11.2 Stripe

`POST /api/stripe/checkout` (plan → Checkout session, promo codes allowed),
`POST /api/stripe/portal` (billing portal), `POST /api/stripe/webhook`
(signature-verified; handles `checkout.session.completed` and
`customer.subscription.created|updated|deleted`, syncing the `Subscription` row). Env:
`STRIPE_SECRET_KEY`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_MAX`, `STRIPE_PRICE_MAX20`,
`STRIPE_WEBHOOK_SECRET`. Effective plan (`getUserPlan`): owner email → OWNER; a
subscription grants its plan only while `ACTIVE`/`TRIALING`, else FREE.

**Setup:** create three recurring monthly **products** in the Stripe dashboard (Pro,
Max x5, Max x20) and copy each **Price ID** (`price_…`) into `STRIPE_PRICE_PRO` /
`STRIPE_PRICE_MAX` / `STRIPE_PRICE_MAX20`. Add a **webhook** endpoint at
`https://YOUR_DOMAIN/api/stripe/webhook` subscribed to `checkout.session.completed`,
`customer.subscription.created`, `customer.subscription.updated`,
`customer.subscription.deleted`, and put its signing secret in
`STRIPE_WEBHOOK_SECRET`. Test locally with `stripe listen --forward-to
localhost:3000/api/stripe/webhook` and card `4242 4242 4242 4242`.

### 11.3 Budget, usage windows & the spend ledger

The real ceiling for paid plans is a monthly **€ budget** (`spend.ts`, `BUDGET_EUR`:
PRO 11, MAX 55, MAX20 110 — sized ~70 % of net revenue after cotisations). `checkBudget`
sums the `ApiSpend` ledger since the period start (the period follows the subscriber's
Stripe renewal date, not the calendar month). Budget-alert emails fire at ≥80 %.
Display-only rolling **5-hour session** and **weekly** meters (`getUsageWindows`) tile
the € cap proportionally. `Usage` tracks message counts + token aggregates per `YYYY-MM`.
`/api/profile/usage` mirrors quota + spend for native clients; `/api/profile/stats`
aggregates the ledger into a token heatmap, per-model/provider mix, and lifetime cost
(self-repairing under-billed rows).

### 11.4 Rate limiting (`src/lib/rate-limit.ts`)

A Postgres fixed-window limiter (`RateLimit` table, atomic upsert — safe across
instances). IP extraction does **not** trust the left-most `X-Forwarded-For`. Notable
limits (per-user unless noted): chat 30/60 s, clarify 60/60 s, follow-ups 30/60 s, agent
proxy 120/60 s, cloud tasks 10/60 s, upload 60/h, generate 30/h, avatar 20/h, import
10/h, export 5/h, account-delete 3/h, roadmap create 8/h; auth routes are IP + global
scoped (register 5/h per IP + 200/h global; password-reset buckets; i18n 4000/h global +
200/h per IP). Over limit → **429**.

---

## 12. Moderation & admin

**Moderation** (`src/lib/moderation*.ts`). Layer 1 `quickScreen` is deterministic regex
(zero provider keys) that fires `critical` only on unambiguous CSAM or credible-threat
adjacency — conservative by design. Layer 2 `moderateText` is a utility-LLM classifier
(categories: illegal_content, csam, credible_threat, harassment, hate, self_harm,
spam_abuse, malware_or_intrusion, other) that **fails open** (never flags a normal user on
error). In the chat route, `quickScreen` runs synchronously before generation (a
high/critical hit → 403 `policy_violation`), and the classifier runs fire-and-forget
after. `recordFlag` writes a `ModerationFlag` audit row and drives the strike engine:
`critical`/`high` ban immediately; otherwise strikes accrue to an auto-ban at 3. A ban
sets `User.bannedAt` (blocks sign-in, kills sessions on the next request, routes to
`/suspended`). Private-mode flags store no prompt preview.

**Admin = owner**, resolved purely from the `OWNER_EMAILS` env list (`src/lib/owner.ts`,
`admin.ts`) — there is no admin role column. Admin API routes return **404** (not 403) to
non-owners to hide the surface — except the three `admin/announcements*` routes, which
still return 403 and are therefore an existence oracle for the admin surface. Surfaces: `/api/admin/users` (search, plan edit, ban/unban
— owners are unbannable/undeletable), `/api/admin/moderation` (the flag queue),
`/api/admin/announcements` (+ `/upload`, 100 MB, magic-byte verified). **Announcements**
(`Announcement` + `AnnouncementDismissal`) surface the newest published, active,
not-yet-dismissed popup to signed-in users via `GET /api/announcements`.

---

## 13. Storage & uploads

`src/lib/storage.ts` targets any **S3-compatible** bucket (AWS S3, Cloudflare R2,
Supabase Storage, MinIO) when configured, else a local `./.uploads` disk fallback (dev;
ephemeral on Vercel — `isStorageAvailable` requires a bucket there). Object keys are
`uploads/<userId>/<uuid>-<sanitized-name>`. `getViewUrl` returns a public CDN URL when
`S3_PUBLIC_URL` is set, else a 1-hour presigned GET.

`POST /api/upload` (nodejs, rate-limited 60/h) validates MIME, enforces the plan's
`maxUploadMb`, verifies **images by magic bytes** (serving them inline), and stores
**everything else as `application/octet-stream` + `Content-Disposition: attachment`** so
uploaded HTML/JS can never render inline (stored-XSS/phishing prevention). Text-extractable
files under 1 MB get their text pulled (≤200 k chars) for multimodal context.
`GET /api/files/[...key]` is auth-gated with per-object authorization (`canReadObject`:
attachments → owner only; avatars/announcement media → any signed-in user) and returns
**404** for unreadable objects (no existence oracle); it honors HTTP Range for video.
`/api/attachments/[id]` handles per-file get/rename/delete (deleting the object only when
no other attachment shares the `storageKey` — library re-attach clones share keys).

> **Vercel note:** server-side uploads pass through a serverless function that caps request
> bodies (~4.5 MB). On the VM this cap doesn't apply; nginx is configured for `120m` bodies.

---

## 14. Product features

**Conversations & messages.** `/api/conversations` (list with title search + folder
filter; create; bulk delete), `/[id]` (thread; PATCH title/pin/archive/folder/project/
model — ownership-checked on moves; delete), `/[id]/messages` (idempotent native
transcript push, encrypted), `/[id]/title` (AI auto-titling that won't overwrite a manual
title, cascading to the project name), `/[id]/fork` (branch-from-here: copies messages up
to an anchor into a new conversation, ciphertext copied verbatim). Search is title-only
(message bodies are encrypted at rest). **Folders** (`/api/folders`) group chats
(conversations survive folder deletion). **Message edit** (`PATCH /api/messages/[id]`,
USER only) and **regenerate** both snapshot the prior content into an append-only
`MessageVersion` and truncate everything after; the transcript shows a ‹ n/total › pager
that lazily fetches `/versions`. Feedback (👍/👎) via `/feedback`.

**Projects** (`/api/projects`) bundle instructions + reference files. The project's
instructions and each reference file's extracted text are injected into the system prompt
for every turn in a project conversation. Native macOS and iOS clients project the
authoritative `project`, `conversation`, and `attachment` entities from encrypted SQLite;
create/edit/favorite/delete use the existing idempotent `/api/v1/mutations` outbox.
Reference uploads reuse bearer-capable `POST /api/upload` with `projectId`, while rename
and delete reuse `/api/attachments/{id}`. Expiring attachment URLs are never persisted:
the client rehydrates the attachment entity immediately before previewing it.

**Artifacts / Canvas.** `/api/artifacts` (library index across all conversations),
`/[id]` (versioned save with optimistic concurrency; rename; delete), `/[id]/export`
(Office export — **Markdown artifacts only** — to `.docx`/`.xlsx`/`.pptx` via `docx`,
`exceljs`, `pptxgenjs`, with format detection so the heavy converters aren't bundled
client-side). Rendered in the opaque-origin `SandboxFrame` (§4.3). Native macOS and
iOS clients project the existing `artifact` and `artifact_version` sync entities into
encrypted, account-scoped SQLite for offline history. An opened artifact refreshes
through the existing bearer route before editing; edits/restores send `baseVersion`,
surface 409 conflicts without overwriting, and reuse the existing rename/delete/export
operations. HTML/SVG previews use an ephemeral WKWebView with external main-frame
navigation and popups denied; source and Markdown remain selectable native content.

**Sharing.** `/api/share` (create/list), `/[id]` (revoke). A `Share` is a **snapshot
pointer**: the public `share/[token]` page (`force-dynamic`, `noindex`) renders only
content that existed at `snapshotAt`, so later messages/versions stay private. The token
is 24 random bytes (base64url), the only capability; revocation is a tombstone that 404s
the page from the next request; creating a share reuses the newest active link for a
target rather than orphaning snapshots.

**Scheduled tasks.** `/api/tasks` create a `ScheduledTask` (cadence DAILY / WEEKDAYS /
WEEKLY / MONTHLY, timezone-aware, plan-limited: PRO 3, MAX/OWNER 10, FREE 0). The
`juno-scheduler` PM2 worker (`scripts/scheduled-task-runner.ts`) claims due tasks every
60 s with an atomic `updateMany` (double-run-safe), runs them through `streamChat` with a
10-min ceiling and budget enforcement, and writes an encrypted USER+ASSISTANT pair into a
lazily-created results conversation.

**Roadmap.** `/api/roadmap` (public feature requests: create, vote-toggle — one per user
via a DB unique — comment; owner-only status moderation writing an append-only
`FeatureStatusEvent` timeline). Kanban board (Under review / Planned / In progress /
Shipped), trending sort by an HN-style gravity score.

**Library & prompts** (two distinct things sharing only the word "library"): the
**Library** page browses the user's `Attachment`s (`/api/library`, re-attachable to a new
message via `/attach` without re-uploading bytes); **prompts** are reusable `SavedPrompt`
snippets (`/api/prompts`) surfaced in a composer dialog, ordered by recent-use. Native
Library/Files surfaces reuse the synchronized attachment projection and hydrate a fresh
signed URL only when the user opens an item; signed URLs are never stored locally.

**Profile / import / export / compare.** Avatar upload (`/api/profile/avatar`, 5 MB,
served via a stable `/api/files/...` proxy path), activity stats and a spend mirror.
`POST /api/import` ingests a ChatGPT **or** Claude export ZIP (idempotent, content
encrypted). `GET /api/account/export` produces a full JSON snapshot or a message-history
CSV (RFC-4180 quoted + CSV-injection neutralized). The **Compare** page fans one prompt
out to 2–3 models by firing independent private-mode `/api/chat` requests in parallel (no
special endpoint), then "Continue in chat" seeds a fork.

---

## 15. Authentication & accounts

### 15.1 Web sessions (NextAuth v5)

`src/lib/auth.ts` configures Auth.js with **JWT sessions** and two providers:
**Credentials** (email + bcrypt password) and **Google** (only if both client id/secret
are set; no auto-linking by email — unverified credential emails could otherwise allow
takeover). To enable Google, create an OAuth client ID in the Google Cloud Console
(Credentials → OAuth client ID → Web application), add redirect URI
`https://<app>/api/auth/callback/google`, and set `GOOGLE_CLIENT_ID` /
`GOOGLE_CLIENT_SECRET`. Passwords use a **v2 scheme**: `bcrypt(base64(sha256(password)))` (the SHA-256
pre-hash defeats bcrypt's 72-byte truncation), 12 rounds, with lazy upgrade of legacy
hashes on login. Sign-in is rate-limited per-email and per-IP and returns a uniform
failure (no account-existence or ban oracle). OAuth tokens on the `Account` row are
encrypted at rest via an encrypted Prisma adapter. Registration
(`POST /api/auth/register`) is Zod-validated, rate-limited, and — unlike the rest of
`/api/auth/*` — still subject to the CSRF origin check.

**Session invalidation** is via `User.sessionVersion`: JWTs carry the version they were
issued with; bumping it (password reset) instantly invalidates every older web JWT *and*
native access token. Cross-subdomain cookies are enabled only when `COOKIE_DOMAIN` is set
(`__Secure-` prefixed in production).

**Password reset** (`/api/auth/forgot-password` + `/reset-password`) sends a one-hour,
single-use link via Resend. The token is delivered in the URL **fragment** (never logged),
stored only as a **SHA-256 digest**, consumed in a concurrency-safe transaction that also
bumps `sessionVersion`. Without `RESEND_API_KEY` the forgot-password route returns 503 and
all sends are silent no-ops. Anti-enumeration: uniform response + a minimum response time.

### 15.2 Native bearer auth (PKCE device authorization)

Native apps authenticate under `/api/v1/auth/*` (`src/lib/native-auth*.ts`). The browser
side of the flow lives at `/app-auth`: it validates a PKCE-S256 authorization request,
requires a signed-in cookie session, and issues a short-lived `NativeAuthorizationCode`
handed back through the app's `com.liammagnier.juno://auth/callback` deep link. The app
exchanges it at `POST /api/v1/auth/token` for a bundle:

- **Access token** — a jose **HS256 JWT**, audience `juno-native`, **10-minute** TTL,
  signed with a key *derived from but namespaced away from* `AUTH_SECRET`. Claims include
  the device session id and `sessionVersion`.
- **Refresh token** — 30-day, **rotating** with reuse detection: a replayed token revokes
  the entire device session and token family (`POST /api/v1/auth/refresh`).

`GET /api/v1/auth/session`, `POST /logout`, `GET /devices`, `DELETE /devices/[id]`
complete the surface. Every exchange consumes state in a **Serializable** transaction.
`authenticateNativeBearer` rejects banned users and `sessionVersion` mismatches, so a
global logout kills native sessions too.

### 15.3 Shared authorization & account lifecycle

`getCurrentUser()` (`src/lib/session.ts`, React-cached) is the dual-mode gate: if an
`Authorization` header is present, the **bearer is authoritative** (never falls back to a
cookie); otherwise the Auth.js cookie session is used. Both paths reload the user and
return `null` for a missing or banned account (a mid-session ban logs the user out on the
next request). Every mutating route scopes queries with `where: { userId }`. A CSRF
middleware (`src/middleware.ts`) rejects cross-origin cookie-bearing writes (requests with
no `Origin`, i.e. native/server, pass; the Stripe webhook and NextAuth are exempt).

Account lifecycle: settings live at `GET`/`PATCH /api/settings`; `DELETE /api/account`
and `POST /api/account/delete` (email-confirmed) run a GDPR cascade (best-effort Stripe
cancel, storage purge, then a cascading `user.delete`); `GET /api/account/export` is the
data export.

---

## 16. Native sync API (`/api/v1`)

A versioned (`CONTRACT_VERSION = 1.1.0`) bearer-authenticated contract that native
clients use to mirror an account offline. Every response carries `X-Juno-Request-Id` +
`X-Juno-Contract-Version`; errors are a typed envelope `{ error: { code, message,
requestId, retryable, retryAfterMs } }`. The canonical source is
`contracts/openapi/juno-native-v1.yaml` (hand-authored); `scripts/generate-native-swift-contract.mjs`
generates Swift models from it and fails the build on drift.

- **`GET /bootstrap`** — a fresh-client baseline: profile, subscription, usage, settings,
  `currentChangeCursor`, `compactionFloorCursor`, `modelManifestVersion`, contract/minimum
  versions. Entities are hydrated separately.
- **`GET /changes`** + **`GET /changes/stream`** — a cursor-based change feed. The cursor
  is a Postgres BIGSERIAL id (decimal string). `/changes` pages changes after a cursor
  (envelope: `{cursor, entityType, entityId, parentEntityId, revision, operation:
  upsert|delete, changedAt}`); a cursor below the compaction floor → **410**
  `cursor_compacted` (resync from bootstrap). `/changes/stream` is an SSE wake-up channel
  (not data) with a 55 s window, 15 s heartbeat, and `cursor` events on advance.
- **`GET /entities/index`** — keyset-paginated owner-scoped live entity inventory for
  fresh installs and compaction rebuilds. The client captures `/bootstrap` first,
  enumerates ids here, hydrates them, commits the baseline atomically, then replays
  `/changes` after that captured cursor so concurrent writes cannot be lost.
- **`GET /entities`** — batch hydration by type + ids (≤100) discovered by the inventory
  or change feed. 22 loaders cover profile,
  settings, subscription, folder, conversation, message (decrypted), message_version,
  attachment (signed url), artifact(+version), project, memory, saved_prompt, connection
  (credentials excluded), usage, share, announcement_dismissal, scheduled_task,
  code_device, code_task, code_task_event, code_workspace. Deleted rows return tombstones
  (`data:null` + `deletedAt`); foreign ids are omitted.
- **`POST /mutations`** — idempotent mutation envelopes (`clientMutationId` unique per
  `(account, device)`), executed in a **Serializable** transaction with optimistic
  `baseRevision` concurrency (mismatch → **409** `revision_conflict`; reused key with a
  different hash → **409** `idempotency_key_reused`). Mutable types: conversation, folder,
  project, memory, settings. `memory.create` / `memory.update` go through the same
  suppression door the web writes use, so content the account asked Juno to forget is
  refused with **409** `suppressed_by_memory` (`retryable:false`, the covering statement
  in `details.suppression`) — a queued offline mutation must be dropped, not retried. Conversation updates include title, pin, sticky model,
  project/folder placement and archive state. Project updates include name, instructions
  and the boolean favorite state (`starred`).
- **`GET /models`** — the native model catalog (ETag'd).
- **Existing general chat routes** — operation-level `/api` servers in the same
  contract publish the bearer-capable transcript append, chat SSE, cancellation and
  first-submission receipt operations without duplicating their production services.

**Change capture is done entirely by Postgres triggers**
(`prisma/migrations/.../account_change_log`), so *any* write — web or native — to a tracked
table auto-emits an `AccountChange` (with a monotonic cursor) and upserts an
`EntityRevision` (incrementing `revision`, setting `deletedAt` on delete). 24 triggers
cover the synced tables. The feed is pruned by `npm run sync:prune`
(`scripts/prune-sync.ts`): it deletes `AccountChange`/`MutationReceipt` rows past the
retention window (default 30 days, min 7) and advances the monotonic **compaction floor**
in `SyncCompaction`; `EntityRevision` (current state) is never pruned. A cookie-session twin
(`/api/sync/changes` + `/api/sync/stream`) serves the shipping web app from the same code.

---

## 17. Data model

Prisma schema: `prisma/schema.prisma` (48 models, 13 enums). Message `content`,
`reasoning`, and `reasoningParts` are **encrypted at rest** (AES-256-GCM,
`src/lib/message-crypto.ts`); connector tokens and OAuth tokens are likewise encrypted.
Every relation cascades from `User` (account deletion is a single cascading delete).

**Users / auth / connectors.** `User` (email, `hashedPassword?`, `sessionVersion`,
moderation fields `bannedAt`/`banReason`/`bannedBy`/`strikes`, image). `Account`,
`Session`, `VerificationToken` (Auth.js). `Connection` (encrypted connector tokens +
`oauthClientId`/`oauthClientSecret` for `mcp_oauth`, `@@unique([userId, provider])`).
`NativeAuthorizationCode`, `NativeDeviceSession`, `NativeRefreshToken` (PKCE device auth,
token families).

**Sync.** `AccountChange` (BIGSERIAL cursor change log), `EntityRevision` (per-entity
current revision + tombstone), `SyncCompaction` (single `global` row, monotonic floor),
`MutationReceipt` (idempotency).

**Conversations & messages.** `Settings` (theme/accent/defaultModel/customInstructions/
responseLanguage/uiLocale/personality/memoryEnabled/voiceId/favoriteModels/email opt-ins).
`Folder`. `Conversation` (title + `titleSource`, `model`, `kind` chat|code, `origin`,
`clientRequestId`, pin/`archivedAt`, `folderId`/`projectId`/`forkedFromId`,
`activeConnectors`, code-workspace attribution). `Project` (name + `nameSource`,
instructions, starred). `Message` (`role`, encrypted `content`/`reasoning`/
`reasoningParts`, `model`, `feedback`, token counts, `costMicroUsd`, `sources`, `activity`;
`clientId` for idempotent native pushes). `MessageVersion` (append-only edit/regenerate
history). `ChatFirstSubmissionReceipt` (durable first-submission idempotency + lease).
`VoiceTranscriptSession`.

**Memory.** `MemoryEntry` (FACT/SUPPRESSION), `ConversationMemory` (per-chat high-water),
`MemorySummary`.

**Artifacts.** `Artifact` (+ `currentVersion`), `ArtifactVersion` (append-only,
`@@unique([artifactId, version])`).

**Billing / usage.** `Subscription` (Stripe ids, plan, status, period). `Usage` (per
`YYYY-MM` message count + token aggregates). `ApiSpend` (append-only per-call ledger,
micro-USD, `kind`/`source`). `RateLimit` (fixed-window buckets).

**Moderation / announcements.** `ModerationFlag` (audit + strike/ban actions).
`Announcement`, `AnnouncementDismissal`.

**Code.** `CodeDevice` (host registration, platform macos|windows), `CodeTask` (queue +
cloud fields `target`/`repoOwner`/`repoName`/`baseRef`/`prUrl`/`runnerClaimedAt`, session
fields `parentSessionId`/`createsNewSession`/`origin`/`idempotencyKey`), `CodeTaskEvent`
(append-only), `CodeRemoteSession` / `CodeRemoteSessionEvent` / `CodeSessionCommand`
(phone↔Mac remote control), `CodeWorkspace` (stable `key` workspace identity).

**Sharing / tasks / roadmap / prompts.** `Share` (`ShareKind` CHAT|ARTIFACT, token,
`snapshotAt`, `revokedAt`, views). `ScheduledTask` (`TaskCadence`) + `ScheduledTaskRun`.
`FeatureRequest` (`FeatureStatus`, `FeatureCategory`) + `FeatureVote` +
`FeatureComment` + `FeatureStatusEvent`. `SavedPrompt`.

**Enums:** `Role` (USER/ASSISTANT/SYSTEM — message roles, *not* authorization), `Theme`,
`MemorySource`, `MemoryKind`, `AttachmentKind`, `ArtifactType`, `Plan`, `SubStatus`,
`Feedback`, `FeatureStatus`, `FeatureCategory`, `ShareKind`, `TaskCadence`.

---

## 18. Security

- **Provider, Stripe, storage, and voice keys are server-only** — read from environment
  in route handlers, never shipped to the browser. There is no BYOK path; every generation
  bills the plan.
- **Every mutating route** authorizes the session/bearer user and scopes queries to their
  data; admin/owner surfaces return 404 (not 403) to hide their existence.
- **At-rest encryption** (AES-256-GCM) for message content/reasoning and all connector /
  OAuth tokens, keyed by `AUTH_SECRET`-derived keys (rotatable via
  `TOKEN_ENCRYPTION_KEYS`/`TOKEN_ENCRYPTION_PRIMARY` + `npm run crypto:rotate`).
- **Session invalidation** via `User.sessionVersion` covers both web JWTs and native
  access tokens; native refresh tokens rotate with family-wide reuse revocation.
- **CSRF** origin check on all cookie-bearing API writes (`src/middleware.ts`).
- **Rate limiting** (Postgres fixed-window) on auth, chat, upload, generation, and abuse-
  prone routes; the IP source doesn't trust spoofable left-most `X-Forwarded-For`.
- **Artifact sandboxing:** opaque-origin iframe, `allow-scripts` only (no
  `allow-same-origin`) — artifact code cannot reach cookies, storage, or the app DOM;
  parent trusts only `postMessage` from the frame's own `contentWindow`.
- **Uploads:** magic-byte verification, non-images forced to download
  (`Content-Disposition: attachment` + `application/octet-stream`), per-plan size caps,
  ownership-checked reads that 404 (no existence oracle).
- **Idempotency & receipts** prevent duplicate charges/conversations on retries;
  cloud-Code uses credential-free OIDC handshakes and single-use, short-lived task tokens
  so no secret ever rides workflow inputs or reaches the runner.
- **Moderation** blocks the worst content before generation and fails open on the
  classifier; markdown renders without raw HTML; input is Zod-validated throughout.
- **Baseline headers** (`next.config.mjs`): nosniff, `X-Frame-Options: SAMEORIGIN`,
  referrer policy, `Permissions-Policy` (microphone only), HSTS. A full CSP is future work
  (Next.js inline scripts need per-request nonces).
- **Privacy:** interface auto-translation sends only opaque catalog IDs, never user
  content; the deep-research/source favicons load from each source's own origin, not a
  proxy; public shares are `noindex` snapshots.

---

## 19. Configuration & environment variables

Copy `.env.example` → `.env`. **Required** must be set; everything else degrades
gracefully when absent.

### Required
| Var | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string (the datasource uses this only). |
| `ANTHROPIC_API_KEY` | Default provider (and the i18n translator). |
| `AUTH_SECRET` | JWT signing + at-rest encryption seed (`openssl rand -base64 32`). |
| `NEXT_PUBLIC_APP_URL` | Public origin (reset links, OAuth callbacks, native token issuer, Apple MCP dial-in). |
| `AUTH_URL` | Public origin for Auth.js redirects behind nginx (else sign-out → localhost). |

| `DIRECT_URL` | Connection used for **schema operations only** (`migrate deploy` / `db push` / `db execute`) — wired as `directUrl` in `prisma/schema.prisma`. On Supabase, point it at the **session** pooler, the same as `DATABASE_URL`. |

> **`DIRECT_URL` is load-bearing, not optional.** `.github/workflows/deploy.yml`
> hard-fails the deploy when it is missing or empty, because migrations run over
> it rather than over the runtime pooler (see §20.2 for the two failure modes
> that forced this).

### Optional (feature degrades when absent)
| Group | Vars |
|---|---|
| Google sign-in | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| Password-reset email | `RESEND_API_KEY`, `EMAIL_FROM` |
| Owner/admin | `OWNER_EMAILS` (comma-separated) |
| Storage (S3) | `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`, `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE`, `S3_PUBLIC_URL` |
| Billing | `STRIPE_SECRET_KEY`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_MAX`, `STRIPE_PRICE_MAX20`, `STRIPE_WEBHOOK_SECRET` |
| Extra providers | `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `ZHIPU_API_KEY`, `MOONSHOT_API_KEY`, `DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`, `XAI_API_KEY`, `MINIMAX_API_KEY`, `MIMO_API_KEY`, `DASHSCOPE_API_KEY`, `SEEDANCE_API_KEY`, `LONGCAT_API_KEY` (+ optional `*_BASE_URL`) |
| Connectors | `COMPOSIO_API_KEY`, `GITHUB_OAUTH_CLIENT_ID`/`_SECRET` (+ `GITHUB_MCP_URL`), `FIGMA_OAUTH_CLIENT_ID`/`_SECRET`/`FIGMA_OAUTH_SCOPE`/`FIGMA_MCP_URL`, `NOTION_MCP_URL`, `APPLE_MUSIC_TEAM_ID`/`_KEY_ID`/`_PRIVATE_KEY` |
| Web search / deep research | `TAVILY_API_KEY` |
| Voice (read-aloud/dictation) | `STT_PROVIDER`, `TTS_PROVIDER`, `OPENAI_API_KEY`, `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`/`_VOICE_ID`, `STT_MODEL`/`TTS_MODEL`/`TTS_VOICE` |
| Voice relay | `NEXT_PUBLIC_VOICE_RELAY_URL` (build-time gate), `VOICE_RELAY_URL`, `GEMINI_LIVE_API_KEY`, `ALLOWED_ORIGINS`, `RELAY_*` overrides |
| Cloud Code | `CLOUD_CODE_SECRET`, `GITHUB_DISPATCH_TOKEN`, `CLOUD_CODE_REPO` |
| Cross-subdomain cookies | `COOKIE_DOMAIN` |
| API rewrite target (UI-on-Vercel setup) | `RENDER_BACKEND_URL` |
| Benchmarks | `AA_API_KEY` |
| Encryption rotation | `TOKEN_ENCRYPTION_KEYS`, `TOKEN_ENCRYPTION_PRIMARY` |

---

## 20. Deployment & operations

### 20.1 Production topology (VM)

The reference deployment runs everything on an always-free VM (Oracle Cloud or GCP;
`deploy/VM_SETUP_GUIDE.md` and `deploy/GCP_SETUP_GUIDE.md` are the click-by-click
runbooks). **nginx** (443, TLS via Certbot) reverse-proxies:

- `/` → `127.0.0.1:3000` (Next.js) — SSE-friendly: `proxy_buffering off`,
  `proxy_read_timeout 3600s`, `client_max_body_size 120m`, larger header buffers.
- `/voice-relay` → `127.0.0.1:8787` (relay) — WebSocket upgrade, `proxy_read_timeout 7200s`.

**PM2** (`deploy/ecosystem.config.js`) runs three processes: `juno-backend`
(`npm start`, `:3000`, ~1.4 GB restart ceiling, raised HTTP header size),
`juno-voice-relay` (`relay/`, `:8787`), and `juno-scheduler` (`tasks:runner`).

### 20.2 Database (Supabase / Postgres)

Juno runs on hosted **PostgreSQL** — the reference deployment uses **Supabase**
(`eu-west-1`); Neon works identically. Juno uses **two** connection strings:

- **Pooled host** (`…-pooler…`, PgBouncer) — this is what `DATABASE_URL` points at
  and what the running app uses. Pooling is essential because many short-lived
  request handlers each open a connection; the pooler keeps Postgres from exhausting
  its connection slots.
- **A second connection string** (`DIRECT_URL`) — used **only for schema
  operations** (`prisma migrate deploy` / `db push` / `db execute`), wired as
  `directUrl` in `prisma/schema.prisma`. This used to be derived by stripping
  `-pooler` from `DATABASE_URL`, which only ever worked because Neon happened to
  name its hosts that way and was a silent no-op on any other provider; it is now
  an explicit environment variable the deploy validates. Two hard-won reasons
  migrations must not run over the runtime pooler:
  - **P3009 poisoning** — through PgBouncer, Prisma's write that marks a migration
    *completed* in `_prisma_migrations` can be dropped, leaving a "failed" record
    that makes every later deploy refuse to run.
  - **P1002 lock timeouts** — Prisma's migrate advisory lock doesn't survive a pooled
    connection, so a canceled deploy orphans the lock and later migrations hang. The
    deploy therefore also sets `PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK=1` (safe here
    because the GitHub Actions concurrency group already serializes deploys).

On Supabase, **both** strings should be the Supavisor **session** pooler (port
5432): the *transaction* pooler (6543) multiplexes connections and cannot keep the
prepared statements Prisma needs, and the *direct* host (`db.<ref>.supabase.co`)
resolves to IPv6 only, which the deploy VM cannot reach. **Migration history:** early
production used `db push`; `scripts/baseline-production-migrations.mjs` converges that
history once, after which `prisma migrate deploy` runs reviewed migrations
exclusively. The **change-capture triggers** that power the native sync feed (§16)
live in the `prisma/migrations/` SQL and are applied the same way. For local
development, `npx prisma migrate dev` against a dev database is all you need; Neon's
free tier is enough.

### 20.2b Schema changes must be expand/contract

`prisma migrate deploy` runs against the live database **while the old code is
still serving** — the deploy applies migrations, then reloads PM2. And Prisma has
no down-migrations: there is no `migrate rollback`. A migration that the running
code cannot tolerate is therefore an outage, not an inconvenience.

All 45 migrations to date are additive — verified: zero `DROP COLUMN`, `DROP
TABLE`, `DROP CONSTRAINT` or `SET NOT NULL` anywhere in `prisma/migrations/`. That
is why this has never bitten. The first destructive change will, unless it is
split:

| Want | Do it as |
|---|---|
| Add a required column | add it **nullable** → deploy → backfill → make required in a **later** release |
| Rename a column | add the new one → write both → backfill → switch reads → drop the old one a release later |
| Drop a column | stop reading it → deploy → drop it in a **later** release |
| Narrow a type / add a constraint | add a check that tolerates existing rows → clean the data → tighten later |

The rule in one line: **every migration must leave the previous release still
working.** Two releases, never one.

### 20.3 Continuous deployment (GitHub Actions)

Pushing to `main` deploys automatically — the low-RAM VM never has to build. The
web deploy, native CI, model-sync, macOS publication, iOS publication and Cloud
Code workflows live in `.github/workflows/`. The native CI workflow gates the
Swift surface (shared packages, the generated API contract, and both app builds)
and is documented in `docs/native/TESTING.md` rather than here.

**`deploy.yml` — Deploy to VM** (on push to `main`, on every pull request, and on
manual dispatch). Concurrency is keyed on whether the run deploys: every deploying
run (push or dispatch) shares the serialised `deploy-vm` group and **queues**, while
pull requests get a disposable per-branch `deploy-pr-<ref>` group with
cancel-in-progress. A superseding run must never sever a deploy midway through its
`rsync --delete` or `prisma migrate deploy`. Pull requests run the `test`,
`migrations` and `runner` jobs; only `build-and-deploy` is skipped, guarded on
`github.event_name != 'pull_request'`:

1. **`test` job** — `npm ci` → `npm run i18n:extract` → `npx tsc --noEmit` →
   `npm test` → `npm run lint`. The catalog step is needed because
   `src/lib/i18n-catalog.generated.ts` is generated rather than tracked. A
   failure here blocks the deploy. (This is the real type-check gate; the production
   `next build` itself ignores type errors so it can finish on the VM's RAM budget.)
   Runs in roughly 90–100 seconds; a "15-minute" run is a job that never got a
   runner, not a slow suite.
2. **`migrations` job** — boots a Postgres 16 service container, replays the
   migrations and diffs the result against `prisma/schema.prisma`, so a migration
   that does not reproduce the schema fails the build.
3. **`runner` job** — builds and tests `runner/agent-core`, including the
   adversarial containment suite, and asserts the Work orchestration sources
   actually reached the compiled output.
4. **`build-and-deploy` job** — writes the production `.env` from the **`PROD_ENV`**
   secret (the single source of truth for every prod env var), builds the app *and*
   the voice relay on GitHub's fast, high-RAM runners, then `rsync`s the build to the
   VM over SSH. The rsync uses `--delete` with careful excludes so persistent runtime
   paths are never wiped: `.env*` (VM secrets), `.uploads` (locally-stored
   avatars/attachments), `logs`, `node_modules`, `.next/cache`. Changed/rotated
   `PROD_ENV` keys are upserted into the VM's runtime `.env` (with an `.env.bak`
   rollback), preserving any VM-only keys. On the VM it then runs the `DIRECT_URL`
   migrations (§20.2), a conditional `npm ci` (only when the lockfile hash changed),
   `prisma generate`, an nginx header-buffer patch if needed, and
   `pm2 startOrReload deploy/ecosystem.config.js --update-env` + `pm2 save`.

Required **protected Production environment inputs**: `PROD_ENV` (the full
production env file), `VM_SSH_KEY`, `VM_KNOWN_HOSTS`, `VM_USER`, and `VM_HOST`.
`PROD_ENV` must also contain `JUNO_SMOKE_TOKEN` or `JUNO_SMOKE_COOKIE`; the
post-deploy authenticated catalog/chat/receipt/replay smoke never has an
optional skip path. All provider keys and app secrets (including
`CLOUD_CODE_SECRET`, `GITHUB_DISPATCH_TOKEN`, etc.) live inside `PROD_ENV`.
The job independently checks the public origin and UI after the VM-local check,
and a failed post-deploy check restores the prior application snapshot while
leaving the database forward-only.

**`sync-models.yml` — Sync models** (nightly cron `04:17 UTC` + manual): runs
`sync:models:write` (provider discovery → `models.generated.ts`), `sync:benchmarks`
(Artificial Analysis grades → `benchmarks.generated.ts`, needs `AA_API_KEY`), and
`radar:models` (OpenRouter industry diff), then `validate:models`. When anything
changed it commits the regenerated files and opens a GitHub issue labeled
`model-watch` for hand-curation. Provider keys are repo secrets; a provider with no
key is skipped, and a failed fetch never prunes.

> This used to say the nightly commit "auto-deploys via `deploy.yml`". It does
> not. The job pushes with `actions/checkout`'s default `GITHUB_TOKEN`, and GitHub
> deliberately does not raise workflow events for pushes made with that token —
> otherwise a workflow could trigger itself indefinitely. So registry changes sit
> on `main` until the next real push deploys them. That is the safer behaviour
> (no unattended 04:17 deploy that drops in-flight SSE streams), but it was
> documented backwards in both this file and the workflow's own header.

**`code-runner.yml` — Cloud Code runner** (dispatched per cloud Code task) is
documented in §9.3.

### 20.3b Rolling back a bad deploy

The deploy rsyncs `--delete` straight over the live directory, so before this
existed the previous version stopped existing the moment a deploy began — a bad
release meant revert → rebuild → redeploy → migrate, with the bad build serving
for the twenty minutes that took.

`deploy.yml` now snapshots the running build to `~/juno-previous` first
(hardlinked, so it costs seconds and almost no space). Its final failure step
performs the rollback automatically and preserves the current `.env`, uploads
and logs before activating the snapshot. If the workflow itself cannot reach
the VM, do not blindly rsync the snapshot over the live tree: use the pinned
SSH path and preserve those runtime paths first.

For a controlled operator rollback when the VM is reachable:

```bash
ssh <vm> 'cd ~ && rsync -a --delete \
  --exclude ".env" --exclude ".env.*" --exclude ".uploads" \
  --exclude "logs" --exclude "node_modules" --exclude ".next/cache" \
  juno-previous/ juno/ && pm2 reload deploy/ecosystem.config.js --update-env'
```

Three things this does **not** do, and you must think about each:

- **It does not roll back the database.** Migrations are applied before the
  reload and Prisma has no down-migrations. Rolling code back under a migrated
  schema is only safe because every migration is additive — which is exactly the
  expand/contract rule in §20.2b, and the reason that rule is not optional.
- **It keeps only one generation.** The snapshot is overwritten on the next
  deploy, so roll back *before* deploying again.
- **It does not roll back `.env`, uploads or logs.** Preserve the live runtime
  paths before using the shorthand command; the workflow's automatic rollback
  already does this.

The VM-local `deploy/deploy.sh` path uses the fuller scheme: immutable
`releases/<sha>-<timestamp>-<pid>` directories with atomic `current` and
`previous` symlinks, candidate build/migration verification, expected-SHA health
checks, and PM2 rollback. Database migrations remain forward-only.

### 20.4 Manual deploy (`deploy/deploy.sh`)

For a deploy from the VM itself (or first-time setup), `deploy/deploy.sh` is the
idempotent release transaction. It requires a clean checkout and reviewed
environment, fetches the selected commit without rewriting the checkout,
materializes an immutable candidate, installs/builds it, verifies the migration
ledger, runs only `prisma migrate deploy`, atomically switches `current`, and
reloads the complete PM2 ecosystem. It rolls back application pointers and PM2
when activation or expected-SHA health fails; it never uses `prisma db push` or
ad-hoc SQL. The `deploy/VM_SETUP_GUIDE.md` (Oracle) and
`deploy/GCP_SETUP_GUIDE.md` runbooks cover one-time VM provisioning
(Node/PM2/nginx/Certbot, swap for the 1 GB build, firewall).

### 20.5 UI-on-Vercel variant

Deploy the UI to Vercel and set `RENDER_BACKEND_URL` so `/api/*` rewrites to the VM
(bypassing serverless timeouts), or route the whole `/api/` path to the VM via Cloudflare
Origin Rules (zero CORS). Share cookies cross-subdomain with `COOKIE_DOMAIN=".yourdomain.com"`.
The voice relay can alternatively run on Render (`render.yaml`, free tier, sleeps after
~15 min).

### 20.6 Routine maintenance

- **Sync-log pruning** (`AccountChange`/`MutationReceipt` grow forever): weekly
  `npm run sync:prune` (advances the compaction floor). A client cursor below the floor
  gets a 410 and resyncs from bootstrap — that's the protocol working, not an error.
- **Model registry**: the nightly workflow syncs it from live provider APIs; promote
  worthwhile `DISCOVERED` entries into `CURATED` and run `npm run validate:models`.
- **Encryption key rotation**: `npm run crypto:rotate`.
- **Log rotation**: PM2 writes `logs/*.log` unbounded. Run `pm2 install
  pm2-logrotate` once on the VM (idempotent) or the disk fills eventually.
- **Health**: ordinary `GET /api/health` returns `{ ok, db, version, uptime }`,
  performs only a bounded database liveness check, and answers **503** when
  Postgres is unreachable. An external uptime monitor needs no special
  configuration — point it at that URL and alert on non-200. Owner-gated
  provider readiness is an explicit `?readiness=1` (with `?diagnostic=1` and
  legacy `?probe=1` aliases); it is never part of public liveness and is bounded
  with cancellable per-provider and batch deadlines.
- **Provider health**: `src/lib/provider-health.ts` probes each configured
  provider with a 1-token completion (10 min TTL, 30 min while a provider is
  known down) and hides unhealthy providers' models from the catalog. Only
  auth/billing failures count — 429s and 5xx are ordinary provider weather.
  A healthy→unhealthy transition raises an operator alert.
- **Operator alerts**: `alertOperator()` (`src/lib/alerts.ts`) writes a structured
  `[alert]` line to stderr always, and additionally mails `OWNER_EMAILS` when
  `RESEND_API_KEY` is set, deduplicated to one message per hour per alert.
  `grep '\[alert\]' logs/err.log` is the audit trail.
- **Backups**: see §20.7. The repository now has custom-format PostgreSQL backup,
  byte-digest verification, scratch-only restore and a disposable local drill;
  remote scratch RPO/RTO evidence and offsite retention remain operational gates.
  User data export is available per-account via `GET /api/account/export` and
  is not a replacement for byte-level backup.

### 20.7 Backup & disaster recovery — **implemented, operationally unverified**

> **Status: local evidence passes; production RPO/RTO is not confirmed.** The
> repository has `scripts/backup-production.mjs`, `scripts/verify-backup.mjs`,
> `scripts/restore-production.mjs`, `scripts/restore-drill.mjs` and the runbook
> `docs/runbooks/BACKUP_RESTORE.md`. Backups contain a custom-format `pg_dump`
> plus a per-object SHA-256/byte manifest. Verification reads every database and
> object byte. Restore refuses production-looking targets, requires explicit
> scratch destinations, validates all manifest paths/digests before writing, and
> the disposable local drill round-trips database rows and object bytes.
>
> A remote scratch restore with measured RPO/RTO, offsite retention, encryption,
> and an operator-owned schedule is still required before claiming disaster
> recovery is production-proven.

This section previously claimed backups relied on "Neon's branching/point-in-time
restore". That was wrong twice over: the reference deployment is **Supabase**, not
Neon (§20.2), and no restore capability was ever verified.

**What an operator must confirm in the Supabase dashboard** (neither is visible
from the repo, and the local `.env` is not authoritative — production env lives in
the protected `PROD_ENV` GitHub Actions secret):

1. **The project's plan tier.** Supabase's Free tier has no point-in-time recovery
   and no scheduled backups; daily backups begin on Pro. On Free, a bad migration
   or an accidental delete is unrecoverable.
2. **The actual backup/retention configuration** — whether PITR is enabled, and the
   retention window in days.

**Why the retention answer is load-bearing, not academic.** Two jobs delete data on
a schedule or on demand: the weekly `npm run sync:prune` (`deploy/VM_SETUP_GUIDE.md`,
30-day default window) and the cascading account delete. If retention is shorter than
the time it takes to *notice* a bad prune, backups do not help.

**Uploads are a separate failure domain.** The backup manifest and restore drill
cover object bytes, but production must still prove that the configured storage
backend is redundant and included in its retention policy. `isStorageConfigured()`
requires the bucket and both credentials; when those are absent, attachments,
avatars and generated images use the VM's local `.uploads` directory (§13). The
deploy workflow excludes that directory from `rsync --delete`, which preserves it
across releases but is not redundancy. A database restore must therefore be
validated together with the matching object target, not by rows alone.

`GET /api/account/export` writes attachment *metadata*, not bytes, so it is not a
substitute. Configure and verify an S3-compatible bucket (or an equivalent
managed redundant store), then include it in the scratch restore drill; a drill
that proves only the database comes back gives false confidence.

**Restore drill.** Once the plan tier and storage target are known, run
`docs/runbooks/BACKUP_RESTORE.md` into an empty scratch database and empty
object target. Record the date, backup age/RPO, restore duration/RTO, row and
object counts, digest comparison, retention, and encryption here. If the
managed plan has no recoverable backup, record that explicitly rather than
calling the local drill production recovery.

Any dump must go through the Supavisor **session** pooler (5432) for the reasons in
§20.2 — never the transaction pooler (6543), never `db.<ref>.supabase.co` (IPv6-only).
Do not commit a backup script carrying a connection string.

---

## 21. Development: scripts & tests

```bash
npm run dev            # next dev (runs i18n:extract first)
npm run build          # prisma generate + next build
npm run lint           # eslint
npm test               # tsx tests + auth + message-crypto + moderation
npm run db:migrate     # prisma migrate dev
npm run db:studio      # Prisma Studio
npm run i18n:extract   # regenerate the static UI translation catalog
npm run validate:models
npm run sync:models    # dry-run provider discovery (sync:models:write to apply)
npm run sync:benchmarks
npm run sync:prune     # prune the sync change log
npm run tasks:runner   # the scheduled-task worker (juno-scheduler)
```

Tests (`tests/*.test.ts` + `scripts/test-*.ts`, run via `tsx`) cover auth token/locale
helpers, message crypto, moderation logic (with provider keys scrubbed to force fail-open),
memory backfill/suppression, clarify, and the code-remote-sessions ordering/planner logic.

> **What still needs operational evidence, stated plainly:** the repository test
> suite covers the chat pipeline, spend policy, provider adapters, authorization
> contracts and release workflow invariants, but two database-backed suites are
> skipped unless their explicit test database is configured. Authenticated
> browser/native journeys, real provider/model availability, visual/accessibility
> snapshots, remote restore RPO/RTO, and signed Apple artifacts remain release
> gates. The `tests/*.test.ts` glob intentionally covers the root test suite;
> subdirectory suites must be invoked explicitly or added to the script.
Local dev: `npm install`, `cp .env.example .env`, `npx prisma migrate dev`, `npm run dev`
→ <http://localhost:3000>. For voice, run the relay with `RELAY_ENABLE_MOCK=1` and set
`NEXT_PUBLIC_VOICE_RELAY_URL=ws://localhost:8787`.

> **Build note:** `next.config.mjs` sets `typescript.ignoreBuildErrors` and
> `eslint.ignoreDuringBuilds` because the 1 GB build VM OOMs on the type-check worker —
> catch type errors locally with `npx tsc --noEmit` before pushing.
