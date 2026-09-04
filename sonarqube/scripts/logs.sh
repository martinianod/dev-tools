#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT_DIR"

if [ "${1:-}" = "-f" ] || [ "${1:-}" = "--follow" ]; then
  echo "Following logs. Press Ctrl-C to stop watching."
  docker compose logs -f --tail=200
else
  docker compose logs --tail="${TAIL:-200}" "$@"
fi
