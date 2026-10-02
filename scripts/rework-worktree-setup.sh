#!/usr/bin/env bash
#
# Make a fresh git worktree of this repo ready for a chat-rework workstream
# (docs/chat-rework/SPEC.md §12.1, "Worktree setup").
#
# A worktree has the sources and nothing else. `npm install` in each one would
# cost a gigabyte and minutes per workstream, so node_modules is a directory of
# symlinks into the main checkout's instead. Three entries cannot be shared:
#
#   @prisma, .prisma   `prisma generate` writes the client for THIS worktree's
#                      schema into them. Symlinked, it would overwrite the main
#                      checkout's generated client with a branch's schema.
#   .cache             tools (jiti, Next) write build caches there. It starts
#                      empty rather than inheriting another checkout's.
#
# Then the three things `npm run typecheck` needs that are not in git: the
# generated Prisma client, `runner/agent-core/dist` (the web app imports its
# declarations) and the generated i18n catalog.
#
# Idempotent: run it again after the main checkout's dependencies change.
#
# Usage:
#   bash scripts/rework-worktree-setup.sh /path/to/new/worktree
#   JUNO_MAIN_CHECKOUT=/elsewhere/juno bash scripts/rework-worktree-setup.sh …
set -euo pipefail

MAIN="${JUNO_MAIN_CHECKOUT:-/Users/liammagnier/Developer/project/juno}"

die() {
  echo "rework-worktree-setup: $*" >&2
  exit 1
}

[ $# -eq 1 ] || die "usage: bash scripts/rework-worktree-setup.sh /path/to/new/worktree"
[ -d "$1" ] || die "no such directory: $1"
TARGET="$(cd "$1" && pwd -P)"
MAIN="$(cd "$MAIN" && pwd -P)"

[ -d "$MAIN/node_modules" ] || die "the main checkout has no node_modules: $MAIN"
[ "$TARGET" != "$MAIN" ] || die "refusing to rewire the main checkout's own node_modules"
[ -f "$TARGET/package.json" ] && [ -f "$TARGET/prisma/schema.prisma" ] || die "not a checkout of this repo: $TARGET"
git -C "$TARGET" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not a git worktree: $TARGET"

MODULES="$TARGET/node_modules"
if [ -L "$MODULES" ]; then
  die "$MODULES is a symlink; remove it first (a shared node_modules would share the generated Prisma client)"
fi
mkdir -p "$MODULES"

# ── 1. node_modules: symlinks, except @prisma, .prisma and .cache ───────────────

echo "Linking node_modules from $MAIN"
shopt -s nullglob dotglob
for entry in "$MAIN/node_modules"/*; do
  name="$(basename "$entry")"
  case "$name" in
    @prisma | .prisma | .cache) continue ;;
  esac
  link="$MODULES/$name"
  # Never replace a real directory: something in this worktree put it there on purpose.
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    echo "  keeping the real $name"
    continue
  fi
  ln -sfn "$entry" "$link"
done

# Links to packages the main checkout no longer has.
for link in "$MODULES"/*; do
  if [ -L "$link" ] && [ ! -e "$link" ]; then
    echo "  removing the dangling link $(basename "$link")"
    rm "$link"
  fi
done
shopt -u nullglob dotglob

# Real copies, refreshed every run so their version always matches the linked
# `prisma` CLI. Only ever inside this worktree's own node_modules.
for name in @prisma .prisma; do
  copy="$MODULES/$name"
  if [ -L "$copy" ]; then
    rm "$copy"
  elif [ -d "$copy" ]; then
    rm -rf "${copy:?}"
  fi
  if [ -d "$MAIN/node_modules/$name" ]; then
    echo "Copying node_modules/$name"
    cp -R "$MAIN/node_modules/$name" "$copy"
  fi
done

if [ -L "$MODULES/.cache" ]; then
  rm "$MODULES/.cache"
fi
mkdir -p "$MODULES/.cache"

# ── 2. The runner's dependencies: shared, as the web app's are ──────────────────

RUNNER_MODULES="$TARGET/runner/agent-core/node_modules"
if [ -e "$RUNNER_MODULES" ] && [ ! -L "$RUNNER_MODULES" ]; then
  echo "Keeping the real runner/agent-core/node_modules"
else
  [ -d "$MAIN/runner/agent-core/node_modules" ] || die "the main checkout has no runner/agent-core/node_modules"
  ln -sfn "$MAIN/runner/agent-core/node_modules" "$RUNNER_MODULES"
fi

# ── 3–5. What typecheck needs and git does not carry ────────────────────────────

cd "$TARGET"

echo "Generating the Prisma client"
npx prisma generate

echo "Building runner/agent-core/dist"
npx tsc -p runner/agent-core/tsconfig.json

echo "Generating the i18n catalog"
npm run i18n:extract

echo "Ready: $TARGET"
