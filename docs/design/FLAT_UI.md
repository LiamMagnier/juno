# Juno Flat UI — the September 2026 retune

This brief replaces `SOFT_UI.md` where the two disagree. `SOFT_UI.md` stays in
the tree as the record of the neumorphic pass it describes; the token names,
the composed surface classes, the radius ladder and the motion vocabulary it
introduced all survive — what changed is what they draw.

## 1. Why

Soft UI cut the interface from one material at three depths: raised cards
extruded from the page with a dual top-left-light / bottom-right-dark shadow,
inset wells recessed into it, and controls that went *down* when pressed. It
was coherent and it was tactile, and next to Claude and ChatGPT it read as
decorated. The products Juno competes with have converged on the opposite:
one flat plane, a hairline where an edge is needed, a tonal fill where a state
is needed, and a real shadow only on the layers that leave the page. Depth
there is information, never texture.

## 2. Principles

1. **Flat by default.** An in-flow surface is its fill and its 1px hairline.
   The only shadow it may carry is a 1px contact shadow at 4% ink, and most
   carry none.
2. **Shadows leave the page.** Menus, popovers, dialogs, toasts and tooltips
   are the one tier with a throw — a soft, wide, low-alpha one (`--shadow-float`).
   Nothing in the reading column casts a shadow.
3. **State is tonal.** Hover is `--accent`, selected is `--secondary`, the
   active sidebar row is `--sidebar-accent`. No surface goes up or down;
   it changes shade.
4. **One accent, used for state.** Coral (or the chosen accent) is the primary
   action, the selected mark, the focus edge on a text field. It is never
   furniture.
5. **Clean paper.** No film grain, no sheen rim, no gradient overlays on
   fills. The dark theme is warm charcoal, lifted two points from the Soft UI
   ground so hairlines read without a shadow behind them.
6. **Motion is unchanged.** The easing and duration ladder, the tiered
   reduced-motion policy, the pop / rise / sheet keyframes and the spring
   presets in `src/lib/motion.ts` all stand. Motion carried the Soft UI
   language well and carries this one better, because there is less
   competing with it.

## 3. Tokens (globals.css)

### 3.1 Ground

| Token | Light | Dark |
|---|---|---|
| `--background` | `48 24% 97.2%` | `30 5% 11.5%` |
| `--card` | `46 32% 99.2%` | `30 5% 14%` |
| `--popover` | `46 32% 99.4%` | `30 5% 16.5%` |
| `--secondary` / `--muted` | `46 20% 93.5%` | `30 5% 18%` |
| `--accent` (hover fill) | `46 20% 91.5%` | `30 5% 21%` |
| `--border` | `44 14% 86.5%` | `30 5% 22.5%` |
| `--input` (field hairline) | `44 12% 78%` | `30 5% 27%` |
| `--sidebar` | `46 22% 95.5%` | `30 5% 9.5%` |

Every rung stays warm (red ≥ green ≥ blue); the native brand-neutral test
still gates it.

### 3.2 Shadows

```
--shadow-raised     0 1px 2px ink/.04                       (dark: black/.25)
--shadow-raised-lg  + 0 6px 16px -6px ink/.08               (dark: + 0 8px 20px -8px black/.5)
--shadow-inset      none
--shadow-pressed    none
--shadow-float      0 0 0 1px ink/.03, 0 2px 6px ink/.05, 0 14px 36px -10px ink/.16
                    (dark: 0 0 0 1px white/.05, 0 4px 12px black/.35, 0 18px 44px -12px black/.6)
```

`--shadow-inset` and `--shadow-pressed` resolve to nothing on purpose rather
than being deleted: sixty call sites and the Swift projection read them, and
a token that resolves to "no shadow" is a retune, not a migration.

### 3.3 Composed surfaces

| Class | Now draws |
|---|---|
| `.surface-raised` | `--card` + hairline at 80% + the 1px contact shadow |
| `.surface-raised-lg` | the same with the soft throw — hero cards, the auth card, pricing |
| `.surface-inset` | `--background` + hairline, no shadow — fields, search, segmented tracks |
| `.surface-float` | `--popover` + hairline at 90% + `--shadow-float` |
| `.control-neu` | hairline at rest → `--accent` fill + darker edge on hover → `--secondary` fill while on |
| `.control-primary` | solid accent fill, no shadow; hover brightens 6%, press dips 3% |
| `.composer-surface` | `--card` + a hairline at the `--input` rung (the one edge on the page that must be found) + one low soft throw; focus darkens the edge to ink/30% |

## 4. Components

- **Buttons.** `default` is the solid accent; `secondary` is the bordered
  flat control; `ghost` and `outline` take the tonal hover. No variant casts
  a shadow. Destructive is the same recipe in the destructive hue, with the
  gradient overlay gone.
- **Sidebar.** The active row is a `--sidebar-accent` fill at medium weight,
  not a raised card. Hover is the same fill on inactive rows.
- **User bubble.** `--secondary` at `rounded-card`, no border, no shadow —
  the Claude / ChatGPT bubble.
- **Switch, checkbox, radio, slider, progress, badge, kbd.** Tonal tracks,
  flat fills, no pressed recipe. The switch track is `--input` when off.
- **Composer.** Three objects on the controls row — `+`, the model chip, the
  send circle — plus quiet dictate / voice icon buttons when the surface has
  them. Nothing else sits on the row: thinking effort is a segmented control
  under the model list inside the picker; tools, project and connectors are
  inside `+`; what is armed for *this* message (deep research) is a pill
  beside `+`, never a count badge on it. The text and the `+` share one left
  inset (16px / 10px), the text and the send circle share one right inset.
  Two radii: the 20px shell and `rounded-control` for every inner object —
  chips, tiles, the quote chip, the paste card. The send circle has one verb:
  send ⇄ stop; disabled is a neutral `--secondary` disc, never the accent at
  40%. The field stays live while a reply streams; Enter queues the next
  message. Every composer in the product (Chat, Code, Work, Compare) draws
  this through `ComposerShell` and its recipes.
- **Model picker.** Three flat panes: a rail of configured labs on the left
  (plus All and Favorites), the lab's models on the right arranged by Text ·
  Image · Video with superseded generations folded away, and a spec sheet
  that fills in on hover or arrow — intelligence, speed, context and cost as
  ten-segment bars, capability chips, the exact price per million tokens,
  and Use / Favorite. Rows carry a one-line description and the price;
  favorites persist to the account and lead the All view.
- **Research plan gate.** Approach paragraph · questions to answer (with
  evidence chips: independent sources, primary source, freshness) · the
  editable schedule · what a complete answer includes · where evidence may be
  thin · the searches one disclosure down. Sections stagger in on the base
  rung.

## 5. Typography

**Inter** replaces Archivo as `--font-sans`. Everything else in the type
scale is unchanged. Newsreader stays for the greeting; JetBrains Mono stays
for labels and code.

## 6. What to do at a call site

Nothing, usually. The surfaces retuned under the classes. When touching a
component:

- Delete `hover:shadow-raised`, `active:shadow-pressed`, `shadow-pop` and the
  `[background-image:linear-gradient(…)]` gloss overlays; replace a raised
  hover with `hover:bg-accent` and a pressed state with `bg-secondary`.
- A selected row is `bg-accent` (or `bg-sidebar-accent` in the sidebar),
  never `.surface-raised`.
- Keep the hairline. A flat edge still needs 3:1 (WCAG 1.4.11).
