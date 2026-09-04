#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

docker compose --profile core --profile observability --profile quality --profile ci up -d

echo "Engineering Control Center full stack:"
echo "- UI:         http://localhost:${HUB_WEB_PORT:-18000}"
echo "- API:        http://localhost:${HUB_API_PORT:-18080}"
echo "- Grafana:    http://localhost:${GRAFANA_PORT:-13000}"
echo "- Prometheus: http://localhost:${PROMETHEUS_PORT:-19090}"
echo "- SonarQube:  http://localhost:${SONARQUBE_PORT:-9000}"
echo "- Jenkins:    http://localhost:${JENKINS_PORT:-18082}"
echo
echo "Nota: Jenkins y algunas imagenes pueden requerir acceso a Docker Hub si no estan precargadas."
