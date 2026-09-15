# SonarQube local runbook

## Estado que tiene que estar levantado

Para analizar desde el hub Docker:

```bash
cd /Users/martiniano/Documents/dev-tools
cp .env.example .env
docker compose --profile core up -d
```

Usa `--build` solo cuando necesites reconstruir la imagen del worker. Antes de rebuildar, valida que Docker Desktop pueda resolver Docker Hub:

```bash
./scripts/docker-registry-doctor.sh
docker compose --profile core up -d --build
```

El hub usa el SonarQube que ya tengas en `http://localhost:9000` mediante:

```dotenv
SONAR_HOST_URL=http://host.docker.internal:9000
PROJECTS_ROOT=/Users/martiniano/Documents
```

Si queres levantar el SonarQube incluido en este hub, usa tambien el perfil `quality` y no dejes otro SonarQube ocupando el puerto `9000`:

```bash
export SONAR_POSTGRES_PASSWORD=<password-externa>
export SONAR_ADMIN_PASSWORD=<password-externa-aleatoria-compatible-con-la-policy>
docker compose --profile core --profile quality --profile observability up -d
```

No guardar esos valores en Git ni pasarlos como argumentos visibles. `SONAR_ADMIN_PASSWORD` debe tener al menos 12 caracteres e incluir mayuscula, minuscula, numero y caracter especial. En una instalacion nueva, el servicio one-shot `sonarqube-credential-bootstrap` espera `UP`, rota la credencial inicial y valida que el acceso externo funcione mientras `admin/admin` deja de funcionar. Si el volumen ya estaba rotado, no cambia la password y valida la proporcionada. Sin secreto o con secreto incorrecto falla; el healthcheck de SonarQube exige `UP` y default invalido, pero **host-ready** requiere ademas bootstrap terminado con exit code 0 y gateway healthy.

La UI se publica en `127.0.0.1:9000` solo a traves de `sonarqube-gateway`. `hub-quality` sigue siendo interna para SonarQube, bootstrap y PostgreSQL; `hub-quality-host` se conecta solo al gateway. Antes del bootstrap exitoso no hay puerto host utilizable, aunque SonarQube ya responda internamente. Para diagnosticar, usar `docker compose --profile quality ps -a` y `docker compose --profile quality logs sonarqube-credential-bootstrap`, nunca un dump de environment o credenciales.

La observabilidad completa no es requisito para correr Sonar. Usala solo si tambien queres revisar Prometheus/Grafana/Loki/Tempo durante el analisis.

## Token

El token no se guarda en ningun archivo del repo ni se pasa como `-Dsonar.token=...` en los scripts nuevos. SonarScanner soporta `SONAR_TOKEN` y `SONAR_HOST_URL` por entorno, que es la forma preferida para no exponer secretos en procesos/logs.

Para ejecuciones desde el panel:

1. Abrir `http://localhost:18000`.
2. Entrar al proyecto.
3. Ir a `Configuracion`.
4. Completar `SONAR_HOST_URL`, `SONAR_TOKEN`, `SONAR_SCAN_SCOPE` y el modo scanner.
5. Guardar.
6. Ejecutar `Doctor`, `Sonar` o `Ejecutar analisis` desde la misma UI.

El API solo devuelve `sonarTokenConfigured: true/false`; no devuelve el token al navegador.

```bash
export SONAR_TOKEN=<token_nuevo>
```

Un intento fallido no consume ni invalida el token. Si parece que tenes que crear uno nuevo cada vez, casi siempre es por una de estas causas:

- el token fue creado con expiracion corta y ya expiro;
- el token pertenece a otro usuario o fue revocado;
- el proyecto/key no existe todavia y el usuario no tiene permiso para crearlo o analizarlo;
- el scanner corre dentro de Docker y apunta a `localhost:9000` del contenedor, no al host;
- el token se pego en logs/chats y conviene revocarlo por seguridad, aunque SonarQube no lo invalida automaticamente.

Los scripts agregados validan el token con `/api/authentication/validate` antes de iniciar el scan. Si no es valido, fallan rapido y no ejecutan el analisis pesado.

## Orden recomendado por proyecto

### Chedoparti

Primero generar cobertura/clases:

```bash
cd /Users/martiniano/Documents/chedoparti-react-app
./scripts/quality/quality-check-local.sh
```

Despues analizar con scope estable:

```bash
SONAR_SCAN_SCOPE=stable ./scripts/quality/sonar-scan-local.sh
```

Scopes:

- `stable`: booking-web + athlo-bff + backend/gateway/saas Java. Es el default y evita mobile/native y paquetes secundarios para reducir memoria.
- `backend`: solo Java backend/gateway/saas, util cuando el analizador JS/TS sea el cuello de botella.
- `frontend`: web/packages sin Java.
- `full`: todo lo declarado en `sonar-project.properties`; usarlo cuando `stable` ya este verde.

### Maria Belen Labarque Ceramic

Ya tenia `sonar-project.properties` y script local. Estrategia: ejecutar coverage frontend/backend y luego `scripts/quality/sonar-scan-local.sh`. Mantener DiTerra separado de conceptos Chedoparti.

### Sistema Dietetica

Se agregaron:

- `sonar-project.properties`
- `scripts/quality/sonar-scan-local.sh`

Orden:

```bash
cd /Users/martiniano/Documents/sistema_dietetica
mvn verify
npm --prefix apps/web run test:coverage:gate
./scripts/quality/sonar-scan-local.sh
```

Analiza `apps/backend/src/main/java`, `apps/backend/src/main/resources` y `apps/web/src`. Tests: `apps/backend/src/test/java` y `apps/web/tests`.

### Giftfinder Proyect

Ya tenia configuracion Sonar. Estrategia: correr Gradle/Jacoco de backend y microservicios, test frontend y scraper, luego el script Sonar existente.

### Panorama Mercados

Se agregaron:

- `sonar-project.properties`
- `scripts/quality/sonar-scan-local.sh`

Analiza `app`, `components`, `lib`, `db` y `scripts`. Tiene tests Vitest, pero todavia no tiene script de coverage ni reporte `coverage/lcov.info`; por eso el hub lo muestra como `COVERAGE` pendiente y no inventa 0%.

## Estrategia de recursos

Para monorepos, no conviene analizar todo siempre:

- usar `stable` o backend/frontend por separado cuando el repo es grande;
- generar coverage antes de Sonar para evitar `Sin datos`;
- excluir `node_modules`, `.next`, `.vite`, `build`, `dist`, `target`, `.gradle`, `coverage`, `.scannerwork` y `.sonar`;
- no incluir mobile native en el scan default salvo que tenga un perfil propio;
- mantener un project key estable por repo y no mezclar dominios.

## Validacion rapida

```bash
cd /Users/martiniano/Documents/dev-tools
npm run check
./scripts/smoke.sh
docker compose --profile core --profile quality ps
npm run test:sonarqube-fail-closed
```

`sonarqube-credential-bootstrap` debe terminar con exit code 0; `sonarqube` y `sonarqube-gateway` deben aparecer healthy. Nunca copies su environment o ejecutes `docker inspect` sobre secretos en una salida compartida.

Desde el hub:

- abrir `http://localhost:18000`;
- entrar a un proyecto;
- pestaña `Configuration`;
- revisar `Templates aprobados`;
- ejecutar `Doctor` antes de `Sonar`.
