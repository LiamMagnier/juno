# Next session — start here

Read this file first, then `STATUS.md` for the longer history. Everything below
was verified on 2026-07-22, not remembered.

## Exact starting point

```
worktree  /Users/liammagnier/Desktop/workspace/.worktrees/juno-final-completion
branch    agent/juno-final-completion   (pushed, == 3c7138e)
base      origin/main == 40dc9b4
tree      clean, no merge/rebase/cherry-pick in progress
```

```bash
cd /Users/liammagnier/Desktop/workspace/.worktrees/juno-final-completion && \
git fetch origin && git status --short && git log --oneline -4
```

## The headline: the phone can now identify itself

The previous session's dead end was that it could not tell which build was on
the iPhone — both candidates reported `0.1.0 (1)`. That is closed.

| fact | value | how it was established |
|---|---|---|
| installed on the physical iPhone | `com.liammagnier.JunoMobile` **0.1.1 (2)**, commit `3c7138ea33` | `devicectl device info apps` after an upgrade install |
| app process on device | running, no launch crash | `devicectl device info processes` |
| deployed server | `40dc9b4`, contract `1.3.0` | `x-juno-contract-version` from production |
| build contract | `1.3.0` | Diagnostics screen, and `JunoNativeContract.version` |

**Device SHA `3c7138ea33` ≠ server SHA `40dc9b4`** — deliberately. This branch
is not merged yet. Parity is a Stage 15/16 item, after the merge.

The install was an **upgrade in place**, so the container and the durable outbox
were preserved. Nothing was deleted.

## What is actually done

- **Settings › About › Diagnostics** (iOS). Shows version and build, commit,
  contract, backend URL, channel, sync phase, change cursor, last successful
  sync, last HTTP status, a short failure kind, the last error, a Retry, and the
  outbox depth broken out by state. English and French. Captured at
  `docs/native/design/diagnostics-ios.png`.
- **Version is 0.1.1 build 2** so installs are distinguishable from here on.
- **Build metadata chain.** `native/Scripts/write-build-metadata.sh` writes
  `native/Config/Generated-Build.xcconfig` (gitignored) with the short SHA and
  the contract read from `src/lib/api-v1.ts`. Run it before any archive.
- **`JunoBackend.productionURLString`** is now the single declaration of the
  backend, dialed by both apps. `release-gates.sh` enforces that and fails if an
  app source hardcodes the host again.
- 11 new tests (7 sync/outbox diagnostics, 4 backend/build-info). Full
  JunoNativeKit suite green, 63 executions, 0 failures. All release gates pass.

## Two traps worth not re-learning

1. **xcconfig strips `//` to end of line.** Carrying the backend URL through it
   produced `https:` on the device — twice, including through a variable meant
   to smuggle the slashes past the comment parser. Only reading the *built*
   `Info.plist` reveals it. The URL now lives in Swift, not xcconfig.

2. **The Debug bundle ID is `com.liammagnier.JunoMobile.debug`.** Querying
   `simctl get_app_container` with the Stable ID returns a *stale* app from an
   earlier session and looks exactly like a failed install. A long detour went
   into that. Also: recent simulators reject unsigned bundles, so build
   simulator apps with `CODE_SIGN_IDENTITY="-"`, not `CODE_SIGNING_ALLOWED=NO`.

## The hard blocker on real-device verification

**The physical iPhone's screen cannot be observed from this environment, and its
UI cannot be driven.** `devicectl` installs, launches and lists processes; it
does not screenshot or tap. The iOS Simulator tooling explicitly refuses
physical devices, and `idevicesyslog` is not installed. `devicectl ... --console`
produced no output because the app logs through `os_log`, not stdout.

So for the physical device, these are established: the build installed, is
signed with a valid `application-identifier`, launched, and stayed running.
These are **not**: what the Diagnostics screen reads on that device, whether the
Offline banner is gone, or whether bootstrap succeeds against production —
because that needs the owner's account and a view of the screen.

**Next action for the owner:** open Juno on the iPhone → Settings → About →
Diagnostics, and report the Phase, Last HTTP status and Failure rows. That is
the exact input Stage 3 needs, and the screen was built to make it a five-second
answer.

## What remains, honestly

**Stage 3 — partly done.** Three real defects found and fixed, with tests:

- `NativeArtifactStore` and `NativeProjectStore` classified failures with
  `error is URLError`, which misreads the common case — a genuine outage arrives
  as `retryLimitExceeded`, not a `URLError` — and treated a cancelled request as
  an outage. The project store also set a phase *only* for `URLError`, leaving
  every other failure showing an error banner over a `.ready` phase.
- Both stores reported a failed outbox drain as a hard `.failed`, telling the
  reader their queued changes had failed when they were queued safely.
- The banner rendered `URLError.localizedDescription` verbatim, so a phone with
  no signal read "The operation couldn't be completed. (NSURLErrorDomain error
  -1009.)". Found by looking at the screen; the code reads fine.
  Fixed: `docs/native/design/banner-offline-readable.png`.

What is **not** done in Stage 3 is the real-device half — see the blocker above.

**Stage 5 — attachments work end to end, unverified against production.**
Backend `POST /api/v1/attachments` with shared validation, magic-byte sniffing,
HEIC kept out, idempotency. Client transcoder (orientation baked into pixels,
GPS stripped, output re-validated), upload client, composer model, and camera /
photos / files pickers with per-file state. Uploads are claimed onto the message
in the same transaction that creates it. Capture:
`docs/native/design/composer-attach-ios.png`.

Not verified: an actual upload against production, which needs the account.
Camera was not exercised on the physical device.

**Stages 4, 6–16 — not started.** Deep Research, Canvas, Code Remote backend,
Mac remote host, mobile Remote, Cloud, the design pass, accessibility, the
threat model, the release and the final installs. Nothing about them should be
assumed. macOS still has **no** Diagnostics screen, which Stage 16's three-way
SHA parity check needs.

### The next concrete thing

`prisma/migrations/20260722200000_attachment_idempotency_key` has **not been
deployed**. It is additive and idempotent (`ADD COLUMN IF NOT EXISTS`, `CREATE
UNIQUE INDEX IF NOT EXISTS`) and hand-written per the standing rule never to run
`migrate dev` against the shared database — but nothing on this branch can ship
until it is applied with `migrate deploy`.

## Repository state

- `agent/juno-final-completion` — this work, pushed, clean.
- PR #18 (`agent/juno-native-claude-continuation`, `2ae1e37`) — one commit not
  reachable from main: `fix(prisma): take the backfill migration verbatim from
  origin/main`. Its content is already in main by a different SHA; confirm with
  a diff of that one file before closing the PR.
- PR #19 (`agent/juno-code-remote-backend`) — fully reachable from `origin/main`.
- `agent/juno-code-remote-orphan-recovery` (`2b353f6`, pushed) — holds the
  orphaned Code-remote backend work. Verified byte-identical to the uncommitted
  files still sitting in the `main` checkout, all 16 files. Not in the release.
- The `main` checkout at `/Users/liammagnier/Desktop/workspace/juno` is still
  dirty with that same work and was **not** touched.
- Migration invariant holds: 22 `NULL::timestamp`, asserted by the gates.
