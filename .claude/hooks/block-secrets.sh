#!/usr/bin/env bash
# PreToolUse hook: hard-block Write/Edit on Leash secret files.
#
# Triggered by .claude/settings.json on Write|Edit tool calls.
# Reads the tool-call JSON on stdin, extracts file_path, and exits 2
# (which Claude Code treats as "deny this tool call") if the target
# matches a known secret path.
#
# Defended paths:
#   - any .env / .env.* file
#   - any session-key.json (CLAUDE.md rule: "session keys never touch disk")
#
# This is defense-in-depth on top of settings.json's permissions.deny —
# the deny list silently rejects, the hook surfaces a clear error.

set -euo pipefail

input=$(cat)
path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')

if [ -z "$path" ]; then
  exit 0
fi

case "$path" in
  */.env|*/.env.*|.env|.env.*|*/session-key.json|session-key.json)
    cat >&2 <<EOF
BLOCKED by .claude/hooks/block-secrets.sh

Refusing to Write/Edit a Leash secret file:
  $path

Per CLAUDE.md:
  - "Session keys never touch disk." (session-key.json)
  - ".env is for local secrets only. Never commit one." (.env*)

If you genuinely need to modify this file, do it outside Claude Code.
EOF
    exit 2
    ;;
esac

exit 0
