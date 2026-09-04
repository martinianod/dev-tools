#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

docker compose --profile core up -d

echo "Engineering Control Center lite:"
echo "- UI:  http://localhost:${HUB_WEB_PORT:-18000}"
echo "- API: http://localhost:${HUB_API_PORT:-18080}"
