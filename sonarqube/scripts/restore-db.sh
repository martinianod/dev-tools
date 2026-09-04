#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT_DIR"

backup_file="${1:-}"
if [ -z "$backup_file" ] || [ ! -f "$backup_file" ]; then
  echo "Usage: $0 backups/sonarqube-YYYYMMDD-HHMMSS.dump"
  exit 1
fi

if [ ! -f .env ]; then
  echo "ERROR: .env does not exist. Run ./scripts/up.sh first or copy .env.example to .env."
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

cat <<'MSG'
This will restore a PostgreSQL dump into the SonarQube database.
The current database contents can be overwritten.

Type RESTORE-SONARQUBE to continue.
MSG

read -r confirmation
if [ "$confirmation" != "RESTORE-SONARQUBE" ]; then
  echo "Restore cancelled."
  exit 0
fi

docker compose up -d sonarqube-db
docker compose stop sonarqube >/dev/null 2>&1 || true

docker compose exec -T sonarqube-db pg_restore \
  -U "${POSTGRES_USER:-sonar}" \
  -d "${POSTGRES_DB:-sonarqube}" \
  --clean \
  --if-exists \
  --no-owner < "$backup_file"

docker compose up -d sonarqube
echo "Restore completed from: $backup_file"
