# Juno 0.1.0 (build 1)

Built from `agent/juno-native-claude-continuation` at
`043051b253c9b0ac61bab2649bcf1ee5ec248c73`.

This is a **pre-release engineering build**, not a public release. See
`DELIVERY_REPORT.md` for what is and is not proven, and `INSTALL.md` for the
signing caveat that applies to your platform.

## Juno for Mac — rebuilt around Chat

The Mac app used to open on a list of destinations, with Chat buried behind a
second sidebar nested inside the detail column. Conversation history was two
clicks deep, and Juno Code — one section — looked like the whole application.

It is now a single three-region workspace that opens on Chat.

**Sidebar.** One source list: New Chat, Search, Projects, Library, Artifacts,
Juno Code, then your conversation history grouped by recency — pinned, today,
yesterday, the last 7 and 30 days, older, archived. Rename, pin and archive from
the context menu. Account, sync state and Settings sit in the footer. Arrow keys
move through the whole list, chats included.

**Conversation canvas.** Answers now render as documents rather than as one flat
block of text: headings, lists, tables, block quotes, task lists, and fenced code
with a language label and a copy button. Code and tables scroll sideways instead
of wrapping, so indentation and column alignment survive. Reasoning is
collapsible above the answer, citations are numbered, and every message can be
copied.

**Inspector.** A resizable pane (⌥⌘I) with the model, how many messages you have
sent, dates, the linked project, artifacts generated in the conversation, and
every citation de-duplicated across the thread. It stays shut until you open it,
and remembers that per window.

**Composer.** Floating, translucent, anchored above the transcript. It grows as
you type and then scrolls. ⌘↩ sends, ↩ inserts a newline. Model and effort
pickers read as names — "Claude Sonnet 4.6", never
`anthropic:claude-sonnet-4-6`. Send becomes Stop while Juno is answering. Drafts
are kept per conversation, so switching chats no longer destroys a half-written
message.

## Fixes

- Model identifiers no longer leak into the interface anywhere on Mac or iOS.
- Icon-only buttons now have VoiceOver names.
- Keychain failures report what actually went wrong instead of
  `SecurityKeychainClientError error 0`.

## Known limitations

- Attachments (camera, photos, files), Deep Research, Canvas, and Juno Code
  Remote and Cloud are **not implemented**.
- The macOS build is not notarized; Gatekeeper blocks the first launch.
- The iOS build installs on one registered device and its profile expires
  2026-07-29.
- Not on TestFlight.
