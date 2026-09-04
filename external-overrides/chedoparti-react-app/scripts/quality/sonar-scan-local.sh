#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${ROOT_DIR}"

: "${SONAR_TOKEN:?Falta SONAR_TOKEN. Exportalo en la shell o en el entorno del worker; no lo escribas en archivos ni en el comando.}"

SONAR_LOCAL_SCAN_SCRIPT_VERSION="2026-07-24-local-stable-v3"
SONAR_HOST_URL="${SONAR_HOST_URL:-http://localhost:9000}"
SONAR_SCANNER_MODE="${SONAR_SCANNER_MODE:-cli}"
SONAR_SCAN_SCOPE="${SONAR_SCAN_SCOPE:-stable}"
SONAR_JAVASCRIPT_NODE_MAXSPACE="${SONAR_JAVASCRIPT_NODE_MAXSPACE:-6144}"
SONAR_SCANNER_JAVA_OPTS="${SONAR_SCANNER_JAVA_OPTS:--Xmx1024m}"
SONAR_USER_HOME="${SONAR_USER_HOME:-${ROOT_DIR}/.sonar}"
SONAR_SKIP_AUTH_CHECK="${SONAR_SKIP_AUTH_CHECK:-0}"

if [ "${SONAR_SCANNER_DOCKER:-0}" = "1" ]; then
  SONAR_SCANNER_MODE="docker"
fi

discover_csv_paths() {
  local path
  local paths=()
  for path in "$@"; do
    if [ -e "${path}" ]; then
      paths+=("${path}")
    fi
  done
  local IFS=,
  printf '%s' "${paths[*]:-}"
}

discover_csv_file_contents() {
  local file
  local values=()
  for file in "$@"; do
    if [ -s "${file}" ]; then
      values+=("$(tr '\n' ',' <"${file}" | sed 's/,$//')")
    fi
  done
  local IFS=,
  printf '%s' "${values[*]:-}"
}

require_java_binaries_for_scope() {
  case "${SONAR_SCAN_SCOPE}" in
    stable|backend|full) return 0 ;;
    *) return 1 ;;
  esac
}

scanner_host_url="${SONAR_HOST_URL}"
if [ "${SONAR_SCANNER_MODE}" = "docker" ] && [[ "${scanner_host_url}" == http://localhost:* || "${scanner_host_url}" == http://127.0.0.1:* ]]; then
  scanner_host_url="${SONAR_DOCKER_HOST_URL:-http://host.docker.internal:9000}"
fi

if [ "${SONAR_SKIP_AUTH_CHECK}" != "1" ] && command -v curl >/dev/null 2>&1; then
  auth_response="$(curl -fsS -u "${SONAR_TOKEN}:" "${SONAR_HOST_URL%/}/api/authentication/validate" 2>/dev/null || true)"
  if ! printf '%s' "${auth_response}" | grep -q '"valid"[[:space:]]*:[[:space:]]*true'; then
    echo "ERROR: SonarQube no valido el token contra ${SONAR_HOST_URL}." >&2
    echo "Verifica que SonarQube este UP, que el token no haya expirado y que pertenezca al usuario con permisos sobre el proyecto." >&2
    echo "Importante: un intento fallido no consume ni invalida un token; si lo pegaste en logs o chats, revocalo por seguridad." >&2
    exit 1
  fi
fi

SONAR_JAVA_BINARIES="${SONAR_JAVA_BINARIES:-$(discover_csv_paths \
  chedoparti-backend/build/classes/java/main \
  chedoparti-saas-backend/build/classes/java/main \
  chedoparti-gateway/build/classes/java/main)}"

SONAR_JACOCO_XML_REPORT="${SONAR_JACOCO_XML_REPORT:-$(discover_csv_paths \
  chedoparti-backend/build/reports/jacoco/test/jacocoTestReport.xml \
  chedoparti-saas-backend/build/reports/jacoco/test/jacocoTestReport.xml \
  chedoparti-gateway/build/reports/jacoco/test/jacocoTestReport.xml)}"

SONAR_JAVA_LIBRARIES="${SONAR_JAVA_LIBRARIES:-$(discover_csv_file_contents \
  chedoparti-backend/build/sonar/runtime-classpath.txt \
  chedoparti-saas-backend/build/sonar/runtime-classpath.txt \
  chedoparti-gateway/build/sonar/runtime-classpath.txt)}"

case "${SONAR_SCAN_SCOPE}" in
  stable)
    SONAR_SOURCES="apps/booking-web/app,apps/booking-web/components,apps/booking-web/lib,apps/athlo-bff/src,chedoparti-backend/src/main/java,chedoparti-backend/src/main/resources,chedoparti-saas-backend/src/main/java,chedoparti-saas-backend/src/main/resources,chedoparti-gateway/src/main/java,chedoparti-gateway/src/main/resources"
    SONAR_TESTS="apps/athlo-bff/test,apps/booking-web/__tests__,apps/booking-web/test,chedoparti-backend/src/test/java,chedoparti-backend/src/integrationTest/java,chedoparti-saas-backend/src/test/java"
    SONAR_TYPESCRIPT_TSCONFIG_PATHS="${SONAR_TYPESCRIPT_TSCONFIG_PATHS:-apps/booking-web/tsconfig.json}"
    ;;
  backend)
    SONAR_SOURCES="chedoparti-backend/src/main/java,chedoparti-backend/src/main/resources,chedoparti-saas-backend/src/main/java,chedoparti-saas-backend/src/main/resources,chedoparti-gateway/src/main/java,chedoparti-gateway/src/main/resources"
    SONAR_TESTS="chedoparti-backend/src/test/java,chedoparti-backend/src/integrationTest/java,chedoparti-saas-backend/src/test/java"
    SONAR_TYPESCRIPT_TSCONFIG_PATHS="${SONAR_TYPESCRIPT_TSCONFIG_PATHS:-}"
    ;;
  frontend)
    SONAR_SOURCES="src,apps/admin-web/src,apps/athlo-bff/src,apps/booking-web/app,apps/booking-web/components,apps/booking-web/lib,apps/public-web/src,apps/tenant-web/src,packages/app-shell/src,packages/brand/src,packages/chedoparti-public-sdk/src,packages/copy/src,packages/tokens/src,packages/ui/src,packages/utils-formatting/src"
    SONAR_TESTS="apps/athlo-bff/test,apps/booking-web/__tests__,apps/booking-web/test"
    SONAR_TYPESCRIPT_TSCONFIG_PATHS="${SONAR_TYPESCRIPT_TSCONFIG_PATHS:-$(discover_csv_paths apps/admin-web/tsconfig.json apps/athlo-bff/tsconfig.json apps/booking-web/tsconfig.json apps/public-web/tsconfig.json apps/tenant-web/tsconfig.json apps/web-next/tsconfig.json)}"
    ;;
  full)
    SONAR_SOURCES="${SONAR_SOURCES:-}"
    SONAR_TESTS="${SONAR_TESTS:-}"
    SONAR_TYPESCRIPT_TSCONFIG_PATHS="${SONAR_TYPESCRIPT_TSCONFIG_PATHS:-$(discover_csv_paths apps/admin-web/tsconfig.json apps/athlo-bff/tsconfig.json apps/booking-web/tsconfig.json apps/public-web/tsconfig.json apps/tenant-web/tsconfig.json apps/web-next/tsconfig.json chedoparti-mobile/tsconfig.json)}"
    ;;
  *)
    echo "ERROR: SONAR_SCAN_SCOPE invalido: ${SONAR_SCAN_SCOPE}. Usa stable, backend, frontend o full." >&2
    exit 1
    ;;
esac

if require_java_binaries_for_scope && [ -z "${SONAR_JAVA_BINARIES}" ] && find chedoparti-backend chedoparti-saas-backend chedoparti-gateway -path '*/src/main/java/*' -name '*.java' -print -quit | grep -q .; then
  echo "ERROR: no se detectaron clases Java compiladas para Sonar." >&2
  echo "Ejecuta primero ./scripts/quality/quality-check-local.sh o los ./gradlew test jacocoTestReport printRuntimeClasspath correspondientes." >&2
  exit 1
fi

export SONAR_HOST_URL SONAR_TOKEN SONAR_JAVASCRIPT_NODE_MAXSPACE SONAR_SCANNER_JAVA_OPTS SONAR_USER_HOME
export SONAR_JAVA_BINARIES SONAR_JACOCO_XML_REPORT SONAR_JAVA_LIBRARIES SONAR_TYPESCRIPT_TSCONFIG_PATHS
mkdir -p reports/sonar "${SONAR_USER_HOME}"

scanner_args=(
  "-Dsonar.host.url=${scanner_host_url}"
  "-Dsonar.javascript.node.maxspace=${SONAR_JAVASCRIPT_NODE_MAXSPACE}"
)

if [ -n "${SONAR_PROJECT_KEY:-}" ]; then
  scanner_args+=("-Dsonar.projectKey=${SONAR_PROJECT_KEY}")
fi

if [ -n "${SONAR_ORGANIZATION:-}" ]; then
  scanner_args+=("-Dsonar.organization=${SONAR_ORGANIZATION}")
fi

if [ -n "${SONAR_SOURCES}" ]; then
  scanner_args+=("-Dsonar.sources=${SONAR_SOURCES}")
fi

if [ -n "${SONAR_TESTS}" ]; then
  scanner_args+=("-Dsonar.tests=${SONAR_TESTS}")
fi

if [ -n "${SONAR_TYPESCRIPT_TSCONFIG_PATHS}" ]; then
  scanner_args+=("-Dsonar.typescript.tsconfigPaths=${SONAR_TYPESCRIPT_TSCONFIG_PATHS}")
fi

if [ -n "${SONAR_JAVA_BINARIES}" ]; then
  scanner_args+=("-Dsonar.java.binaries=${SONAR_JAVA_BINARIES}")
fi

if [ -n "${SONAR_JACOCO_XML_REPORT}" ]; then
  scanner_args+=("-Dsonar.coverage.jacoco.xmlReportPaths=${SONAR_JACOCO_XML_REPORT}")
fi

if [ -n "${SONAR_JAVA_LIBRARIES}" ] && [ "${SONAR_SCANNER_MODE}" = "cli" ]; then
  scanner_args+=("-Dsonar.java.libraries=${SONAR_JAVA_LIBRARIES}")
  scanner_args+=("-Dsonar.java.test.libraries=${SONAR_JAVA_LIBRARIES}")
fi

echo "Running SonarQube analysis for chedoparti-react-app"
echo "SONAR_LOCAL_SCAN_SCRIPT_VERSION=${SONAR_LOCAL_SCAN_SCRIPT_VERSION}"
echo "SONAR_HOST_URL=${SONAR_HOST_URL}"
echo "SONAR_SCANNER_MODE=${SONAR_SCANNER_MODE}"
echo "SONAR_SCAN_SCOPE=${SONAR_SCAN_SCOPE}"
echo "SONAR_JAVASCRIPT_NODE_MAXSPACE=${SONAR_JAVASCRIPT_NODE_MAXSPACE}"

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
    -e SONAR_PROJECT_KEY \
    -e SONAR_ORGANIZATION \
    -e SONAR_JAVASCRIPT_NODE_MAXSPACE \
    -e SONAR_SCANNER_JAVA_OPTS \
    -e SONAR_USER_HOME=/opt/sonar-scanner/.sonar \
    -v "${SONAR_USER_HOME}:/opt/sonar-scanner/.sonar" \
    -v "${ROOT_DIR}:/usr/src" \
    -w /usr/src \
    "${docker_image}" \
    "${scanner_args[@]}"
else
  echo "ERROR: sonar-scanner no esta instalado o no esta en PATH." >&2
  echo "Opciones:" >&2
  echo "  1. Usar el hub Docker, que ya incluye SonarScanner CLI." >&2
  echo "  2. Instalar SonarScanner CLI localmente." >&2
  echo "  3. Ejecutar con Docker: SONAR_SCANNER_MODE=docker SONAR_HOST_URL=http://localhost:9000 ./scripts/quality/sonar-scan-local.sh" >&2
  exit 1
fi

echo "Analisis finalizado. Revisa resultados en ${SONAR_HOST_URL}."
