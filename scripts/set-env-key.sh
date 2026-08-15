#!/usr/bin/env bash
#
# Upsert one key into a .env file, safely.
#
#   ./scripts/set-env-key.sh SERPER_API_KEY
#   ./scripts/set-env-key.sh SERPER_API_KEY --reload      # also reloads pm2 (server)
#
# The VALUE is never an argument, and that is the point. A secret passed on the
# command line lands in your shell history, in `ps` output for every user on the
# box while the command runs, and in any shell-integration log your terminal
# keeps. This reads it from a silent prompt instead, so it exists only in this
# process and in the file it is written to.
#
# Three things it gets right that `echo 'KEY=…' >> .env` does not:
#
#   1. UPSERT, not append. Appending a key that is already present leaves two
#      lines; dotenv takes the last, so the file disagrees with itself and the
#      one you can see at the top is not the one in effect.
#   2. Permissions. A fresh .env written by a shell redirect is world-readable
#      on a default umask. This forces 0600.
#   3. An atomic replace via a temp file in the same directory, so an interrupted
#      write cannot leave a half-truncated .env — which on this app means the
#      next boot comes up with no DATABASE_URL.
#
# It deliberately does NOT touch the GitHub `PROD_ENV` secret: that is the
# source of truth every deploy re-syncs from, and it has to be edited where it
# lives. Set it there too, or the next deploy is the last time you see this key.

set -euo pipefail

KEY="${1:-}"
RELOAD="${2:-}"

if [ -z "$KEY" ]; then
  echo "usage: $0 <ENV_KEY_NAME> [--reload]" >&2
  exit 2
fi

if ! printf '%s' "$KEY" | grep -Eq '^[A-Z][A-Z0-9_]*$'; then
  echo "error: '$KEY' is not a plausible env key name (expected UPPER_SNAKE_CASE)." >&2
  exit 2
fi

ENV_FILE=".env"
[ -f "$ENV_FILE" ] || { : > "$ENV_FILE"; chmod 600 "$ENV_FILE"; }

# -s: no echo. -r: a backslash in a key is a backslash, not an escape.
printf 'Value for %s (input hidden): ' "$KEY" >&2
read -rs VALUE
printf '\n' >&2

if [ -z "$VALUE" ]; then
  echo "error: empty value — nothing written." >&2
  exit 2
fi

# A pasted value often carries a trailing newline or stray quotes from wherever
# it was copied. dotenv would treat those quotes as part of the secret.
VALUE="$(printf '%s' "$VALUE" | tr -d '\r\n')"
VALUE="${VALUE%\"}"; VALUE="${VALUE#\"}"
VALUE="${VALUE%\'}"; VALUE="${VALUE#\'}"

TMP="$(mktemp "${ENV_FILE}.XXXXXX")"
trap 'rm -f "$TMP"' EXIT
chmod 600 "$TMP"

# Every line that is not this key, then the key. Order does not matter to
# dotenv, and keeping the new value last makes it obvious in a diff.
grep -v "^${KEY}=" "$ENV_FILE" > "$TMP" || true
printf '%s=%s\n' "$KEY" "$VALUE" >> "$TMP"

mv "$TMP" "$ENV_FILE"
trap - EXIT
chmod 600 "$ENV_FILE"

# Confirm WITHOUT printing the secret: length and last four characters are
# enough to tell a correct paste from a truncated one.
LEN="${#VALUE}"
TAIL="$(printf '%s' "$VALUE" | tail -c 4)"
printf '%s set in %s (%d chars, ends …%s)\n' "$KEY" "$ENV_FILE" "$LEN" "$TAIL"

if [ "$RELOAD" = "--reload" ]; then
  if command -v pm2 >/dev/null 2>&1; then
    # --update-env is load-bearing: without it pm2 restarts the process with the
    # environment it was originally started with, so the new key is not seen and
    # the deploy looks like it silently did nothing.
    pm2 startOrReload deploy/ecosystem.config.js --update-env
    echo "pm2 reloaded with the new environment."
  else
    echo "pm2 not found — restart the app yourself for this to take effect." >&2
  fi
fi

echo
echo "Reminder: also add ${KEY} to the GitHub PROD_ENV secret, or the next deploy will drop it."
