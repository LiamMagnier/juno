# Premium audit — September 2026

An audit of what "minimal, clean, premium" means in the products Juno is
measured against, what Juno actually ships, and the rules that close the gap.

`FLAT_UI.md` is still the material law: one plane, hairlines, tonal state, one
accent. This document is about **composition** — how much is on screen, how many
voices speak at once, and where the eye lands first. Juno's tokens were never
the problem. Every surface audited below is individually on-token and
collectively reads as a control panel.

## 1. What the reference products actually do

Read from ChatGPT, Claude, Linear, Raycast and Arc — not their marketing, their
chrome.

**They spend their pixels on one thing per surface.** Claude's model menu is a
list of model names with a one-line descriptor. There is no speed meter, no
price table, no context-window figure. The cost of a model is a business fact,
not a choosing fact, and it is not on the menu. ChatGPT's is the same list with
a "Thinking" toggle folded into the entry.

**Chrome is quieter than content, always.** In all five the sidebar is the
lowest-contrast region on screen: one weight of text, one ink at ~55% against
the panel, no glyph unless the row is a destination rather than a document.
Juno's sidebar draws a 16px icon on every row including the chat titles, which
puts a hundred small marks in the quietest column in the product.

**A list is rows, not cards.** Nothing in the reference set puts a border, a
fill, or a radius on an unselected list row. The row is text on the panel. Fill
appears on hover and stays on selection, and that is the entire vocabulary.

**Type has two sizes in chrome, not five.** A row size and a section size.
Juno's picker uses `ui` (13px), `label` (12px caps), `caption` (11px), `micro`
(10.5px mono) and `tabular-nums` at 17px — five voices inside 700px.

**Density is honest.** Reference rows sit at 32–36px with 8–12px of side
padding, and the panel has real breathing room at its edges (16px, not 8px).
Juno's picker pads its list viewport to 8px and its rows to 8px, so the text
starts 16px from the popover edge while the spec sheet beside it starts at 16px
from its own — two different left edges that happen to compute the same number.

**Motion is a consequence, not an event.** Hover fills cross-fade in ~120ms.
Nothing slides, scales, or springs in chrome.

## 2. Findings

### P0 — the model picker reads as a dashboard
`src/components/chat/model-selector.tsx`

Three panes in 700×440. A 48px icon-only lab rail (names only in tooltips), a
squeezed ~350px list, and a 300px spec sheet carrying four numeric grades over
4px meters, capability chips, a two-column price table and a Use button.

The spec sheet is the whole problem. It is a permanent third region that answers
a question nobody asked at the moment of choosing, and it is the loudest thing
in the popover.

**Rule:** two panes. A lab rail on the left, the model list on the right.
Everything the spec sheet said moves onto the row it describes. One trailing
signal per row, maximum.

**Named rows on the rail were tried and reverted.** The argument for them —
that a logo with no name is a memory test and a tooltip delay sits on the
surface's primary navigation — is real, and it lost to arithmetic: 168px of a
680px box, a quarter of the surface, spent on sixteen words a person reads
once. The list is where the choosing happens and it got the width. The
compromise is that the tooltip now carries *more* than the row did — the lab
and its model count — so hovering answers both questions the named row
answered.

**The effort control is part of this surface, not an exception to it.** It was
a `bg-secondary` track with six `flex-1` segments stretched across the footer
and a `shadow-raised` on the selected one: the last framed, shadowed object in
the picker, wrapped around its smallest decision.

It then became a row of words, on the argument that six discrete values are
what a radio group is for. That is right about semantics and wrong about the
thing being chosen: **effort is ordered**. Instant is less than Max and every
rung between them is on the way, so a row of equal words — which says "here
are six options" — states something false about the choice. It is a slider
again: a 3px rail, a fill to where you are, a tick per stop so the
discreteness stays visible, and the rung named in words beside it. A native
`input[type=range]` underneath supplies drag, click-to-jump, arrows and every
touch gesture, so none of that lives in the component.

The lesson generalises past this control: **match the control to the shape of
the quantity, not to the number of values it has.** Two things with an order
between them are a slider even when there are only four.

### P0 — the sidebar competes with the transcript
`src/components/app/app-sidebar.tsx`

Every row carries a `size-4` glyph, including recents. Section eyebrows are mono
caps; date folds are sans captions one rung below; the product switch, search
field, New chat button and five nav destinations all sit above the list. That is
332px of chrome before the first chat title.

**Rule:** glyphs on destinations only, never on documents. One eyebrow voice.
Chrome above the list gets a hard budget.

### P1 — the aura paints the whole window for every surface
`src/components/ambient/ambient-aura.tsx`, `src/lib/aura.ts`

The light is claimed by five sources (`voice`, `chat`, `research`, `code`,
`work`), portals to `<body>`, and paints the bottom and both sides of the
viewport — across the sidebar. So a background chat stream lights the frame
around a sidebar the user is reading, and the "wave" is a literal sine ribbon
with a 1.25px crest that reads as a 2008 audio visualiser.

**Rule:** voice only. Scoped to the chat surface, never the window. A field,
not a waveform. **Behind the content, not over it** — `z-index: 0` under a
`z-[1]` content wrapper, so the transcript reads on top of the light. That
wrapper is not optional bookkeeping: a positioned `z-index: 0` box paints
ABOVE unpositioned in-flow content in the same stacking context, so a layer
with no counterpart wrapper is over the text, not under it. The aura bench
(`app/aura-preview`) was missing exactly that wrapper, which meant the one
surface built to judge whether the light stays out of the way of type was
rendering it over the type.

**And behind is not enough on its own.** A field under the whole column still
sits under the transcript, and coloured ground under body text costs contrast
however correct the stacking is. Turning the whole layer down to compensate
makes it too dim at the edges, where it is actually doing its job — one
problem solved twice, badly, in opposite directions. So the reading column is
ERASED out of the finished field (`READ_W`, a soft ellipse, `destination-out`).
The light is a rim, the middle is clean paper, and the edges can then be as
bright as they need to be without touching a line of type.

**And the light has to be big to be ambient.** The first full-column pass kept
the arms to 0.52 of the height on the argument that light above the midline
encloses the reader. That argument was covering for a bug: each pool along an
arm was filled over the EDGE's box rather than its own, so the gradient was
sheared flat at the arm's tip — and since both arms shear at the same height,
what rendered was a seam straight across the window at mid-screen. Every
centimetre of extra arm moved that seam further up, so of course less of it
looked better. Filling each pool over its own square removes the cut, and the
light can then go where a lit room is lit: up the sides, dying out before the
top.

**Three parties, three inks, three motions.** One 0..1 ramp from neutral to
accent could only ever say more or less of one thing, so "working" and
"answering" were the same colour at different strengths. Now: you speak in the
accent and the light moves with your voice; Juno thinks in `--ultra` and the
light breathes slowly; Juno answers in `--source` and the light rests high and
travels. Either channel alone is enough to tell them apart, which is the point
— the person may not be looking at the screen at all.

### P2 — five type voices in chrome

`ui` / `label` / `caption` / `micro` / `tabular-nums` inside one popover. The
scale is good; the usage is undisciplined.

**Rule:** chrome gets `ui` for rows and `label` for sections. `micro` is for
genuine machine metadata (a model id, a token count) and appears at most once
per surface. No numerals above `ui` size anywhere in chrome.

## 3. The rules

1. **One question per surface.** A picker picks. It does not also compare,
   benchmark, or price.
2. **Two panes maximum.** The narrow one is a rail of marks; anything it
   would have said in words belongs in its tooltip.
3. **A list row is text on the panel.** No border, no fill, no radius until
   hover or selection.
4. **Glyphs mark destinations, not documents.**
5. **Two type voices in chrome**: row and section.
6. **One trailing signal per row.** If a row needs two facts on the right, one
   of them is not needed.
7. **Meters are banned in chrome.** A number is a number; a bar beside it is the
   same fact drawn twice.
8. **16px side gutters** on every panel edge, and the panes agree on their
   inner left edges by construction, not by arithmetic.
9. **Ambient light belongs to the surface that earned it**, never to the
   window — and it sits *behind* that surface's content, never over it.
10. **Nothing in chrome moves except a fill.**
11. **Never clip a gradient that still carries alpha.** Fill every radial
    gradient over its own bounding box and let it reach zero on its own. Every
    hard seam this layer has ever shown — the faceted bands, the sheared arm
    tips — was a gradient cut short, and each one cost a redesign that was
    really a debugging session.

