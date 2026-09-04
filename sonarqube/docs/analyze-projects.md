# Comandos de analisis por proyecto

Usa un token de usuario local para uso individual. Para CI/VPS, preferi tokens controlados y rotables.

## Chedoparti

```bash
cd /Users/martiniano/Documents/dev-tools/sonarqube
./scripts/up.sh

cd /Users/martiniano/Documents/chedoparti-react-app
export SONAR_HOST_URL=http://localhost:9000
export SONAR_TOKEN=<token>

npm --prefix apps/booking-web test -- --coverage
(cd chedoparti-backend && ./gradlew test jacocoTestReport)
(cd chedoparti-gateway && ./gradlew test jacocoTestReport)
(cd chedoparti-saas-backend && ./gradlew test jacocoTestReport)

SONAR_SCAN_SCOPE=stable ./scripts/quality/sonar-scan-local.sh
```

Usa `SONAR_SCAN_SCOPE=backend`, `frontend` o `full` solo cuando necesites ampliar el alcance.

## Maria Belen Labarque Ceramic

```bash
cd /Users/martiniano/Documents/dev-tools/sonarqube
./scripts/up.sh

cd /Users/martiniano/Documents/maria-belen-labarque-ceramic
export SONAR_HOST_URL=http://localhost:9000
export SONAR_TOKEN=<token>

npm run test:frontend:coverage
npm --prefix backend run test:coverage

./scripts/quality/sonar-scan-local.sh
```

## Sistema Dietetica

```bash
cd /Users/martiniano/Documents/dev-tools/sonarqube
./scripts/up.sh

cd /Users/martiniano/Documents/sistema_dietetica
export SONAR_HOST_URL=http://localhost:9000
export SONAR_TOKEN=<token>

mvn verify
npm --prefix apps/web run test:coverage:gate
./scripts/quality/sonar-scan-local.sh
```

## Giftfinder

```bash
cd /Users/martiniano/Documents/dev-tools/sonarqube
./scripts/up.sh

cd /Users/martiniano/Documents/giftfinder-proyect
export SONAR_HOST_URL=http://localhost:9000
export SONAR_TOKEN=<token>

(cd giftfinder-backend && ./gradlew test jacocoTestReport)
(cd microservices/api-gateway && ./gradlew test jacocoTestReport)
(cd microservices/auth-service && ./gradlew test jacocoTestReport)
(cd microservices/service-registry && ./gradlew test jacocoTestReport)
npm --prefix giftfinder-frontend test -- --coverage

./scripts/quality/sonar-scan-local.sh
```

## Panorama Mercados

```bash
cd /Users/martiniano/Documents/dev-tools/sonarqube
./scripts/up.sh

cd /Users/martiniano/Documents/panorama-mercados
export SONAR_HOST_URL=http://localhost:9000
export SONAR_TOKEN=<token>

npm test
./scripts/quality/sonar-scan-local.sh
```

`panorama-mercados` todavia no tiene coverage LCOV configurado; Sonar importara cobertura cuando exista `coverage/lcov.info`.

## Scanner via Docker en macOS

Si no queres instalar `sonar-scanner` localmente:

```bash
docker run --rm \
  -e SONAR_HOST_URL="http://host.docker.internal:9000" \
  -e SONAR_TOKEN \
  -e SONAR_SCANNER_OPTS="-Xmx2048m" \
  -v "$PWD:/usr/src" \
  sonarsource/sonar-scanner-cli@sha256:23ca0f137965d9dff2198074043fd48d386280bc5d0ccac8c8349cea4cf096a9 \
  -Dsonar.host.url="http://host.docker.internal:9000" \
  -Dsonar.javascript.node.maxspace=4096
```

En Linux puede usarse `--network host` con `http://localhost:9000`. En macOS, `host.docker.internal` es la opcion mas predecible cuando el scanner corre dentro de Docker.

Si el analisis JS/TS falla con `The bridge server is unresponsive`, subir memoria antes de reintentar:

```bash
export SONAR_JAVASCRIPT_NODE_MAXSPACE=6144
export SONAR_SCANNER_OPTS=-Xmx3072m
SONAR_SCANNER_DOCKER=1 ./scripts/quality/sonar-scan-local.sh
```

Runbook completo: `../../docs/sonarqube-local-runbook.md`.
