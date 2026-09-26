# Agents v2 — rules, environment and gates (read before touching anything)

These rules come from the owner, from the repo's own gates, and from mistakes earlier
sessions actually made. **A rule here overrides your own judgement.** When a rule and
the brief seem to disagree, the rule wins. Stop and write the conflict in `PROGRESS.md`.

---

## 1. Where you work

- **Your worktree:** `/Users/liammagnier/Developer/project/juno-agents`, on branch
  `agents/v2`. Do everything there.
- **Never touch** `/Users/liammagnier/Developer/project/juno`, the main checkout.
  Several other AI sessions work there, with uncommitted work of their own. Also never
  touch any other `juno-*` worktree. Never run `git checkout`/`switch`/`reset` in them.
- Never `git push --force`. Never `git add -A` or `git add .`: stage the files you
  changed by name, and check `git status` before every commit.
- Commit on `agents/v2` at the end of every step that leaves the gates green. Use short
  imperative subject lines like the repo's history, for example "Give each agent its own
  computer: provider layer and data". End every commit message with:
  `Co-Authored-By: Gemini 3.8 Flash <noreply@google.com>`.
- **The shell is zsh.**
  - `status` is a read-only variable: use `rc=$?`.
  - Globs that match nothing are errors.
  - `$var` does not word-split.
  - `"$sha:r..."` is a zsh modifier: write `"${sha}:refs/heads/main"`.

  For anything longer than one line, write a script file and run it with `bash file.sh`.
  `/bin/bash` is 3.2, so use no bash-4 features.
- **Never deploy.** Do not run `deploy/deploy-from-mac.sh`, `deploy/deploy.sh`, `ssh`,
  `scp`, `pm2`, or anything against the VM. The owner deploys.
- **Never use the repo `.env`**, if one exists: it points at the **production database**.
  Never run `prisma migrate dev`, `prisma db push`, `prisma migrate deploy` or any
  writing script against it.
  - For dev env, symlink the main checkout's `.env.local`:
    `ln -s /Users/liammagnier/Developer/project/juno/.env.local .env.local`
  - For migrations, use the throwaway Postgres in §6.
- **Never print, log or commit a secret.** `COMPUTER_E2B_API_KEY` lives only in
  `.env.local` or the environment. The pre-commit hook refuses `.env*` files.
- Do not create accounts. Do not sign in to anything. Do not buy anything. The one real
  external service you may call is **E2B**, with the owner's key, for the live smoke
  test in Phase 2. That creates and kills a sandbox and costs cents.

## 2. The owner's design rules (web, Mac, iOS)

1. **No status pills, badges, capsules or status dots, anywhere.** That covers
   "Live", "Active", "Running", "Awake", "Connected", "Online", "Working", "Done",
   "Recommended", count badges on tabs, and pulsing or coloured dots.
   - Normal states: plain text, or nothing.
   - In-progress states: quiet text, optionally with the small thinking orb on the text line.
   - Attention states (needs you, failed): colour + icon as plain text, never in a container.
2. **Mac/iOS:** native Liquid Glass for **chrome only** (toolbars, sheets, menus,
   popovers, system button styles). Never on rows, cards, messages or content.
   - `scripts/check-native-glass.mjs` enforces this. It forbids glass in
     `native/Packages/**` except six allow-listed files.
   - Agent buttons use `.buttonStyle(.junoProminent)`.
   - Never fake glass with blur or Material rectangles.
3. **Copy:**
   - No em dashes (—) in visible text.
   - No "seamless", "elevate" or "unleash".
   - Button labels are 1–3 words, one label per intent.
   - Sentence case. No eyebrow labels above headings.
4. **Tokens only.**
   - No hex or rgb colours in components.
   - Use `text-caption/label/ui/body/...`, never `text-sm` or `text-[13px]`.
   - Radii from the scale (`rounded-sm/xs/md/control/field/menu/card/panel/stage/full`), never `rounded-[Npx]` or bare `rounded`.
   - `z-popper/z-modal/z-toolbar/z-toast` for high stacking.
   - Icons only from `@/components/ui/icons`, never `lucide-react` or phosphor directly. These are ESLint errors.
5. **Motion:** only for real live state. Only `transform` and `opacity` animate. Honour
   reduced motion. No infinite decorative loops.
6. The face (`AgentFace`) is the agent's status display. Always say the state in words
   next to it too.

## 3. Security invariants (the reviewer will check each one)

1. **One computer per agent.** A sandbox is never shared between agents or users. Every
   lookup is server-side from `(userId, agentId)`. Never accept a sandbox id from the
   model, the client or a URL.
2. **The provider key, the sandbox id, the CDP token and both VNC passwords stay server-side**:
   - encrypted at rest with `encryptSecret` (`@/lib/crypto`);
   - never in logs, WorkEvents, AgentEvents, push or inbox payloads, tool output, the
     model's context, or `provenance.source`/`summary`.
   - A viewer URL is minted per request (`Cache-Control: no-store`,
     `Referrer-Policy: no-referrer`), carries the password in the **URL fragment**, and
     is never stored.
3. **Watch mode is view-only on the server.** It uses the separate view-only VNC
   password; it never relies on noVNC's `view_only` flag alone. Control mode is minted
   only on an explicit click, records an AgentEvent, and rotates the passwords when it ends.
4. **Screens are untrusted content.** Never mark a screenshot or page text as trusted.
   Images travel through the structured image channel (BRIEF §4.4) while the text stays
   in the untrusted envelope.
5. **Nothing widens without the owner's press on a deterministic card.** "Widens" means:
   - autonomy up;
   - adding apps;
   - turning the computer on;
   - resetting it;
   - creating or resuming an unattended routine;
   - changing the model or effort;
   - **any** configuration change requested in a turn that read outside content.

   A card's text is written by the server, never by the model.
6. **The approval floor stays**: send, publish, pay or purchase, delete, and
   account/security settings ask under every autonomy level. A pixel click or Enter on a
   page that takes payment is the existing always-confirm action `work.browser.purchase`.
7. **Budget binds the computer.** Computer time counts in the account's 5-hour and weekly
   windows. There is no second budget. There are caps on running computers (BRIEF §4.8).
8. **The feature is off unless configured.** With no `COMPUTER_PROVIDER=e2b` +
   `COMPUTER_E2B_API_KEY`:
   - computer tools are never registered;
   - the computer API returns `{ computer: null }`;
   - the Computer tab is hidden;
   - every test passes with **zero env vars**.
9. Do not weaken, skip or delete any existing test or gate to get green. **Extend**
   `scripts/check-work-sandbox.mjs`; never relax it. If a pinned source-regex test breaks
   because you changed the line it pins **on purpose**, update that test's expectation in
   the same commit and say so in the commit message.

## 4. Additive-only contracts (shipped Mac/iPhone apps must keep working)

- **Prisma:** new tables and new nullable or defaulted columns only. No renames, drops,
  or NOT NULL without a default. Details in §6.
- **API:** only new routes and new optional response keys. Never rename or remove keys,
  never change a method, never make a zod schema `.strict()`, never add a required
  field to an existing request schema. The roster decode on native is all-or-nothing: every
  `ClientAgent` must keep `id`, `name`, `createdAt` and `updatedAt`.
- **Do not add:**
  - `AGENT_STATES` values;
  - face vocabulary (shapes, tones, eyes, marks);
  - Work event kinds;
  - Work degradation kinds;
  - capabilities;
  - chat `StreamChunk` types;
  - `ActivityKind` values.

  New data travels as **optional fields on existing payloads**. (New *action names*
  such as `work.computer.click` are fine. They are not contract vocabulary.)
- New `AGENT_EVENT_KINDS` values are fine: it is an open vocabulary on native.
- Every new `src/app/api/**/route.ts` or `(app)/**/page.tsx` must be classified in
  `contracts/parity/features.json`, then `npm run native:parity`.
- Every new chat request field or `ClientActivityEvent` key must be classified in
  `contracts/chat/juno-chat-wire-v1.status.json`, then `npm run native:wire`.
- `/agents/<id>` must keep resolving. Native push paths use it.

## 5. Code conventions that bite

- Next 15: route `params` is a `Promise`, so `await params`.
- Every route:
  - `export const runtime = "nodejs"`;
  - `requireUser` from `@/lib/code-remote`;
  - `schema.safeParse(await req.json().catch(() => null))`;
  - errors as `{ error: "snake_code", message: "Sentence." }`;
  - `rateLimit` from `@/lib/rate-limit` on anything that costs money.
- Zod is v4 (`z.int()`, `z.iso.datetime()`). React 19.
- `server-only` modules (the store, `action-approval-store`, `llm`, `crypto`, `prisma`,
  your computer provider) must never be imported by a client component. Inside chat-tool
  modules they are loaded with **`await import()`**, never statically. A test enforces this.
- `tsconfig` has `noUnusedLocals`, so an unused import is a **typecheck error**.
- **Tests:**
  - Top-level `tests/<name>.test.ts` (the glob is not recursive).
  - Use `node:test` + `node:assert/strict` and `@/` imports.
  - They run with no env, no DB, no network.
  - A test may not import a module that imports `server-only`. Pin such modules as
    source text instead, as the existing tests do.
  - Gate `mock.module` with `canMockModules ? test : test.skip`.
- **`runner/agent-core` is a separate package:**
  - ESM NodeNext, so imports need `.js` suffixes.
  - It cannot import `@/` or `src/`.
  - Tests go in `runner/agent-core/src/test/*.test.ts`.
  - Record every change in `runner/agent-core/VENDORED.md`.
  - **The runner executes `runner/agent-core/dist`.** Rebuild with
    `npm run build --prefix runner/agent-core` after every agent-core edit, or nothing
    changes at runtime.
- **`runner/agent-core/src/work/plan.ts` contains a literal NUL byte.** Do not edit that
  file (you may corrupt it). The brief's design never needs to.
- **Never import `scripts/work-runner.ts` from a test.** It starts a worker when imported.
- **i18n:** there is no `t()`. Write English literals.
  - Keep copy in static objects or constants named `*_COPY`, `*Label`, `*Title` or `*Message` so the extractor catches it.
  - Never build copy with `${}` templates if it should translate.
  - Run `npm run i18n:extract` before typecheck or dev.
  - Mark user or remote content and the live-view container `translate="no"`.
- **Chat tool schemas** use only `type/properties/description/required/enum/items`.
  - No `additionalProperties`: Gemini rejects it.
  - No nested objects.
  - Every property has a `description`.
  - Tool names are ≤64 characters.
- **Native tools get no provider `callId`.** Derive idempotency keys from `userMessageId`
  plus a digest of the normalized arguments.
- **Iframes:**
  - No `sandbox` attribute containing `allow-same-origin` anywhere in `src/`. A test
    walks every file for this. For the live view, omit `sandbox`.
  - Set `referrerPolicy="no-referrer"`.
- `@e2b/desktop` and `e2b` are server-only. Keep them out of client bundles. If
  `next build` complains, add them to `serverExternalPackages` in `next.config.mjs`.

## 6. Prisma migrations, exactly

1. Edit `prisma/schema.prisma` in the house style:
   - `id String @id @default(cuid())`, `userId String`, timestamps;
   - `user User @relation(..., onDelete: Cascade)`;
   - `@@index([userId, ...])`;
   - `///` doc comments.
2. Create `prisma/migrations/<YYYYMMDDHHMMSS>_agents_v2/migration.sql`.
   - The timestamp must sort **after every existing migration directory**. Check with
     `ls prisma/migrations | tail -3`.
   - The name is permanent once pushed.
3. Generate the SQL without a database:
   ```bash
   git show origin/main:prisma/schema.prisma > /tmp/old.prisma
   npx prisma migrate diff --from-schema-datamodel /tmp/old.prisma --to-schema-datamodel prisma/schema.prisma --script
   ```
   Then edit it into the house style (copy the header of `prisma/migrations/*_agents/migration.sql`):
   - a header comment that says what it is and "Expand-only (docs/JUNO.md §20.2b)";
   - `ADD COLUMN IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` on existing tables;
   - **never `CONCURRENTLY`**;
   - `ALTER TABLE "<NewTable>" ENABLE ROW LEVEL SECURITY;` for each new table. ENABLE, never FORCE.
   - **No** `juno_record_account_change` trigger on new tables: it breaks native sync.
4. Add every new model that has a `userId` to `OWNER_COLUMN` in `src/lib/db.ts`, with a
   comment. `tests/ownership-guard.test.ts` fails otherwise.
5. Run `npx prisma generate`.
6. **Drift check against a throwaway Postgres.** It must print no differences and exit 0:
   ```bash
   # once
   export LC_ALL=en_US.UTF-8
   /opt/homebrew/opt/postgresql@17/bin/initdb -D /tmp/jpg17 -U postgres --auth=trust >/dev/null
   printf "unix_socket_directories = ''\nlisten_addresses = '127.0.0.1'\nport = 54391\n" >> /tmp/jpg17/postgresql.conf
   /opt/homebrew/opt/postgresql@17/bin/pg_ctl -D /tmp/jpg17 -l /tmp/jpg17.log start
   /opt/homebrew/opt/postgresql@17/bin/createdb -h 127.0.0.1 -p 54391 -U postgres shadow
   # every time
   DATABASE_URL=postgresql://postgres@127.0.0.1:54391/shadow DIRECT_URL=postgresql://postgres@127.0.0.1:54391/shadow \
     npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma \
     --shadow-database-url postgresql://postgres@127.0.0.1:54391/shadow --exit-code
   DATABASE_URL=postgresql://x@127.0.0.1:1/x DIRECT_URL=postgresql://x@127.0.0.1:1/x npx prisma validate
   ```
   Stop the server at the end with `pg_ctl -D /tmp/jpg17 stop`.
7. If you store a secret or user content in a new column, add a row to the
   "What is encrypted at rest today" table in `SECURITY.md`.

## 7. Env vars (all optional; everything degrades when unset)

For each new variable:
- add it to `src/lib/env.ts` as a getter plus an `isXConfigured()` helper;
- add a commented block to `.env.example`;
- add a row to the Optional table in `docs/JUNO.md` §19.

| Name | Default | Meaning |
|---|---|---|
| `COMPUTER_PROVIDER` | `off` | `e2b` enables agent computers. `fake` is accepted only when `NODE_ENV !== "production"` (tests, galleries). |
| `COMPUTER_E2B_API_KEY` | — | E2B key. **Not** `E2B_API_KEY`, which the code interpreter already reads as a fallback token. |
| `COMPUTER_E2B_TEMPLATE` | `desktop` | E2B template id |
| `COMPUTER_MAX_RUNNING_PER_USER` | `2` | awake computers per account |
| `COMPUTER_MAX_RUNNING_TOTAL` | `10` | awake computers across the whole deployment (E2B Hobby allows 20) |
| `COMPUTER_IDLE_PAUSE_SECONDS` | `180` | idle time before an awake computer is put to sleep |
| `COMPUTER_RETENTION_DAYS` | `30` | a computer asleep this long is destroyed (logins lost) |
| `COMPUTER_COST_MICRO_USD_PER_SECOND` | `46` | ≈ $0.166/h, the E2B price of 2 vCPU / 4 GiB |

## 8. Gates

Run the **quick set** after every step. Run the **full set** at the end of every phase
and before the final push. Record the results in `PROGRESS.md`. The first time, run the
full set on the untouched tree to get a **baseline**, and write down anything that already
fails there. You are not required to fix those, but nothing that passed may start failing.

**One-time setup in the worktree:**
```bash
npm ci
npm ci --prefix runner/agent-core && npm run build --prefix runner/agent-core
npm ci --prefix relay
ln -s /Users/liammagnier/Developer/project/juno/.env.local .env.local   # dev env; never copy .env
```

**Quick set:**
```bash
npm run i18n:extract && npm run typecheck && npm test && npm run lint
npm run build --prefix runner/agent-core && npm test --prefix runner/agent-core   # if agent-core changed
```

**Full set.** This is what `deploy-from-mac.sh` runs, plus the checks that only lived in
GitHub Actions, which are not running:
```bash
npm run i18n:extract
npm run typecheck
npm test
npm run lint
npm run capabilities:check
npm run work:contract:check
npm run models:capabilities:audit
npm run work:sandbox:check
npm run build --prefix runner/agent-core && npm test --prefix runner/agent-core
npm test --prefix relay
npm run native:sync:check          # OpenAPI→Swift, parity ledger, chat wire, shell contract
npm run native:design:check
npm run design:tokens:check        # if the script exists
npm run security:check             # includes npm audit; needs network
# prisma validate + drift check (§6)
npm run build                      # next build with the symlinked .env.local; catches client-bundle mistakes
```

**Final proof:** the exact deploy check phase in Docker, on the exact commit you will push.
- Docker Desktop must be running. If it isn't, write that in the report; do not start it
  yourself.
- Only report "gate passed" if the script prints `GATE PASSED`.
```bash
bash /Users/liammagnier/Developer/project/juno-release-tools/gate-like-deploy.sh /Users/liammagnier/Developer/project/juno-agents <sha>
```

**Native, if you touched `native/`:**
```bash
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer npm run native:test JunoNativeKit
xcodegen generate --spec native/macOS/JunoDesktop/project.yml
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer xcodebuild -project native/macOS/JunoDesktop/JunoDesktop.xcodeproj -scheme JunoDesktop -configuration Debug -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO SWIFT_TREAT_WARNINGS_AS_ERRORS=YES build
# Also the Stable configuration, and the iOS simulator build:
xcodegen generate --spec native/iOS/JunoMobile/project.yml
# ... xcodebuild -scheme JunoMobile -destination 'generic/platform=iOS Simulator' build
git checkout -- native/macOS/JunoDesktop/JunoDesktop.xcodeproj native/iOS/JunoMobile/JunoMobile.xcodeproj   # never commit regenerated pbxproj
```
- `docs/native/TESTING.md` is the reference for native builds and tests.
- Never run XCUI or UI-automation tests, and never capture the screen: the owner declined screen control.

## 9. Verifying the web UI

- The in-app browser is **not signed in**, and you must not sign in.
- Verify UI in a **dev-only gallery page**, `src/app/dev/agents-v2/page.tsx`:
  - `if (process.env.NODE_ENV === "production") notFound();`
  - a `"use client"` `gallery.tsx` with inline fixtures;
  - a `window.fetch` shim that maps `/api/agents/...` to fixtures;
  - Radix-heavy parts wrapped in `next/dynamic` with `{ ssr: false }`.

  Copy the pattern of `src/app/dev/premium/` or `src/app/dev/documents/`.
- Run your own dev server in your worktree on **port 3170**:
  `npm run i18n:extract && npx next dev -p 3170`. Never run a second `next dev` in
  another checkout: it shares `.next/`.
- Iframes loaded by URL are blocked by the app's built-in browser pane. Verify the live
  view with Playwright driving the installed Chrome:
  `chromium.launch({ channel: "chrome", headless: true })`, run from a script in your
  worktree. Take viewport screenshots at **1440×900 and 390×844, light and dark**. Save
  them under `docs/design/agents-v2/screens/` and list them in `PROGRESS.md`.
