# Work in a folder (Mac "cowork") — status

Branch `native/mac-cowork` (from origin/main e3c6f6b6d). Local commits only:
not pushed, not deployed, not merged.

## What it is

The person picks a folder in the chat composer ("Work in a folder"). From then
on the chat's own model (the one they selected) can list, read (text, PDF,
Word/RTF), search, write, edit, move, make folders, move to the Trash, run
shell commands that start in the folder, and open files on the Mac. Every
destructive step asks first with a card in the chat: Deny / Allow Once /
Always for This Folder.

## Architecture

1. **Mac composer** (`ChatFolderControl`) picks a folder through `NSOpenPanel`
   only. `DesktopChatFolderStore` keeps a plain bookmark per conversation
   (UserDefaults `alevr.chat.folders`), separate from Work's grants so a chat
   folder is never advertised to the relay.
2. **Request**: the store is the conversation model's `localToolHost`. On each
   turn the request carries `localFolder: {name, access}` (display name only,
   never a path) and adds `local_folder` to `clientFeatures`. The web never
   declares it (`WEB_CLIENT_FEATURES` excludes it); iOS never sets a host.
3. **Server** (`src/lib/chat/local-folder*.ts`): `resolveApprovals` gates the
   tools on feature + folder + saved non-voice, non-lockdown chat turn + a
   tool-calling model. `buildNativeTools` adds the ten `folder_*` tools; the
   prompt gets a "Shared folder" section; a folder turn may take 24 tool
   rounds (`ToolLoop.maxRounds`). A call is shape-checked (no absolute paths,
   no `..`), sent as `{type:"local_tool", call:{id, tool, args}}` on the turn's
   own stream, and waits (in-process `globalThis` registry) for
   `POST /api/chat/local-tools/{callId}` from the same user. Results go to the
   model inside the untrusted envelope. Recorded as canonical tool
   `local_folder` with `args.action`.
4. **Mac executes**: `NativeConversationModel` hands each call id once to the
   host; `ChatFolderExecutor` (JunoWorkRuntime) runs it through `GrantAccess`
   + `WorkFileService`; commands go through Alevr Code's
   `CommandExecutionService.contained` (kernel sandbox). Tool rows render in
   the existing run block (`NativeLocalFolderPresentation`), expandable like
   every tool row.

## Security model

- A folder exists only because the person chose it in the macOS open panel.
  Nothing remote can create or widen one; the server never learns its path.
- Every location: `GrantedPath` (no absolute, `~`, `..`, control chars) then
  `GrantAccess.resolveForReading/ForMutation` immediately before the disk
  (`realpath(3)` of the target / deepest existing ancestor, must be inside the
  canonical root). Searches never walk a symlink. Tests cover `..`, absolute,
  symlinked-folder and symlinked-file escapes for read, write, search and a
  command's cwd.
- Read only vs read & write per folder (menu on the folder capsule). Read-only
  is refused **before** any card: no write, edit, move, mkdir, delete or
  command; open still allowed (asks).
- Ask first: replacing or editing an existing file, the Trash (never a
  permanent delete — no such path exists), any command, opening anything.
  "Always" remembers the kind for that folder only. Cards time out to Deny
  after 10 minutes (the server waits 11.5), and are answered Deny when the
  turn ends or the folder is removed.
- Commands: zsh under `sandbox-exec` with Code's profile — writes only inside
  the folder (plus per-user temp/toolchain caches), no network, credential
  paths unreadable, scrubbed environment (no Alevr token, no provider keys),
  1–300 s timeout (default 60), 48 KB output cap, process group killed. If
  `sandbox-exec` is missing the command still runs and the model is told it was
  not contained.
- Entitlements unchanged: the app is not sandboxed by design
  (`JunoDesktop.entitlements` explains why), so no user-selected entitlement is
  involved; bookmarks are plain, as Work's are.

## Moving the control into the composer tray

`native/composer-tray` had no tray commits when this was built, so the control
sits in the composer's controls row right after `+`
(`ChatComposer.controlsRow`, guarded by `!isPrivate, !voiceActive`). To move
it: delete that `if` block and put
`ChatFolderControl(conversationID: fixedProjectID == nil ? model.selectedConversationID : nil)`
in the tray's extension slot. It reads `@Environment(\.desktopChatFolders)`
(set in `JunoDesktopApp.liveRoot`) and needs nothing else. Keep the draft
hand-off in `ChatComposer.dispatch` (`chatFolders?.adoptDraft(into:)` after
`createConversationResolvingID`).

## Tests

- Web: `tests/local-folder-tools.test.ts` (tools only with the feature;
  lenient field; path checks; round trip; denial; timeout/stop),
  `tests/turn-stream.test.ts` (row recorded as `local_folder`).
- `JunoWorkRuntimeTests/ChatFolderExecutorTests` (containment, approvals,
  every tool).
- `JunoChatKitTests/NativeLocalFolderWireTests` (frame, request, result post,
  row words).
- `JunoDesktopTests/DesktopChatFolderTests` (draft → chat, relaunch, no path
  leaves, cards and "Always", stop answers no, contained shell refuses a write
  outside).
- Snapshots: `ChatFolderSnapshotTests` → `folder-composer`,
  `folder-composer-empty`, `folder-composer-read-only`, `folder-running`,
  `folder-approval`, `folder-approval-delete` (light + dark), in `shots/`.

## Open

- The bridge is in-process: correct while prod runs one `juno-backend`
  process. More than one process needs a table (approval receipts are the
  model).
- No signed-in end-to-end run yet: needs a deployed server with this branch
  and a Mac build pointed at it.
- iOS/web show past folder rows generically ("Read march.csv", "Used …") from
  `src/lib/run/presentation.ts`; no new web copy keys were added.
