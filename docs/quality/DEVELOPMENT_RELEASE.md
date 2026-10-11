# Private development release verification

Run from a clean committed checkout with Node 24, Xcode and an installed iPhone
simulator. No paid Apple membership is needed. The runner refuses dirty sources,
unfinished Git integrations and local .env files, and supplies a minimal environment
so deployment credentials cannot accidentally enter its tests or web build.

```sh
python3 scripts/development-release.py --output /tmp/alevr-candidate-001 --plan
python3 scripts/development-release.py --output /tmp/alevr-candidate-001
```

Each run needs a new output directory outside the repository. `--plan` prints
planned commands; it is never candidate evidence. Actual execution installs locked
dependencies, runs existing shared security/contract/migration/runner/relay gates,
checks native contracts/assets/design rules, builds the env bundle and web, tests
four Swift packages strictly, and builds/tests Mac Debug, Mac Stable and the iOS
simulator target. Real failures stop execution. The existing Swift helper permits
one bounded retry only for a timed-out test process, with a clean scratch directory;
ordinary failures are never retried. All attempts remain in that check's log.

Mac Debug and Stable use separate derived-data directories. All app builds disable
signing and embed the full exact source SHA, overriding stale local build metadata.
The runner checks the commit and worktree before/after every step and compares
both native bundles' declared SHA before creating archives. No check-skipping flags
exist. The web build's JS heap was raised from 4 to 8 GiB after the 4 GiB build
exhausted memory; the 8 GiB build completed locally with 231 generated pages.

`manifest.json` records tool versions, exact SHA, commands, exit codes, durations,
log checksums, artifact checksums and distribution limits. A failed or incomplete
run cannot receive `verified-development`. The manifest also has a separate
SHA-256 checksum. Inspect each archive checksum and retain the source commit and
manifest together. The web archive contains build output, public files and lockfiles;
it is build evidence, not a production deployment bundle or automatic installer.

```sh
cd /tmp/alevr-candidate-001
shasum -a 256 -c manifest.sha256
```

These unsigned archives are for private Xcode/development testing. They are not
notarized public releases, device installs, hardware acceptance or production
verification. Gatekeeper may refuse an unsigned Mac archive; run through the
development environment and follow macOS's per-app controls where appropriate.
Never disable Gatekeeper globally. Physical iPhone testing can use a personal Xcode
team with Apple's free-provisioning limitations; simulator archives alone cannot
prove microphone, Bluetooth or cross-device behavior.

## Evidence status

Five regression tests verify dirty/untracked rejection, a required check failing
before later checks run, source mutation after a green check, stale bundle rejection,
and refusal to certify without complete checks and artifacts. They run in shared
local gates. Existing local web/native evidence predates this runner and does not
count as a sealed candidate. Three consecutive passing candidates are still a target;
no candidate count or production readiness is inferred from those earlier logs.
