# iOS premium pass: audit

Captured 2026-09-26 on an iPhone 17 Pro simulator (iOS 27) through the DEBUG preview
harness (`--juno-ui-preview`, fixture account, no network). Before shots are in
`before/`, after shots in `after/` (light and dark).

## What made each screen feel cheap

**Welcome and sign-in** (`before/01-welcome.png`, `before/02-signin.png`)
- An empty cream void with a glyph in two concentric circles: the one screen every
  new reader sees had no brand imagery at all.
- Headline in bold SF at title size, centred; reads as a template, not as Juno.
- Body copy with an em dash; generic "One assistant, every model." cadence.
- Sign-in: two separately boxed fields in a card, a grey disabled glass slab as the
  primary action, and "Continue in browser" washed in pale coral. No hierarchy
  between the two ways in.
- No entrance motion.

**Shell** (`before/03-new-chat.png`, `before/tab-*.png`)
- The tab bar showed Chat, Code, Work, **Projects** and a system **More** tab: the
  workspace tabs were declared for the iPad sidebar and leaked into the iPhone bar
  (hidden visibility is not honoured past five tabs). "More" opened UIKit's list.
- Three stacked capsules at the bottom (composer, live-run pill, tab bar).
- A "Chat" title over a greeting that already names the moment.

**New chat** (`before/03-new-chat.png`)
- Small bold-sans greeting in the middle of a blank screen; "Ask anything. Juno is
  here to help." filler; no starting points; the composer a grey glass slab.

**Drawer** (`before/05-drawer.png`)
- Eight full-height destination rows pushed every conversation below the fold in a
  sheet whose job is finding a conversation.
- A "+ Chat" pill clipped by the sheet's rounded corner.
- Accent-coloured pins and project stars (the accent spent on chrome).

**Transcript** (`before/04-conversation.png`)
- The user bubble had a hairline border and a pure-black drop shadow, so the
  reader's words looked like a text field.
- Edit floated halfway between the bubble and the next turn.

**Model picker**
- Every row carried five monospaced capability chips and a coral SMART badge; the
  check sat inline after the name, so selected rows changed width.
- Provider filter and section headers in accent.

**Settings and secondary pages** (`before/06-settings.png`, `before/tab-*.png`,
`before/settings-*.png`)
- Every settings icon tinted coral; the profile card inset differently from the
  groups under it.
- Page titles disagreed: Projects bold large, Artifacts and Connections medium with
  the search field *above* the title, Tasks smaller, Library a centred inline title.
- Connections: a column of coral Connect buttons and a coral "Connected" pill.
- Code: the selected Mac outlined in accent; tinted count capsules; breathing dots.

**Voice** (`before/voice-fullscreen.png`): solid, but the status line was plain
semibold and did not share the product's display voice.

## Directives received mid-pass

1. No status pills or decorative status dots anywhere (owner calls them slop).
2. Native Liquid Glass only for chrome: system glass APIs and button styles, no
   custom rebuilt materials or custom capsule chrome.
3. Use the painted plates (`public/brand/plates/`), `path.jpg` for onboarding.

## Not covered or not verifiable here

- Agents tab shows "Something went wrong" in the preview harness because its model
  is built only at a real sign-in; not a design state, left alone.
- Usage reads a live ledger; the harness has no network, so only its error state
  was seen.
- Real streaming (border beam timing, shimmer) could not be driven without a server;
  verified by build and code review only.
