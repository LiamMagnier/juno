# Phase 3: menus, the menu bar, ⌘K and Search, Share, Outputs, the account popover, dialogs, sheets, Settings, onboarding and announcements (brief)

Written 2026-09-25. Nothing in `native/` is changed by this document.

**Three stages, built at the same time in three worktrees**, all branched from `250b5b13` (Phase 5 Stage A, which already carries the merge of `origin/main` at `fe0a501d`):

| Stage | Worktree | Branch | What it builds |
|---|---|---|---|
| **A** | `/Users/liammagnier/Developer/project/juno-glass-p3` | `mac/lg-p3` | The menu bar and `JunoShortcutRegistry`, which generates `DesktopCommands` and the Keyboard Shortcuts window; the Chat menu's actions; the menu recipe on the shell, sidebar, composer and transcript menus. |
| **B** | `/Users/liammagnier/Developer/project/juno-glass-p3b` | `mac/lg-p3b` | The ⌘K / Search panel; the Share, Outputs and account popovers; the Archived Chats sheet; confirmation dialogs and rename on chat surfaces; sheet fills on chat surfaces. |
| **C** | `/Users/liammagnier/Developer/project/juno-glass-p3c` | `mac/lg-p3c` | The Settings window to web parity (order, every row, Devices, Plan & usage with the Upgrade sheet, the usage page folded in, text size, theme and accent); onboarding and announcements. |

Other lanes are live while these run: Phase 4 pages (`juno-glass-pages`, `juno-glass-p4b`, `juno-glass-p4c`) and Phase 5 (`juno-glass` for Stage B, the task card; `juno-glass-p5c` for Stage C, Needs you, the Agents fold and the Notifications popover). §2 says which files each Phase 3 stage owns, which files it must not touch, and how the seams between lanes are wired at integration (§6).

**Precedence.** Read the spec (`MACOS_LIQUID_GLASS_REDESIGN.md`) Part B, then its "Fact-check errata", "Phase 2 errata", "Foundations errata" and "Phase 5 errata", then this brief. Where this brief and the spec disagree, this brief wins for §2.4, §2.7, §5.7 (Settings rows only), §7 and §11 Phase 3, because §0 below is today's web. Where you find another disagreement, follow the web on `origin/main` and record it (§2.5). Read the web with `git -C <your worktree> show origin/main:<path>` after `git -C <your worktree> fetch -q origin`; never read the branch's own `src/`, which is older, and never write in `/Users/liammagnier/Developer/project/juno` or `juno-tools`.

Line numbers below are from `250b5b13` (Mac) and `fe0a501d` (web). Prefer the symbol names; they survive edits.

---

## 0. Today's web, and where the Mac is

### 0.1 ⌘K and Search: two palettes on the web (`src/components/app/command-palette.tsx`)

One shell (`PaletteShell`), two surfaces.

**Shared shell.** A dialog at `top-[9svh]`, `max-w-[640px]`, `rounded-panel`, no keycap footer. The field band: `AppIcons.search` at 20px, a 17px (`body-lg`) input on a 60px band, a Clear ✕ that fades in with the first character (tooltip "Clear", label "Clear search"). The list has `min-h-[13rem]` so the overlay never changes shape between keystrokes, `max-h-[min(56svh,calc(100dvh-10rem))]`, `p-2`. Group headers are sentence case at `text-ui` medium muted, 4px above the first and 24px above later groups. Rows are `rounded-field` (12, concentric with the 20 shell and 8 inset), 36px for one line and taller with a snippet: a plain 18px glyph in a 20px slot (no plate), the title at 15px (`text-foreground/75`, full ink when active), the snippet at 13px muted, trailing meta at 11px tabular muted, and keycaps. The active row's fill cross-fades on the `fast` rung (no sliding bar). Rows fade in on the `tight` stagger (first eight). Keys: ↑ ↓ move, ↩ runs, Esc closes (Radix). A polite live region announces the result count.

**Command menu (⌘K).** Placeholder "Search or start a chat", label "Command menu". Groups and rows, filtered by a word-start match over label and keywords (`atWordStart`):
- **Actions:** New chat (`⌘⇧O`), New code session, New design, New automation, New assistant, New agent, Search everything, Toggle sidebar (`⌘⇧S`), Open notifications, Open Assistants, Open Agents, Open Code, Open pull requests, Open Designs, Open Artifacts, Open Library, Open Connections, Open Skills, Open Automations, Open Permissions, Compare models, Open Memory, Roadmap & feature requests. Each row's keywords are in the file; port them verbatim.
- **Chats:** the five newest chats (not archived, not Code), or up to six title matches, meta = relative time ("Just now", "5m", "2h", "Yesterday", "3d", "2w", "4mo", "1y").
- **Code sessions:** the four newest, or six matches; meta = workspace name or time.
- **Projects:** four (pinned first, "Pinned" as meta) or six matches, then "All projects".
- **Settings:** Settings, Plans & upgrade, "Switch to dark mode" / "Switch to light mode" (`⌘⇧L`), Keyboard shortcuts (`⌘/`).
- Empty: "No matches for “{query}”." with "Try a chat title, or a command like “settings”.".

**Search (the sidebar's Search row, `juno:search`).** Placeholder "Search", label "Search everything".
- Empty query: "Recent" from `GET /api/recents?limit=8` (chats, tasks, Code sessions, projects).
- With a query: `GET /api/search?q=&types=&projectId=&window=`, debounced 180ms, the previous request aborted. Groups in `SEARCH_TYPES` order with `SEARCH_TYPE_LABELS`: Chats, Messages, Projects, Files, Knowledge, Artifacts, Memory, Tasks (`src/lib/search/types.ts`). Hits carry `titleMarks` and a `snippet` with offset marks, a `locator` or time as meta, and an `href` to the exact place.
- **Filters appear only once there is a query:** a scrolling row of 28px chips (Everything plus the eight types), a hairline, date chips (Any time, Past week, Past month, Past year), a hairline and a project `Select` (All projects, then each project). Active chip: hairline, `foreground/10` fill, full ink.
- **Coverage notices** under the filters when a source was searched only in part: "{Type}: {detail}", at most two, then "{n} more part of your account was searched only in part.".
- States: five 36px skeleton rows while searching; "Search is unavailable right now." / "Check your connection and try the search again." (error tile); "Nothing matches “{query}”." / "Try fewer words, or widen the filters above."; empty query with no recents: "Search everything in Juno" / "Chats and their messages, projects, files, artifacts, memories and tasks.". Status line: "{n} results[, some sources searched only in part]".
- Matched spans are `<mark>` in `bg-primary/15 text-primary-ink`.

### 0.2 Keyboard shortcuts (`src/hooks/use-global-shortcuts.ts`, `ShortcutsSheet` in `command-palette.tsx`)

Global: `⌘⇧S` sidebar, `⇧Esc` focus the composer, `⌘⇧C` copy the last response ("Copied the last response." / "No response to copy yet." / "Couldn’t copy.", `chat-view.tsx:1449-1461`), `⌘⇧;` copy the last code block ("Copied the last code block." / "No code block in this conversation yet." / "Could not copy."), `⌘⇧L` toggle the theme (PATCHes `theme` to the account), `⌘⇧1` Chat, `⌘⇧2` Code. The palette owns `⌘K`, `⌘⇧O` and `⌘/`.

The "Keyboard shortcuts" dialog (`max-w-lg`, two columns from `sm`, group heads in the mono label voice, rows on `divide-y`): **Everywhere** Command menu ⌘K · New chat ⌘⇧O · Toggle sidebar ⌘⇧S · Toggle theme ⌘⇧L · Settings ⌘, · Keyboard shortcuts ⌘/; **Products** Chat ⌘⇧1 · Code ⌘⇧2; **Composer** Send message ↵ · New line ⇧↵ · Attach files ⌘U · Edit your last message (empty field) ↑ · Focus the composer ⇧Esc · Stop generating · close a menu Esc · Commands / · Tools and connectors @; **Responses** Copy the last response ⌘⇧C · Copy the last code block ⌘⇧; · Find in conversation ⌘F.

### 0.3 Share (`src/components/share/share-dialog.tsx`, `shared-links-card.tsx`)

A dialog. Title "Share this chat" / "Share this artifact"; description "People with the link see the conversation up to now. New messages stay private." / "People with the link see this artifact as it is now. Later edits stay private.". Opening it creates the link (`POST /api/share {kind, conversationId | artifactId}`).
- loading: a field skeleton, a button skeleton, a caption skeleton
- error: "Couldn’t create the link. Please try again." and an outline "Try again"
- blocked (403 `share_taken_down`): the server's sentence, else "This can’t be shared."
- revoked: "The link was revoked. Anyone opening it now sees nothing." and a primary "Create a new link" with the link glyph
- ready: a read-only URL field (selects on focus, label "Share link"), a primary "Copy" that swaps to a check and "Copied" for 1.5s, then a row with "Snapshot · {Sep 22, 2026} · {n} view(s)" and a ghost destructive "Revoke link" ("Revoking…"); toasts "Link revoked. It no longer works." / "Couldn’t revoke the link."

### 0.4 Outputs (`src/components/chat/session-outputs.tsx`)

A header chip (`CodeIcons.file` plus a rolling count; tooltip "Outputs"; label "Outputs — {n} in this chat" or "What this chat used"), absent when there is nothing. A 336px popover (max `min(30rem,70vh)`), `p-4`:
- **Outputs** (15px medium): artifacts plus generated images, newest first; two columns when there are two or more, one landscape tile (16:9) when there is one; tile preview at 4:3, title at 13px, label at 11px muted ("Doc", "Web page", "Component", the code language, "Image", "Diagram", "Design"). Designs draw their poster. A click opens the artifact in the canvas, or the image.
- **Used in this session** (after a hairline when both show): 32px rows with a muted glyph, the label and a right-aligned detail: Model / Models ("A · B" or "A +2"), Uploads ("name" or "{n} files", then up to eight openable file rows with an extension badge and "Open", "+{n} more in the chat"), Web search ("{n} sources"), Memory ("Read · {subject}" or "Read · {n} facts"), Connector / Connectors (names or "{n} used"). The model is `readSession()`, exported and pure.

### 0.5 Account menu (`src/components/app/user-menu.tsx`)

- **Identity:** a 32px avatar, the name (13px medium), a **neutral** plan pill (`bg-secondary`, caption medium, sans, not mono), the email (11px muted).
- **Usage block** (`bg-secondary`, `rounded-control`): "Messages" and "{used} / {limit}" (tabular), then an 18-dot `DotFillBar`. With no limit: "No cap" and "Everything unlocked, with no usage cap." (owner) or "All models, with a monthly token limit.".
- Separator. **Settings**; **Upgrade plan** (Sparkle glyph, only when a higher plan is purchasable); **Admin panel** (owners).
- Separator. **Get the apps** (to `/download`); **Keyboard shortcuts** with `⌘/`.
- Separator. **Sign out** (destructive).

There is no Profile row any more; it duplicated Settings.

### 0.6 The row menu, archive and Archived chats (`src/components/app/app-sidebar.tsx`)

- **Row menu:** Rename · Pin/Unpin · Add to project ▸ · Share · Archive · — · Delete, each with its glyph.
- **Delete:** "Delete this conversation?", "This permanently removes the conversation and its messages. This can't be undone.", confirm "Delete chat"; on failure the row comes back and "Delete failed.".
- **Archive:** "Chat archived." with Undo; "Couldn’t archive the chat.".
- **More** is now Assistants · Skills · Automations, a hairline, then **Archived chats**. Connections and Permissions left More.
- **The Archived chats dialog** (`ArchivedChatsDialog`, `max-w-md`):
  - "Archived chats" and "Archived chats stay searchable. Restore one to bring it back to Recent."
  - `GET /api/conversations?archived=only` filtered to the product
  - rows at 48px: the title (13px medium; "New chat" if empty) over "Archived {date}" (mono caption), then Restore (`BoxArrowUp`) and Delete icon buttons
  - four 48px skeleton rows while loading; "Nothing archived." in a quiet tile; "Couldn’t load archived chats." (error)
  - a click opens the chat and closes the dialog
  - toasts "Chat restored." / "Couldn’t restore the chat."

### 0.7 Settings (`src/components/settings/*`)

**Sections, in this order** (`settings-sections.ts`): General · Personalization · Memory · Models · Connectors · **Devices** · Voice · Data & privacy · Account · **Plan & usage**. Aliases: `permissions`/`macs`/`hosts` → Devices, `usage`/`plan` → Plan & usage, `profile`/`security` → Account.

**Layout** (`setting-row.tsx`, `save-status.tsx`):
- Flat groups, rows on hairlines, no cards. The pane's name is the title; a group title is 17px semibold; a row label is 15px medium; notes are 13px muted. The destructive group is set apart by a full-width rule and space, not a red box.
- Every write is optimistic. A row shows nothing while saving, then a check and "Saved" beside its label for 1.8s, or "Not saved" in the destructive ink for 5s (the toast carries the reason).

| Section | Groups and rows, in order (copy verbatim from the file named) |
|---|---|
| **General** (`sections/general.tsx`) | **Appearance**, "Theme and accent follow your account. Text size is set for this device.": Theme (segmented Light / Dark / System with Sun, Moon and Monitor); Accent color, "Buttons, selection and focus." (six swatches Coral, Juniper, Teal, Violet, Amber, Sage, plus "Custom accent color" through a colour well, default `#ea580c`); Text size, "Scales the whole interface on this device." (a six-step slider, 14 · 15 · 16 · 17 · 18 · 20 px, small and large "A" at the ends, the px value after). **Language**: Interface language, "Replies follow Response language in Personalization." (Auto-detect, then the locales; the page reloads). |
| **Personalization** (`personalization.tsx`) | Untitled group: What Juno calls you, "Used in greetings, and shown in the sidebar." (placeholder "Your name", saved on blur or Return; "Couldn’t save your name."); Custom instructions, "Juno keeps these in mind in every conversation." (a text area, placeholder "For example: I’m a product manager. Keep answers short and use bullet points.", saved on blur). **Responses**, "Your custom instructions take priority over both.": Personality (a choice menu with descriptions, `src/lib/personalities.ts`); Response language, "The language Juno replies in." (Match my message, English, Spanish, French, German, Portuguese, Italian, Japanese, Korean, Chinese, Hindi, Arabic). |
| **Memory** (`memory.tsx`) | Untitled: Reference saved memories (switch); Learn from past chats in the background (switch, disabled while memory is off, `memoryBackgroundLearning`); Memories, "See what Juno remembers, change it or forget it." with an outline "Manage" to `/memory`. **Sensitive subjects**, "Juno doesn’t learn these on its own. Anything you ask it to remember is always kept.": one switch per topic (`SENSITIVE_TOPIC_META` in `src/lib/memory-sensitive.ts`, field `memorySensitiveTopics`). **Background work**, "Memory, chat titles, summaries and moderation run without you asking.": Who may read your chats for it (The lab I chat with · Any configured lab · Juno’s own models only, plus the legacy "A provider I chose"). |
| **Models** (`models.tsx`) | Untitled: Default model (a combobox with Auto; description "New chats start on this model. You can switch in any message." or "Juno picks the model and thinking depth each message needs."). **On this device**, "Where each new message starts in this browser. The composer can change any of them.": Thinking effort (Auto, Minimal, Low, Medium, High, Extra high, Max); Fast mode, "Prefer the quickest capable model and skip extended thinking."; Web search, "Let models look things up when a message needs current information." These are **per device**, not synced. **Favorites**, "Pinned models lead the model picker, in this order." with an outline "Add"; rows with an Unpin star; "Nothing pinned yet.". |
| **Connectors** (`connectors.tsx`) | **Connected apps**, "Turn one off to block everything Juno would do in it, reading included." with an outline "Browse apps" to `/connections`: one switch row per connected app, plus blocked ones ("Not connected. Still blocked if you connect it again." / "Blocked. Juno can’t use this app." / the account label). Empty: "No apps connected" / "Connect GitHub, your calendar, mail or notes and Juno can work inside them."; error "Couldn’t load your apps" / "The list didn’t come back. Nothing has been disconnected.". **Permissions**, "Juno checks these before every action in a connected app, so a change applies to chats already open.": When Juno acts in an app (five policies with descriptions, `POLICY_COPY`); Lockdown, "Refuse every action, reading included, whatever the choice above and every approval already given."; error "Couldn’t load your permissions" / "Nothing is shown rather than a guess.". |
| **Devices** (`devices.tsx`) | **Your Macs**, "Where a task can reach a folder, an app or your signed-in browser. Open one to choose what it may do, or to revoke it.": `WorkHostRow`s (revoked last), two skeleton rows, the stale note "These are the last answers Juno got. The latest check failed, so a Mac may have woken or gone away since.", error "Couldn’t load your Macs. Anything already signed in can still be reached, with the permissions it had.", empty "No Macs yet" / "Install Juno on your Mac, sign in, and turn on Work in the app. It appears here on its own." with "Get the Mac app". A footnote: "Some actions wait for you on every Mac, whatever it is allowed to do." with the link "See what Juno always asks first" to `/permissions`. |
| **Voice** (`voice.tsx`) | **Read aloud**: Voice (a Play/Stop preview button, "Play a preview" / "Stop the preview", and a choice menu of voices with descriptions; unavailable variants "Choosing a voice needs a plan with voice." and others). A footnote on dictation and voice conversations. |
| **Data & privacy** (`data-privacy.tsx`, `import-history.tsx`, `shared-links-card.tsx`) | Untitled: Export your data, "Profile, settings, conversations, memories, projects and file details." (Export ▾: JSON "Everything, in one readable file." · Juno package "Everything, plus your Library files where they fit." · CSV "Your conversations, for a spreadsheet."); Import chat history, "From ChatGPT, Claude, Gemini or another Juno account. A .zip or .json export up to 100 MB, or drop it here." (`POST /api/import`, progress in the row). **Shared links**, "Anyone with one of these links can open what it shows.": rows (chat or artifact glyph, title or "Untitled", "Chat · {date} · {n} views", Copy link, Revoke); "Nothing shared yet. Links you make from a chat or an artifact appear here."; "Couldn’t load your shared links." with "Try again". Destructive: Delete all conversations, "Every chat and its messages, at once. Memories and projects stay." → "Delete all conversations?" / "Every conversation and its messages are deleted for good. Memories and projects stay. This can’t be undone." / "Delete all conversations" (`DELETE /api/conversations`; "All conversations deleted." / "Couldn’t delete conversations."). |
| **Account** (`account.tsx`, `src/components/auth/account-security.tsx`) | The profile block: the avatar ("Change profile picture", `POST /api/profile/avatar`; "Profile picture updated."), the name and email, an outline "Change name" that opens Personalization. **Sign-in and security**: Two-step verification ("On" badge; "Set up…" / "Turn off…", with the set-up, recovery-codes and turn-off dialogs); Password ("Changing it signs out every other device." or "This account signs in with Google or Apple, so it has no password."); Email address, "The address you sign in with. A link to the new address confirms the change."; This session, "Sign out on this device. Other devices stay signed in." (Sign out); Sign out everywhere, "Ends every session on every device, including this one. Use it if you've lost a phone or laptop.". **Notifications** (email): Budget alerts, "An email when you reach 80% of your monthly budget."; Weekly digest, "A recap of your usage every Monday."; then the browser rows ("When something needs you", "Approvals and questions a task or an agent is waiting on."; "Updates", "Finished tasks, and ideas your agents want to share."). Destructive: Delete account, "Chats, memories, files and your subscription, all at once. Export first if you want a copy." → "Delete this account?" with "Type {email} to confirm" and "Delete permanently". |
| **Plan & usage** (`billing.tsx`, `usage-history.tsx`) | The plan block: the name (with an "Active" badge while generating is possible), the tagline, "€{n} a month, excluding VAT." or "Free.", then "Renews {date}." / "Access ends {date}."; actions "Upgrade" (primary, Free) or "Change plan" and "Manage billing" (outline, `POST /api/stripe/portal`). **Usage**: unlimited text, the Free sentence, or three meters (This month "€x left of €y"; Current session "A rolling 5-hour window." / "Resets in {2h 14m}" / "Resetting now."; This week "A rolling 7-day window." / "Resets {moment}"). **Spend ceiling**: Monthly ceiling (whole euros 0–100,000, placeholder "Default", Save; the cap-source note; the switched-off warning). **History**, "Replies per day across chat, code and tasks.": 30 day bars with arrow-key reading, "Nothing in the last 30 days.", "Your usage history couldn’t be loaded.". Data: `GET /api/profile/usage` (quota, spend, windows, billing) and `/breakdown?days=30`; the ceiling is `PATCH /api/settings {monthlySpendCapEur}`. |

### 0.8 Upgrade (`src/app/(app)/upgrade/page.tsx`, `src/components/billing/plan-cards.tsx`, `src/lib/plans.ts`)

- **A page:** eyebrow "Plan", heading "Upgrade", lede "You’re on the {Plan} plan. Every paid plan unlocks all models with a monthly limit based on tokens — upgrade any time, changes apply instantly.".
- A Monthly / Yearly segmented control, only when annual plans are purchasable, with "Billed monthly." or "Twelve months up front — same price, one invoice.".
- **Cards:** Free, Pro ("Recommended"), and Max with a ×5 / ×10 segmented switch. Each card has a price ("0 €", "20 €", "100 €"; with "excl. VAT / mo" or "/ yr") and the plan's features.
- **Card actions:** "Current plan" (disabled), "Upgrade to {Plan}" (`POST /api/stripe/checkout {plan, interval}` → redirect; "Redirecting…"), "Downgrade" / "Manage" (the portal).
- The fair-use line, a "Questions" FAQ with five disclosures, and the terms line.
- **Which plans are purchasable** comes only from server-rendered app data (`features.purchasablePlans`, `purchasableAnnualPlans`). No API exposes it to native clients.

### 0.9 Onboarding and announcements

- **Onboarding** (`src/components/app/onboarding.tsx`):
  - Shown once per browser (`juno:onboarded:v1`), and only when the account has no conversations.
  - A dialog over a dot-field backdrop: "Welcome to Juno", "Three quick choices, all optional. Everything here is in Settings later.".
  - "What should Juno call you?" (placeholder "Your first name"); Theme tiles Light / Dark / System (local only); Accent swatches (saved to the account).
  - "Start chatting" (primary; saves the name) and "Skip for now" (ghost).
  - It suppresses announcements while open.
- **Announcements** (`src/components/app/announcement-popup.tsx`, `GET /api/announcements` → `{announcement}`, `POST /api/announcements/{id}/dismiss`):
  - A dialog with the visual on top: a muted looping video (paused with controls under Reduce Motion), an image, a provider logo, or the Juno mark.
  - An optional model-name line, the title, the description.
  - Then "Read more" (or `newsLabel`, outline) when there is a `newsHref`, else a ghost "Not now", and the primary `ctaLabel` with an arrow when there is a CTA.
  - Closing dismisses it. Dismissals are also kept per browser. Both endpoints accept the native bearer (`getCurrentUser` reads it).

### 0.10 Notifications (context only)

The inbox row, the popover and the "Needs you" signals are Phase 5 Stage C's (`MACOS_PHASE5_WORK_IN_CHAT_BRIEF.md` §5). Phase 3 carries two things: ⌘K's "Open notifications" row, and the Settings window's restyle of main's "Notifications on this Mac" section (Account).

### 0.11 The Mac at `250b5b13`

- **Menu bar** (`App/DesktopCommands.swift`): Phase 1's minimum. It has:
  - File: New Chat ⌘N, New Private Chat ⇧⌘N, a second "New Chat" ⇧⌘O, Open Folder… ⌘O (Code), Attach Files… ⌘U, Attach Screenshot… ⇧⌘U, Find in Juno… ⇧⌘F, Ask Juno… ⌥Space
  - Edit: Find in Conversation ⌘F / ⌘G / ⇧⌘G
  - View: Chat ⌘1 / Code ⌘2 plus the system sidebar and toolbar items
  - Window: Tasks (Legacy)
  - a Session menu for Code, whose ⌘K opens Code's palette
  - Help: Juno Help and Keyboard Shortcuts ⌘/

  There is no Chat menu, no ⌘K in Chat, and no ⇧⌘C, ⇧⌘; or ⇧⌘L.
- **Keyboard Shortcuts window** (`App/DesktopShortcutsWindow.swift`): a hand-written three-column `Table` with zebra rows and a "{n} shortcuts" count, not derived from the menu.
- **Menus are mostly on the recipe already.** `.menuStyle(.button)` plus `.menuIndicator(.hidden)` is used on the sidebar's More and row menus, the composer's `+`, the voice call bar and the reply actions. `DesktopConversationMenu` (in `DesktopChatSidebar.swift`) is one list shared by the row, the hover menu and the title menu, but its rows have no glyphs.
- **The deprecated `.borderlessButton` remains at 22 sites:**

  | File | Sites | Owner |
  |---|---|---|
  | `DesktopWorkWorkspace` | 5 | Phase 5 D deletes it |
  | `DesktopProjectsScreen` | 4 | Phase 4 |
  | `DesktopWorkSettings` | 2 | Phase 4 C / Phase 5 D |
  | `DesktopDesignScreen` | 2 | deleted by Phase 4 A |
  | `DesktopArtifactCanvas` | 2 | Phase 4 A |
  | `DesktopLibraryScreen` | 1 | Phase 4 |
  | `DesktopArtifactsScreen` | 1 | Phase 4 |
  | `ResearchViews` | 1 | Phase 5 B |
  | `DesktopVoice:939` | 1 | **Stage A** |
  | Code's `CodePreviewWindow` and `SimulatorPane` | 3 | the Code session |
- **View-level chords that the menu bar will own:** the stop face's ⌘. (`ChatComposer.swift:686`), and the `+` menu's ⌘U and ⇧⌘U (`ComposerPlusMenu.swift:92, 104`).
- **Search** is a page (`App/DesktopSearchScreen.swift`, the `.search` destination, routed in `DesktopAccountScreens.swift:99`), opened by the sidebar's Search button and ⇧⌘F through `DesktopChatWorkspace.openSearch()` (`:704`). The on-device index is `NativeSearchModel` / `NativeSearchStore` in JunoChatKit, not in the page file.
- **Share** is an interim popover (`ChatToolbar.swift`, `DesktopShareResultPopover`, 360 × 132): it copies the link and says so. It has no Copy button and no Revoke. `NativeShareClient` has create, list and revoke for chats only.
- **There is no Outputs item** (`ChatToolbar.swift` says it waited for a per-chat model).
- **Account popover** (`DesktopAccountFooter.swift:339-508`): Profile…, Settings…, Admin Panel, Sign Out. The plan pill is in mono. The usage block says "This week" with a percentage. There is no Upgrade and no Keyboard Shortcuts row.
- **There is no Archived Chats surface.** `NativeConversationStore.setArchived(id:archived:)` exists, and synced rows carry `archivedAt`.
- **Dialogs on chat surfaces are mostly right.**
  - Delete conversation: title and message are the web's; the button says "Delete", not the web's "Delete chat".
  - Leave private chat, regenerate-with-artifacts and delete project: all as specified.
  - The sidebar renames inline through `JunoInlineRenameField`.
  - Rename… from the title menu relies on the sidebar being visible.
- **`junoSheetSurface` on the Mac:**

  | Where | Owner |
  |---|---|
  | `DesktopChatWorkspace.swift:1325` (image edit), `DesktopLibraryPicker.swift:161` | **B** |
  | `DesktopSettingsScreen.swift:540, 1494` | **C** |
  | `DesktopProjectsScreen` ×2, `DesktopLibraryScreen`, `DesktopAccountScreens.swift:572` | Phase 4 |
  | `DesktopTasksScreen` | dead |
  | `DesktopCodeWorkspace` ×2 and three Code package sites | Code |
  | `NativeAgentPage` and `NativeAgentHire` | shared WorkKit views, Phase 4 C |
- **Settings** (`DesktopSettingsWindow.swift`, `DesktopSettingsScreen.swift`):
  - The sections are General · Personalization · Memory · Models · Connectors · Voice · Code · Data & privacy · Account · Plan & billing.
  - Each pane carries a Mac-written subtitle.
  - Connectors embeds the whole Connections page, Memory embeds the Memory page, and Plan & billing embeds `DesktopUsageScreen` (a page of cards: plan, stat strip, activity heatmap, where it went, token mix, pace, most used models).
  - Personalization uses "Response style" tiles and a Save/Revert editor.
  - The Settings window has its own `JunoToastCenter`.
  - `DesktopSettingsSection` raw values, the `.usage` and `.connections` aliases and `DesktopSettingsRouter.open` are used by Code, the account footer and the preview root.
  - `DesktopSettingsMetrics.editorMinHeight` and `.confirmWidth` are used by `DesktopAccountScreens.swift` (Phase 4).
- **Settings writes:** `NativeMemorySettingsStore.updateSettings(NativeSettingsPatch)` covers theme, accent, default model, custom instructions, response language, interface locale, personality, memory on/off, favorites, the two emails, background provider and voice. It does **not** cover the name, background learning, sensitive topics, connector policy, lockdown, blocked apps or the spend ceiling. `NativeUsagePlan` decodes the plan, the session and weekly windows, the budget and renewal, but **not** `quota` or the spend fields.
- **`junoTextScale` exists and nothing sets it** (`JunoTypography.swift:343`); prose, markdown and the greeting already read it. The theme reaches the main window (`JunoDesktopRootView.swift:49-64`) and Quick Entry, but not the Settings window. `JunoAccent` has the six presets and no custom colour.
- **There is no onboarding or announcement surface on the Mac.**

### 0.12 Corrections to the spec (today's web wins)

| Spec | Web today | Phase 3 does |
|---|---|---|
| §7.2 sections end "Plan & billing" | "Plan & usage", with **Devices** between Connectors and Voice | Web order and labels; the Mac-only Code section stays last (register P3-3) |
| §7.2 Models: Fast mode and Web search as **synced** settings | "On this device": per device, like thinking effort | Per device (`@AppStorage`, the composer's own keys) |
| §7.2 Account: usage stats and heatmap move to Account | History (30 day bars) is in Plan & usage; nothing in Account | History in Plan & usage; the other usage cards go (owner question §8.2) |
| §7.2 Plan & billing: invoices | None | None |
| §7.2 Voice: dictation Pickers (Transcription, Voice mode) | Read aloud only, plus a footnote | Read aloud plus the Mac's true dictation sentence |
| §7.2 General: text size | Six steps, 14–20px, per device | Six steps → `junoTextScale` (C5) |
| §7.3 Share: Copy Link, Revoke, "Snapshot of Sep 22 · 14 views" | Copy / Copied, "Revoke link", "Snapshot · Sep 22, 2026 · 14 views", revoked and blocked states | The web's states and words, in a popover, with "More…" kept (P3-16) |
| §7.4 one filter row always, a date `Menu` | Filters only once there is a query; date chips | Filters only with a query; dates and projects as menus (P3-11) |
| §7.4 height animated from 56 | A fixed floor (13rem) so the shape never changes while typing | A 56pt field plus a 208pt list floor (B1) |
| §7.4 matched run in semibold | Coral mark (`primary/15`, `primary-ink`) | Semibold, neutral, as find does (P3-10) |
| §7.4 empty query: actions then five chats | Command menu: Actions, Chats, Code sessions, Projects, Settings; Search: Recent | The web's two lists, one per mode |
| §2.7 account rows: Profile…, Settings…, Admin; no Upgrade | Settings, Upgrade plan, Admin panel; Get the apps, Keyboard shortcuts; Sign out | The web's rows, less "Get the apps" (P3-15) |
| §7.1 Archived Chats as a `.page` sheet | A small dialog (`max-w-md`) | A fitted sheet, 480 × 520 (B5) |
| §7.12 onboarding writes the web's settings patch | The name and the accent go to the account; the theme stays in the browser | Name, theme and accent all to the account, because the Mac's theme is the account's (P3-9) |

---

## 1. Decisions

Parity decisions follow the web. They are recorded in a new "Phase 3 errata" section of the spec at integration (§6). Deliberate differences get a **provisional** register number `P3-n`, listed in Appendix C; the integration step renumbers them after whatever Phase 4 and Phase 5 have taken.

| # | Decision | Why | Recorded |
|---|---|---|---|
| 1 | **One registry, `JunoShortcutRegistry`, generates the menu bar and the Keyboard Shortcuts window.** No chord is typed anywhere else in the Chat window. View-level `.keyboardShortcut`s that duplicate a menu chord are removed (the stop face's ⌘., the `+` menu's ⌘U and ⇧⌘U). | Spec §7.8–§7.9; one chord, one place (§10.2 rule 7). | Errata; P3-19 |
| 2 | **One ⌘K item, in View.** "Command Menu…" opens the Juno panel in Chat and Code's own palette in Code (until the Code session retires it). The Session menu loses its ⌘K row. | Two menu items on one chord depend on AppKit's disabled-item matching; one item cannot collide. | Errata |
| 3 | **A Chat menu** with the web's global chat keys plus the Mac's: Attach Files… ⌘U, Attach Screenshot… ⇧⌘U, Focus Composer ⇧⎋, Stop Generating ⌘., Regenerate ⌘R, Copy Last Response ⇧⌘C, Copy Last Code Block ⇧⌘;, then the conversation items from `DesktopConversationMenu`. | Spec §7.8 and `use-global-shortcuts.ts`. | Errata; P3-21 |
| 4 | **View › Switch to Dark Mode / Switch to Light Mode ⇧⌘L** writes the account theme, as the web's ⌘⇧L does. | Parity. | Errata |
| 5 | **Menu rows carry the web's glyphs** (16pt `Label`s), in Title Case with the web's words. | Spec §7.1; the web's row menu has a glyph per row. | Errata |
| 6 | **Search and ⌘K are one panel with two modes**, Commands (⌘K) and Search (⇧⌘F, the sidebar button). "Search everything" switches mode and keeps the query. | Register #7 already. | — |
| 7 | **Search results:** chats, messages, projects, files and artifacts come from the on-device index (works offline, full text of synced messages); memory, knowledge and tasks come from `/api/search`. With no query, Search mode lists `GET /api/recents?limit=8` (the local store when offline). | Spec §7.4 engine; the web's message search is bounded by encryption at rest (`src/lib/search/types.ts` header). | P3-12 |
| 8 | **Filters only with a query**, as on the web; the nine type chips in one row; date and project as two menus beside them. | The web's parity for when; menus for the Mac's width. | P3-11 |
| 9 | **Matched words are semibold in the row's ink, never coral.** | Accent budget (§0.4); the find bar's highlights are neutral too. | P3-10 |
| 10 | **Command rows whose page is not built are absent, not disabled**: Skills, Automations, Permissions, Assistants, New automation, New assistant (Phase 4); Open notifications (Phase 5 C). They appear when their hook is wired (§2.3). **Left out on the Mac:** "Open pull requests" (Code's own palette) and "Compare models" (no Mac Compare page). "Roadmap & feature requests" opens the web. | Spec §2.3 "unbuilt items are absent"; §9 "Compare, Roadmap: not in this pass". | P3-13 |
| 11 | **"New private chat ⇧⌘N"** is a Command row on the Mac. | The Mac has the chord and private mode inline; spec §7.4. | P3-14 |
| 12 | **Share stays a popover**, with the web's five states and words, plus the system "More…" share item. | Spec §7.3; a toolbar-anchored popover is the Mac idiom. | P3-16 |
| 13 | **The Outputs chip and popover follow `session-outputs.tsx`.** Artifacts open the canvas dock; uploads and images open Quick Look. | Parity; Quick Look is register #19. | P3-17 |
| 14 | **Account popover = the web's menu**, less "Get the apps" (this app is the download; the iPhone link is on the web's download page). The plan pill is SF, and the usage block says "Messages {used} / {limit}" or "No cap". | §0.5. | P3-15 |
| 15 | **Archived Chats is a fitted sheet** at the web's small size. A failure inside it shows under its row, never as a toast (no toasts in sheets). | Spec §7.1 "no toasts inside sheets". | P3-18 |
| 16 | **Settings follows today's web**: its order, labels, rows, words and save status. The system grouped form stands in for the web's flat rows. The Mac keeps a search field, About (version, updates, diagnostics) in General, and the Code section last. | §0.7; spec §7.2; A5. | P3-1, P3-2, P3-3 |
| 17 | **Settings panes carry no Mac-written subtitles**; the title bar says the section's name. | The web's pane has a title only. | Errata |
| 18 | **"On this device" reads "on this Mac"** in Models' note. | The web's sentence says "in this browser", which is untrue here. | P3-4 |
| 19 | **Interface language is not shown on the Mac** until the Mac ships a string catalogue: the row would change nothing on this device. | §10.2 rule 13 (no silent controls). | P3-5; owner question §8.1 |
| 20 | **Text size** is six steps stored per Mac (`@AppStorage("juno.textSize")`, the web's ids) and drives `junoTextScale` (px / 16) in the Chat window, Settings and Quick Entry. System chrome (sidebar, menus, toolbar) keeps macOS's own sizes. | Web per-device rule; the Mac's sidebar follows System Settings. | P3-6 |
| 21 | **A custom accent** follows the web's rule (hex → HSL, lightness clamped to ≥ 55 in dark and ≤ 55 in light, white on-accent below 60). The focus ring stays neutral. | `app-provider.tsx:227-256`; spec §8.1 keeps the graphite ring. | P3-7 |
| 22 | **Upgrade is a native sheet with Monthly only**, until the server tells native clients which plans and intervals are for sale. Checkout and billing open in the browser (Stripe). | §0.8: no API exposes `purchasablePlans`. | P3-8; API gap |
| 23 | **Plan & usage absorbs the Usage page the web's way** (plan, three meters, spend ceiling, 30 day history), and `DesktopUsageScreen.swift` is deleted. The Mac-only cards (heatmap, where it went, token mix, pace, most used models) are not carried over. | §0.7. | Owner question §8.2 |
| 24 | **Devices**: this Mac's own host switch first (`DesktopWorkHostTile`, moved out of Settings › Code), then the web's "Your Macs" list. On the Mac, the empty state offers this Mac's switch instead of "Get the Mac app". | You are on the Mac. | P3-23 |
| 25 | **Onboarding writes the name, theme and accent to the account**, and has no dot-field backdrop. | The Mac's theme is the account's; no decoration (§10.2 rule 5). | P3-9 |
| 26 | **Sign Out keeps its confirmation on the Mac** ("Juno removes this Mac's local copy…"). | It deletes local data; the web's does not. | P3-24 |
| 27 | **Group headings in the Shortcuts window are SF 13 medium**, not the web's mono label. | §10.2 rule 6; extends Phase 4's #57/#71. | P3-22 |
| 28 | **The Keyboard Shortcuts window** keeps a Code group and the Mac-only keys (⌘1/⌘2, ⌃⌘S, ⌥Space, ⇧⌘N, ⇧⌘F, ⌘., ⌘R). | Register #4; the Mac has these chords. | P3-20 |
| 29 | **Settings entry points that land on pages** (Memory "Manage", Connectors "Browse apps", Devices rows and "See what Juno always asks first") open the page in the main window through hooks that stay unset until Phase 4's router is merged. | Phase 4's `DesktopPageRouter` is not on this base. | Integration (§6) |

---

## 2. How the three stages run in parallel

### 2.1 Who owns which files

A file listed under a stage is edited **only** by that stage. "Bounded" means the stage may change only the named region; anything else in that file belongs to someone else.

| Stage A | Stage B | Stage C |
|---|---|---|
| **New:** `App/JunoShortcutRegistry.swift`, `App/ChatCommands.swift` (the Chat menu's actions: copy last response / code block, regenerate, stop, focus), `Tests/JunoShortcutRegistryTests.swift`, `Tests/ChatCommandsTests.swift`, `Tests/Snapshots/ShortcutsSnapshotTests.swift`, `scripts/check-native-menus.mjs` | **New:** `App/DesktopSearchPanel.swift` (glass allow-listed by name already), `App/DesktopSearchPanelModel.swift`, `App/DesktopCommandCatalog.swift`, `App/DesktopSharePopover.swift`, `App/DesktopOutputsPopover.swift` (with the pure `ChatSessionOutputs`), `App/DesktopArchivedChatsSheet.swift`, `JunoChatKit/NativeUnifiedSearchClient.swift` (search and recents), tests, `Tests/Snapshots/OverlaySnapshotTests.swift` | **New:** `App/DesktopSettings{General,Personalization,Memory,Models,Connectors,Devices,Voice,Data,Account,Plan}Pane.swift`, `App/DesktopSettingsRows.swift` (row, save status, group header), `App/DesktopUpgradeSheet.swift` (+ `DesktopPlanCatalog`, `DesktopUpgradePresenter`), `App/DesktopOnboardingSheet.swift`, `App/DesktopAnnouncementSheet.swift`, `App/DesktopFirstRunPresenter.swift`, `App/DesktopTextSize.swift`, `App/DesktopSettingsLinks.swift`, `JunoChatKit/NativeBillingClient.swift`, `NativeAnnouncementsClient.swift`, `NativeAccountSecurityClient.swift`, `NativeImportClient.swift`, tests, `Tests/Snapshots/SettingsSnapshotTests.swift` |
| **Rewritten:** `App/DesktopCommands.swift`, `App/DesktopShortcutsWindow.swift` | **Rewritten:** `App/ChatToolbar.swift`, the popover in `App/DesktopAccountFooter.swift` | **Rewritten:** `App/DesktopSettingsWindow.swift`, `App/DesktopSettingsScreen.swift` (becomes the pane switch); **deleted:** `App/DesktopUsageScreen.swift` |
| **Bounded:** `DesktopChatWorkspace.swift`: the `workspaceActions` property (`:764-795`), one new `chatCommands` property beside it, and one `.focusedSceneValue` line beside `:268`. `DesktopChatSidebar.swift`: the `DesktopConversationMenu` struct only (`:719-777`). `ChatComposer.swift`: remove the stop face's chord (`:686`) and publish the stop and focus requests. `ComposerPlusMenu.swift`: remove the two in-menu chords (`:92, 104`) and audit the rows. `DesktopVoice.swift`: both options menus (`:573-590`, `:895-945`). `MessageActions.swift`: audit only. `JunoDesktopWorkspaceView.swift`: one `toggleTheme` field on `DesktopShellActions`. `scripts/check-native-design.mjs` (register the rule), `package.json` (one script line), `scripts/check-native-design-baseline.json` (the new `menus` key only) | **Bounded:** `DesktopChatWorkspace.swift`: `openSearch()` (`:704`), the panel overlay (one modifier on the split view), the Archived Chats and share presentation, the delete dialog's button (`:275`), the image-edit sheet's `junoSheetSurface` line (`:1325`), and the toolbar's new arguments (`:470`). `ChatDetail.swift`: the detail column's frame for the panel's position, and the toolbar arguments. `DesktopLibraryPicker.swift:161` (sheet fill). `JunoChatKit/NativeShareClient.swift` (artifact kind, blocked state). `contracts/openapi/juno-native-v1.yaml` (`/search`, `/recents`, `/share`, `/share/{id}`, `/conversations` `archived` parameter) | **Bounded:** `JunoChatKit/NativeMemorySettingsStore.swift` (the new settings fields, additive), `JunoChatKit/NativeUsageBreakdown.swift` (`quota` and `spend`, additive), `JunoChatKit/NativeAccountDataClient.swift` (delete all, the Juno package export), `JunoDesignSystem/JunoAccent.swift` (custom accent, additive, API kept), `JunoDesktopRootView.swift` (the text-scale environment and one `.desktopFirstRunSheets()` line that attaches the first-run and Upgrade presenters, nothing else), `DesktopQuickEntry.swift` (one environment line), `DesktopSettingsSection` and `DesktopSettingsRouter` (add, never remove: `.usage`, `.connections` and `DesktopSettingsMetrics`'s members stay), `contracts/openapi/juno-native-v1.yaml` (`/announcements`, `/account/*`, `/profile/avatar`, `/profile/usage` fields, `/settings` fields, `/stripe/*`, `/import`, `DELETE /conversations`) |

**Nobody in Phase 3 touches** (other lanes own them):
- **Phase 4:** the page files (`DesktopLibraryScreen`, `DesktopProjectsScreen`, `DesktopProjectPage`, `DesktopArtifactsScreen`, `ArtifactPage*`, `DesktopConnectionsScreen`, `DesktopAccountScreens.swift`, the Memory, Skills, Assistants, Automations and Permissions screens), `DesktopArtifactCanvas.swift`, `DesktopNavigationState.swift`, `DesktopPageRoute.swift`, everything in `DesktopChatSidebar.swift` except `DesktopConversationMenu` (the `DesktopDestination` enum included), `JunoDesktopConfiguration.swift`, `DS/JunoPage.swift` and `JunoRenameSheet.swift`.
- **Phase 5:** `ChatWorkRunCard.swift`, `ChatWorkPanel.swift`, `ChatWorkApprovals.swift`, `ChatWorkDeliverables.swift`, `ApprovalCard.swift`, `ResearchViews.swift`, `ActivityPanel.swift`, `DesktopMenuBarExtra.swift`, `DesktopWorkbenchRegistry.swift`, the WorkKit sources, and the sidebar's Needs-you, Agents and Notifications code.
- **Code:** everything under `JunoCode/`, and `DesktopCode*.swift`. A Phase 3 stage may make only a mechanical rename there to keep Code compiling.
- **Also left alone:** `DesktopSearchScreen.swift`, which B stops routing to (the integration step deletes it, §6), and `DesktopWorkWorkspace.swift`.

### 2.2 Shared files, and how to keep merges clean

| File | Rule |
|---|---|
| `DesktopChatWorkspace.swift` | A and B only, in the regions named in §2.1. Put new logic in your own new files as `extension`s or small views, and pass state in; keep the edit here to wiring. If a needed `private` must become internal, change only that one declaration. |
| `JunoDesktopRootView.swift` | C only, within the lines named. p4-A and p5-B each add two lines too; the integration merges them. |
| `project.pbxproj` | Generated. Every lane runs `native/Scripts/generate-projects.sh` after adding or removing files; the integration regenerates, it never hand-merges. |
| `juno-native-v1.yaml` and `JunoNativeContract.swift` | B and C each insert their paths in **alphabetical position**, in the file's existing style, and never re-sort or reflow other entries. Regenerate the Swift contract (`node scripts/generate-native-swift-contract.mjs --output=native/Packages/JunoNativeKit/Sources/JunoAPI/Generated/JunoNativeContract.swift`) so `native:contract:check` stays green; the integration regenerates it again. `info.version` does not change (additive). |
| `scripts/generate-native-icons.mjs`, `JunoBrand.swift` (`JunoIcon`), the icon catalogues | **`Keyboard` is needed by both A and B, so both make the identical edit at the identical place** (identical changes merge cleanly): the line `  Keyboard: "Keyboard",` directly after `  Monitor: "Monitor",` in the generator's `PHOSPHOR` map (`:204`); the line `    case keyboard` directly after `    case sun, moon, monitor, home2` in `JunoIcon` (`JunoBrand.swift:162`); and `        case .keyboard: "ph.keyboard"` directly after `        case .monitor: "ph.monitor"` (`:349`). Every other new glyph is one stage's, appended **at the end** of the relevant block with a comment naming the stage: B adds `MapTrifold`; C adds `Camera` and `Star`. Add a `JunoIcon` case only for a glyph you draw. Run `npm run native:icons` and `native:icons:check`. The integration unions the lists and regenerates. |
| `scripts/check-native-design-baseline.json` | Counts that fall pass without re-baselining; **do not re-baseline to record a fall**. Re-baseline only to raise a count, with the reason in the commit body. A adds one new key (`menus`). The integration re-locks every rule. |
| The spec, the handoff, `WEB_TO_NATIVE_DESIGN.md` | **Not edited by the stages.** Each stage writes its errata, register entries (with their `P3-n`), runtime checks left and follow-ups into its own new file, `docs/native/phase3/STAGE-{A,B,C}-NOTES.md`, and repeats the essentials in its commit body. The integration folds them into the spec's "Phase 3 errata", the register and `MACOS_REDESIGN_HANDOFF.md`. |

### 2.3 Seams: hooks each stage leaves, and what the integration wires

A hook is an optional closure. **While it is `nil` the control it drives is absent, not disabled.** Each seam below is written so that every stage builds, tests and looks right on its own.

| # | Seam | Left by | Wired at integration to |
|---|---|---|---|
| 1 | `DesktopWorkspaceActions.openCommandMenu` (new field, A) | A sets it to the existing `openSearch` in Chat and to `codeActions.openPalette` in Code | B's `DesktopSearchPanelModel.present(.commands)` |
| 2 | Keycap hints in B's panel rows and the account popover | B writes literal hints | A's `JunoShortcutRegistry` lookups, plus a test that every panel hint equals the registry |
| 3 | `DesktopCommandCatalog.Hooks.openNotifications` | B | Phase 5 C's notifications popover opener |
| 4 | `…Hooks.openUpgrade`, and the account popover's `openUpgrade` | B | C's `DesktopUpgradePresenter.shared.present()` |
| 5 | `…Hooks.openPage(DesktopPanelPage)`: skills, automations, newAutomation, assistants, newAssistant, permissions, designs, newDesign, newAgent | B | Phase 4's `DesktopPageRouter` (`open(_:route:artifactsType:)`) |
| 6 | `…Hooks.openTaskRecord(sessionID)`: a Tasks hit without a conversation | B | Phase 5 D's `DesktopTaskRecordSheet` |
| 7 | `DesktopSharePopover(target: .artifact(id))` | B | Phase 4's `shareArtifact` hook on the Artifacts page (and the canvas dock) |
| 8 | `DesktopArchivedChatsSheet` presentation (`showingArchivedChats` in the workspace) | B | Phase 4 C's `openArchivedChats` hook on the sidebar's More |
| 9 | `DesktopAccountUsage.init(plan:)` (B's value for the usage block) | B reads today's fields | C's `NativeUsagePlan.quota` ("Messages {used} / {limit}") |
| 10 | `DesktopSettingsLinks.shared`: `openMemory`, `openConnections`, `openHost(id)`, `openPermissions` | C | Phase 4's `DesktopPageRouter` (+ bring the main window forward) |
| 11 | C's interim `DesktopSettingsHostRow` | C | Phase 4 C's `DesktopWorkHostRow`; delete C's row |
| 12 | The composer's `openUpgrade` (`DesktopChatWorkspace.swift:1999`, today Settings › Plan & billing) | — | C's presenter |
| 13 | The theme toggle, written twice (A's ⇧⌘L via `DesktopShellActions`, B's ⌘K row) | A and B | One `DesktopThemeToggle` helper |
| 14 | "What Juno noticed" (on-device proposals), still in Settings › Memory | C keeps it until the Memory page's Edits exist | Phase 4 B's Memory page; then delete it from Settings |

### 2.4 Rules every stage follows

**Work.**
- **Where:** your worktree and branch only (the table at the top). Use absolute paths, with `cd <worktree> && …` in every Bash call. The shell is zsh; write non-trivial scripts to a file and run them with bash.
- **Long jobs:** anything that may run longer than about two minutes goes in the background and is polled with short calls.
- **Builds:** at most one build at a time, always `-jobs 2`; build iOS once, at the end of the stage. Use derived data under your lane's own prefix (`/tmp/jgL<n>-*`, from your task).
  ```sh
  cd <worktree>
  xcodebuild -jobs 2 -project native/macOS/JunoDesktop/JunoDesktop.xcodeproj -scheme JunoDesktop -configuration Debug \
    -destination 'platform=macOS' -derivedDataPath /tmp/jgL<n>-mac CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= build
  #   … the same with `-only-testing:JunoDesktopTests test` for the unit tests (never the UITests target)
  xcodebuild -jobs 2 -project native/iOS/JunoMobile/JunoMobile.xcodeproj -scheme JunoMobile \
    -destination 'generic/platform=iOS Simulator' -derivedDataPath /tmp/jgL<n>-ios CODE_SIGNING_ALLOWED=NO build
  JUNO_SWIFT_SCRATCH=/tmp/jgL<n>-swift npm run native:test JunoNativeKit     # when you touched a package; JunoAuthTests alone if it hangs
  npm run design:tokens:check && npm run native:icons:check && npm run native:contract:check && npm run native:design:check \
    && npm run native:design:type && npm run native:design:motion && npm run native:design:glass && npm run native:design:targets
  ```
- **Git and safety:** never push, deploy or download. Commit only a green tree, at the end of the stage and at safe checkpoints, with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Keep iOS and Code compiling; shared-package changes are additive, with defaults that leave iOS unchanged. Never delete user-data paths.

**Design law for these surfaces.**
- **Glass** only on the ⌘K panel (and the existing composer, find bar, toast host, Quick Entry and Scroll to latest). Popovers and sheets are system-presented and draw no custom background: no `presentationBackground`, no `junoSheetSurface`, no glass inside them, no toast inside a sheet. Content inside the panel is not glass: rows are plain, with `junoGlassHover` for the active row.
- **Accent (coral):** switches, sliders and progress; links and accent text; the send/stop disc; and **one** prominent button per surface, always `.buttonStyle(.junoProminent)` (never raw `.borderedProminent`, never system blue). Outline buttons are `.bordered` with `.tint(nil)`. A refusal or delete uses the destructive ink, not a fill. Selection is neutral.
- **Radii:** control 10 · field 12 · menu 14 · card 16 · panel 20, concentric inside a container (`.containerShape` plus `ConcentricRectangle`).
- **Type:** at least three levels on every surface, from `JunoType`: title / heading / body or ui / caption. SF throughout. Mono only for code, ids, counts, costs, durations and keycaps (the `micro` rung). No uppercase, no letter-spaced or mono micro-labels, no eyebrows.
- **Copy:** web words verbatim in content, with their curly apostrophes and dashes. Title Case in native menus, the menu bar and buttons (macOS convention, the same words). New Mac-only copy is plain, has no em dash, and is listed in Appendix A.
- **Symbols:** `ph.*` and `juno.*` only, through `scripts/generate-native-icons.mjs`. `.help` and an accessibility label on every icon-only control.
- **Targets:** 28pt pointer targets with `.contentShape`.
- **Motion:** `JunoMotion` rungs. Rise-in is 4pt on `outSoft` 220ms; leaving is `in` 160ms. Under Reduce Motion, travel and scale go to 0, loops stop and opacity keeps its timing. Under Reduce Transparency the panel draws the popover fill with a hairline. Under Increase Contrast the panel's edge strengthens.
- **Crash rules:** one `NavigationSplitView` per window; every popover and overlay panel has an explicit `.frame`; toolbar items are declared once and hidden with `ToolbarContent.hidden(_:)`, never added or removed; opening the ⌘K panel first closes any anchored popover.

**The design skills** (the owner asked for them): invoke `swiftui-design-skill`, then `design-taste-frontend`, before designing.
- **5-Dimension Review.** Score every surface you build on Philosophy, Hierarchy, Craft, Functionality and Originality (1–10) from its snapshot, in both appearances. Fix anything under 7 before committing, and write the scores in the commit body and your stage notes.
- **One signature detail per surface** (named in each stage). Nothing else on that surface competes with it.
- **Full states:** loading (skeleton rows at the rows' own pitch, not spinners), empty and error on every list.
- **Contrast:** WCAG AA for button labels and field text; `junoTertiaryInk` only for text of 13pt and up that is not essential.
- **Honest content:** no decorative dots (a dot always means a real state), and no fake precision (fixtures use plausible, unround figures; the UI never shows a number the server did not send).
- **Copy self-audit** before each commit: every visible string you added or moved. Web strings match byte for byte; new strings read plainly.

**Snapshots.** Add fixtures to the offscreen harness (`native/macOS/JunoDesktop/Tests/Snapshots`). Render into `/tmp/juno-glass-snapshots/phase3-<a|b|c>/` with `TEST_RUNNER_JUNO_SNAPSHOT_DIR` (and `TEST_RUNNER_JUNO_FINAL_SNAPSHOT_DIR` for window compositions), in light and dark. **Look at every PNG with the Read tool** and fix what is wrong before committing.
- Glass is drawn with its Reduce Transparency recipe (`junoSnapshotOpaqueGlass`).
- Menus and the menu bar cannot be photographed; `ImageRenderer` draws a `Menu` trigger as a placeholder. Cover them with unit tests instead.
- Popover content is rendered as a view at its popover frame on a stand-in popover fill.
- No screen capture or control.

### 2.5 When the web and this brief disagree

Follow the web on `origin/main`. Add the correction to your stage notes, and give a deliberate difference the next free `P3-n`.

---

## 3. Stage A: the menu bar, the shortcut registry, the Shortcuts window, and the menu recipe

One commit; checkpoints are allowed. Snapshots go in `/tmp/juno-glass-snapshots/phase3-a/`.

### A1. `JunoShortcutRegistry` (`App/JunoShortcutRegistry.swift`)

A pure table, the single source for every chord the Chat window answers to and for the Shortcuts window.
- `JunoShortcut`: `id` (`JunoShortcutID`), `menuTitle` (Title Case, with an ellipsis when it asks for more), `listLabel` (sentence case; the web's words where the web lists it), `key: KeyEquivalent?` plus `modifiers`, `keys: [String]` (one keycap each, the web's `splitKeys`: "⇧", "⌘", "F"), `group` (`.everywhere`, `.products`, `.composer`, `.responses`, `.code`), `menu` (`.file`, `.edit`, `.view`, `.chat`, `.session`, `.help`, or nil for keys that are not menu items, such as ↩, ⇧↩, ↑, /, @), `context` (`.always`, `.chat`, `.code`), `glyph: JunoIcon?`.
- **Everywhere:** Command menu ⌘K · Search ⇧⌘F · New chat ⌘N (⇧⌘O as well) · New private chat ⇧⌘N · Ask Juno from anywhere ⌥Space · Toggle sidebar ⌃⌘S · Toggle theme ⇧⌘L · Settings ⌘, · Keyboard shortcuts ⌘/. Toggle sidebar and Settings are drawn by the system (`SidebarCommands`, the `Settings` scene), so their entries are listed but have no menu placement.
- **Products:** Chat ⌘1 · Code ⌘2.
- **Composer:** Send message ↩ · New line ⇧↩ · Attach files ⌘U · Attach a screenshot ⇧⌘U · Edit your last message (empty field) ↑ · Focus the composer ⇧⎋ · Stop generating ⌘. · Commands / · Tools and connectors @. List a composer key **only if the Mac does it today**; check `ChatComposer.swift`, and drop / and @ if the palette has not landed (§7).
- **Responses:** Copy the last response ⇧⌘C · Copy the last code block ⇧⌘; · Find in conversation ⌘F · Find next ⌘G · Find previous ⇧⌘G · Regenerate ⌘R.
- **Code:** today's rows from `DesktopShortcutsWindow.swift`, moved as data.
- **Check ⇧⌘; first.** On a US layout it is ⌘:, AppKit's "Show Spelling and Grammar". The app adds no `TextEditingCommands` today, so the chord should be free; confirm that no Edit › Spelling and Grammar item appears in the built app's menu bar (read the `NSApp.mainMenu` item tree in a unit test). If it is taken, Copy Last Code Block becomes ⌥⇧⌘C, next to ⇧⌘C Copy Last Response, and the stage records it as the next `P3-n`.
- **Tests** (`JunoShortcutRegistryTests`):
  1. No chord is bound twice within overlapping contexts.
  2. No entry takes a system chord (⌘Q, ⌘W, ⌘H, ⌘M, ⌘`, ⌘⇥, ⌘Space).
  3. Every `menuTitle` is Title Case (small words excepted).
  4. Every `listLabel` is sentence case, and the rows the web lists carry the web's label byte for byte (a table in the test).
  5. Every menu entry has a glyph.
  6. The Shortcuts window's groups are exactly the registry's.

### A2. `DesktopCommands`, generated

Every menu is built by iterating the registry's entries for that menu, with `perform(_ id:)` and `isEnabled(_ id:)` resolvers over the focused values. Nothing is hand-listed except the system groups and the legacy block.
- **App menu:** Check for Updates… as today (keep `updateStatusItem`); Settings… ⌘, stays the system's.
- **File:** New Chat ⌘N ("New Task" in Code), New Private Chat ⇧⌘N, New Chat ⇧⌘O (the alias stays, as Phase 1 decided), Open Folder… ⌘O (Code), Ask Juno… ⌥Space.
- **Edit:** Find in Conversation… ⌘F, Find Next ⌘G, Find Previous ⇧⌘G, unchanged: disabled where there is no conversation, so they do not claim the keys.
- **View:** Chat ⌘1 · Code ⌘2 (the checkmark `Toggle`s, as today) · Command Menu… ⌘K (decision 2) · Search… ⇧⌘F · Switch to Dark Mode / Switch to Light Mode ⇧⌘L · then the system's sidebar and toolbar items.
- **Chat** (`CommandMenu("Chat")`, enabled only while the focused window shows Chat): Attach Files… ⌘U · Attach Screenshot… ⇧⌘U · Focus Composer ⇧⎋ · Stop Generating ⌘. · Regenerate ⌘R · Copy Last Response ⇧⌘C · Copy Last Code Block ⇧⌘; · Divider · `DesktopConversationMenu(conversation:projects:actions:renameTitle: "Rename…")` for the conversation on screen (disabled when there is none). The menu reuses that struct, so the row, hover, title and Chat menus stay one list. If `CommandsBuilder` supports conditionals on the deployment target, show Chat only while Chat is showing and Session only while Code is; otherwise both stay, with their items disabled.
- **Session:** Code's items, minus its ⌘K row. Code's Stop keeps ⌘.; the registry test proves Chat's and Code's ⌘. never share a context.
- **Window:** the system's items, plus the **Tasks (Legacy)** block **verbatim**, untouched, so Phase 5 D can delete it cleanly.
- **Help:** Juno Help ↗ · Keyboard Shortcuts ⌘/ · Roadmap & Feature Requests ↗ (the web's `/roadmap`).
- **Actions:**
  - `DesktopWorkspaceActions` gains `openCommandMenu: (() -> Void)?` (seam 1).
  - `DesktopShellActions` gains `toggleTheme: (() -> Void)?`, published by `JunoDesktopWorkspaceView`, which writes `theme` through `NativeMemorySettingsStore.updateSettings`.
  - A new focused value, `DesktopChatCommandActions`, is published by `DesktopChatWorkspace` (`chatCommands`). It carries: the conversation, the projects, the conversation actions, attach, screenshot, stop, regenerate, copyLastResponse, copyLastCodeBlock and focusComposer, each nil when it cannot act.
  - Move Attach Files and Attach Screenshot from File to Chat; move Find in Juno… to View › Search….

### A3. The Chat menu's actions (`App/ChatCommands.swift`, bounded wiring in the workspace and composer)

- **Copy Last Response:** the newest assistant reply with words, through `NativeMessageContent.copyableMarkdown(of:)`, trimmed. Toasts: "Copied the last response." / "No response to copy yet." / "Couldn’t copy.".
- **Copy Last Code Block:** the last fenced block of the newest reply that has one, read through the same Markdown parser the prose draws with, not a regex over text. Toasts: "Copied the last code block." / "No code block in this conversation yet." / "Could not copy." (web words, including that one's "Could not").
- **Regenerate:** send the newest reply's own Try Again request, so the "Regenerate this answer?" confirmation still asks when it carries artifacts. Enabled only for a settled newest reply while nothing streams.
- **Stop Generating:** exactly what the composer's stop face does. A streaming reply stops; research cancels its run, then the stream; a live task with nothing streaming stops the task (`ChatComposerDisc` / `ChatComposerSteering`, one function they share). Enabled only when the face would be Stop. Remove the face's own `.keyboardShortcut` (`ChatComposer.swift:686`).
- **Focus Composer:** the existing `ChatComposerRequest.Kind.focus`, with the caret at the end.
- **Tests** (`ChatCommandsTests`): the last-response and last-code-block extraction (no reply, a reply with no code, memory tags stripped, several blocks), the enabling rules, and that Stop follows the disc's precedence.

### A4. The Keyboard Shortcuts window, generated

`DesktopShortcutsWindow` reads `JunoShortcutRegistry.groups`. The scene (`Window("Keyboard Shortcuts")`) is unchanged.
- **Layout:** content 640 wide, the window sized to its content (explicit `.frame(width: 640)`, height from the registry), `junoCanvas` behind. Two balanced columns of groups, 32pt apart, 24pt margins; a group never splits across columns.
- **Groups:** Everywhere, Products, Composer, Responses, Code. Heading 13pt medium in the secondary ink, sentence case (decision 27); rows 32pt, the label at 13pt in the foreground on the left, keycaps on the right; `junoBorder` hairlines between rows, no zebra striping, no table chrome, no count.
- **Keycaps:** one cap per key, never a string such as "⇧⌘F". `micro` rung (SF Mono 10.5) in `junoSecondaryInk` (never tertiary), on `junoSecondary`, radius 6, min width 20, height 20, 4pt apart.
- **Signature detail:** the keys drawn as separate physical caps, so ⇧ ⌘ F reads as three presses, not a code.
- **Accessibility:** each row is one element, "Search, Shift Command F". The group titles are headers.

### A5. The menu recipe on the shell, sidebar, composer and transcript

The recipe (§7.1):
- **Trigger:** `.menuStyle(.button)` + `.buttonStyle(.borderless | .plain | a Juno style)` + `.menuIndicator(.hidden)` for icon-only triggers, a 28pt `.contentShape` and `.help`.
- **Rows:** `Label`s with 16pt glyphs, Title Case, `Toggle` for on/off, `Picker(.inline)` for choices, `Divider` between groups, `role: .destructive` last, and no hand-drawn rows.
- **No `.keyboardShortcut` inside in-window menus;** the menu bar owns chords (decision 1).

Apply it to:
- **`DesktopConversationMenu`:** glyphs per the web. Rename `ph.pencilsimple`, Pin `ph.pushpin` / Unpin `ph.pushpinslash`, Add to Project `ph.folder` (No Project and each project as the checkmark `Toggle`s, then New Project… `ph.plus`), Open Project `ph.folderopen`, Share… `ph.sharenetwork`, Archive `ph.archive`, Delete… `ph.trash` (destructive, after the one divider). Its words and order are already right.
- **`ComposerPlusMenu`:** remove ⌘U and ⇧⌘U from the rows; check every row for the recipe and Title Case with the web's words.
- **`DesktopVoice`:** the call bar's options menu is right. The older options menu (`:895-945`) moves from `.borderlessButton` to the recipe. Its words go Title Case: "Voice Model", "Share Screen", "Stop Sharing Screen".
- **`MessageActions`:** an audit only (Phase 2 built it to the recipe); fix any row without a glyph.
- **Not yours:** the task card's, research's and canvas's menus, and the page files'. Their `.borderlessButton` sites are listed in §0.11 with their owners.

### A6. The menus gate

- `scripts/check-native-menus.mjs` is a ratchet rule named `menus`, built on `check-native-design-lib.mjs`. It counts `.menuStyle(.borderlessButton)` and `.borderlessButton` in Mac-shipped code.
- Wire it into `native:design:check` and add `"native:design:menus"` to `package.json`.
- Record its baseline once (the count left after A5, owned by other lanes). The integration re-locks it.

### A7. Acceptance

- Builds, tests and gates green; the iOS build green.
- `rg -n 'keyboardShortcut\(' native/macOS/JunoDesktop/App` shows no chord that the registry also puts in the menu bar, other than inside `DesktopCommands.swift`.
- The registry and Chat-command tests pass.
- **Snapshots:** `shortcuts-window` (light and dark), and `conversation-menu-rows`, a table of the menu's labels and glyphs rendered as plain rows, to check the glyphs and words, since a real menu cannot be photographed.
- 5-Dimension scores ≥ 7 for the Shortcuts window.
- `docs/native/phase3/STAGE-A-NOTES.md` written.
- **Deferred to a person at the screen:** every menu item from the keyboard in Chat and Code, ⌘. in each product, ⌘R on a reply with artifacts (the confirmation), ⇧⌘L writing the theme, ⌘K in Code opening Code's palette.

---

## 4. Stage B: ⌘K and Search, Share, Outputs, the account popover, Archived Chats, dialogs and sheet fills

Two or three commits (B0–B1, B2–B4, B5–B7). Snapshots go in `/tmp/juno-glass-snapshots/phase3-b/`.

### B0. Clients and the contract

- **`NativeUnifiedSearchClient`** (JunoChatKit, iOS-safe, not wired on iOS):
  - `search(query:types:projectID:window:for:)` → `GET /api/search`, decoding `UnifiedSearchResult` exactly: groups, hits (`id`, `type`, `title`, `titleMarks`, `snippet{text, marks}`, `locator`, `updatedAt`, `href`), `coverage[]` (`type`, `state`, `detail`), `partial`, `total`, and the echoed `query`, so a late answer is dropped.
  - `recents(limit:for:)` → `GET /api/recents?limit=`.
  - Tests over recorded JSON: marks, partial coverage, the echo guard and an unknown type ignored.
- **`NativeShareClient`:** add `share(artifactID:for:)`. Decode `403 {code: "share_taken_down", error}` into a `.blocked(reason)` error. Keep the chat call.
- **OpenAPI:** add `/search`, `/recents`, `/share` (POST), `/share/{id}` (DELETE), and the `archived` query parameter on `GET /conversations` if B5 uses it. Regenerate the Swift contract (§2.2).

### B1. The ⌘K / Search panel

**Files:** `DesktopSearchPanelModel` (`@Observable`, one per window), `DesktopCommandCatalog` (the web's command list and matcher), `DesktopSearchPanel` (the view) and a host overlay. `DesktopChatWorkspace.openSearch()` now presents the panel in `.search` mode, which covers the sidebar button and ⇧⌘F. The `.search` destination is no longer reached (§2.1, §6).

**Placement and shape:**
- A window-level overlay on the split view. A clear full-window layer under the panel dismisses it on click. There is no scrim.
- The panel is centred on the detail column (its frame, read in `ChatDetail`), with its top 72pt below the toolbar.
- Width `min(640, detail width − 32)`.
- Height: 56 (field) + filters (44, Search mode with a query) + notices (as needed) + a list with **a 208pt floor**, capped at `min(480, window height − 144)`. It never changes size while typing below the floor; above it, height follows on `JunoMotion.layout`.
- The shell is `GlassEffectContainer { … .glassEffect(.regular, in: .rect(cornerRadius: 20)) }` with `.containerShape(.rect(cornerRadius: 20))`.
- It enters with opacity and scale 0.98 on `JunoMotion.standard`, and leaves in 160ms on `in` (opacity only under Reduce Motion).

**The field row:**
- An 18pt `ph.magnifyingglass` in the secondary ink.
- A `TextField` at `bodyLarge` (17). Placeholder "Search or start a chat" (Commands) or "Search" (Search); accessibility label "Command menu" or "Search everything". It is focused on open.
- An "esc" keycap at rest; once there is text, a 28pt ✕ that fades in, labelled "Clear search", help "Clear".

**Modes and lists:**
- **Commands:** the web's groups and rows (§0.1) from `DesktopCommandCatalog`, with each row's keywords verbatim and the `atWordStart` matcher ported and unit-tested.
  - Glyphs are the web registry's; hints come from the registry at integration (seam 2).
  - **Rows present on this base:** New chat, New private chat, New code session, New design (Artifacts filtered to Designs, New open: route to `.design` until seam 5), New agent (Agents' hiring), Search everything (switches to Search, keeps the query), Toggle sidebar, Open Agents, Open Code, Open Designs, Open Artifacts, Open Library, Open Connections, Open Memory, Roadmap & feature requests ↗. Chats (kind chat, not archived), Code sessions (open through `DesktopWorkbenchRegistry.request(.openSession)`), Projects plus "All projects". Settings, Plans & upgrade (hook), Switch to dark/light mode, Keyboard shortcuts.
  - **Hook rows are absent while nil** (decision 10).
- **Search:**
  - **Empty query:** "Recent", from `recents` online or the local store offline (chats, Code sessions, projects by recency, eight rows). With nothing: the web's empty tile.
  - **With a query:** the local `NativeSearchModel` for chats, messages, projects, files and artifacts, merged with `/api/search?types=memory,knowledge,work` (decision 7). Both debounce at 180ms and cancel the previous request; the local results render first, and the server's groups slot in when they land without moving the active row.
  - **Offline:** show one notice line per unreachable type ("Memory: not searched while offline.", Appendix A).
  - **Groups** in the web's order and labels (Chats, Messages, Projects, Files, Knowledge, Artifacts, Memory, Tasks).
- **Filters (Search with a query):**
  - The nine type chips, Everything first: 28pt capsules at 12pt medium, one scrolling row. Selected: `junoGlassFill`, primary ink and a hairline. At rest: secondary ink, no fill.
  - Then "Any time ▾" and "All projects ▾" as menus with the recipe. Triggers show the web's words; menu rows are Title Case: Any Time, Past Week, Past Month, Past Year; All Projects, then each project.
  - Changing a filter moves the cursor back to the first row (the web's `resetKey`).
- **Rows:**
  - 36pt for one line; with a snippet, the title plus one 13pt snippet line (≈52pt). Radius 12, concentric (panel 20, inset 8).
  - A plain 18pt glyph in a 20pt slot at x = 16; the title at 15pt; the snippet at 13pt secondary; meta at 11pt secondary tabular; keycaps in the micro rung.
  - Matched spans are **semibold** in the row's own ink (decision 9).
  - Group headers: 13pt medium secondary, 4pt above the first group and 24pt above later ones.
  - The active row takes `junoGlassHover` in `ConcentricRectangle`, cross-fading on `JunoMotion.fast`; pointer movement sets it. Rows fade in on arrival (the first eight, 20ms apart, no stagger under Reduce Motion); a row that survives a keystroke does not replay.
- **Keys** (`.onKeyPress`): ↑ ↓ move, ↩ runs, Esc closes, ⇥ / ⇧⇥ move focus between the field and the filter row. ⌘K while open toggles it closed; ⇧⌘F while in Commands switches to Search. The cursor goes back to the top whenever the list underneath is replaced.
- **States** (inside the panel, on glass, so the tile is `junoGlassFill`, not opaque):
  - searching: five 36pt skeleton rows breathing on the skeleton loop (static under Reduce Motion)
  - error: the web's tile and words, in the error tone
  - no match: the web's words
  - Commands with no match: the web's words
- **Routing a hit or a recent row:**
  - `/chat/{id}[?m=]` opens the conversation.
  - `/projects/{id}` opens the project.
  - Files and knowledge open the Library.
  - `/a/{id}` opens the artifact's conversation with the canvas when the conversation is known, and the Artifacts page otherwise (the router at seam 5).
  - Memory opens the Memory page.
  - Tasks: a task with a conversation opens its chat; one without calls `openTaskRecord` (seam 6), and until that is wired the row is absent.
  - Anything else opens the web.
- **Accessibility:**
  - The field is the combobox, and the list's active row carries `.isSelected`.
  - Result counts are announced with the web's status words through `AccessibilityNotification.Announcement`, once per settled set.
  - The panel is a modal element while open. Focus returns to where it was (the composer, usually) on close.
- **Signature detail:** the panel holds its shape while you type (the floor), and the reason each row is there is legible in it (the semibold words).
- **Tests:** the matcher (word starts, keywords, "canvas" finding one row), the merge order and the late-answer guard, filter reset, hook-absent rows, the hit routing table, and the offline notices.

### B2. The Share popover (`DesktopSharePopover`)

- **Where it opens:** the toolbar Share, the title menu's and row menus' Share…, the Chat menu's Share… (A), and the reply's More › Share Chat…, all through the one `DesktopShareState`. `target: .chat(id) | .artifact(id)`; artifacts come at seam 7.
- **Frame:** `.frame(width: 360, height: 232)` in every state, content top-aligned, padding 12.
- **Contents:**
  - The title "Share this chat" / "Share this artifact" at 13pt semibold, marked as a header, then the web's description at 12pt secondary.
  - **Loading:** a field-shaped skeleton and a button-shaped skeleton, then a caption skeleton.
  - **Error:** the failure glyph and "Couldn’t create the link. Please try again." in the destructive ink, and a `.bordered` "Try Again".
  - **Blocked:** the reason in the destructive ink.
  - **Revoked:** `ph.linksimplebreak` and "The link was revoked. Anyone opening it now sees nothing.", and a `.junoProminent` "Create a New Link".
  - **Ready:**
    - a read-only field (`junoInput` hairline, radius 12, 32pt) holding the URL at 12pt mono, selected on focus, labelled "Share link"
    - a `.junoProminent` "Copy" whose glyph swaps `ph.copy` → `ph.check` and whose word becomes "Copied" for 1.5s (announced)
    - a row with "Snapshot · Sep 22, 2026 · 14 views" in SF 11 tabular secondary (register #40), and a borderless "Revoke Link" in the destructive ink ("Revoking…" while it runs)
    - a `ShareLink` "More…" with `ph.sharenetwork` (P3-16)
- **Toasts:** "Link revoked. It no longer works." / "Couldn’t revoke the link." go to the window's host.
- **Signature detail:** the Copy button's glyph and word turning to the check and "Copied".
- **Delete:** `DesktopShareResultPopover` and its interim copy.
- **Tests:** the state machine (create, blocked, error, retry, revoke, re-create) against a stub client.

### B3. The Outputs chip and popover (`DesktopOutputsPopover`)

- **`ChatSessionOutputs.read(artifacts:messages:)`:** a line-for-line port of `readSession()`. Labels are `TYPE_LABEL`; images come from the assistant's attachments; the used rows are Models, Uploads, Web search, Memory and Connectors, with the web's detail strings. Unit-tested against the web's cases.
- **Toolbar:** a new, first `ToolbarItem` in the Share/Private capsule, declared unconditionally and hidden with `.hidden(!isChatRoute || nothing to show)`. Its label is `ph.filetext` with the count (`monospacedDigit`, `.contentTransition(.numericText())`) when there are outputs. Accessibility "Outputs — {n} in this chat" / "What this chat used"; help "Outputs".
- **Popover:** width 336; height `min(400, computed from the rows)`, a deterministic function with a `ScrollView` inside for overflow; padding 16.
  - "Outputs" at 15pt medium, then the grid: two columns (12pt gap, 16pt rows) with 4:3 previews; a single output is one wide 16:9 tile. Previews come from `NativeDesignPreviewLoader` / the artifact thumbnails / the picture, radius 12, hairline. Titles at 13pt, labels at 11pt secondary.
  - "Used in this session" (with a hairline above when both show): 32pt rows with a 16pt secondary glyph, the label and the detail right-aligned in the secondary ink, then up to eight 28pt upload rows (an extension badge in `micro`, the name, "Open" in SF 11) and "+{n} more in the chat".
  - An artifact opens the canvas dock; an upload or image opens Quick Look (the conversation's hoisted `quickLookURL`). Both close the popover.
- **Signature detail:** one output fills the width as a landscape tile, so a single result never looks like a half-empty grid.

### B4. The account popover

Rewrite `DesktopAccountPopover` to §0.5. The footer row above it is unchanged.
- **Header:** a 32pt avatar; the name at 13pt medium; the plan pill in **SF** 11pt medium secondary on `junoGlassFill` (drop the mono); the email at 12pt secondary, truncating in the middle.
- **Usage block** (`junoGlassFill`, radius 10):
  - "Messages" and "{used} / {limit}" (tabular), then the 18-dot `DesktopSidebarDotFillBar` tinted accent → warning → destructive, the footer's own tones.
  - Or "No cap" and the web's sentence.
  - Built from `DesktopAccountUsage.init(plan:)` over today's fields (seam 9): until `quota` arrives, a plan with a weekly window shows its percentage the way it does now.
- **Rows** (28pt, `junoGlassHover`, radius 8): Settings… `ph.gearsix` (⌘, shown as a trailing hint), Upgrade Plan `ph.sparkle` (only when the plan is below the top purchasable tier, today FREE, PRO or MAX; hidden while `openUpgrade` is nil), Admin Panel ↗ `ph.shieldcheck` (owners). Divider. Keyboard Shortcuts `ph.keyboard` (⌘/). Divider. Sign Out `ph.signout` in the destructive ink.
- **No Profile… row** (the web dropped it). No Get the apps (P3-15).
- **Frame:** width 288; height a constant per row set (base, + Upgrade, + Admin), never measured at runtime.
- **Signature detail:** the 18-dot bar, the web's own mark for how much is left.

### B5. Archived Chats (`DesktopArchivedChatsSheet`)

- **Presented** from the workspace (`showingArchivedChats`); reached from More at seam 8.
- **Sheet:** a system sheet with `.presentationSizing(.fitted)`, `.frame(width: 480, height: 520)`, no custom ground. The title "Archived chats" at the heading rung, marked as a header; the description, the web's words, at 13pt secondary; then the list; then a footer with "Done" (`.bordered`, `.tint(nil)`, `.cancelAction`). There is no prominent button.
- **Data:** the local store's `kind == "chat"` rows with `archivedAt`, newest archived first. If the store turns out not to hold rows archived before this Mac first synced (test it), read `GET /api/conversations?archived=only` instead and note which.
- **Rows** (48pt, radius 10, hover `junoHover`):
  - the title at 13pt medium ("New chat" when empty) over "Archived {date}" in SF 11 tabular secondary
  - two trailing 28pt icon buttons: Restore (`ph.boxarrowup`, help "Restore") and Delete (`ph.trash`, help "Delete", the destructive ink on hover)
  - a click on the row opens the chat and closes the sheet
- **Restore:** `setArchived(false)`. The row leaves with a fade (`exit`).
- **Delete:** `.junoConfirmation`, the web's title and message, "Delete Chat" destructive.
- **Failures:** a line under the row in the destructive ink ("Couldn’t restore the chat." / "Delete failed.") for six seconds, never a toast (decision 15).
- **States:** four 48pt skeleton rows; `JunoEmptyState(.panel)` with `ph.archive` and "Nothing archived."; tone `.error` with "Couldn’t load archived chats.".
- **Signature detail:** a restored row leaving the list, the visible sign it went back to Recent.

### B6. Dialogs, rename and sheet fills on chat surfaces

- **Delete conversation** (`DesktopChatWorkspace.swift:274`): move it to `.junoConfirmation`, with the web's title and message and the button "Delete Chat". Its failure path restores the row and posts "Delete failed.".
- **Rename… when the sidebar is hidden:** reveal the sidebar (`columns = .all`), then start the inline field on the row. Test it through the actions.
- **Audit** every `.alert` on chat surfaces. An error stays an `.alert`; any choice becomes `.junoConfirmation`. List what you changed in your notes.
- **Remove `junoSheetSurface`** at `DesktopChatWorkspace.swift:1325` and `DesktopLibraryPicker.swift:161`. Each sheet keeps its explicit frame and gets `.presentationSizing(.fitted)`. Check the dark sheet still reads as raised: the system draws it now. The two Settings sites are C's, because C rewrites those files; the page files' sites are Phase 4's.

### B7. Acceptance

- Builds, tests and gates green; glass holds (the panel is allow-listed by name).
- **Snapshots:**
  - `panel-commands-empty`, `panel-commands-query`, `panel-search-recent`, `panel-search-results` (snippets, semibold marks, filters), `panel-search-offline-notice`, `panel-search-empty`, `panel-search-error`, `panel-search-loading`
  - `share-loading`, `share-ready`, `share-copied`, `share-revoked`, `share-blocked`, `share-error`
  - `outputs-one`, `outputs-many`, `outputs-used-only`
  - `account-popover-free`, `account-popover-owner`
  - `archived-list`, `archived-empty`, `archived-error`, `archived-loading`
  - `final/window-panel-over-chat`

  All in light and dark, with the panel drawn with its Reduce Transparency recipe.
- 5-Dimension scores ≥ 7 for the panel (both modes), Share, Outputs, the account popover and Archived Chats.
- `docs/native/phase3/STAGE-B-NOTES.md` written.
- **Deferred to a person at the screen:** ⌘K and ⇧⌘F focus and Esc, a live `/api/search` answer, a real share create and revoke, Quick Look from Outputs, a restore and delete against the server, the panel's glass over a live transcript.

---

## 5. Stage C: Settings to web parity, Upgrade, text size, theme and accent, onboarding and announcements

Two or three commits (C0–C2, C3–C5, C6–C7). Snapshots go in `/tmp/juno-glass-snapshots/phase3-c/`.

### C0. Data (additive; iOS unchanged)

- **`NativeSettings` and `NativeSettingsPatch`** add:
  - `name` (sent as `name`)
  - `memoryBackgroundLearning`
  - `memorySensitiveTopics: [String]`
  - `actionApprovalPolicy`
  - `lockdownMode`
  - `blockedConnectors: [String]`
  - `monthlySpendCapEur` (`Int??` in the patch, so that `null`, "back to the default", can be sent)

  Decode them when present; old payloads still decode.
- **`NativeUsagePlan`** adds:
  - `quota {plan, used, limit?}`
  - `spend {spentMicroUsd, reservedMicroUsd, budgetMicroUsd?, eurPerUsd, capSource, capDisabled, userCapEur?, windows, billing}`

  All optional, from `GET /api/profile/usage` (the route's JSON, `src/app/api/profile/usage/route.ts`).
- **Clients:**
  - `NativeBillingClient`: `checkout(plan:interval:)` → `POST /api/stripe/checkout` → URL; `portal()` → `POST /api/stripe/portal` → URL.
  - `NativeAnnouncementsClient`: `current()`, `dismiss(id:)`.
  - `NativeAccountSecurityClient`: `status`, `mfa/start`, `mfa/confirm`, `mfa/disable`, `password`, `email`, `sessions/revoke`, reading `src/components/auth/account-security.tsx` for the bodies.
  - `NativeImportClient`: `POST /api/import` multipart with upload progress.
  - `NativeAccountDataClient` gains `deleteAllConversations()` (`DELETE /api/conversations`) and the `format=juno` export.
  - An avatar upload (`POST /api/profile/avatar`).
- **Contract:** the paths and fields above, then regenerate.
- **Tests:** each decoder over recorded JSON, and each client's request shape.

### C1. The Settings window

- **Sections:** `DesktopSettingsSection` in the web's order: General, Personalization, Memory, Models, Connectors, **Devices** (new, `ph.laptop`), Voice, Data & privacy, Account, **Plan & usage** (label changed; raw value `billing` kept), then Code (Mac-only, `juno.code`). Keep `.usage`, `.connections` and the raw values. The web's aliases resolve to sections for `DesktopSettingsRouter.open(named:)` (new, additive).
- **Layout:**
  - `NavigationSplitView` with a sidebar source list (`ph.*` from the web's `SettingsIcons`) and `.searchable(placement: .sidebar, prompt: "Search settings")`, matching on labels, row labels and the existing search terms.
  - The detail is a `Form` with `.formStyle(.grouped)` and `.scrollContentBackground(.hidden)`, over the window's `containerBackground(Color.junoCanvas, for: .window)`, with no other backgrounds. Remove `.junoReadingCanvas()` from the detail.
  - The title bar says the section's name. Remove `navigationSubtitle` and the summaries (decision 17).
  - Default size 820 × 600, minimum 680 × 480.
  - The window applies the account theme (`preferredColorScheme`), `.junoAccentTint()` and `junoTextScale`.
- **Rows** (`DesktopSettingsRows.swift`):
  - `DesktopSettingRow(label, description, status) { control }` is `LabeledContent` with the label at 13pt medium, the description at 12pt secondary under it, and the control trailing.
  - Group header: the title at 13pt semibold, the note at 12pt secondary; a group with no title has no header.
  - The destructive group is a `Section` with no title, set apart by space, its rows in the destructive ink.
  - `DesktopSaveStatus` sits beside the label: nothing while saving; `ph.checkcircle` in the success ink with "Saved" for 1.8s; `ph.warningcircle` with "Not saved" in the destructive ink for 5s. Fade in on `fast`, out on `exit`, announced once.
  - Every write is optimistic with rollback, and a failure toasts the reason in the Settings window's host.
- **Controls:** `Toggle(.switch)` (coral on); `Picker(.menu)` with the recipe, Title Case rows; `JunoSegmented` for the Theme (never a system `.segmented`, which draws the system accent); `TextField` / `TextEditor` saved on focus loss and Return; outline buttons `.bordered` with `.tint(nil)`; at most one `.junoProminent` per pane.
- **Remove `junoSheetSurface`** from `DesktopSettingsScreen.swift:540, 1494`. Settings sheets are system sheets with an explicit frame and `.presentationSizing(.form)`.
- **Tests:** section order and labels, alias resolution, search matching, and save-status timing.

### C2. The panes (one file each), to §0.7's table

Everything below is the web's row, in the web's order, with the web's words.

- **General:**
  - Appearance: Theme (`JunoSegmented` Light / Dark / System with `ph.sun`, `ph.moon`, `ph.monitor`).
  - Accent color: 24pt swatches with a check on the selected one, plus "Custom accent color" as a `ColorPicker` in a swatch-shaped well (C5).
  - Text size: a stepped `Slider` of six steps, a small and a large "A" at the ends, the pt value after it in tabular SF (C5).
  - Language: omitted (decision 19).
  - Mac-only **About** group last: Version, Check for Updates… / Install and Relaunch, Diagnostics… (moved from Data & privacy).
- **Personalization:** What Juno calls you (saved on focus loss or Return; "Couldn’t save your name."), Custom instructions (a `TextEditor` well at the editor minimum height, saved on focus loss; the Save/Revert buttons and the character count go), Personality (a `Picker` with each option's description as the row's description), Response language.
- **Memory:** the three untitled rows ("Manage" `.bordered` through `DesktopSettingsLinks.openMemory`, hidden while nil); Sensitive subjects (one switch per topic, from a Swift copy of `SENSITIVE_TOPIC_META`); Background work (the four options with descriptions). The embedded Memory page goes. "What Juno noticed" stays until seam 14.
- **Models:** Default model (the existing model trigger and catalogue; Auto first). **On this device**, with the note in Mac words (decision 18): Thinking effort, Fast mode and Web search, bound to **the composer's own `@AppStorage` keys** (read them from `ChatComposer.swift`; do not edit that file). Favorites (an "Add" menu over the catalogue, rows with the provider mark, name and provider, an Unpin 28pt `ph.star` button, "Nothing pinned yet.").
- **Connectors:** Connected apps ("Browse Apps" `.bordered` through `openConnections`; per-app switches with the connector mark; the empty and error states as `JunoEmptyState(.panel)`) and Permissions (the policy `Picker` with descriptions; the lockdown note; Lockdown). The embedded Connections page goes.
- **Devices:**
  - **This Mac:** `DesktopWorkHostTile`, moved here from Settings › Code, whose "Juno Work" section is removed.
  - **Your Macs**, with the web's note: `DesktopSettingsHostRow` (seam 11: the name, the state in words, the live dot only for an awake Mac, a chevron, a click through `openHost`), revoked last, two skeleton rows, the stale note, and the error.
  - The empty state on the Mac is this Mac's switch (decision 24).
  - The footnote with the link "See what Juno always asks first" (`openPermissions`, hidden while nil).
- **Voice:** Voice (a 28pt Play/Stop preview button, "Play a preview" / "Stop the preview", then the `Picker`; the unavailable sentences), and the footnote: the Mac's dictation sentence ("Dictation uses this Mac’s own speech recognition.") and the web's voice-plan sentence.
- **Data & privacy:**
  - Export your data: an "Export ▾" menu with JSON / Juno Package / CSV, each with its description, through `.fileExporter`.
  - Import chat history: `.fileImporter` plus drop onto the row; progress in the row with the web's words; the result as a toast.
  - Shared links: inline rows (the chat or artifact glyph, title, "Chat · {date} · {n} views" in SF tabular, a Copy Link 28pt button swapping to the check, a borderless "Revoke"); the web's loading, empty and error states. The old sheet goes.
  - Destructive: Delete all conversations ("Delete All…" → `.junoConfirmation` with the web's title and message and "Delete All Conversations").
- **Account:**
  - The profile block: a 56pt avatar with a camera badge on hover ("Change profile picture", an image `NSOpenPanel` or `PhotosPicker`), the name and email, "Change Name" (selects Personalization).
  - Sign-in and security: Two-step verification (an "On" badge; "Set Up…" / "Turn Off…" `.form` sheets with the web's steps, QR code, code field and recovery codes with Copy), Password (a "Change…" sheet, or the Google/Apple sentence), Email address (a "Change…" sheet), This session ("Sign Out", which keeps the Mac's confirmation, decision 26), Sign out everywhere ("Sign Out Everywhere…" with confirmation).
  - Notifications (email): Budget alerts and Weekly digest.
  - **Notifications on this Mac:** main's section, restyled onto these rows with the web's words for "When something needs you" and "Updates", plus the permission row.
  - Destructive: Delete account (the existing type-your-email sheet, with the web's words, "Delete Permanently").
  - The "Danger zone" heading goes.
- **Plan & usage:** C3.
- **Code:** unchanged apart from the moved tile.

### C3. Plan & usage (and the Usage page folded in)

- **Plan block:** the plan name at 17pt semibold with an "Active" pill (neutral, no dot) while generating is possible; the tagline at 13pt secondary; "€20 a month, excluding VAT." / "Free." and "Renews {date}." / "Access ends {date}." (the money and dates in SF tabular).
  - **Actions:** FREE shows "Upgrade" (`.junoProminent`, the pane's one) → the Upgrade sheet. Paid plans show "Change Plan" (`.bordered`) → the Upgrade sheet, and "Manage Billing" (`.bordered`) → `portal()` → `openURL`; its failure toasts "Couldn’t open the billing portal.".
- **Usage:** the unlimited or Free sentence, or three `ProgressView` meters (This month, Current session, This week) with the web's descriptions and reset wording. The tone goes accent → warning at 80% → destructive at 100%.
- **Spend ceiling:** Monthly ceiling (an integer field, placeholder "Default", "Save" `.bordered`, enabled when the value is valid and changed; the web's descriptions and cap-source note; the switched-off warning in the warning ink).
- **History:** 30 day bars (Swift Charts `BarMark` or plain rects; one ink, no gradient; the busiest day labelled; ← → read a day through the accessibility adjustable action), with the web's empty and error sentences.
- **Delete `DesktopUsageScreen.swift`.** Keep `DesktopUsageModel.swift`, which Code and the footer use.

### C4. Upgrade (`DesktopUpgradeSheet`, `DesktopUpgradePresenter`)

- **Presenter:** `DesktopUpgradePresenter.shared` (`@Observable`, main actor) presents one sheet over the key window. It is attached to the Chat window (through the `.desktopFirstRunSheets()` line in `JunoDesktopRootView`) and to the Settings window. `present()` is what the seams call.
- **Sheet:** `.presentationSizing(.page)`, `.frame(width: 760, height: 640)`, no custom ground.
  - The title "Upgrade" at `pageTitle`, marked as a header, and the web's lede.
  - **No Monthly/Yearly switch** until the server exposes the interval offer (decision 22; recorded as an API gap).
  - **Three opaque plan cards** (`junoCard`, radius 16, hairline, 24pt padding), from `DesktopPlanCatalog`, a Swift copy of `src/lib/plans.ts` with a test that pins it:
    - Free
    - Pro, with a neutral "Recommended" pill
    - Max, with a `JunoSegmented` ×5 / ×10 switch in its header

    Each card has the name at 17pt semibold, the tagline, the price at 26pt with "excl. VAT / mo" at 12pt secondary, the features with `ph.check` in the secondary ink, and the action at the foot: "Current Plan" (disabled), "Upgrade to {Plan}" (`.junoProminent` on Pro, `.bordered` elsewhere), or "Downgrade" / "Manage" (`.bordered`, the portal).
  - The fair-use line with `ph.info`; a "Questions" group of five `DisclosureGroup`s with the web's answers; the terms line with its links.
  - A footer "Done" (`.cancelAction`).
- **Checkout** opens the returned Stripe URL in the browser, and the card shows "Redirecting…" until the app resigns active. A failure goes inline under the card (no toast in a sheet).
- **Signature detail:** the recommended card is the only one with a coral button, so the choice reads before the prices do.

### C5. Text size, theme and accent

- **`DesktopTextSize`:** `@AppStorage("juno.textSize")` holding the web's ids (`xs`, `small`, `default`, `large`, `xl`, `xxl`), with scale = px / 16. `.environment(\.junoTextScale, …)` at the Chat window's root (`JunoDesktopRootView`), the Settings window and Quick Entry (one line). Content rungs already read it; confirm the composer field, rows and page headers do too, and list any rung that ignores it in your notes.
- **Theme:** Settings and onboarding write the account `theme`. The Chat window and Quick Entry already follow it; the Settings window now does too (C1).
- **Accent:** `JunoAccentSelection.apply(setting:)` accepts a `#rrggbb` setting and derives the accent by the web's rule (decision 21): accent, ink and on-accent per appearance. The ring stays graphite. The API that the eighty call sites read (`color`, `ink`, `onAccent`, `ring`, `hsl(dark:)`) is unchanged, and iOS still compiles and looks the same for presets.
- **Tests:** the clamp rule, a pale custom accent getting dark on-accent ink, the preset round trip, and the text-size mapping.

### C6. Onboarding and announcements (`DesktopFirstRunPresenter`)

- **Onboarding:**
  - **When:** once per account (`@AppStorage("juno.onboarded.v1.<accountID>")`), only when the account has no conversations after the first sync, and only while Chat is showing.
  - **Sheet:** `.presentationSizing(.form)`, `.frame(width: 480, height: 440)`, no dot field.
  - **Contents:** "Welcome to Juno" at the title rung, marked as a header; the web's description at 13pt secondary; "What should Juno call you?" (a field, placeholder "Your first name"); "Theme" (three 72pt opaque tiles, Light / Dark / System with their glyphs, the selected one on `junoSelectedFill` with the edge); "Accent" (six 28pt swatches, the check on the chosen one).
  - **Footer:** "Skip for Now" (borderless, `.cancelAction`) and "Start Chatting" (`.junoProminent`, `.defaultAction`).
  - **Writes:** name, theme and accent to the account (decision 25). The accent applies live.
  - **Signature detail:** choosing a swatch recolours "Start Chatting" at once, so the choice is previewed on the one coral control.
- **Announcements:**
  - **When:** after onboarding (never at the same time) and while Chat is showing. `current()` on launch and on sign-in; skip ids dismissed on this Mac.
  - **Sheet:** `.presentationSizing(.page)`, `.frame(width: 560, height: 520)`.
  - **The visual** at 16:9, radius 12, clipped: a video through `AVPlayerView` (muted, looping, no controls; paused with controls under Reduce Motion), or an image through the existing loader, or a provider mark on `junoSecondary`, or `juno.chat`.
  - **Text:** the optional model name at 13pt medium secondary, the title at 22pt semibold, the description at 15pt secondary.
  - **Buttons:** "Read More" (or `newsLabel`, `.bordered`) or "Not Now" (borderless), and the CTA (`.junoProminent` with `ph.arrowright`).
  - **Closing** by any route dismisses (locally and `POST …/dismiss`).
  - **Links:** internal hrefs go through `JunoNotificationRoute(path:)` and `DesktopWorkbenchRegistry.requestRoute` where they map; others open the browser.
- **Tests:** the presentation rules (no conversations, already onboarded, announcement after onboarding, a dismissed id), and the href routing.

### C7. Acceptance

- Builds, tests and gates green; the iOS build green (the accent, settings and usage changes are shared).
- `rg -n 'junoSheetSurface' native/macOS/JunoDesktop/App/DesktopSettings*` finds nothing; `DesktopUsageScreen.swift` is gone.
- **Snapshots** (window compositions of the Settings window at 820 × 600, via the final renderer):
  - `settings-general` (a custom accent), `settings-personalization`, `settings-memory`, `settings-models`, `settings-connectors`, `settings-connectors-empty`, `settings-devices`, `settings-devices-this-mac-only`, `settings-voice`, `settings-data` (shared links), `settings-account`, `settings-plan-free`, `settings-plan-pro`, `settings-save-status`
  - `upgrade-sheet`, `onboarding`, `announcement-image`, `announcement-plain`
  - `text-size-xl` (a transcript at the largest size)

  All in light and dark.
- 5-Dimension scores ≥ 7 for every pane, Upgrade, onboarding and the announcement.
- `docs/native/phase3/STAGE-C-NOTES.md` written.
- **Deferred to a person at the screen:** checkout and the portal in the browser, 2FA set-up with a real authenticator, the avatar upload, a real import upload, the first-run sheet on a fresh account, a live announcement with video, the theme and text size switching live in all three windows.

---

## 6. The integration step (after A, B and C, merged with the other lanes)

1. **Merge in this order:** B into A, then C, each followed by `generate-projects.sh`, `npm run native:icons`, the contract regenerated, and a build. Merge Phase 4 and Phase 5 as the orchestrator directs.
2. **Wire the seams** in §2.3, rows 1–14. Each is a few lines; add the test named with it.
3. **Delete** `DesktopSearchScreen.swift` and the `.search` branch in `DesktopDestinationView`. Normalise a stored `.search` destination to `.chat`. Bring Phase 5 D's Search › Tasks scope into the panel's Tasks chip (sessions from `NativeWorkModel`, a task without a conversation through seam 6).
4. **Make `junoSheetSurface` iOS-only** (`#if os(iOS)`) once no Mac call site is left, so no new one can appear. Until then, list the survivors and their owners.
5. **Re-lock the baselines:** `native:design:baseline` for every rule, the new `menus` rule included. Write the counts in the commit.
6. **Fold the notes:**
   - the three `STAGE-*-NOTES.md` into the spec's new "Phase 3 errata" section
   - the register entries (renumber the `P3-n` after Phase 4's and Phase 5's)
   - `MACOS_REDESIGN_HANDOFF.md` (a Phase 3 entry, the runtime checks left)
   - `WEB_TO_NATIVE_DESIGN.md`
   - `API_GAPS.md`: plans and intervals for native, the interface-language catalogue

   Then delete `docs/native/phase3/`.
7. **Re-render** the `final/` window set with the panel, the toolbar's Outputs, and the Settings window.

---

## 7. Not in Phase 3 (explicit)

1. **The composer's `/` and `@` palette, "Use a Skill" and `skillSlug`, and the quote card (Ask/Modify with `artifactEdit`).** Spec §11 puts them in Phase 4 step 4; the Phase 4 brief hands them to this track, and they need Phase 4 B's `NativeSkillLibraryModel`, which is not on this base. They run as a follow-up after integration.
2. **Code's own palette and Session menu redesign** (the Code session). Code's three `.borderlessButton` sites and five `junoSheetSurface` sites (two in `DesktopCodeWorkspace.swift`, three in the package) are theirs too.
3. **`.borderlessButton` and `junoSheetSurface` in page files, the task card, research and the canvas:** the owners are in §0.11 and the menus gate holds the line.
4. **The Notifications popover, the Needs-you signals, the menu-bar extra and the Dock badge:** Phase 5 C. Phase 3 only adds the ⌘K row (seam 3) and restyles the Settings section.
5. **The More menu's contents and the Archived Chats item in it:** Phase 4 C (seam 8).
6. **The Compare page** (no Mac surface; the ⌘K row is left out).
7. **A Monthly/Yearly choice and purchasable-plan awareness in Upgrade.** The server must expose them to native clients first (API gap).
8. **App Store billing (`SubscriptionStoreView`):** only if an App Store build ships.
9. **Interface language on the Mac:** needs a string catalogue (owner question §8.1). The new copy is not in `Localizable.xcstrings` either (carried forward).
10. **Quick Entry:** built in Phase 1 (the shared shell, the switch, bringing the window forward). Phase 3 only passes it the text size (C5).
11. **Runtime checks at the screen:** the lists in A7, B7 and C7; the owner does them (screen control is off).

## 8. Owner questions (none block the stages)

1. **Interface language.** Hide the row on the Mac until there is a Mac string catalogue (this brief's choice), or show it as an account setting that only affects the web?
2. **The Mac-only usage cards** (activity heatmap, where it went, token mix, pace, most used models). The web's Plan & usage has only History. Drop them (this brief's choice) or keep them under History as Mac extras?
3. **Upgrade on the Mac.** Expose `purchasablePlans` and `purchasableAnnualPlans` to native clients (bootstrap or a small route), so the sheet can offer Yearly and hide what is not for sale?
4. **"Get the apps"** in the account menu. Leave it out on the Mac (this brief's choice), or keep it as a link to the web's download page for the iPhone?

---

## Appendix A: new Mac-only copy (for the copy audit)

Everything else is the web's, verbatim. These are new and must read plainly:
- **Menus** (Title Case, the web's words where they exist): "Command Menu…", "Search…", "Switch to Dark Mode", "Switch to Light Mode", "Focus Composer", "Stop Generating", "Regenerate", "Copy Last Response", "Copy Last Code Block", "Roadmap & Feature Requests", "Voice Model", "Share Screen", "Stop Sharing Screen".
- **Shortcuts window labels not on the web:** "Search", "New private chat", "Ask Juno from anywhere", "Attach a screenshot", "Find next", "Find previous", "Regenerate", and the Code group's existing rows.
- **⌘K:** "New private chat". The offline notices "Memory: not searched while offline.", "Knowledge: not searched while offline.", "Tasks: not searched while offline.".
- **Share:** "More…".
- **Settings:** "Where each new message starts on this Mac. The composer can change any of them." (Models); "Dictation uses this Mac’s own speech recognition." (Voice); "This Mac" (the Devices group title); the About group's existing rows.
- **Archived Chats:** "Done" (the footer).
- **Upgrade:** "Done" (the footer).

## Appendix B: file map

**New**
- **A:** `App/JunoShortcutRegistry.swift`, `App/ChatCommands.swift`, `Tests/JunoShortcutRegistryTests.swift`, `Tests/ChatCommandsTests.swift`, `Tests/Snapshots/ShortcutsSnapshotTests.swift`, `scripts/check-native-menus.mjs`, `docs/native/phase3/STAGE-A-NOTES.md`
- **B:** `App/DesktopSearchPanel.swift`, `App/DesktopSearchPanelModel.swift`, `App/DesktopCommandCatalog.swift`, `App/DesktopSharePopover.swift`, `App/DesktopOutputsPopover.swift`, `App/DesktopArchivedChatsSheet.swift`, `JunoChatKit/NativeUnifiedSearchClient.swift`, tests, `Tests/Snapshots/OverlaySnapshotTests.swift`, `docs/native/phase3/STAGE-B-NOTES.md`
- **C:** `App/DesktopSettings{General,Personalization,Memory,Models,Connectors,Devices,Voice,Data,Account,Plan}Pane.swift`, `App/DesktopSettingsRows.swift`, `App/DesktopSettingsLinks.swift`, `App/DesktopUpgradeSheet.swift`, `App/DesktopOnboardingSheet.swift`, `App/DesktopAnnouncementSheet.swift`, `App/DesktopFirstRunPresenter.swift`, `App/DesktopTextSize.swift`, `JunoChatKit/NativeBillingClient.swift`, `NativeAnnouncementsClient.swift`, `NativeAccountSecurityClient.swift`, `NativeImportClient.swift`, tests, `Tests/Snapshots/SettingsSnapshotTests.swift`, `docs/native/phase3/STAGE-C-NOTES.md`

**Rewritten**
- **A:** `DesktopCommands.swift`, `DesktopShortcutsWindow.swift`
- **B:** `ChatToolbar.swift`, the account popover in `DesktopAccountFooter.swift`
- **C:** `DesktopSettingsWindow.swift`, `DesktopSettingsScreen.swift`

**Changed (bounded, §2.1)**
- `DesktopChatWorkspace.swift` (A, B), `DesktopChatSidebar.swift` (A: `DesktopConversationMenu` only), `ChatComposer.swift`, `ComposerPlusMenu.swift`, `DesktopVoice.swift`, `MessageActions.swift`, `JunoDesktopWorkspaceView.swift` (A)
- `ChatDetail.swift`, `DesktopLibraryPicker.swift`, `NativeShareClient.swift` (B)
- `JunoDesktopRootView.swift`, `DesktopQuickEntry.swift`, `NativeMemorySettingsStore.swift`, `NativeUsageBreakdown.swift`, `NativeAccountDataClient.swift`, `JunoAccent.swift` (C)
- `contracts/openapi/juno-native-v1.yaml` and the regenerated `JunoNativeContract.swift` (B, C)
- `scripts/generate-native-icons.mjs`, `JunoBrand.swift` and the icon catalogues (A: Keyboard; B: MapTrifold; C: Camera, Star)
- `scripts/check-native-design.mjs`, `package.json`, `scripts/check-native-design-baseline.json` (A)

**Deleted**
- **C:** `DesktopUsageScreen.swift`
- **At integration:** `DesktopSearchScreen.swift` and the `.search` view branch; B's `DesktopShareResultPopover` goes in B

## Appendix C: register entries (provisional numbers; renumbered at integration)

- **P3-1.** Settings has a search field in its sidebar; the web's rail has none.
- **P3-2.** Settings groups are the system's grouped form; the web's are flat rows on hairlines.
- **P3-3.** A Mac-only Code section stays last in Settings until Code's redesign.
- **P3-4.** Models' "On this device" note says "on this Mac"; the web's says "in this browser".
- **P3-5.** Interface language is not offered on the Mac until the Mac ships a string catalogue.
- **P3-6.** Text size scales Juno's own type and controls. The sidebar, menus and toolbar keep macOS's sizes; the web scales everything.
- **P3-7.** A custom accent leaves the focus ring graphite; the web sets the ring to the custom colour.
- **P3-8.** Upgrade is a sheet, monthly only until the server says which plans and intervals are for sale; the web is a page with Yearly when offered.
- **P3-9.** Onboarding has no dot-field backdrop, and its theme choice is saved to the account; the web keeps it in the browser.
- **P3-10.** Search marks matched words in semibold in the row's ink; the web washes them in coral.
- **P3-11.** Search's date and project filters are menus; the web's dates are chips.
- **P3-12.** Chats, messages, projects, files and artifacts are searched on this Mac (offline, full text); memory, knowledge and tasks on the server. The web asks the server for all.
- **P3-13.** ⌘K leaves out "Open pull requests" and "Compare models", and "Roadmap & feature requests" opens the web.
- **P3-14.** ⌘K offers "New private chat" (⇧⌘N); the web's palette has no such row.
- **P3-15.** The account popover has no "Get the apps" row.
- **P3-16.** Share is a popover with a system "More…" item; the web's is a dialog without it.
- **P3-17.** Outputs open uploads and images in Quick Look (extends #19).
- **P3-18.** A failure inside Archived Chats shows under its row, not as a toast.
- **P3-19.** Chords are shown in the menu bar and the Shortcuts window only, not inside in-window menus.
- **P3-20.** Keyboard Shortcuts is a window with a Code group and the Mac's own keys; the web's is a dialog.
- **P3-21.** The Chat menu adds ⌘R Regenerate and ⌘. Stop Generating; the web stops with Esc and has no regenerate chord.
- **P3-22.** Shortcuts window group headings are SF, not the web's mono label.
- **P3-23.** Devices on the Mac starts with this Mac's own switch, and its empty state offers that switch rather than "Get the Mac app".
- **P3-24.** Sign Out asks first on the Mac, because it removes this Mac's local copy.

Stages number anything else they find from P3-25 upward.
