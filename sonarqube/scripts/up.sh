#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT_DIR"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example. Configure POSTGRES_PASSWORD before startup."
fi
chmod 600 .env

set -a
# shellcheck disable=SC1091
. ./.env
set +a

if [ -z "${POSTGRES_PASSWORD:-}" ]; then
  echo "POSTGRES_PASSWORD must be provided in sonarqube/.env or the external environment." >&2
  exit 1
fi

if [ -z "${SONAR_ADMIN_PASSWORD:-}" ] \
  || [ "${SONAR_ADMIN_PASSWORD}" = "admin" ] \
  || [ "${#SONAR_ADMIN_PASSWORD}" -lt 12 ] \
  || [[ ! "${SONAR_ADMIN_PASSWORD}" =~ [A-Z] ]] \
  || [[ ! "${SONAR_ADMIN_PASSWORD}" =~ [a-z] ]] \
  || [[ ! "${SONAR_ADMIN_PASSWORD}" =~ [0-9] ]] \
  || [[ ! "${SONAR_ADMIN_PASSWORD}" =~ [^a-zA-Z0-9] ]]; then
  echo "SONAR_ADMIN_PASSWORD must be provided externally and satisfy the SonarQube password policy." >&2
  exit 1
fi

docker compose up -d

echo "SonarQube starting at: http://localhost:${SONARQUBE_PORT:-9000}"
echo "SonarQube will become healthy only after readiness and default-credential checks pass."
