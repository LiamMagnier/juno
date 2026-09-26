# Agents v2 — implementation brief

**For:** Gemini 3.8 Flash, working alone from start to finish.
**From:** the mentor (Claude), who ran the audit and read the code.
**Owner's request, in their words:**
> "I want a real agent working on its own VM or something, that can take actions like
> Grok Bot and Muse. I don't want it to be an AI experiment or slop; I want a real
> working product, not only a design interface. More customization, better UI/UX,
> everything more condensed, and configuration should be done in the chat directly,
> like Muse: you talk to the AI so it configures itself. When everything is done, push
> it all to main and tell me when I can deploy using my Mac with
> deploy/deploy-from-mac.sh."

Read, in this order: `RULES.md` (binding), `AUDIT.md` (why), then this file. Keep
`PROGRESS.md` up to date as you go. It is how the owner, or a later session, resumes
your work.

Line numbers below come from `design/premium-pass` @ f5b1de46 and will have drifted.
**Find code by symbol name** (`git grep -n "function buildTools"`), not by line.

---

## 0. Definition of done

The owner can open an agent in Juno on the web and:

1. **Hire it by talking.** Press "New agent", say what they need, and the agent sets
   itself up: name, role, brief, face, first goal. Anything that widens what it may do is
   proposed on a card the owner presses.
2. **Change anything by talking.** "Call yourself Nova", "be more direct", "make yourself
   violet with a leaf", "remember I'm vegetarian", "check prices every morning at 8",
   "you can use my Gmail", "get your own computer". Each change appears in the chat as
   a card, with **Undo** where it applies directly.
3. **Watch it work on its own computer.** In the side panel, a real Linux desktop (XFCE)
   with Chromium, **running on the owner's own server**, where the agent browses, clicks,
   types, runs commands and keeps files. Logins persist between tasks. The computer
   rests or sleeps when idle and wakes when needed.
4. **Take over** for a login, 2FA or CAPTCHA, then hand back. The agent never sees the
   secret.
5. **See what happened.** The agent's next reply knows what its last tasks produced.
6. Find everything on one condensed screen: **the agent's thread + a side panel (Now ·
   Computer · Setup)**.

Also:
- Everything is off, and invisible, until the owner runs the one-time server setup
  (`deploy/agent-computers/setup-vm.sh`) and sets `COMPUTER_PROVIDER=docker` on the VM.
- Shipped Mac and iPhone apps keep working.
- Every gate is green.
- The work is merged and pushed to `main`, and the owner is told exactly how to deploy.

---

## 1. Phase 0 — preconditions (do these first; STOP if one fails)

1. `cd /Users/liammagnier/Developer/project/juno-agents`, `git status` (it should be
   clean on `agents/v2`), then `git fetch origin`.
2. **The premium pass must already be on main.** Run
   `git merge-base --is-ancestor design/premium-pass origin/main && echo merged`.
   - If it does not print `merged`, **STOP**. Write in `PROGRESS.md`: "Blocked: the premium
     pass (branch design/premium-pass) is not merged into main yet; Agents v2 builds on
     its UI." Tell the owner, and do nothing else.
   - If the local branch `design/premium-pass` no longer exists, check
     `git log origin/main --oneline | grep -i "premium"` instead.
3. `git merge origin/main` into `agents/v2`. This brings the premium pass and this brief
   together.
4. Do the one-time setup from RULES §8, then run the **full gate set** and record the
   baseline in `PROGRESS.md`.
5. Check that Docker Desktop is running on this Mac: `docker info >/dev/null 2>&1 && echo up`.
   You need it for the local computer smoke test (Phase 2) and for the final deploy gate.
   - If it is not running, **do not start it yourself**. Write "Docker Desktop is not
     running" in `PROGRESS.md` and tell the owner.
   - Carry on with the work that doesn't need Docker. Check again before Phase 2.
6. Read `INFRA.md` (the container, firewall, relay and docker-driving design) as part of
   the required reading.
7. Read, at least:
   - `docs/design/AGENTS.md`;
   - `docs/JUNO.md` §9b and §9c;
   - `src/lib/agents/*`;
   - `src/components/agents/*`;
   - `scripts/work-runner.ts` (`buildTools`, `execute`, `tick`);
   - `runner/agent-core/src/work/{tools,session,types}.ts`;
   - `src/lib/work/browser.ts`;
   - `src/lib/chat/task-tool.ts` and `handoff-tool.ts`;
   - the tool block of `src/app/api/chat/route.ts` (search `nativeTools`);
   - `src/components/chat/approval-card.tsx`.

---

## 2. Decisions — fixed; do not relitigate

| # | Decision |
|---|---|
| D1 | **One persistent computer per agent, on the owner's own server.** It is a Docker container with a full Linux desktop (Xvfb + XFCE), headful Chromium, a shell and a per-agent volume at `/home/agent`. The design is in `INFRA.md`. **No third-party sandbox vendor.** A computer is never shared between agents or users. It is created lazily and has two idle tiers: **resting** (`docker pause`: RAM kept, instant resume) and **asleep** (`docker stop`: RAM freed; the disk keeps logins and files). It wakes on demand. It is destroyed on reset, retire, disable, account deletion, or after `COMPUTER_RETENTION_DAYS` asleep. The owner is upgrading the server, so **size for a real server**; do not cut capabilities to fit today's small one. This deliberately reverses AGENTS.md's "clean computer every run" at the owner's request. Update the docs (Phase 8). |
| D2 | **No second runtime.** Agent work still runs as Work runs in `juno-work` (`scripts/work-runner.ts`). The computer is a set of tools that run's `buildTools` attaches when the run's session has an `agentId` whose computer is enabled. Plain Work runs with no agent stay exactly as they are. |
| D3 | **The existing `browser` tool drives the agent's own Chrome** over CDP when a computer is attached: same tool name, same risk ladder, same purchase floor, but real, persistent, visible, with images loaded. No request interception: egress leaves from the container's own firewalled network (`INFRA.md`, `firewall.sh`), never from the app process. Pixel tools (`computer_*`), shell and files are added beside it. |
| D4 | **Configuration by chat** is five native chat tools: `create_agent`, `update_agent`, `agent_goal`, `agent_routine`, `agent_memory`. Direct changes apply at once, with an Undo card. Widening changes go through the existing chat approval broker (`authorizeExternalAction`, connector id `juno_agents`) as a card. Forms remain as a secondary path. |
| D5 | **The thread is the agent's home.** `/agents/[id]` becomes a redirect to the thread with the side panel open. The side panel has three tabs: **Now · Computer · Setup**. The roster becomes a compact list. Hiring is a conversation; the old form lives at `/agents/new?form=1`. |
| D6 | **Screenshots reach the model** through a structured image channel in agent-core. The untrusted envelope stays around the text. Images are stripped from checkpoints. Only the last 3 are kept in context, which is made safe by porting the Mac client's thinking `drop_block` binding to agent-core's Anthropic provider. |
| D7 | **The server is protected by caps, not by a bill.** There is a cap on awake computers per account and in total, per-container memory, CPU and disk limits, and a preflight that refuses to start a computer when the host lacks free memory or disk. Computer time can still count against the account's usage windows through `COMPUTER_COST_MICRO_USD_PER_SECOND`, which defaults to `0` (it's the owner's own server). There is no new budget system. |
| D8 | Native (Mac and iPhone) gets **watch and take over** of the computer by showing Juno's own `/computer-view` page in a `WKWebView`, plus labels for the new chat tools. This happens in Phase 7 and **must not block** the web release (see Phase 7's exit rule). |
| D10 | **The live view streams through Juno's own voice relay** (`/voice-relay/computer`, `INFRA.md`) as VNC, drawn by the noVNC client (`@novnc/novnc`) inside Juno's page. No third-party origin, no iframe. View-only is enforced by x11vnc's separate view-only password. |
| D9 | **Deferred:** group rooms, teach-a-task, credential vault, single-use cards, external messaging, uploaded or generated avatar images, new face vocabulary. Say so in the docs. Do not build them. |

---

## 3. What exists today (the map)

- **Agents** (`src/lib/agents/`):
  - `domain.ts`: vocabularies, zod schemas, `deriveAgentState`, limits.
  - `store.ts` (server-only): every CRUD function (`createAgentForUser`,
    `updateAgentForUser`, `retireAgentForUser`, `ensureAgentThread`, `startAgentTask`,
    `createAgentRoutine`, goal and note functions, `agentChatContext`,
    `recordAgentEvent`, `loadAgentDetail`, `listAgentActivity`).
  - `prompt.ts`: `buildAgentPromptBlock`.
  - `templates.ts`, `avatar.ts`, `types.ts` (wire shapes), and `reflect*.ts`.
- **Routes:** `src/app/api/agents/**`. Every route uses `requireUser` from
  `@/lib/code-remote` and forwards `store` results.
- **UI:** `src/components/agents/*`. The page with 5 tabs is `agent-page.tsx`, the hire
  form is `agent-hire.tsx`, the thread header is `agent-thread-header.tsx`, the roster
  is `agents-roster.tsx`, and `use-agents.ts` polls. The pages are under
  `src/app/(app)/agents/**`.
- **In chat:**
  - `src/app/api/chat/route.ts` reads `conversation.agentId`.
  - `agentChatContext(...)` builds the prompt block.
  - The tools `start_task` (`src/lib/chat/task-tool.ts`) and `hand_off_to_teammate`
    (`src/lib/chat/handoff-tool.ts`) are the two existing `NativeChatTool`s. They are
    **your templates** for the new tools: pure half on top, server half at the bottom,
    server imports via `await import()`, queue-serialised, broker approvals with a
    synthetic connector id.
- **Work executor:**
  - `scripts/work-runner.ts` (`tick` → `drive` → `execute` → `buildTools`).
  - The runtime is `runner/agent-core/src/work/`: `session.ts`
    (`WorkAgentSession.executeToolCall`, `checkpoint`), `tools.ts` (`browserTool(deps)`,
    `asWorkTool`, `withoutHostWorkspaceTools`) and `types.ts` (tiers, risk,
    `ALWAYS_CONFIRM_ACTIONS`, the `WorkEvent` union).
  - The local headless browser is `src/lib/work/browser.ts` (`createWorkBrowser`).
- **Approvals:**
  - In chat: `src/lib/action-approval.ts` (`JunoRules`, `actionPreview`) and
    `src/lib/action-approval-store.ts` (`authorizeExternalAction`,
    `completeExternalAction`). The card is `src/components/chat/approval-card.tsx`.
  - In runs: `approvalAsksUnder` + `WorkApproval`.
- **Known bug to fix:** a paused agent's thread still starts tasks. `agentChatContext`
  never checks `status`, and `task-tool.ts` has no pause check.

---

## 4. Architecture

### 4.1 Data (one migration, `<timestamp>_agents_v2`)

```prisma
/// An agent's own computer: a Docker container on the owner's server. One per
/// agent, never shared. The container is created lazily; `containerRef` is null
/// until first use.
model AgentComputer {
  id             String    @id @default(cuid())
  userId         String
  agentId        String    @unique
  provider       String                       // "docker" | "fake"
  containerRef   String?   @db.Text           // encryptSecret(container id)
  secrets        String?   @db.Text           // encryptSecret(JSON {cdpToken, vncControl, vncView})
  status         String    @default("asleep") // asleep | resting | waking | awake | error
  streamOn       Boolean   @default(false)
  leaseRunId     String?
  leaseExpiresAt DateTime?
  lastResumedAt  DateTime?
  lastActiveAt   DateTime?
  lastViewedAt   DateTime?
  activeSeconds  Int       @default(0)        // lifetime awake seconds, for the UI
  diskMb         Int?                         // last measured /home/agent size
  lastError      String?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt
  user  User  @relation(fields: [userId], references: [id], onDelete: Cascade)
  agent Agent @relation(fields: [agentId], references: [id], onDelete: Cascade)

  @@index([userId, status])
  @@index([status, lastActiveAt])
}
```

- Add `computer AgentComputer?` to `Agent`, and `agentComputers AgentComputer[]` to `User`.
- On `Agent` add:
  - `notify String @default("results")`, with values `needs_you | results | all`;
  - `pinnedAt DateTime?`.
- `AgentComputer` goes in `OWNER_COLUMN`. Add RLS ENABLE. **No** sync trigger.
- Add a `SECURITY.md` row: `AgentComputer.containerRef` and `.secrets` use `encryptSecret`.
- A row existing means the computer is **enabled**. Disabling deletes the row, after
  removing the container and its volume.
- `AgentEvent.detail` keeps its JSON shape. Undo data goes in it as `detail.before` and
  `detail.after`. It holds only field values, never note text: notes use `noteId`
  references, because note text is encrypted and must never be copied into the log.

### 4.2 The computer provider layer (`src/lib/computer/`, all `import "server-only"`)

The container image, entrypoint, CDP gate, firewall, server setup script, the exact
`docker` flags, pixel control through `xdotool`/`scrot`, the on-demand x11vnc and the
relay are all specified in **`INFRA.md`**. Copy the infra files verbatim.

```ts
// src/lib/computer/types.ts
export type ComputerStatus = "asleep" | "resting" | "waking" | "awake" | "error";
export interface Shot { mediaType: "image/jpeg"; data: string /* base64 */; width: number; height: number }
export interface ExecResult { stdout: string; stderr: string; exitCode: number; timedOut: boolean }
export interface Endpoints { cdp: { host: string; port: number }; vnc: { host: string; port: number } }
export interface ComputerHandle {
  readonly ref: string;                             // container id; never leaves the server
  screenshot(): Promise<Shot>;                      // JPEG q70, NOT resized (1280×800 = click space)
  click(x: number, y: number, button?: "left" | "right" | "double"): Promise<void>;
  move(x: number, y: number): Promise<void>;
  drag(from: [number, number], to: [number, number]): Promise<void>;
  scroll(x: number, y: number, direction: "up" | "down", amount: number): Promise<void>;
  type(text: string): Promise<void>;
  key(keys: string): Promise<void>;                 // xdotool names: "Return", "ctrl+l", "Tab"
  exec(cmd: string, opts: { timeoutMs: number; cwd?: string }): Promise<ExecResult>;
  readFile(path: string, maxBytes: number): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  listFiles(path: string): Promise<Array<{ name: string; path: string; type: "file" | "dir"; size?: number }>>;
  endpoints(): Promise<Endpoints>;                  // container IP on Linux; docker port on macOS dev
  startVnc(passwords: { control: string; view: string }): Promise<void>;
  stopVnc(): Promise<void>;
  diskUsageMb(): Promise<number>;
}
export interface ComputerProvider {
  readonly id: "docker" | "fake";
  available(): Promise<{ ok: true } | { ok: false; reason: string }>; // image present, daemon up
  preflight(): Promise<{ ok: true } | { ok: false; reason: string }>; // host free memory + disk
  create(meta: { userId: string; agentId: string; cdpToken: string }): Promise<ComputerHandle>;
  open(ref: string): Promise<ComputerHandle | null>;                  // null if the container is gone
  state(ref: string): Promise<"running" | "paused" | "stopped" | "missing">;
  start(ref: string): Promise<void>;                                  // from stopped
  pause(ref: string): Promise<void>;                                  // docker pause (resting)
  unpause(ref: string): Promise<void>;
  stop(ref: string): Promise<void>;                                   // docker stop (asleep)
  destroy(ref: string, agentId: string): Promise<void>;               // rm -f + volume rm
  listOwned(): Promise<Array<{ ref: string; agentId?: string; userId?: string; state: "running" | "paused" | "stopped" }>>;
}
```

**Files:**
- `provider.ts`: `computerProvider()` returns the configured provider or `null`.
  - It reads the env via `src/lib/env.ts`.
  - `fake` is refused in production.
  - `isAgentComputerConfigured()` is the one switch every caller checks: `COMPUTER_PROVIDER`
    set, plus a cached `available()` (60 s).
- `docker.ts`: `DockerProvider`, exactly as specified in `INFRA.md`.
  - It uses only `execFile("docker", argv)` or `spawn("docker", argv, { shell: false })`,
    with argument arrays. Never a host shell string.
  - The creation flags are fixed.
  - A unit test with an injected fake `runDocker` asserts the full production argv and
    the forbidden flags.
  - **Development on this Mac:** build the image locally with
    `docker build -t juno-computer:dev deploy/agent-computers`, then use
    `COMPUTER_DOCKER_IMAGE=juno-computer:dev`. Ports are published to 127.0.0.1 only on
    macOS outside production.
- `fake.ts`: an in-memory `FakeProvider` for tests and the dev gallery.
  - It returns a fixed 1280×800 grey JPEG.
  - It records calls and supports every state transition.
  - It keeps an in-memory filesystem.
- `remote-browser.ts`: `connectAgentBrowser(handle, secrets)`.
  1. `const { cdp } = await handle.endpoints()`.
  2. Discover the browser WebSocket path **inside** the container with
     `exec("curl -s http://127.0.0.1:9223/json/version")`, and parse
     `webSocketDebuggerUrl`. Wait up to 20 s after a start for it to answer.
  3. Connect with
     `chromium.connectOverCDP("ws://" + cdp.host + ":" + cdp.port + path, { headers: { "X-Juno-Cdp-Token": secrets.cdpToken }, timeout: 20_000 })`,
     using `playwright`, which is already a runtime dependency.
  4. Use `browser.contexts()[0]`, the persistent profile. **Never** call `context.close()`
     on it.
  5. When done, call `browser.close()`. For a CDP connection this only disconnects.
     **Verify in the local smoke test** that Chromium is still running afterwards.
  6. Implement the agent-core `BrowserToolDeps` interface, the seam `browserTool(deps)`
     already takes, over this page. Actions follow the newest page, and call
     `page.bringToFront()` so the live view shows what the agent does.
  7. **Reuse, don't copy,** the snapshot, ref, `submitsForm`, `pageTakesPayment` and act
     logic of `src/lib/work/browser.ts`. Extract the page-level helpers into
     `src/lib/work/browser-page.ts` so that both `createWorkBrowser` (local, unchanged
     behaviour) and the remote browser use them.
     - `tests/work-browser.test.ts` must pass **unchanged**.
     - If extraction proves risky, stop extracting and call the same helpers through a
       small adapter. Never change the local browser's behaviour.
  8. The remote browser loads images, fonts and media; it is a real browser. It keeps
     the structural "click on a form submit is refused; use submit" rule, the risk
     ladder and purchase detection. The checks before `open` (`blockedFetchTarget` and
     the skill egress grant) already sit in the tool layer and still apply.
- `live-view.ts`: the live view.
  - `ensureStream(handle, row)`: if `streamOn` is false, generate fresh `vncControl` and
    `vncView` (8 characters of `[A-Za-z0-9]` each), call `handle.startVnc(...)`, save
    them with `encryptSecret`, and set `streamOn = true`.
  - `stopStream` calls `handle.stopVnc()` and sets `streamOn = false`.
  - `mintViewToken(row, endpoints, mode)` returns the relay token defined in `INFRA.md`,
    signed with the key derived from `AUTH_SECRET`, `exp` 60 s.
- `store.ts` (`server-only`): the only module that reads or writes `AgentComputer`. It
  holds the lifecycle functions in §4.3.

### 4.3 Lifecycle, leases, rest, sleep, sweep (`src/lib/computer/store.ts`, `sweep.ts`)

- `enableComputer(userId, agentId)` creates the row (`status: "asleep"`, no container).
  It refuses if the feature is off.
- `ensureAwake(userId, agentId, reason)`:
  1. **Resting** (paused): `unpause`, then go to step 5. This is instant, and needs no
     preflight or caps change: a resting computer already counts.
  2. Otherwise, check the caps (§4.7) and `provider.preflight()`. When the account's
     usage windows matter (cost > 0), also run `checkUsageWindows`, which Work dispatch
     uses. Refuse with the provider's sentence.
  3. `status = "waking"`.
  4. `open(containerRef)` then `start`, or `create` if there is no ref or `open` returned
     `null`. When a missing container is recreated, clear the secrets, generate a new
     `cdpToken`, and record an AgentEvent `computer_recreated`: "Its computer was lost and
     has been replaced; sign-ins are gone." Then wait for CDP to answer (≤ 30 s).
  5. `status = "awake"`, `lastResumedAt = lastActiveAt = now`.
  6. On error: `status = "error"`, `lastError` set to a **sentence with no ids, IPs or
     URLs**.
- `restComputer`: `stopStream`, `provider.pause`, `status = "resting"`, and add the awake
  seconds to `activeSeconds`.
- `sleepComputer(userId, agentId)`:
  1. If it is resting, `unpause` first.
  2. `stopStream`.
  3. Take a poster: `screenshot()`, then `putObject` under
     `agent-computers/<userId>/<agentId>/poster.jpg`, using `@/lib/storage`.
  4. `provider.stop`. It stops gracefully, so Chromium flushes cookies.
  5. Add the awake seconds to `activeSeconds`, and bill them if the cost is > 0 (D7).
  6. `status = "asleep"`.
- `resetComputer` / `disableComputer` / on retire:
  - `destroy` the container **and its volume**, and clear the ref and secrets;
  - then delete the row (disable) or keep it asleep with no container (reset);
  - delete the poster and record an AgentEvent.
  - The UI says plainly that sign-ins and files are deleted.
- **Run lease:** `acquireComputerLease(agentId, runId, ttlMs = 120_000)`.
  - It is one conditional `updateMany` where `leaseRunId` is null, or equals `runId`, or
    `leaseExpiresAt < now`, and it checks the count.
  - `renewComputerLease` runs on the Work run's existing lease-renewal timer (every 40 s)
    and sets `lastActiveAt = now`.
  - `releaseComputerLease` sets `lastActiveAt = now`. It **does not** rest or sleep the
    computer; the sweeper does that.
- **Sweeper** (`sweepAgentComputers()` in `sweep.ts`), called from the Work runner's
  `tick()` at most once every 60 s, with no new PM2 app. It:
  1. **Rests** every `awake` computer with no valid lease whose
     `max(lastActiveAt, lastViewedAt)` is older than `COMPUTER_IDLE_PAUSE_SECONDS`.
  2. **Puts to sleep** every `resting` computer idle longer than
     `COMPUTER_IDLE_STOP_MINUTES`.
  3. Stops the stream on awake computers with `streamOn` and no view heartbeat for 60 s.
  4. Every 10 min, measures `diskUsageMb` for awake computers and stores `diskMb`.
  5. At most every 6 h, lists `listOwned()`:
     - removes containers and volumes with no matching row, which covers deleted agents
       and deleted accounts;
     - destroys computers asleep longer than `COMPUTER_RETENTION_DAYS`;
     - resets any `waking` status stuck for more than 3 min to `error`.
  6. Reconciles the state: a row that says `awake` for a container Docker reports as
     `stopped` becomes `asleep`. This happens after a server reboot, because containers
     use `--restart no`.

  Every step is try/catch-per-item and logs without ids, IPs or URLs.
- **Any handle call** that finds the container paused or stopped (the sweeper raced a run)
  unpauses or starts it once and retries once.

### 4.4 In the Work runner (`scripts/work-runner.ts` + agent-core)

**Attaching.** In `buildTools(...)`:
1. If the run's session has `agentId` and `isAgentComputerConfigured()`, and the agent
   has an `AgentComputer` row, then `acquireComputerLease`, `ensureAwake`, and
   `connectAgentBrowser`.
2. On success:
   - (a) pass the **remote** deps into the existing `browserTool(...)` instead of
     `createWorkBrowser`;
   - (b) add the computer tools from `runtime.computerTools(deps)`;
   - (c) push a disposer that disconnects Playwright and releases the lease, and **never
     stops, pauses or removes the container**; the sweeper rests it later. The same
     disposer runs on park or pause.
3. If the lease is busy, or waking fails, fall back to the existing local browser and
   log a line. Tell the model in the opening context: "Your computer is busy with another
   task or unavailable; you're using a temporary browser for this one."
4. All tools stay **inside** the array literal returned through
   `runtime.withoutHostWorkspaceTools([...])`. Disposers are pushed before the `return`.

**Targeting.** For a session with an `agentId` whose computer is enabled, dispatch must
target the **cloud**, never a paired Mac.
- Today, "screen" or "terminal" wording infers Mac-only capabilities
  (`src/lib/work/inference.ts`).
- Make `startAgentTask`, `start_task` from an agent thread, routines and handoffs pass
  `requestedTarget: "cloud"` when the agent has a computer.
- Make sure inference cannot re-route or degrade that session. Add a test.

**The computer tools** (new file `runner/agent-core/src/work/computer-tools.ts`, exported
from `work/index.ts`, recorded in `VENDORED.md`). Do **not** reuse or modify
`runner/agent-core/src/computer.ts`, which is the Mac sidecar's.

| Tool | Input | tier | intent | action | risk |
|---|---|---|---|---|---|
| `computer_screenshot` | `{ reason }` | `visual` | `screen.look` | `work.computer.screenshot` | `safe` |
| `computer_click` | `{ x, y, button?: left\|right\|double }` | `visual` | `screen.click` | `work.computer.click` | `command`; **`irreversible`** + action `work.browser.purchase` if the active page takes payment |
| `computer_type` | `{ text ≤ 2000 }` | `visual` | `screen.type` | `work.computer.type` | same rule as click |
| `computer_key` | `{ keys }` e.g. `"ctrl+l"`, `"enter"` | `visual` | `screen.key` | `work.computer.key` | same rule as click |
| `computer_scroll` | `{ x, y, direction, amount 1..10 }` | `visual` | `screen.scroll` | `work.computer.scroll` | `safe` |
| `computer_shell` | `{ command ≤ 4000, timeoutSeconds 1..300 (default 60), cwd? }` | `shell` | `shell.run` | `work.computer.shell` | `command` |
| `computer_files` | `{ action: list\|read\|write, path, content? }` (paths under `/home/agent` only) | `shell` | `files.read` / `files.write` | `work.computer.files` | read `safe`, write `edit` |

Rules for these tools:
- Intents are **disjoint** from `browser.*`, so the tier lattice never refuses them
  while `browser` is healthy. The prompt steers: use `browser` for web pages, pixel
  tools only where the DOM tool can't reach (other apps, canvas, drag-and-drop, file
  pickers), shell and files for code and data.
- `riskFor` is synchronous. The "payment page" flag is a cached boolean that the deps
  refresh after every action and screenshot, from the remote page's `pageTakesPayment`.
  `work.browser.purchase` is already an always-confirm action, so no vocabulary changes.
- Every action tool returns a short text result plus **one fresh screenshot** through the
  image channel. The model rarely needs `computer_screenshot`.
- `summarize(input)` is exact and bounded (≤200 characters), and names the current site
  (hostname only), e.g. `Click at (640, 320) on mail.google.com` or
  `Run: npm test (in /home/agent/work)`. This is the only thing an approval card shows.
  It never contains ids or URLs with tokens.
- `provenanceFor`:
  - `source: "the agent's computer"`;
  - `sourceKind: "web"` for pixel and browser actions, `"local_app"` for shell and files;
  - `trust: "untrusted"` for **every** output.
- `isHealthy()` returns the handle's last known state.
- The container desktop is 1280×800. Screenshots are **not resized**, so a click at
  (x, y) lands where the model saw it.
- Hard timeouts on every call: 30 s for UI actions, `timeoutSeconds` for the shell. Tools
  get no AbortSignal, so without these a stuck call blocks Stop.
- Output limits: shell stdout and stderr are each capped at 20,000 characters (say that
  it was cut); file reads are capped at 200 KB of text.

**The image channel (agent-core):**
- `ToolResult` gains an optional
  `images?: ReadonlyArray<{ mediaType: "image/jpeg" | "image/png"; data: string }>`.
- In `WorkAgentSession.executeToolCall`, after the existing untrusted wrapping of the text,
  return the `tool_result` **followed by** `{ type: "image", mediaType, data }` parts.
  Check that `runAgentLoop` and the delegate path accept an array. The report says they
  do; verify it, and write a test.
- `checkpoint()` replaces every image part with the text
  `"[Screenshot omitted from the saved run]"`. This mirrors
  `runner/agent-core/src/session.ts` `saveMessages`. A test asserts that a checkpoint
  never contains `"data":"/9j` or `base64`.
- Before each provider call, keep only the **last 3** image parts in the messages,
  replacing older ones with the same marker. This is only safe for Opus 5.5 / Fable 5.1
  thinking signatures with the binding control:
  - port `bindingTolerant` from `native/Packages/JunoCode/Sources/JunoCodeBridge/BackendCodeModelClient.swift`
    into agent-core's Anthropic provider: when `thinking.type` is `adaptive` or
    `enabled`, add `thinking.block_binding = { prefix_mismatch_behavior: "drop_block" }`
    **and** the `anthropic-beta: thinking-binding-controls-2026-08-01` header, merged with
    any existing betas;
  - the field and the beta always travel together. Test both.
- **Stall detector:** `plan.observeToolCall(name, input)` would halt a run that takes
  screenshots in a loop.
  - Add an optional `signatureInput?(input): unknown` to `WorkToolDefinition`, and have
    `session.ts` pass `tool.signatureInput ? tool.signatureInput(input) : input` to
    `observeToolCall`. **Do not edit `plan.ts`.**
  - Computer tools and the remote `browser` return `{ ...input, screen: deps.screenEpoch() }`,
    where the epoch increments after every mutating action. Repeated look-without-acting
    still counts as stalling, which is correct.
  - Add a test: a 20-step click/screenshot loop against the fake provider must not halt.

**Identity in runs.** In `execute()`, when `session.agentId` is set, load the agent
(scoped by `userId`, not retired), its active goals (≤8) and newest notes (≤24,
decrypted). Add them to the run's opening context:
- the brief, style and goals as **"Who you are working as"** (authored by the owner);
- the notes inside the existing untrusted envelope (the model may have written them).
- When a computer is attached, add the **"Your computer"** section:

> You have your own computer: a Linux desktop with Chromium, a shell and files. The
> `browser` tool drives its Chromium, and the person can watch the same screen. Prefer
> `browser` for web pages. Use the `computer_*` pixel tools only for things the page
> tools can't reach. Keep files you want to keep under /home/agent/work. Stay signed in to
> sites between tasks: your sign-ins persist. When a site needs a password, a 2FA code, a
> CAPTCHA, payment details or anything only the person should type, call `ask_user` and
> ask them to take over your computer for that step. Never ask for a secret in the chat
> and never type one you were told in the chat.

**Billing.** At sleep and at run end, compute the awake seconds since `lastResumedAt`
(minus what was already billed), multiply by `COMPUTER_COST_MICRO_USD_PER_SECOND`, and
record the spend through the **same ledger** `billRunUsage` / `recordWorkRunSpend` uses.
Attribute seconds inside a run to that run; attribute idle or viewing seconds as a
utility spend line. Read the ledger code first and pick the existing function that fits;
do not create a second ledger. The 5-hour and weekly windows then include computer time.
`ensureAwake` refuses when a window is spent, naming the window, as dispatch does.

### 4.5 API routes (new; each classified in `contracts/parity/features.json`)

All routes:
- are owner-scoped;
- use `requireUser`;
- return `{ computer: null }` or `404 not_enabled` when the feature is off;
- are rate-limited where noted;
- set `Cache-Control: no-store` on every computer route.

| Route | Does |
|---|---|
| `GET /api/agents/[id]/computer` | `{ computer: null \| { enabled, status, streamOn, lastActiveAt, activeSeconds, hasPoster, usingNow: { summary } \| null, error: string \| null } }`. `usingNow` comes from the agent's live run's newest `tool_started.summary`. |
| `POST /api/agents/[id]/computer` | `{ action: "enable" \| "disable" \| "wake" \| "sleep" \| "reset" }`. These are UI presses by the owner, so no card; the UI confirms disable and reset in a dialog. `wake` returns 202 and runs `ensureAwake` in `after()` (from `next/server`). Rate limit 20/h. |
| `POST /api/agents/[id]/computer/view` | `{ mode: "watch" \| "control", handoff?: boolean }`. Requires `awake` or `resting`; a resting computer is unpaused. Otherwise 409 `{ error: "asleep" }`. Starts the stream if it is off. Returns `{ mode, relayUrl, token, password }`: `relayUrl` is `<the voice relay origin>/voice-relay/computer`, `token` is the 60 s relay token (`INFRA.md`), and `password` is `vncView` for watch or `vncControl` for control. With `handoff: true` (native), it returns `{ url }` instead: a one-time `https://<app>/computer-view?c=<code>` link (below). `control` records AgentEvent `takeover_started`. Rate limit 60/h. Headers `Cache-Control: no-store`, `Referrer-Policy: no-referrer`. The response is never logged. |
| `POST /api/agents/[id]/computer/heartbeat` | `{ mode, ended?: boolean }`. Updates `lastViewedAt` and returns the status. `ended` with `mode: "control"` records `takeover_ended` and **restarts the stream**, rotating both passwords so the control password dies. Rate limit 10/min. |
| `GET /api/agents/[id]/computer/poster` | The last-frame JPEG (owner-scoped read from storage), `Cache-Control: private, no-store`. |
| `GET /api/agents/[id]/computer/files?path=` | Lists a directory under `/home/agent` (awake or resting only). `&download=1` on a file streams it (≤25 MB, `Content-Disposition: attachment`). Paths are resolved inside the container with `realpath -m` and must stay under `/home/agent/`. |
| `GET /computer-view?c=<code>` (page, outside the `(app)` group) | The viewer for native apps' `WKWebView`. `code` = HMAC-signed `{agentId, userId, mode, exp: 60 s}` with the same `AUTH_SECRET`-derived scheme, under its own label `juno-computer-handoff-v1`. The server component verifies it, mints a relay token and password, and renders the same `ComputerViewer` client component the web panel uses, full-bleed and without the app shell. Headers `no-store`, `no-referrer`, `robots: noindex`. An invalid or expired code shows "This link has expired. Open the computer again from the app." |
| `POST /api/agents/[id]/undo` | `{ eventId }`. Applies `detail.before` from that AgentEvent if it belongs to this agent and user and has not been undone; marks `detail.undoneAt`. Returns `{ agent }`. |
| `POST /api/agents/[id]/duplicate` | Copies profile, face, style, brief, autonomy, apps, model and active goals. Never copies notes, the computer, routines or the thread. Named "<name> 2". Returns 201 `{ agent }`. Respects the 24-agent cap. |

Other changes:
- Extend `PATCH /api/agents/[id]`: optional `notify` and `pinned: boolean`, both
  additive. `pinned: true` sets `pinnedAt` and the roster sorts pinned first.
- `GET /api/agents` and `GET /api/agents/[id]` gain optional keys:
  - `notify`, `pinnedAt`;
  - `computer: { enabled, status } | null`;
  - `recentChanges` is **not** needed.
- **CSP:** the viewer's WebSocket goes to the voice relay origin, which `buildCsp`
  already allows in `connect-src` when the relay URL is configured. Confirm that in
  `src/lib/csp.ts` and `src/middleware.ts`, and find how the web client learns the relay
  URL (search the voice client). If the relay origin is not in `connect-src`, add it the
  same way the voice relay is added. Do **not** loosen anything else, and keep
  `tests/csp.test.ts` green.
- **Relay:** implement `relay/src/computer-view.ts` exactly as `INFRA.md` specifies, with
  its tests in `relay/tests/`. Add `RELAY_COMPUTER_CIDR` only if you need to override the
  default. `AUTH_SECRET` is already in the relay's env allowlist.

### 4.6 Configuration by chat (`src/lib/chat/agent-config-tools.ts` + route wiring)

**Build every tool on the `task-tool.ts` / `handoff-tool.ts` pattern:**
- a pure top half: `McpFunctionTool` declarations, argument parsing and bounding, and a
  refusal table;
- a server half, `createAgentConfigTools(ctx): NativeChatTool[]`, with `access: "write"`,
  a promise queue, and store and broker imports via `await import()`;
- idempotency keys of `userMessageId` + a sha256 of the normalized arguments.

**Gate:** offer the tools on exactly the turns where `chatTaskToolEnabled(...)` is true
(same gate object). Never on private, voice, regenerate or lockdown turns. Add them to
`nativeTools` next to `taskTool` and `handoffTool`, and update the pinned regex in
`tests/chat-task-tool.test.ts` deliberately.
- **In an agent thread** (`agentContext` non-null and the agent active): `update_agent`,
  `agent_goal`, `agent_routine`, `agent_memory` (targeting that agent), and
  `create_agent`.
- **In any other chat:** `create_agent` and `update_agent`, which needs the `agent` name.
  Resolve names like `resolveTeammate` does: exact, then case-insensitive, and refuse
  duplicates.

**Tools** (flat schemas; every property has a description; `enum`s where listed):

1. `create_agent`:
   - `name` (required, ≤40), `role` (≤80), `template` (enum of the 7 template ids),
     `instructions` (≤6000), `style` (enum), `faceShape`/`faceTone`/`faceEyes`/`faceMark`
     (enums from `avatar.ts`), `autonomy` (enum conservative/balanced/permissive),
     `apps` (array of provider ids), `computer` (boolean), `firstGoal` (≤200).
   - The server creates the agent **at once** with the safe fields, and autonomy capped at
     `balanced`.
   - Then, if the request widens anything (permissive, apps, computer), it raises **one**
     card listing exactly those, and applies them on Allow.
   - Result card: "Hired Nova", with the face and **Open** (→ the thread).
2. `update_agent`:
   - Fields: `agent` (name; omit in the agent's own thread), `name`, `role`,
     `instructions` (replace), `addToInstructions` (append one line), `style`, the four
     face fields, `model`, `reasoningEffort`, `proactive` (boolean), `notify` (enum),
     `autonomy`, `addApps[]`, `removeApps[]`, `computer` (enum `on|off|reset`), `status`
     (enum `paused|active`), `pinned` (boolean).
   - **Direct, with Undo:** name, role, instructions, addToInstructions, style, face,
     proactive, notify, removeApps, autonomy **narrowing**, status, pinned.
   - **Card:** autonomy **up**, addApps, `computer: on`, `computer: reset` (destroys
     sign-ins; say so), `computer: off` (same), model, reasoningEffort.
   - **In a turn that read outside content** (`untrustedContentInTurn`), **everything**
     goes through the card.
3. `agent_goal`:
   - `action` (enum `add|update|achieve|pause|resume|drop`), `goalId`, `title`,
     `detail`, `cadence`.
   - Direct with Undo, except `drop`, which is direct and not undoable, so say so.
4. `agent_routine`:
   - `action` (enum `create|pause|resume|delete`), `routineId`, `name`, `instructions`,
     `cadence` (enum hourly/daily/weekdays/weekly/monthly), `hour`, `minute`, `weekday`,
     `monthday`.
   - `create` and `resume` go through a **card**, because they run unattended. `pause` is
     direct. `delete` goes through a card.
   - **Timezone:** add an optional `timeZone` string to `chatBodySchema` and
     `ChatRequestBody` (IANA name, validated with `Intl.supportedValuesOf("timeZone")`, or
     try/catch `new Intl.DateTimeFormat(undefined, { timeZone })`). The web sends
     `Intl.DateTimeFormat().resolvedOptions().timeZone` from `use-chat.ts`. Classify it in
     the wire status file as web-only. If it is absent, refuse `create` with "Tell me your
     time zone" rather than guessing UTC.
5. `agent_memory`:
   - `action` (enum `remember|forget|list`), `text` (≤1000), `noteId`.
   - `remember` writes an `AgentNote`. Add a `source` parameter to `createAgentNote`
     (default `"user"`); this tool writes `"agent"`.
   - It goes direct with Undo in a clean turn, and through a **card** in a turn with
     untrusted content. Never copy note text into an AgentEvent: store the `noteId`.

**Approval cards** (widening changes):
- Call `authorizeExternalAction` with:
  - `connectorId: "juno_agents"`, `connectorLabel: "Agents"`;
  - `toolName` equal to the tool name;
  - `args` equal to **the exact change set**: `{ agent: name, changes: [{ field, label, from, to }] }`,
    with long text bounded to 600 characters so the card shows what is approved;
  - `provenance: { source: "chat_model", sourceKind: "agent_config", derivedFromUntrusted }`.
- Add **exact** `JunoRules` entries: `"juno_agents:<tool>": "external_write"` for all five
  tools. Without them, the token classifier treats `role` or `key` as destructive.
- Add an `actionPreview` branch. It is the push and inbox text: "Let Nova work without
  asking and use Gmail?" Build it on the server from the change set; never use
  model-written text.
- On the web, extend `approval-card.tsx` with a `juno_agents` variant:
  - a headline from `actionPreview`;
  - a small table of `label: from → to` rows;
  - Deny first, then Allow once. No "always" for these.
  - Copy tables go next to `TASK_*` and `HANDOFF_*`. Compare the literal connector id;
    don't import from the server module.
- Bind the card to the agent's `updatedAt` at request time: refuse to apply if the agent
  changed since, with "Nova changed since you were asked. Ask again."
- Call `completeExternalAction` on every exit path.

**Change cards in the transcript** (persisted, so they survive reload):
- Add an optional key to `ClientActivityEvent` (`src/types/chat.ts`):
  ```ts
  agentChange?: {
    version: 1;
    agentId: string; agentName: string; avatar: AgentAvatar;
    kind: "hired" | "updated" | "goal" | "routine" | "memory";
    summary: string;                       // server-written, e.g. "Renamed to Nova"
    changes: Array<{ label: string; from?: string; to?: string }>;
    eventId?: string;                      // AgentEvent id when undoable
    undoable: boolean;
    status: "applied" | "pending" | "declined" | "undone";
  }
  ```
- **Add it to `serializeActivity`'s whitelist** (`src/lib/serializers.ts`). Otherwise it
  vanishes at `done` and on reload. Copy the pattern and test of the `patch`/`exitCode`
  keys.
- Classify it in `contracts/chat/juno-chat-wire-v1.status.json` (web-only), then
  `npm run native:wire`.
- Emit it from the route through a callback the tool receives (like `onStarted`):
  `sendActivity({ kind: "tool", title, agentChange })`. Custom titles don't appear in the
  thought panel, so this card is the visible record.
- Render `src/components/chat/agent-change-card.tsx`, lazy-loaded in `message-item.tsx`
  from `view.activity`, next to the approvals block. It contains:
  - the face (`xs`);
  - one line of summary;
  - the `label: from → to` rows in muted text;
  - **Undo** (POST `/api/agents/[id]/undo`), which becomes "Undone";
  - **Open** for `hired`.

  No pill and no coloured status dot. "Pending" shows as the plain words "Waiting for
  you" next to the approval card.
- After any change: `announceAgentsChanged()` on the client. The thread header must
  re-read the agent. Make chat-view keep the agent in state, and refetch it with
  `fetchAgentDetail` when an `agentChange` activity arrives or a turn ends in an agent
  thread.

**Prompt.** `buildAgentPromptBlock`:
- Describe the config tools **only when they are on** (a `selfConfig` flag threaded
  through `agentChatContext` options). Keep that text byte-stable: it is cached.
- **Onboarding mode:** when the agent has an empty `role` and `instructions`, add:

  > You were just created and have no job yet. From the person's first message, set
  > yourself up: choose a fitting name if they didn't give one, and set your role,
  > brief and face with update_agent. Then add a first goal with agent_goal if one is
  > clear. Propose autonomy, apps or your own computer only if the job needs them; the
  > person confirms those on a card. Do it in one or two short messages. Don't
  > interrogate.

- Update `tests/agents-domain.test.ts` expectations deliberately.
- Keep the voice persona (`src/app/api/voice/persona/route.ts`) free of tools. It passes
  `taskHandoff: false`; also pass `selfConfig: false`.

**Results back into the thread.** `agentChatContext` gains **"Recent work"**: the agent's
last 5 WorkSessions (title, terminal status, finished time), and for finished ones the
first 600 characters of the run's final report text (find it in the `run_finished`
payload or the run's outcome field). Put it inside the chat's untrusted-content wrapper,
the same one used for connector or memory context in `system-prompt.ts`.

**Fix the pause bug.** For a paused agent, `agentChatContext` returns `status`.
`start_task`, the handoff and the config tools refuse, except `update_agent` with
`status: "active"`, and the prompt says "You are paused". Add a test.

### 4.7 Caps, cost, budget (the numbers)

The defaults are sized for the **upgraded** server. The owner tunes them in `~/juno/.env`
without a code change.
- **Running computers:** ≤ `COMPUTER_MAX_RUNNING_PER_USER` (2) per account and ≤
  `COMPUTER_MAX_RUNNING_TOTAL` (4) overall. The count is
  `status in (awake, waking, resting)`, because a resting container still holds its RAM.
  - Waking beyond a cap refuses with "Two of your agents' computers are already on. Put
    one to sleep or wait for it to rest."
  - A run that can't get a computer falls back to the temporary browser (§4.4).
- **Per computer:** `COMPUTER_MEMORY_MB` (2048) RAM, `COMPUTER_CPUS` (2) and
  `COMPUTER_DISK_LIMIT_MB` (10240) of `/home/agent`.
- **Host preflight:** free memory ≥ `COMPUTER_MIN_FREE_MEMORY_MB` (1024) and free disk ≥
  `COMPUTER_MIN_FREE_DISK_GB` (10). This keeps the website itself healthy.
- **Rest** (`docker pause`) after `COMPUTER_IDLE_PAUSE_SECONDS` (180) with no lease and no
  viewer. **Sleep** (`docker stop`) after `COMPUTER_IDLE_STOP_MINUTES` (30) of rest.
- **Retention:** destroy after `COMPUTER_RETENTION_DAYS` (30) asleep. The UI says, in
  Setup: "Asleep more than 30 days: its sign-ins and files are cleared."
- **Cost:** `COMPUTER_COST_MICRO_USD_PER_SECOND` defaults to `0`. It's the owner's
  server; they may set a value so computer time counts in the usage windows.
- **Plan:** computers are available where Work is available (reuse the existing
  plan gate the agents store uses, `plan_locked`).

### 4.8 UI (web)

Follow the premium pass's existing components and tokens. Reuse `AgentFace`,
`SegmentedControl`, `Button`, the dialog and sheet primitives, and `WorkRunPanel` pieces.
Density target: nothing larger than the thread header until you open something.

1. **Agent thread** (`/chat/[conversationId]` when `conversation.agentId`):
   - **Header** (`agent-thread-header.tsx`): face `sm` (live state) · name · state
     sentence (plain text) · right side: icon buttons **Computer** (monitor icon; only if
     the feature is on) and **Agent** (panel icon), plus an overflow menu with
     Pause/Resume, Pin, Duplicate and Retire. The face and name open the panel. There is
     no more "Agent page" link.
   - **Side panel** (`src/components/agents/agent-panel.tsx`):
     - It uses the chat-view split slot that `CanvasPanel` and the document viewer use,
       with the same column markup, width variable and separator. An open artifact or
       document takes precedence.
     - Below the split breakpoint it is a bottom `Sheet`.
     - It is controlled by the `?agent=now|computer|setup` query param. The header
       buttons set it; closing removes it.
     - It uses `useAgentDetail(agentId)`.
     - Tabs: **Now · Computer · Setup** (`SegmentedControl`, **no count badge**).
   - **Now** (`agent-panel-now.tsx`):
     - **Needs you:** question and approval cards for the agent's live run, using the
       existing Work components.
     - **Working on:** title, plan tally, current action line, "Show in chat" (scrolls to
       the run panel).
     - **Goals:** a compact list with an "achieve" checkbox and an inline "Add goal" input.
     - **Ideas:** Start / Not now.
     - **Next up:** the next 3 routine fires.
     - **Activity:** the last 8 rows, as icon + text. **Remove the tone dots** from
       `agent-activity.tsx`; use glyphs (check, cross, hand, arrow) in muted or attention
       colour.
     - Keep the reflect-on-open call, but only when this tab opens, still not forced.
   - **Computer** (`agent-panel-computer.tsx`). States, plain text:
     - Feature off: the tab is not rendered at all.
     - No computer: "Nova doesn't have a computer yet. With one, it can sign in to sites,
       run code and keep files." **[Give it a computer]**. A confirm dialog explains that
       it runs on your server and that sign-ins persist until reset.
     - `asleep`: the poster image (dimmed) or an empty frame, plus "Asleep. It wakes when
       Nova starts working." **[Wake]**.
     - `resting`: the poster or last frame, plus "Resting. Opens instantly." Opening the
       view unpauses it.
     - `waking`: the frame, plus "Waking up…" with the small thinking orb on the text line.
     - `awake`: the **`ComputerViewer`** client component
       (`src/components/agents/computer-viewer.tsx`). It is the noVNC `RFB` client from
       `@novnc/novnc`:
       - loaded with `next/dynamic` and `ssr: false`, because it touches `window`;
       - version pinned exact; check `npm run security:dependencies`;
       - connected to `relayUrl?t=<token>` with `credentials: { password }`;
       - `viewOnly` true in watch mode (the server enforces it too, through the view-only
         VNC password), `scaleViewport` true, `resizeSession` false;
       - 16:10, fitting the panel width, `translate="no"`.
       Below it: the line "Nova is using it: <usingNow.summary>" or "Idle. Rests after 3
       minutes." **[Take control]** · **[Full screen]**.
     - Control mode: the viewer reconnects with a `control` token and password, a
       plain-text attention line (hand
       icon, accent colour) "You have control. Nova waits until you hand back."
       **[Hand back]**. Hand back posts heartbeat `ended`, and if the agent's run has an
       open question, answers it with "Done. I've finished on your computer; continue."
       through the existing answer route.
     - `error`: "Couldn't reach the computer." **[Try again]** · **[Reset]**.
     - Under the frame, in a disclosure: **Files** (list `/home/agent/work`, download),
       **Reset computer** and **Turn off** (confirm dialogs that say sign-ins and files
       are deleted), and the usage line "Awake 3 h 12 min in total".
     - **Heartbeat** every 20 s while the tab is visible (`document.visibilityState`);
       stop when hidden or unmounted. Re-mint the token and reconnect on a disconnect, a
       409, or when the status comes back to awake. The password lives only in component
       memory, never in the URL, `localStorage` or logs.
     - When the agent's run asks a question while it has a computer, the Now tab's
       question card shows a **Take control** button that opens the Computer tab in
       control mode.
   - **Setup** (`agent-panel-setup.tsx`):
     - A hint line: "You can change any of this by telling Nova in the chat."
     - Rows that show their current value in plain text and expand in place, each with
       its own Save (PATCH, then `announceAgentsChanged()`):
       - Name and role
       - Face (the `FaceBuilder`, compact)
       - Personality (style + brief)
       - Autonomy (3 options with the floor sentence)
       - Apps
       - Computer (the same controls as the Computer tab)
       - Model and effort
       - Notifications (Needs you only / Results / Everything)
       - Suggests ideas
       - Memory (notes: edit, delete, add, download)
       - Routines (pause, delete, "Edit in Automations")
     - Footer: Pause/Resume · Duplicate · Retire (dialog).
2. **`/agents/[id]`:** a server component. It checks ownership, calls `ensureAgentThread`,
   and `redirect`s to `/chat/<conversationId>?agent=<tab>`, where `tab` defaults to
   `now` and `?tab=` maps `profile` to `setup`. Delete the 5-tab page and its arrival
   choreography, and update `tests/voice-persona.test.ts` and `e2e/agents.spec.ts`
   deliberately.
3. **Roster** (`/agents`): a compact list.
   - Each row: face `sm` · name · "role · state sentence" (one line, truncated) · trailing
     hand icon when it needs you · pinned agents first.
   - A row links to the thread.
   - The header keeps `TeamStatus` and adds **New agent**.
   - For the empty state, keep the "first hire" template chips, which now start a chat
     hire (item 4).
4. **Hiring:** `/agents/new`.
   - With `?form=1`, it renders the existing `AgentHire` form, unchanged.
   - Otherwise it renders `AgentStart`: a face preview and the template chips (the 7
     templates plus "Start from scratch").
   - Pressing one POSTs `/api/agents` (`name` = the template's first suggested name, or
     "New agent"; the template's defaults), then `router.push`es to the thread. **A GET
     never creates anything.**
   - In the thread, the empty-state greeting becomes: "Hi, I'm <name>. Tell me what you'd
     like me to take on and I'll set myself up." It has 3 suggestion chips drawn from the
     template, and a "Set up with a form" link to `/agents/new?form=1`.
   - The sidebar's agent rows, the command palette and the roster all link to the
     **thread**. Notification paths stay `/agents/<id>`, which the redirect handles.
5. **Customization** that is visible in the UI: Pin, Duplicate, Notifications and
   Model/effort in Setup. Look changes by chat (§4.6).
6. **Notifications:** respect `Agent.notify` in `src/lib/work/notify/deliver.ts` for
   agent runs:
   - `needs_you`: only questions, approvals and failures;
   - `results`: those plus finished runs (the current behaviour, and the default);
   - `all`: also reflection ideas.

### 4.9 Native (Phase 7; must not block the release)

- **Contract first.** New routes the apps call (`computer`, `computer/view`,
  `computer/heartbeat`, `computer/poster`) must be added to all of:
  - the route set in `tests/agents-contract.test.ts`;
  - `contracts/openapi/juno-native-v1.yaml` (then regenerate the Swift contract, see
    RULES §8, and bump any hard-coded operation counts the tests assert);
  - `contracts/parity/features.json` as `native`.
- **Shared views** (`native/Packages/JunoNativeKit/Sources/JunoWorkKit/Agents/`):
  - `NativeAgentComputerView`: the poster or frame, the plain-text state line, and
    **Wake**, **Watch**, **Take control** and **Hand back**.
  - Watch and control call `POST …/computer/view` with `handoff: true` and open the
    returned one-time `/computer-view?c=…` URL in a sheet with a `WKWebView`
    (`NSViewRepresentable` / `UIViewRepresentable`) modelled on
    `JunoChatKit/NativeArtifactRuntimeWebView.swift`:
    - `.nonPersistent()` store;
    - navigation pinned to the app's own origin;
    - no cookies or bearer injected (the code is the credential, valid 60 s);
    - unloaded on disappear or backgrounding.
  - It is the same viewer as the web, so watch and takeover behave identically.
  - It sits in the agent page's Now tab (Mac and iOS) in place of the "Its computer"
    text feed when the feature is on, keeping the text feed as the fallback.
  - Remove the "Live" word at the Mac "Its computer" heading.
- `NativeRunPresentation.swift`: running and done lines and icons for the five config
  tools and the computer tools. `ApprovalCard.swift` stays generic for `juno_agents`,
  which is fine.
- Refresh the agents model when a turn containing one of the config tools completes, on
  Mac (chat workspace) and iOS (conversations view).
- Gates: RULES §8 native. Never glass on content. 44 pt targets on iOS, 28 pt on Mac.
  `.junoProminent` for primary buttons.

---

## 5. Phases (in order; commit on `agents/v2` at the end of each, gates green)

Write each phase's result, the gate results and any deviations in `PROGRESS.md` before
moving on.

**Phase 1 — Data and provider layer.**
- The migration, `OWNER_COLUMN`, env (RULES §7), `src/lib/computer/{types,provider,fake,docker,remote-browser,live-view,store,sweep}.ts`,
  the infra files from `INFRA.md` in `deploy/agent-computers/`, and `SECURITY.md`.
- Unit tests with the fake provider:
  - lifecycle, including rest, sleep and the missing-container recreate;
  - lease CAS;
  - the caps and the preflight;
  - sweeper decisions, including reconciliation after a reboot;
  - secrets encrypted (assert that the stored value is not the plaintext);
  - "no env = off".
- Also a `DockerProvider` argv test through an injected runner: the exact creation flags,
  and the forbidden flags absent.
- Exit: quick gates, the drift check and `prisma validate` are green.

**Phase 2 — Runner integration.**
- Agent-core: computer tools, the image channel, checkpoint scrubbing, image pruning,
  thinking binding, the `signatureInput` hook, and `VENDORED.md`. Rebuild `dist`.
- Runner: `buildTools` wiring, disposers, lease renewal, sweeper in `tick`, identity in
  runs, the "Your computer" section, billing, targeting.
- Extend `scripts/check-work-sandbox.mjs`. Keep rules 1–4 and add:
  - (5) `computer-tools.ts` and `src/lib/computer/**` must not import `tools/bash`,
    `bashTool`, `node:child_process` or `container-sandbox`, and must not reference
    `ctx.cwd` or `ctx.env`;
  - (6) every tool named `computer_*` is built by `computerTools(`;
  - (7) the `REMOTE_TOOL_NAMES` list is disjoint from the `workspaceTools()` names.
- Tests:
  - a 20-step loop on the fake provider doesn't stall;
  - the checkpoint has no base64;
  - only 3 images are kept;
  - the binding field and beta travel together;
  - a payment page escalates to `work.browser.purchase`;
  - summaries carry no ids or URLs;
  - a busy lease falls back to the temporary browser.
- **Local smoke test on Docker Desktop** (required; it's free).
  1. Build the image: `docker build -t juno-computer:dev deploy/agent-computers`.
  2. Write `scripts/dev/computer-smoke.ts`, run with
     `COMPUTER_PROVIDER=docker COMPUTER_DOCKER_IMAGE=juno-computer:dev NODE_OPTIONS=--conditions=react-server npx tsx scripts/dev/computer-smoke.ts`.
     It must not be run by `npm test`.
  3. The dev containers run on Docker's default network with ports published to
     127.0.0.1. The VM firewall is not part of this test; the owner's setup script
     installs it.
  4. The script must:
     1. create a computer for a fake agent id, and wait for CDP;
     2. connect over CDP and open `https://example.com`;
     3. read the page; take a screenshot (check it is 1280×800); pixel-click the page's
        link; check the URL changed;
     4. set a cookie with an expiry through CDP;
     5. run `exec("uname -a")`, write and read back `/home/agent/work/hello.txt`, and
        check that `../` and `/etc/passwd` are refused;
     6. start x11vnc with two passwords, and confirm the view-only marker syntax with
        `x11vnc -help`;
     7. `pause`, `unpause`, and check the tab is still open;
     8. `stop`, `start`, and check that the cookie **and** the file survived and that
        Chromium is running again;
     9. `destroy`, and check that the container and the volume are gone.
  5. Print **no** tokens or passwords. Record the timings (create, start, stop, pause,
     unpause) and the image size in `PROGRESS.md`.
- Exit: the full gate set (without `next build`) is green.

**Phase 3 — API.**
- The routes in §4.5, CSP, parity classification, PATCH additions, undo, duplicate.
- Tests: ownership (another user's agent id returns 404), feature off returns
  `computer: null`, no AgentEvent, log line or push payload contains a VNC password,
  token, container id or IP. Test the relay token mint and verify with the relay's
  verifier: tamper, expire, wrong mode.
  plus rate limits and path traversal in files.
- Exit: quick gates and `native:sync:check`.

**Phase 4 — Configuration by chat.**
- §4.6 in full: tools, gate, route wiring, `JunoRules`, `actionPreview`, the
  `approval-card` variant, `agentChange` persistence, wire classification, the
  `timeZone` field, prompt changes, recent work, the pause-bug fix.
- Tests (on the model of `tests/chat-task-tool.test.ts` and `chat-handoff-tool.test.ts`):
  - schema shapes (no `additionalProperties`);
  - direct vs card for every field;
  - untrusted turns send everything to the card;
  - private, regenerate and voice turns have no tools;
  - a stale card is refused;
  - undo round-trips;
  - no note text in AgentEvents;
  - `serializeActivity` keeps `agentChange`;
  - the server-only import rule.
- Exit: quick gates and `native:wire:check`.

**Phase 5 — The thread-first UI.**
- §4.8 in full, plus the gallery `src/app/dev/agents-v2/` with fixtures for every state:
  - panel tabs, computer states (poster, resting, waking, awake with the viewer fed by a fake RFB stub, control,
    error, off);
  - change cards (applied, pending, declined, undone);
  - roster, the start page, the onboarding greeting.
- Verify with Playwright and Chrome at 1440 and 390, light and dark. Save the screenshots
  (RULES §9).
- Check each screenshot against the owner's rules in RULES §2 and fix anything that
  breaks them.
- Exit: the full gate set plus `npm run build`.

**Phase 6 — End to end on your machine.**
- With your dev server on :3170 and `.env.local` pointing at a **local** DB only (never
  production), run one real task against a real computer. If you have no local DB, run
  it through the smoke script path instead.
  - If a local Postgres with migrations is not available, write "E2E not run: no local
    DB" in the report. Do **not** point anything at the production DB to get it.

**Phase 7 — Native.**
- §4.9.
- Exit rule: native builds (Mac Debug + Stable, the iOS simulator build) and the package
  tests must pass.
  - If after honest effort they don't, **revert your native source changes**, but keep any
    contract edits the web tests need (the route set only lists routes the Swift client
    actually calls; if you revert the Swift calls, revert those route-set entries too).
  - Record the work as "Native parity deferred" in the final report, and continue. The web
    release must not wait on native.

**Phase 8 — Docs, final gates, land.**
1. **Docs:**
   - Update `docs/design/AGENTS.md`: the reversal of the "clean computer every run" and
     "no shell in the cloud" principles for agents, the new §5 UI, and §8 deferred items.
   - Update `docs/JUNO.md` §9c (+ §19 env rows), `SECURITY.md`, and the header comments
     that say "never a picture" (`NativeAgentGates.swift`, `agent-now.tsx` if still
     present).
   - Add `docs/design/agents-v2/OPERATIONS.md`, covering how to turn it on, the caps, the
     costs, the sweeper, and how to kill everything (`COMPUTER_PROVIDER=off`).
2. `git fetch origin && git merge origin/main`. Resolve conflicts:
   - Resolve them in your own files freely.
   - In shared hot spots (`src/app/api/chat/route.ts`, `src/lib/llm.ts`, `src/types/chat.ts`,
     `src/lib/serializers.ts`, `message-item.tsx`, `chat-view.tsx`, `approval-card.tsx`),
     keep **both** sides' intent.
   - If a conflict is outside those files and outside the agents area, and you can't
     resolve it with certainty, **STOP** (§7).
3. Run the **full gate set** again, plus the drift check and `npm run build`. Then
   `git log -1 --format=%H` → run the Docker gate (RULES §8) on that SHA. It must print
   `GATE PASSED`.
4. `git push origin agents/v2:main`.
   - If it is rejected because main moved: `git fetch origin && git merge origin/main`,
     re-run the quick set plus `work:sandbox:check`, `native:sync:check` and the Docker
     gate on the new SHA, then push again.
   - Never force-push.
5. Confirm with `git fetch origin && git rev-parse origin/main`: it equals your pushed SHA.
6. Write the final report (§6) in `PROGRESS.md` **and** as your last message to the owner.

---

## 6. The final report (your last message, exactly this shape)

```
Agents v2 is on main at <short sha> (<date/time>).

What you get
- <5–8 bullets in plain words: own computer, watch/take over, configure by chat, thread-first UI, customization, native status>

Verified
- Gates: <list, each passed>, Docker deploy gate: GATE PASSED on <sha>
- Local computer smoke (Docker Desktop): <passed with timings / not run: reason>
- UI: screenshots in docs/design/agents-v2/screens/ (<n> files)
- Native: <built and tested / deferred: reason>

Not verified (needs you, signed in)
- <e.g. a real task end to end in production; takeover on iPhone>

Deploy
You can deploy now from your Mac:
  deploy/deploy-from-mac.sh
It runs the new migration <name> (expand-only, safe while the old release serves).
Agent computers stay off and hidden until you do the two steps below.

Turn on agent computers (after the deploy, once your server upgrade is done)
1. One-time server setup (Docker on, isolated network, firewall, image build; ~10 min):
   ssh -i ~/Developer/KEY/chatliamsdev.pem liammgnr@20.91.138.96 'sudo bash ~/juno/current/deploy/agent-computers/setup-vm.sh'
2. Switch them on:
   ssh -i ~/Developer/KEY/chatliamsdev.pem liammgnr@20.91.138.96
   cd ~/juno && ./scripts/set-env-key.sh COMPUTER_PROVIDER --reload      (enter: docker)
Tune the caps later in ~/juno/.env (COMPUTER_MAX_RUNNING_TOTAL, COMPUTER_MEMORY_MB, …).

After deploy
- JUNO_PUBLIC_UI_BASE_URL=https://chat.liams.dev node scripts/public-ui-smoke.mjs
- Open an agent, give it a computer, ask it to open a site, watch it in the side panel,
  then press Take control and hand back.
```

---

## 7. STOP conditions (write the reason in PROGRESS.md, tell the owner, don't push)

- The premium pass is not on main (Phase 0).
- A gate that passed at baseline fails, and the only fixes you can find weaken, skip or
  delete a test or check.
- The migration drift check or `prisma validate` fails and you can't make schema and SQL
  agree.
- A merge conflict outside the agents area can't be resolved with certainty.
- You would need to change a rule in RULES.md, touch the production DB, deploy, create
  an account, or push somewhere other than `origin main` or your own branch.
- The Docker gate does not print `GATE PASSED` on the SHA you're about to push.
