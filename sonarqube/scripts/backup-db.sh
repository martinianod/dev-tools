#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT_DIR"

if [ ! -f .env ]; then
  echo "ERROR: .env does not exist. Run ./scripts/up.sh first or copy .env.example to .env."
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

db_container="$(docker compose ps -q sonarqube-db)"
if [ -z "$db_container" ]; then
  echo "ERROR: sonarqube-db is not running. Start SonarQube before creating a backup."
  exit 1
fi

mkdir -p backups
timestamp="$(date +%Y%m%d-%H%M%S)"
backup_file="backups/sonarqube-${timestamp}.dump"

docker compose exec -T sonarqube-db pg_dump \
  -U "${POSTGRES_USER:-sonar}" \
  -d "${POSTGRES_DB:-sonarqube}" \
  -Fc > "$backup_file"

echo "Backup created: $ROOT_DIR/$backup_file"
