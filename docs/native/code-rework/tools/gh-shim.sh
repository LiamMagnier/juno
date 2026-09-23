#!/bin/bash
#
# A stand-in for the few `gh` calls native/Scripts/release-macos.sh makes, over
# curl. On 2026-09-23 every TLS handshake from `gh` (Go 1.27) to api.github.com
# stalled on this Mac's network while curl's succeeded, so the release script
# could not reach GitHub through the real CLI. This speaks the same REST calls
# with the same stored credential (`gh auth token`, which needs no network) and
# keeps the token out of argv by handing it to curl on stdin.
#
# Supported, exactly as the release script uses them:
#   gh auth status --hostname github.com
#   gh api [--include] [--method M] <path> [-F key=value ...]
#   gh release create <tag> <files...> --repo R --target SHA --draft --title T --notes N
set -uo pipefail

REAL_GH="${REAL_GH:-/opt/homebrew/bin/gh}"
API="https://api.github.com"
UPLOADS="https://uploads.github.com"

TOKEN="$("$REAL_GH" auth token --hostname github.com 2>/dev/null)" || TOKEN=""
if [ -z "$TOKEN" ]; then
  echo "gh-shim: no stored GitHub token (gh auth token failed)" >&2
  exit 4
fi

# curl with the token supplied as a config line on stdin, never on the command line.
authed_curl() {
  printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" | curl -sS -K - \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    -H "User-Agent: juno-release-gh-shim" \
    "$@"
}

# gh's -F: true/false/null and integers are sent typed; anything else as a string.
fields_json() {
  python3 - "$@" <<'PY'
import json, re, sys
out = {}
for arg in sys.argv[1:]:
    key, _, value = arg.partition("=")
    if value in ("true", "false"):
        out[key] = value == "true"
    elif value == "null":
        out[key] = None
    elif re.fullmatch(r"-?[0-9]+", value):
        out[key] = int(value)
    else:
        out[key] = value
print(json.dumps(out))
PY
}

cmd_auth() {
  # `auth status`: succeed only if the token actually works.
  local code
  code="$(authed_curl -o /dev/null -w '%{http_code}' "$API/user")" || return 1
  [ "$code" = "200" ]
}

cmd_api() {
  local include=0 method="" path="" fields=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --include|-i) include=1; shift ;;
      --method|-X) method="$2"; shift 2 ;;
      -F|--field|-f|--raw-field) fields+=("$2"); shift 2 ;;
      -*) echo "gh-shim: unsupported api flag $1" >&2; return 2 ;;
      *) path="$1"; shift ;;
    esac
  done
  [ -n "$path" ] || { echo "gh-shim: api needs a path" >&2; return 2; }
  path="${path#/}"
  if [ -z "$method" ]; then
    if [ "${#fields[@]}" -gt 0 ]; then method=POST; else method=GET; fi
  fi

  local body_file header_file code
  body_file="$(mktemp)"; header_file="$(mktemp)"
  local data_args=()
  if [ "${#fields[@]}" -gt 0 ]; then
    fields_json "${fields[@]}" > "$body_file.req"
    data_args=(-H "Content-Type: application/json" --data-binary "@$body_file.req")
  fi
  code="$(authed_curl -X "$method" -D "$header_file" -o "$body_file" -w '%{http_code}' \
    ${data_args[@]+"${data_args[@]}"} "$API/$path")" || { rm -f "$body_file" "$body_file.req" "$header_file"; return 1; }
  if [ "$include" = 1 ]; then
    tr -d '\r' < "$header_file"
  fi
  cat "$body_file"
  rm -f "$body_file" "$body_file.req" "$header_file"
  if [ "$code" -ge 400 ]; then
    echo "gh: HTTP $code" >&2
    return 1
  fi
  return 0
}

content_type_for() {
  case "$1" in
    *.dmg) echo "application/x-apple-diskimage" ;;
    *.zip) echo "application/zip" ;;
    *.json) echo "application/json" ;;
    *.txt) echo "text/plain" ;;
    *) echo "application/octet-stream" ;;
  esac
}

cmd_release_create() {
  local tag="$1"; shift
  local files=() repo="" target="" draft=false title="" notes=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --repo|-R) repo="$2"; shift 2 ;;
      --target) target="$2"; shift 2 ;;
      --draft|-d) draft=true; shift ;;
      --title|-t) title="$2"; shift 2 ;;
      --notes|-n) notes="$2"; shift 2 ;;
      -*) echo "gh-shim: unsupported release create flag $1" >&2; return 2 ;;
      *) files+=("$1"); shift ;;
    esac
  done
  [ -n "$repo" ] && [ "$draft" = true ] || { echo "gh-shim: release create needs --repo and --draft" >&2; return 2; }

  local request response code release_id
  request="$(mktemp)"; response="$(mktemp)"
  python3 - "$tag" "$target" "$title" "$notes" > "$request" <<'PY'
import json, sys
tag, target, title, notes = sys.argv[1:5]
body = {"tag_name": tag, "name": title, "body": notes, "draft": True, "prerelease": False}
if target:
    body["target_commitish"] = target
print(json.dumps(body))
PY
  code="$(authed_curl -X POST -H "Content-Type: application/json" --data-binary "@$request" \
    -o "$response" -w '%{http_code}' "$API/repos/$repo/releases")" || { rm -f "$request" "$response"; return 1; }
  if [ "$code" != "201" ]; then
    echo "gh-shim: creating the draft release failed (HTTP $code)" >&2
    cat "$response" >&2
    rm -f "$request" "$response"
    return 1
  fi
  release_id="$(jq -r '.id' "$response")"
  rm -f "$request" "$response"

  local file name upload_code
  for file in "${files[@]}"; do
    name="$(basename "$file")"
    upload_code="$(authed_curl -X POST \
      -H "Content-Type: $(content_type_for "$name")" \
      --data-binary "@$file" -o /dev/null -w '%{http_code}' \
      "$UPLOADS/repos/$repo/releases/$release_id/assets?name=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$name")")" || return 1
    if [ "$upload_code" != "201" ]; then
      echo "gh-shim: uploading $name failed (HTTP $upload_code); draft release $release_id left in place" >&2
      return 1
    fi
    echo "uploaded $name"
  done
  echo "https://github.com/$repo/releases/tag/$tag"
}

case "${1:-}" in
  auth)
    [ "${2:-}" = "status" ] || { echo "gh-shim: only 'auth status' is supported" >&2; exit 2; }
    cmd_auth ;;
  api)
    shift; cmd_api "$@" ;;
  release)
    [ "${2:-}" = "create" ] || { echo "gh-shim: only 'release create' is supported" >&2; exit 2; }
    shift 2; cmd_release_create "$@" ;;
  *)
    echo "gh-shim: unsupported command: $*" >&2; exit 2 ;;
esac
