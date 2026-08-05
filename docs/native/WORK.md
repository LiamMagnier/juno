# Juno Work — how it executes, where the boundaries are, how to run it

Date: 2026-08-05
Status: cloud execution and the API surface are built; the Mac host half is
partially built and explicitly not wired end to end (see
[What is not yet wired](#what-is-not-yet-wired)).

Juno Work is the surface where Juno is asked to *do* something rather than
answer something: move a folder of files, prepare a document, drive an app,
carry out a briefing. That difference is the whole reason this document exists.
A chat turn that goes wrong produces a bad paragraph. A Work run that goes wrong
has already moved the files.

Everything below follows from that one fact.

## Vocabulary

`src/lib/work/domain.ts` declares every status, target, event kind, risk level,
capability, sensitivity and audit kind Work has. The Prisma columns holding them
are `TEXT`; that file is what makes them a type, and
`scripts/generate-work-contract.mjs` is what makes the Swift clients agree with
it. **A value that is not in that file is not a value Work has.** Do not
re-declare any of it — not in a route, not in the runner, not in Swift.

The generated Swift half is
`native/Packages/JunoNativeKit/Sources/JunoCore/Generated/JunoWorkContract.swift`,
byte-compared against a fresh generation by `npm run work:contract:check`. That
gate lives in `deploy.yml` rather than `native.yml` because `native.yml` is path
filtered: a commit touching only `contracts/work/juno-work-v1.json` or
`src/lib/work/domain.ts` would never trigger it. The failure it prevents is
quiet in the worst way — a client that cannot name a status renders the run as
nothing at all, so the user sees an empty screen rather than an error.

## How a run happens

A **session** is a goal plus its settings. A **run** is one attempt at that
goal. Sessions outlive runs, which is why "retry" is a new run rather than a
mutation of the old one: a Work run can have moved files, sent a message or
spent most of a budget before it stopped, and repeating those silently is worse
than stopping.

```text
POST /api/work/sessions                      create the goal
POST /api/work/sessions/{id}/runs            dispatch an attempt
GET  /api/work/sessions/{id}/events          SSE: snapshot → events → done
POST /api/work/sessions/{id}/answer          answer a question the run asked
POST /api/work/approvals/{id}/decision       allow or deny one exact action
POST /api/work/runs/{id}/control             pause / resume / cancel
GET  /api/work/hosts                         the user's Macs and their state
```

The request shapes and every pure decision on that surface live in
`src/app/api/work/protocol.ts`, deliberately free of Prisma and `server-only` so
`tests/work-routes.test.ts` can exercise them without a database. A check that
can only be run against a live Postgres is a check that gets run once, by hand,
on the day it is written.

### Target selection

A run declares `cloud`, `local` or `automatic`, and `selectTarget` in
`src/lib/work/domain.ts` resolves that to an `effectiveTarget`. It is pure and
deterministic so the awkward cases can be unit-tested rather than observed in
production: the Mac that is enabled but asleep, the task needing one local
capability out of six, the account with two Macs where only the second has been
granted a folder.

`automatic` goes local only when the run needs a capability the cloud cannot
serve at all *and* some usable host serves every one of them; otherwise it goes
to cloud. The important branch is the one that returns **`target: null`** —
when local work is genuinely required and no host can do it, the caller must not
queue. A queued run with no possible executor renders as a spinner that never
resolves, and the user is never told that nothing is going to happen.

`GET /api/work/hosts` narrows a host's stored state by its heartbeat before
returning it (`hostStateFor`, `RUN_LEASE_MS`), so a list a user picks a host
from cannot show `online` for a Mac that was closed an hour ago.

### Cloud execution

`scripts/work-runner.ts` is the cloud executor. Three properties shape it, and
all three come from one fact: a Work run outlives the process that started it.

- **It leases rather than flags.** `claimRun` puts the condition inside the
  `UPDATE ... WHERE`, so exactly one worker wins a queued run, and the lease
  expires so a worker that dies does not strand its run in `running` for ever.
  Each tick sweeps other workers' expired leases before claiming anything new,
  because a run whose executor died is indistinguishable from a healthy one on
  every client.
- **It waits for a person without being held hostage.** A question or an
  approval suspends the run. If the answer arrives within `ATTENDED_WAIT_MS`
  (four minutes) the run continues in place; otherwise it is checkpointed,
  released, and picked up later by whichever worker is free. Blocking
  indefinitely would mean one unanswered question costs a worker until somebody
  comes back from lunch.
- **It never restarts a run on its own.** `interrupted` is a terminal state with
  a retry the user chooses, for the reason given at the top of this document.

The agent runtime itself is `runner/agent-core/src/work` — the budget guard, the
tool-tier lattice, the plan/progress checker and the untrusted-content scanner.
The executor deep-imports the **compiled** output (`dist/work/index.js`), the
same way the Cloud Code runner does, because `runner/agent-core` sits outside
the root `tsconfig.json` and a static import would make the web build depend on
a directory it does not typecheck.

### Local execution on a Mac

A Mac never receives a run. It receives **commands** — `start`, `pause`,
`resume`, `stop`, `answer`, `approve`, `deny`, `undo`, `grant_folder`,
`revoke_grant`, `refresh_capabilities`, `ping` — claims them one at a time over
a long poll, hands them to the local Work runtime, and acknowledges the outcome. `WorkRemoteHost` (in `JunoWorkKit`) is that loop and it executes
nothing itself: it claims, checks, hands over and acknowledges. Execution
belongs to the local runtime with its own grants and its own approval flow,
which is what makes it true that **a remote command cannot acquire a capability
a local prompt does not already have**.

## How a Mac is opted in

Nothing is on until the person sitting at the machine turns it on.
`DesktopWorkHostModel` (`native/macOS/JunoDesktop/App/DesktopWorkHost.swift`)
owns the switches, the policy they add up to, and the claim loop's lifetime —
and deliberately not execution.

Signing into Juno is not consent to hand a phone the filesystem. A Mac that
started accepting instructions from elsewhere the moment somebody signed in
would be a default nobody would choose if they were asked. Juno Code learned
this with `servesQueuedTasks`; this is the same shape for a much larger
capability.

The individual switches are `allowsFileWork`, `allowsBrowser`,
`allowsComputerUse`, `allowsShell`, `allowsBackground`, an `approvalPolicy`
(`conservative` / `balanced` / `permissive`), and app and domain allowlists.
Two details in `WorkHostPolicy` are load-bearing:

- An **empty `allowedApps` means none**, never "all". An empty allowlist read as
  permissive is exactly how a feature ships switched on for everyone who never
  opened Settings.
- **`blockedApps` always beats `allowedApps`**, so widening the allowlist later
  cannot re-admit something the user explicitly refused.

The policy is re-advertised on **every heartbeat**, not only at registration,
because the answer changes when the user revokes a folder or flips a switch, and
a relay routing on a stale manifest dispatches work the host will refuse.

The settings surface holds display names and access modes only. Grant paths live
behind `GrantAccessing` in `JunoWorkLocal` and are never held in the model, so a
Settings screen cannot render one and a screenshot of that window cannot leak
one.

## Where the security boundaries are

Five boundaries. Each exists because a specific failure is otherwise reachable.

### 1. The grant — a path the Mac knows and nobody else does

A `WorkFileGrant` stores `localPath` and `resolvedRealPath`. Those two columns
are the only record of where a user's folder actually is, and they must never
travel to a phone, a browser, or a cloud executor.

`src/lib/work/serializers.ts` enforces that by construction:

- `serializeGrantForRemote` names every field it emits. Nothing is spread from
  the row and nothing is deleted from a copy, so a column added next quarter — a
  bookmark blob, a volume UUID, a second path under a different name — cannot
  ride out because somebody forgot to update a delete list.
- `serializeGrantForHost` builds on top of it and adds the two paths. There is
  exactly one place in the codebase where a stored path is added to a response,
  and that is it.
- `ClientWorkGrant` declares `localPath?: never` and `resolvedRealPath?: never`.
  Without those, `HostWorkGrant` is structurally assignable to
  `ClientWorkGrant` — excess property checks only fire on fresh object literals,
  never on a value returned from a function — so a handler declared to return
  the remote shape could hand back the host shape and the compiler would agree.
- The unqualified `serializeGrant` is bound to the **remote** half. Code that
  reaches for it without having thought about which side of the boundary it is
  on gets the shape with no paths in it. Wanting the paths has to be said out
  loud.

Commands get the same treatment for the same reason. `serializeCommandForRemote`
filters payload and result through **per-kind allowlists** (`REMOTE_PAYLOAD_KEYS`,
`REMOTE_RESULT_KEYS`), and a kind absent from those tables yields `{}` rather
than a pass-through, so a command kind added next quarter is silent to remote
clients until somebody decides what it may say. The concrete case is
`grant_folder`: the phone sends a display name, the user at the Mac picks a
folder in a file dialog, and the host answers with the absolute path it
resolved. Echoing that answer back would hand the phone the very thing the grant
design keeps from it — through a field nobody thinks of as a path. Withheld key
names are returned in `redacted` so a remote surface can say "the Mac returned
more than this" rather than quietly showing a truncated result as if it were
whole.

Because the command shapes differ only in which JSON keys survive, the type
system cannot catch the command half the way `never` catches the grant half.
That is why `deploy.yml` and `scripts/release-gates.sh` both grep
`src/app/api/work` for `serializeGrantForHost` and `serializeCommandForHost`.
`serializeCommandForHost` is a plausible thing to write in a route, reads as
deliberate, and produces a response that looks right in the browser — the
failure is invisible in review, which is exactly the kind that deserves a
mechanical gate.

### 2. The approval digest — a promise about one exact thing

An approval is a promise the user made about one action. `src/lib/work/digests.ts`
stops that promise being spent on something else, and there are two concrete
ways it otherwise would be.

**Action substitution.** The user is shown "Move 14 files from Downloads to
Archive" and taps Allow. The row now says `decision: "allowed"`. An executor
consulting only that column has authorised anything it does next — including the
delete it was refused ten seconds earlier, or the same move re-run against a
directory whose contents changed while the user was reading. Binding the
approval to a hash of the exact normalised action lets the executor ask a
different question: not "was something allowed" but "was *this* allowed".

**Policy widening by the back door.** The user approves a send while the session
runs under `permissive`. Before the executor gets to it, the policy narrows to
`conservative` — the entire point of which is that sends now stop and ask. An
approval carrying no record of the policy it was granted under would sail
straight through, and the narrowing would have had no effect on the one
operation it was aimed at. The resolved policy is hashed alongside the action,
so the digests stop agreeing and the approval has to be asked again under the
rules actually in force.

`canonicalize` sorts object keys, drops `undefined` and emits no whitespace,
because `JSON.stringify` preserves insertion order: the same action built by two
code paths, or round-tripped through JSONB, would otherwise hash differently. A
digest that changes when nothing changed makes every mismatch noise, and a noisy
integrity check gets disabled by whoever is on call the night it starts firing.

The module is deliberately pure — no Prisma, no `server-only`, no clock —
because the executor, the relay, the routes and the tests all compute these, and
the digest is worth nothing unless every one of them computes it identically.

### 3. The policy lattice — five inputs, one direction

Five things want a say in what a run may do: the host's switches, the project,
the session, the schedule that fired it, and the skill it invoked. **Every one
of them may only narrow.**

That is expressed as a lattice with a meet operation — `WorkHostPolicy` in
Swift, `narrowestPolicy` / `narrowestBudget` / `maxSensitivity` in
`src/lib/work/domain.ts` — rather than a chain of conditionals, because a chain
of conditionals eventually grows a branch that widens, and a widening branch in
this particular place is a remote prompt acquiring a capability the owner of the
Mac never granted.

Two subtleties worth knowing before touching it:

- `narrowestBudget` cannot be `Math.min`. Zero means "no ceiling at this layer",
  so a naive minimum would let an unset session budget clamp a schedule's real
  one to zero and stop every run instantly.
- Sensitivity only ever rises (`maxSensitivity`), and `restricted` content never
  appears in a screenshot that leaves the Mac (`allowsScreenshotRelay`). That is
  checked *before* the screenshot is stored or relayed — a redaction pass that
  runs on an image already sent to the phone has redacted nothing.

### 4. The egress proxy — an allowlist the container cannot reconfigure

`--network=none` is the right default and it is not always workable: a real
build fetches dependencies. The wrong answer is to turn the network on, because
an agent with unrestricted egress can post the repository anywhere. The answer
is a proxy the container cannot reconfigure, with an explicit allowlist.

`runner/agent-core/src/tools/egress-policy.ts` holds those rules — and only the
rules. They are pure and separately tested precisely because an allowlist
exercised only by starting a proxy and making real requests is an allowlist
whose edge cases are never tested, and the edge cases are the whole point.
`normalizeHost` strips the trailing dot for one of them: `evil.com.` and
`evil.com` resolve identically, so a string comparison lets the first through a
list containing the second.

**No process enforces this today.** See below.

### 5. The container — the boundary a regex cannot be

`runner/agent-core/src/tools/container-sandbox.ts` runs agent-authored commands
in a container instead of on the runner VM. The division of labour matters more
than any individual flag: the **driver** stays on the host holding the task
token and the clone token and doing the clone, commit, push and PR; the **agent**
gets a container with the worktree bind-mounted and nothing else — no tokens, no
`~/.gitconfig`, no Actions environment, no network.

The image is pinned **by digest, never by tag**: `node:20` today and `node:20`
next month are different images, so a tagged run is not reproducible and a
compromised tag is a supply-chain problem nobody would notice.

Command classification stays as defence in depth — it refuses obviously
destructive commands early with a better error than a container failure — but it
is a text gate, not a boundary, and it can be spelled around. What actually
holds is that the process has no credential to steal and no socket to send it
over.

Alongside this, `runner/agent-core/src/work/injection.ts` wraps every piece of
untrusted content in sentinels and scans it, so text that persuades the model is
at least recorded as having tried.

## Running the workers

```bash
npm run work:runner      # the cloud Work executor (scripts/work-runner.ts)
npm run tasks:runner     # the scheduled-task worker, for comparison
```

`work:runner` claims queued runs whose `effectiveTarget` is `cloud`, drives at
most three at a time, ticks every five seconds, renews its leases at a third of
their life (so two consecutive renewal failures are harmless), and sweeps other
workers' expired leases on the way in. It is safe to run several copies: the
claim is a conditional `UPDATE`, so a run is claimed exactly once no matter how
many workers race for it.

It requires the compiled agent core:

```bash
npm ci     --prefix runner/agent-core
npm run build --prefix runner/agent-core
```

`runner/agent-core/dist` is gitignored and built in CI, so a checkout alone is
not enough — the deep import of `dist/work/index.js` fails at startup otherwise.

## CI and release gates

| Gate | Where | What it prevents |
|---|---|---|
| `npm run work:contract:check` | `deploy.yml` → `test` | A Swift client that cannot name a status renders the run as nothing at all |
| No host-only serialiser in `src/app/api/work` | `deploy.yml` → `test`, `release-gates.sh` | A local path or an unfiltered command payload reaching a phone |
| Work migration present | `deploy.yml` → `migrations` | Work routes failing on their first query against a freshly migrated database |
| No `CREATE INDEX CONCURRENTLY` | `deploy.yml` → `migrations` | A half-applied migration that P3009-blocks every later deploy |
| `runner/agent-core` build + tests | `deploy.yml` → `runner` | Untested budget, tier, plan and injection policy |
| Work suites reached `dist/` | `deploy.yml` → `runner` | `node --test dist/test/*.test.js` going green because the glob matched fewer files |
| `swift test` for `JunoWork` | `native.yml` → `packages` matrix | A Swift package outside that matrix is never compiled by CI at all |

The two migration greps run **before** `npm ci` in the `migrations` job, so a
migration mistake costs seconds rather than the two minutes it takes to install
dependencies and boot Postgres only to be told the same thing.

`scripts/release-gates.sh` remains **manual and pre-release only**, run from the
repository root. It is not wired into a workflow and should not be: it asserts
the worktree is clean and that the built app's metadata matches `HEAD`, neither
of which is meaningful on a CI checkout. Its Work sections deliberately do not
repeat the CI gates — they assert those gates are *still wired*, which is the
failure this script can catch and CI cannot. A gate deleted in a refactor is
green in CI by construction.

## What is not yet wired

Stated plainly, because a half-wired security boundary that reads as finished is
worse than an absent one.

- **The Mac host command surface is only half built.** `WorkRelaying` declares
  `advertiseWorkHost`, `claimNextWorkCommand` and `acknowledgeWorkCommand`. The
  advertisement half has landed (`POST /api/work/hosts/register`, with the pure
  decisions in `src/lib/work/relay.ts`); the claim and acknowledge routes have
  not. `serializeCommandForHost` still has no caller outside
  `tests/work-grant-paths.test.ts`, which is the check to re-run when judging
  whether that is still true — the moment a claim route exists, it is the first
  thing that will legitimately want the host shape, and the first place the
  disclosure gate earns its keep. The gate was written *before* those routes on
  purpose: a gate added afterwards is a gate added after the mistake.
- **The cloud executor gives the agent no tools.** `scripts/work-runner.ts`
  constructs `WorkAgentSession` with `tools: []`. The orchestration runtime,
  budget guard, tier lattice and plan checker are all exercised; the tool
  surface is not.
- **The cloud executor holds a provider key.** `resolveProvider` builds an
  adapter from a directly-configured provider in the environment. Production
  should reach models through the Juno proxy with a per-run scoped token,
  exactly as `scripts/cloud-code-runner.mjs` does — that handshake needs a
  per-run token this queue does not mint yet. The consequence is real: this
  worker holds a key where the Code runner does not.
- **No process enforces the egress policy.** `egress-policy.ts` is rules and
  tests; nothing imports it outside its own suite. `container-sandbox.ts`
  accepts a `proxyNetwork` and will attach the container to it, but the proxy
  that network is supposed to route through has not been built. Until it is,
  `network: "none"` is the only honest setting.
- **The cloud Work executor is not deployed.** There is no `juno-work` entry in
  `deploy/ecosystem.config.js`, and `build-and-deploy` in `deploy.yml` does not
  build `runner/agent-core`, so `dist/` never reaches the VM — and
  `node_modules` is excluded from the deploy rsync, so its runtime dependencies
  would not be there either. Wiring it means mirroring what the voice relay
  already does: build it in `build-and-deploy`, `npm ci --omit=dev --prefix
  runner/agent-core` in the post-deploy step, and add a pm2 app. All three parts
  have to land together; two of the three would produce a worker that looks
  deployed and never starts.

## Files worth reading first

| File | Why |
|---|---|
| `src/lib/work/domain.ts` | The vocabulary. Everything else agrees with it or is wrong |
| `src/lib/work/serializers.ts` | The disclosure boundary, in full |
| `src/lib/work/digests.ts` | Why an approval is bound to an action *and* a policy |
| `src/app/api/work/protocol.ts` | Request shapes and the pure decisions, testable without a database |
| `src/lib/work/relay.ts` | The phone → Mac seam: revocation mid-poll, two Macs racing one command, redelivery |
| `scripts/work-runner.ts` | Leases, attended waits, and why a run is never auto-restarted |
| `runner/agent-core/src/work/` | Budget, tier, plan, injection |
| `native/Packages/JunoNativeKit/Sources/JunoWorkKit/WorkHostPolicy.swift` | The lattice, and why it is a lattice |
| `native/macOS/JunoDesktop/App/DesktopWorkHost.swift` | The opt-in model |
