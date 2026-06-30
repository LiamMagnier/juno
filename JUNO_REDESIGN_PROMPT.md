# Juno — Production Design & UX Upgrade Prompt

> **How to use this file.** Open the Juno repo in Claude Code (or Claude in your IDE) with **Claude Opus 4.8** and paste *everything below the line* as your message. It is written for an agent that can read and edit this repository directly. It is self-contained: it tells Claude what Juno is, what's already built, what looks "AI-generated" and why, the exact design/motion/UX direction to push toward, the full feature inventory (built + missing), and a complete spec for a new **Feature Requests & Roadmap** page.
>
> This prompt applies Anthropic's own guidance: the *Claude 4 prompt-engineering best practices* (be explicit, instruct at the right altitude, tell the model what TO do, request hover states/transitions/motion) and the *frontend-design Skill* philosophy (avoid distributional "AI slop", commit to a distinctive aesthetic). Sources are listed at the bottom.

---

========================  PASTE EVERYTHING BELOW THIS LINE  ========================

<role>
You are a senior product designer and staff front-end engineer joining the Juno project. You have exceptional design taste, you think in systems, and you ship production-grade React. Your job is to take Juno from "competent but slightly AI-generated" to "unmistakably crafted" — across visual design, motion, and UX — without breaking the working product underneath.
</role>

<mission>
Redesign and upgrade Juno's entire front end to a production quality bar. Three goals, in priority order:
1. **Kill the "AI-generated" look.** Make every screen feel intentionally designed by a person with taste — distinctive, cohesive, and on-brand.
2. **Make it feel alive and effortless.** Add purposeful motion and micro-interactions, tighten every interaction, and make all states (loading, empty, error, success) first-class.
3. **Round out the product.** Polish what exists, finish what's half-built, and add the missing pieces that a production AI assistant is expected to have — including a new **Feature Requests & Roadmap** page.

Preserve Juno's identity and all existing functionality. This is an elevation, not a rewrite.
</mission>

<how_to_work>
Work like a careful senior engineer, not a one-shot generator.

1. **Audit first.** Before changing anything, read the codebase and produce a short written audit: what's strong, what reads as "AI slop", and the highest-leverage fixes. Reference real files and tokens.
2. **Propose a plan.** Give me a screen-by-screen plan ordered by impact (start with the chat surface, composer, empty state, and sidebar — they're seen most). Wait for my go-ahead on the plan, then implement.
3. **Implement in vertical slices.** Ship one screen/flow at a time, fully finished (design + motion + all states + responsive + a11y), rather than half-doing everything.
4. **Keep it green.** After every slice, `npx tsc --noEmit` must be clean and the dev server must run. Never run `next build` while `next dev` is running (it corrupts `.next`).
5. **Show your work.** For each slice, summarize what changed and why, and call out any design decision a reasonable person might disagree with.
6. **Ask before destructive or far-reaching changes** (dependency bumps, schema migrations, deleting features). Default to additive.

Think like a front-end engineer the whole way: map every aesthetic idea to concrete, implementable CSS/React. Design at the right altitude — no hard-coded magic hex values scattered inline, no vague "make it pop". Use the token system.
</how_to_work>

<project_context>
**Juno** is a production-grade, multi-provider AI chatbot (Claude × ChatGPT × Perplexity DNA) built from scratch and already running locally, ready to deploy to Vercel.

**Stack (pinned intentionally — do NOT bump majors without asking):**
- Next.js 15.5 (App Router) · React 19 · TypeScript 5.7
- Tailwind CSS **v3.4** (not v4) + shadcn-style UI primitives (Radix)
- Prisma 6 + PostgreSQL · NextAuth v5 beta (Auth.js)
- `@anthropic-ai/sdk` + `openai` SDK (one adapter for all OpenAI-compatible providers)
- Stripe · AWS SDK v3 (S3-compatible storage) · lucide-react · sonner · next-themes · react-markdown + rehype-highlight + remark-gfm

**Where things live (high-signal map):**
```
src/app/
  (auth)/sign-in | sign-up
  (app)/layout.tsx            # authed shell (AppProvider + AppShell)
  (app)/chat, chat/[id]       # ChatView
  (app)/settings | memory | upgrade
  api/                        # chat (SSE), conversations, messages, folders, memory,
                              # settings, account, artifacts, upload, files, voice, stripe, auth, models
  layout.tsx, globals.css     # root layout (fonts) + Juno design tokens
src/components/
  ui/         # shadcn-style primitives (button, dialog, dropdown, select, tabs, tooltip, …)
  app/        # app-provider (context), app-shell, app-sidebar, user-menu
  chat/       # chat-view, composer, message-list, message-item, markdown, model-selector,
              # artifact-inline-card, empty-state
  canvas/     # canvas-panel, sandbox-frame (sandboxed artifact iframe)
  voice/      # voice-mode
  signature/  # dot-field, ascii-hero, dot-matrix, thinking-dots, dotted-divider, voice-orb
  brand/      # logo (JunoMark), provider-logo
src/hooks/    # use-chat, use-uploads, use-speech-recognition, use-tts
src/lib/      # anthropic, openai-compat, llm, models, model-discovery, providers, plans,
              # usage, memory, storage, message-content, rate-limit, auth, prisma, accents, …
prisma/schema.prisma          # full data model
```
Read `HANDOFF.md` and `README.md` for the complete picture and conventions before you start.
</project_context>

<the_problem>
Juno's *bones* are good — it already has a warm coral identity and a genuinely distinctive dot/ASCII "signature" layer. But several concrete things make it read as AI-generated, and those are your first targets:

1. **The body typeface is Inter** (`src/app/layout.tsx` → `--font-sans`). Inter is the single biggest "AI slop" tell. The serif (Newsreader) and mono (JetBrains Mono) are great; the dominant UI font is the problem. **Replace it.**
2. **Generic shadcn composition.** Many surfaces are default card-in-a-box layouts with even, timid spacing and little hierarchy. It looks like a template, not a product.
3. **Motion is sparse and inconsistent.** A few `fade-in-up`s exist, but there's no page-load choreography, no spring physics, no view transitions, and most interactions have no tactile feedback.
4. **The signature dot/ASCII layer is under-used.** The best, most ownable part of Juno (dot-field, ascii-hero, dot-matrix, thinking-dots) appears in only a couple of places. It should be a consistent through-line.
5. **States are uneven.** Loading/empty/error states are missing or plain on several screens (memory, folders, settings, history search, uploads).

Do not "fix" these by adding more gradients, more glassmorphism, or more shadcn defaults. Fix them with intent.
</the_problem>

<design_direction>
Adopt and adapt Anthropic's frontend-aesthetics guidance. The general principle (from Anthropic's frontend-design Skill):

<frontend_aesthetics>
You tend to converge toward generic, "on-distribution" outputs. In frontend design this creates the "AI slop" aesthetic. Avoid it: make a distinctive, cohesive interface that feels genuinely designed for *this* product.
- **Typography:** choose beautiful, characterful fonts. Never Inter, Roboto, Arial, Open Sans, or system defaults. Use weight and size extremes for hierarchy (100/200 vs 800/900; 3×+ size jumps), not timid 400-vs-600.
- **Color & theme:** commit to a cohesive aesthetic via CSS variables. Dominant colors with sharp accents beat evenly distributed, timid palettes.
- **Motion:** use animation for high-impact moments and micro-interactions. One well-orchestrated page load with staggered reveals creates more delight than scattered fidgets. CSS-first; reach for a JS spring only when it earns its keep.
- **Backgrounds:** create atmosphere and depth — layered gradients, texture, geometric/dot patterns — rather than flat fills.
Don't just swap one set of clichés for another. Avoid converging on Space Grotesk, purple gradients, and predictable layouts. Make unexpected choices that fit the context.
</frontend_aesthetics>

Now make it specifically *Juno*. **The target aesthetic: "Claude-warm, but unmistakably Juno — editorial, tactile, alive — blended with current (2026/27) design craft, with a monospace dot/ASCII signature as the through-line."**

KEEP and DEEPEN (this is Juno's identity — do not throw it away):
- The **warm paper / warm charcoal** themes and the **coral primary** (`hsl(15 63% 60%)` ≈ `#D97757`) with the 5 swappable accents (coral · teal · violet · amber · sage). All driven by the CSS variables in `globals.css` — keep using them.
- **Newsreader** serif for "human moments" (greetings, headlines, empty states) and **JetBrains Mono** for labels, metadata, and the dot/ASCII layer.
- The **film grain**, `prefers-reduced-motion` support, thin theme-aware scrollbars, and the **dot/ASCII signature** components.

CHANGE / ELEVATE:
- **Replace Inter** with a distinctive, warm humanist/grotesque UI sans loaded via `next/font/google` (or Fontshare). Pick ONE decisively and test it in both themes. Good candidates that pair with Newsreader + JetBrains Mono: *Hanken Grotesk, Schibsted Grotesk, Funnel Sans, Mona Sans, Instrument Sans, Geist*. Avoid Inter/Roboto/Arial and don't default to Space Grotesk. Establish a real **type scale** (display/title/body/label/mono-caption) and use it consistently.
- **Push the dot/ASCII signature into a consistent system:** section dividers (`DottedDivider`), loading and skeleton states (dot-based), quota/usage (`DotFillBar`), avatars/identicons (`DotIdenticon`), empty states (`AsciiHero` variants), and subtle dotted texture on key surfaces (auth, upgrade, roadmap headers) using a faint `DotField`. Tasteful, not noisy — it should feel like a watermark, not wallpaper.
- **Apply 2026/27 craft, selectively:**
  - **Bento-grid layouts** for dense, scannable surfaces: Settings, Upgrade/pricing, Memory, and the new Roadmap. Use varied tile sizes and clear hierarchy — not a uniform card grid. Consider gentle Z-axis layering (shadow/elevation) over flat cards.
  - **Restrained glassmorphism 2.0** for *secondary, floating* layers only (command palette, popovers, the composer's floating bar, modals, toasts) — subtle translucency + backdrop-blur that creates depth without noise. Never for primary content blocks.
  - **Mature, designed-first dark mode** — not an inverted light theme. Verify contrast and elevation in dark explicitly.
  - **Tactile depth & detail:** considered shadows, 1px hairline borders, inner highlights, and texture instead of flat color. Generous, *rhythmic* spacing (an 8pt-ish scale) with deliberate density where it aids scanning.
  - **Distinctive, human details:** a real focus style, hover/press affordances, and a touch of editorial flourish (serif italics for names/greetings already exist — extend that idea).
- **Hierarchy, contrast, balance, movement** on every screen. If a screen looks like a default template, it's not done.

Anti-AI-slop checklist (reject your own output if it has these): Inter/Roboto anywhere; purple-on-white gradients; evenly weighted gray-on-gray cards; emoji as iconography; centered hero + three feature cards; timid 4px radii everywhere; motion that's either absent or a generic fade. Juno's radius is `1rem` (`--radius`) — respect it and vary it intentionally.
</design_direction>

<motion_and_interaction>
Motion should guide, reassure, and add polish — never decorate for its own sake. Smooth, curved easing; spring-like settle; respect `prefers-reduced-motion` everywhere (the global reduce rule already exists — keep honoring it).

Required motion work:
- **Page-load choreography.** On each route, stagger key elements in (`animation-delay` ladders or a small variants system). The chat empty state, sidebar, and settings should *arrive*, not pop.
- **Chat streaming polish.** Keep the mono caret + `ThinkingDots`, but choreograph message entrances (assistant message rises in as it begins; tool/artifact cards expand smoothly; auto-scroll is smooth and interruptible). Add a subtle "new message" settle.
- **Composer feel.** Tactile send button (press/scale + state morph between Send/Stop), smooth textarea autoresize, attach-chip add/remove transitions, drag-over state that feels physical.
- **Micro-interactions.** Hover/press on every actionable element, animated icon swaps (copy→check already exists — extend the pattern), toggle/switch transitions, tab underline slides, dropdown/popover enter/exit, optimistic UI on upvotes/pins/feedback.
- **View transitions.** Use the View Transitions API (or a light wrapper) for sidebar ↔ chat and opening the Canvas, where it's clean and degrades gracefully.
- **Easing tokens.** Define a small set of easing/duration tokens (e.g. `--ease-out-expo`, `--ease-spring`, durations 150/250/400ms) and use them consistently instead of ad-hoc values. You may add the `motion`/Framer library *only if* you justify it; prefer CSS + the existing Tailwind keyframes (`fade-in`, `fade-in-up`, `rise-in`, `dot-wave`, `blink`, `drift`, `pulse-ring`, `shimmer`) and extend that set.

Performance bar: 60fps, GPU-friendly transforms/opacity only, no layout-thrash animations, no jank on low-end devices.
</motion_and_interaction>

<ux_and_production_readiness>
Hold every screen to a production bar:
- **Every state, everywhere:** loading (skeletons using the dot/shimmer language), empty (with a helpful next action), error (recoverable, human copy), success, offline/disabled, and quota-reached. No dead ends.
- **Responsive & mobile-first.** The chat, composer, sidebar (drawer on mobile), Canvas (full-screen sheet on mobile), and Roadmap must all be excellent on a phone. Most chatbot use is mobile and one-handed.
- **Accessibility (WCAG AA):** focus-visible on everything, full keyboard operability, correct ARIA roles/labels, trapped focus in modals, screen-reader-friendly streaming (`aria-live` on the assistant message), and AA contrast in *both* themes. Keep reduced-motion paths.
- **Keyboard & power-user UX:** a **⌘K command palette** (new chat, search conversations, switch model, jump to settings/memory/roadmap, toggle theme), plus shortcuts (⌘↵ send, ⌘⇧O new chat, ⌘/ shortcuts cheatsheet, Esc to close/stop). Show a discoverable shortcuts sheet.
- **Capability transparency & trust** (chatbot-specific best practice): make it obvious what model is active and what it can do, style AI vs user turns distinctly (already partly done), keep per-message actions, surface citations/sources cleanly when present (there's a `--source` token — use it), and show clear "memory updated" / tool-running affordances.
- **Onboarding:** a first-run experience (name, default model, accent, a one-line "what Juno can do") that uses the signature aesthetic. New users currently land in an empty chat — give them a warm, guided start.
- **Consistency:** one set of buttons, inputs, menus, badges, and spacing tokens used everywhere. Audit `components/ui` and make the primitives genuinely good, then reuse them.
- **Copywriting:** warm, calm, precise microcopy (Juno's voice). No robotic empty-state filler.
</ux_and_production_readiness>

<feature_inventory>
Treat this as the source of truth for scope. **Preserve and polish everything in "Built". Finish "Partial". Add "New".**

### Built — must be preserved and visually elevated
- **Auth** — email+password (bcrypt) + Google OAuth, NextAuth v5, JWT sessions; sign-in / sign-up pages.
- **Streaming chat** — SSE, persistence; per-message **copy, regenerate, edit, 👍/👎 feedback**, read-aloud.
- **Multi-provider models** — Anthropic native + OpenAI-compatible (OpenAI, Google Gemini, Zhipu GLM, Moonshot Kimi, DeepSeek, Mistral, xAI Grok). **Live model discovery**, curated latest-per-family, T3-style picker with a left rail of lab logos, **favorite/starred models**.
- **Reasoning effort** control (Instant / Low / Medium / High) for models that support it.
- **Conversation history** — sidebar grouped by date, **search, rename, pin, folders (+ delete)**.
- **Settings** — theme (light/dark/system) + 5 accents, default model, custom instructions, response language, **data export**, account deletion (all persisted).
- **Memory** — inline `<juno:memory>` tags **and** background auto-extraction; manager UI at `/memory` (view/search/edit/delete), master on/off toggle, "memory updated" chip.
- **Canvas / artifacts** — `<juno:artifact>` → side panel with **Preview + Code tabs, version history, edit, copy, download, fullscreen**, rendered in a **sandboxed iframe** (HTML/React/SVG/Mermaid/Code/Markdown).
- **File + image upload** — drag-drop + `+` menu, validation, progress, S3 **or** local-disk storage, multimodal (images + PDFs + text) to vision models.
- **Voice** — Web Speech dictation + full **voice-conversation mode** (orb, listening/thinking/speaking, interrupt) + optional server STT/TTS.
- **Billing** — Stripe Checkout + customer portal + webhooks + **server-side plan gating**; plans FREE / PRO / MAX + non-purchasable **OWNER** (unlimited).
- **Quota & rate limiting** — monthly message quota (DotFillBar), Postgres fixed-window rate limit.

### Partial / limited — finish these
- **Memory relevance** is recency-based (most-recent injected), not semantic retrieval → add lightweight relevance/ranking and a memory **consolidation/summary** pass.
- **Per-conversation export & sharing** — there's account-level data export, but no per-chat **export (Markdown/PDF)** or **shareable read-only link**.
- **Web search / citations** — Juno has Perplexity DNA and a `--source` color but no first-class **web-search-with-citations** flow. Add it (gated by plan) or, if out of scope, design the sources/citation UI for when tools return them.
- **Large uploads on Vercel** — switch to **presigned direct-to-S3** for files > ~4.5 MB.
- **Code blocks** — add per-block **copy button**, language label, and filename/wrap affordances in the markdown renderer.

### New — add these (production expectations)
- **⌘K command palette** and a **keyboard-shortcuts sheet** (see UX section).
- **First-run onboarding** flow.
- **Prompt library / saved prompts** and a reusable **suggestion/prompt-starter** system (the empty-state pills are the seed).
- **Conversation niceties:** bulk select/delete, move-to-folder drag-and-drop, archive, "scroll to latest" pill, jump-to-message search within a chat.
- **Usage dashboard** (in settings): messages used vs. quota (DotFillBar), per-model usage, current plan, with upgrade CTA.
- **Owner/admin mini-dashboard** (OWNER plan only): basic stats + **Feature Requests moderation** (see below).
- **★ Feature Requests & Roadmap page** — the flagship new feature, fully specified next.
</feature_inventory>

<feature_requests_and_roadmap>
Build a public-style **Feature Requests & Roadmap** experience inside Juno (authenticated users browse, submit, and upvote; OWNER moderates). Model it on Canny/Linear's public roadmaps, in Juno's design language. This directly fulfills: *"a page where users can ask for a feature, see features asked by other users, features currently being built, features that will be built, and features that were built."*

**Routes**
- `/roadmap` — the board (public roadmap + voting).
- `/roadmap/[id]` — a single request (detail, comments, vote, status timeline).
- Entry points: sidebar nav item (with the dot-matrix mark), a "Request a feature" action in the user menu, and a link in the empty-state/footer.

**Statuses (the columns / filter tabs)** — map exactly to the user's ask:
1. `UNDER_REVIEW` — newly asked by users (triage).
2. `PLANNED` — we'll be building it.
3. `IN_PROGRESS` — currently building.
4. `SHIPPED` — was built / done (link to release notes or the relevant screen).
5. `DECLINED` — not planned (collapsed by default, with a short reason).

**Core UX**
- **Board view** with status columns (Linear/Canny style) on desktop that collapses to **filter tabs + a vertical list** on mobile. Each card: title, short description, **upvote button with live count**, status badge, tag/category, comment count, author avatar (`DotIdenticon`), and "you voted" state.
- **Upvote** with optimistic UI and a satisfying micro-interaction (the count ticks, the dot fills). One vote per user per request; toggle to remove.
- **Submit a request:** modal/page with title + description + category; **duplicate detection** (search-as-you-type surfaces similar existing requests to vote on instead — reduces noise).
- **Sort & filter:** Top (most votes) · New · Trending; filter by status and category/tag; search.
- **Detail page:** full description, **status timeline** (when it moved review→planned→in-progress→shipped), threaded **comments**, vote, and (for OWNER) inline status controls + an official reply that's visually distinguished.
- **Status-change feedback:** when a request a user voted on ships or moves, show an in-app notification/toast and (optional, if email is configured) an email. At minimum, a "what's new / recently shipped" strip at the top of the board.
- **OWNER moderation:** change status, edit/merge duplicates, pin, mark official comment, decline-with-reason. Only OWNER plan sees these controls (reuse `isOwnerEmail` / plan gating).
- **Empty & seed states:** a warm empty board with `AsciiHero`, and seed the board with Juno's *real* near-term roadmap (pull from `HANDOFF.md` "Pending / next steps": semantic memory, memory consolidation, presigned uploads, web search w/ citations, image generation, voice provider wiring) so it never looks empty.

**Data model (Prisma — add to `schema.prisma`, then migrate):**
```prisma
model FeatureRequest {
  id          String        @id @default(cuid())
  authorId    String
  title       String
  description String        @db.Text
  category    FeatureCategory @default(OTHER)
  status      FeatureStatus   @default(UNDER_REVIEW)
  pinned      Boolean       @default(false)
  declineReason String?
  mergedIntoId String?       // duplicate handling
  createdAt   DateTime      @default(now())
  updatedAt   DateTime      @updatedAt

  author    User              @relation(fields: [authorId], references: [id], onDelete: Cascade)
  votes     FeatureVote[]
  comments  FeatureComment[]
  events    FeatureStatusEvent[]

  @@index([status, createdAt])
}

model FeatureVote {
  id        String   @id @default(cuid())
  requestId String
  userId    String
  createdAt DateTime @default(now())
  request   FeatureRequest @relation(fields: [requestId], references: [id], onDelete: Cascade)
  user      User           @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@unique([requestId, userId])   // one vote per user
  @@index([userId])
}

model FeatureComment {
  id        String   @id @default(cuid())
  requestId String
  authorId  String
  body      String   @db.Text
  official  Boolean  @default(false)   // OWNER/team reply styling
  createdAt DateTime @default(now())
  request   FeatureRequest @relation(fields: [requestId], references: [id], onDelete: Cascade)
  author    User           @relation(fields: [authorId], references: [id], onDelete: Cascade)
  @@index([requestId, createdAt])
}

model FeatureStatusEvent {
  id        String        @id @default(cuid())
  requestId String
  status    FeatureStatus
  note      String?
  createdAt DateTime      @default(now())
  request   FeatureRequest @relation(fields: [requestId], references: [id], onDelete: Cascade)
  @@index([requestId, createdAt])
}

enum FeatureStatus   { UNDER_REVIEW PLANNED IN_PROGRESS SHIPPED DECLINED }
enum FeatureCategory { CHAT MODELS CANVAS MEMORY VOICE FILES BILLING UI INTEGRATIONS OTHER }
```
(Add the matching `votes` / `featureRequests` / `featureComments` relations on `User`.) Build the API routes under `src/app/api/roadmap/*` with Zod validation, session auth, owner-gating on mutations that require it, and the existing rate-limit on create/comment. Keep all the design-system rules above — this page should be a showcase of the new Juno, not a bolt-on.
</feature_requests_and_roadmap>

<constraints_and_conventions>
From `HANDOFF.md` — follow these exactly:
- **`npx tsc --noEmit` must stay clean.** Don't run `next build` while `next dev` is running. If `.next` corrupts: `rm -rf .next && npm run dev`.
- **Don't bump major dependency versions** (Tailwind stays v3.4, Next 15, React 19, Prisma 6, NextAuth v5 beta) without flagging it and getting agreement.
- **Style discipline:** coral/accent **tokens** (no raw hex inline), **mono** for labels/metadata, **serif** for human moments, **no purple/AI gradients**, keep it warm and calm. Drive `--primary`/`--ring` via `[data-accent]`.
- **Security stays intact:** API/voice/Stripe/storage keys server-only; every mutating route authorizes the session user and scopes to their data; artifact previews stay in the **sandboxed iframe** (`allow-scripts`, opaque origin); validate input with **Zod**; render Markdown without raw HTML.
- **Don't regress** any "Built" feature. If a refactor risks one, add it to the plan and call it out.
- Match existing patterns (new-chat navigation via `router.replace`, hydration-gated client-only UI, `provider:model` IDs, etc.).
</constraints_and_conventions>

<definition_of_done>
A screen is done when:
- It would pass review at a top-tier product studio: clear hierarchy, distinctive type, cohesive color, intentional spacing, tactile detail — no "template" feel.
- Motion is present and purposeful, 60fps, reduced-motion-safe.
- Every state exists (loading/empty/error/success/disabled) and is on-brand.
- It's fully responsive and keyboard-accessible at WCAG AA in both light and dark.
- It uses the shared tokens/primitives and the dot/ASCII signature where appropriate.
- `tsc` is clean and no existing feature regressed.

Overall success test: a designer who has never seen Juno should not be able to tell it was built with AI, and should want to screenshot it.
</definition_of_done>

<first_response>
Do NOT start editing yet. For your first reply:
1. Read `HANDOFF.md`, `README.md`, `globals.css`, `tailwind.config.ts`, `layout.tsx`, and the `chat/`, `app/`, and `signature/` components.
2. Give me a concise **design audit** (what's strong, what reads as AI-generated, with file references).
3. Propose the **typeface** you'll replace Inter with (one pick + one backup) and a tiny type scale.
4. Give me an **impact-ordered plan** of slices (chat surface → composer → empty state/onboarding → sidebar/history → settings/memory/upgrade → command palette → roadmap), with the first slice broken into concrete steps.
Then stop and wait for my go-ahead.
</first_response>

========================  END OF PROMPT  ========================
