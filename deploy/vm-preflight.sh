#!/usr/bin/env bash
# The VM half of a deploy's preflight. Both callers pipe it to the VM before
# they upload anything, naming the directory their upload will go into:
#
#   deploy/deploy-from-mac.sh      vm "UPLOAD_DIR='…' bash -s" < deploy/vm-preflight.sh
#   .github/workflows/deploy.yml   ssh … "UPLOAD_DIR='…' bash -s" < deploy/vm-preflight.sh
#
# It frees disk space for the upload and then creates UPLOAD_DIR, and does both
# holding the lock deploy.sh holds for a whole release transaction. It used to
# be an inline script in each caller that took no lock at all: run beside
# another deploy, it deleted that deploy's archive and build artifact out of
# /tmp, so the deploy failed its checksum or tar step, and its half-built
# release out of releases/, and the upload that followed overwrote whatever was
# left, because uploads were named for the commit rather than for the run.
#
# While anything else holds the lock this changes nothing and says who holds it.
# Once it holds the lock no release transaction is in progress, so staged
# releases, and releases that are neither current nor previous, are nobody's.
# Uploads are different: a run holds no lock between this preflight and its
# deploy.sh, so another run's upload is removed only once it is abandoned.
set -euo pipefail

LIVE_ROOT="$HOME/juno"
# deploy.sh locks .deploy.lock in the directory that holds `current`, and both
# callers hand it JUNO_CURRENT_LINK="$LIVE_ROOT/current".
LOCK_FILE="$LIVE_ROOT/.deploy.lock"
# A run that is uploading writes to its files as it goes, and one that has
# finished only verifies them before deploy.sh takes the lock. An hour is twice
# the CI deploy job's whole timeout, so no live run's upload is ever this stale.
ABANDONED_AFTER_MINUTES=60

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

UPLOAD_DIR="${UPLOAD_DIR:-}"
case "$UPLOAD_DIR" in
  /*) ;;
  *) fail "UPLOAD_DIR must be the absolute path of the directory this run uploads into, not '$UPLOAD_DIR'." ;;
esac
case "${UPLOAD_DIR##*/}" in
  juno-upload-?*) ;;
  *) fail "UPLOAD_DIR must be named juno-upload-<run id>: $UPLOAD_DIR" ;;
esac
UPLOAD_ROOT="${UPLOAD_DIR%/*}"
RUN_ID="${UPLOAD_DIR##*/juno-upload-}"
[ -d "$UPLOAD_ROOT" ] || fail "The upload root $UPLOAD_ROOT does not exist."
[ -d "$LIVE_ROOT" ] || fail "Live root $LIVE_ROOT is missing."
command -v flock >/dev/null 2>&1 || fail "flock (util-linux) is required on the VM."

umask 077
# Taken as deploy.sh's acquire_deploy_lock takes it: on a descriptor opened for
# append, so a run that is refused reads the holder's note instead of
# truncating it, and then with a note of its own for whoever is refused next.
exec 9>>"$LOCK_FILE"
if ! flock -n 9; then
  holder="$(cat -- "$LOCK_FILE" 2>/dev/null || true)"
  fail "Another deployment is already running${holder:+ ($holder)}: $LOCK_FILE"
fi
printf 'pid %s since %s, preflight of run %s\n' "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$RUN_ID" > "$LOCK_FILE" || true

# Freeing space is best effort, as it always was: a find that trips over a file
# something else removed mid-scan must not cost the deploy.
releases="$LIVE_ROOT/releases"
# Old releases are deleted here only when space is short (under 5 GB free):
# a release is tens of thousands of files, and on a VM under memory pressure
# deleting one held a deploy for 15 minutes (2026-10-02). deploy.sh prunes to
# two releases after every successful activation either way.
free_kb="$(df -Pk -- "$LIVE_ROOT" 2>/dev/null | awk 'NR == 2 { print $4 }')"
if [ -d "$releases" ]; then
  find "$releases" -mindepth 1 -maxdepth 1 -name '.staging-*' -exec rm -rf -- {} + 2>/dev/null || true
fi
prune_below_kb="${JUNO_PRUNE_BELOW_KB:-5242880}"
if [ -d "$releases" ] && { [ -z "$free_kb" ] || [ "$free_kb" -lt "$prune_below_kb" ]; }; then
  current_target="$(readlink -f "$LIVE_ROOT/current" 2>/dev/null || true)"
  previous_target="$(readlink -f "$LIVE_ROOT/previous" 2>/dev/null || true)"
  find "$releases" -mindepth 1 -maxdepth 1 -type d ! -name '.*' | sort | while IFS= read -r dir; do
    real_dir="$(cd -- "$dir" 2>/dev/null && pwd -P || printf '%s\n' "$dir")"
    if [ "$real_dir" != "$current_target" ] && [ "$real_dir" != "$previous_target" ]; then
      echo "Pruning older release: $dir"
      rm -rf -- "$dir" || true
    fi
  done || true
fi

for dir in "$UPLOAD_ROOT"/juno-upload-*; do
  [ -d "$dir" ] && [ ! -L "$dir" ] || continue
  # Written to within the hour: a run may still be uploading into it, or be
  # about to hand it to deploy.sh. A directory find cannot read is left alone.
  recent="$(find "$dir" -mmin "-$ABANDONED_AFTER_MINUTES" -print -quit 2>/dev/null)" || continue
  [ -z "$recent" ] || continue
  echo "Removing abandoned upload: $dir"
  rm -rf -- "$dir" || true
done
# Before per-run directories, uploads were named for the commit and written
# straight into the upload root. An older copy of either caller still does that.
find "$UPLOAD_ROOT" -mindepth 1 -maxdepth 1 -type f \
  \( -name 'juno-*.tar.gz' -o -name 'juno-*.sha256' -o -name 'juno-*.env' \) \
  -mmin "+$ABANDONED_AFTER_MINUTES" | while IFS= read -r file; do
  echo "Removing abandoned upload: $file"
  rm -f -- "$file" || true
done || true

df -h "$HOME" | tail -1 || true
# Created here and nowhere else. A name that is already taken belongs to
# another run, which will remove it when it ends, so it is never reused.
if [ -e "$UPLOAD_DIR" ] || [ -L "$UPLOAD_DIR" ]; then
  fail "Upload directory $UPLOAD_DIR already exists: run id $RUN_ID is another run's."
fi
mkdir -m 700 -- "$UPLOAD_DIR"
echo "Upload directory for run $RUN_ID: $UPLOAD_DIR"
