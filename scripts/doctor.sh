#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PROJECTS_ROOT="${PROJECTS_ROOT:-$(dirname "$ROOT_DIR")}"
HUB_API_PORT="${HUB_API_PORT:-18080}"
HUB_WEB_PORT="${HUB_WEB_PORT:-18000}"
SONAR_HOST_URL="${SONAR_HOST_URL:-http://127.0.0.1:9000}"

pass() { printf "OK   %s\n" "$1"; }
warn() { printf "WARN %s\n" "$1"; }
fail() { printf "FAIL %s\n" "$1"; FAILED=1; }
FAILED=0

require_cmd() {
  if command -v "$1" >/dev/null 2>&1; then
    pass "$1 found"
  else
    fail "$1 not found"
  fi
}

check_port() {
  local port="$1"
  local name="$2"
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    warn "port $port is already in use ($name)"
  else
    pass "port $port is free ($name)"
  fi
}

echo "Developer Quality & Observability Hub doctor"
echo "Root: $ROOT_DIR"
echo

require_cmd node
require_cmd npm
require_cmd docker

if docker compose version >/dev/null 2>&1; then
  pass "docker compose available"
else
  fail "docker compose unavailable"
fi

if [ -d "$PROJECTS_ROOT" ]; then
  pass "PROJECTS_ROOT exists: $PROJECTS_ROOT"
else
  fail "PROJECTS_ROOT does not exist: $PROJECTS_ROOT"
fi

if [ -f .env ]; then
  pass ".env exists"
else
  warn ".env missing; copy .env.example to .env before Docker startup if you need custom values"
fi

if [ -n "${HUB_AUTH_TOKEN:-}" ] && [ ${#HUB_AUTH_TOKEN} -ge 32 ] && [ -n "${HUB_AUTH_ACTOR_ID:-}" ]; then
  pass "local mutation authentication is configured"
else
  warn "API is read-only until HUB_AUTH_TOKEN (32+ chars) and HUB_AUTH_ACTOR_ID are configured"
fi

if [ "${HUB_PRIVILEGED_EXECUTION_ENABLED:-0}" = "1" ]; then
  warn "privileged native execution is enabled; confirm loopback binding and TRUSTED_LOCAL projects"
else
  pass "privileged execution disabled by default"
fi

node --check apps/control-api/server.mjs >/dev/null && pass "control API syntax" || fail "control API syntax"
node --check apps/web/app.js >/dev/null && pass "web JS syntax" || fail "web JS syntax"
docker compose config >/dev/null && pass "compose config is valid" || fail "compose config is invalid"

check_port "$HUB_API_PORT" "control-api"
check_port "$HUB_WEB_PORT" "web"
check_port 19090 "prometheus"
check_port 13000 "grafana"
check_port 13100 "loki"
check_port 13200 "tempo"
check_port 19093 "alertmanager"

if curl -4 -fsS "$SONAR_HOST_URL/api/system/status" >/dev/null 2>&1; then
  pass "SonarQube API reachable at $SONAR_HOST_URL"
else
  warn "SonarQube API not reachable at $SONAR_HOST_URL"
fi

if curl -4 -fsS "http://127.0.0.1:${HUB_API_PORT}/healthz" >/dev/null 2>&1; then
  pass "control API health endpoint is reachable"
else
  warn "control API is not running on $HUB_API_PORT"
fi

if [ "$FAILED" -ne 0 ]; then
  echo
  echo "Doctor finished with failures."
  exit 1
fi

echo
echo "Doctor finished. Warnings may be expected before the stack is started."
