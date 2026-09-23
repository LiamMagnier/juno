# Juno Code rework: handoff (paused 23 September 2026)

Paused at the user's request. No job is running: no deploy, release, build or
workflow, and every git tree involved is clean.

## Done

- **Code.** All of it is on `main` at `d0997af2`, which `origin/main` also
  points at. That covers the rebuild (`ae5f4914`), the 22 review fixes, the
  eight former open items (hooks, turn rewind, model compaction, session-store
  scaling, relay upload, screen-control settings, agent-proxy billing and idle
  timeouts, the private-repo release feed), the four permission-system
  security fixes, and the integration repairs. `00-README.md` §4–§5 records
  where each item landed.
- **Verification on the exact released tree.**
  - Swift: JunoCode 1,069 XCTest cases plus Swift Testing, all passing.
    NativeKit JunoCodeKit/Voice/Core tests pass.
  - App: JunoDesktopTests (119) pass and the Stable configuration builds.
  - Web: typecheck, lint and 3,768 tests pass.
  - Every `scripts/check-*` wiring and design gate passes.
- **Production.** `d0997af2` is deployed twice. The second deploy loaded the
  token the user added. Health checks, migrations, the voice relay, the
  production smoke tests and the public-UI smoke test all passed.
- **Mac 1.6.0 (build 87).** Released at
  https://github.com/LiamMagnier/juno/releases/tag/v1.6.0 (release id
  `394751075`).
  - It is a normal release, not a prerelease, so installed 1.5.4 apps can
    see it.
  - Tag `v1.6.0` is at `d0997af2`.
  - DMG SHA-256 `c9ccfa763911e93b5351ff99d7d5eef1a57dc8f7d070a1adaabe9a1eff6b729d`,
    22,948,382 bytes. It is ad-hoc signed and not notarized.
- **The user's Mac.** 1.6.0 is installed in `/Applications/Juno.app`, from the
  same DMG. 1.5.4 is kept in the Trash as "Juno 1.5.4.app".
- **Not in 1.6.0.** The Mac Chat redesign (Liquid Glass) is not in this
  release. It lives on `mac/liquid-glass-chat` in
  `/Users/liammagnier/Developer/project/juno-glass`, owned by another session,
  and will ship as a later release. Leave it alone.

## Still open

1. **The live update feed sees no release.** It still says macOS "Not
   published yet", so installed apps other than the user's cannot find 1.6.0.
   - The code is proven to work: `buildDownloadFeed` run locally with a valid
     token returns the private repo's releases with a signed
     `release-assets.githubusercontent.com` URL.
   - So production is loading no `JUNO_RELEASES_GITHUB_TOKEN`, or one that
     cannot read the repo.
   - The user was given two checks:
     - a `curl` of the releases API with their token, which must return 200;
     - `grep -c '^JUNO_RELEASES_GITHUB_TOKEN=' ~/juno/.env ~/juno/current/.env`
       on the VM, where both counts must be 1.
   - Claude may not read production env or secrets.
   - **Next step after the user fixes it:** redeploy if the token went into
     `~/juno/.env` after the last deploy (`deploy/deploy-from-mac.sh
     --skip-checks` is safe while `origin/main` is still `d0997af2`). Then
     confirm
     `curl -s "https://chat.liams.dev/api/downloads?refresh=$RANDOM" | jq '.downloads[0]'`
     shows version 1.6.0 with the SHA-256 and size above, `notarized:false`,
     and a githubusercontent URL.
2. **`gh` cannot reach GitHub from this Mac.** Since about 15:20 on 23 Sept
   every `gh` call fails with "net/http: TLS handshake timeout". curl, openssl
   and URLSession all work.
   - Ruled out: the sandbox, the MTU, trust evaluation, a per-process filter
     (a local proxy did not help), and ML-KEM (turned off through GODEBUG).
   - gh 2.101.0 is built with Go 1.27.1.
   - The 1.6.0 publish went through `tools/gh-shim.sh`, a curl-based stand-in
     for the six `gh` calls `release-macos.sh` makes. It keeps the token off
     the command line. To use it, put a directory containing it, named `gh`,
     first on `PATH`.
3. **Known gaps**, as recorded by the agents that built each item:
   - **Hooks:** only `command` hooks run. The `http`, `prompt`, `agent` and
     `mcp_tool` types are reported but not run, and PreCompact is not wired.
   - **Relay:** commands that are still pending never expire; only claimed
     ones are leased.
   - **Proxy:** a stream abandoned before the provider's usage event is billed
     at a character floor.
   - **Sandbox:** the Gradle, Maven and CocoaPods caches are still shared with
     the reader.
   - **Rewind:** changes made by shell commands are not captured, as in
     Claude Code.
   - The `check-native-design` targets baseline could be lowered from 338 to
     315 (`node scripts/check-native-targets.mjs --baseline`). It was
     deliberately not done.

## Branches and worktrees

- `main` = `origin/main` = `d0997af2`.
- `release/1.6.0`: same commit as `main`, the tree the release was built from.
  Its worktree was in `/private/tmp` and was removed at pause.
- `rework/{store,compaction,checkpoints,hooks,screen,relay,proxy,feed,review-fixes,security-fixes,integration}`:
  all merged, and kept only because this record names them.
- `code-rework/handoff`: this note plus `tools/gh-shim.sh`. Worktree:
  `.claude/worktrees/code-rework-handoff`.

## Workflow run IDs (session aee0fbc2)

| Run | What it did |
|---|---|
| `wf_e4b4a444-161` | Review of the rebuild |
| `wf_4182429f-8e7` | The eight items |
| `wf_88a02ce1-cdc` | Security review |
| `wf_3e68ca63-c22` | Integration |
| `wf_79073104-a0e` | Pre-release review |

The journals are under
`~/.claude/projects/-Users-liammagnier-Developer-project-juno/aee0fbc2-f56e-405d-b054-497d066eb589/subagents/workflows/`.
