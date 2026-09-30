# AI chat UI on iOS: reference study for the Juno Refoundation

Written 2026-09-30 for the iPhone part of the Refoundation (PRODUCT_REFOUNDATION §4.3, §5, §6, §7, §9, §10). It answers one question: **what does premium look like on iOS today, moment by moment, and what is slop?** The owner's rules apply throughout: no status pills, badges or decorative dots; native Liquid Glass on Apple platforms; nothing consequential without deterministic approval.

## How this was researched, and its limits

- **Mobbin was not available.** `search_screens` and `search_flows` both returned "Mobbin MCP requires a paid plan" on 2026-09-30, in deep and standard mode. This document therefore has **no `mobbin_url` citations**. If the plan is upgraded, rerun the moment queries in §3 and add them to this board.
- **What was used instead (all first-party):**
  1. The current App Store screenshot sets for 11 apps, pulled from the public iTunes lookup API at 1290×2796. Each app's version and release date as of 2026-09-30 is listed in §8.
  2. Apple Newsroom images and text for iOS 26 (2025-06-09) and iOS 27 (2026-06-08 and 2026-09-14). These include the new Siri app, which is Apple's own AI chat app.
  3. Apple's Human Interface Guidelines (HIG), read from its JSON source on 2026-09-30: Materials, Tab bars, Sheets, Playing haptics, Generative AI and Toolbars.
  4. Press and secondary sources, which are marked **[secondary]** where cited. Claims that could not be confirmed are marked **UNVERIFIED**.
- **Caveats on the screenshots.** App Store screenshots are staged marketing frames. They show which states each company chose to show off, not every state the app has.
  - Perplexity's set is older (iPhone 14-era chrome, pre-Liquid Glass), so treat it as an information-architecture reference, not a visual one.
  - Things 3's set shows iOS 16–18 chrome.
  - Static images show no motion and no haptics. Anything said here about either is labelled "implied" or cites a source.
- **The reference board** is 34 high-resolution images in `/private/tmp/claude-501/-Users-liammagnier-Developer-project-juno/9a242067-f03a-4200-acec-6b9eafa8d677/scratchpad/refs/ios/`.
  - Files are named `NN-moment_app_what-it-shows.jpg`, and `_index.jpg` is a contact sheet of all of them.
  - That folder is session scratch space. Copy it somewhere durable if the board should outlive this session.
  - The source URL for every file is in §7.

---

## 1. The twelve lessons

1. **On iOS in 2026, "premium" means using system components and staying out of their way.** The HIG's rule is exact: Liquid Glass "forms a distinct functional layer for controls and navigation" and "Don't use Liquid Glass in the content layer". The best AI apps now look alike at the chrome level:
   - ChatGPT, Gemini, Copilot, Meta AI and Mistral Vibe all use the same pieces: a glass circle for the menu, grouped glass buttons at the top right, and a floating capsule composer.
   - They differ in the content layer: typography, answer layout, and how work and results are shown.
   - Juno should compete there, not by inventing chrome.
2. **The composer has settled into one shape.** From left to right: a `+` (a separate glass circle in Apple's Messages and Siri; inside the capsule for ChatGPT, Gemini, Copilot and Meta AI), a placeholder, a dictate mic, and one filled trailing button that is voice at rest and send once there is text. This matches Juno §5 exactly (`+`, model control, dictate, send/voice). Juno does not need to invent anything here. It needs to finish it.
3. **Voice has moved into the thread.** Since 2025-11-25, ChatGPT runs voice inside the conversation instead of on a separate screen, with "Separate mode" kept as a setting ([TechCrunch 2025-11-25](https://techcrunch.com/2025/11/25/chatgpts-voice-mode-is-no-longer-a-separate-interface/); [OpenAI on X](https://x.com/OpenAI/status/1993381101369458763)).
   - A full-screen mode survives only where the camera is involved: Gemini Live, Siri's Camera mode, Copilot's vision.
   - Juno §9 ("quiet at rest") should default to inline voice and keep full screen for camera and screen sharing.
4. **Mode and model belong in a small anchored menu, not a navigation split.**
   - Copilot's menu offers Auto / Quick response / Thinks deeper, then providers. Meta AI's offers Instant / Thinking, each with a one-line description and a checkmark.
   - Both are native floating menus of two to six rows with a line of explanation under each. This is Juno §6.
   - Grok's top segmented control (Ask · Imagine · Build) is the counter-example. It splits one conversation into three products.
5. **The best work trace is a short list of past-tense verbs that collapses.** Mistral Vibe shows "Working · Loading skills", then "Ran 2 web searches", "Thought for 3s" and "Loading skill pipeline-analysis.md". Copilot Cowork shows "Working on it", then "Searching email", "Reviewing Teams chats" and "Creating Email Draft".
   - Each row is an icon and a sentence, set in secondary grey, and the list collapses once the result arrives.
   - The HIG's generative-AI page says the same: "instead of 'Processing…', say 'Finding substitutions for ingredients'".
6. **Deterministic approval on iOS is a sheet.** Copilot Cowork turns its finished draft into a "Send Email" sheet with:
   - recipients as removable tokens, the subject and the body;
   - **Cancel** and **Send** as two equal-width capsules, with Send filled.
   This is the most premium approval pattern in the set, and the right model for Juno's always-confirm floor. Claude's inline full-width "Approve" button on a task card is the second-best: good for low-stakes answers, too easy to hit for consequential ones.
7. **The attention model is: Lock Screen, then the item, then the answer.**
   - Linear's push says "Cursor Agent needs input: Which repository is this issue about?" It names the agent, says what kind of thing is needed, and gives the question itself.
   - Claude's Dispatch set shows a stack of task notifications on the Lock Screen.
   - Apple's own "Notify Me" (iOS 27) shows the same thing for a background watcher.
   - This copy format is Juno's "Mira needs you" (§4.1, §7), made native.
8. **Live Activities are the native home for a long task, and a pill is not.** Apple's Live Activity (iOS 26) and a reported ChatGPT Lock Screen tracker (UNVERIFIED, [Josh Miller on X](https://x.com/joshm/status/1924882477136429152)) show where a task in progress should live when the app is closed.
9. **Apple's Siri app (iOS 27) is the strongest single reference for Juno's iPhone chat.** It has:
   - an editorial answer with a full-bleed image and a large display headline;
   - one source chip ("wikipedia.org +6");
   - history as a two-column masonry of titled cards with timestamps and a pin, with floating glass Search and Compose buttons and no tab bar.
   One exception: its headline is a serif, which Juno's identity rules out for greetings (§12). Take the structure, not the face.
10. **The tab bar should morph instead of stacking a composer on top of tabs.** On an issue page, Linear's floating glass tab bar collapses into Home, a "Leave a comment" field and Search. The HIG adds that the tab bar can minimize on scroll and fold its bottom accessory inline. Juno's `Chat · Crew · Code + Search` (§4.3) should use both behaviours.
11. **Keyboard-adjacent craft is where native apps prove themselves.**
    - Things 3's quick-entry card sits on the keyboard, with a destination ("Inbox") at the bottom left, a Save capsule, and a keyboard return key that becomes a blue checkmark.
    - Linear's composer puts property chips and a formatting bar above the keyboard.
    - Copilot's context palette (All · Chats · Files · People · Meeting) opens above the keyboard when you type `/`.
    That last one is almost exactly Juno's `@` token palette.
12. **Most AI-app slop on iOS is a leftover web habit.** It includes:
    - glass on content, and mode switches as top segmented controls;
    - status chips with counts, and unread dots;
    - sparkle marks and orbs as the only sign of state;
    - generic starter prompts, and long-running haptics.
    §5 lists each with its source.

---

## 2. The platform baseline on 2026-09-30

**The iOS version.** iOS 27 shipped on 2026-09-14 ([MacRumors 2026-09-14](https://www.macrumors.com/2026/09/14/apple-releases-ios-27/); [Apple Newsroom 2026-09](https://www.apple.com/newsroom/2026/09/major-updates-for-apples-software-platforms-are-now-available/)). In Apple's words, "Liquid Glass refinements improve overall readability, and a new slider in Settings lets you personalize its appearance from ultra-clear to fully tinted." In practice:

- **Design for the whole range of that slider.** Juno's glass must stay legible when the person chooses fully tinted and when they choose ultra-clear. Using standard components gets this for free.
- **Custom `glassEffect` surfaces must respect the slider and the Reduce Transparency and Increase Contrast settings.** The HIG says variant appearance "can differ in response to certain system settings, like if people choose a preferred look for Liquid Glass".

**Materials** ([HIG Materials](https://developer.apple.com/design/human-interface-guidelines/materials), read 2026-09-30):

- Glass is for controls and navigation only. The exceptions are transient interactive controls, such as sliders and toggles while they are being used.
- "Use Liquid Glass effects sparingly… Limit these effects to the most important functional elements."
- Use the **regular** variant for text-heavy components (alerts, sidebars, popovers). Use **clear** only over media, and "if the underlying content is bright, consider adding a dark dimming layer of 35% opacity."
- Content-layer structure uses the standard materials (ultra-thin, thin, regular, thick) and vibrant label colours.

**Tab bars** ([HIG Tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars); [Donny Wals, 2025-06-19, updated 2025-07-07](https://www.donnywals.com/exploring-tab-bars-on-ios-26-with-liquid-glass/)):

- The bar floats.
- `tabBarMinimizeBehavior(.onScrollDown)` shrinks it on scroll.
- `tabViewBottomAccessory` adds a persistent shelf above the bar, which folds inline when the bar minimizes.
- `Tab(role: .search)` gives a separated search tab at the trailing end.
- The HIG says to reserve badges for "critical information". Owner rule: Juno uses none.

**Sheets** ([HIG Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets)):

- Sheets have medium and large detents, and custom detents. Resizable sheets need a grabber.
- A nonmodal sheet "lets people… affect the parent view without dismissing the sheet". Notes' formatting sheet is the example.
- Compose sheets in Messages and Mail use only the large detent.

**Haptics** ([HIG Playing haptics](https://developer.apple.com/design/human-interface-guidelines/playing-haptics)):

- Use system patterns only for their documented meanings.
- Build a "clear, causal relationship between each haptic and the action".
- "Prefer playing short haptics that complement discrete events"; long-running haptics "can dilute the meaning".
- Match haptic intensity to the animation it accompanies.

**Generative AI** ([HIG Generative AI](https://developer.apple.com/design/human-interface-guidelines/generative-ai)):

- Give specific feedback while generating, not "Processing…".
- Put Edit, Undo, Retry and Adjust near generated content.
- "Give them the ability to dismiss new content they don't want, and revert".
- Say where AI is used, and show what is sent to a server.

**The critique to design against.** NN/G's "Liquid Glass Is Cracked" (Raluca Budiu, 2025-10-10, [nngroup.com](https://www.nngroup.com/articles/liquid-glass/)) names the failure modes: text on top of busy images, "text on top of text", cramped floating controls, and controls that appear and disappear unpredictably. iOS 27's readability pass partly answers it. Juno must not bring these problems back with custom glass.

---

## 3. Moment by moment

Each moment lists the references (board file numbers), what makes them premium on iOS specifically, the slop to avoid, and what it means for Juno.

### 3.1 Home and composer

**References**

- **01 ChatGPT.** Top left is a glass circle with the menu. Top right is a grouped glass capsule with New chat and More. User turns are tinted bubbles; assistant turns are plain text on the page. The composer capsule reads `+`, "Ask ChatGPT", a mic, and a filled blue voice button.
- **02 Apple Siri app (iOS 27, WWDC image 2026-06-08).**
  - The answer is laid out like an article: a full-bleed image under the status bar, a large display headline, SF body text with bold list items, and one source chip ("wikipedia.org +6").
  - The follow-up question sits in a grey bubble with a Messages-style tail.
  - The composer is three separate glass objects: a `+` circle, an "Ask Siri" capsule and a mic circle.
- **04 Messages (iOS 26).** The same three-object composer, `+` then "iMessage" then a mic, floating over a custom background. This is the system's canonical composer, and people use it dozens of times a day.
- **03 Mistral Vibe.** The home screen greets "Welcome back, Charlie." and shows horizontally scrolling suggestion cards drawn from connected apps ("Summarize my unread emails" with the Gmail mark, "Post update to #team-channel" with the Slack mark). The mode ("Work ⌄") sits in the title.

**Why it is premium on iOS**

- The composer copies the system Messages composer, so the person already knows how it works.
- Controls are glass circles at least 44 pt, grouped into clusters, the way `ToolbarItemGroup` groups them.
- The answer text is plain SF on the page, not in a bubble, so dynamic type and long reads stay comfortable.
- Siri's answer earns its richness from content (an image, a headline), not from chrome.

**Slop**

- ChatGPT's App Store gradient is marketing only. Never put it behind product UI.
- Suggestion cards that are generic prompts. Copilot's home offers "Plan my day / Search in my org / Triage my inbox" (27). Mistral's cards are better because each is tied to a connected app. Juno §5 goes further: suggestions come only from real state, and there are none when nothing is real.

**Juno**

- Keep §5's four objects.
- On iPhone, split the `+` into its own glass circle, the way Messages and Siri do.
- The model control is a compact label inside the capsule (Claude's "Opus" chip in 30 is the right size). Dictate and send/voice sit at the trailing end.
- The greeting is one line in SF (no serif, §12). At most three state-derived suggestion rows, drawn with the token marks of the crew member or app they concern.

### 3.2 Keyboard, attachment tray and context palette

**References**

- **05 Copilot.** Typing `/` opens a palette above the keyboard with filter tabs (All · Chats · Files · People · Meeting) and rows that each carry the object's own app mark (OneNote, Excel, PowerPoint, Word). The composer rises with the keyboard.
- **06 Linear.** A composer sheet with an X, a team chip ("Mobile") and send. Above the keyboard: horizontally scrolling property chips (Triage, Medium, assignee, iOS), then a formatting bar (`+ @ list checklist code quote`).
- **07 Things 3.** The quick-entry card sits on the keyboard: title, notes, a checklist with drag handles, a tag, date and flag icons, the destination "Inbox" at the bottom left and a Save capsule. The keyboard's return key becomes a blue checkmark.
- **30 Claude.** Attachments appear as a row of tiles above the user turn: a photo thumbnail and document tiles with a type label (DOC, PDF) and file name.

**Why it is premium on iOS**

- The system keyboard stays the system keyboard. The app only adds an input accessory row, uses the return-key type, and follows the keyboard's animation curve so the card rises with it.
- Every inserted object carries the thing's own mark. That is Juno's token rule, and Copilot proves it reads well at phone size.
- Destinations are explicit ("Inbox", "Mobile"), so the person knows where the thing will land before they commit.

**Slop**

- A custom emoji or AI "sparkle" key.
- An attachment tray drawn as a web-style popover instead of a native menu or medium-detent sheet.
- Attachment chips that show upload status as coloured pills.

**Juno**

- `@` opens a palette like Copilot's, filtered by Crew · Files · Projects · Apps · Chats (§5), above the keyboard.
- A chosen item becomes an atomic token with its mark. Backspace deletes the whole token, and a haptic tick is implied.
- `+` opens a native menu of Photos, Camera, Files, Screenshot, From Library, plus the two switches people actually flip (web search, memory).
- `/` uses the same palette for skills.
- Tokens that need approval say so in the palette row ("Posting to #design will ask you first"), not after send.

### 3.3 Model and mode switching

**References**

- **08 Copilot.** Tapping "Auto ⌄" in the title opens a floating menu:
  - Auto ("Adjusts based on your task"), Quick response ("Answers right away") and Thinks deeper ("Thinks longer for better ans…");
  - a separator;
  - providers: GPT › (OpenAI), Claude ✓ (Anthropic), and Work IQ ✓.
- **09 Meta AI.** A "Thinking" control in the composer opens a menu over the keyboard: Instant ("Answers right away") and ✓ Thinking ("Reasons longer before answering").
- **10 Grok.** A top segmented control (Ask · Imagine · Build), plus an "Expert ⌄" chip and a white "Speak" capsule in the composer.
- **11 Gemini.**
  - The model is in the title ("Gemini Flash ⌄").
  - Creation modes appear as a removable token inside a two-row composer ("Images ×", placeholder "Describe your image").
- **[sibling research]** ChatGPT's picker sits at the top of the conversation on mobile. Long-press Send picks a model for one message (iOS, 2026-06-08) (`docs/rework/research/openai.md:40-44`).

**Why it is premium on iOS**

- These are native `Menu`s: glass, anchored to their control, with a one-line subtitle per row and a checkmark for the selection.
- The list is short (at most six rows) and leads with Auto. Detail lives one level down (Copilot's "GPT ›" disclosure).
- Gemini's token model is the most interesting. The mode is part of the sentence and is removed with its ×, which is exactly Juno's token grammar.

**Slop**

- Grok's segmented Ask · Imagine · Build makes the person choose a product before speaking.
- Speed and intelligence bars, or price tables, in the first-level menu.
- A picker at the top on mobile but in the composer on web. OpenAI's own inconsistency is flagged in the sibling doc.

**Juno**

- §6 is right. The composer model label opens a native menu: Auto, favourites, four or five current models, each with one line.
- Effort goes at the bottom as a three-segment `Picker` (Light · Standard · Deep). That is a control, not a status pill.
- "All models…" opens a large-detent sheet.
- Add long-press on Send for "this message only". It is a real power-user affordance, and it is invisible until wanted.

### 3.4 Streaming and thinking

**References**

- **12 Mistral Vibe.**
  - A trace reads "Working · Searching web ⌄", then "Thought for 3s", then "Searching web" with a live spinner.
  - A nested card lists the search ("Robotics breakthroughs", "4 sources") with favicon and domain rows.
  - Completed rows get a check. The live row gets the only animation.
- **13 Mistral Vibe.** "Loading skill · pipeline-analysis.md" is lifted as a floating callout, then the deliverable arrives as a titled document card ("Q3 2026 Strategic Review").
- **14 Perplexity.** Pro Search pauses at "Understanding question" to ask a clarifying question: "What are your main interests for this trip?" There are option chips (Beaches, Temples, National Parks, Cities), a free-text field, and Skip / Continue. This is a plan gate on a phone.
- **Meta AI (board set, not copied).** "Show thinking ›" is a single collapsed line above the answer.
- **[secondary]** ChatGPT shows an "Answer now" control while thinking, which stops reasoning and answers immediately ([TechRadar](https://www.techradar.com/ai-platforms-assistants/chatgpt/you-can-now-toggle-gpt-5s-thinking-time-for-faster-or-smarter-answers-heres-how-to-do-it)).

**Why it is premium on iOS**

- Rows are short and in the past tense, set in secondary label colour with SF Symbols.
- Only the live row moves. The rest is static and collapses to one line when the answer lands.
- Sources are a real list, not a row of coloured favicons.
- On a phone, clarification uses native chips and a text field, with an explicit Skip.

**Slop**

- "Thinking…" with a shimmer and nothing else.
- Raw chain-of-thought streamed into the thread.
- An animated gradient border around the whole answer.
- A pulsing brand orb as the only progress signal.

**Juno**

- A task's lead line (§9) is one sentence ("Reading 14 sources · 3 of 5 questions answered") in the secondary label style. The plan and trace sit behind a disclosure chevron.
- The live row gets a subtle symbol effect (`.symbolEffect(.pulse)` or a variable-colour symbol). Everything else is still.
- The research plan gate uses Perplexity's shape: a question, options, free text, then Skip and Continue as equal capsules.
- Add "Answer now" while Deep effort is thinking.

### 3.5 Voice, inline and full-screen

**References**

- **15 ChatGPT, inline voice.**
  - The conversation stays on screen and transcripts appear as turns.
  - A blue orb floats above the composer.
  - The composer turns into mute and a black X (end).
  - See the 2025-11-25 sources in §1.3.
- **16 Mistral Vibe, dictation.** A bottom panel holds a large green waveform, an X, an "Autosend OFF" toggle and a send arrow. Dictation is clearly separate from conversation.
- **17 Gemini Live with the camera.** Full-bleed camera, with a spoken question in a dark glass bubble. A glass control row holds video, screen share, the orb, mic and X.
- **18 Siri, on-screen awareness (iOS 27).** A large regular-glass panel titled "Summary" floats over a document. Siri's Camera mode (Newsroom, not on the board) puts the answer in a dark glass panel over the viewfinder, in a mode between PHOTO and PORTRAIT.
- **Board set, not copied:**
  - Perplexity voice shows a dot-matrix waveform with a "4 sources" chip and live transcript text that fades out upward.
  - Meta AI real-time voice shows captions in the thread and an "Explore on Social" card, with a blue X to end.
- **Apple, 2026-09 (not on the board).** "Write with Siri" on the Lock Screen streams the spoken request into a glass panel ("— Ask Siri") with a "Show Results" capsule.

**Why it is premium on iOS**

- Voice keeps the context: the thread stays visible and the orb is small.
- Each mode is distinguishable. Mistral's Autosend toggle makes the difference between dictation and conversation explicit.
- Full screen appears only when the camera or the screen is the input.
- Controls over the camera use clear glass with dimming, as the HIG prescribes.

**Slop**

- A full-screen orb for a voice-only exchange.
- An orb as the only state indicator, with no text for listening, thinking or speaking.
- Continuous haptics while speaking.
- Voice that can "send" or act without the same approvals as text.

**Juno**

- §9 plus the owner rule: inline by default. The voice presence lives in the composer's slot, not over the thread.
- Listening, thinking and speaking differ in both motion and a text label (VoiceOver reads the same label).
- Full screen appears only for camera and screen share.
- A medium impact haptic on start and a light one on end. Nothing continuous.
- Consequential actions spoken aloud still produce the same approval sheet (§3.7).

### 3.6 Agent and task progress

**References**

- **19 Copilot Cowork.**
  - Title "Cowork". A "Working on it ⌄" disclosure lists steps with app marks (Searching email, Reviewing Teams chats, Creating Email Draft).
  - Then a "Send Email" sheet slides up: To: tokens with ×, subject, body with a deck link, and Cancel / Send.
- **20 Claude, task list.**
  - Filter chips: All 300 · Blocked 12 · In progress 3 · Done.
  - Task rows show an icon, title, repository and age. The waiting task is raised as a card with a hand icon, its question ("I found 3 more components using the hard-coded 8px value. Change them?") and a full-width **Approve**.
  - Unread blue dots sit on the row icons.
- **13 Mistral Vibe.** Skill loading is visible (see §3.4).
- **[sibling research]** Grok Bot turns drafted email and Slack messages into "Send Email" / "Send Message" cards on mobile (`docs/rework/research/xai-grok.md:715-716`).

**Why it is premium on iOS**

- One sentence says what is happening, and steps sit behind a disclosure.
- The result shows up as the native object it is: an email becomes a compose-style sheet, not a markdown code block.
- The approval surface has equal-weight Cancel and Send, with Send filled. It sits at the bottom, in thumb reach.

**Slop**

- Claude's filter chips with counts and its unread dots break the owner rules as drawn.
- The green "Connected" label under a task title is a status chip.
- A single full-width "Approve" with no Deny next to it makes the default action too easy for consequential operations.

**Juno**

- A task in a chat follows §9's order: what Juno is doing, what needs you, one progress line, then the result.
- Anything on the always-confirm floor (send, publish, buy, delete, transfer, change permissions, credentials) becomes a sheet at the medium or large detent. It shows the exact payload (recipients as tokens, the diff, the amount) with **Cancel** and a verb-labelled primary ("Send", "Publish", "Delete"). This is the deterministic approval.
- Low-stakes questions ("Change them?") can be answered inline with two buttons, never one.
- The Crew tab's roster order follows the sibling finding (needs input, then blocked, then ready, then running) without count chips. The section header is the count.

### 3.7 Notifications and approvals away from the app

**References**

- **22 Linear.** A Lock Screen push reads "Cursor Agent needs input: Which repository is this issue about?"
- **21 Claude Dispatch.** A stack of task notifications on the Lock Screen: "Keep tasks running while you're away".
- **23 Apple Notify Me (iOS 27).** "Notify Me · The Brian Tran Band Tour · An update was detected on this page."
- **24 Apple Live Activity (iOS 26).** A Lock Screen card with a route line, a time estimate and three fields.
- **UNVERIFIED.** ChatGPT has run a Lock Screen Live Activity tracker for background work ([Josh Miller on X](https://x.com/joshm/status/1924882477136429152); not independently confirmed).

**Why it is premium on iOS**

- The notification names the actor, says what kind of thing is needed, and carries the question itself, so the person can often answer from a long-press action without opening the app.
- A Live Activity holds progress that changes over time, and the Dynamic Island holds the compact form. No in-app banners are needed.

**Slop**

- "Your agent needs attention".
- Unnamed actors.
- Notifications for progress, as opposed to decisions.
- A red badge count on the app icon for non-critical state (HIG: "Reserve badges for critical information").

**Juno**

- Push copy follows the Linear format with a named crew member: "Mira needs your answer · Acme renewal: send the revised quote today?"
- Actionable notification categories (Answer, Open) may approve only *narrowing or non-consequential* things. Floor actions always open the approval sheet with Face ID (`LAContext`) before executing. That keeps approval deterministic.
- One Live Activity per running long task, with the §9 lead line as the text. It ends with the result, and the Dynamic Island shows the member's face in the compact leading slot.
- No app-icon badge.

### 3.8 History

**References**

- **25 Siri app history (iOS 27).**
  - A two-column masonry of cards. Each card has a timestamp or day, a bold multi-line title, and either a two-line excerpt or an image.
  - Pinned cards carry a pin glyph.
  - A filter button sits top right. Floating glass Search (bottom left) and Compose (bottom right) replace the tab bar.
- **Perplexity Library (board set, older).** Library · Pages · Collections segments, with rows that show the question, a two-line answer excerpt, image thumbnails and age.
- ChatGPT, Claude, Gemini, Grok, Meta AI and Mistral all keep history in a leading drawer opened from the glass menu circle.

**Why it is premium on iOS**

- Titles are real titles, written by the model and edited for scanning.
- Content previews (image, excerpt) make recall visual.
- Search and compose are thumb-reachable floating glass buttons. Search is placed at the bottom, as iOS 26 moved it.

**Slop**

- Undifferentiated lists of truncated first prompts.
- Date-group headers as the only structure.
- Swipe-to-delete that hard-deletes without undo.

**Juno**

- History lives in the Search tab (system `role: .search`) and the Chat tab's top-left menu (§4.3).
- Use Siri-style titled rows or cards with the crew member's face or the project mark as the leading visual.
- Pinned first.
- Swipe actions are Pin, Move to project and Delete. Delete is undoable through a toast with Undo, and the item goes to trash rather than being hard-deleted.

### 3.9 Drawer or tabs

**References**

- **27 Copilot.** A floating glass tab bar (Chat · Cowork · Search · More) with a separate glass Compose circle at the trailing end. The composer floats above the tab bar on the Chat root.
- **26 Linear.** On an issue page, the tab bar becomes Home (circle), a "Leave a comment" capsule with an attachment clip, and Search (circle).
- **Linear (board set).** The root tab bar is Home · Inbox · Scan · switcher · Search. Inbox rows swipe to "Unread".
- **28 Things 3.** A single sidebar-as-root list (Inbox, Today, Upcoming, Anytime, Someday, Logbook, then Areas and Projects) with Quick Find at the top.
- **Drawer apps:** ChatGPT, Claude, Gemini, Grok, Meta AI, Mistral and Perplexity.

**Why it is premium on iOS**

- Tabs are right when the top-level nouns keep independent state. Copilot has Chat and Cowork; Linear has Home and Inbox.
- The drawer is right for one-noun apps. ChatGPT's drawer works because everything is a chat.
- The morph from tab bar to comment field keeps the bottom glass layer to one object at a time.

**Slop**

- A tab bar with a composer stacked above it inside a thread, which gives two glass layers.
- A "More" tab as a junk drawer.
- A hamburger drawer that hides five destinations.

**Juno**

- §4.3's `Chat · Crew · Code` plus the system Search tab is correct. Juno has three nouns with their own state, and Crew and Code are not chats.
- The tab bar minimizes on scroll (`.onScrollDown`).
- Inside a thread (chat, crew member, Code session), the tab bar yields to the composer, the way Linear's does.
- A running voice session or the most urgent live task can be the `tabViewBottomAccessory`, which folds inline when the bar minimizes (the Music MiniPlayer pattern).
- Library, Projects and Customize come from the Chat tab's top-left glass menu circle. No "More" tab.

### 3.10 Settings and Customize

**References**

- **29 Arc Search.** An inline card of three toggle rows, each with a coloured SF-style icon tile (Block Ads, Block Cookie Banners, Block Trackers).
- **Arc Search (board set).** A popup picker inside a row: "Archive Inactive Tabs · After 1 day ⌃⌄".
- **Meta AI (board set).** Device quick tiles (Translate Off, Do not disturb On, Battery Saver Off).
- The AI apps rarely show Settings in their marketing frames. The benchmark is Apple's Settings app, where the Liquid Glass slider itself lives in iOS 27.

**Why it is premium on iOS**

- An inset grouped `Form` with native `Toggle` and `Picker` (menu style). The current value appears as trailing text, not a pill.
- Icon tiles are used only at the top level.
- Changes apply at once, with no Save button.

**Slop**

- Web settings pages in a WebView.
- Custom toggles.
- "On/Off" status pills.
- Settings split across a sidebar and a separate "Connections" page.

**Juno**

- Customize (§4.1, §8) is a native `Form`. Apps are rows with the service mark.
- Each app's page has sections: account, can read, can change, last used, who can use it, and a per-action policy `Picker` (Allow · Ask · Off, menu style).
- The approval ladder is one `Picker` with the three §8 labels. The always-confirm floor is shown as a footer ("Always asks: send, publish, buy, delete…") rather than as disabled toggles.

### 3.11 Artifacts and files

**References**

- **30 Claude.** "Congrats! I created your deck here." sits above a card with a file-type glyph, the title "All About Minnie" and "Presentation · PPTX".
- **31 Claude.** A generated app (flashcards) opens in a large sheet over the chat, with an X and a More button. The chat stays visible behind it.
- **32 Grok.** A generated app card with a hero image, the title "Tiny City Game", "Not Published Yet" as secondary text, and Share and Play buttons.
- **Mistral Vibe (board set).** A document opens as a sheet with a header card.
- **ChatGPT (board set).** An email draft block with inline edit, copy and send icons.

**Why it is premium on iOS**

- The deliverable is a first-class card: glyph, title, and type in secondary text.
- Opening it presents a sheet that keeps the conversation behind it. That is spatial continuity; a zoom transition from the card is implied.
- Grok states lifecycle ("Not Published Yet") as plain text, which is the right way under the owner's rules.

**Slop**

- A paper-plane send icon inside a draft block. It makes a consequential action a single tap in the content layer.
- Artifacts rendered inline at full height inside the thread.
- Status badges ("Draft", "Live") as coloured pills.

**Juno**

- A Library item appears in the thread as a card: type glyph, title, type and version in secondary text.
- It opens with a zoom transition (`.navigationTransition(.zoom)`) into a large sheet or a pushed page.
- Share (private link) and Publish (public URL) are separate toolbar actions (§10). Publish goes through the approval sheet.
- The version is secondary text ("v3 · edited 2 min ago"), never a pill.

---

## 4. Native craft references outside AI

- **Things 3 (07, 28, 33).**
  - **Magic Plus.** Tap it to create a to-do, or lift and drag it to insert one exactly where you drop it. Drop it on the Inbox target to file it without leaving the list ([Cultured Code, Things features](https://culturedcode.com/things/features/)).
  - **The quick-entry card on the keyboard.** Destination, Save, and a checkmark return key.
  - Headings in brand blue. Dark mode tuned rather than inverted. Widgets.
  - Juno lesson: one gesture-rich primary button (compose) beats a toolbar of options. Drag-to-place is the premium version of "choose where this goes".
- **Arc Search (34, 29).**
  - "Browse for Me" builds a clean answer page (headline, emoji-bulleted facts) and is triggered from a small button next to each suggestion.
  - [secondary] A product breakdown describes a steady haptic pulse and a slow downward reveal while the page builds ([Medium, Design Bootcamp](https://medium.com/design-bootcamp/a-product-manager-breaks-down-the-arc-search-app-99bc2a15c762)).
  - Take the reveal. Do not take the continuous haptic, which the HIG warns against in apps.
- **Linear mobile (06, 22, 26).**
  - The tab-bar-to-composer morph.
  - Property chips above the keyboard.
  - Inbox swipe actions.
  - An agent's "needs input" push written as a question.
  - A "Daily Pulse" audio digest with a play button in the inbox.
  - Everything is dark, dense and quiet.
- **Apple Messages, Phone, Music and Siri (02, 04, 18, 23–25, and the Newsroom set).**
  - The three-object composer.
  - The unified Phone layout, with a tab bar and a separated search circle.
  - Music's full-bleed, blurred-artwork lyrics view, where glass floats over media.
  - Siri's editorial answers and card history.

---

## 5. Slop catalogue (iOS-specific)

| Pattern | Seen in | Why it is slop | Juno instead |
|---|---|---|---|
| Glass on content (answer cards, bubbles) | Common in third-party redesigns; the HIG warns against it | "Don't use Liquid Glass in the content layer" | Glass only on navigation and controls; content uses standard materials |
| Top segmented mode switch | Grok (10) | Makes the person pick a product before speaking | One composer; the model decides; `/` for skills |
| Filter chips with counts, unread dots, status chips | Claude (20), Linear detail chips | Owner rule; noise | The section header is the count; state as text |
| Sparkle or asterisk as the AI mark next to "thinking" | Meta AI, Claude | Generic AI identity; §12 bans the sparkle mark | Juno's own mark; the state is plain text |
| Orb as the only voice state | Various | Not accessible; ambiguous | Orb motion plus a text label |
| Generic starter prompts | Copilot (27), Gemini | Not derived from the person | Up to three state-derived rows or none (§5) |
| Single full-width "Approve" | Claude (20) | The consequential default is one tap | Cancel + verb button; the floor goes to a sheet with Face ID |
| Send icon inside a draft block | ChatGPT (board set) | A consequential action in the content layer | "Review and send" opens the approval sheet |
| Long-running haptics | Arc Search [secondary] | The HIG says it "can dilute the meaning" | Short, discrete, causal haptics only |
| Marketing gradients in product UI | ChatGPT, Arc App Store frames | Hurts legibility; NN/G's text-on-image problem | System backgrounds; colour from content |
| Two glass layers at the bottom (composer above the tab bar inside a thread) | Some drawer-less apps | Stacked glass, cramped targets (NN/G) | The tab bar yields to the composer in threads |

---

## 6. Recommendations for Juno on iPhone

1. **Build on system components everywhere.** That means `TabView` with `role: .search`, `.tabBarMinimizeBehavior(.onScrollDown)`, `tabViewBottomAccessory`, `Menu`, `Form`, `Picker`, sheets with detents, and `glassEffect` only on custom controls. Test under the iOS 27 slider at both extremes, and with Reduce Transparency and Increase Contrast on.
2. **Composer.** Messages-style: `+` circle, capsule (model label, field, dictate), and a trailing voice/send circle. The `@` and `/` palettes open above the keyboard, and tokens carry marks and delete as a whole.
3. **Model menu.** A native `Menu`: Auto, favourites, current best models with one line each, and an effort `Picker`. "All models…" opens a sheet. Long-press Send sets the model for one message.
4. **Trace.** One lead sentence, past-tense steps behind a disclosure, a symbol effect only on the live row, and "Answer now" during Deep effort.
5. **Voice.** Inline by default, full screen only with camera or screen share. States shown by motion and text. Voice never bypasses approvals.
6. **Approval.** A sheet showing the exact payload, Cancel and a verb button, and Face ID for floor actions. Notification actions may only answer questions or narrow things.
7. **Attention.** Push copy that names the crew member and asks the question. A Live Activity per long task. No badges.
8. **History.** Titled rows or cards with a face or project mark, pinned first, in the Search tab and the top-left menu.
9. **Deliverables.** A card, a zoom transition into a sheet, and Share separated from Publish.
10. **Haptics map** (implied design, following the HIG's documented meanings):
    - selection tick on token insert and menu choice;
    - light impact on send;
    - medium impact on voice start;
    - `.warning` notification haptic when a crew member needs you in the foreground;
    - `.success` after an approved action completes.
    Nothing continuous.

---

## 7. Reference board index

Folder: `/private/tmp/claude-501/-Users-liammagnier-Developer-project-juno/9a242067-f03a-4200-acec-6b9eafa8d677/scratchpad/refs/ios/`. Contact sheet: `_index.jpg`.

App Store image sources are the `is1-ssl.mzstatic.com` 1290×2796 renditions of each listing's current screenshot set. Newsroom images are the `large_2x` renditions.

| File | App | Source |
|---|---|---|
| 01-home_chatgpt_glass-nav-and-composer-capsule | ChatGPT 1.2026.265 | https://apps.apple.com/us/app/chatgpt/id6448311069 (shot 1) |
| 02-home_apple-siri-app-ios27_editorial-answer-and-composer | Apple Siri app, iOS 27 | https://www.apple.com/newsroom/2026/06/apple-unveils-next-generation-of-apple-intelligence-siri-ai-and-more/ (`Apple-iOS-27-Siri-app-chat-260608_inline`) |
| 03-home_mistral-vibe_state-derived-suggestions | Vibe by Mistral (ex-Le Chat) 2.12.0 | https://apps.apple.com/us/app/vibe-by-mistral-ex-le-chat/id6740410176 (shot 1) |
| 04-composer_apple-messages-ios26_plus-circle-and-capsule | Messages, iOS 26 | https://www.apple.com/newsroom/2025/06/apple-elevates-the-iphone-experience-with-ios-26/ (`Messages-custom-Background`) |
| 05-keyboard_copilot_context-palette-over-keyboard | Microsoft Copilot 2.114.2 | https://apps.apple.com/us/app/microsoft-copilot/id541164041 (shot 2) |
| 06-keyboard_linear_property-chips-and-format-bar | Linear Mobile 1.101.0 | https://apps.apple.com/us/app/linear-mobile/id1645587184 (shot 3) |
| 07-keyboard_things3_quick-entry-card | Things 3 3.24.2 | https://apps.apple.com/us/app/things-3/id904237743 (shot 4) |
| 08-model_copilot_auto-effort-and-provider-menu | Microsoft Copilot | id541164041 (shot 4) |
| 09-model_metaai_instant-thinking-menu-over-keyboard | Meta AI 292.0.0 | https://apps.apple.com/us/app/meta-ai/id1558240027 (shot 6) |
| 10-model_grok_mode-segments-and-model-chip | Grok AI 1.4.46 | https://apps.apple.com/us/app/grok-ai/id6670324846 (shot 2) |
| 11-model_gemini_mode-token-inside-composer | Google Gemini 1.2026.3770306 | https://apps.apple.com/us/app/google-gemini/id6477489729 (shot 3) |
| 12-thinking_mistral-vibe_working-trace-and-sources | Vibe by Mistral | id6740410176 (shot 3) |
| 13-thinking_mistral-vibe_loading-skill-then-deliverable | Vibe by Mistral | id6740410176 (shot 4) |
| 14-thinking_perplexity_clarifying-plan-gate | Perplexity 26.38.0 (older screenshot set) | https://apps.apple.com/us/app/perplexity-ai-search-chat/id1668000334 (shot 4) |
| 15-voice_chatgpt_inline-voice-in-thread | ChatGPT | id6448311069 (shot 2) |
| 16-voice_mistral-vibe_dictation-sheet-autosend | Vibe by Mistral | id6740410176 (shot 6) |
| 17-voice_gemini-live_camera-with-glass-controls | Google Gemini | id6477489729 (shot 2) |
| 18-voice_apple-siri-ios27_onscreen-summary-glass | Siri, iOS 27 | https://www.apple.com/newsroom/2026/09/siri-ai-a-profoundly-more-capable-and-personal-assistant-is-here/ (`Apple-Siri-AI-onscreen-awareness_inline`) |
| 19-task_copilot-cowork_steps-then-send-approval-sheet | Microsoft Copilot | id541164041 (shot 5) |
| 20-task_claude_task-list-inline-approve | Claude 1.260925.19 | https://apps.apple.com/us/app/claude-by-anthropic/id6473753684 (shot 7, "Code Review") |
| 21-notify_claude-dispatch_lockscreen-task-notifications | Claude | id6473753684 (shot 6, "Dispatch") |
| 22-notify_linear_agent-needs-input | Linear Mobile | id1645587184 (shot 4, "Push") |
| 23-notify_apple-ios27_notify-me | iOS 27 | Siri AI newsroom 2026-09 (`Apple-iOS-27-Notify-Me_inline`) |
| 24-notify_apple-ios26_live-activity | iOS 26 | iOS 26 newsroom 2025-06 (`Live-Activities`) |
| 25-history_apple-siri-app-ios27_conversation-cards | Siri app, iOS 27 | Siri AI newsroom 2026-09 (`Apple-Siri-AI-conversation-history-overview_inline`) |
| 26-nav_linear_tabbar-morphs-into-comment-field | Linear Mobile | id1645587184 (shot 6) |
| 27-nav_copilot_glass-tabbar-plus-compose | Microsoft Copilot | id541164041 (shot 1) |
| 28-nav_things3_sidebar-list-hierarchy | Things 3 | id904237743 (shot 1) |
| 29-settings_arc-search_inline-toggle-card | Arc Search 1.48.0 | https://apps.apple.com/us/app/arc-search-find-it-faster/id6472513080 (shot 6) |
| 30-artifact_claude_file-deliverable-card | Claude | id6473753684 (shot 5) |
| 31-artifact_claude_artifact-sheet-over-chat | Claude | id6473753684 (shot 4) |
| 32-artifact_grok_publishable-app-card | Grok AI | id6670324846 (shot 5) |
| 33-craft_things3_magic-plus-drag-insert | Things 3 | id904237743 (shot 5) |
| 34-craft_arc-search_browse-for-me-page | Arc Search | id6472513080 (shot 3) |

The full staging set (84 App Store shots and 20 Newsroom images) is in `…/scratchpad/stage/`, with per-app contact sheets in `…/scratchpad/sheets/`.

---

## 8. Sources

App Store listings. Version and last update are as returned by `itunes.apple.com/lookup` on 2026-09-30:

- ChatGPT 1.2026.265 (2026-09-29): https://apps.apple.com/us/app/chatgpt/id6448311069
- Claude by Anthropic 1.260925.19 (2026-09-28): https://apps.apple.com/us/app/claude-by-anthropic/id6473753684
- Google Gemini 1.2026.3770306 (2026-09-23): https://apps.apple.com/us/app/google-gemini/id6477489729
- Perplexity 26.38.0 (2026-09-29; the screenshot set predates Liquid Glass): https://apps.apple.com/us/app/perplexity-ai-search-chat/id1668000334
- Grok AI 1.4.46 (2026-09-30): https://apps.apple.com/us/app/grok-ai/id6670324846
- Meta AI 292.0.0 (2026-09-26): https://apps.apple.com/us/app/meta-ai/id1558240027
- Microsoft Copilot 2.114.2 (2026-09-30): https://apps.apple.com/us/app/microsoft-copilot/id541164041
- Vibe by Mistral, formerly Le Chat, 2.12.0 (2026-09-22): https://apps.apple.com/us/app/vibe-by-mistral-ex-le-chat/id6740410176
- Things 3 3.24.2 (2026-09-22): https://apps.apple.com/us/app/things-3/id904237743
- Arc Search 1.48.0 (2026-08-12): https://apps.apple.com/us/app/arc-search-find-it-faster/id6472513080
- Linear Mobile 1.101.0 (2026-09-22): https://apps.apple.com/us/app/linear-mobile/id1645587184

Apple:

- Newsroom, iOS 26 (2025-06-09): https://www.apple.com/newsroom/2025/06/apple-elevates-the-iphone-experience-with-ios-26/
- Newsroom, Liquid Glass (2025-06-09): https://www.apple.com/newsroom/2025/06/apple-introduces-a-delightful-and-elegant-new-software-design/
- Newsroom, iOS 27 and Siri AI announcement (2026-06-08): https://www.apple.com/newsroom/2026/06/apple-unveils-next-generation-of-apple-intelligence-siri-ai-and-more/
- Newsroom, Siri AI availability (2026-09): https://www.apple.com/newsroom/2026/09/siri-ai-a-profoundly-more-capable-and-personal-assistant-is-here/
- Newsroom, OS 27 availability (2026-09): https://www.apple.com/newsroom/2026/09/major-updates-for-apples-software-platforms-are-now-available/
- HIG pages (undated, read 2026-09-30 via the JSON source): Materials, Tab bars, Sheets, Playing haptics, Generative AI and Toolbars, all under https://developer.apple.com/design/human-interface-guidelines/

Press and secondary:

- MacRumors, "Apple Releases iOS 27…" (2026-09-14): https://www.macrumors.com/2026/09/14/apple-releases-ios-27/
- TechCrunch, ChatGPT voice no longer a separate interface (2025-11-25): https://techcrunch.com/2025/11/25/chatgpts-voice-mode-is-no-longer-a-separate-interface/
- OpenAI on X, voice inside chat (2025-11-25): https://x.com/OpenAI/status/1993381101369458763
- NN/G, Raluca Budiu, "Liquid Glass Is Cracked, and Usability Suffers in iOS 26" (2025-10-10): https://www.nngroup.com/articles/liquid-glass/
- Donny Wals, "Exploring tab bars on iOS 26 with Liquid Glass" (2025-06-19, updated 2025-07-07): https://www.donnywals.com/exploring-tab-bars-on-ios-26-with-liquid-glass/
- TechRadar on ChatGPT thinking controls and "Answer now" (undated in the search result): https://www.techradar.com/ai-platforms-assistants/chatgpt/you-can-now-toggle-gpt-5s-thinking-time-for-faster-or-smarter-answers-heres-how-to-do-it
- Cultured Code, Things features (Magic Plus): https://culturedcode.com/things/features/
- Medium, Design Bootcamp, Arc Search breakdown (undated): https://medium.com/design-bootcamp/a-product-manager-breaks-down-the-arc-search-app-99bc2a15c762

UNVERIFIED (not relied on for recommendations):

- ChatGPT Lock Screen Live Activity tracker (Josh Miller on X): https://x.com/joshm/status/1924882477136429152
- "Claude prepares Liquid Glass UI revamp for iOS app" (Crypto Briefing, 2026-09-25). No named source, no specifics beyond "overhauled navigation": https://cryptobriefing.com/claude-liquid-glass-ios-redesign/
- Secondary guides claiming Claude Cowork reached the iOS sidebar on 2026-07-07 (coworkerai.io and similar). Not confirmed first-party here; see `anthropic.md` for first-party Claude findings.

Mobbin: unavailable ("requires a paid plan", 2026-09-30). No Mobbin screens or URLs are used.
