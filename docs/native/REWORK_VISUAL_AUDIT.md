# Juno native rework — first-hand visual audit

Date: 2026-08-15. Xcode 27.0, iOS 27.0 SDK, macOS 27.0 SDK, iPhone 17 Pro simulator.

Every finding below was seen in a **running build**, not read from source. Both apps
were built from `main` at `67906060` and launched in the `--juno-ui-preview` harness.
Screenshots are in `design/rework/`.

The owner's verdict is that the apps read as "experimental AI slop, not a production
product." That verdict is correct, and this document is about *why* — because the
reason is not the one the code suggests.

## The diagnosis

**The design system is good. It is simply not enforced.**

`JunoDesignTokens.swift` is a genuinely careful, well-reasoned colour system, generated
from the web's `globals.css` by `scripts/generate-design-tokens.ts` so the two platforms
cannot drift. `JunoMotion` exists. `JunoTypography` exists. The radius ladder exists.
None of that is the problem, and none of it should be thrown away.

The problem is that the screens **bypass it**, **re-implement platform controls instead
of adopting native ones**, and **leak developer telemetry into the product surface**.
Four measured facts carry most of the verdict:

| Measure | Count | What it means |
|---|---|---|
| `.font(.system(size:))` call sites | **285**, across **17 distinct sizes** (9,10,11,12,13,14,15,16,17,18,19,20,22,24,26,28,30) | There is no enforced type scale. `JunoTypography` is bypassed. |
| `withAnimation` / `.animation(` call sites | **208** | `JunoMotion` exists and is widely bypassed with ad-hoc `.easeOut(duration: 0.12)`, `0.15`, `0.16`, `0.2`, `0.25`, `0.36`, `2.6`… |
| `.glassEffect` + `GlassEffectContainer` | **21 + 8** across ~90k LOC of Swift | Liquid Glass is barely adopted. macOS has essentially none. |
| Largest single SwiftUI files | `DesktopWorkWorkspace` **5346**, `DesktopChatWorkspace` **4645**, `DesktopCodeStudio` **3110**, `SessionController` **2768**, `JunoMobileWorkView` **2465** | There is no component layer between tokens and screens. |

Hardcoded colour, by contrast, is nearly absent (6 `Color(red:)`, 0 hex literals) and
`accessibilityReduceMotion` is honoured in 78 places. The engineering discipline is real.
It stops at the visual layer.

## Systemic defects

### 1. Monospace is used as a UI label font

This is the single most consistent tell across every screen, on both platforms.

- iOS chat: the model name and per-message cost — `Claude Sonnet 4.6 · $0.021` — render
  in monospace, as do attachment subtitles (`Markdown`, `Design`).
- iOS settings: `Default model`, `Response language`, `Interface language` are monospace
  section headers, while `Appearance` and `Theme` on the same screen are not.
- macOS Work: `Where` / `Model` / `Spent` / `Attempt`, `What you asked for`, `Plan`, and
  the `Needs approval` badge are all monospace.

Monospace outside of code and terminals reads as a debug console. It is the fastest way
to make a product look like an internal tool.

### 2. Per-message cost is shown in the product surface

iOS chat prints `$0.021` and `$0.024` under individual assistant messages; macOS Work
shows a `Spent 0,41 US$` column. No consumer product surfaces per-message inference cost.
This is developer telemetry that escaped into the UI. (It also carries a real bug — see
defect 9.)

### 3. Platform controls are hand-rolled instead of adopted

iOS Settings is built from hand-drawn cards rather than a native `Form` / `List
(.insetGrouped)`. Consequences, all visible: no native section headers, no native row
separators or disclosure behaviour, no swipe actions, inconsistent Dynamic Type. The
theme picker is three hand-drawn bordered boxes rather than a `Picker(.segmented)`, and
signals its selection three redundant ways at once (coral border **and** coral fill
**and** a checkmark). The dropdowns use a `chevron.up.chevron.down` glyph — a *Mac*
control idiom — on iPhone.

This is the deep reason the apps feel non-native, and it is the direct answer to "keep
the Liquid Glass native components": Liquid Glass largely comes **for free** from adopting
`NavigationStack`, `Form`, `List`, `Picker`, `.toolbar`, `.searchable` and
`.buttonStyle(.glass)`. Hand-rolling those surfaces is what opts the app *out* of it.

### 4. The type scale is inverted between screens

Chat body text renders at roughly 19pt with ~1.5 line height — about five lines of an
answer fit on a 6.3" phone. Meanwhile 58 call sites use 11pt and 12 use 10pt. The same
app is simultaneously too large to read and too small to read, depending on the screen.

### 5. No component layer

There is nothing between the token files and 2,000–5,000-line screen files. Every card,
badge, row, status dot and button is drawn inline at its call site, which is why no two
of them agree on padding, radius or weight.

## Screen-level defects

| # | Platform | Screen | Defect | Evidence |
|---|---|---|---|---|
| 1 | iOS | Sign-in | Content stacks from the top and stops; the bottom ~45% is dead space. Disabled "Sign in" is grey-on-grey and reads as broken, not disabled. "Continue in browser" carries identical visual weight to the primary. Text fields (~10pt radius) and buttons (full capsule) use two different corner languages in one 400pt column. | `ios-signin.png` |
| 2 | iOS | Chat | Model chip truncates to `Claud…`. Send is a low-contrast outlined circle with no primary affordance. The nav bar contains three different container shapes (circle, merged capsule, bare text). Message action glyphs float ungrouped with inconsistent spacing between the 2-icon and 3-icon rows. | `ios-chat-light.png` |
| 3 | iOS | Chat (dark) | The dark ground is effectively pure black and cards are barely separable from it. A hard horizontal seam sits under the nav bar where content scrolls beneath with no scroll-edge effect. | `ios-chat-dark.png` |
| 4 | iOS | Work | **Two full-width coral primary buttons on one screen** — "Allow once" (a security decision, expiring in 10 minutes) and "Say something" (low stakes) — so there is no primary. The task title is duplicated: truncated in the nav bar *and* repeated as a serif H1. The parent list bleeds through at the left edge. Four hues compete (amber badge, amber warning, coral buttons, green checks). Completed plan steps render grey, reading as disabled rather than done. | `ios-work.png` |
| 5 | iOS | Settings | See defect 3. Also: ~40pt gaps between groups mean only four settings fit on screen; card radius (~20pt), control radius (~10pt) and button radius disagree. | `ios-settings.png` |
| 6 | iOS | **Code, Tasks** | **Both render "Something went wrong."** The preview harness never passes a `codeModel` — `JunoMobileApp.swift:87–109` omits it, while deliberately passing `workModel` with a comment explaining that Work had this exact bug and was fixed. Code was never given the same fix, so **Juno Code on iOS has never been visually reviewable.** The error state itself is a developer message ("Restart Juno, or sign out and back in") with no retry control. | `ios-code-error.png` |
| 7 | macOS | Work | Three levels of horizontal switching stack up: Chat/Code/Work segmented → sidebar rows → Overview/Context/Activity/Files & cost. "Needs approval" appears **twice** — floating in the toolbar and again beside the H1. "Stop" (destructive) is styled identically to "Pause". | `mac-work.png` |
| 8 | macOS | Code | Eight unlabelled, ungrouped toolbar icons with no separators. The target picker ("juno · ~/Developer/juno · This Mac") seams into the composer with a mismatched radius. The sidebar footer overlaps a clipped, half-transparent project row — a live layout bug. A mic icon and a coral voice orb sit adjacent, giving two microphone affordances. Six status glyphs (shield, spinner, filled dot, green check, red exclamation, hollow dot) with no legend. | `mac-code.png` |
| 9 | macOS | Work | Currency renders as **`0,41 US$`** — a locale-mismatched formatter producing a French decimal comma with a suffixed symbol. Should be `$0.41`. | `mac-work.png` |

## Information architecture

`JunoMobileSection` declares **ten top-level destinations on a phone**: chat, search,
code, work, tasks, projects, library, artifacts, connections, settings
(`native/iOS/JunoMobile/App/JunoMobileSection.swift:6-16`). Two of them do not render.

For comparison, the products Juno is being measured against ship two to four. Ten
destinations behind a hamburger is not an information architecture; it is a list of
everything that was built.

## What must survive the rework

- The **colour token system** and its generator (`scripts/generate-design-tokens.ts`).
  It is the best-documented thing in the repository and it already keeps web and native
  from drifting. Extend this pipeline — do not replace it.
- `JunoMotion`, `JunoTypography` and the radius ladder as *concepts*. They need
  enforcement, not redesign.
- **`accessibilityReduceMotion` discipline** — 78 honoured sites is genuinely above
  industry norm.
- The **macOS Code launchpad** ("What are we working on?" with suggested starts and an
  explicit target picker). Its structure is right; only its chrome is wrong.
- The **macOS Work approval card**. It is the one component in either app with correct
  visual priority.
- The **preview harness** (`JunoPreviewSupport`, ten scenarios including offline, error,
  conflict, streaming). This is exactly the right tool for a visual rework — it just
  needs Code wired into it.

## Immediate follow-ups this audit implies

1. Wire `codeModel` into the iOS preview harness so Code can be reviewed at all.
2. Fix the `0,41 US$` currency formatter.
3. Remove per-message cost from the chat transcript; move cost to a session-level receipt.
4. Replace every monospace UI label with the text style it should have been.
