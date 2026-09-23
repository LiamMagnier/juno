# Phase 2 implementation brief: the Mac transcript (juno-glass, branch mac/liquid-glass-chat)

All paths are under `/Users/liammagnier/Developer/project/juno-glass/`, and nothing has been changed. Line numbers come from the current working tree. `DesktopChatWorkspace.swift` has uncommitted edits by other agents (+963/−338 against HEAD), so re-check the anchors before editing.

Web references are to `/Users/liammagnier/Developer/project/juno/src` (main), which is the live site. The branch's own `src/` is older than main.

## 0. What the tree looks like now, and corrections to the inputs

### Action row
The glass has already been removed in the working tree, but that change is not committed. The user's screenshot is the installed build. In `App/DesktopChatWorkspace.swift` now:

- `actionRow` (2256–2264) is a plain `HStack(spacing: 0)`.
- `DesktopMessageActionStyle` (2349–2382) draws a radius-8 `RoundedRectangle` hover fill in `junoHover`, not a circle.
- `DesktopMessageActionMark` (2385–2395) is a 16pt glyph in a 28×28 frame.

Still wrong:
- **Too many actions:** up to 8 top-level actions (2211–2241).
- **Mono caption still there:** `footerLine` (1966–1974), drawn at 2202–2207.
- **Visibility is hover-only everywhere:** `opacity(hovered || copied ? 1 : 0)` at 2258.
- **Regenerate menu is thin:** hidden caret, no instructions, no provider sections (2290–2313).
- **Continue is in the row** (2230–2235) instead of in the finish note.
- **Stale doc comment** at 1871–1881.
- **Tint source:** coral comes from `.junoAccentTint()` at `App/ChatDetail.swift:60`. It must never reach action ink.

### Why media never shows
Four breaks in the chain:
1. **The sync client drops the URL.** `JunoSync/NativeSyncAPIClient.swift:77-88` strips `url`.
2. **The live stream drops attachments and artifacts.** `EventEnvelopeWire.Message` (`JunoChatKit/NativeChatAPIClient.swift:1600-1616`) has no `attachments` field, and the envelope has no `artifacts` field.
3. **The finished row keeps its placeholder and loses its data.** `completeAssistant` (`NativeConversationStore.swift:2065-2087`) never clears `mediaProgress` and never copies attachments or cost. The transient row keeps showing the placeholder until `reload()`.
4. **No view reads attachments.** `MessageRow` never reads `message.attachments`, neither `userTurn` (2008–2039) nor `assistantTurn` (2150–2247).

The report claim that the attachment `url` is a "short-lived signature" is wrong. `getViewUrl` always returns the stable `/api/files/<key>` (`src/lib/storage.ts:203-208`).

### Artifacts
- `DesktopInlineArtifactCard` (2404–2485) is an icon row with no body.
- `NativeArtifactSandbox.document` (`NativeArtifactPreview.swift:120-135`) renders only HTML and SVG, with network blocked.
- Design artifacts opened from chat use the tag body (`DesktopArtifactCanvas.swift:817`), which may lack `schemaVersion`.
- Two icon mistakes in `DesktopArtifactKindLabel.icon`:
  - REACT maps to `.code`, which is the Juno Code product mark (`juno.code`). The web draws Phosphor `Code`.
  - DESIGN maps to `.penTool`. The web uses the Juno Design mark.

### Corrections to the spec and the input reports

| # | Topic | Correction |
|---|---|---|
| 1 | Action size | The web action is 32×32 (`pressable.tsx:141`, `size-8`). The spec keeps 28pt as deliberate difference #10 (§0.6, §0.8). **Use 28pt circles**, as the task asks. Pager arrows become 24pt (the web's 28 minus the same 4). |
| 2 | Prose and bubble type | The web moved to `text-reading` 16/1.7 (`tailwind.config.ts:393`; `globals.css` `.prose-juno` `font-size:1rem; line-height:1.7`, block gap `0.85em`, `max-inline-size:75ch`; `USER_BUBBLE_CLASS` px-4 py-2.5 `text-reading`). §6.2 and §6.4 (15pt/1.6–1.65) are stale. |
| 3 | Models glyph | On main, `SettingsIcons.models` is `Cube` (`src/lib/app-icons.ts:477`). The branch's `src/lib/app-icons.ts:455` still says `Cpu`. **Merge origin/main into the branch before regenerating icons**, or the generator's icons.tsx check fails on `Cube`. |
| 4 | Artifact card | Radius **16**, no outer inset. The body is `min(44vh, 360)` with a 240 minimum, not a fixed 320. The icon tile is 32 with radius 12. The button says "Open" (help text: "Open in canvas"). This corrects §6.8. |
| 5 | Sent attachments | Images are 144pt tall and at most 288 wide, radius **16**. Files are 144×144 page tiles with a 48pt caption band. There are no "chips" and no 160pt thumbnails (§6.2 is wrong on both). Video is a card (≤480 wide, 52pt footer), not a bare `VideoPlayer`. |
| 6 | Error box | Destructive 40% border and a fill of 5% (light) or 14% (dark). This corrects §6.11's 35% and 7%. |
| 7 | Designs in chat | The web does **not** draw designs inline: `sandbox-frame.tsx:786-803` dumps the JSON in a `<pre>`. The Mac will draw them, so record this in the §0.8 register. |
| 8 | User-turn fork label | The web label is "Fork privately", not "Fork from here" (2032). The web also hides Edit while busy; it does not grey it out. |

### Coordination
- Stage 1 splits `DesktopChatWorkspace.swift`. It is contended, so one agent should do the split in one commit and everyone else rebases.
- New files need `native/Scripts/generate-projects.sh` (XcodeGen). The pbxproj is also contended.
- Every change to `JunoChatKit` or `JunoDesignSystem` must also build iOS (JunoMobile).

## 1. Stage plan
Each stage builds and passes tests on its own, and each later stage depends only on earlier ones.

| Stage | Priority | Contents |
|---|---|---|
| **1** | P-A plus foundations | Snapshot harness and test-host guard. File split. The new action row and menus. Wire and store fixes (`regenerateInstruction`, attachments and cost in `done`, clearing `mediaProgress`, tolerating `work`/`resume` frames). New icons. |
| **2** | P-B | Media and files inline: URL retention, a media loader, user attachments, generated image and video, file cards, Quick Look, image edit. |
| **3** | P-C | Artifacts: resolving stored rows, the web-parity WKWebView runtime, the inline card with Preview/Code/Console, Open → dock (editable when a stored row exists), inline designs, Mermaid, `juno-visual`. |
| **4** | P-D | The rest of §6: prose, code, tables, activity row and Thought panel (TrailingDock), sources pill and citations with thread hydration, finish notes and errors, follow-ups, scrolling, find, stream resume, approvals. |

Gates for every stage:
- `npm run design:tokens:check`
- `npm run native:design:glass`: transcript files must not be allow-listed, except `ScrollToLatestButton.swift` and `FindBar.swift` in Stage 4.
- `native:contract:check`
- JunoNativeKit `swift test`
- JunoDesktopTests
- An iOS build
- The transcript snapshot suite, light and dark

---

## 2. Offscreen snapshot harness (the first task in Stage 1)

### 2.1 Test-host guard
Without this guard, running JunoDesktopTests opens the real app, its window, and its production Keychain-backed store.

`App/JunoDesktopApp.swift`:
- Add `enum JunoTestHost { static let isActive = ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil }`.
- In `init()` (136–150), set `_configuration = State(initialValue: JunoTestHost.isActive ? nil : …live())`. This stops the test run from opening the encrypted store and triggering a Keychain prompt.
- Main `WindowGroup` (152): add `.defaultLaunchBehavior(JunoTestHost.isActive ? .suppressed : .automatic)`.
- `MenuBarExtra` (241): pass `isInserted: .constant(!JunoTestHost.isActive)`.
- `JunoDesktopAppDelegate`: when the guard is active, call `NSApp.setActivationPolicy(.accessory)` in `applicationWillFinishLaunching`, and skip `presentMainWindowIfWithheld()` (97–110).

**Acceptance:** running the suite shows no window, no Dock icon, no menu-bar item and no Keychain prompt.

### 2.2 Files
Create:
- `native/macOS/JunoDesktop/Tests/Snapshots/TranscriptSnapshotRenderer.swift`
- `native/macOS/JunoDesktop/Tests/Snapshots/TranscriptSnapshotFixtures.swift`
- `native/macOS/JunoDesktop/Tests/Snapshots/TranscriptSnapshotTests.swift`
- `native/macOS/JunoDesktop/Tests/Snapshots/SnapshotStills.swift` (WKWebView stills and deterministic media)

Also:
- Migrate `Tests/DesktopWorkStartPathSnapshots.swift`, which calls `window.orderBack(nil)` and so puts a window on screen, to the new renderer.
- Add an npm script, `"native:snapshots:transcript"`, that runs the command in §2.5.

### 2.3 Renderer
Use `NSHostingView` and `cacheDisplay` rather than `ImageRenderer`:
- `ImageRenderer` draws AppKit-backed pieces as placeholders: `Menu` with `.menuStyle(.button)`, `TextEditor`, `ScrollView`.
- Neither approach can draw a `WKWebView`, which renders out of process. §2.4 covers that.

```swift
@MainActor enum TranscriptSnapshotRenderer {
  static func render<V: View>(_ v: V, name: String, width: CGFloat = 832,
                              appearance: NSAppearance.Name, into dir: URL) async throws
}
```

Steps:
1. **Root view:**
   ```swift
   v.frame(width: width)
    .fixedSize(horizontal: false, vertical: true)
    .background(Color.junoCanvas)
    .environment(\.colorScheme, appearance == .darkAqua ? .dark : .light)
    .environment(\.controlActiveState, .key)
    .environment(\.locale, Locale(identifier: "en_US"))
    .transaction { $0.disablesAnimations = true }
   ```
   The fixture wraps rows in the same `TranscriptColumn` modifier the app uses: `frame(maxWidth: 768)` plus a 32pt horizontal gutter, so 832 = 768 + 2×32.
2. **Offscreen window.** Create `NSWindow(contentRect: CGRect(x: -20_000, y: -20_000, width: width, height: 10), styleMask: .borderless, backing: .buffered, defer: false)`. Set `appearance`, set `isReleasedWhenClosed = false` and install the hosting view as `contentView`. **Never call `orderFront` or `orderBack`.**
3. **Size.** Call `host.layoutSubtreeIfNeeded()`, set `size = host.fittingSize`, call `window.setContentSize(size)`, then lay out again.
4. **Settle.** Run a loop for up to 1.5s, pumping `RunLoop.main.run(until: .now + 0.05)` plus `Task.yield()`, until `SnapshotProbe.pending == 0` (the stub loaders are done). Wait at least 300ms.
5. **Bitmap at a fixed 2×.** Create `NSBitmapImageRep(pixelsWide: 2w, pixelsHigh: 2h, …, colorSpaceName: .deviceRGB)`, set `rep.size = size`, call `host.cacheDisplay(in: host.bounds, to: rep)`, and write the PNG to `$JUNO_SNAPSHOT_DIR/transcript/<name>-<light|dark>.png`.
6. **Non-blank check.** Assert that at least 0.5% of pixels differ from the canvas colour.
7. **Verify on the first run** that an un-ordered offscreen window draws. If it comes back blank, do not fall back to ordering the window in; report the problem instead.

### 2.4 Deterministic stand-ins
- **WKWebView stills.** `NativeArtifactWebPreview` reads a new environment value, `\.junoWebPreviewStill: ((String) -> NSImage?)?`, and draws `Image(nsImage:)` instead of the web view when the value returns an image. `SnapshotStills` builds these images from an offscreen `WKWebView(frame: 720×360)` that is never placed in a window:
  - Load the document with `loadHTMLString`.
  - Wait for the `juno` bridge to post `status` done or error, or for `didFinish` plus 400ms.
  - Call `takeSnapshot(with: WKSnapshotConfiguration())`.
  - Fixtures use inline CSS only, so no network is needed.
- **Media.** `TranscriptMediaProviding` is the protocol `NativeChatMediaLoader` conforms to (Stage 2). `SnapshotMediaProvider` returns:
  - `PreviewImageFixtures.png(for:)` for `img-user-1` (1200×800) and `img-gen-1` (1024×1024), from `JunoPreviewSupport/PreviewImageFixtures.swift:18-24`.
  - CoreGraphics-drawn thumbnails: a PDF page, a spreadsheet grid and a 16:9 slide.
  - Forced states: `.loading` and `.failed`.
- **Hover.** Add `@Entry var junoSnapshotHover = false`. It forces the row's `hovered` flag and the media hover cluster.
- **Menus and tooltips cannot be drawn offscreen.** Menu contents come from a pure `MessageMenuModel`, which gets unit tests instead.

### 2.5 Fixtures
Each fixture is built from `NativeChatMessage` values with no store involved, and rendered through the real `MessageRow`. Every fixture is rendered in light and dark.

1. **`reply-actions`**
   - The newest assistant reply: two paragraphs and a list.
   - Model `anthropic:claude-sonnet-4-6`, 8421 prompt tokens, 612 completion tokens, cost 0.0214.
   - Variants: `-rated` (feedback `.up`), `-copied`, and `-older-hover` (an older reply with hover forced on).
2. **`user-image-pdf`**
   - A user turn, "Can you compare these?", with:
     - IMAGE `img-user-1` (1200×800 → a 216×144 tile)
     - FILE `quasar-notes.pdf`, `application/pdf`, 248000 bytes, with a page thumbnail. Caption: "PDF · 242.2 KB".
   - Variant: `-hover`, showing Copy, Edit and Fork Privately.
3. **`generated-image`**
   - Content `""`, one IMAGE attachment `img-gen-1` named "GPT Image 2 — Poster.png", model `openai:gpt-image-2`, cost 0.042.
   - Expected: a 320pt square frame, the row [Good][Bad][More] and **no caption**.
   - Variants: `-loading`, `-failed`, `-hover` (Edit, Download, Expand).
4. **`media-placeholder`**
   - `mediaProgress` image, stage "generating".
   - A second variant with video, stage "queued".
5. **`file-card-xlsx`**
   - "Here's the workbook." plus `Q3 forecast.xlsx` (`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, 90112 bytes).
   - Caption: "Excel workbook · 88 KB", with a grid thumbnail.
6. **`file-card-pptx`**
   - `Launch plan.pptx` (`…presentationml.presentation`, 1258291 bytes).
   - Caption: "PowerPoint deck · 1.2 MB".
   - The stub returns no thumbnail but an excerpt, so this exercises the text layer.
   - Variant: `-extension-only`.
7. **`artifact-html`**
   - Content: `<juno:artifact identifier="pricing-card" type="html" title="Pricing card">…inline-styled HTML…</juno:artifact>`.
   - A stored `NativeArtifact` v2 with the same `messageID`. Meta line: "HTML · v2 · Live".
   - Variants: `-streaming` (tag still open, `isPending`), `-code`, `-console-error`.
8. **`design-output`**
   - Uses msg-6 and `art-design` from `JunoPreviewSupport/PreviewFixtures.swift:166-171, 232-236`.
   - The SVG comes from a stubbed `/api/design/art-design/export?format=svg`. Add that route to `PreviewSender.swift` next to the `/api/attachments/` route at :46-67.
9. **`code-block`**: a 12-line Swift fence (with gutter) and a 3-line bash fence (no gutter).
10. **`table`**: 4 columns × 5 rows, with one wide column so the table scrolls horizontally.
11. **`sources-pill`**: 6 sources, collapsed and expanded (a `startsExpanded` init parameter).
12. **`error-note`**
    - `errorDescription` "The model provider is overloaded. Try again in a moment.", on the newest turn, so "Try again" shows.
    - `finish-note`: `.length`, reading "The model stopped at its token limit." with Continue.
13. **Stage 4 extras:** `activity-live`, `activity-settled`, `follow-ups`, `find-highlight`.

### 2.6 Running the suite
The test is gated with `.enabled(if: env["JUNO_SNAPSHOT_DIR"] != nil)`.

```
TEST_RUNNER_JUNO_SNAPSHOT_DIR="$PWD/.snapshots" xcodebuild test \
  -project native/macOS/JunoDesktop/JunoDesktop.xcodeproj -scheme JunoDesktop \
  -destination 'platform=macOS' -only-testing:JunoDesktopTests/TranscriptSnapshotTests
```

xcodebuild strips the `TEST_RUNNER_` prefix before passing the variable to the tests. The test host is the app (`TEST_HOST` in pbxproj :773), so `ph.*` symbols resolve from `Icons.xcassets`.

---

## 3. Stage 1 (P-A): message actions and wire foundations

### 3.1 Split `DesktopChatWorkspace.swift` (Phase 2 step 1)

| Destination file (`App/`) | What moves into it |
|---|---|
| `ChatTranscript.swift` | `DesktopChatMeasure` (1322–1327), `DesktopTranscript` (1329–1820), `DesktopMessageRise` (1829–1862) |
| `MessageRow.swift` | `DesktopRegenerateModel` (1866–1869), `DesktopMessageRow` (1882–2314) without its actions |
| `MessageActions.swift` (new) | Everything in §3.2 |
| `InlineArtifactCard.swift` | 2404–2485, moved as is; rewritten in Stage 3 |
| `SourcesPill.swift` | 2517–2564 |
| `ActivityRow.swift` | 2579–2603 |
| `FinishNote.swift` | 2605–2632 |

`DesktopSpeechPlayback` (2487–2505) moves to `MessageActions.swift` and becomes `@Observable`, with `playingMessageID: String?` and `stop()`.

`DesktopChatWorkspace.swift` keeps `DesktopChatWorkspace`, `DesktopNewProject*` and `DesktopConversationView`.

### 3.2 `MessageActions.swift`: the native recipe

**`MessageActionButtonStyle(isOn: Bool = false, isOpen: Bool = false)`** is pure SwiftUI with no glass and no `.tint`.

- **Shape and glyph:**
  - Frame 28×28 with `.contentShape(Circle())`.
  - Label: `JunoIconView(icon, size: 16, isOn: isOn)`. `isOn` picks the `.fill` cut (`JunoBrand.swift:439`).
- **Ink:**
  - `isOn`: `Color.junoAccentInk` (#AD5234 / #DE8D73).
  - Hovered or `isOpen`: `junoForeground` (#1D1D1B / #F4F3F1).
  - Otherwise: `junoSecondaryInk` (#6A6862 / #AEAAA3).
- **Background:**
  - `isOn`: `Circle().fill(.junoSelected)`, held under hover.
  - `isOpen`: `Circle().fill(.junoCard)` plus `strokeBorder(.junoBorder, 1)`.
  - Hovered: `Circle().fill(.junoHover)` (#EEECE5 / #383633).
  - Otherwise: clear.
- **New token.** Add `Color.junoSelected = junoAdaptive(JunoGeneratedColors.selected)` to `JunoDesignSystem/JunoColors.swift`. That is `--selected`: #EBE8E0 / #403D3A, `Generated/JunoGeneratedTokens.swift:217-221`. Do not reuse `junoSelectedFill`, which is the sidebar's colour.
- **Motion and states:**
  - Hover fill and ink change: `JunoMotion.fast` (120ms, curve 0.33, 1, 0.68, 1).
  - Press: scale 0.97 on `JunoMotion.press` (70ms).
  - Disabled: opacity 0.5 and no hit testing.
  - Focus: `.focusEffectDisabled()` plus a 2pt `Circle().stroke(Color.junoRing, lineWidth: 2)` padded out by 2pt, shown when `@Environment(\.isFocused)` is true.
- **No hover articulation** (§0.8 #8), so the web's lift, tilt and rotate gestures are dropped.
- **Feedback swell** (only when a thumb turns on, and not under Reduce Motion): a `KeyframeAnimator` scaling 0.86 → 1.18 → 1 over 220ms on the out-back curve (0.34, 1.32, 0.64, 1).
- **Feedback burst:** 6 dots of 4pt in `junoAccentInk`, at angles 15° + 60°·n. Each fades from opacity 0.9 to 0, scales from 0.4 to 0.2 and travels 3.6pt, over 360ms on out-expo (0.16, 1, 0.3, 1).
- **Tooltips:** `.help(label)`. The system tooltip delay is a deliberate difference.

**`MessageActionRow`** is an `HStack(spacing: 0)` with 6pt above it, is 32pt tall, and has no leading inset, so the first circle lines up with the text.

- **Visibility:**
  - The row is always at opacity 1 on the newest reply.
  - Otherwise it is at opacity 1 only when `hovered || focusedAction != nil || menuTracking || copied || snapshotHover`, and 0 otherwise.
  - The fade is `JunoMotion.reduced(.fast, tier: .tint)`.
  - "Newest reply" is new API: pass `isNewest = message.id == transcript.last?.id && role == .assistant`.
- **Keeping the row visible while a menu is open.** SwiftUI `Menu` does not report when it opens. The row observes `NSMenu.didBeginTrackingNotification` and `NSMenu.didEndTrackingNotification`:
  - When tracking begins while `hovered` is true, it sets `menuTracking = true` and `openTrigger = hoveredAction`.
  - `openTrigger` gives the Regenerate trigger its `isOpen` look.
  - Check this at runtime before relying on it.
- **Accessibility.** The turn gets `.accessibilityAction(named:)` for each action, so VoiceOver can reach them even when the row is at opacity 0.

**Reply row.** It renders when `!isVoice && !message.isPending && message.errorDescription == nil`. As on the web, an errored turn gets no row. The order is fixed:

`[MessageVersionPager]` (outside the fading cluster), then `[Copy] [Good response] [Bad response] [Regenerate▾] [More▾]`

| Action | Condition | Glyph (asset) | Behaviour |
|---|---|---|---|
| Copy | `hasTextContent` | `ph.copy` swaps to `ph.check` in `junoSuccessInk` (#347449 / #60AF7A) | Copies the raw Markdown with `<juno:memory>` removed and trailing space trimmed: a new `NativeMessageContent.copyableMarkdown(of:)`, matching the web's `stripMemoryTags(view.content).trimEnd()`. **Manual cross-fade:** the two glyphs share a ZStack, both at opacity 0↔1 and scale 0.8↔1 over 120ms. The check arrives on a spring curve (0.34, 1.16, 0.64, 1); the copy glyph leaves on ease-in. It reverts after 2.0s. `JunoIconView` is a raster `NSImage`, so `.symbolEffect(.replace)` does not apply. No toast. |
| Good / Bad response | `setFeedback != nil` (a server row, not private) | `ph.thumbsup(.fill)`, `ph.thumbsdown(.fill)` | Optimistic toggle, with the `isOn` style. `POST /api/messages/{id}/feedback` `{feedback:"UP"\|"DOWN"\|null}`. On failure, roll back and show "Could not save your feedback." |
| Regenerate ▾ | `isNewest && regenerate != nil && !isGenerating && !isMediaOnly` | `ph.arrowclockwise` 16pt plus `ph.caretdown.bold` 12pt at 60% opacity, 2pt gap, −4pt trailing, inside the same 28pt circle | `Menu`, `.menuStyle(.button)`, `.buttonStyle(MessageActionButtonStyle(isOpen:))`, `.menuIndicator(.hidden)` |
| More ▾ | any item is available | `ph.dotsthree` | Menu; accessibility label "More actions", help "More" |

`isMediaOnly = !hasTextContent && !message.attachments.isEmpty`. An image-only reply therefore shows [Good][Bad][More] only.

**Regenerate menu.** Menu labels are Title Case (§0.7); the instruction strings are sent verbatim.
1. **Try Again** (`ph.arrowclockwise`): `regenerate(.init())`.
2. **Switch Model ▸** (`ph.cube`):
   - One `Section(providerName)` per provider. The provider name is the display-name part before " · ".
   - Each item is a `Toggle`. Its getter is `id == (message.model ?? composerModel)`; its setter calls `regenerate(.model(id))`. The system checkmark marks the current model; this is a deliberate difference from the web's coral check.
   - Item icon: the provider mark, rasterised once to a 16pt template `NSImage` with `ImageRenderer`. NSMenu section headers cannot hold an image.
   - With no models, show "No other models available."
   - List chat-modality models only, with no coming-soon and no legacy entries.
   - Extend `DesktopRegenerateModel` with `provider` and `providerLabel`.
3. Divider.
4. **More Concise** (`ph.listdashes`): instruction "Make the answer more concise: keep the substance, cut the length by at least half."
5. **Add Details** (`ph.listplus`): instruction "Add more detail: expand the answer with the specifics, examples and caveats that were left out."

**More menu**, in order:
1. **Read Aloud** (`ph.speakerhigh`), or **Stop Reading** (`ph.square.fill`) while `speechPlayback.playingMessageID == message.id`. Needs text.
2. **Branch ▸** (`ph.gitbranch`):
   - **Into a New Chat** (`ph.gitbranch`): the existing `branch` path (`POST /api/conversations/{id}/fork {atMessageId}`). Toast "Branched into a new chat." The More trigger shows a `ProgressView` and is disabled while the request runs.
   - **Fork Privately** (`ph.gitfork`): a new `NativePrivateChatModel.seed(_ turns: [Turn])`, allowed only while it is empty and idle. Starts the private route with the transcript up to this message. Toast "Forked from message N".
3. **Share Chat…** (`ph.sharenetwork`): the existing `share`, which opens the popover. Hidden in private chats and unsaved chats.
4. A divider, only when both neighbouring groups have items.
5. **Quote in Composer** (`ph.quotes`): new `ChatComposerRequest.Kind.quote(String)` (`App/ChatComposer.swift:245-256`). Seeds the composer with every line prefixed by "> ", then "\n\n", with the caret at the end.
6. **Copy Link** (`ph.linksimple`): `{origin}/chat/{conversationID}?m={messageID}`, where the origin is the configured backend origin (`JunoDesktopConfiguration.swift:159`). Toasts "Link copied." or "Couldn't copy the link."
7. A divider, then an info `Section`, when the model or tokens are known or cost > 0:
   - `Text(modelName)`
   - `Text(meta)` in 11pt monospaced. NSMenu shows information items greyed; the web keeps them at full ink, so this is a deliberate difference.
   - **Format** (port of `lib/utils.ts:147-160`), `"{fmt(in+out)} tokens ({fmt(in)} in · {fmt(out)} out) · {usd}"`:
     - Tokens: under 1000, a rounded integer; under 10k, 1 decimal plus "K"; under 1M, 0 decimals plus "K"; otherwise 2 decimals plus "M".
     - Cost: under 0.0001, "<$0.0001"; under 0.01, 4 decimals; under 1, 3 decimals; otherwise 2 decimals.
     - The cost part appears only when cost > 0.
   - Examples: `"9.0K tokens (8.4K in · 612 out) · $0.021"` and `"140 tokens (140 in · 0 out) · $0.042"`.

**Delete:**
- `footerLine` (1966–1974) and its view (2202–2207).
- Read aloud, Continue, Branch and Share from the row (2224–2241). Continue moves to the finish note in Stage 4. Until then, keep it as the only button in a temporary `FinishNote` row.
- `DesktopMessageAction`, `DesktopMessageActionStyle` and `DesktopMessageActionMark` (2317–2395).
- Rewrite the doc comment at 1871–1881.

**`MessageVersionPager`** (Mac-only; leave the shared `NativeBranchNavigator` alone for iOS):
- Arrows: 24×24 circles with the same recipe, `ph.caretleft` and `ph.caretright` at 14pt regular. Labels "Previous version" and "Next version".
- Count: "2/3" in 11pt mono `junoSecondaryInk` with `.monospacedDigit()`, minimum width 21pt, centred, `.accessibilityValue`.
- 4pt trailing margin.
- Disabled at either end and while generating, with no help text when disabled.

### 3.3 User turn (`MessageRow.userTurn`, replacing 2008–2133)

- **Container:** remove `Spacer(minLength: 90)` and `.frame(maxWidth: 640)`. Use a trailing `VStack` with attachments (Stage 2), the bubble, then the actions.
- **Bubble:**
  - 16pt `junoForeground` with `.lineHeight(.multiple(factor: 1.7))`. Errata item 13: verify that this works on `Text`.
  - Padding 16 horizontal, 10 vertical.
  - Fill `junoSecondary` (#F2F0EB / #302E2C). It is `junoMuted` today (2068), which is wrong. **No stroke**: delete 2069.
  - Shape: `UnevenRoundedRectangle(16, 16, 8, 16)`.
  - Width at most 85% of the measure. The transcript measures its column with `onGeometryChange` and passes it down as `@Entry var junoMeasure`.
  - `.textSelection(.enabled)`.
- **Collapse** (keep `NativePromptLimits`, and assert it uses more than 700 characters or more than 14 lines):
  - Clamp to 240pt.
  - A 64pt gradient from `junoSecondary` to clear.
  - The clamp switches instantly; only the gradient fades, over 220ms.
- **Show more:**
  - A 28pt-tall row with radius 10, 6pt horizontal padding, 4pt above and −6pt trailing.
  - 11pt medium **SF, not mono**, `junoSecondaryInk`.
  - Hover fills `junoHover` and turns the ink `junoForeground`.
  - Label "Show more · N lines" only when the count is exact and above 1; otherwise "Show more".
- **Actions:** 4pt under the bubble, trailing. The pager sits outside the cluster, then [Copy][Edit][Fork Privately].
  - The cluster is **always** hover- or focus-revealed, even on the newest turn.
  - Edit (`ph.pencilsimple`) is **hidden**, not disabled, while generating.
  - Fork Privately (`ph.gitfork`) uses the same seed path as §3.2.
- **Editor:**
  - Full column width, with the bubble's fill, shape and padding.
  - At rest a 1pt clear border. On focus, a 1pt `junoRing` border plus a 3pt `junoRing`-at-16% halo, fading over 120ms. The web uses `--primary`; the spec's focus colour and accent budget win.
  - The text field is 16pt at line height 1.7 and grows to 14 lines (about 381pt), then scrolls. It is pre-filled from the displayed version, with the caret at the end.
  - Keys: Return sends. Shift-Return inserts a newline. ⌘Return sends. Esc cancels. Return is ignored while IME marked text is active: check `NSTextView.hasMarkedText()` in `onKeyPress(.return)`.
  - Buttons: trailing, 8pt below, 8pt apart.
    - Ghost "Cancel": 28pt tall, 12pt horizontal padding, 13pt medium, radius 10, hover `junoHover`.
    - `.borderedProminent` "Send": disabled only when the text is empty.
  - Unchanged text just closes the editor, except on an unsent turn, which re-sends.
  - Focus returns to whatever opened the editor.
- **Unsent turn:** always visible, 6pt under the bubble. "Not sent" in 11pt mono `junoDestructiveInk`, 10pt of space, then a `.bordered` small "Retry send" with `ph.arrowclockwise` at 14pt.

### 3.4 Wire and store (JunoChatKit)

- **`regenerateInstruction`** (the web trims it and caps it at 400 characters, `lib/chat/request.ts:88`):
  - Add it to `GenerationRequestWire` (`NativeChatAPIClient.swift:1506-1530`) and to `NativeChatGenerationRequest`. Omit the key when nil.
  - Add a one-shot `RetryContext.regenerateInstruction`.
  - Change `retryLastMessage(conversationID:modelID:)` (`NativeConversationStore.swift:1747`) to `retryLastMessage(conversationID:modelID:instruction:)`.
- **`done` frame:**
  - `EventEnvelopeWire.Message` gets `attachments: [AttachmentWire]?`, carrying id, kind, fileName, mimeType, size, url, width, height and parserState.
  - `EventEnvelopeWire` gets `artifacts: [ArtifactWire]?`, used in Stage 3.
  - `NativeCompletedChatMessage` gets `attachments: [NativeChatAttachment]` and `artifacts`.
- **`completeAssistant`** (2065–2087) must also set `mediaProgress = nil`, `attachments`, `costUSD = costUsd`, `promptTokens`, `completionTokens`, `cacheReadTokens` and `cacheWriteTokens`.
- **Unknown frame types.** In `decodeEvent`, `work` and `resume` must not end the stream (`default: throw malformedResponse` at `NativeChatAPIClient.swift:1230`). Add `.resume(available: Bool?, refetch: Bool?)`. Map `work` and any unknown type to `.ping`.
- **`NativeChatMessage`:** no new fields in this stage.

### 3.5 Icons
In `scripts/generate-native-icons.mjs`, add these to the `PHOSPHOR` map (line 75+) after merging main:

| Phosphor name | icons.tsx export |
|---|---|
| `Cube` | models |
| `ListDashes` | `ListMinus` |
| `ListPlus` | `ListPlus` |
| `ArrowElbowDownRight` | `CornerDownRight` |
| `VideoCamera` | `Video` |
| `ArrowSquareOut` | `ExternalLink` |
| `Code` | `Code2` |

In `JunoDesignSystem/JunoBrand.swift` (enum at :99, one case per line with string literals only, so the generator check can parse it):
- New cases: `.cube`, `.listDashes`, `.listPlus`, `.cornerDownRight`, `.video`, `.externalLink`, `.codeBrackets`.
- Change `.models` to `ph.cube`.

Run `node scripts/generate-native-icons.mjs`, then `--check`. `Tests/DesktopIconCatalogTests.swift` covers the rest.

### 3.6 Acceptance
- **Newest reply:** exactly [Copy][👍][👎][Regenerate▾][More▾] at opacity 1 with the pointer elsewhere. An older reply shows nothing until hover or focus.
- **No caption:** the string "·" followed by a cost appears nowhere in the reading column.
- **Image-only reply:** [👍][👎][More] only.
- **Rated thumb:** fill cut, `junoSelected` circle, `junoAccentInk`. Tab focus shows the graphite ring.
- **Glass gate** passes with `MessageActions.swift` not allow-listed.
- **Unit tests** (JunoChatKitTests):
  - `regenerateInstruction` is encoded only when set.
  - A `done` fixture from `/api/generate` with `attachments[0]` produces a completed row with the attachment and `mediaProgress == nil`.
  - Streams containing `work` and `resume` frames finish.
  - A `MessageInfoFormat` table test covering every formatter boundary above.
  - `MessageMenuModel` item sets for newest, older, private, media-only and unsaved turns.
- **Snapshots:** `reply-actions*` and `user-image-pdf-hover` (the bubble only until Stage 2).

---

## 4. Stage 2 (P-B): media and files inline

### 4.1 Data
- **`NativeChatAttachment`** (`NativeChatAttachment.swift:15-47`): add `url: String?` and `parserState: String?`, plus:
  - `fileExtension`
  - `formatLabel`: port of `formatLabelOf`, `viewer-kind.ts:104-131`. PDF → "PDF"; image → "Image"; video → "Video"; docx/docm → "Word document"; pptx/pptm → "PowerPoint deck"; xlsx/xlsm → "Excel workbook"; odt → "OpenDocument text"; ods → "OpenDocument spreadsheet"; odp → "OpenDocument presentation"; rtf → "Rich text"; md → "Markdown"; csv → "CSV"; tsv → "TSV"; txt → "Text"; otherwise the uppercased extension, or "File".
  - `byteLabel`: port of `formatBytes`, base 1024 with 1 decimal and trailing ".0" dropped. Examples: 248000 → "242.2 KB", 90112 → "88 KB", 1258291 → "1.2 MB".
- **Keep the URL in sync.** In `NativeSyncAPIClient.persistableData` (`JunoSync/NativeSyncAPIClient.swift:77-88`), keep `url` when it matches `^/api/files/[^?#]+$` and drop anything else. Rewrite the comment. Existing rows without a URL fall back to `NativeProjectAPIClient.accessFile(id:)` (`NativeProjectAPIClient.swift:165-193`), which calls `GET /api/v1/entities?type=attachment&ids=`.
- **Decode it.** Add `url` to `MessageAttachmentWire` (`NativeConversationStore.swift:2651-2660`) and pass it through in `decodeAttachment` (494–513).
- **Show attachments on the sender's turn immediately.** Add `attachments: [NativeChatAttachment]` to `RetryContext` and set it on the transient user row, built from the `NativeUploadedAttachment`s. `ChatComposer` then calls `mediaLoader.seed(localBytes, for: id)` for images right after upload.

### 4.2 Loader: new `JunoChatKit/NativeChatMediaLoader.swift`
`@MainActor @Observable` and conforming to `TranscriptMediaProviding`.

- `imageState(id)` and `loadImage(_:)`: wraps the existing `NativeChatImageLoader` (`GET /api/attachments/{id}`, images only, 60-entry LRU).
- `fileURL(for:) async throws -> URL`:
  - Path: `attachment.url`, falling back to `accessFile`.
  - Request: `GET /api/files/<key>` with the bearer token and an `accept: */*` header via `NativeBearerRequest(path:headers:)`.
  - Writes to `~/Library/Caches/<bundle id>/TranscriptFiles/<account>/<attachmentID>/<sanitised fileName>`.
  - Limit 51MB (`HTTPValidation.swift:24-25`). Larger files return `.tooLarge`.
  - Purged on sign-out.
- `preview(for:)`:
  - `GET /api/attachments/{id}/preview` returns `{text, previewable, thumbnailUrl, truncated}`.
  - When `thumbnailUrl` is present, fetch `GET /api/attachments/{id}/thumbnail` (a 640-wide JPEG).
  - Cached per id in memory.
- `quickLookThumbnail(for:)`: for Office and iWork files with no server thumbnail and size at most 25MB (`NativeFilePreviewLoader.documentByteLimit`), download the file and run `QLThumbnailGenerator` (`.thumbnail`, 288×192 @2x). The web shows a text excerpt here, so this goes further than the web.
- `seed(_:for:)`.

In the app, create the loader once per session in `DesktopChatWorkspace`: `@State var mediaLoader`, keyed with `.id(session.profile.id)`. Inject it with `.environment(mediaLoader)`.

### 4.3 Views: new `App/TranscriptAttachments.swift`

**`UserAttachmentStrip`**
- A custom trailing `FlowLayout`, 8pt spacing, 8pt above the bubble.
- If `content` is empty, render **no bubble**.

**`SentImageTile`**
- **Size:** height 144; width `clamp(144 × aspect, 72…288)`. The aspect comes from the metadata or the decoded image; when unknown, the tile is 144 wide. The picture is `.scaledToFill` and clipped.
- **Frame:** `RoundedRectangle(16, .continuous)` filled with `junoSecondary`, with a 1pt `junoBorder` at 70%.
- **Hover:** border to `junoForeground` at 25%, plus a shadow (ink 4%, radius 1, y 1), over 120ms. The image scales to 1.015 over 220ms on out-soft; skipped under Reduce Motion.
- **Failed:** `ph.imagebroken` at 20pt and 70% opacity, centred.
- **Click or Space:** Quick Look.

**`FileTile`** (144×144, radius 16, `junoCard`, 1pt `junoBorder` at 70%)
- **Well:** the top 96pt, filled with `junoSecondary`.
- **Page:** inset 14pt left and right and 12pt from the top, flush with the caption band. Top corners radius 6, 1pt border at 70% with no bottom edge, `junoCard` fill, shadow `0 1 2` ink 4% (dark: black 25%). On hover it moves up 2pt over 220ms.
- **Page content**, first available of:
  1. The thumbnail, `.scaledToFill` and top-aligned.
  2. A text excerpt: SF Mono 10.5pt, line height 1.55, `junoForeground` at 60%, padding 10pt on three sides, masked with a black-to-clear gradient starting at 45%.
  3. The uppercased extension, centred, SF Mono 11pt medium, `junoSecondaryInk`.
- **Caption band:** 48pt tall, 1pt top border at 60%, `junoCard`, 12pt horizontal padding.
  - Line 1: the name without its extension, 11pt medium, truncated.
  - Line 2: 10.5pt mono secondary, e.g. "Excel workbook · 88 KB".
- **Hover:** border to foreground at 25% plus the raised shadow.
- **Click or Space:** Quick Look.
- **Context menu:** Quick Look · Open With Default App · Save As… (`NSSavePanel`).

**Quick Look is hoisted.** It is `.quickLookPreview($previewURL, in: previewURLs)` on `DesktopConversationView`, reached through an `openFile(_:)` closure. It cannot live in a lazy row, for the same reason as `DesktopChatWorkspace.swift:824-831`.

**`GeneratedImageView`**
- **Order in `assistantTurn`:** the placeholder when `mediaProgress != nil && errorDescription == nil`; otherwise file tiles (non-video FILE attachments), then a media flow (8pt spacing, 4pt below), then the text and artifact parts.
- **Frame:**
  - Width `min(measure, 320)`, square, image `.scaledToFit` so non-square images are letterboxed on `junoMuted`.
  - Radius 12 continuous; 1pt `junoBorder` at 60%, going to 100% on hover over 120ms; no shadow.
- **Loading overlay:** `ph.image` at 20pt and 70% opacity, plus "Preparing image" in 11pt mono secondary, 6pt apart.
- **Reveal:** decode off the main thread with `CGImageSource`. The overlay fades out over 220ms; the pixels fade in over 360ms on `timingCurve(0.33, 1, 0.68, 1)`.
- **Failed:** `ph.imagebroken` with "Preview unavailable · open original"; a click opens it in Quick Look.
- **Hover cluster**, top-right, inset 8pt, 6pt apart, fading from 0 to 1 over 120ms on hover or focus:
  - **"Edit" pill:** 28pt tall capsule, 10pt horizontal padding, 11pt mono at foreground 85%, `ph.pencilsimple` at 14pt with a 6pt gap. Fill `junoCard` at 90%, 1pt `junoBorder` at 60%, shadow `0 1 2` ink 4%, press 0.97. Shown only when not private, not generating and an image model is available.
  - **Download:** 28pt circle, same surface, `ph.downloadsimple`, `NSSavePanel`.
  - **Expand:** `ph.arrowsoutsimple`, help "Quick Look".
- **Click on the image:** Quick Look. The web opens a new tab; the Mac adds Download and Expand. Both are deliberate differences.
- **Drag out:** file URL.
- **Edit presentation** is hoisted: `.sheet(item: $imageEditTarget)` on `DesktopConversationView`, presenting `NativeImageEditSheet(attachmentID:fileName:accountID:attachments:client:models:openConversation:close:)` (`NativeImageEditSheet.swift:27-45`) as `DesktopLibraryScreen.swift:766` does. The result streams back through `/api/generate`.

**`GeneratedVideoCard`**
- Width at most 480, radius 12, 1pt border at 60%, `junoCard`.
- **Stage:** 16:9 on `junoMuted`. "Preparing video" (`ph.videocamera` at 20pt plus 11pt mono) shows until `AVPlayerItem.status == .readyToPlay`. Then AVKit `VideoPlayer` fades in over 360ms. On failure: "Video preview unavailable".
- **Footer:** 52pt tall, 1pt top border at 60%, 14pt horizontal padding.
  - Leading: `ph.videocamera` 14pt, "Video" in 11pt mono at foreground 75%, "·", then the status in 11pt: Preparing, Ready or Preview unavailable.
  - Trailing "Open" pill: 28pt capsule, `junoSecondary`, 1pt border at 60%, 10pt horizontal padding, 11pt mono, `ph.arrowsquareout` 14pt. Hover `junoHover` with a full border. Opens the file with `NSWorkspace.shared.open`.
- **Source:** `fileURL`, limited to 51MB. Follow-up: an `AVAssetResourceLoaderDelegate` using Range requests, which `/api/files` already supports with 206 responses.

**Placeholder fixes** in `JunoChatKit/NativeMediaGenerationView.swift` (shared with iOS):
- Clip the canvas to radius 12 continuous.
- Label at 15pt (was 14).
- A second line in muted 15pt that fades in over 220ms after 20s for images or 15s for video: "Still working. Detailed images can take a minute." / "Longer clips can take a couple of minutes."
- `AccessibilityNotification.Announcement` on each stage change.
- The video play plate: a 48pt circle in `junoCard` with a 1pt `junoBorder`.

### 4.4 Acceptance
- **Fixture msg-7:** the photo shows as a 216×144 tile above the bubble. **msg-8:** the image shows as a 320 square with [👍][👎][More] (when its text is removed) and no caption.
- **A live `/api/generate` reply:** placeholder, then the image on `done`, with no gap and no empty turn.
- **Tiles:** PDF tiles show page 1; xlsx and pptx tiles show a Quick Look thumbnail, falling back to the excerpt, then the extension.
- **Actions:** Space opens Quick Look. Download writes the file. Edit opens the sheet.
- **Unit tests:** `formatLabel` and `byteLabel` parity tables; `persistableData` keeps `/api/files/…` and drops signed `https://…?sig`; `decodeAttachment` reads `url`; the loader remembers a failure and does not retry it.
- **Snapshots:** `user-image-pdf`, `generated-image*`, `media-placeholder*`, `file-card-*`.

---

## 5. Stage 3 (P-C): artifacts, canvas and design inline

### 5.1 Data
- **Streamed artifacts.** Decode `done.artifacts` (`ClientArtifact`: id, identifier, type, title, language, currentVersion, content, versions[{version, content, origin, createdAt}], messageId, createdAt, updatedAt; `src/types/chat.ts:266-285`) into `NativeStreamedArtifact`. `NativeArtifactModel.merge(streamed:)` then gives the card a stored row before sync arrives.
- **Resolver.** `ChatArtifactResolver`, keyed by `(conversationID, identifier)`, returns a `NativeArtifact?` from `NativeArtifactModel.artifacts` (`NativeArtifactStore.swift:202`). Pass `configuration.artifactModel` (`JunoDesktopConfiguration.swift:48`) through the environment.
- **Card inputs**, as in `message-item.tsx:1360-1377`:
  - content: `stored?.currentContent ?? part.content`
  - kind: `stored?.kind ?? part.kind ?? .code`
  - `v{currentVersion}`
  - updated: `stored.messageID != nil && stored.messageID != message.id`
  - streaming: `part.streaming && message.isPending`

### 5.2 Runtime matching the web's sandbox
- **Document builder.** New `JunoChatKit/NativeArtifactRuntimeDocument.swift` ports `buildSandboxDoc` (`sandbox-frame.tsx`), using the same builders and the same CDN URLs as the web (`sandbox-frame.tsx:7-12`):
  - Tailwind: `https://cdn.tailwindcss.com`
  - React and ReactDOM: 18.3.1 **development** UMD from unpkg
  - `@babel/standalone`
  - Pyodide 0.26.4 from jsdelivr
  - Mermaid: served locally as `juno-runtime://mermaid.min.js`
- **Shims.** Inject `SANDBOX_SHIM`, `STATUS_LITE`, `CONSOLE_BRIDGE` and `LINK_BRIDGE`, with `parent.postMessage` replaced by `window.webkit.messageHandlers.juno.postMessage`. They go in as a `WKUserScript` at document start, main frame only.
- **CSP.** The web's string verbatim (`sandbox-frame.tsx:51-71`), with `juno-runtime:` added to `script-src`.
- **Policy.** New `NativeArtifactPreviewPolicy.inline`. `.inline` and `.document` use the runtime builder. **`.thumbnail` is unchanged**: inert, JavaScript off and network blocked, so the library tiles in `DesktopArtifactsScreen.swift:551-600` stay safe.
- **WKWebView setup** (`NativeArtifactPreview.swift` `makeWebView`, :346-372):
  - `websiteDataStore = .nonPersistent()`, the counterpart of the web's opaque origin.
  - `allowsContentJavaScript = true`.
  - `setURLSchemeHandler(ArtifactRuntimeSchemeHandler(root: Bundle.main/ArtifactRuntime), forURLScheme: "juno-runtime")`.
  - Rule list for runtime policies: allow `https`, `http`, `data`, `blob` and `juno-runtime`; block every other scheme, including `file:`.
  - Load with `loadHTMLString(doc, baseURL: nil)`.
  - Navigation delegate: allow only the initial load. Cancel link navigations and open http(s) URLs with `NSWorkspace.shared.open`.
  - `createWebView` returns nil (no popups).
  - Alerts become an `NSAlert` sheet (the web allows modals).
  - Downloads go through `WKDownloadDelegate` and `NSSavePanel`.
- **Bridge model.** `ArtifactRuntimeModel` (`@Observable`): status (loading, running, done, error), console entries (capped at 150, keeping the last 120; each entry at most 2,000 characters), and an error count.
- **Security trade-off, needs sign-off.** This relaxes the Mac's deny-all network to match the web. Vendoring React, Babel and Tailwind behind `juno-runtime://` with a sha256 manifest is an optional offline hardening step.

### 5.3 `App/InlineArtifactCard.swift` (rewrite)
- **Container:** full width, 20pt vertical margin, radius 16, `junoCard`, 1pt `junoBorder` at 60% going to 100% on hover over 120ms. Rises in over 220ms from a 6pt offset.
- **Header:** 14pt horizontal and 10pt vertical padding. It is a row when the card is at least 384pt wide; otherwise it stacks with 10pt between parts.
  - **Identity:** a button whose hover is `junoHover` at 40%, radius 12, with a −6pt margin and 6pt padding.
  - **Icon tile:** 32×32, radius 12, 1pt border at 60%, `junoSecondary`. The glyph is 16pt `junoSecondaryInk`, and stays muted while streaming (§0.4).
  - **Glyphs by kind:** HTML `ph.globesimple`, REACT `ph.code`, CODE `ph.filecode`, SVG `ph.image`, MARKDOWN `ph.filetext`, MERMAID `ph.gitbranch`, DESIGN `juno.design`.
  - **Title:** 13pt medium, 20pt line, truncated, fallback "Untitled artifact".
  - **Meta:** 10.5pt mono secondary, 2pt top padding, 6pt gaps, 4pt `junoBorder` dots between parts. Parts: the runtime label (React, HTML, SVG, Diagram, Markdown, Design, or the language), `v{n}` (only when n > 1 and not streaming), "Updated" (foreground at 60%), and the status:
    - "Writing": `junoAccentInk` with a pulsing 6pt dot.
    - "Loading" or "Running": `junoSource` with a pulsing dot.
    - "Live" (web runtime) or "Done" (console): `junoSuccessInk`.
    - "Error": `junoDestructiveInk`.
- **Switch:** Preview (called "Output" for console runtimes) / Code / Console `n`.
  - Track `junoCanvas`, 1pt border at 80%, radius 14, 4pt padding.
  - Thumb `junoCard`, radius 10, shadow `0 1 2` 4%.
  - Options 24pt tall, 10pt horizontal padding, 11pt.
  - Console shows only once it has entries, with a 16pt `junoMuted` count capsule.
  - Hidden while streaming or when there is only one option.
- **Then**, at card widths of at least 384: a 1×16pt `junoBorder` hairline at 70%, and **"Open"**: 28pt tall, radius 10, 10pt horizontal padding, 11pt medium muted, `ph.sidebarsimple.mirrored` 14pt, hover `junoHover` with foreground ink, help "Open in canvas".
- **Divider:** 1pt `junoBorder` at 60%. While streaming, a band one third wide (clear → `junoAccent` → clear) sweeps across from −100% to 300% over 1.8s, linear, repeating. Static under Reduce Motion.
- **Body:** height `clamp(0.44 × viewportHeight, 240…360)`. Pass `viewportHeight` from `DesktopConversationView.columnHeight` (835) through `@Entry`. Switching views cross-fades over 220ms. Views:
  - **Preview:** an 8pt `junoCanvas` mat holding a radius-8 white sheet with a 1pt inset `junoBorder` at 70%, containing the `.inline` web view. Console runtimes use a `#0B0B0E` ground.
  - **Markdown:** `JunoMarkdownText` with 20pt padding, directly on the card.
  - **Code:** `ArtifactCodeSurface`: `junoMuted`, 10.5pt mono on a 20pt line. Gutter with 8pt horizontal and 12pt vertical padding and a right border at `junoBorder` 40%. Code area padded 12pt, 32pt on the right. Wraps only for Markdown. While streaming, scrolls to follow when within 48pt of the bottom. Stage 4 adds highlighting.
  - **Console:** header with 12pt horizontal and 8pt vertical padding, bottom border, `ph.terminalwindow` 14pt and "Console" in 10.5pt mono. Body padded 12pt, last 80 entries. Colours: error `junoDestructiveInk`, warn `junoWarningInk`, info `junoSource`.
- **States:**
  - Streaming with content: Code view forced.
  - Streaming with no content: at least 180pt, centred `JunoThinkingMatrix`, "Writing artifact" at 18pt semibold, "The source will stream in here." at 13pt muted.
  - Settled with empty content: an error well at least 140pt tall reading "Source unavailable".
  - After the stream ends: Preview.
- **Open → dock.**
  - `DesktopChatArtifact` (`DesktopArtifactCanvas.swift:42-58`) gains `stored: NativeArtifact?`, and `resolvedContent` prefers the stored row.
  - Designs open with `DesktopDesignSurface(content: stored.currentContent, readOnly: stored == nil, onEdit: { artifactModel.saveArtifact(id:content:) })`, replacing :817. This fixes "not a Juno Design document", because stored rows are the expanded form (`lib/artifacts-store.ts:16-25`).
  - The dock header shows `v{n}`. The canvas never opens by itself.

### 5.4 Design outputs inline: new `App/InlineDesignPreview.swift`
- **Fetch:** when a stored id exists, `GET /api/design/{id}/export?format=svg` with the bearer token and `accept: image/svg+xml`.
- **Cache:** in memory and at `Caches/DesignPreviews/{id}-v{n}.svg`.
- **Render:** `NativeArtifactPreview(kind: .svg, content: svg, mode: .preview, policy: .thumbnail)` on the same mat and sheet as §5.3.
- **Tabs:** Preview | Code (the JSON). Meta label "Design". Status "Loading", then "Done" or "Error".
- **Errors:** a 422 (`MISSING_ASSET`) or 500 shows the `juno.design` glyph at 20pt, "Preview unavailable" and Open.
- **Before a stored row exists, or while streaming:** Code view of the tag body.
- Record in §0.8 that the web shows JSON here.

### 5.5 Mermaid, juno-visual and charts
- **Mermaid:** add `native/macOS/JunoDesktop/Resources/ArtifactRuntime/` as a folder reference in `project.yml`, like `DesignEditor`, containing `mermaid.min.js` 11.x plus a LICENSE. In `JunoDesktopApp.init`, call `JunoMermaidEngine.register(script:)` (`MermaidDiagramView.swift:32-44`).
- **Mermaid figure:** radius 16, 1pt border at 70%, `junoCard`. Header with 12pt horizontal and 8pt vertical padding: "Diagram · Mermaid" plus Copy. Body 288pt, with a skeleton until it loads. Dark mode prepends `%%{init:{"theme":"dark"}}%%`. While streaming, show the code block plus "Diagram renders when complete…".
- **`juno-visual`:** new `JunoDesignSystem/JunoVisualBlock.swift`, a parser and view, hooked into the `.code` branch of `JunoMarkdownView.swift:96-114`.
  - Fence names: `juno-visual`, `juno-ui`, `juno-block`, `visual`, `visual-block`.
  - Section: radius 16, `junoCard`, border.
  - Header: 16pt horizontal and 12pt vertical padding, bottom border. A 36pt radius-12 `junoSecondary` tile, a 10.5pt mono type chip (radius 6, `junoMuted`), "N parts", the title at 18pt semibold and the subtitle at 13pt.
  - Type mapping:

    | Web type | Mac view |
    |---|---|
    | steps | `JunoStepLabView` |
    | timeline | processTimeline |
    | comparison, table | comparison (minimum 544pt wide, scrolls horizontally) |
    | quiz | quiz |
    | callout | learningCard |
    | cards | new two-column grid at 576pt and up; items at least 80pt, radius 12, padding 12; the active item uses `junoSelected` plus a border, not coral |
    | flow, flowchart, diagram | new node grid (128pt minimum columns) with `ph.arrowright` between nodes and edge chips |

  - Streaming or failure: a radius-12 notice reading "Drawing inline visual..." or "This inline visual could not be rendered."
- **Charts:** already handled by `InlineChartRenderer`; they only need the Stage 4 token pass.

### 5.6 Acceptance
- **HTML artifacts:** a Tailwind-styled one renders styled inline, with a body 240–360pt tall and status Loading → Live.
- **React:** a TSX artifact renders. A thrown error shows the red `<pre>`, status "Error" and "Console 1".
- **Streaming:** shows Writing with the sweep and the Code view, then Preview once done.
- **Links:** a link in a preview opens the browser. The card never navigates, and `window.open` does nothing.
- **Design:** msg-6 shows a drawn design. Open gives an editable dock. Save calls `POST /api/artifacts/{id}` with `baseVersion` and produces v2.
- **Library tiles are unchanged:** a test asserts that `.thumbnail` documents keep `script-src 'none'`.
- **Unit tests:** builders (import stripping, `export default` → `window.__Component`, CSP equal to the web's string); bridge message caps; resolver precedence (stored row over tag).
- **Snapshots:** `artifact-html*`, `design-output`, a Mermaid figure and `juno-visual` cards.

---

## 6. Stage 4 (P-D): the rest of §6

### 6.1 Prose (`JunoMarkdownView.swift`, `JunoLessonText.swift`), using the live web values
- **Body:** 16pt, `.lineHeight(.multiple(1.7))`, block gap 0.85em (13.6pt). Paragraph maximum width is 75ch, computed from the advance of "0" in 16pt SF.
- **Headings:** Markdown headings are demoted one level, as on the web. `#` is 24pt, `##` is 20.8pt, `###` is 17.92pt. All semibold, line height 1.3, 1.3em above.
- **Lists:** indent 1.4em, 0.2em between items.
- **Blockquote:** a 3pt `junoBorder` bar, 1em padding, `junoSecondaryInk`.
- **Inline code:** SF Mono at 0.875em on `junoMuted`, radius 6, padding 0.15em × 0.4em.
- **Links:** `junoAccentInk`, underlined with a 2pt offset.
- **Rule:** 1pt `junoBorder`.
- **Streaming:** delete `JunoStreamingCursor` (168–191, used at 206). Past 140 characters, mask the last block with a vertical gradient that fades to 30%.

### 6.2 Code and tables
**Code block:** rewrite `JunoAIcssCode.swift:15-87` per §6.5.
- `junoCard`, 1pt border, radius 12.
- **Header:** 32pt tall, the language in 11pt mono secondary, and a borderless Copy that cross-fades from `ph.copy` to `ph.check` as in §3.2.
- **Body:** one `Text` per block, SF Mono 13pt on an exact 20pt line, `.textSelection`, padding 12 × 14, no wrapping, scrolls horizontally, capped at 520pt with internal scrolling.
- **Gutter:** 8 lines or more only, 12pt mono in `junoSecondaryInk`. The errata limits tertiary ink to text of 13pt and up.
- **Syntax highlighting:** new `JunoSyntaxHighlighter.swift`. Keywords `junoAccentInk`, strings `junoCodeString`, numbers `junoCodeNumber`, comments `junoSecondaryInk` in italic.

**Table:** in `JunoMarkdownTable` (284+), a `Grid` in a radius-12 card.
- Header row on `junoSecondary`, 13pt medium, with a bottom rule of foreground at 28%.
- Body 13pt, cell padding 10 × 8, `junoBorder` rules between rows.
- Scrolls horizontally when wider than the measure.

### 6.3 Activity row and Thought panel
**Data:**
- `NativeChatMessage` gains `activity: [NativeChatActivity]` and `reasoningParts: [String]?`.
- `recordActivity` writes into the pending assistant row, replacing the conversation-wide `researchActivity` (`NativeConversationStore.swift:953, 977-981`). `researchDegradedWarning` is computed from the row.
- Decode activity kind `"artifact"`, including `artifactVerification`.

**`App/ActivityRow.swift`:**
- **Live row:**
  - A 12pt `JunoThinkingMatrix` in neutral ink.
  - A 13pt secondary sentence from the copy ladder: "Writing the response" / "Checking your request" / "Starting your request". From 120s: "Still thinking — working in the background". From 600s: "Still thinking deeply — safe to leave; the answer will be here when you return". While recovering: "Reconnecting — the answer is still being written".
  - "· " followed by `Text(timerInterval:)` in 12pt mono secondary.
  - `.updatesFrequently` on the sentence only.
- **Reasoning preview:** 13pt at line height 1.55, secondary ink, capped at 180pt with a top fade.
- **Settled row:** a plain `Button`, "Thought process · 4 searches · 9 sources · 8.4s", plus `ph.caretright.bold` 10pt, in 13pt secondary that turns primary on hover.
- **Replaces:** `JunoAIcssReasoningStream` (2152–2160), the "Thinking about your request" row (2164–2172) and the `DesktopResearchActivity` GroupBox (2579–2603).

**Dock and panel:**
- `App/TrailingDock.swift` generalises `DesktopArtifactDock` (`DesktopArtifactCanvas.swift:301-520`). It holds either an artifact or a thought panel, never both. It keeps the existing width model: 46% default, 420pt minimum, 320pt kept for the transcript, 82% maximum, side-by-side from 900pt.
- `App/ThoughtPanel.swift`, per §6.6:
  - A 40pt header with the state word, a Filter menu, a Copy menu and Close.
  - A find field showing n/m, with ⌘G.
  - Elapsed / Cost / Sources figures.
  - The step list; j and k move between steps.

### 6.4 Sources, citations and thread hydration
- **Hydration.** New `JunoChatKit/NativeThreadClient.swift` calls `GET /api/conversations/{id}`, which returns `{conversation, messages: ClientMessage[], artifacts: ClientArtifact[]}` (`lib/queries.ts` `getConversationThread`).
  - Overlay each message with sources (including `cited`), activity, reasoningParts, attachment URLs and version metadata.
  - Merge the artifacts into the artifact model.
  - Run it when a conversation opens and, debounced, after each `done`.
  - This fixes sources vanishing after a reload, with no change to the sync entities.
- **Pill** (`App/SourcesPill.swift`, per §6.7):
  - A 32pt capsule, `junoCard`, 1pt `junoBorder`.
  - Up to four 18pt favicons, overlapping by −6pt, each with a 1.5pt ring. A letter stands in when no favicon loads.
  - "Sources" at 12pt medium, the count in 12pt mono, `ph.caretdown.bold` 10pt.
  - It expands in place on `JunoMotion.standard` into 36pt rows.
  - Delete the `DisclosureGroup` card (2517–2564).
- **Inline `[n]`.** Only when `cited == true`. Add `cited` to `SourceWire` and `NativeChatSource`. Rewrite `[n]` to `juno-cite://n` links and handle them with `OpenURLAction`. Each renders as an 18pt capsule with a 14pt favicon; clicking opens a 320×140 popover.

### 6.5 Finish notes and errors (`App/FinishNote.swift`)
**Note row:**
- Radius 12, 1pt `junoBorder` at 70%, `junoMuted` fill, padding 14 × 10, 13pt secondary.
- Glyph: `ph.info` at 16pt, or `ph.warningcircle` for a partial answer that failed.
- Copy, verbatim from `message-item.tsx:1207-1218`:

  | Finish reason | Text |
  |---|---|
  | `length` | "The model stopped at its token limit." |
  | `network_error` | "The stream was interrupted. The partial answer was preserved." |
  | `user_stopped` | "Stopped by user." |
  | `tool_calls` | "The model requested tools, but no tool flow is enabled for this request." |
  | `sensitive` | "The provider stopped the response for safety reasons." |

- **Continue:** `.bordered` small, 28pt, `ph.arrowelbowdownright` at 14pt. Shown when the turn is newest, nothing is generating and the reason is `length` or `network_error`.

**Error box:**
- Radius 12, 1pt `junoDestructive` at 40%, fill at 5% (light) or 14% (dark), 13pt `junoDestructiveInk`, `ph.warningcircle` 16pt aligned to the top line.
- "Try again": `.bordered` small, destructive-tinted, `ph.arrowclockwise` 14pt, only on the newest turn when idle.

**Moves and deletions:**
- The error box renders inside the turn, under the answer and above Sources.
- Delete both GroupBoxes (2590, 2611) and the transcript-level error rows (1514–1516, 1600–1617).
- The store's error moves onto the newest assistant row. Action errors become toasts.

### 6.6 Follow-ups
- Move them out of the `LazyVStack` (1588–1598) into the `ChatComposerDock` above-slot (§5.6).
- Up to three opaque `JunoChipStyle` capsules, 13pt, truncating at 320pt, wrapping with 8pt spacing, left-aligned to the measure.
- **A click sends immediately**, through a new `ChatComposerRequest.Kind.send(String)`.
- Shown only when idle and the draft is empty.

### 6.7 Scrolling
- Replace the `ScrollViewReader` and its `scrollTo` calls (1631–1672) with `.scrollPosition($position)`, `.defaultScrollAnchor(.bottom)`, `.contentMargins(.top, 24)` and `.scrollEdgeEffectStyle(.soft, for: [.top, .bottom])`.
- Track `atBottom` with `onScrollGeometryChange`, using a 24pt tolerance. Follow the stream only while at the bottom.
- **`App/ScrollToLatestButton.swift`:** a 32pt `.glass` circle with `ph.arrowdown`, centred 12pt above the composer, using `.glassEffectTransition(.materialize)`. When hidden it is `.accessibilityHidden` and removed from the tab order. Add it to the glass gate's allow-list.
- On the edge from streaming to done, announce "Response complete, N words."

### 6.8 Find (⌘F): `App/FindBar.swift`, per §6.14
- A glass capsule at most 480pt wide in the top `safeAreaBar`: `ph.magnifyingglass`, the field, "3 of 12" in 12pt mono, `ph.caretup` and `ph.caretdown`, and Done.
- Matches get a background run of foreground at 10%; the current match gets 22%. The highlight reaches the text through `@Entry var junoFindHighlight`, read by `JunoInlineText`.
- ⌘G and ⇧⌘G step through matches; Esc closes.

### 6.9 Resuming a stream
- On conversation open and when reachability returns, call `GET /api/chat/stream/active?conversationId=…`. It returns `{generationId}` or a 404.
- Then call `GET /api/chat/stream/{generationId}?after={lastSeq}`. The SSE `id:` lines carry the sequence number; extend the parser at `NativeChatAPIClient.swift:1740` to track them.
- Feed the results into `ChatStreamReducer`.
- `resume{available:false}` stops and shows the "Reconnecting" rung; `resume{refetch:true}` runs hydration.

### 6.10 Approvals
- Move `NativeChatApprovalCard` (1523–1538) into the newest assistant turn, above its answer.
- Restyle `NativeChatApprovalView.swift:83-130` per §6.9:
  - Remove `.junoProminentAction()` (:92).
  - Radius 16, with the hairline in the risk tone.
  - Buttons: "Don't allow" · "Allow once" · "Allow this action for this connector".
  - Nothing bound to `.defaultAction`.

### 6.11 Acceptance
- No `GroupBox` remains in the transcript files.
- Sources survive a relaunch.
- Scrolling up during a stream stops auto-follow and shows Scroll to latest.
- ⌘F highlights matches and ⌘G steps through them.
- Killing the network mid-stream and then restoring it resumes from `after=seq`.
- **Snapshots:** `code-block`, `table`, `sources-pill`, `error-note`, `finish-note`, `activity-*`, `follow-ups`, `find-highlight`.

---

## 7. Docs to update as the stages land
- **`docs/native/MACOS_LIQUID_GLASS_REDESIGN.md`:** add errata for §6.2, §6.4, §6.8, §6.10 (the pager is 24pt; the web is 32 against the Mac's 28) and §6.11, per §0 above.
- **§0.8 register additions:**
  - Designs are drawn inline on the Mac; the web shows JSON.
  - The Mac adds Download and Expand on images, and clicks open Quick Look instead of a new tab.
  - The More menu's info item is greyed by the system.
  - System checkmarks instead of the web's coral check.
  - `.help()` tooltip timing.
  - The artifact sandbox now allows network, matching the web.
---

## Addendum (2026-09-23): the web's new thinking, tool-call and research design, for Stage 4

The Tool calls & research audit session (worktree `/Users/liammagnier/Developer/project/juno-tools`, branch `web/tools-thinking-research`, not merged yet) has decided how the web will show thinking, tool calls and research. Its decisions are in `docs/chat-rework/DECISIONS.md` in that worktree: §1 T6 covers the data and §2 the UI. `docs/chat-rework/SPEC.md` will hold the exact visual spec once it is final. Read both **read-only** before Stage 4. Where they conflict with §6.3–§6.4 of this brief or with spec §6.6–§6.7, **they win**, because the Mac must match what the web is about to ship.

1. **Inline first.** One run block sits above the answer from send until done.
   - **While live:** a status line (glyph, shimmer on the label only, elapsed time), with live tool rows. Each row shows its own state: running, succeeded, failed, or awaiting approval.
   - **When the answer starts:** the block folds, without the layout jumping, into one summary line such as "Thought for 12s · 5 sources · ran code ›". One click expands the full chronological timeline inline.
2. **ThinkingDots goes away.** The 3×3 dot matrix is replaced by one signature: a single 2 s loop in muted ink that animates only transform and opacity. Only the label shimmers.
   - If SPEC.md is final when Stage 4 runs, build exactly that.
   - If it isn't, build a minimal version of this description behind a single `JunoRunSignature` view so it can be swapped later.
   - Never add violet, glow or a matrix.
3. **The right panel becomes "Activity"**, the TrailingDock's non-canvas panel. It has three parts:
   - **Timeline:** reasoning interleaved with tool rows, in their real order.
   - **Sources:** Cited, then Also read.
   - **Details:** model, effort, context and memory used.
   - Cost as a headline figure, the filters, and the Research/Think/Write ledger are all removed.
4. **Wire changes.** All of them are additive; old fields stay so shipped builds keep working.
   - Activity events gain a server `seq`, and reasoning parts and tool calls gain a `round`.
   - A tool call becomes a typed record updated in place, with:
     - a status enum: queued, awaiting_approval, running, succeeded, failed, denied, expired, cancelled
     - a human title and figure
     - a persisted approval
   - Text written before a tool call becomes timeline "commentary" rather than being joined onto the answer.
   - Decode these fields when present and fall back to today's fields when absent.
5. **Research has no levels any more.**
   - Quick, Standard, Deep and Max are removed; the feature is just "Research". Remove the depth second line from the composer's `+` menu row, rename the row "Research", and stop showing depth in marks.
   - Live progress moves to a "Research" view in the right panel, and the transcript keeps a one-line row.
   - The server will ignore `researchEffort`, so sending it is harmless, but don't surface it.

The tools session will message this session when SPEC.md is final and before any merge or deploy.
