#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${ROOT_DIR}"

: "${SONAR_TOKEN:?Falta SONAR_TOKEN. Exportalo en la shell o en el entorno del worker; no lo escribas en archivos ni en el comando.}"

SONAR_HOST_URL="${SONAR_HOST_URL:-http://localhost:9000}"
SONAR_SCANNER_MODE="${SONAR_SCANNER_MODE:-cli}"
SONAR_JAVASCRIPT_NODE_MAXSPACE="${SONAR_JAVASCRIPT_NODE_MAXSPACE:-4096}"
SONAR_SCANNER_JAVA_OPTS="${SONAR_SCANNER_JAVA_OPTS:--Xmx768m}"
SONAR_USER_HOME="${SONAR_USER_HOME:-${ROOT_DIR}/.sonar}"
SONAR_SKIP_AUTH_CHECK="${SONAR_SKIP_AUTH_CHECK:-0}"

if [ "${SONAR_SCANNER_DOCKER:-0}" = "1" ]; then
  SONAR_SCANNER_MODE="docker"
fi

if [ "${SONAR_SKIP_AUTH_CHECK}" != "1" ] && command -v curl >/dev/null 2>&1; then
  auth_response="$(curl -fsS -u "${SONAR_TOKEN}:" "${SONAR_HOST_URL%/}/api/authentication/validate" 2>/dev/null || true)"
  if ! printf '%s' "${auth_response}" | grep -q '"valid"[[:space:]]*:[[:space:]]*true'; then
    echo "ERROR: SonarQube no valido el token contra ${SONAR_HOST_URL}." >&2
    echo "Un intento fallido no consume ni invalida un token; si fue expuesto, revocalo por seguridad." >&2
    exit 1
  fi
fi

SONAR_TYPESCRIPT_TSCONFIG_PATHS="${SONAR_TYPESCRIPT_TSCONFIG_PATHS:-tsconfig.json}"
scanner_host_url="${SONAR_HOST_URL}"
if [ "${SONAR_SCANNER_MODE}" = "docker" ] && [[ "${scanner_host_url}" == http://localhost:* || "${scanner_host_url}" == http://127.0.0.1:* ]]; then
  scanner_host_url="${SONAR_DOCKER_HOST_URL:-http://host.docker.internal:9000}"
fi

export SONAR_HOST_URL SONAR_TOKEN SONAR_JAVASCRIPT_NODE_MAXSPACE SONAR_SCANNER_JAVA_OPTS SONAR_USER_HOME SONAR_TYPESCRIPT_TSCONFIG_PATHS
mkdir -p reports/sonar "${SONAR_USER_HOME}"

scanner_args=(
  "-Dsonar.host.url=${scanner_host_url}"
  "-Dsonar.javascript.node.maxspace=${SONAR_JAVASCRIPT_NODE_MAXSPACE}"
  "-Dsonar.typescript.tsconfigPaths=${SONAR_TYPESCRIPT_TSCONFIG_PATHS}"
)

echo "Running SonarQube analysis for panorama-mercados"

if command -v sonar-scanner >/dev/null 2>&1 && [ "${SONAR_SCANNER_MODE}" = "cli" ]; then
  sonar-scanner "${scanner_args[@]}"
elif [ "${SONAR_SCANNER_MODE}" = "docker" ]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: SONAR_SCANNER_MODE=docker pero docker no esta disponible." >&2
    exit 1
  fi
  docker_image="${SONAR_SCANNER_DOCKER_IMAGE:-sonarsource/sonar-scanner-cli@sha256:23ca0f137965d9dff2198074043fd48d386280bc5d0ccac8c8349cea4cf096a9}"
  docker run --rm \
    -e SONAR_HOST_URL="${scanner_host_url}" \
    -e SONAR_TOKEN \
    -e SONAR_USER_HOME=/opt/sonar-scanner/.sonar \
    -v "${SONAR_USER_HOME}:/opt/sonar-scanner/.sonar" \
    -v "${ROOT_DIR}:/usr/src" \
    -w /usr/src \
    "${docker_image}" \
    "${scanner_args[@]}"
else
  echo "ERROR: sonar-scanner no esta instalado o no esta en PATH." >&2
  exit 1
fi
