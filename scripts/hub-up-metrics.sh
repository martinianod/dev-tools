#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

docker compose --profile core --profile metrics up -d

echo "Engineering Control Center + metrics:"
echo "- UI:         http://localhost:${HUB_WEB_PORT:-18000}"
echo "- API:        http://localhost:${HUB_API_PORT:-18080}"
echo "- Grafana:    http://localhost:${GRAFANA_PORT:-13000}"
echo "- Prometheus: http://localhost:${PROMETHEUS_PORT:-19090}"
