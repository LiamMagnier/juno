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
3. **Watch it work on its own computer.** In the side panel, a real Ubuntu desktop with
   Chrome, where the agent browses, clicks, types, runs commands and keeps files.
   Logins persist between tasks. The computer sleeps when idle and wakes when needed.
4. **Take over** for a login, 2FA or CAPTCHA, then hand back. The agent never sees the
   secret.
5. **See what happened.** The agent's next reply knows what its last tasks produced.
6. Find everything on one condensed screen: **the agent's thread + a side panel (Now ·
   Computer · Setup)**.

Also:
- Everything is off, and invisible, until the owner sets `COMPUTER_PROVIDER=e2b` and
  `COMPUTER_E2B_API_KEY` on the VM.
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
5. Check whether `COMPUTER_E2B_API_KEY` is set, in `.env.local` or the environment. Do
   not print it: `node -e 'console.log(!!process.env.COMPUTER_E2B_API_KEY)'` after
   loading env, or `grep -c '^COMPUTER_E2B_API_KEY=.' .env.local`.
   - If it is set, you will run the live E2B smoke test in Phase 2.
   - If not, build everything against the fake provider, and mark the live test
     "not run: no key" in the final report. **Do not** stop for this.
6. Read, at least:
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
| D1 | **One persistent cloud computer per agent**, on **E2B Desktop** (`@e2b/desktop`, Ubuntu 22.04 + XFCE + Chrome + x11vnc + noVNC). Never shared between agents or users. It is created lazily, sleeps (E2B `pause`, which keeps memory, disk and logins) when idle, wakes (`Sandbox.connect`) on demand, and is destroyed on reset, retire, disable, account deletion or after `COMPUTER_RETENTION_DAYS` asleep. This deliberately reverses AGENTS.md's "clean computer every run" at the owner's request. Update the docs (Phase 8). |
| D2 | **No second runtime.** Agent work still runs as Work runs in `juno-work` (`scripts/work-runner.ts`). The computer is a set of tools that run's `buildTools` attaches when the run's session has an `agentId` whose computer is enabled. Plain Work runs with no agent stay exactly as they are. |
| D3 | **The existing `browser` tool drives the agent's own Chrome** over CDP when a computer is attached: same tool name, same risk ladder, same purchase floor, but real, persistent, visible, with images loaded. No request interception: egress leaves from E2B's network, not the VM. Pixel tools (`computer_*`), shell and files are added beside it. |
| D4 | **Configuration by chat** is five native chat tools: `create_agent`, `update_agent`, `agent_goal`, `agent_routine`, `agent_memory`. Direct changes apply at once, with an Undo card. Widening changes go through the existing chat approval broker (`authorizeExternalAction`, connector id `juno_agents`) as a card. Forms remain as a secondary path. |
| D5 | **The thread is the agent's home.** `/agents/[id]` becomes a redirect to the thread with the side panel open. The side panel has three tabs: **Now · Computer · Setup**. The roster becomes a compact list. Hiring is a conversation; the old form lives at `/agents/new?form=1`. |
| D6 | **Screenshots reach the model** through a structured image channel in agent-core. The untrusted envelope stays around the text. Images are stripped from checkpoints. Only the last 3 are kept in context, which is made safe by porting the Mac client's thinking `drop_block` binding to agent-core's Anthropic provider. |
| D7 | **Computer time counts against the account's existing usage windows** (`COMPUTER_COST_MICRO_USD_PER_SECOND`). There are caps on awake computers per account and in total. There is no new budget system. |
| D8 | Native (Mac and iPhone) gets **watch and take over** of the computer, plus labels for the new chat tools. This happens in Phase 7 and **must not block** the web release (see Phase 7's exit rule). |
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
/// An agent's own cloud computer. One per agent, never shared. The provider's
/// sandbox is created lazily; `sandboxRef` is null until first use.
model AgentComputer {
  id             String    @id @default(cuid())
  userId         String
  agentId        String    @unique
  provider       String                       // "e2b" | "fake"
  sandboxRef     String?   @db.Text           // encryptSecret(provider sandbox id)
  secrets        String?   @db.Text           // encryptSecret(JSON {cdpToken, vncControl, vncView})
  status         String    @default("asleep") // asleep | waking | awake | error
  streamOn       Boolean   @default(false)
  leaseRunId     String?
  leaseExpiresAt DateTime?
  lastResumedAt  DateTime?
  lastActiveAt   DateTime?
  lastViewedAt   DateTime?
  activeSeconds  Int       @default(0)        // lifetime awake seconds, for the UI
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
- Add a `SECURITY.md` row: `AgentComputer.sandboxRef` and `.secrets` use `encryptSecret`.
- A row existing means the computer is **enabled**. Disabling deletes the row, after
  destroying the sandbox.
- `AgentEvent.detail` keeps its JSON shape. Undo data goes in it as `detail.before` and
  `detail.after`. It holds only field values, never note text: notes use `noteId`
  references, because note text is encrypted and must never be copied into the log.

### 4.2 The computer provider layer (`src/lib/computer/`, all `import "server-only"`)

```ts
// src/lib/computer/types.ts
export type ComputerStatus = "asleep" | "waking" | "awake" | "error";
export interface Shot { mediaType: "image/jpeg"; data: string /* base64 */; width: number; height: number }
export interface ExecResult { stdout: string; stderr: string; exitCode: number; timedOut: boolean }
export interface ComputerHandle {
  readonly sandboxId: string;                       // never leaves the server
  screenshot(): Promise<Shot>;                      // JPEG q70, NOT resized (coordinates stay 1:1)
  click(x: number, y: number, button?: "left" | "right" | "double"): Promise<void>;
  move(x: number, y: number): Promise<void>;
  drag(from: [number, number], to: [number, number]): Promise<void>;
  scroll(direction: "up" | "down", amount: number): Promise<void>;
  type(text: string): Promise<void>;
  key(keys: string): Promise<void>;                 // "enter", "ctrl+l", "Tab"
  exec(cmd: string, opts: { timeoutMs: number; cwd?: string }): Promise<ExecResult>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  listFiles(path: string): Promise<Array<{ name: string; path: string; type: "file" | "dir"; size?: number }>>;
  keepAlive(ms: number): Promise<void>;             // sandbox.setTimeout
  host(port: number): string;                       // e.g. "6080-<id>.e2b.app"
}
export interface ComputerProvider {
  readonly id: "e2b" | "fake";
  create(meta: { userId: string; agentId: string }): Promise<ComputerHandle>;
  connect(sandboxId: string): Promise<ComputerHandle | null>; // resumes a paused one; null if it no longer exists
  pause(sandboxId: string): Promise<void>;
  destroy(sandboxId: string): Promise<void>;
  listOwned(): Promise<Array<{ sandboxId: string; agentId?: string; userId?: string; state: "running" | "paused" }>>;
}
```

**Files:**
- `provider.ts`: `computerProvider()` returns the configured provider or `null`.
  - It reads the env via `src/lib/env.ts`.
  - `fake` is refused in production.
  - `isAgentComputerConfigured()` is the one switch every caller checks.
- `e2b.ts`: `E2BProvider`, on `@e2b/desktop`.
  - **Pin exact versions**: `npm install --save-exact @e2b/desktop@2.4.0` (it pulls
    `e2b`). If a newer patch exists, read its changelog first.
  - **Read the installed `.d.ts` files** under `node_modules/@e2b/desktop/dist` and
    `node_modules/e2b/dist` before writing a line, and use only APIs that exist there.
    The mentor's research of the Sept 2026 API follows. Verify every item:
    - `Sandbox.create(template, { apiKey, resolution: [1280, 800], dpi: 96, timeoutMs: 600_000, metadata: { app: "juno", userId, agentId }, lifecycle: { onTimeout: "pause", autoResume: false } })`
    - `Sandbox.connect(id, { apiKey, timeoutMs: 600_000 })`: resumes a paused sandbox. **Always pass `timeoutMs`.** A missing sandbox throws; map that to `null`.
    - `sbx.pause()`, not the deprecated `betaPause()`. `sbx.kill()`, `sbx.setTimeout(ms)`, `sbx.getHost(port)`.
    - `sbx.screenshot()` returns PNG bytes. Convert with `sharp` (already a dependency) to JPEG quality 70 **without resizing**.
    - `leftClick(x, y)`, `rightClick`, `doubleClick`, `moveMouse`, `drag([x,y],[x,y])`, `scroll("down", n)` (the current signature is `(direction, amount)`, whatever the README says), `write(text)`, `press(key | key[])`.
    - `sbx.commands.run(cmd, { timeoutMs, cwd, user, envs, background })`. Background daemons need `{ background: true, timeoutMs: 0 }`.
    - `sbx.files.read(path, { format: "bytes" })`, `files.write(path, data)`, `files.list(path)`.
    - `Sandbox.list({ apiKey, query: { metadata: { app: "juno" } } })`: a paginator (`nextItems()`, `hasNext`).
- `fake.ts`: an in-memory `FakeProvider` for tests and the dev gallery.
  - It returns a fixed 1280×800 grey JPEG.
  - It records calls and supports pause/connect/destroy state.
  - It keeps an in-memory filesystem.
- `boot.ts`: `ensureServices(handle, secrets)`, run after every create **and every
  resume**. It is idempotent: check with `pgrep` before starting anything.
  1. As root, write `/etc/opt/chrome/policies/managed/juno.json`, which stops Chrome saving
     passwords or cards:
     `{"PasswordManagerEnabled":false,"AutofillCreditCardEnabled":false,"AutofillAddressEnabled":false,"DefaultBrowserSettingEnabled":false}`
  2. As root, write the CDP token to `/etc/juno/cdp-token` (mode 0600, root) and the gate
     script (below) to `/etc/juno/cdp-gate.py`. Start it as root in the background if
     `pgrep -f cdp-gate.py` finds nothing.
  3. As `user`, if `pgrep -f "remote-debugging-port=9223"` finds nothing, start Chrome
     on the visible display in the background:
     `google-chrome --remote-debugging-port=9223 --user-data-dir=/home/user/.juno-chrome --no-first-run --no-default-browser-check --start-maximized about:blank`
     with `envs: { DISPLAY: ":0" }`. Then wait up to 10 s for
     `curl -s http://127.0.0.1:9223/json/version` to answer.
  4. `mkdir -p /home/user/work`.
- `cdp-gate.py`: the **only** way into Chrome from outside. It checks a secret header,
  accepts WebSocket upgrades only, and rewrites `Host`. Ship it verbatim as a string
  constant in `boot.ts`:

```python
#!/usr/bin/env python3
# Juno CDP gate: exposes Chrome's loopback DevTools socket to Juno's worker only.
import hmac, socket, threading
TOKEN = open("/etc/juno/cdp-token", "rb").read().strip()
def pipe(a, b):
    try:
        while True:
            d = a.recv(65536)
            if not d:
                break
            b.sendall(d)
    except OSError:
        pass
    finally:
        for s in (a, b):
            try: s.shutdown(socket.SHUT_RDWR)
            except OSError: pass
def handle(c):
    try:
        c.settimeout(10)
        head = b""
        while b"\r\n\r\n" not in head:
            d = c.recv(4096)
            if not d or len(head) > 65536:
                c.close(); return
            head += d
        c.settimeout(None)
        h, _, rest = head.partition(b"\r\n\r\n")
        lines = h.split(b"\r\n")
        ok = False; upgrade = False; out = [lines[0]]
        for line in lines[1:]:
            k, _, v = line.partition(b":")
            key = k.strip().lower()
            if key == b"x-juno-cdp-token":
                ok = hmac.compare_digest(v.strip(), TOKEN); continue
            if key == b"upgrade" and v.strip().lower() == b"websocket":
                upgrade = True
            if key == b"host":
                out.append(b"Host: 127.0.0.1:9223"); continue
            if key == b"origin":
                continue
            out.append(line)
        if not (ok and upgrade):
            c.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            c.close(); return
        u = socket.create_connection(("127.0.0.1", 9223))
        u.sendall(b"\r\n".join(out) + b"\r\n\r\n" + rest)
        threading.Thread(target=pipe, args=(u, c), daemon=True).start()
        pipe(c, u)
    except OSError:
        try: c.close()
        except OSError: pass
srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("0.0.0.0", 9222)); srv.listen(64)
while True:
    conn, _ = srv.accept()
    threading.Thread(target=handle, args=(conn,), daemon=True).start()
```

- `remote-browser.ts`: `connectAgentBrowser(handle, secrets)`.
  1. Discover the browser WebSocket path **inside** the VM with
     `exec("curl -s http://127.0.0.1:9223/json/version")` and parse `webSocketDebuggerUrl`.
  2. Connect with
     `chromium.connectOverCDP("wss://" + handle.host(9222) + path, { headers: { "X-Juno-Cdp-Token": secrets.cdpToken }, timeout: 20_000 })`,
     using `playwright`, which is already a runtime dependency.
  3. Use `browser.contexts()[0]`, the persistent profile. **Never** call `context.close()`
     on it.
  4. When done, call `browser.close()`. For a CDP connection this only disconnects.
     **Verify in the live smoke test** that Chrome is still running afterwards.
  5. Implement the agent-core `BrowserToolDeps` interface, the seam `browserTool(deps)`
     already takes, over this page. Actions follow the newest page, and call
     `page.bringToFront()` so the live view shows what the agent does.
  6. **Reuse, don't copy,** the snapshot, ref, `submitsForm`, `pageTakesPayment` and act
     logic of `src/lib/work/browser.ts`. Extract the page-level helpers into
     `src/lib/work/browser-page.ts` so that both `createWorkBrowser` (local, unchanged
     behaviour) and the remote browser use them.
     - `tests/work-browser.test.ts` must pass **unchanged**.
     - If extraction proves risky, stop extracting and call the same helpers through a
       small adapter. Never change the local browser's behaviour.
  7. The remote browser loads images, fonts and media; it is a real browser. It keeps
     the structural "click on a form submit is refused; use submit" rule, the risk
     ladder and purchase detection. The checks before `open` (`blockedFetchTarget` and
     the skill egress grant) already sit in the tool layer and still apply.
- `stream.ts`: the live view.
  - **Do not** use the SDK's `stream.start()`. Its single password makes view-only
    client-side. Instead:
    - `startStream(handle)`: generate `vncControl` and `vncView`, each 8 random
      characters (VNC uses only the first 8 characters). Write
      `/home/user/.juno/vncpass` (0600) as `"<control>\n__BEGIN_VIEWONLY__\n<view>\n"`.
      Kill any running `x11vnc` or noVNC proxy. Start
      `x11vnc -bg -display :0 -forever -shared -wait 50 -rfbport 5900 -passwdfile /home/user/.juno/vncpass -o /tmp/x11vnc.log`,
      then the noVNC proxy on port 6080 in the background (`timeoutMs: 0`).
    - **Copy the exact noVNC command and path from the installed `@e2b/desktop`
      source** (`dist`, search `novnc_proxy`), including its working directory.
    - Save the passwords with `encryptSecret`, and set `streamOn = true`.
    - `stopStream(handle)` kills both processes and sets `streamOn = false`. Stopping
      rotates the passwords on the next start.
    - `viewerUrl(handle, mode, secrets)` returns
      `https://${host(6080)}/vnc.html#autoconnect=true&resize=scale&reconnect=true&view_only=${mode === "watch" ? 1 : 0}&password=${mode === "watch" ? vncView : vncControl}`.
      The password goes in the **fragment**, never the query.
- `store.ts` (`server-only`): the only module that reads or writes `AgentComputer`. It
  holds the lifecycle functions in §4.3.

### 4.3 Lifecycle, leases, sleep, sweep (`src/lib/computer/store.ts`, `sweep.ts`)

- `enableComputer(userId, agentId)` creates the row (`status: "asleep"`, no sandbox). It
  refuses if the feature is off.
- `ensureAwake(userId, agentId, reason)`:
  1. Check caps (§4.8) and the usage windows (`checkUsageWindows`; reuse whatever Work
     dispatch calls).
  2. `status = "waking"`.
  3. `connect(sandboxRef)`, or `create` if there is no ref or `connect` returned `null`.
     In that case also clear the secrets, generate a new `cdpToken`, and record an
     AgentEvent `computer_recreated`: "Its computer was lost and has been replaced;
     sign-ins are gone."
  4. `ensureServices`.
  5. `status = "awake"`, `lastResumedAt = lastActiveAt = now`.
  6. On error: `status = "error"`, `lastError` set to a **sentence with no ids or URLs**.
- `sleepComputer(userId, agentId)`:
  1. `stopStream`.
  2. Take a poster: `screenshot()`, then `putObject` under
     `agent-computers/<userId>/<agentId>/poster.jpg`. Use the storage helper the Work
     runner uses (`@/lib/storage`).
  3. `provider.pause`.
  4. Add `now - lastResumedAt` to `activeSeconds` and **bill it** (§4.8).
  5. `status = "asleep"`.
- `resetComputer` / `disableComputer` / on retire: `destroy` the sandbox, clear the ref
  and secrets, and delete the row (disable) or keep it asleep (reset). Delete the poster.
  Record an AgentEvent.
- **Run lease:** `acquireComputerLease(agentId, runId, ttlMs = 120_000)`.
  - It is one conditional `updateMany` where `leaseRunId` is null, or equals `runId`, or
    `leaseExpiresAt < now`, and it checks the count.
  - `renewComputerLease` runs on the Work run's existing lease-renewal timer (every 40 s)
    and also calls `handle.keepAlive(600_000)`.
  - `releaseComputerLease` sets `lastActiveAt = now`. It **does not** sleep the computer;
    the sweeper does that.
- **Sweeper** (`sweepAgentComputers()` in `sweep.ts`), called from the Work runner's
  `tick()` at most once every 60 s, with no new PM2 app. It:
  1. Sleeps every `awake` computer with no valid lease whose
     `max(lastActiveAt, lastViewedAt)` is older than `COMPUTER_IDLE_PAUSE_SECONDS`.
  2. Stops the stream on awake computers with `streamOn` and no view heartbeat for 60 s.
  3. At most every 6 h, lists `listOwned()`:
     - kills sandboxes with no matching row, which covers deleted agents and deleted
       accounts;
     - destroys computers asleep longer than `COMPUTER_RETENTION_DAYS`;
     - resets any `waking` status stuck for more than 3 min to `error`.

  Every step is try/catch-per-item and logs without ids or URLs.
- **E2B's 1-hour continuous cap (Hobby)** and surprise pauses: every handle call goes
  through a wrapper. If the SDK reports the sandbox as paused or not running, it calls
  `connect()` once and retries the call once. The user sees at most a brief reconnect of
  the live view.

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
     kills or pauses the sandbox**. The same disposer runs on park or pause.
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
| `computer_files` | `{ action: list\|read\|write, path, content? }` (paths under `/home/user` only) | `shell` | `files.read` / `files.write` | `work.computer.files` | read `safe`, write `edit` |

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
  `Run: npm test (in /home/user/work)`. This is the only thing an approval card shows.
  It never contains ids or URLs with tokens.
- `provenanceFor`:
  - `source: "the agent's computer"`;
  - `sourceKind: "web"` for pixel and browser actions, `"local_app"` for shell and files;
  - `trust: "untrusted"` for **every** output.
- `isHealthy()` returns the handle's last known state.
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

> You have your own computer: an Ubuntu desktop with Chrome, a shell and files. The
> `browser` tool drives its Chrome, and the person can watch the same screen. Prefer
> `browser` for web pages. Use the `computer_*` pixel tools only for things the page
> tools can't reach. Keep files you want to keep under /home/user/work. Stay signed in to
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
| `POST /api/agents/[id]/computer/view` | `{ mode: "watch" \| "control" }` → `{ url, mode }`. Requires `awake` (otherwise 409 `{ error: "asleep" }`). Starts the stream if it is off. `control` records AgentEvent `takeover_started`. Rate limit 60/h. `Referrer-Policy: no-referrer`. |
| `POST /api/agents/[id]/computer/heartbeat` | `{ mode, ended?: boolean }`. Updates `lastViewedAt` and returns the status. `ended` with `mode: "control"` records `takeover_ended` and **restarts the stream** (rotating passwords) so the control URL dies. Rate limit 10/min. |
| `GET /api/agents/[id]/computer/poster` | The last-frame JPEG (owner-scoped read from storage), `Cache-Control: private, no-store`. |
| `GET /api/agents/[id]/computer/files?path=` | Lists a directory under `/home/user` (awake only). `&download=1` on a file streams it (≤25 MB, `Content-Disposition: attachment`). Refuse `..`, symlinks out of `/home/user` and absolute paths elsewhere. |
| `POST /api/agents/[id]/undo` | `{ eventId }`. Applies `detail.before` from that AgentEvent if it belongs to this agent and user and has not been undone; marks `detail.undoneAt`. Returns `{ agent }`. |
| `POST /api/agents/[id]/duplicate` | Copies profile, face, style, brief, autonomy, apps, model and active goals. Never copies notes, the computer, routines or the thread. Named "<name> 2". Returns 201 `{ agent }`. Respects the 24-agent cap. |

Other changes:
- Extend `PATCH /api/agents/[id]`: optional `notify` and `pinned: boolean`, both
  additive. `pinned: true` sets `pinnedAt` and the roster sorts pinned first.
- `GET /api/agents` and `GET /api/agents/[id]` gain optional keys:
  - `notify`, `pinnedAt`;
  - `computer: { enabled, status } | null`;
  - `recentChanges` is **not** needed.
- CSP (`src/lib/csp.ts`):
  - Add an **option** `liveViewFrameOrigins` to `buildCsp`, appended to `frame-src` only
    when passed.
  - `src/middleware.ts` passes it from a constant in a new, dependency-free
    `src/lib/live-view-origins.ts`: `["https://*.e2b.app"]`.
  - **Check the host the SDK returns** from `getHost()` in the live test. If it is
    `e2b.dev`, use that instead.
  - Add a `tests/csp.test.ts` case for the option. The existing exact-match assertions
    must stay green because they don't pass the option.

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

- **Awake computers:** ≤ `COMPUTER_MAX_RUNNING_PER_USER` (2) per account and ≤
  `COMPUTER_MAX_RUNNING_TOTAL` (10) overall. The count is `status in (awake, waking)`.
  - Waking beyond a cap refuses with "Two of your agents' computers are already awake.
    Stop one or wait for it to sleep."
  - A run that can't get a computer falls back to the temporary browser (§4.4).
- **Sleep** after `COMPUTER_IDLE_PAUSE_SECONDS` (180) with no lease and no viewer.
- **Retention:** destroy after `COMPUTER_RETENTION_DAYS` (30) asleep. The UI says, in
  Setup: "Asleep more than 30 days: its sign-ins and files are cleared."
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
       time counts toward usage and that sign-ins persist until reset.
     - `asleep`: the poster image (dimmed) or an empty frame, plus "Asleep. It wakes when
       Nova starts working." **[Wake]**.
     - `waking`: the frame, plus "Waking up…" with the small thinking orb on the text line.
     - `awake`: an `<iframe>` of the watch URL at 16:10, fitting the panel width, with
       `referrerPolicy="no-referrer"`, no `sandbox` attribute, `allow="clipboard-read;
       clipboard-write"` and `translate="no"`. Below it: the line "Nova is using it:
       <usingNow.summary>" or "Idle. Sleeps after 3 minutes." **[Take control]** ·
       **[Full screen]**.
     - Control mode: the iframe re-minted in `control`, a plain-text attention line (hand
       icon, accent colour) "You have control. Nova waits until you hand back."
       **[Hand back]**. Hand back posts heartbeat `ended`, and if the agent's run has an
       open question, answers it with "Done. I've finished on your computer; continue."
       through the existing answer route.
     - `error`: "Couldn't reach the computer." **[Try again]** · **[Reset]**.
     - Under the frame, in a disclosure: **Files** (list `/home/user/work`, download),
       **Reset computer** and **Turn off** (confirm dialogs that say sign-ins and files
       are deleted), and the usage line "Awake 3 h 12 min in total".
     - **Heartbeat** every 20 s while the tab is visible (`document.visibilityState`);
       stop when hidden or unmounted. Re-mint the URL on a 409 or when the status comes
       back to awake.
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
  - Watch and control open a sheet with a `WKWebView` (`NSViewRepresentable` /
    `UIViewRepresentable`) modelled on `JunoChatKit/NativeArtifactRuntimeWebView.swift`:
    `.nonPersistent()` store, navigation pinned to the minted host, no cookies or bearer
    injected, unloaded on disappear or backgrounding.
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
- The migration, `OWNER_COLUMN`, env (RULES §7), `src/lib/computer/{types,provider,fake,e2b,boot,stream,remote-browser,store,sweep}.ts`,
  and `SECURITY.md`.
- Unit tests with the fake provider: lifecycle, lease CAS, the caps, sweeper decisions,
  secrets encrypted (assert that the stored value is not the plaintext), and
  "no env = off".
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
- **Live smoke test (if you have the key):** `scripts/dev/computer-smoke.ts`, run with
  `NODE_OPTIONS=--conditions=react-server npx tsx scripts/dev/computer-smoke.ts`. It must
  not be run by `npm test`. It must:
  1. create a computer for a fake agent id;
  2. run `ensureServices`;
  3. connect over CDP and open `https://example.com`;
  4. read the page and take a screenshot;
  5. run `exec("uname -a")`;
  6. start the stream and print **only the hostname** of the viewer URL (not the password);
  7. pause, reconnect, and check that the example.com tab is still open and Chrome is
     still running;
  8. `destroy`.

  Record the timings (create, pause, resume) and the real `getHost` domain in
  `PROGRESS.md`. Fix the CSP constant if the domain differs.
- Exit: the full gate set (without `next build`) is green.

**Phase 3 — API.**
- The routes in §4.5, CSP, parity classification, PATCH additions, undo, duplicate.
- Tests: ownership (another user's agent id returns 404), feature off returns
  `computer: null`, no route response or AgentEvent contains `password=` or a sandbox id,
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
  - panel tabs, computer states (poster, waking, awake with a stubbed iframe, control,
    error, off);
  - change cards (applied, pending, declined, undone);
  - roster, the start page, the onboarding greeting.
- Verify with Playwright and Chrome at 1440 and 390, light and dark. Save the screenshots
  (RULES §9).
- Check each screenshot against the owner's rules in RULES §2 and fix anything that
  breaks them.
- Exit: the full gate set plus `npm run build`.

**Phase 6 — End to end on your machine (if you have the key).**
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
- Live E2B smoke: <passed with timings / not run: no key>
- UI: screenshots in docs/design/agents-v2/screens/ (<n> files)
- Native: <built and tested / deferred: reason>

Not verified (needs you, signed in)
- <e.g. a real task end to end in production; takeover on iPhone>

Before you deploy (only if you want agent computers on)
1. Create an E2B account at e2b.dev and copy an API key (Hobby is free with $100 credit).
2. On the VM: ssh in, cd ~/juno, then run
   ./scripts/set-env-key.sh COMPUTER_PROVIDER      (enter: e2b)
   ./scripts/set-env-key.sh COMPUTER_E2B_API_KEY   (paste the key)
Without these, everything else ships and the computer stays hidden.

Deploy
You can deploy now from your Mac:
  deploy/deploy-from-mac.sh
It runs the new migration <name> (expand-only, safe while the old release serves).

After deploy
- JUNO_PUBLIC_UI_BASE_URL=https://chat.liams.dev node scripts/public-ui-smoke.mjs
- Open an agent, give it a computer, ask it to open a site, watch it in the side panel.
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
