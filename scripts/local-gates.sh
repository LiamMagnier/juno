#!/bin/bash
# Shared offline gates for CI, Mac VM deployment and Mac publication.
# Dependencies (root, relay, runner/agent-core) must already be installed.
# Full runs include isolated migration replay; web build containers may receive
# --without-migrations only after the caller has run --migrations-only on the host.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
if [ "${1:-}" = "--migrations-only" ]; then
  node scripts/check-local-migrations.mjs "${2:-HEAD}"
  exit
fi
if [ "${1:-}" != "--without-migrations" ]; then
  node scripts/check-local-migrations.mjs
fi
step() { printf '\n--> %s\n' "$*"; }
step "Generated runtime inputs"
npm run i18n:extract
npm run models:capabilities:audit
npm run build --prefix runner/agent-core
step "Typecheck, tests and lint"
npm run typecheck
npm test
npm run lint
step "Security and approval dispatch"
npm run security:check
node scripts/check-approval-dispatch.mjs
python3 -m unittest discover -s tests -p 'test_computer_infrastructure.py'
step "Generated contracts and sandbox"
for task in capabilities:check work:contract:check agent:protocol:check shell:contract:check native:wire:check design:tokens:check native:parity:check work:sandbox:check; do
  npm run "$task"
done
step "Runner and relay"
npm test --prefix runner/agent-core
npm test --prefix relay
npm run build --prefix relay
step "Release source invariants"
bash scripts/release-gates.sh
