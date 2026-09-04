#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

docker compose stop \
  sonarqube \
  sonar-postgres \
  jenkins \
  prometheus \
  grafana \
  loki \
  tempo \
  tempo-init \
  otel-collector \
  alertmanager \
  blackbox \
  cadvisor

echo "Heavy services stopped. Volumes were preserved."
