#!/bin/bash
# Shared offline gates for CI, Mac VM deployment and Mac publication.
# Dependencies (root, relay, runner/agent-core) must already be installed.
# Full runs include isolated migration replay; web build containers may receive
# --without-migrations only after the caller has run --migrations-only on the host.
set -Eeuo pipefail
export PYTHONDONTWRITEBYTECODE=1
cd "$(dirname "$0")/.."
if [ "${1:-}" = "--migrations-only" ]; then
  node scripts/check-local-migrations.mjs "${2:-HEAD}"
  exit
fi
if [ "${1:-}" != "--without-migrations" ]; then
  node scripts/check-local-migrations.mjs
fi
# No bypass here, on purpose. CI, the Mac release and the Mac deploy all call
# this script, and an inherited SKIP_CHECKS=1 used to turn every one of them
# into a silent exit 0 (a leftover export was enough). The one emergency path
# is deploy-from-mac.sh --skip-checks=<reason>, which never calls this script,
# still runs the fast security gates, and records the bypass on this Mac and
# on the VM. See docs/rework/SECURITY_REVIEW_2026-10-02.md.
if [ -n "${SKIP_CHECKS:-}" ]; then
  echo "SKIP_CHECKS is set in the environment and is ignored: the shared gates always run." >&2
fi
step() { printf '\n--> %s\n' "$*"; }
step "Generated runtime inputs"
npm run i18n:extract
npm run models:capabilities:audit
npm run build --prefix runner/agent-core
step "Typecheck, tests and lint (in parallel)"
# The three are independent; running them together cuts several minutes off CI.
gate_logs="$(mktemp -d)"
npm run typecheck >"$gate_logs/typecheck.log" 2>&1 & pid_typecheck=$!
npm run lint >"$gate_logs/lint.log" 2>&1 & pid_lint=$!
npm test >"$gate_logs/test.log" 2>&1 & pid_test=$!
gate_failed=0
for name in typecheck lint test; do
  pid_var="pid_$name"
  if wait "${!pid_var}"; then
    echo "  pass  $name"
  else
    echo "  FAIL  $name (log below)"; cat "$gate_logs/$name.log"; gate_failed=1
  fi
done
[ "$gate_failed" -eq 0 ] || exit 1
step "Security and approval dispatch"
npm run security:check
node scripts/check-approval-dispatch.mjs
python3 -m unittest discover -s tests -p 'test_computer_infrastructure.py'
python3 -m unittest discover -s tests -p 'test_exec_host.py'
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
