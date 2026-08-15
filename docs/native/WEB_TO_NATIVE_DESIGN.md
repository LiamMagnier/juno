# Juno web → native design translation

Date: 2026-08-15. The design source of truth for the iOS and macOS rework.

This supersedes the "design principles" section of [`REWORK_PLAN.md`](REWORK_PLAN.md)
wherever the two disagree. That document derived a register from competitive research; this
one derives it from **Juno's own website**, which is what the owner asked for. The plan's
structural work (component layer, IA, phases, motion tokens, gates) is unaffected.

## Which website register to follow

The site has two, and they disagree. Measured across `src/components/`:

| Surface | `font-mono` | `text-label` | `text-caption` | `uppercase` |
|---|---|---|---|---|
| chat | 152 | 31 | 104 | 16 |
| work | 121 | 42 | 62 | 6 |
| code | 56 | 16 | 65 | 6 |
| **research** (redesigned 2026-08-15) | **2** | **3** | **32** | 6 |

Deep Research is the newest surface and the one the owner signed off after rejecting its
predecessor as "horrible AI slop". **It is the register to port.** Web Chat, Code and Work
have not been converted yet, so porting *them* verbatim would import the exact problem this
rework exists to remove.

Two owner rules govern the register, both recorded as feedback:

1. **Never full uppercase.** No `uppercase` on eyebrows, section labels, kickers or
   headings. Uppercase-plus-mono micro-labels are the single clearest "AI slop" tell.
2. **`font-mono` is for genuinely machine metadata only** — model ids, token counts,
   hashes, file paths, diff bodies, terminal output. Never headings, statuses or counts;
   those belong in the interface face.

Note the trap in rule 1: `text-label` carries `letterSpacing: 0.10em` **because it was
drawn for caps**. Setting it in sentence case looks wrong too — the tracking goes with the
caps. So `text-label` does not get a native counterpart at all. Its replacement is
`text-caption font-medium` in the sans face, sentence case.

## The typographic system

Three families, and contrast comes from **family and 3× size jumps, not timid weights** —
that is the stated intent in `tailwind.config.ts` and it should survive the port.

| Web rung | Family | Native |
|---|---|---|
| `text-hero`, `text-display` | Newsreader serif | `JunoSerif` display face. **Hero question and artifact/document titles only.** |
| `text-title` | sans | `junoFont(size:relativeTo: .title2)` |
| `text-body` | sans | `junoFont(size:relativeTo: .body)` |
| `text-ui` | sans | `junoFont(size:relativeTo: .callout)` — the workhorse; most interface text is this |
| `text-caption` | sans | `junoFont(size:relativeTo: .caption)`, sentence case — the eyebrow/kicker rung |
| `text-micro` | sans | `junoFont(size:relativeTo: .caption2)` |
| `text-label` | sans, 0.10em, drawn for caps | **No native counterpart. Do not port.** |
| `font-mono` | mono | `JunoMono` — machine metadata only, per rule 2 |

The serif is *display-only*. It is not a body face and never sets a paragraph.

### What this changes in the apps today

- iOS chat prints `Claude Sonnet 4.6 · $0.021` entirely in mono. The model id may stay
  mono (it is a machine identifier); **the cost may not** — a count belongs in the sans
  face. Split the line rather than setting all of it one way.
- macOS Work sets `Where` / `Model` / `Spent` / `Attempt`, `What you asked for` and `Plan`
  in mono. All six are headings or labels → sans `text-caption` equivalent, sentence case.
- iOS Settings sets three of five section headers in mono. → sans.

## Colour and surface

The palette is already generated from `globals.css` and is correct. What must be ported is
its **application**, which the web does far more restrainedly than the apps:

- **One accent.** Coral appears on the primary action and on the one italic emphasis line.
  It is not spread across icons, statuses and badges. The apps currently run four hues on a
  single Work screen.
- **Hairlines are translucent.** The web's dominant border is `border-border/50` to `/70`,
  not a solid rule. Port as the hairline token at matching opacity.
- **Warm ground, opaque content.** `bg-card` / `bg-secondary` are solid fills, never
  translucent. This is the same rule as the glass rule below, arrived at independently.

## Layout and disclosure — the actual shape of the direction

This is the part that matters more than any token, and it is what the Deep Research
redesign was really about:

1. **Progressive disclosure, not density.** The live surface shows a serif question, a
   spine of five stages with **only the live one expanded**, and a source rail. Everything
   else sits behind **one** "Show detail" disclosure, **closed by default**. The rejected
   predecessor rendered nine blocks at once.
2. **A finished run is a document cover, not a stat dashboard.** The artifact's own title
   in the serif, one provenance sentence, one verdict, and **one wide door** into the full
   report. Machinery hides behind "How it worked".
3. **One set of transport controls, and the composer owns them.** The panel gets no
   Pause/Stop. Typing while a run is live adds a constraint; the composer's Stop face
   cancels the run and the stream. A second set of transport controls a few hundred pixels
   above the real ones was a named defect.
4. **Real sentences over raw machinery.** The plan gate shows the planner's written steps,
   never the raw query list. Queries live behind "Show the searches".

### Applying 1–4 to the apps

- **macOS Work** currently violates 3 outright: `Pause` and `Stop` sit in the detail pane
  *and* the composer is at the bottom of the same view. Remove the panel pair.
- **iOS Work** violates 2 and 3: two full-width coral primaries ("Allow once" and "Say
  something") with no hierarchy, and a completed task that shows a plan instead of an
  answer. A finished task is a document cover with the answer as the hero.
- **macOS Code** violates 1: the inspector exposes every pane at once rather than one
  live thing plus a disclosure.
- **Both**: the six undocumented status glyphs are raw machinery where a sentence belongs.

## Liquid Glass — how the web's elevation becomes native material

The website has no glass; it expresses elevation with **radius + soft shadow + a warm
ground**. That is exactly what Liquid Glass expresses natively, which makes the translation
rule mechanical rather than a matter of taste:

> **Where the web floats a surface *above* the page — composer, sidebar, toolbar, popover,
> menu, sheet — that surface becomes the Liquid Glass layer natively.**
> **Where the web uses `bg-card` / `bg-secondary` for content the reader reads or acts on —
> rows, transcript, cards, diffs, empty states — that stays opaque natively.**

Both halves are enforceable by grep, and the second half is the one that fails most often.

Concretely, the web's `.composer-surface` (floating, large radius, soft shadow, sitting over
the scrolling transcript) is the single clearest glass candidate in the product. It is
already the right *shape*; it needs the material rather than a drawn shadow.

The rest of the glass rules from `REWORK_PLAN.md` stand unchanged and are compatible with
this: one `GlassEffectContainer` per cluster, `glassEffectID` on every participant, morph
rather than fade, exactly one tinted action per bar on the trailing edge, register bars for
the scroll edge effect, delete custom bar backgrounds, `ToolbarSpacer(.fixed)` grouping.

**Concentric shapes.** The web's radius ladder is flat (`rounded-field` 10,
`rounded-card` 14, `rounded-composer` 26) because CSS has no concentricity primitive.
Native does: use `ConcentricRectangle` / `.rect(corner: .containerConcentric)` for nested
containers rather than porting the numbers. This is the fix for the composer/target-picker
seam on macOS Code and the mixed radii on the iOS sign-in screen — both are cases where two
nested shapes were given independent literal radii.

## What the apps must NOT port from the web

- `text-label` and every uppercase micro-label.
- The `font-mono` density of web Chat / Code / Work (121–152 uses). Those surfaces are
  pre-redesign.
- Hand-rolled controls. The web hand-rolls selects and segmented controls because the
  platform gives it nothing; native gives it `Picker`, `Menu`, `Form`, `List`. **Adopting
  the native structure is what makes Liquid Glass appear** — hand-rolling opts out of it.
  This is the single biggest reason the apps read as non-native today.
- The web's own god-files. `work-transport.tsx` is 1,667 lines and `app-sidebar.tsx` is
  2,045; the native side already has worse. Port the *design*, not the decomposition.

## Always in sync, and never a loading state

Owner requirement, 2026-08-15: *"the website and apps should be sync everytime without any
loading."*

This is an architectural bar, not a polish item, and it decides how every surface is
written. It resolves into four rules.

### 1. Reads are cache-first. A surface never awaits the network to render.

Every screen renders from the local SQLite store immediately and unconditionally. The
network is what *updates* what is already on screen; it is never what produces the first
frame. A list that spins on cold launch is unusable in the twenty-second windows a phone
actually gets used in.

The machinery for this already exists — `SQLiteAccountRepository`, `NativeSyncModel`, the
cursor/revision/tombstone contract at `/api/v1/changes`. What was missing was coverage:
the audit found 23 of 87 Prisma models had entity loaders and change-capture, and **all 16
`Work*` models had neither**, so a Work task could never arrive through sync at all. That
is now closed to 30 entities including seven `work_*` and four `code_*`.

**Falsifiable:** put the device in airplane mode, cold-launch, and open every destination.
Anything that shows a spinner instead of its last-known content is a defect.

### 2. Writes are optimistic and go through the outbox.

A mutation applies to the local store and renders instantly; the outbox reconciles it.
Offline writes currently cover 6 entity families out of 87 — so today, most actions in the
product are a direct network call with no outbox behind them. Every action a user can take
on a surface being reworked must be added to `sync-mutations.ts` as part of that rework,
not deferred.

**Falsifiable:** every button that changes state must work in airplane mode and reconcile
on reconnect.

### 3. Changes arrive; they are not fetched.

Polling is what makes a product feel stale, and Juno currently depends on a foregrounded
30-second poll — which also means a backgrounded phone learns nothing at all. Two pieces:

- **Foreground:** the SSE wakeup on `/api/v1/changes` drives the cursor, so an edit on the
  web appears on the Mac and the phone without either asking.
- **Background:** there is **no push pipeline anywhere in the native tree** — no
  entitlements, no device-token registration, no server service, no link between a
  `WorkApproval` row and a device. Work's whole proposition is unattended execution that
  stops to ask you something, so without push the proposition does not hold on a phone.
  This is a backend project with its own schedule and it is the single largest remaining
  gap between "synced" as claimed and "synced" as experienced.

### 4. Where a wait is genuine, it is a skeleton with real final geometry — never a spinner.

Three waits are real and cannot be designed away: the first-ever sign-in on a new device,
a large artifact download, and a live agent run producing output that does not exist yet.
Everything else is a cache miss that rules 1–3 should have prevented.

For those three, the answer is a skeleton whose geometry matches the content that will
land, so nothing reflows — plus a *specific* label. "Reading 14 files" is honest; "Loading"
is not. The product has 112 bare `ProgressView()` sites and one skeleton today.

**Falsifiable:** any `ProgressView()` on a surface whose row geometry is known is a defect.

### What this costs, stated plainly

Rules 1 and 2 are largely mechanical now that the entity coverage exists. Rule 3's
foreground half is wiring. Rule 3's background half — push — is genuinely a separate
project needing certificates, entitlements, a server-side service and a device registry.
Until it lands, "always in sync" is true for two foregrounded surfaces and false for a
phone in a pocket, and the plan should not claim otherwise.

## Ambient decoration

The web defines `.composer-aura`, `.voice-aura`, `.aicss-shine` and registers two animated
custom properties for the aura's tint and swell. The native side mirrors these in ~1,084
lines across `JunoComposerAura`, `JunoVoiceAura`, `JunoProviderGlow` and `JunoAIcssShine`.

Note that `design-qa.md` claims the design deliberately has "no composer glow", and
`globals.css` contradicts it with 68 `aura` references. **The web is not a settled
reference on this point**, so it cannot decide the native question. This remains the open
owner decision recorded in `REWORK_PLAN.md`: kill, demote to one static accent, or keep.

Whatever is decided, encoding *which AI lab you are talking to* as hue and *reasoning
effort* as brightness fails the still-frame test — it is information that cannot be read,
only sensed — and that part should go regardless.
