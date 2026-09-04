#!/usr/bin/env bash
set -euo pipefail

BASE_IMAGE="${BASE_IMAGE:-node:24.4.1-alpine3.22}"
APP_IMAGE="${APP_IMAGE:-developer-quality-observability-hub-control-api:latest}"

section() {
  printf '\n== %s ==\n' "$1"
}

section "Docker daemon"
if docker info >/dev/null 2>&1; then
  echo "OK: Docker daemon responde."
else
  echo "ERROR: Docker daemon no responde. Abrir Docker Desktop y esperar a que este Running." >&2
  exit 1
fi

section "Imagen del hub local"
if docker image inspect "$APP_IMAGE" >/dev/null 2>&1; then
  echo "OK: existe $APP_IMAGE."
  echo "Podés levantar sin rebuild:"
  echo "  ./scripts/hub-up-lite.sh"
  echo "  ./scripts/hub-up-metrics.sh"
else
  echo "WARN: no existe $APP_IMAGE. El primer build va a necesitar acceso a Docker Hub."
fi

section "Imagen base local"
if docker image inspect "$BASE_IMAGE" >/dev/null 2>&1; then
  echo "OK: existe $BASE_IMAGE en cache local."
else
  echo "WARN: no existe $BASE_IMAGE en cache local."
fi

section "Acceso a Docker Hub desde Docker"
tmp_log="$(mktemp)"
if docker buildx imagetools inspect "$BASE_IMAGE" >"$tmp_log" 2>&1; then
  echo "OK: Docker puede resolver y consultar Docker Hub para $BASE_IMAGE."
  rm -f "$tmp_log"
else
  echo "ERROR: Docker no pudo consultar Docker Hub para $BASE_IMAGE." >&2
  echo "Salida:" >&2
  sed -n '1,80p' "$tmp_log" >&2
  rm -f "$tmp_log"
  cat >&2 <<'EOF'

Esto suele ser DNS/proxy/VPN de Docker Desktop, no un error del repo.

Acciones recomendadas:
  1. Si la imagen del hub ya existe, levantar sin --build con ./scripts/hub-up-lite.sh.
  2. Reiniciar Docker Desktop.
  3. Revisar VPN, proxy corporativo o DNS de Docker Desktop.
  4. Probar de nuevo con:
       docker pull node:24.4.1-alpine3.22
       docker compose --profile core up -d --build

EOF
  exit 2
fi
