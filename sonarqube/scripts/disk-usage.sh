#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT_DIR"

echo "Docker disk usage:"
docker system df || true

echo
echo "Sonar-related volumes:"
docker volume ls --filter name=sonar || true

echo
echo "Active local SonarQube volume details:"
docker volume inspect \
  local_sonarqube_data \
  local_sonarqube_db_data \
  local_sonarqube_extensions \
  local_sonarqube_logs \
  2>/dev/null || true

echo
echo "Legacy SonarQube volumes detected, if any:"
docker volume inspect \
  sonarqube_sonarqube_data \
  sonarqube_sonarqube_db_data \
  sonarqube_sonarqube_extensions \
  sonarqube_sonarqube_logs \
  2>/dev/null || true

echo
echo "Local configuration directory:"
du -sh "$ROOT_DIR" 2>/dev/null || true
