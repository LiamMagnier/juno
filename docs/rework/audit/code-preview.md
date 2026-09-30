# Juno Code on Mac: Preview and browser audit

Date: 2026-09-30. Branch `rework/refoundation` @ `3e3040e6` (code identical to `main` @ `1feb392c`). Read-only pass.
Scope: the dev-server engine (`JunoCodeLocal/DevServer*.swift`, `StaticPreviewServer.swift`), discovery, the WebKit
preview surface and its agent tools (`JunoCodeUI/Views/Preview/*`), the desktop host (`native/macOS/JunoDesktop/App/DesktopCodeWorkspace.swift`,
`DesktopCodePreviewDock.swift`), approval and policy hooks, and `scripts/check-code-preview-wiring.mjs`.

Unless a path starts with `native/`, `src/` or `scripts/`, it is relative to `native/Packages/JunoCode/Sources/`.
Nothing was built or run. `node scripts/check-code-preview-wiring.mjs` was run (it passes, and §3.7 explains why that
proves little). Status of each finding: **CONFIRMED** means it was read in the code, or its logic was replicated;
**PLAUSIBLE** means the code allows it, but it needs a runtime check.

Companion documents:
- `docs/rework/research/code-computer-preview.md` has the competitor facts and gap IDs P1–P10. It also has the proposed
  Preview v2 vocabulary (§7.3) and the verify loop (§7.4). This audit does not repeat those. It adds the code-level
  bugs those documents do not cover, and it turns §7.3 and §7.4 into an engineering target.
- `docs/rework/audit/code-runtime-swift.md` covers the loop. Work already in progress on another workflow is out of
  scope here: the cache prefix, retries, crash-safe batches, output spill, durable shells, and the new file/search tools.
  This audit refers to durable shells only where Preview has to integrate with them.

---

## 0. Verdict

Preview is careful about **facts**. "Running" means that a live process answered an HTTP request
(`JunoCodeLocal/DevServerService.swift:710-740`). The agent can act only on loopback (`Views/Preview/CodePreviewInspectionTool.swift:13-27`).
Page text is redacted, and refs are regex-checked and JSON-encoded, so they cannot inject script. It is **not built for an
agent that loops on its own**:

1. **The preview belongs to a SwiftUI view, not to the session.** If the reader switches sessions, the dev server is
   killed. `open_preview` from a background session does nothing, yet it reports success. A crashed server cannot be
   restarted by the agent.
2. **The agent is blind to the server.** Compile errors, SSR stack traces and port conflicts never reach the model. Its
   only view of the page is `document.body.innerText`, which cannot see framework error overlays (shadow DOM).
3. **The agent cannot drive a real UI.** `el.click()` is not a pointer interaction. There is no navigation to a route,
   no key presses, and no viewport or dark-mode control. Below Full Access, every click and scroll asks for approval.
4. **Two S1 security bugs sit in the static server:** it serves `.env` with `Access-Control-Allow-Origin: *`, and it can
   crash the app with SIGPIPE. There is also one S1 approval bug: the reader approves "Use the preview?" without seeing
   the command that will run.
5. **A shared helper refuses ordinary commands.** `run_command` refuses every `a && b` chain, as well as `vitest` and
   `vite build`. This is not strictly Preview, but the helper exists for Preview, and it breaks the build/test loop.

So the owner's "think, build, look, loop" cannot close today on web work, except in Full Access, in the selected
session, on a Node project, with a pane that stays open, and without a framework error.

---

## 1. What exists

| Layer | Where | What it does |
|---|---|---|
| Process | `JunoCodeLocal/DevServerService.swift` (863 lines) | Runs one long-lived child per service under `sandbox-exec` (`:105-121`, network loopback-only by default), with a scrubbed env plus `BROWSER=none` and `FORCE_COLOR=0` (`:458-470`). It kills the process group with SIGTERM, then SIGKILL after 2 s (`:626-662`). It reads the URL from output (`:795`) and gates on an HTTP probe (`:710-740`). A 25 s silence note appears if no URL is seen (`:287-302`). |
| URL detection | `JunoCodeLocal/DevServerURLDetector.swift` | Takes the first loopback URL, then RFC 1918, then a bare `localhost:port`, then "listening on port N" (`:23-41`). ANSI and CR are stripped (`:132-175`). |
| Discovery | `Views/Preview/CodePreviewWindow.swift:140-320` + `JunoCodeLocal/DevServerCommandDiscovery.swift` | Reads `package.json` scripts at the root and in nested packages (depth 3, max 48). The package manager is taken from the lockfile. `index.html` or `public/index.html` becomes an in-process static server, but only when no `package.json` exists anywhere. |
| Static server | `JunoCodeLocal/StaticPreviewServer.swift` (490 lines) | BSD-socket HTTP/1.1 on `127.0.0.1:<ephemeral>`, GET/HEAD only, with a traversal check. |
| Model | `CodePreviewModel`, `CodePreviewWindow.swift:345-1232` | `@MainActor`. A static registry maps `previewID` to a model (`:348`). It holds the server state, a 2,000-line UI log, reconnect (8 × 1.2 s, `:1212-1223`) and browser diagnostics (100 kept, 20 returned). |
| Surfaces | Dock `CodePreviewDock` (`:1814-2167`), window `CodePreviewWindowView` (`:1251-1805`), `CodePreviewScene` (`:2175-2187`), hosted by `native/macOS/JunoDesktop/App/DesktopCodePreviewDock.swift` | Each surface creates its own `WKWebView`: non-persistent store, `isInspectable`, and a page-world console hook (`:2203-2235`). |
| Agent tools | `Views/Preview/CodePreviewInspectionTool.swift` | `open_preview` (no input, `.critical`), `inspect_preview` (`.read`), and `preview_browser` with `snapshot, click, type, select, scroll, wait, assert_text` (click/type/select/scroll are `.critical`). Registered in Code mode only (`Models/SessionController.swift:791-798`). The system prompt tells the model to use them (`Models/WorkspaceContext.swift:368-378`). |
| Guard rails | `JunoCodeRuntime/Tools/CommandAndTestTools.swift:173-193`, `JunoCodeCore/CommandClassifier.swift:163-166, 723-742` | These keep `&` and dev servers out of `run_command`, and point the model at `open_preview`. |
| Host wiring | `native/macOS/JunoDesktop/App/DesktopCodeWorkspace.swift:273-287, 311-316, 326-332, 788-800` | `open_preview` posts a notification. The workspace presents the dock only for the selected session. Changing session or leaving Code clears the target. |

### 1.1 What the agent can do in the preview today

| Capability | Juno today | Evidence |
|---|---|---|
| Start the discovered server | yes, `open_preview`, with no choice of command | `CodePreviewInspectionTool.swift:186-225` |
| Restart, stop, or list servers | **no** | none |
| Read the dev-server log | **no** | the log exists only in UI state, `CodePreviewWindow.swift:392, 615-622` |
| Navigate to a route, back/forward, reload | **no** | action enum `CodePreviewInspectionTool.swift:232-240` |
| DOM/ARIA snapshot with refs | partial: 80 elements, light DOM only, visibility dropped | `CodePreviewWindow.swift:872-950` |
| Click / type / select / scroll | synthetic JS only | `:1034-1100` |
| Key press, hover, drag, file upload | **no** | none |
| Screenshot | the visible pane only, retina PNG, ≤6 MB | `:992-1011` |
| Console | `error`/`warn`, `window.onerror` and `unhandledrejection`, last 20, `inspect_preview` only | `:350-385, :1188` |
| Network requests and HTTP status | **no** | none |
| Resize, mobile, dark mode | **no** (the page follows the Mac's appearance) | comment `:2219-2223` |
| Wait for readiness or settle | 8 s fixed, then "try again" | `:738-758` |
| Verify evidence for "done" | **no** (`VerificationEngine` records tests only) | `JunoCodeRuntime/VerificationEngine.swift:14-45` |

---

## 2. Can the agent verify its UI in a loop? A walkthrough

Take a Next.js app, the default "Ask before edits" (`workspaceWrite`) mode, and the task "fix the settings menu".

1. `open_preview` makes the approval card read "Use the preview? Open the local website Preview and start its development server".
   It does not say which script, or in which package (§3.6 PV-33). If the reader has meanwhile opened another session,
   the notification is dropped (`DesktopCodeWorkspace.swift:274-277`), but the tool still returns "Opened the local Preview" (PV-2).
2. `next dev` compiles for more than 8 s. `preview_browser snapshot` waits 8 s and then errors with "still starting… try again"
   (`CodePreviewWindow.swift:834-837`). The model polls, and each poll costs a turn (PV-23).
3. The page renders at the dock width, which is about 44% of the window (`DesktopCodePreviewDock.swift:78`). The model cannot choose a
   desktop or phone width, and it cannot go to `/settings` except by finding a link ref (PV-18).
4. It clicks the menu trigger. That is one approval prompt, because `click` is `.critical` and `workspaceWrite` asks on critical
   (`JunoCodeCore/PermissionModel.swift:170-171`). `el.click()` does not fire `pointerdown`, so a Radix `DropdownMenu`
   (Juno's own web app depends on `@radix-ui/react-dropdown-menu`) never opens (PV-19).
5. It edits the component. HMR patches the page with no navigation, so `loadState` stays `.loaded`. The next snapshot may
   read the DOM from before the update (PV-23). If the edit broke the build, the error sits in the server log (never shown to the
   model, PV-12) and in Next's shadow-DOM overlay (absent from `innerText`, PV-20). The model can read "no errors" and
   report done.
6. The reader glances at another session. The dock disappears and the server is killed (PV-1). Every later tool call
   fails with "No active local Preview".

Result: the loop only closes when the agent has Full Access, runs in the selected session and on a Node project,
the pane stays open, and nothing throws.

---

## 3. Bugs

Severity follows the companion doc. **S1** breaks a safety rule, crashes, or produces wrong actions. **S2** blocks an
autonomous loop. **S3** is parity or polish. "P0" marks the findings to fix before any new feature.

### 3.1 Lifecycle and ownership

| ID | Sev | Status | Finding | Evidence |
|---|---|---|---|---|
| PV-1 | S2 P0 | CONFIRMED | **Switching sessions kills the agent's server.** `onChange(of: selectedSessionID)` sets `previewTarget = nil`. The dock's `onDisappear` then calls `releaseSurface()`, which calls `shutDown()`, which calls `service.stop()`. Leaving Code does the same. Tools then throw `noActivePreview`, because they require `activeSurfaceCount > 0`. | `DesktopCodeWorkspace.swift:284-287, 311-316`; `CodePreviewWindow.swift:538-544, 588-598, 1851, 712-716, 730-734` |
| PV-2 | S2 P0 | CONFIRMED | **`open_preview` from a non-selected session is dropped, but reports success.** The observer requires `target.sessionID == controller?.sessionID`, and the tool result is hard-coded. Background and queued sessions cannot preview at all. | `DesktopCodeWorkspace.swift:273-283`; `CodePreviewInspectionTool.swift:206-223` |
| PV-3 | S2 P0 | CONFIRMED | **The agent cannot restart, stop or re-run a server.** When the pane is already open, the observer's `previewTarget == nil` guard ignores the request. Auto-start runs only in the dock's first `.task`. After a crash, or after an edit to `next.config`/`package.json`, the agent is stuck, and `open_preview` still says "Opened". | `DesktopCodeWorkspace.swift:277`; `CodePreviewWindow.swift:1842-1850` |
| PV-4 | S2 | CONFIRMED | **Pop-out creates a second page and can orphan the agent.** The dock stays up when the window opens, and each surface creates its own `WKWebView` with its own non-persistent store. The result is two loads, two HMR clients, doubled page side-effects, and sign-in that is not shared. Both coordinators write one `loadState`, and either navigation clears the shared diagnostics. `attach` runs only in `makeNSView`, and `activeWebView` is `weak`. Closing the pop-out therefore leaves no attached view while the dock is still visible, and the tools fail with "still attaching" after 8 s. | `DesktopCodeWorkspace.swift:326-332`; `CodePreviewWindow.swift:430, 687-689, 1202-1205, 2203-2235` |
| PV-5 | S2 | CONFIRMED | **The agent can only use a server that Juno itself spawned.** `awaitReadySurface` and `browserSurface` require `serverState.isLive`. Three cases are uninspectable: a server the reader typed in, a server they run in Terminal, and (soon) a durable-shell server. There is no url-attach mode. | `CodePreviewWindow.swift:741-745, 839-841` |
| PV-6 | S3 | PLAUSIBLE | Models are registered in a static dictionary from the view's `init` (`State(initialValue: .shared(for:))`). They are removed only by `releaseSurface`. A view that SwiftUI constructs but never shows leaves a zombie entry that `activeTarget(for:)` can return. | `CodePreviewWindow.swift:433-458, 1263-1265, 1825` |

### 3.2 Server, ports and logs

| ID | Sev | Status | Finding | Evidence |
|---|---|---|---|---|
| PV-11 | S2 P0 | CONFIRMED (logic replicated) | **`run_command` refuses normal commands.** `contains("& ")` matches every `&&` chain (for example `cd web && npm test` or `npm ci && npm run build`). `hasPrefix("vite")` matches `vitest run` and `vite build`. Both are denied as "background" or "dev server". Replicated with Node on 2026-09-30. Neither in-progress branch (`rf/code-runtime`, `rf/code-tools`) touches this file. Durable shells should replace the `&` rule, but the prefix and substring bugs must be fixed whichever lands first. | `JunoCodeRuntime/Tools/CommandAndTestTools.swift:173-193` |
| PV-12 | S2 P0 | CONFIRMED | **The dev-server log never reaches the model.** Lines go into `CodePreviewModel.log`, which is UI only, and `DevServerRun.recent`, which holds 40 lines and is used only for a failure reason. `inspect_preview` returns browser diagnostics only. Compile errors, SSR traces, `EADDRINUSE` and missing env are invisible unless they also appear in the page console. | `CodePreviewWindow.swift:392, 615-622, 1188`; `DevServerService.swift:587, 853-862` |
| PV-7 | S2 | CONFIRMED / fonts PLAUSIBLE | **The dev server has no internet and no way to request it.** `contained(...)` defaults to `allowsNetwork: false`, and the model uses that default. SSR fetches to remote APIs fail, and so do `npx` downloads and Google Fonts. Juno's own `src/app/layout.tsx` uses `next/font/google`, so the agent would judge typography against fallback fonts. There is no per-project override or prompt. | `DevServerService.swift:105-121`; `CodePreviewWindow.swift:464-467, 2067-2071`; `JunoCodeLocal/CommandSandboxProfile.swift:256-272` |
| PV-8 | S2 | CONFIRMED | **The first printed URL wins forever.** Suppose a proxy target, a Supabase `API URL: http://127.0.0.1:54321`, or a `turbo dev` sibling app prints before the server's own address. That URL is kept. The probe then either succeeds against the wrong server, so the preview shows another app, or loops until exit. The 25 s silence note is suppressed because a URL "was found". The only fix is typing the address, which then disables agent access (PV-5). | `DevServerService.swift:290-293, 795-798`; `DevServerURLDetector.swift:18-22` |
| PV-9 | S2 | CONFIRMED | **A LAN-only address works for the reader but fails for the agent.** The detector accepts RFC 1918 URLs, while the inspection policy accepts loopback only. | `DevServerURLDetector.swift:27-29, 54-56`; `CodePreviewInspectionTool.swift:13-27` |
| PV-10 | S2 | CONFIRMED | **Only `package.json` projects can start.** There is no launch config, no custom command, cwd or env, and no Django, Rails, Flask, Go, Hugo or PHP project outside `package.json`. The static option is offered only when no `package.json` exists anywhere, so a repo with a tooling-only `package.json` and a root `index.html` gets nothing. `run_command` refuses `&` and servers. So non-Node projects have **no agent-reachable preview**. Separately, the classifier forbids `python -m http.server`, `serve` and `http-server` outright, including inside `DevServerService`. A launch config that uses them would be refused. | `CodePreviewWindow.swift:149-234`; `DevServerService.swift:208-212`; `CommandClassifier.swift:163-166, 723-742` |
| PV-13 | S3 | CONFIRMED | One server per preview, and one preview per session. A frontend plus API pair cannot run. | `DevServerService.swift:74-75` |
| PV-14 | S2 | PLAUSIBLE | **Orphans after a crash.** Only in-process paths kill children: `stop`, `deinit` and the `willTerminate` observer. No PGID ledger exists. After a Juno crash (see PV-30), `next dev` keeps holding its port, and the next run silently moves to 3001. | `CodePreviewWindow.swift:480-493`; `DevServerService.swift:128-130` |
| PV-15 | S3 | CONFIRMED | No port management. Juno sets no `PORT`, picks no free port, and probes nothing before start. It relies on each framework's own fallback. A pinned port (`-p`, `strictPort`) fails late, as a generic failed state. | `DevServerService.swift:458-470` |
| PV-16 | S3 | CONFIRMED | `DevServerCommandDiscovery`'s static branch (`:76-99`) is dead code for the UI. If it were reused, its `public/` case would serve the wrong root, because `DevServerService` serves the command's `workspaceRoot` (`DevServerService.swift:164`). | as cited |
| PV-17 | S3 | CONFIRMED (latent) | `start()` blocks its caller for up to about 5 s while the previous group dies (`stopAndWait`), and the model is `@MainActor`. The UI never starts while live today, but a restart tool built on this would freeze the app. | `DevServerService.swift:157, 415-427` |

### 3.3 Agent browser tools

| ID | Sev | Status | Finding | Evidence |
|---|---|---|---|---|
| PV-18 | S2 | CONFIRMED | The vocabulary is too small. There is no `navigate`, back/forward/reload, `key`, `hover`, `drag`, `resize`, color scheme, network, console filter, `eval` or batch. This is P1–P3 in the companion doc. | `CodePreviewInspectionTool.swift:232-240, 332-335` |
| PV-19 | S2 | PLAUSIBLE (library behaviour; verify with a fixture) | **Clicks and typing are not real input.** `el.click()` dispatches one untrusted `click` event, with no `pointerdown`/`mousedown`/`pointerup`. Radix triggers (DropdownMenu, Select) open on `pointerdown`. `type` sets `.value` and fires `input`/`change` with no key events, so Enter-to-submit, `keydown` handlers and masked inputs never fire. For `contenteditable` it replaces `textContent`, which destroys ProseMirror or Lexical DOM. | `CodePreviewWindow.swift:1034-1079`; `package.json` (`@radix-ui/react-dropdown-menu`) |
| PV-20 | S2 | CONFIRMED (spec behaviour; verify with a fixture) | **Framework error overlays are invisible to the text snapshot.** Text comes from `document.body.innerText`, and elements from `querySelectorAll`. Neither enters shadow roots or iframes. Vite's `<vite-error-overlay>` and Next's `<nextjs-portal>` render in shadow roots. A broken page can therefore read as the normal page, and only a screenshot shows the error. Controls inside web components never get refs. | `CodePreviewWindow.swift:874-904, 1120` |
| PV-21 | S2 | CONFIRMED | **Refs are unreliable.** Only the first 80 matches in DOM order get refs, hidden nodes included. The selector omits `tab`, `menuitem`, `checkbox`, `switch`, `option`, `summary`, `label`, `[contenteditable]` and click-handler `div`s. `visible` is computed (`:896-900, :912`) but dropped: `CodePreviewBrowserElement` has no field for it. The model therefore cannot tell a visible button from an off-canvas one. | `CodePreviewWindow.swift:874-877, 937-950`; `CodePreviewInspectionTool.swift:242-249` |
| PV-22 | S3 | CONFIRMED | **Actions do not report what they caused.** `preview_browser` results carry no console diagnostics, so the model needs a separate `inspect_preview` to learn that a click threw. Diagnostics are also wiped at every navigation start, so the error that triggered a full reload is lost. | `CodePreviewInspectionTool.swift:251-287`; `CodePreviewWindow.swift:1202-1205` |
| PV-23 | S2 | CONFIRMED | **Readiness and settling are naive.** There is a fixed 8 s wait and then a "try again" error, with no `wait_for(timeout)`. The code has no HMR awareness: after an edit the page patches in place, `loadState` stays `.loaded`, and a snapshot can precede the update. The post-action settle is a blind `Task.sleep` (default 150 ms). | `CodePreviewWindow.swift:738-758, 834-837, 1013-1016`; `CodePreviewInspectionTool.swift:459-461` |
| PV-24 | S3 | CONFIRMED | **Screenshots capture whatever the pane happens to be.** `takeSnapshot(configuration: nil)` captures the pane's current bounds at retina scale as PNG. Layout is therefore judged at an accidental breakpoint, with no full page, no scale and no JPEG. This is P9 in the companion doc. | `CodePreviewWindow.swift:992-1011, 1164`; `DesktopCodePreviewDock.swift:72-81` |
| PV-25 | S3 | CONFIRMED | **Local sign-in cannot be tested.** Password fields are refused, and there is no secure-fill alternative. The store is non-persistent, so sign-in is lost on every open (P7). | `CodePreviewWindow.swift:1063, 2205` |

### 3.4 WebKit surface

| ID | Sev | Status | Finding | Evidence |
|---|---|---|---|---|
| PV-26 | S2 | CONFIRMED | **No navigation policy and no `WKUIDelegate`.** The coordinator implements neither `decidePolicyFor` nor any UI-delegate method. The page, a redirect or the reader can take the pane to any external site. The agent's origin check then refuses to act, which is safe, but the pane has quietly become a general browser inside Juno's chrome. Popups and `target=_blank` do nothing, so OAuth popups fail. `alert`/`confirm`/`prompt` are auto-dismissed, and `confirm()` returns false, so "Delete? OK" flows cannot be tested. `<input type=file>` never opens a panel, because macOS requires `runOpenPanelWith`. The main-document HTTP status (for example a 500) is never read. | `CodePreviewWindow.swift:2259-2308` |
| PV-27 | S3 | PLAUSIBLE | The diagnostics hook and the message handler live in the page content world. The page can overwrite the hook or post forged diagnostics, and so can any subframe, cross-origin iframes included (the handler does not check `frameInfo`). The results are labelled untrusted, which bounds the damage. | `CodePreviewWindow.swift:350-385, 2206-2216, 2270-2280` |

Kept as-is (good): the agent is loopback-only and must match the preview origin (`CodePreviewInspectionTool.swift:13-52`; the post-hoc URL check is at `CodePreviewWindow.swift:925-935`). Typed addresses must be http(s), so `file://` and `javascript:` are refused (`:636-647`). Refs are regex-validated and text is JSON-literal-encoded (`:1018-1032`). Password values are never returned (`:885, :910`). Page text is redacted (`:944-961`). The store is non-persistent by default, and Web Inspector is available to the reader (`:2227`).

### 3.5 Static server

| ID | Sev | Status | Finding | Evidence |
|---|---|---|---|---|
| PV-29 | S1 P0 | CONFIRMED | **It serves secrets to any origin.** Every file under the root is served, dotfiles included (`.env`, `.git/config`, `.npmrc`), with `Access-Control-Allow-Origin: *` and no `Host` check. Any page open in any browser on the Mac can scan the ephemeral range and `fetch('http://127.0.0.1:<port>/.env')`. The preview page itself (untrusted project output) can do the same. | `StaticPreviewServer.swift:265-296, 357-363` |
| PV-30 | S1 P0 | PLAUSIBLE | **SIGPIPE can kill Juno.** Client sockets get no `SO_NOSIGPIPE`, and the app never ignores SIGPIPE (the only `F_SETNOSIGPIPE` is `CommandExecutionService.swift:276`). A write to a socket the browser already closed, such as a reload during a large asset, raises SIGPIPE, and its default action terminates the process. | `StaticPreviewServer.swift:131-133, 405-414` |
| PV-31 | S2 P0 | CONFIRMED | **Large files are truncated.** The client socket is `O_NONBLOCK`, and the write loop stops at the first `write <= 0` (`EAGAIN`), while `Content-Length` promises the full body. Images, bundles and videos bigger than the socket buffer arrive cut off. | `StaticPreviewServer.swift:131-133, 357-360, 405-414` |
| PV-32 | S3 | CONFIRMED | Reads are a busy-wait loop (5 ms `usleep`, up to 2 s per connection on a global queue). Whole files are read into memory. There is no `Range` support (videos cannot seek) and no live reload, and the agent has no reload tool either. | `StaticPreviewServer.swift:160-195, 345` |

### 3.6 Approval and policy

| ID | Sev | Status | Finding | Evidence |
|---|---|---|---|---|
| PV-33 | S1 P0 | CONFIRMED | **Approvals do not show what is approved.** `open_preview` takes no input and is approved before discovery runs. The card says "Use the preview?" with a fixed summary. The reader never sees the script, its body, the package or the cwd. A click is summarised as "Click an element in the local Preview", without the element's name. This is consent without the object, which falls short of the owner's deterministic-approval rule. | `Studio/StudioApprovalPrompt.swift:299-301`; `CodePreviewInspectionTool.swift:192-203, 386-395` |
| PV-34 | S2 | CONFIRMED | **Risk tiers make loops impractical below Full Access.** Click, type, select and even scroll are `.critical`, and `workspaceWrite` and `askBeforeChanges` ask on every one. A ten-step UI check means ten prompts. Claude Code Desktop, by contrast: "Your local dev servers and project files don't need approval, so auto-verify keeps working without prompts". | `CodePreviewInspectionTool.swift:379-384`; `JunoCodeCore/PermissionModel.swift:164-171` |
| PV-35 | S3 | CONFIRMED | Opening the dock auto-starts the suggested script. On a project's first run it does not say which one. | `CodePreviewWindow.swift:1842-1850, 2038-2042` |

### 3.7 UI, copy and checks

| ID | Sev | Status | Finding | Evidence |
|---|---|---|---|---|
| PV-36 | S3 | CONFIRMED | **The status pill breaks an owner rule.** A floating `statusPill` capsule over the page ("Ready", "Running · npm run dev") breaks the no-status-pills rule, even though its dot was already removed (`:2311-2324`). The shield and caution icons for "sandboxed" (`:2067-2077`) are status badges too. | `CodePreviewWindow.swift:1609-1642, 2083-2096` |
| PV-37 | S3 | CONFIRMED | **Duplicated chrome and a heavy log.** There are two full preview chromes (already in `02-AUDIT-UI.md:265`). The window log is a non-lazy `VStack` of up to 2,000 rows that re-renders on every line, which may cause hitches with chatty servers (PLAUSIBLE). | `CodePreviewWindow.swift:1741-1766` |
| PV-38 | S3 | CONFIRMED | **Reload loses the route, and the copy is stale.** ⌘R and the reconnect retries load the *base* address, not the current route, and the address field never follows in-page navigation (no KVO on `webView.url`). The copy "It cannot mirror an iOS Simulator" is stale, because `JunoSimulator` and `DesktopSimulatorDock` exist. | `CodePreviewWindow.swift:673-677, 2237-2250, 1554-1566` |
| PV-39 | S3 P0 | CONFIRMED | **`code:preview:check` checks strings, not behaviour.** It does not require the `.junoCodePreviewOpenRequested` observer, which is the one link that makes `open_preview` do anything, and it exercises no behaviour. No test drives `inspect_preview` or `preview_browser` against a real page. `CodePreviewHarnessTests` covers names, fail-closed paths and origin policy only. | `scripts/check-code-preview-wiring.mjs:28-69`; `native/Packages/JunoCode/Tests/JunoCodeUITests/CodePreviewHarnessTests.swift` |

---

## 4. Parity with Claude Code Desktop, and a Codex and Cursor check

Claude Code facts come from two sources. The first is its docs ([desktop](https://code.claude.com/docs/en/desktop), fetched 2026-09-30).
The second is the Browser-pane tool manifest that the Claude desktop build on this Mac exposed to this session on
2026-09-30 (`mcp__Claude_Browser__*`). That manifest is primary evidence of one shipping build, not documentation.
Codex facts come from [learn.chatgpt.com/docs/browser](https://learn.chatgpt.com/docs/browser?surface=app), which
`developers.openai.com/codex/app/browser` redirects to. Cursor facts come from [cursor.com/docs/agent/browser](https://cursor.com/docs/agent/browser) (undated).
Both were fetched 2026-09-30.

| Capability | Juno | Claude Code Desktop | Codex app | Cursor |
|---|---|---|---|---|
| Committed server config | no | `.claude/launch.json`: `name, runtimeExecutable, runtimeArgs, port, cwd, env, autoPort, program, args, url` | UNVERIFIED | UNVERIFIED |
| Multiple servers, attach to a running one | no / no | yes (`preview_list`; `url` with no command attaches) | localhost pages, yes | yes, any URL |
| Port conflicts | the framework's own fallback | `autoPort` true/false/ask once; passes `PORT` | UNVERIFIED | UNVERIFIED |
| Server logs to the model | no | `preview_logs(level, search, lines)` | UNVERIFIED | no mention |
| Navigate, a11y tree, find | no / partial / no | `navigate`, `read_page` (refs, interactive filter), `find` | "Navigate and read" | "Navigate … anywhere" |
| Real input | synthetic click and type | `computer` click/double/right/hover/drag/key/scroll, `form_input` | click and type | click, double, right, hover, type, scroll |
| Console and network | error/warn only / no | `read_console_messages(pattern, onlyErrors)`, `read_network_requests` (body by id) | "console output and network traffic via Developer mode" (CDP, approval) | console yes, network yes |
| Viewport and dark mode | no | `resize_window` presets mobile 375×812 (mobile UA and touch), tablet 768×1024, desktop; `colorScheme` light/dark | UNVERIFIED | UNVERIFIED |
| JS eval | no | `javascript_tool`, labelled "DEBUGGING and INSPECTION only" | full CDP behind approval | UNVERIFIED |
| Auto-verify after edits | no | `autoVerify`, on by default: "takes screenshots, checks for errors, and confirms changes work" | relies on user comments and Annotate | UNVERIFIED |
| Approval for local servers | every click in non-Full modes | none needed for local dev servers | confirm on "sensitive actions" | manual, allow-listed or auto-run modes |
| Persist sign-in | no | **Persist sessions** toggle | own profile, sign in inside | cookies, localStorage, IndexedDB persist |
| User feedback on the page | no | UNVERIFIED | browser comments and **Annotate** | Design Mode (companion doc §3.6) |

Juno's structural advantages are worth keeping. It observes the served URL instead of assuming port 3000. It runs the
dev server under a kernel sandbox. It gives the agent loopback-only scope with redaction. Claude's docs default `port`
to 3000, and they send non-loopback `url`s through a per-site permission.

---

## 5. Target design

It builds on companion §7.3 (tool vocabulary) and §7.4 (verify loop), and fixes every PV above. Owner rules apply:
no status pills or decorative dots, native Liquid Glass, and nothing consequential without deterministic approval.

### 5.1 Ownership: the preview belongs to the session, not the view

- **`PreviewRegistry` (actor, `JunoCodeLocal`)** owns every server and every page. Entries are keyed by
  `(checkout root, config name)`. Sessions hold **leases**, and surfaces are only viewers.
  - A server lives until one of three things happens: its last lease ends (session archived or deleted), the reader or
    agent stops it, or it has been idle past a timeout (default 30 min with no lease and no surface).
  - It never stops because a view disappeared. This fixes PV-1 and PV-3.
  - Two sessions on the same checkout share one server instead of fighting over `.next`. Worktrees get their own.
- **PGID ledger.** `~/Library/Application Support/Juno/preview-servers.json` records `pgid, pid, cwd, config hash, started`.
  On launch, Juno reaps entries whose owner is gone, by checking that the pgid's leader still has the recorded start
  time before it signals. This fixes PV-14.
- **Move blocking work off the main actor.** `DevServerService.start` becomes `async` (`await stop()` and then launch), so a
  restart never blocks the main actor. This fixes PV-17.
- **Durable shells (in progress) are the process layer.** A preview server is a durable shell with `role: server` and
  an observed URL. `preview_list` and the shell list therefore agree. `preview_attach(shell_id)` promotes any shell that
  printed a loopback URL. Once shells land, `checkForUnmanagedPreviewServer` is deleted, and the classifier's
  static-server refusal applies to `run_command` only, not to configured servers. This fixes PV-10 and PV-11, alongside the
  immediate P0 patch in §5.10.

### 5.2 One page per preview, which also works in the background

- **One `WKWebView` per preview, owned by `PreviewPage` (`@MainActor`) and not by a SwiftUI view.** The dock and the window
  *re-parent* the same view (`NSViewRepresentable` that adds or removes an existing `NSView`). That gives one load, one
  HMR client, one sign-in and one diagnostics buffer. This fixes PV-4.
- **An offscreen host.** When no surface shows the page, it lives in a borderless, non-activating host window that
  is never ordered front. The window is sized to the requested viewport, so tools work for background sessions (PV-1,
  PV-2). **UNVERIFIED:** WebKit may throttle timers, rAF and snapshots for occluded or offscreen windows. The first step
  is a one-day spike. It should measure `takeSnapshot`, `requestAnimationFrame` cadence and HMR socket liveness in an
  offscreen window. The fallback is to keep a 1-pt, alpha-0.01 on-screen host, which needs an owner call because it is a
  hack.
- **Viewport as data.** The page has a `viewport: (width, height, deviceScale, mobileUA, colorScheme)`, which is set by
  sizing the host frame, `customUserAgent` and `appearance` (`.darkAqua`/`.aqua` drives `prefers-color-scheme`, as
  the existing comment at `CodePreviewWindow.swift:2219-2223` says). The visible pane shows the page letterboxed at that
  size when a preset is chosen, and "Responsive" follows the pane. This fixes PV-24 and P2.

### 5.3 Launch configuration

- **`.juno/launch.json`**, plus a read-only import of `.claude/launch.json` when present. The owner's own repo already has
  five configurations there (`.claude/launch.json` in `~/Developer/project/juno`). Field set:
  `name, runtimeExecutable, runtimeArgs, program, args, cwd, env (non-secret), port, autoPort, url`. Juno adds three fields:
  - `network: "loopback" | "internet"` (default `loopback`);
  - `ready: { path?: "/health", timeoutSeconds?: 90 }`;
  - top-level `autoVerify` (default `true` for web).
- **Discovery writes the first file.** It covers the current `package.json` scan plus Python, Rails, PHP, Hugo and Go,
  and static sites as a `juno:static` config. The reader reviews it in the pane. After that, the file is the only source
  of truth. This fixes PV-10 and PV-16.
- **URL truth, keeping Juno's current principle.** A URL counts as the server's only if a socket that listens on its
  port belongs to the server's process group. Check that with `proc_pidinfo(PROC_PIDLISTFDS)` and
  `PROC_PIDFDSOCKETINFO` over the group's pids, not with a string match.
  - Printed URLs whose port the group does not own are ignored. This fixes PV-8.
  - When `port` is set, the probe goes straight to it.
  - LAN addresses are rewritten to loopback only if the group also listens on the wildcard or loopback address.
    Otherwise the preview says why the agent cannot use it. This fixes PV-9.
- **Ports.** `autoPort: true` means Juno finds a free port by `bind` probe and passes `PORT`. `false` means it checks
  before launch and fails with the owning process from `proc_pidinfo`, with no restart loop. Unset means ask once and
  save, as Claude does. This fixes PV-15.
- **Env.** Juno already uses a scrubbed environment. Config `env` holds non-secret values. Secrets come from a
  per-project Keychain item that the reader edits in Settings. They are injected into the child only and never into the
  model context.

### 5.4 Network policy for dev servers

The default stays loopback-only. Seatbelt network rules can name only `localhost` or `*` as the remote host (the profile at
`CommandSandboxProfile.swift:261-267` names only `localhost`), so per-domain rules are not possible in the kernel.

- When the log shows a blocked outbound attempt, Juno asks once, per project and per config hash. The patterns are
  `getaddrinfo ENOTFOUND`, `EAI_AGAIN`, `connect EPERM` to a non-loopback address, and `Failed to download … Google
  Fonts`. The card reads "The dev server tried to reach fonts.googleapis.com. Allow this project's server to use the
  internet?" and offers **Allow for this project** or **Keep offline**.
- The answer is stored as `network: "internet"` in local (not committed) state, bound to the config hash. It is
  deterministic, visible and revocable. This fixes PV-7.
- A later step could route traffic through a local proxy with a domain allowlist. It is not needed for v2.

### 5.5 Tools

The vocabulary is companion §7.3. Implementation decisions follow.

- **Servers:**
  - `preview_start(name?)`, `preview_stop(name)`, `preview_restart(name)` and `preview_list()`, with state, URL,
    port and uptime;
  - `preview_logs(name, level: all|error, search?, since_cursor?)` from a 5,000-line ring buffer in the service, not
    the view. This fixes PV-3 and PV-12.
- **Browser (`preview_browser`):**
  - Actions: `navigate(path | same-origin url | back | forward | reload)`, `snapshot`, `find(query)`,
    `click(ref | x,y; button, count, modifiers)`, `hover`, `drag`, `type(ref, text, submit?)`, `key(chord, repeat)`,
    `select`, `scroll`, `scroll_to(ref)`, `wait_for(text | selector | url | settled, timeout ≤ 60 s)`,
    `screenshot(full_page?, scale?, clip_ref?)`, `resize(preset | w×h, color_scheme)`, `console(level, pattern, since)`,
    `network(filter: failed|all, id → body ≤ 64 KB)`, `eval(js)` and `batch([...])`.
  - `eval` is `.critical`, off unless enabled per project, and labelled debug-only. That matches Claude's labelling and
    Codex's approval gate.
- **Every result reports what the action caused.** Each result carries the URL, title, main-document HTTP status,
  console errors *since the previous action* and failed requests since the previous action. A screenshot is added when
  asked, or automatically on a failed `assert`/`wait_for`. The model can never miss a thrown click. This fixes PV-22.
- **Snapshot.**
  - It runs in an isolated `WKContentWorld` (`juno-preview`), so the page cannot see or spoof refs.
  - It walks open shadow roots and same-origin iframes.
  - It orders viewport-visible elements first, with a cap of 300 refs, and keeps `visible`, bounding box and
    `aria-*` state.
  - The role set includes tab, menuitem, checkbox, switch, option, summary, label, `[contenteditable]` and elements
    with pointer listeners (found through a `cursor: pointer` heuristic).
  - It reports an active framework error overlay as `error_overlay: <text>` by reading
    `vite-error-overlay`/`nextjs-portal` shadow text. This fixes PV-20 and PV-21.
- **Input fidelity.**
  - The primary path synthesizes `NSEvent` mouse and key events and delivers them to the `WKWebView` at the ref's rect
    centre. These arrive as trusted events, with pointerdown/up, focus and IME.
  - The fallback is a full JS sequence: `pointerdown → mousedown → focus → pointerup → mouseup → click`, and
    `keydown/keypress/input/keyup` per character.
  - **UNVERIFIED** until the spike: whether synthesized NSEvents reach a view hosted offscreen. This fixes PV-19.
- **Instrumentation.**
  - The page-world shim is kept for console, `fetch`/XHR failures and `WebSocket` errors. It is marked untrusted, and
    each message is accepted only when its `frameInfo.securityOrigin` equals the preview origin (PV-27).
  - The main-document status comes from `decidePolicyFor navigationResponse`.
  - Resource failures come from `PerformanceObserver` and `didFail…`.
  - The diagnostics buffer holds 500 entries and is **not** cleared on navigation. Entries carry a navigation id instead.
- **Secure fill.** A `type` into a password field is allowed only with a `secret: "<name>"` handle. That handle resolves
  from the per-project Keychain test credentials in §5.3. The value never enters the model context, and the transcript
  shows `••••`. This fixes PV-25.
- **Persist sign-in.** `WKWebsiteDataStore(forIdentifier:)` per checkout. It is off by default, has a "Clear data" command
  in the pane menu, and is shared by the dock and the window through §5.2 (P7).

### 5.6 WebKit hardening

- **`decidePolicyFor navigationAction`.** Allow the preview origin and configured loopback `url`s. For anything else,
  cancel, open it in the reader's default browser when the action came from a user gesture, and tell the agent "external
  navigation is not available" otherwise. OAuth that must return to localhost can be allowed per config through
  `allowedExternalOrigins`, with a reader-approved list. This fixes PV-26.
- **`WKUIDelegate`:**
  - `createWebViewWith`: a same-origin popup loads in the same page; an external one goes to the default browser.
  - `alert`/`confirm`/`prompt` are recorded as a dialog event on the next result. The agent answers with
    `preview_browser dialog(accept|dismiss, text?)`. Unanswered dialogs are dismissed after 30 s.
  - `runOpenPanelWith` offers only files inside the workspace, and only through an explicit `upload(ref, path)` action
    (`.write`).
- **Downloads** are cancelled and reported. `file://`, `data:` top-level and `javascript:` navigations stay refused.

### 5.7 Static server hardening

1. Deny dotfiles and dot-directories. Keep a denylist of `node_modules`, `.git`, `*.pem`, `*.key` and `.env*`.
2. Drop `Access-Control-Allow-Origin: *`, and require `Host` to be `127.0.0.1:<port>` or `localhost:<port>`. Together
   these stop cross-origin reads and DNS rebinding (PV-29).
3. Set `SO_NOSIGPIPE` on every accepted socket (PV-30).
4. Use a blocking write loop with `poll`, or `DispatchIO`, until the whole body is sent. Stream files instead of loading
   them whole. Support `Range` (PV-31, PV-32).
5. Add live reload: inject a 1-line SSE client into served HTML, and push a reload when a file under the root changes.
   Use the existing `WorkspaceChangeDetector` (PV-32).

### 5.8 Permissions (deterministic)

| Action | Risk | Effect |
|---|---|---|
| `preview_list`, `preview_logs`, `snapshot`, `find`, `screenshot`, `console`, `network`, `wait_for`, `scroll`, `scroll_to`, `resize`, `navigate` (same origin), `reload` | `.read` | Always allowed in Code mode. |
| `preview_start` or `preview_restart` of a config **whose hash the reader approved** in this project | `.read` | The approval is the config, not the call. |
| `preview_start` of a new or changed config | `.critical` | The card shows the exact argv, cwd, env *keys*, `network` and the package, from the config. It offers **Allow once / Always for this config**, and "Always" is stored with the config hash. This fixes PV-33 and PV-35. |
| `click`, `type`, `select`, `key`, `hover`, `drag`, `dialog` on the loopback preview | `.execute` | Allowed after the server's config is approved. The prompt policy follows the mode ladder, but "Always for this preview" is offered once per session, not once per action. The summary names the element: `Click "Delete project" (button)`. This fixes PV-34. |
| `upload` | `.write` | Workspace files only. |
| `eval` | `.critical` | Off unless enabled per project. |
| Any action on a non-preview origin | refused | The agent never gets a general browser here. External browsing stays a separate, owner-decided feature. |

The companion doc's rule applies: a reviewer model may only add friction, never replace one of these grants.

### 5.9 The verify loop in Preview (implements companion §7.4)

- **Settle.** After an edit batch that touches files under a running config's `cwd`, the page settles on the first of:
  - a navigation completes (a full reload);
  - both network and DOM are idle: no pending fetch, XHR or script resource for 300 ms (`PerformanceObserver`) and no
    DOM mutations for 300 ms, bounded at 10 s;
  - an error overlay appears.
  
  Juno also scans the server log since the edit for compile-error patterns (for example `Failed to compile`,
  `Module not found`, `error TS`, `[vite] Internal server error`), and for stderr in general. This fixes PV-23.
- **Evidence the model cannot forge.** The runtime mints `VerificationEvidence.ui`, and only from facts it observed
  itself:
  - `url`, the viewport and HTTP 2xx;
  - no *new* console errors compared with the pre-edit baseline;
  - no error overlay and no new server-log errors;
  - the assertions that passed;
  - a screenshot hash.
  
  It is recorded through `VerificationEngine.recordUIVerification`, parallel to `recordTestVerification`
  (`VerificationEngine.swift:14-45`, `AgentOrchestrator.swift:1186`). A goal with UI acceptance criteria cannot finish
  without it.
- **Budget.** At most 3 verify rounds per turn. The loop stops early when the same failure signature repeats. That
  matches companion §7.4.
- **Transcript.** Each round is one quiet row, "Checked /settings at desktop and phone: no errors", with inline
  thumbnails. There are no pills, and failures read in words.

### 5.10 UI (owner rules)

- **One chrome**, shared by the dock and the window. It fixes PV-37 and deletes the duplicate. It is a Liquid Glass
  toolbar with:
  - a servers menu (multi-server; Start, Stop, Restart, Edit configuration);
  - an address field that follows navigation (KVO on `url`), with back, forward and reload that keep the route (PV-38);
  - a device menu (Responsive, Phone, Tablet, Desktop);
  - an appearance menu (System, Light, Dark);
  - log and "Keep sign-in" toggles.
- **State in words, in the toolbar subtitle**, for example "Running `pnpm run dev` in apps/web on :3000". The floating
  status capsule and the shield and caution badges are removed (PV-36). Containment moves into that sentence ("offline"
  or "online") and into the config card.
- **Agent at work:** an edge glow on the page while Juno drives it, following the shipped "glow = state" rule, with the
  plain sentence "Juno is using the preview" and **Stop**. Esc in the pane stops agent control.
- **Log drawer:** a lazy list over the service ring buffer. Selecting lines lets the reader send them to chat.
- **Annotate** (companion §7.3.5) sits later, on the same page object.
- The stale simulator copy is replaced by a pointer to the Simulator pane (PV-38).

### 5.11 Checks and tests

- **`check-code-preview-wiring.mjs`.** Require the notification observer (or, after §5.1, the registry lease call from
  the tool). Require the tool registrations, the `WKUIDelegate` and navigation policy, and `SO_NOSIGPIPE`. Drop
  string checks on implementation details that §5 replaces (PV-39).
- **Offscreen WebKit tests** (no screen control, following the owner's "offscreen snapshot tests" practice). Use fixture
  pages served by `StaticPreviewServer`:
  1. a Radix-like trigger that opens only on `pointerdown` (PV-19);
  2. a shadow-root error overlay (PV-20);
  3. more than 80 hidden elements before the target (PV-21);
  4. `confirm()` and `window.open` (PV-26);
  5. a 20 MB asset with a client that closes mid-transfer (PV-30, PV-31);
  6. a `.env` request with a foreign `Host` and `Origin` (PV-29).
- **Service tests:**
  - URL ownership against a process that prints another server's URL (PV-8);
  - `autoPort` with a squatter on the port (PV-15);
  - the reaper with a stale ledger (PV-14);
  - lease lifetime across a simulated session switch (PV-1);
  - `run_command` accepting `a && b`, `vitest run` and `vite build` (PV-11).
- **End-to-end (manual smoke, following the owner's release practice):** a Next fixture, "fix the settings menu", in
  `workspaceWrite`. Expect at most 2 prompts, a completed verify round with `ui` evidence, and a working session switch
  midway.

### 5.12 Delivery order

| Step | Contents | Size (estimate) |
|---|---|---|
| A. P0 fixes, before any feature | PV-11 (tokenised check: a trailing `&` token only, and exact program names), PV-29/30/31 (static server), PV-33 (show the command before approval: resolve discovery before the card), PV-2 (an honest `open_preview` result that waits for or reports the state), PV-3 (`open_preview` restarts a dead server), PV-4 attach-on-appear, PV-38 route-preserving reload, PV-39 check | 2–3 days |
| B. Ownership | Registry and leases, one page per preview, offscreen host spike, PGID ledger, async start, launch config with import, URL ownership, ports, network ask, `preview_logs` | 1–1.5 weeks |
| C. Tools | Vocabulary, isolated world, trusted input, shadow and iframe snapshot, per-step diagnostics, viewport and scheme, dialogs, navigation policy, secure fill, risk table | 1–1.5 weeks |
| D. Loop | Settle, log scan, `autoVerify`, `VerificationEvidence.ui`, transcript rows, UI consolidation | 1 week |

Durable-shell integration (§5.1, last bullet) lands in B or C, whichever comes after the shell work merges.

---

## 6. Open questions and UNVERIFIED items

1. Do WebKit timers, HMR sockets, `takeSnapshot` and synthesized `NSEvent`s work in a never-ordered-front window (§5.2, §5.5)?
   This decides between the offscreen host and a visible host.
2. Do Juno's Bedrock and OpenAI model paths accept per-step screenshots at the proposed cadence? This interacts with the
   in-progress image-retention change on `rf/code-runtime` (`ImageRetention.swift`).
3. Should agent browsing of external sites ever exist in Code, as Claude Desktop and Codex allow with site approvals?
   This audit keeps it refused. It is an owner decision (companion §8).
4. Is proof-of-work (a step strip or recording) attached to PRs? That is companion P10 and an owner decision.
5. Claude Code, Codex and Cursor rows marked UNVERIFIED in §4 were not confirmed from a primary source in this pass.

## 7. Sources

- Claude Code Desktop docs, "Preview your app", "Configure preview servers", "Port conflicts" and "Browse external sites":
  https://code.claude.com/docs/en/desktop (fetched 2026-09-30).
- Claude desktop Browser-pane tool manifest observed in this session on 2026-09-30: `preview_start`, `preview_list`,
  `preview_logs`, `preview_stop`, `navigate`, `computer`, `read_page`, `find`, `form_input`, `get_page_text`,
  `javascript_tool`, `read_console_messages`, `read_network_requests`, `resize_window`, `tabs_*`, `browser_batch`.
  This is primary evidence of one build.
- Codex / ChatGPT desktop in-app browser: https://learn.chatgpt.com/docs/browser?surface=app, which
  https://developers.openai.com/codex/app/browser redirects to with a 308 (fetched 2026-09-30).
- Cursor browser tool: https://cursor.com/docs/agent/browser (fetched 2026-09-30; undated page).
- Companion research: `docs/rework/research/code-computer-preview.md` §2.2, §5 (P1–P10), §7.3, §7.4 and §9.
- Prior audits: `docs/native/code-rework/01-AUDIT-RUNTIME.md` (tool table), `02-AUDIT-UI.md:265` (two chromes),
  and `docs/rework/audit/code-runtime-swift.md` (the `&` refusal; durable shells plan).
