#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT_DIR"

cat <<'MSG'
This will delete all SonarQube Docker volumes for this Compose project.

You will lose:
- users
- projects
- tokens
- historical analyses
- quality gates
- internal SonarQube configuration

Type RESET-SONARQUBE to continue.
MSG

read -r confirmation
if [ "$confirmation" != "RESET-SONARQUBE" ]; then
  echo "Reset cancelled."
  exit 0
fi

docker compose down -v
echo "SonarQube containers and volumes were removed."
