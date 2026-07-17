# Juno Quick: canonical cross-platform contract

Status: implementation contract for the macOS and Windows Quick surfaces. This
document records the invariants that both native clients must preserve while the
backend's generation APIs are promoted into the versioned native contract.

## Product boundary

Juno Quick is a lightweight entry point into the same Juno account, models,
projects, conversations, quotas, attachments, artifacts, and private-chat
semantics as the main applications. It is not a separate chat product and must
not maintain a second source of truth.

The macOS surface is owned by the application process as a key-capable `NSPanel`.
The Windows surface is a dedicated, hidden Tauri webview with an explicitly
restricted capability. Closing the main window may leave the process running
when Quick is enabled; an explicit Quit action must terminate it.

## Shared state machine

The composer follows this state machine on both platforms:

```text
hidden -> ready -> clarifying? -> submitting -> streaming -> complete
                    |                |             |
                    +-> cancelled <--+-------------+
                    +-> failed <-------------------+
```

- `ready` uses cached account state and never performs a network request merely
  because the overlay was shown.
- Empty submissions are rejected locally.
- Clarification is fail-open: transport, timeout, or malformed-response errors
  continue with the original prompt. At most one compact question is shown.
- The answer to a clarification is submitted with the original prompt; the
  original prompt remains visible and editable until submission.
- The first accepted submission owns one stable client request identifier. A
  retry must not intentionally create a second conversation.
- Streaming is rendered incrementally and remains cancellable. A terminal event
  is applied once, even when the transport completes and disconnects together.
- Successful first submission replaces any provisional local conversation
  identity with the server identity everywhere it is referenced.
- Private mode follows the main client's retention semantics and must not claim
  that uploaded content is ephemeral unless the server contract guarantees it.

## Presentation and dismissal

- macOS default shortcut: Option-Space.
- Windows default shortcut: Ctrl-Shift-Space.
- Shortcut registration is transactional. A conflicting replacement leaves the
  previous working shortcut active and exposes a useful error in Settings.
- Key-repeat and duplicate shortcut events are debounced.
- The panel opens on the display containing the pointer, falling back to the
  active window's display and then the primary display. Its frame is clamped to
  the display's visible work area.
- Showing Quick stores the previously focused application/window. Escape or a
  click outside dismisses the panel and restores focus where the OS permits.
- Escape first closes transient UI such as a picker, clarification, or expanded
  result before it dismisses the panel.
- Reduced motion removes nonessential transitions. Increased contrast, forced
  colors, and reduced transparency must retain legible boundaries and focus.

## Account, drafts, and handoff

- Quick uses the authenticated account already established by the main app. It
  never implements a parallel token store or refresh loop.
- A draft is keyed by account identity, encrypted with the platform credential
  store, and never synchronized as a conversation before submission.
- Sign-out clears the visible draft and prevents drafts from another account
  being displayed. Switching accounts reloads only the matching draft.
- `Open in Juno` opens or reveals the main app and navigates to the canonical
  conversation identity. It must also work after every main window was closed.

## Backend compatibility bridge

The first desktop implementation may wrap the existing bearer-authenticated
routes while the equivalent versioned contract is introduced:

- `POST /api/chat/clarify`
- `POST /api/chat`
- `POST /api/chat/cancel`
- `POST /api/upload` and attachment retrieval routes
- conversation, model, project, artifact, usage, and sync routes already used by
  the main clients

The target native contract is a versioned generation resource with:

- `clientRequestId` and `clientMessageId` idempotency keys;
- `origin` values `web`, `main_macos`, `main_ios`, `main_windows`,
  `quick_macos`, and `quick_windows`;
- a durable generation receipt and shared cancellation state;
- resumable, ordered event identifiers;
- typed `meta`, `activity`, `delta`, `reasoning_summary`, `sources`, `artifact`,
  `quota`, `done`, and `error` events;
- structured clarification questions, recommendations, answers, and inspected
  context provenance;
- explicit attachment lifecycle and private-upload behavior.

Clients must show an honest failure when conversation creation or persistence
fails. A locally generated identifier must not be presented as proof that a
server-side conversation exists.

## Security boundary

- The Quick surface receives only the minimum commands required for session
  presence, generation transport, cancellation, safe bytes upload, preferences,
  draft storage, focus/window lifecycle, and main-app handoff.
- It must not receive shell, PTY, Git, code-runner, arbitrary filesystem-path,
  workspace, updater, or broad secret-store commands.
- File attachments come from explicit user grants and are size/type checked
  before upload. Private mode must reject persistent attachment workflows until
  the server provides explicitly ephemeral uploads.
- Logs and error UI must not include access tokens, refresh tokens, draft text,
  prompt bodies, or attachment contents.

## Release evidence

Automated release checks must cover shortcut conflict rollback, repeated invoke,
account-scoped drafts, clarification fail-open, single first submission,
stream/cancel terminal-event races, server-ID migration, sign-out/account switch,
focus restoration, and least-privilege command access.

Platform smoke checks remain required on real macOS and Windows hardware for
multi-display placement, DPI changes, fullscreen/Spaces, assistive technologies,
IME composition, dictation permissions, sleep/wake, lock/unlock, login launch,
installer upgrade/uninstall, and OS foreground-activation restrictions.
