# Computer use and preview in coding agents: research for Juno Code (Mac)

Date: 2026-09-30. Branch `rework/refoundation`. Author: research subagent (read-only on code).

Scope: how Codex, Claude Code, Cursor and others let a coding agent **see and operate apps** (computer use) and **run, view and verify what it built** (preview and browser). The goal is to specify what Juno Code on macOS still lacks, so that it becomes an agent that builds, looks at the result, judges it and loops. This does not re-specify the loop hardening and new tools that another workflow is building now: cache prefix, retries, crash-safe batches, malformed JSON, output spill, usage ledger, durable shells, multi_edit/apply_patch, image/PDF reads, grep context, todo_write, ask_user, exit_plan, nested AGENTS.md and skill trust. Everything below sits on top of that work.

Source rules: competitor facts come from primary sources fetched on 2026-09-30, with URLs in §9. A secondary source is labelled as such. Anything that could not be confirmed is marked **UNVERIFIED**. "Observed manifest" means the tool schemas that the Claude Code desktop build on this Mac exposed to this session on 2026-09-30 (`mcp__computer-use__*`, `mcp__Claude_Browser__*`, `mcp__Claude_Code_iOS_Simulator__*`, `mcp__claude-in-chrome__*`). They are primary evidence of one shipping build, not documentation.

---

## 1. Findings in brief

1. **The field has settled on three surfaces, used in a fixed order.** The order is: structured tools (MCP, shell, Xcode), then an agent-owned browser for web work, then a simulator driver for iOS, then app-scoped computer use for native apps, and full-screen takeover only as a last resort. Claude Code documents this ladder word for word. Codex says "For web apps you are building locally, use the built-in browser first." Juno has all four surfaces in part, but no ladder, and computer use is whole-screen only.
2. **Claude Code enforces the ladder with per-app tiers.** Browsers and trading apps are view-only, terminals and IDEs are click-only, and everything else gets full control. Codex blocks terminal apps, the agent itself and admin prompts outright. **Juno has no app scoping at all.** Its capture includes Juno's own window (`SCContentFilter(display:excludingWindows: [])`, `ComputerUseCoordinator.swift:361`), and its clicks can land anywhere. With Full access or Always allow on, the agent can click "Allow" on Juno's own approval card, or type into Terminal and so get around the command classifier. This is the most serious finding, because it breaks the owner's rule of deterministic approval.
3. **Scaling screenshots is a correctness issue, not a matter of taste.** Anthropic says the image limits are 1568 px long edge / ~1.15 MP for older models and 2576 px / 4784 visual tokens for Opus 4.7 and later. Clicks go wrong unless the harness downsizes the screenshot itself and maps coordinates back. Claude Code downsizes 3456×2234 to about 1372×887. OpenAI asks for `detail: "original"`. Juno sends point-size JPEGs at `detail: .high` with no scale map (`ComputerUseTools.swift:37`, `ComputerUseCoordinator.swift:363-369`). Large displays and older models will therefore click off target. **This is likely but not measured; §7.2 specifies a calibration test.**
4. **Action vocabularies have converged.** Anthropic's GA `computer_toolset_20260801` has 17 member tools, batch actions and zoom on by default. On Opus 5.5, `computer_20251124` returns a 400 error from 2026-09-22. OpenAI's `computer` tool returns ordered `actions` arrays. Juno has 5 tools: no drag, right-click, triple-click, hover, hold-key, wait, zoom or batch. Its action results come back as text only ("Click completed."), so every step costs an extra screenshot round trip.
5. **Background, per-app computer use is now standard on macOS.** Claude Desktop's `app_*` tools capture one window even when hidden or on another Space. They act through Accessibility element indices and never take the pointer. Full-screen control needs its own consent. Codex runs "in the background while you keep working" and has a locked-Mac mode. Juno takes over the main display and the real pointer.
6. **Preview is where the loop lives.** Claude Code Desktop has `autoVerify` on by default: after edits it "takes screenshots, checks for errors, and confirms changes work before completing its response". It is configured in `.claude/launch.json` and exposes server logs, console, network, an accessibility tree with refs, and viewport presets. Codex adds **Annotation mode** (click or drag, then comment, then Adjust styles) and CDP "Developer mode". Cursor's Design Mode sends xpath, component, computed styles, fiber props and a screenshot. **Juno's `preview_browser` cannot navigate to a URL, press a key, hover, resize, reload, or read network traffic or server logs.** It captures only `console.error`/`warn`, in the page's own world. It has no verify loop, and `VerificationEngine` only knows about tests.
7. **The UI signals control as a fact, and stopping is global.** Claude Code consumes Esc system-wide ("so prompt injection can't use it to dismiss dialogs") and posts start and done notifications. Claude Desktop's full-screen mode shows a "screen glow". Codex covers all displays during locked use. OpenAI dots say "has control" plus Take over. Juno's Stop lives only inside Juno's capsule, which uses a red status dot (`StudioScreenControl.swift:217`) and breaks the no-dots rule. There is no global Esc.
8. **Prompt-injection defence is layered.** The layers are: vendor classifiers on screenshots and page content; keeping the agent's own UI out of its own screenshots; site permission that does not mean trust ("A website permission ... doesn't make the site's content trustworthy"); a confirm step for consequential actions; secret entry the model cannot see; and, at OpenAI, a Guardian reviewer subagent now applied to computer use and the Browser connector (PR merged 2026-09-23). Juno has only a text label ("Page content is untrusted project output") and per-action prompts.
9. **Proof of work is becoming an artifact.** Cursor cloud agents attach "videos, screenshots, and logs" to PRs. Claude in Chrome records GIFs. Antigravity's walkthrough includes recordings. Juno deliberately keeps screenshots in memory only. A deliberately scoped evidence artifact would need an owner decision (§8).
10. **Mac-native verification has new primary hooks.** Xcode's MCP bridge (`xcrun mcpbridge`, Apple doc) exposes build, tests, diagnostics and `RenderPreview` (tool names from a secondary source). ScreenCaptureKit and AX give per-window capture and element trees. Juno already has a simulator pane (`JunoSimulator`, 2,211 lines) with boot, install, launch, screenshot and openURL, but it has **no agent-facing simulator tools and no input injection** (`supportsEmbeddedInput`).

---

## 2. Juno today (baseline)

Paths are under `native/Packages/JunoCode/Sources/` unless noted.

### 2.1 Computer use

- **Tools:** `computer_screenshot`, `computer_click` (optional double), `computer_type`, `computer_press_key`, `computer_scroll` (`JunoCodeCore/ComputerUse.swift:108-118`, `JunoCodeRuntime/Tools/ComputerUseTools.swift`). The action kinds are screenshot, click, doubleClick, typeText, pressKey and scroll (`ComputerUse.swift:120-127`).
- **Gating:** the tools are removed unless the model supports vision and the reader has started Screen Control in the session (`JunoCodeUI/Models/SessionController.swift:788-790`). They are also stripped from sub-agents (`:818`, `:839`, `:887`).
- **Coordinator envelope** (`JunoCodeLocal/ComputerUseCoordinator.swift`):
  - one active session;
  - an activation generation re-checked across every suspension point, which is a strong design;
  - one action in flight, with a 0.5 s minimum interval (`:58`);
  - a bounds check;
  - a before/after capture and a journal;
  - an emergency stop.
- **Capture:**
  - ScreenCaptureKit of the main display only, with nothing excluded (`:361`);
  - captured at logical point size to match CGEvent space (`:363-369`);
  - cursor shown, JPEG quality 0.82.
- **Model input:** only `computer_screenshot` returns an image, at `detail: .high` (`ComputerUseTools.swift:37`). Click, type, key and scroll return one line of text. The coordinator's "after" capture is thrown away (`ComputerUseCoordinator.swift:84-89`). `ModelImage.Detail` has no `original` case (`JunoCodeRuntime/ModelClient.swift:7-11`).
- **Permissions UI** (`JunoCodeUI/Studio/StudioScreenControl.swift`):
  - "Screenshots never ask. Each click, keystroke and scroll asks first, unless the session has Full access or you allowed it for all projects" (`:409`);
  - the capsule shows a red 7 pt dot while active (`:217`), a 45 pt thumbnail of the last capture, and Stop.
- **Stop:** in-app only (`SessionController.stopComputerUse`, `:1860-1864`). The only global key monitor in the app is for quick entry (`macOS/JunoDesktop/App/DesktopQuickEntry.swift:57`).
- **Not present:** app list or per-app grant, tiers, deny list, hiding other apps, excluding own windows, background per-window mode, AX tree, drag, right/triple click, hover, hold, wait, zoom, batch, multi-display, clipboard grant, teach mode, and native provider computer tools.

### 2.2 Preview and browser

- **Tools** (`JunoCodeUI/Views/Preview/CodePreviewInspectionTool.swift`):
  - `open_preview` (`.critical`, because it starts the discovered dev server; `:189`);
  - `inspect_preview` (URL, title, up to 12k visible text, interactive element count, last 20 diagnostics, optional screenshot; `:122`);
  - `preview_browser` with `snapshot | click | type | select | scroll | wait | assert_text`, refs `e1…e999` that expire on navigation, and an optional screenshot (`:232`, `:325`).
- **Surface** (`CodePreviewWindow.swift`, 2,324 lines):
  - WKWebView with a **non-persistent data store** (`:2205`) and `isInspectable = true` (`:2227`);
  - control restricted to loopback (`:854`);
  - the dev server is contained, with "network access disabled" (`:2070`);
  - screenshots are PNG capped at 6 MB (`:1000`).
- **Diagnostics:** an injected page-world script wraps `console.error`/`console.warn` and listens for `error` and `unhandledrejection` (`:351-384`). There is no `log`/`info`, no network capture, and dev-server stdout/stderr (`DevServerService` log) is not given to the model.
- **Discovery:** `package.json` scripts or a static `index.html` (`:107-190`). There is no committed config file and no multi-server setup. The user can type an address, but the agent cannot.
- **Verification:** `JunoCodeRuntime/VerificationEngine.swift` (94 lines) records only test-run evidence. There is no visual or UI evidence type.
- **Simulator:** `JunoSimulator/*` covers boot, install, launch, screenshot, openURL and frame streaming for a pane and relay. `supportsEmbeddedInput` exists but no injection path does. No agent tool drives it (a grep of `JunoCodeRuntime` and `SessionController` finds none).

---

## 3. Primary-source facts by vendor

### 3.1 Anthropic API: computer and browser toolsets

**Release notes** (platform.claude.com):
- **2026-08-19:** "The computer use tool is out of beta ... as the `computer_toolset_20260801` toolset: no beta header, batch actions (several actions in one turn), `zoom` enabled by default, and per-member configuration through `configs`." Anthropic launched the browser use tool (`browser_toolset_20260801`) the same day.
- **2026-08-20:** both toolsets reached Google Cloud.
- **2026-09-22:** "On Claude Opus 5.5 ... the earlier `computer_20251124` tool returns a 400 error".

**`computer_toolset_20260801`** ([computer use tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)):
- **Members (17):** `screenshot`, `zoom` (region `[x0,y0,x1,y1]` at full resolution), `left_click`, `right_click`, `middle_click`, `double_click`, `triple_click` (all take an optional coordinate and modifier `text`), `left_click_drag`, `mouse_move`, `left_mouse_down`, `left_mouse_up`, `cursor_position`, `scroll` (direction, amount, optional coordinate and modifiers), `type`, `key` (with `repeat` 1-100), `hold_key` (up to 300 s) and `wait` (up to 300 s). `allowed_callers` accepts only `["direct"]`.
- **Batch rules:**
  - run the blocks sequentially and stop at the first failure;
  - answer the rest with `is_error` and exactly "Not executed: an earlier computer action in this turn failed.";
  - only `screenshot` and `zoom` return images;
  - "Attach a screenshot as an extra image block on the last result if the batch doesn't end with one to save a round trip."
- **Image limits:** "Claude Opus 4.7 and later models ... accept up to 2576 pixels on the long edge and 4784 visual tokens total (`⌈width / 28⌉ × ⌈height / 28⌉`, approximately 3.75 megapixels); earlier models accept up to 1568 pixels on the long edge and approximately 1.15 megapixels."
- **Retina:** "macOS Retina displays capture screenshots at a device pixel ratio of 2 ... Either downscale the screenshot by 2x before sending, or halve the coordinates Claude returns."
- **Recommended sizes:** 1024×768 or 1280×720 for desktop work; 1280×800 or 1366×768 for web apps. The docs give a scale-factor recipe: `min(1, 1568/long, sqrt(1.15M/pixels))`, then divide the model's coordinates by the scale.
- **Screenshot history:** keep 20 or fewer images per request, or keep both sides at 2000 px or less. "A reasonable default is to keep the last three screenshots and prune every 25 turns, so the prefix stays byte-identical between prune events." On 5.5+ models with thinking, use server-side tool-result clearing instead of client pruning.
- **Safety:** "Classifiers automatically scan tool results (screenshots, etc.) for potential prompt injections" and steer the model to confirm with the user. The docs also recommend a VM with minimal privileges, domain allowlists, and human confirmation for consequential actions.
- **Tips:**
  - verify with a screenshot after each step;
  - prefer keyboard shortcuts for dropdowns and scrollbars;
  - put instruction text **before** the image;
  - zoom for small text;
  - "End each group of actions with a screenshot."
- **Precision note:** "Claude Sonnet 4.6 is more mechanically precise at clicking than Claude Opus 4.6. Claude Opus 4.7 has comparable precision to Sonnet 4.6."

**`browser_toolset_20260801`** ([browser use tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool)). There are 31 members, all run client-side:
- **Navigation and capture:** `navigate` (http/https, or `back`/`forward`/`reload`), `screenshot`, `zoom`.
- **Pointer:** the click family plus `hover`, `left_click_drag`, mouse down/up/move, `scroll`, `scroll_to`.
- **Keyboard and timing:** `type`, `key`, `hold_key` (up to 30 s), `wait` (up to 30 s).
- **Reading:** `read_page` (accessibility tree with `ref_N`, filter `interactive|all`, `depth`, subtree `ref`), `find` (natural language, up to 20 matches), `get_page_text`.
- **Forms:** `form_input`; `file_upload` is **off** by default.
- **Diagnostics:** `read_console`, `read_network` and `javascript_exec` are all **off** by default.
- **Tabs:** `new_tab`, `list_tabs`, `switch_tab`, `close_tab`.

How it targets and reports:
- **Targets** are either `{"type":"ref"}` (valid until navigation or a material DOM change) or `{"type":"coordinate"}` in viewport pixels, for canvas, video and cross-origin frames.
- **Results** may carry a `browser_state` block with the full tab inventory and `state_changes` (tab_opened, download_started, download_completed).

Required security precautions:
- an isolated profile with no credentials;
- a domain allowlist enforced at the network layer and "re-check in `navigate` handler post-redirects; block loopback/link-local/private ranges unless needed";
- accept only http/https and reject `javascript:`, `file:`, `data:`, `chrome:`;
- keep `javascript_exec` and `file_upload` disabled unless needed;
- human confirmation for purchases, account changes, messaging and terms.

### 3.2 Claude Code CLI: computer use ([docs](https://code.claude.com/docs/en/computer-use))

- **Availability:** a built-in MCP server `computer-use`, off by default and enabled per project in `/mcp`. It is a research preview on macOS with Pro/Max plans, and interactive mode only.
- **Ladder:** "If you have an MCP server ... Claude uses that. If the task is a shell command, Claude uses Bash. If the task is browser work and you have Claude in Chrome set up, Claude uses that. If none of those apply, Claude uses computer use."
- **Per-app approval each session:**
  - The prompt shows the apps requested, extra permissions (clipboard), and "How many other apps will be hidden while Claude works".
  - **Sentinel warnings** flag broad-reach apps: "Equivalent to shell access" (terminals and IDEs), "Can read or write any file" (Finder), "Can change system settings" (System Settings).
- **Lock:** one session at a time; the lock is taken at the first action and released when the session exits.
- **Screen handling:**
  - Other apps are hidden while Claude works.
  - "Your terminal window stays visible and is excluded from screenshots, so you can watch the session and Claude never sees its own output."
- **Downscaling:** 3456×2234 downscales to ~1372×887 with the aspect ratio kept, and "There is no setting to change the target size."
- **Stop:**
  - A notification says "Claude is using your computer · press Esc to stop".
  - "the `Esc` key aborts computer use from anywhere, and the key press is consumed so prompt injection can't use it to dismiss dialogs".
  - A second notification appears when Claude is done.

### 3.3 Claude Code Desktop: computer use, Browser pane, iOS Simulator

**Computer use** ([desktop docs](https://code.claude.com/docs/en/desktop#let-claude-use-your-computer)):
- **Platforms:** macOS and Windows. It can run in the background on macOS. The support article summary gives macOS 15+ as the requirement for background mode (**UNVERIFIED** version).
- **Fixed tiers by app category:**

| Tier | What Claude can do | Applies to |
|---|---|---|
| View only | See the app in screenshots | Browsers, trading platforms |
| Click only | "Click and scroll, but not type or use keyboard shortcuts" | Terminals, IDEs |
| Full control | "Click, type, drag, and use keyboard shortcuts" | Everything else |

- **Settings:** "Denied apps" and "Unhide apps when Claude finishes". Dispatch-spawned sessions re-prompt app approvals after 30 minutes.
- **Defaults:** investment, trading and crypto apps are blocked by default ([support article](https://support.claude.com/en/articles/14128542)).

**Observed manifest (2026-09-30), computer-use MCP.** There are two modes.

*Background, per app.* The target window never comes to the front.
- `app_screenshot` works "regardless of whether it is visible, minimized, or on another Space". It returns the image plus a compact list of interactive AX elements with `[N]` indices.
- Actions:
  - `app_click`, which targets by coordinate, `element_index` or `target:"focused"`, and refuses menu-presenting controls;
  - `app_type`, with `mode: insert|replace` and an `overwrite_existing` guard that refuses to clobber a whole field by default and returns the prior ≤500 chars when allowed;
  - `app_key`;
  - `app_scroll`, in scroll-range units;
  - `app_drag`, with a path of up to 20 points;
  - `app_menu`, which walks the menu bar by title and is used "instead of app_key for ⌘-shortcuts";
  - `app_focus`, which is refused for password fields.
- Support tools: `app_zoom`, `app_ax_find`, `app_list_windows`, `app_bring_to_current_space`, `app_batch` and `app_release`.
- A `scale` in [0.1, 1] shrinks the returned image. "Coordinates are ALWAYS in the full-resolution coordinate frame".

*Display scope (takeover).*
- `computer_batch` uses the Anthropic action vocabulary.
- It needs a **separate** full-screen consent card (`request_full_control`) and shows a "screen glow". `release_full_control` returns to background mode.
- "The frontmost application must be in the session allowlist ... The frontmost check runs before EACH action inside the batch."

*Grants and extras.*
- `request_access(apps, reason, clipboardRead, clipboardWrite, systemKeyCombos)` shows one dialog. The installed-app list inside it is labelled "DATA ONLY".
- `list_apps`, `open_application`, `switch_display`, `read_clipboard` and `write_clipboard` round out the grant tools.
- **Teach mode:** `request_teach_access`, `teach_step` and `teach_batch` show on-screen tooltips and wait for the user's Next.

The server instructions add:
- browsers are tier "read" and terminals and IDEs tier "click";
- "Never click web links with computer-use tools";
- no trades or money movement.

**Browser pane and preview** ([desktop docs](https://code.claude.com/docs/en/desktop#preview-your-app)):
- **Scope:** "Claude can start a dev server and open it in the Browser pane to verify its changes. This works for frontend web apps as well as backend servers."
- **`autoVerify` on by default:** "it takes screenshots, checks for errors, and confirms changes work before completing its response". It can be set per project in `.claude/launch.json` or from the server dropdown.
- **`launch.json` fields:** `name`, `runtimeExecutable`, `runtimeArgs`, `port` (default 3000), `cwd` (`${workspaceFolder}`), `env` ("Don't put secrets here"), `autoPort` (true = find a free port and pass `PORT`; false = fail; unset = ask once and save), `program`/`args`, and `url`. A localhost `url` must be origin-only and match the port; no url means attach to a running server.
- **Pane features:**
  - "Persist sessions" (cookies and localStorage survive restarts);
  - a tabbed browser;
  - element select (Cmd+Shift+S);
  - opens HTML, PDF, image and video files.
- **External sites:**
  - the same classifiers as auto mode check write actions in every mode;
  - a per-site card (Allow once, Always allow, Deny);
  - a domain allowlist outside Auto and Bypass modes;
  - "won't purchase items, create accounts, or bypass CAPTCHAs without your input";
  - managed settings `browserExternalPageTools` and `disableBrowserExternalNavigation`.
- **Observed tool vocabulary** (`mcp__Claude_Browser__*`):
  - servers: `preview_start` (from `.claude/launch.json`), `preview_list`, `preview_logs` (server stdout/stderr, `level: error`, `search`), `preview_stop`;
  - navigation and reading: `navigate` (also back/forward), `read_page` (YAML accessibility tree with `ref_N`, `filter: interactive`), `find`, `get_page_text`;
  - input: `computer` (screenshot with `scale`, zoom, clicks by coordinate or ref, `scroll_to`, hover, drag), `form_input`;
  - debugging: `javascript_tool` ("for DEBUGGING and INSPECTION only. Do NOT use this to implement UI changes"), `read_console_messages` (`onlyErrors`, `pattern`), `read_network_requests` (list, or body by `requestId`);
  - viewport: `resize_window` (presets mobile 375×812 with a mobile UA and touch points, tablet 768×1024, desktop, plus `colorScheme` light/dark);
  - tabs and batching: `tabs_*`, `browser_batch` (sequential, stop on first error).

**iOS Simulator pane** ([docs](https://code.claude.com/docs/en/desktop-ios-simulator)):
- It "drives the simulator directly, so it doesn't need computer use and never takes over your screen".
- **Consent:** once per device. Screenshots go to Anthropic under normal retention ("don't sign in to real accounts").
- **Actions that follow the permission mode instead:** opening a URL ("a URL can carry data off the device") and building (`xcodebuild` runs project scripts).
- **Visibility:** a "Claude is using this device" badge. Up to 4 devices per session, each owned by its session. Devices Claude booted are shut down 10 minutes after detach.
- **Observed tools:** `control` with `attach | launch | screenshot | tap | swipe | touch_path | touch2_path | text | button | open_url | detach`, in device points, plus a `build` tool.
- The mechanism for tap injection is not documented (**UNVERIFIED**; the public `simctl` has no tap).

### 3.4 Claude in Chrome ([docs](https://code.claude.com/docs/en/chrome))

- It uses the real browser's logins. Tabs are collected into a session tab group.
- "When Claude encounters a login page or CAPTCHA, it pauses and asks you to handle it manually."
- Capabilities: console and DOM for live debugging, GIF recording ("captures everything visible ... review it before sharing"), `save_to_disk` screenshots, and uploads up to 10 MB that are blocked if `Read` is denied.
- Site permissions come from the extension. JS dialogs block events.

### 3.5 OpenAI: ChatGPT desktop (Codex and Work), API

**Computer Use** ([learn.chatgpt.com/docs/computer-use](https://learn.chatgpt.com/docs/computer-use), undated, fetched 2026-09-30):
- **Setup:** a plugin with an MCP server and a skill. It needs Screen Recording and Accessibility, and runs on macOS and Windows.
- **Invocation:** `@Computer` or `@AppName`. "If the target app exposes a dedicated plugin or MCP server, prefer that structured integration." "For web apps you are building locally, use the built-in browser first."
- **App approval:** "ChatGPT asks for your permission before it can use an app ... You can choose **Always allow**". Always-allowed apps are listed under Settings > Computer use, and admins can restrict apps and saved approvals. "ChatGPT may also ask for permission before taking sensitive or disruptive actions."
- **Hard limits:** "can't automate terminal apps or ChatGPT itself, since automating them could bypass ChatGPT security policies. It also can't authenticate as an administrator or approve security and privacy permission prompts."
- **Locked use (macOS):**
  - It installs an Apple authorization plug-in.
  - "temporarily unlocks the Mac while blocking local use";
  - "covers every display while the desktop is temporarily unlocked";
  - "If ChatGPT detects local keyboard or pointer input, it relocks the Mac".
- **Windows:** foreground only.
- **Retention:** "Your ChatGPT data controls apply to ... screenshots taken by Computer Use."
- **Model:** GPT-6 Astra is recommended "for difficult tasks that depend on screenshots or visual judgment".
- **Secondary reports:**
  - Help Net Security, 2026-04-17: "its own cursor"; "Multiple agents can run in parallel without interfering". The primary openai.com post returned 403, so the wording is **UNVERIFIED** at the primary source.
  - MacRumors, 2026-05-22: the locked-use overlay reads "Codex is Using Your Mac".

**Built-in browser** ([docs/browser](https://learn.chatgpt.com/docs/browser)):
- **Profile:** separate from the user's browser; users sign in inside it.
- **Agent actions:** "open pages, click, type, inspect rendered state, take screenshots, and verify the result of its work in the page".
- **Site permission:** asked per site unless allowed. Confirmation is required "before sensitive actions such as submitting information, making a purchase, changing permissions, or deleting data". The browser "can't automate file uploads". "A website permission ... doesn't make the site's content trustworthy."
- **Preview flow:**
  1. start the dev server in the integrated terminal or with a local action;
  2. open the route;
  3. "Review the rendered state alongside the code diff";
  4. leave comments;
  5. ask for fixes with a narrow scope.
- **Annotation mode:** "Click an element, or drag to select an area", then write a comment. **Adjust** lets the user change font, text, spacing and color, preview the change on the page, and send it. The **Browser Annotation API** lets a site define selection targets, text ranges, metadata and suggested comments ([annotations-extensibility](https://learn.chatgpt.com/docs/annotations-extensibility)).
- **Developer mode:** "controlled access to the Chrome DevTools Protocol (CDP)" for console, network, DOM and styles, and performance traces. "ChatGPT asks for explicit approval before it uses full CDP to inspect a website." Admins can set `browser_use_full_cdp_access = false`.
- **Site tools (WebMCP):** pages can expose tools, and "The browser checks each request before the website carries it out" ([webmcp](https://learn.chatgpt.com/docs/webmcp)).
- **Enterprise boundary:** "Computer Use operating a browser ... **Browser Use's site and capability policies do not apply to this path**" ([local security](https://learn.chatgpt.com/docs/enterprise/chatgpt-work-local-security)). This is the reason to cap browsers at view-only under computer use. The feature flags are `features.computer_use`, `in_app_browser`, `browser_use` and `browser_use_external`.
- **Cloud browser (Work):**
  - a secure sign-in form, so the model never sees credentials;
  - "an additional review model checks the sign-in request ... for signs of phishing";
  - site access set to Always ask, Auto approve or Always allow (the last "not recommend[ed]");
  - takeover available.

**Guardian auto-review:**
- [openai/codex#47647](https://github.com/openai/codex/pull/47647), merged 2026-09-23, "Apply Guardian computer-use review to the Browser connector". It classifies the Browser connector under computer-use scope, forwards confirmation policy, captures review evidence and tracks JavaScript execution.
- Guardian is an LLM reviewer subagent that escalates only risky calls (secondary: codex.danielvaughan.com, 2026-04-20).
- "Guardian v2 defaults to computer-use reviews with images" comes from a search summary only (**UNVERIFIED**).

**API** ([computer use guide](https://developers.openai.com/api/docs/guides/tools-computer-use), undated):
- **Three integration paths:** the `computer` tool (structured actions), code execution (the model writes PyAutoGUI or Playwright code; "For GPT-6 Astra, we recommend code execution"), or your own function or MCP tools.
- **`computer_call`:** an ordered `actions` array of `click` (with button), `double_click`, `drag` (path), `move`, `scroll` (`scroll_x`/`scroll_y`), `type`, `keypress`, `wait` and `screenshot`.
- **Images:** "use `detail: "original"` to preserve resolution"; "If you downscale a screenshot, map the model's coordinates back"; the reference context viewport is 1440×900.
- **Safety:** "Treat screen content as untrusted", "Confirm consequential actions", "Stop and escalate when the model sees prompt injection".

### 3.6 Cursor

- **Browser tool** ([docs](https://cursor.com/docs/agent/tools/browser), undated; the page still recommends "Sonnet 4.5, GPT-5", so it may be stale):
  - a pane in the editor driven through MCP;
  - navigate, click, double, right, hover, type, scroll, screenshot, console, network;
  - approvals: Manual (recommended), Allow-listed, or Auto-run; enterprise origin allowlists;
  - cookies and storage persist, "isolated per workspace".
- **Design Mode** ([docs](https://cursor.com/docs/agent/design-mode)): "click an element, draw on the page, or describe a change by voice", and multi-select. The agent receives "the xpath, the component, attributes, computed styles, and props from the fiber tree" plus "A screenshot: the layout, surrounding elements, and the exact page state". Shortcuts are Cmd+Shift+D (toggle), Shift+drag (area) and Cmd+L (add to chat).
- **Cloud agents with computer use** ([blog](https://cursor.com/blog/agent-computer-use), 2026-02-24):
  - each agent has an isolated VM;
  - "iterate until they've validated their output";
  - they "produce artifacts (videos, screenshots, and logs)";
  - "You can also control the agent's remote desktop";
  - "More than 30% of the PRs we merge at Cursor are now created by agents operating autonomously in cloud sandboxes."

### 3.7 Others

- **Google Antigravity** (prior Juno research, `docs/native/code-rework/research/antigravity.md`, 2026-09-22):
  - a separate browser subagent model drives a Chrome profile with click, scroll, type, console, DOM, screenshot and markdown capture, and video;
  - it has a side view that streams steps with per-click screenshots ("red dot marking the click") and "Playback available";
  - in 2.x the browser is used only via `/browser`, because "agents were still not capable enough to determine exactly when to be using the browser".
- **Playwright MCP** ([README](https://github.com/microsoft/playwright-mcp)) uses the accessibility tree, not pixels: "Fast and lightweight", "LLM-friendly", "Deterministic tool application". Its tools include `browser_snapshot`, ref-based `browser_click`, `browser_take_screenshot`, `browser_console_messages`, `browser_network_requests`, `browser_evaluate` and `browser_resize`. Coordinate tools are opt-in (`--caps=vision`).
- **Xcode MCP bridge** ([Apple](https://developer.apple.com/documentation/xcode/giving-external-agents-access-to-xcode)):
  - "Allow external agents to use Xcode tools", then `xcrun mcpbridge`;
  - "Xcode alerts you when the external agent connects to Xcode and when it's active";
  - tool names (secondary, rudrank.com, 2026-02-04): `BuildProject`, `GetBuildLog`, `RunAllTests`, `RunSomeTests`, `XcodeListNavigatorIssues`, `XcodeRefreshCodeIssuesInFile`, `ExecuteSnippet`, `RenderPreview` ("Generate SwiftUI preview images"), `DocumentationSearch` and file tools.
- **Apple APIs for a Mac implementation** (Apple doc JSON, availability read 2026-09-30):
  - `SCContentFilter(desktopIndependentWindow:)`, "captures only the specified window" (macOS 12.3);
  - `SCContentFilter(display:excludingApplications:exceptingWindows:)` (12.3);
  - `SCScreenshotManager` (14.0);
  - `CGEvent.postToPid(_:)` (10.11);
  - `AXUIElementCreateApplication` (10.2);
  - `WKWebsiteDataStore(forIdentifier:)` (14.0), for a persistent per-workspace profile;
  - `WKWebView.isInspectable` (13.3);
  - `WKContentWorld` (11.0), an isolated script world;
  - `WKWebView.takeSnapshot` (10.13).

---

## 4. What the field agrees on

### 4.1 Action vocabulary

| Capability | Anthropic toolset | OpenAI `computer` | Claude Desktop background | Juno today |
|---|---|---|---|---|
| Screenshot | yes | yes | per window, with AX list | display only |
| Zoom region at native px | yes (default on) | no (use `original`) | `app_zoom` | no |
| Left/double click | yes | yes | coordinate, element index or focused | yes |
| Right, middle, triple click | yes | button param | right | no |
| Drag / path | drag, mouse down/up | drag path | path of 2-20 points | no |
| Hover / move | `mouse_move` | `move` | (display scope) | no |
| Type | yes | yes | insert or replace, overwrite guard | yes |
| Key chord, repeat | yes, repeat 1-100 | `keypress` | `app_key`, `app_menu` for ⌘ | single key |
| Hold key | up to 300 s | no | no | no |
| Wait | up to 300 s | yes | no | no |
| Scroll with direction | yes | x/y | range units | y only |
| Batch in one turn | yes, stop on first failure | actions array | `app_batch` | no |
| Screenshot after action | recommended | returned per call | inside the batch | dropped |

### 4.2 Coordinates and scaling

1. Capture at device pixels, then downsize **in the harness** to within the model's limits. Fix one coordinate frame and state it in every result: the frame, its size and the scale. Map the model's coordinates back before injecting input.
2. Never let the provider resize silently. Choose the target size per model family: 1568 px / 1.15 MP for older Claude models, 2576 px / 4784 tokens for Opus 4.7+ and 5.x, and `detail: "original"` for OpenAI.
3. Give the model a `zoom` at native density for small text. The zoom is a reading aid only, and coordinates still refer to the base screenshot, as the observed manifest states.
4. Reduce images: default to window capture rather than the whole display; add a `scale` parameter; keep the last N screenshots, prune in batches to keep the cache prefix stable, or use server-side clearing on 5.5+.

### 4.3 App scoping and permission tiers

- Grant **per app, per session**, with one dialog for a set of apps and separate checkboxes for clipboard and system keys.
- Use **fixed tiers by category**: browsers view-only (web work goes through the browser tool, where site policy applies), terminals and IDEs click-only (shell goes through Bash, where the command policy applies), and full control for everything else.
- Show **sentinel warnings** for Finder, System Settings and terminals.
- Keep a **deny list** and default-deny finance and crypto apps.
- **Hard blocks:** the agent itself, admin and TCC prompts, and terminal typing.
- Run a **frontmost-app gate before every action**, including inside batches.
- Treat **background** (per window, no pointer) and **takeover** (whole display) as separate consents.

### 4.4 Showing control, stop and takeover

- Tell the user at the start and at the end (Claude Code notifications).
- Make control a stated fact: Codex covers displays in locked use, Claude Desktop shows a screen glow in takeover mode, and dots say "has control" next to Take over.
- Provide a **global** stop key that the system consumes.
- Hide other apps during takeover and restore them afterwards.
- Stream a step view with per-action screenshots and the click point (Antigravity), and allow playback or recording as proof.
- Simulator and browser panes show the live surface with an "is using this device" signal. Juno's owner rules forbid badges and pills, so §7 uses glow and an edge treatment instead.

### 4.5 Prompt-injection defences for screen content

1. Keep the agent's own UI (transcript and approval cards) **out of its screenshots**, and make it **unclickable** by the agent.
2. Label all screen, page and AX text as data. Pass installed-app names and menu titles as "DATA ONLY" (as the observed manifest does).
3. Run vendor classifiers on tool results. Anthropic does this for its toolsets. **Whether it runs on custom function-tool images is undocumented (UNVERIFIED)**, which is a reason to prefer the native toolset.
4. Treat a site or app permission as access, not trust. Confirm consequential actions (submit, purchase, delete, change permissions, send).
5. Keep secrets away from the model: use a secure sign-in form or have the user do the step. Pause at CAPTCHA and login pages.
6. A reviewer model (Guardian) can reduce prompts on low-risk calls. Under Juno's rules it may only **add** friction; it must never replace a deterministic grant.
7. Make the global Esc consumed, so an injected dialog cannot capture it.

### 4.6 The visual verification loop

- **Web:** start or attach the server, then navigate to the affected route. Collect status, console errors, failed requests, the accessibility tree and a screenshot at more than one viewport. Judge against the acceptance criteria, fix, and repeat until satisfied or out of budget. Claude Code's `autoVerify` runs this by default after edits. Codex relies on the user's annotations and "describe how to verify the finished result". Cursor iterates in a VM and attaches artifacts.
- **Native:** build, launch, then run app-scoped computer use (AX first) plus screenshots and the same judgement. Claude Code's CLI example: "Build the MenuBarStats target, launch it, open the preferences window, and verify the interval slider updates the label."
- **Human-in-the-loop input:** element pick or annotation becomes structured context (selector or xpath, component, computed styles, props, crop).

### 4.7 Console, network and server logs

Everyone exposes console reads with level and pattern filters, and network lists with bodies on demand. Claude Desktop also exposes **dev-server stdout/stderr** (`preview_logs`). Raw JS evaluation and full CDP access are gated: Anthropic keeps them off by default, Codex asks for explicit per-site approval, and Claude's tool is labelled "debug only".

### 4.8 Accessibility tree or pixels

Use the accessibility tree or DOM refs first, because they are deterministic, cheap and survive layout shifts. Use pixels for canvas, video, cross-origin frames and visual judgement, where a screenshot and zoom are needed. Claude Desktop's `app_screenshot` returns both the image and the AX list in one call, which is the pattern to copy for native apps.

---

## 5. Gap analysis: Juno against the field

Severity: **S1** breaks a safety rule or produces wrong actions; **S2** blocks an autonomous loop; **S3** is parity or polish.

| # | Gap | Evidence | Sev |
|---|---|---|---|
| C1 | No app scoping. Juno's own windows are captured and clickable, so the agent can approve its own prompts. Terminal typing gets around the command policy under Full access or Always allow. | `ComputerUseCoordinator.swift:361` (`excludingWindows: []`); no bundle checks anywhere; `StudioScreenControl.swift:409` | **S1** |
| C2 | Coordinate scaling is unmanaged: point-size capture, no scale map, `.high` detail, no `original` case. A 16" default (1728×1117) exceeds the older-Claude limits, and a Pro Display XDR (3008 wide) exceeds even 2576. | `:363-369`; `ComputerUseTools.swift:37`; `ModelClient.swift:7-11` | **S1** (likely; measure it, §7.2) |
| C3 | "Screenshots never ask" captures every visible app (Mail, Messages), with no hiding and no per-window capture. | `:361`, `:409` | S1 (privacy) |
| C4 | Approval is per action with no per-app grant, so loops either stall on prompts or run with blanket Full access. | `:409`, tool risk `.critical` | S2 |
| C5 | Thin vocabulary, no batch, and action results carry no image. | `ComputerUseTools.swift:76`, `:111` | S2 |
| C6 | No global Esc. Stop is only inside Juno's window, which may be hidden behind the app being driven. The red dot breaks the no-dots rule. | `StudioScreenControl.swift:217`; only a quick-entry global monitor | S1 (stop) / S3 (dot) |
| C7 | Takeover only: the agent moves the real pointer, uses the main display only, and has no background mode. | driver `perform` uses CGEvent at the global location | S2 |
| C8 | No AX tree for native apps, so the agent is pixel-only. | none | S2 |
| C9 | Native provider computer tools are unused: no `computer_toolset_20260801`, no OpenAI `computer`. Custom tools may miss vendor injection classifiers (UNVERIFIED). | `grep computer_20\|toolset` finds nothing | S3 |
| P1 | `preview_browser` has no `navigate` (routes), `key`, `hover`, back/forward/reload, drag or `scroll_to`. | `CodePreviewInspectionTool.swift:232-240` | **S2** |
| P2 | No viewport or device presets and no color scheme, so mobile and dark mode cannot be verified. | none in tool schema | S2 |
| P3 | Console capture is only error/warn/runtime, in the page world where the page can overwrite it. No `log`/`info`, no network, no server logs given to the model, last 20 only. | `CodePreviewWindow.swift:351-384`, `:1188` | S2 |
| P4 | No committed launch config: no multi-server, `url` attach, `autoPort` or env. The agent cannot point the preview at a running server. | `:107-190` | S2 |
| P5 | No auto-verify, and `VerificationEngine` has no UI or visual evidence, so "done" never requires having looked. | `VerificationEngine.swift` | **S2** |
| P6 | No annotation or element pick into chat, and no Adjust. | none | S3 |
| P7 | The non-persistent data store loses sign-in on every open. | `:2205` | S3 |
| P8 | No native verify path: the simulator has no agent tools and no input, and there is no Xcode MCP bridge, `RenderPreview` or AX-driven app checks. | `JunoSimulator/SimulatorCapability.swift:35,46`; no runtime tools | S2 |
| P9 | Screenshots are full-size PNG (up to 6 MB) with no `scale` or zoom, which costs tokens and trips provider resizing. | `:1000` | S3 |
| P10 | No proof-of-work artifact (a video, GIF or step strip) in the transcript or PR. | memory-only by design | owner decision |

Related and already recorded elsewhere, so not re-specified here: rewriting image messages to text after every turn breaks the cache and thinking in vision and computer-use sessions (`code-runtime-swift.md` §3.5c, `AgentOrchestrator.swift:977`). The loop work in progress should close it. Computer use makes it much worse, because every step adds an image.

---

## 6. Design constraints from owner rules

- **Deterministic approval.**
  - Grants (app, tier, site, device, takeover) are deterministic cards that the user answers.
  - A reviewer model, if one is ever added, can only escalate.
  - Consequential in-app actions must be caught by rules, not by model judgement alone. Examples: a click on a control whose AX title matches send/submit/delete/buy/pay/confirm, typing into secure fields, and anything in a default-sensitive app.
- **No status pills or decorative dots.**
  - Control is shown by a **screen-edge glow** in native Liquid Glass (consistent with the shipped "glow = state" rule), an agent cursor ghost, and plain sentences ("Juno is using Xcode. Press Esc to stop.").
  - Do not use a red dot or a "Live" chip.
- **Native Liquid Glass** for the grant cards, the step strip and the annotation toolbar.
- **Nothing consequential without approval:** building (runs project scripts), starting a dev server, opening a URL on a device, and full-screen takeover all follow the permission mode or their own card, as Claude Code's simulator pane does.

---

## 7. What to build (on top of the in-progress loop and tools work)

### 7.1 Routing ladder (system prompt and tool descriptions)

Order: Xcode MCP / shell / MCP tools, then Preview browser (web), then Simulator tools (iOS), then app-scoped computer use (native Mac apps), then display takeover (last resort, separate consent). Put the ladder in the tool descriptions, as Claude Code and Codex do, and enforce it with tiers (§7.2) so the model cannot drift down it.

### 7.2 Computer use v2

1. **Grants**
   - `request_apps(apps[], reason, clipboard_read?, clipboard_write?, system_keys?)` opens one Liquid Glass card listing the bundle IDs, their tiers and sentinel warnings.
   - Grants last for the session, with optional per-app Always allow (owner decides, §8).
   - A deny list in Settings, default-deny for finance and crypto categories, and a hard block on Juno itself, `loginwindow`, SecurityAgent and admin or TCC prompts.
   - Tiers: browsers **view**, terminals and IDEs (Terminal, iTerm, Warp, VS Code, Xcode editor) **click**, everything else **full**.
   - A frontmost or target-app gate re-checked before every action.
2. **Capture**
   - Background mode: `SCContentFilter(desktopIndependentWindow:)` per window, plus an AX summary (`[N] role title frame`) built with `AXUIElementCreateApplication`.
   - Takeover mode: `SCContentFilter(display:excludingApplications:[Juno] …)`, plus multi-display `switch_display`.
   - Harness-side downscaling per model family (§4.2) with a stated frame and scale, `zoom` at native pixels, and a `scale` parameter.
   - Add `.original` to `ModelImage.Detail` for OpenAI.
   - Do not rely on `NSWindow.sharingType = .none` to hide Juno's windows; its behaviour under ScreenCaptureKit on macOS 15+ is **UNVERIFIED**. Exclude explicitly.
3. **Input**
   - AX first: press action by `element_index`, set the value or selected text for typing, with an overwrite guard.
   - `CGEvent.postToPid` for keys in background mode, and `app_menu` for ⌘ shortcuts.
   - Global CGEvent only in takeover.
4. **Vocabulary and wire**
   - Use the Anthropic member set as Juno's canonical actions (§4.1), plus `batch` (sequential, stop on first failure, and a screenshot attached to the last result if none was taken).
   - Provider adapters: `computer_toolset_20260801` for Claude 4.8/5.x (the only native option on Opus 5.5); OpenAI `computer` with `detail: original`; function tools as the fallback.
5. **Stop and show**
   - A global Esc through a listen-and-consume `CGEventTap`, which requires the Accessibility grant that computer use already has.
   - Start and done notifications, and a screen-edge glow while in takeover.
   - In background mode, a glass outline on the target window only. **UNVERIFIED feasibility:** overlaying another app's window needs a click-through overlay window tracking the target's frame.
   - Hide other apps in takeover and restore them at turn end. The lock is released at turn end, and the grant ends when the session ends.
6. **Journal to UI**
   - Each action becomes a step row with the before and after thumbnails the coordinator already takes, and the click point drawn in.
   - Thumbnails stay in memory as today unless the owner opts into artifacts (§8).
7. **Calibration test for C2**
   - An offscreen snapshot test renders a grid window at 1512×982, 1728×1117 and 3008×1692 point sizes.
   - Run the scaling pipeline, feed synthetic model coordinates, and assert the injected CGEvent points land within 2 pt.
   - Add a live check: a hidden fixture app with numbered targets that the agent must click.

### 7.3 Preview v2

1. **Config**
   - `.juno/launch.json` using Claude's field set: `name`, `runtimeExecutable`, `runtimeArgs`, `port`, `cwd`, `env`, `autoPort`, `program`, `args`, `url`, and top-level `autoVerify`.
   - Also read `.claude/launch.json` if present, for interoperability.
   - Discovery writes the first version for the user to review.
   - Starting a server follows the permission mode, as today (`open_preview` is `.critical`).
2. **Tools**
   - Servers: `preview_start`, `preview_stop`, `preview_list`, and `preview_logs(level, search, since)` from `DevServerService`.
   - Browser: `navigate` (same origin as the preview, or a configured loopback URL; back, forward, reload), `snapshot` (a11y refs), `find`, click, double, right, hover or drag by ref or coordinate, `type`, `key`, `select`, `scroll` and `scroll_to`, and `wait_for(text|selector|network_idle, timeout)`.
   - Capture: `screenshot(scale, full_page)` and `zoom`.
   - Viewport: `resize(preset: mobile|tablet|desktop|WxH, color_scheme)`.
   - Diagnostics: `console(level, pattern, since)`, `network(filter: failed|all, id→body)`, and `eval` (debug-only, approval-gated).
   - `batch`.
   - Keep the loopback restriction and the "untrusted project output" label.
3. **Instrumentation**
   - Run snapshot and ref resolution in an isolated `WKContentWorld`, so the page cannot spoof it.
   - Console, fetch and XHR hooks have to live in the page world. Mark them untrusted, and cross-check with `PerformanceObserver` resource entries.
   - Keep a ring buffer of 500 entries, not 20.
4. **Persistence:** optional "Keep sign-in" using `WKWebsiteDataStore(forIdentifier:)` per workspace, off by default, with a clear-data control.
5. **Annotation**
   - An annotate toolbar in Liquid Glass: click an element or drag an area, write a comment, and send it as a chat attachment.
   - The attachment carries the selector, a11y role and name, bounding box, computed styles, a source hint (React `_debugSource`/fiber or data attributes when present), and a cropped screenshot.
   - Add "Adjust" (font, spacing, color) later.

### 7.4 The verify loop: making Juno "look at what it built"

1. **Trigger.** An edit batch touches files that an active preview or native target depends on, or the goal has UI acceptance criteria, or the user asks. Controlled by `autoVerify` (default on for web, as Claude Code does it).
2. **Collect evidence.**
   - **Web:** reload and settle (network idle or a timeout), then navigate to the affected routes (the agent picks them from the diff). Record: HTTP status; new console errors and unhandled rejections compared with a pre-edit baseline; failed requests; the a11y snapshot; screenshots at desktop and mobile, plus dark mode if the diff touches color tokens.
   - **Native Mac:** build through Xcode MCP or `xcodebuild` (permission mode applies), then launch, then take an app-scoped AX snapshot and screenshot.
   - **SwiftUI:** `RenderPreview` via `xcrun mcpbridge` when Xcode is open (tool name from a secondary source).
   - **iOS:** add agent tools on `JunoSimulator` for launch, screenshot and openURL. Tap and swipe need an injection path, which is **UNVERIFIED**: the public `simctl` has no tap, so the options are a private SimulatorKit HID path, idb, or AX-driven Simulator.app under computer use.
3. **Judge.** Compare against the goal's acceptance criteria and the user's annotations, and state the verdict in words.
4. **Loop.** Fix and repeat. Bounds: at most 3 verify rounds per turn by default; stop early when there is no progress (the same failure signature twice) or when a consequential action would be needed.
5. **Evidence.** Add `VerificationEvidence.kind = .ui(url|bundle, viewport, checks[], screenshotHash)` to `VerificationEngine`. A goal with UI criteria cannot be reported done without it. Show each round as step rows with thumbnails.

### 7.5 Sequencing

1. **S1 fixes first, before any autonomy is widened:** C1 (exclude and block Juno, block terminal typing), C6 (global Esc, and remove the dot), C2 (scaling pipeline with the calibration test) and C3 (per-window capture).
2. **Preview tools:** P1 to P4, then the verify loop (P5) with UI evidence.
3. **Computer use v2:** grants and tiers, the background AX mode and the batch vocabulary, with native provider adapters.
4. **Native verification:** Xcode bridge, simulator agent tools, and annotation (P6).

---

## 8. Owner decisions needed

1. **Always allow per app for computer use** (Codex offers it; Claude Code keeps session-only). Recommendation: session-only at first.
2. **Proof-of-work artifacts.** Keep screenshots memory-only (today), or save a redacted step strip or short recording to the session or PR as Cursor and Antigravity do? This affects privacy copy and sync.
3. **External sites in the Preview browser.** Keep it loopback-only (today), or allow external sites with per-site Allow once / Always / Deny, following Claude Desktop's model?
4. **A reviewer model (Guardian-style)** that can only add confirmations, or none.
5. **iOS tap injection method** (private SimulatorKit, idb, or computer use on Simulator.app). Each carries maintenance and signing risk.
6. **Locked-Mac operation** (Codex ships it through an authorization plug-in). Recommendation: out of scope; it requires installing a system auth plug-in.

---

## 9. Sources (fetched 2026-09-30 unless dated otherwise)

Primary:
1. Anthropic, Computer use tool. https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool (undated)
2. Anthropic, Browser use tool. https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool (undated)
3. Anthropic, Platform release notes, entries 2026-08-19, 2026-08-20, 2026-09-22. https://platform.claude.com/docs/en/release-notes/overview
4. Claude Code, Computer use from the CLI. https://code.claude.com/docs/en/computer-use (undated)
5. Claude Code, Desktop application (computer use, Browser pane, launch.json, autoVerify, managed settings). https://code.claude.com/docs/en/desktop (undated)
6. Claude Code, Test iOS apps in the simulator. https://code.claude.com/docs/en/desktop-ios-simulator (undated)
7. Claude Code, Use Claude Code with Chrome. https://code.claude.com/docs/en/chrome (undated)
8. Claude Help Center, Let Claude use your computer in Cowork (safety). https://support.claude.com/en/articles/14128542 (undated)
9. Observed manifest: Claude Code desktop tool schemas in this session (`mcp__computer-use__*`, `mcp__Claude_Browser__*`, `mcp__Claude_Code_iOS_Simulator__*`, `mcp__claude-in-chrome__*`), 2026-09-30
10. OpenAI, Computer Use. https://learn.chatgpt.com/docs/computer-use (undated; `.md` fetched)
11. OpenAI, Browser. https://learn.chatgpt.com/docs/browser (undated; `.md` fetched)
12. OpenAI, Annotations Extensibility. https://learn.chatgpt.com/docs/annotations-extensibility (undated)
13. OpenAI, Site tools (WebMCP). https://learn.chatgpt.com/docs/webmcp (undated)
14. OpenAI, ChatGPT Work local security. https://learn.chatgpt.com/docs/enterprise/chatgpt-work-local-security (undated)
15. OpenAI API, Computer use guide. https://developers.openai.com/api/docs/guides/tools-computer-use (undated)
16. openai/codex PR #47647, "Apply Guardian computer-use review to the Browser connector", merged 2026-09-23. https://github.com/openai/codex/pull/47647
17. Cursor, Browser tool. https://cursor.com/docs/agent/tools/browser (undated; possibly stale)
18. Cursor, Design Mode. https://cursor.com/docs/agent/design-mode (undated)
19. Cursor, "Cursor agents can now control their own computers", 2026-02-24. https://cursor.com/blog/agent-computer-use
20. Microsoft, Playwright MCP README. https://github.com/microsoft/playwright-mcp
21. Apple, Giving external agents access to Xcode. https://developer.apple.com/documentation/xcode/giving-external-agents-access-to-xcode
22. Apple API reference (availability from `developer.apple.com/tutorials/data/documentation/...json`): SCContentFilter init(desktopIndependentWindow:), init(display:excludingApplications:exceptingWindows:), SCScreenshotManager, CGEvent.postToPid(_:), AXUIElementCreateApplication, WKWebsiteDataStore init(forIdentifier:), WKWebView.isInspectable, WKContentWorld, WKWebView.takeSnapshot

Secondary (labelled wherever used):

23. Help Net Security, "Codex can now operate between apps", 2026-04-17. https://www.helpnetsecurity.com/2026/04/17/openai-codex-desktop-update-macos/
24. MacRumors, "OpenAI's Codex Can Now Use Your Mac Even When It's Locked", 2026-05-22. https://www.macrumors.com/2026/05/22/codex-use-mac-apps-when-locked/
25. D. Vaughan, "Codex CLI Guardian Approval", 2026-04-20. https://codex.danielvaughan.com/2026/04/20/codex-cli-guardian-approval-configuring-auto-review-policies/
26. R. Ricky, "Exploring Xcode 26.3 MCP tools", 2026-02-04. https://rudrank.com/exploring-xcode-using-mcp-tools-cursor-external-clients
27. Prior Juno research: `docs/native/code-rework/research/antigravity.md` (2026-09-22); `docs/rework/research/openai.md`; `docs/rework/research/anthropic.md`; `docs/rework/audit/code-runtime-swift.md`

**UNVERIFIED items:**
- Codex's "own cursor" and parallel-agent wording (the primary post returned 403);
- Guardian v2 image reviews on by default;
- the macOS 15+ requirement for Claude background mode;
- how Claude Desktop injects simulator taps;
- whether Anthropic's classifiers cover custom function-tool images;
- `NSWindow.sharingType` under ScreenCaptureKit on macOS 15+;
- Xcode MCP tool names (secondary source);
- the freshness of Cursor's Browser page;
- the measured size of Juno's click error (C2) until the calibration test runs.
