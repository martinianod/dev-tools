#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT_DIR"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example. Review it if needed."
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

docker compose up -d

echo "SonarQube starting at: http://localhost:${SONARQUBE_PORT:-9000}"
echo "Initial credentials: admin/admin. Change the password on first login."
