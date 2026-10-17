#!/usr/bin/env bash
# The wave-2 base gate (spec §14, P0 (1)). Every wave-2 worktree is cut from
# main only after this passes, and each package PR prints the base SHA it shows.
#
#   bash scripts/qa/check-base.sh [--repo <dir>] [--wave1 <sha>]... [--main-branch <name>]
#
# Fails (exit 1) unless all of these hold:
#   1. `git diff --name-only --diff-filter=U` is empty (no unmerged paths).
#   2. The wave-1 integration commit 244366124 (or its merge into main, if main
#      squashed it: add that SHA to WAVE1_COMMITS below) is an ancestor of HEAD.
#   3. Main CI is green: every check run on main's head commit on GitHub has
#      completed as success, neutral or skipped, and its combined commit status
#      (if it has any statuses) is success. Read with the GitHub CLI; if CI
#      cannot be read, the gate fails rather than guessing.
#
# --wave1 replaces the default commit list (fixture repos use it).
set -Euo pipefail

WAVE1_COMMITS=(244366124)
REPO=""
MAIN_BRANCH="main"
CUSTOM_WAVE1=()
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:-}"; shift 2 ;;
    --wave1) CUSTOM_WAVE1+=("${2:-}"); shift 2 ;;
    --main-branch) MAIN_BRANCH="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "check-base: unknown argument $1" >&2; exit 64 ;;
  esac
done
if [ "${#CUSTOM_WAVE1[@]}" -gt 0 ]; then WAVE1_COMMITS=("${CUSTOM_WAVE1[@]}"); fi
case "$MAIN_BRANCH" in ''|*[!A-Za-z0-9._/-]*) echo "check-base: bad --main-branch" >&2; exit 64 ;; esac

if [ -z "$REPO" ]; then
  REPO="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "check-base: not inside a git repository." >&2; exit 1; }
fi
cd "$REPO" || exit 1

pass() { printf '  pass  %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; FAILED=1; }
FAILED=0

HEAD_SHA="$(git rev-parse HEAD 2>/dev/null)" || { echo "check-base: the repository has no HEAD." >&2; exit 1; }
echo "Wave-2 base gate"
echo "Base SHA: $HEAD_SHA"
if MERGE_BASE="$(git merge-base HEAD "$MAIN_BRANCH" 2>/dev/null)"; then
  echo "Merge base with $MAIN_BRANCH: $MERGE_BASE"
fi

# 1. Unmerged paths.
UNMERGED="$(git diff --name-only --diff-filter=U)"
if [ -z "$UNMERGED" ]; then
  pass "no unmerged paths"
else
  fail "unmerged paths:"
  printf '%s\n' "$UNMERGED" | sed 's/^/          /'
fi

# 2. Wave 1 is in the history.
FOUND=""
for commit in "${WAVE1_COMMITS[@]}"; do
  if git cat-file -e "${commit}^{commit}" 2>/dev/null && git merge-base --is-ancestor "$commit" HEAD 2>/dev/null; then
    FOUND="$commit"
    break
  fi
done
if [ -n "$FOUND" ]; then
  pass "wave-1 integration commit $FOUND is an ancestor of HEAD"
else
  fail "none of the wave-1 commits (${WAVE1_COMMITS[*]}) is an ancestor of HEAD (fetch main, or rebase onto it)"
fi

# 3. Main CI.
if ! command -v gh >/dev/null 2>&1; then
  fail "main CI could not be read: the GitHub CLI (gh) is not installed"
else
  CI_SHA="$(gh api "repos/{owner}/{repo}/commits/$MAIN_BRANCH" --jq '.sha' 2>/dev/null)"
  CHECKS="$(gh api "repos/{owner}/{repo}/commits/$CI_SHA/check-runs?per_page=100" \
    --jq '.check_runs[] | [.name, .status, (.conclusion // "")] | @tsv' 2>/dev/null)"
  CHECKS_STATUS=$?
  STATUS_LINE="$(gh api "repos/{owner}/{repo}/commits/$CI_SHA/status" \
    --jq '[.statuses[] | select(.context != "Vercel")] as $checks | (if any($checks[]; .state == "failure" or .state == "error") then "failure" elif any($checks[]; .state != "success") then "pending" else "success" end) + " " + ($checks | length | tostring)' 2>/dev/null)"
  STATUS_STATUS=$?
  if [ "$CHECKS_STATUS" -ne 0 ] || [ "$STATUS_STATUS" -ne 0 ]; then
    fail "main CI could not be read from GitHub (gh api failed; is gh signed in?)"
  else
    total=0; bad=()
    while IFS=$'\t' read -r name status conclusion; do
      [ -z "${name:-}" ] && continue
      # The owner explicitly excludes Vercel: production ships through Actions.
      case "$name" in Vercel|"Vercel Preview Comments") continue ;; esac
      total=$((total + 1))
      if [ "$status" != "completed" ]; then
        bad+=("$name: $status")
      else
        case "$conclusion" in
          success|neutral|skipped) ;;
          *) bad+=("$name: ${conclusion:-no conclusion}") ;;
        esac
      fi
    done <<< "$CHECKS"
    read -r combined_state combined_total <<< "$STATUS_LINE"
    if [ "${combined_total:-0}" -gt 0 ] && [ "$combined_state" != "success" ]; then
      bad+=("combined commit status: $combined_state")
    fi
    label="$MAIN_BRANCH${CI_SHA:+ at ${CI_SHA:0:9}}"
    if [ -n "${CI_SHA:-}" ] && [ -n "${MERGE_BASE:-}" ] && [ "$CI_SHA" != "$MERGE_BASE" ]; then
      fail "HEAD does not include $MAIN_BRANCH at ${CI_SHA:0:9}; update the base before building wave 2"
    fi
    if [ "$total" -eq 0 ]; then
      fail "main CI has no check runs for $label"
    elif [ "${#bad[@]}" -eq 0 ]; then
      pass "main CI is green for $label ($total checks)"
    else
      fail "main CI is not green for $label (${#bad[@]} of $total):"
      printf '          %s\n' "${bad[@]}"
    fi
  fi
fi

if [ "$FAILED" -ne 0 ]; then
  echo "Base gate: FAIL. Do not cut a wave-2 worktree from this base."
  exit 1
fi
echo "Base gate: pass. Cut wave-2 worktrees from $HEAD_SHA."
