# Engineering Control Center

Plataforma local para registrar proyectos existentes, ejecutar acciones de calidad aprobadas, escanear riesgos locales de seguridad y consolidar en un dashboard datos de SonarQube, estado operativo y enlaces a Prometheus, Grafana, Loki, Tempo y Alertmanager.

## Estado actual

Fase implementada: centro de control local para Foundation + Quality + Observability + Cloud/Infrastructure + Jobs/Testing + Deployments + Living Documentation + Adapter Discovery Cache + Git/Versions + Living Documentation v2 + UX operativa. M0 Security Containment agrega binding loopback, auth local, roles, trust de proyectos, CORS/SSRF guards y un perfil Docker core sin ejecucion privilegiada.

- Control API y worker local sin dependencias externas de npm.
- UI web convertida en workspace operativo: resumen global, busqueda, filtros de estado, catalogo, prioridades, detalle por proyecto, command palette y onboarding checklist.
- Configuracion runtime por proyecto desde la UI: Sonar host allowlisted, trust, scan scope, modo scanner, memoria y variables no secretas permitidas.
- Drawer amplio por proyecto con tabs internas para resumen, entorno, calidad, terminal, ejecuciones y configuracion.
- Local Run Engine por proyecto: start/stop/restart de Docker Compose, deteccion de conflictos de puertos, recursos activos y logs de contenedor.
- Links por proyecto a GitHub/GitLab, branches, PRs/MRs, SonarQube, Jenkins, Grafana, Prometheus y Alertmanager, con validacion accionable desde la UI.
- Observabilidad Fase 2 con endpoints global/por proyecto, queries Prometheus/Loki/Tempo, alertas Alertmanager y dashboard Grafana filtrado por proyecto.
- Calidad y seguridad Fase 3 con overview global/por proyecto, evidencia de tests, SonarQube, dependencias, secret scanning redaccionado, container scanning estatico y findings priorizados.
- Cloud e infraestructura Fase 4 con discovery read-only, adaptadores local/AWS/GCP/VPS/Kubernetes, inventario de recursos y drift estatico.
- Discovery Fase 8 con registro comun de adaptadores, capacidades, timeouts, rate limits, cache TTL, refresh auditado y cloud live calls bloqueadas.
- Jobs y pruebas Fase 5 con orquestador, worker local, catalogo cerrado, smoke, load HTTP local acotado, DAST pasivo, evidencias y guardrails.
- Despliegues Fase 6 con plan/apply/verify/rollback, aprobaciones explicitas, auditoria y guardrails de produccion read-only.
- Documentacion viva Fase 7/12 con guias, runbooks, diagramas Mermaid, confianza, historial, snapshots auditados, matriz obligatoria, documentos por ambiente/proveedor y metadata verificable.
- Jenkins local opcional para jobs multibranch por proyecto mediante el perfil `ci`.
- Drawer de jobs con resumen visual de fallos antes del log crudo completo.
- Worker Docker con bash, Git, OpenJDK 21, Maven, Python y SonarScanner CLI 8.0.1.
- Registro inicial de cinco proyectos:
  - `chedoparti-react-app`
  - `maria-belen-labarque-ceramic`
  - `sistema-dietetica`
  - `giftfinder-proyect`
  - `panorama-mercados`
- Descriptor YAML versionado en `config/project-catalog.yaml` para proyectos, componentes y ambientes declarados.
- Modelo de Fase 1 con estado declarado, detectado y verificado por proyecto.
- Workspace permitido mediante `PROJECTS_ROOT`.
- Discovery de stacks Git, Node, Next/Vite, Maven, Gradle, Python, Flutter, Docker y SonarQube.
- Jobs asincronicos con estados, logs sanitizados, SSE e idempotency key.
- Integracion SonarQube API desde backend.
- Compose con perfiles `core`, `metrics`, `logging`, `tracing`, `alerting`, `observability`, `quality`, `ci`, `stateful` e `infra`.
- Provisioning base de Prometheus, Grafana, Loki, Tempo, OTel Collector, Alertmanager y Blackbox.

No se modifican repositorios externos automaticamente. Las acciones solo ejecutan templates detectados; el navegador no puede enviar comandos arbitrarios. El Local Run Engine ejecuta `docker compose` solo sobre manifests detectados dentro del proyecto registrado.

## Auditoria inicial

`/Users/martiniano/Documents/dev-tools` no era un repo Git y contenia una instalacion local reusable de SonarQube en `sonarqube/`. No habia frontend, backend de control, registry, worker, base de datos del hub ni stack de observabilidad completo.

Infra reutilizable encontrada:

- `sonarqube/docker-compose.yml`
- `sonarqube/scripts/up.sh`
- `sonarqube/scripts/down.sh`
- `sonarqube/scripts/backup-db.sh`
- `sonarqube/scripts/restore-db.sh`
- templates locales de SonarQube por proyecto.

Brechas principales cerradas en este MVP:

- Catalogo multi-proyecto.
- Control API versionada.
- Discovery seguro de carpetas.
- Ejecuciones asincronicas no arbitrarias.
- UI consolidada como centro de control operativo.
- Compose multi-perfil.
- Documentacion de arquitectura, onboarding, observabilidad y seguridad.

Brechas que quedan para siguientes fases:

- Migrar persistencia JSON local a PostgreSQL con migraciones reproducibles.
- Identidades multiusuario/RBAC durable; M0 solo provee un principal Bearer local con roles centralizados.
- Runners especializados por stack con coverage profundo por proyecto.
- Instrumentacion real de cada proyecto externo.
- Tests E2E Playwright y accesibilidad automatizada.
- Datasources Grafana validados contra contenedores ya levantados.

## Prerrequisitos

- macOS con Docker Desktop.
- Node.js `>=22`.
- Docker Compose.
- SonarQube local en `http://localhost:9000` si se quiere importar calidad.
- El perfil Docker `core` es read-only y no monta Docker socket. Las operaciones locales privilegiadas requieren ejecucion nativa explicita, loopback, autenticada y sobre proyectos `TRUSTED_LOCAL`.

## Configuracion

```bash
cd /ruta/a/dev-tools
cp .env.example .env
```

Configurar una raiz de proyectos explicita y portable:

```dotenv
PROJECTS_ROOT=/ruta/absoluta/a/proyectos
SONAR_HOST_URL=http://host.docker.internal:9000
HUB_AUTH_TOKEN=<valor-aleatorio-de-32-o-mas-caracteres>
HUB_AUTH_ACTOR_ID=<identidad-local>
HUB_AUTH_ROLE=ADMIN
```

Si corres la API nativa fuera de Docker, podes usar:

```bash
export PROJECTS_ROOT=/ruta/absoluta/a/proyectos
export SONAR_HOST_URL=http://127.0.0.1:9000
```

Los secretos nunca van en Git ni en la configuracion runtime persistida. `SONAR_TOKEN`, `HUB_AUTH_TOKEN`, passwords de Grafana/Jenkins/PostgreSQL y equivalentes se suministran mediante environment externo. La UI solo conserva el token Bearer del hub en `sessionStorage` hasta cerrar la sesion del navegador.

Tambien podes usar variable de entorno global si ejecutas scripts por consola:

```bash
export SONAR_TOKEN=<token>
```

El descriptor declarado del catalogo vive en:

```text
config/project-catalog.yaml
```

Para usar otro descriptor local:

```bash
export HUB_PROJECT_DESCRIPTOR=/ruta/project-catalog.yaml
```

Si pegaste un token en una terminal compartida, chat o log, revocalo y crea uno nuevo. Un intento fallido de scanner no consume ni invalida el token; si parece pasar eso, revisa expiracion, permisos del usuario y `SONAR_HOST_URL`.

Para levantar o detener un proyecto desde el panel, la API debe ejecutarse en modo nativo seguro: `HUB_PRIVILEGED_EXECUTION_ENABLED=1`, bind loopback, credencial externa y proyecto `TRUSTED_LOCAL`. El perfil Compose `core` permite discovery y administración no privilegiada, pero rechaza runtime/jobs con `PRIVILEGED_EXECUTION_DISABLED`.

`Start` es la accion normal recomendada. Antes de ejecutar refresca Git, calcula un fingerprint de fuentes/configuracion/variables no secretas y lo compara con el ultimo deploy local registrado. Si no hay deploy previo o el fingerprint cambio, fuerza rebuild/recreate sin borrar volumenes persistentes. Si el codigo local cambia despues del deploy, el proyecto se marca como `Obsoleto` y el Action Center ofrece volver a levantarlo.

`Rebuild changed components` reconstruye cuando difiere la huella de fuente; `Clean rebuild` fuerza build/recreate preservando volumenes; `Pull and rebuild` exige worktree limpio y pull fast-forward antes de reconstruir.

## Comandos

Validacion local sin levantar contenedores:

```bash
npm run check
./scripts/smoke.sh
./scripts/doctor.sh
./scripts/docker-registry-doctor.sh
```

Ejecutar API nativa:

```bash
PROJECTS_ROOT=/ruta/absoluta/a/proyectos \
SONAR_HOST_URL=http://127.0.0.1:9000 \
HUB_AUTH_TOKEN=<secreto-externo> \
HUB_AUTH_ACTOR_ID=<identidad-local> \
HUB_AUTH_ROLE=ADMIN \
HUB_PRIVILEGED_EXECUTION_ENABLED=1 \
npm start
```

Abrir:

```text
http://127.0.0.1:18080
```

Arranque diario liviano con Docker. Este flujo levanta solo `control-api` y `web`; no inicia Postgres, Redis, SonarQube, Jenkins ni observabilidad pesada:

```bash
./scripts/hub-up-lite.sh
```

Equivalente manual:

```bash
docker compose --profile core up -d
```

`control-api` corre non-root con filesystem read-only, monta el project root una sola vez en modo lectura y no recibe `/var/run/docker.sock`. `docs/live` y los volúmenes de data/cache son sus únicas superficies de escritura deliberadas.

`hub-postgres` y `redis` quedan en el perfil opcional `stateful`. El backend actual persiste en `HUB_DATA_DIR/state.json`; no necesita esos dos contenedores para usar el panel.

En modo liviano, el resumen de servicios cuenta solo `core` como requerido. SonarQube, Jenkins y observabilidad aparecen como opcionales apagados, no como degradacion del panel.

Arranque con metricas basicas. Levanta dashboard + Prometheus + Grafana:

```bash
./scripts/hub-up-metrics.sh
```

Equivalente manual:

```bash
docker compose --profile core --profile metrics up -d
```

Arranque con observabilidad completa para diagnostico profundo:

```bash
docker compose --profile core --profile observability up -d
```

Levantar todo, incluyendo observabilidad completa, SonarQube y Jenkins:

```bash
./scripts/hub-up-full.sh
```

Equivalente manual:

```bash
docker compose --profile core --profile observability --profile quality --profile ci up -d
```

Si ya esta corriendo la instalacion existente `sonarqube/` en puerto `9000`, no levantes tambien el perfil `quality` salvo que cambies `SONARQUBE_PORT`.

Una instalacion nueva del perfil `quality` requiere `SONAR_ADMIN_PASSWORD` externa y aleatoria, con al menos 12 caracteres, mayuscula, minuscula, numero y caracter especial. El bootstrap la usa una sola vez para invalidar la credencial administrativa default; una instalacion ya rotada no se resetea. SonarQube solo queda healthy cuando la aplicacion esta `UP` y la credencial default ya no funciona.

El servicio SonarQube usa `SONARQUBE_IMAGE` y por defecto apunta a `sonarqube:community`, que puede reutilizar una imagen local ya descargada. Para fijar una version concreta, definir por ejemplo `SONARQUBE_IMAGE=sonarqube:26.6-community` en `.env`.

Levantar Jenkins local:

```bash
docker compose --profile core --profile ci up -d --build jenkins
```

La primera ejecucion de Jenkins necesita resolver `jenkins/jenkins` y descargar plugins desde internet. Si Docker Desktop no puede resolver Docker Hub (`registry-1.docker.io`), el perfil `ci` no puede construirse hasta corregir red/DNS/proxy o precargar la imagen.

UI:

```text
http://localhost:18082
```

Jenkins no tiene credenciales funcionales por defecto: antes de activar el perfil se deben suministrar `JENKINS_ADMIN_ID` y `JENKINS_ADMIN_PASSWORD` externamente. M0 elimina Docker socket, ejecución root, agent port y mount de proyectos del contenedor Jenkins; los Jenkinsfiles que construyan imágenes Docker requieren migración futura a un runner aislado.

El perfil `ci` crea jobs multibranch para los proyectos con remoto Git desde `config/jenkins/seed/jobs.groovy`. Actualmente quedan configurados Chedoparti, Maria Belen, Sistema Dietetica y Giftfinder; `panorama-mercados` queda pendiente porque la carpeta local no es repo Git. Cada repo necesita un `Jenkinsfile` en la raiz para ejecutar build, tests, coverage, Sonar y build de imagen Docker. Mientras Jenkins sea local, GitHub no puede disparar webhooks directamente salvo que publiques Jenkins por HTTPS o uses un tunnel seguro; el default local escanea branches cada 5 minutos.

Apagar servicios pesados sin borrar volumenes:

```bash
./scripts/hub-down-heavy.sh
```

Rebuild solo cuando cambie `Dockerfile.api`, dependencias de la imagen o quieras regenerar la imagen del worker:

```bash
./scripts/docker-registry-doctor.sh
docker compose --profile core up -d --build
```

El rebuild necesita que Docker Desktop pueda resolver Docker Hub (`registry-1.docker.io`). Si falla DNS/proxy, el arranque sin `--build` puede seguir funcionando con la imagen local ya construida.

## Puertos

Todos los puertos publicados usan `HUB_BIND_ADDRESS=127.0.0.1` por defecto. PostgreSQL y Redis no se publican al host; se administran con `docker compose exec`. Un bind no-loopback sin `HUB_AUTH_TOKEN` impide el arranque; si se configura exposición remota explícita, las lecturas de API y métricas también requieren Bearer.

Blackbox y cAdvisor son internos y no publican puertos. Las redes backend de calidad y observabilidad permanecen `internal`; redes host acotadas por dominio permiten materializar solamente los bindings loopback enumerados abajo.

| Servicio | Puerto host |
| --- | ---: |
| Web estatica | `18000` |
| Control API | `18080` |
| SonarQube | `9000` |
| Jenkins | `18082` |
| Prometheus | `19090` |
| Grafana | `13000` |
| Loki | `13100` |
| Tempo | `13200` |
| OTel gRPC/HTTP | `14317` / `14318` |
| Alertmanager | `19093` |

## API

Base local:

```text
http://127.0.0.1:18080/api/v1
```

Los GET permanecen disponibles en modo local de lectura. Toda mutación requiere `Authorization: Bearer <HUB_AUTH_TOKEN>` y la policy central asigna `READ`, `OPERATE` o `ADMIN`. `GET /api/v1/security/session` informa el estado sin devolver la credencial.

Endpoints principales:

- `GET /security/session`
- `GET /catalog/descriptor`
- `GET /projects`
- `POST /projects/discover`
- `POST /projects`
- `GET /projects/{idOrSlug}`
- `GET /projects/{idOrSlug}/git`
- `POST /projects/{idOrSlug}/git`
- `GET /projects/{idOrSlug}/freshness`
- `GET /projects/{idOrSlug}/local-state`
- `GET /projects/{idOrSlug}/runtime-identity`
- `GET /projects/{idOrSlug}/links`
- `POST /projects/{idOrSlug}/links/validate`
- `GET /projects/{idOrSlug}/runtime`
- `POST /projects/{idOrSlug}/runtime/start`
- `POST /projects/{idOrSlug}/runtime/start-fresh`
- `POST /projects/{idOrSlug}/runtime/stop`
- `POST /projects/{idOrSlug}/runtime/restart`
- `POST /projects/{idOrSlug}/runtime/restart-fresh`
- `POST /projects/{idOrSlug}/runtime/rebuild-changed`
- `POST /projects/{idOrSlug}/runtime/clean-rebuild`
- `POST /projects/{idOrSlug}/runtime/pull-rebuild`
- `GET /projects/{idOrSlug}/runtime/changes`
- `POST /projects/{idOrSlug}/runtime/volumes/delete`
- `GET /projects/{idOrSlug}/runtime/logs`
- `POST /projects/{idOrSlug}/runtime/logs/clear`
- `GET /versions/overview`
- `GET /projects/{idOrSlug}/versions/overview`
- `GET /projects/{idOrSlug}/versions/changes`
- `POST /projects/{idOrSlug}/doctor`
- `POST /projects/{idOrSlug}/executions`
- `GET /executions/{jobId}`
- `GET /executions/{jobId}/events`
- `GET /projects/{idOrSlug}/quality/summary`
- `GET /quality-security/overview`
- `GET /projects/{idOrSlug}/quality-security/overview`
- `GET /infrastructure/overview`
- `GET /infrastructure/adapters`
- `GET /projects/{idOrSlug}/infrastructure/overview`
- `GET /projects/{idOrSlug}/infrastructure/adapters`
- `POST /projects/{idOrSlug}/infrastructure/refresh`
- `GET /deployments/overview`
- `GET /projects/{idOrSlug}/deployments/overview`
- `POST /projects/{idOrSlug}/deployments/plan`
- `POST /projects/{idOrSlug}/deployments/plans/{planId}/approve`
- `POST /projects/{idOrSlug}/deployments/plans/{planId}/reject`
- `POST /projects/{idOrSlug}/deployments/plans/{planId}/apply`
- `POST /projects/{idOrSlug}/deployments/verify`
- `POST /projects/{idOrSlug}/deployments/rollback`
- `GET /docs/overview`
- `GET /projects/{idOrSlug}/docs/overview`
- `GET /projects/{idOrSlug}/docs/documents`
- `POST /projects/{idOrSlug}/docs/snapshot`
- `GET /agents/overview`
- `POST /agents/heartbeat`
- `POST /agents/discovery/refresh`
- `GET /testing/overview`
- `GET /projects/{idOrSlug}/testing/overview`
- `GET /projects/{idOrSlug}/testing/executions`
- `POST /projects/{idOrSlug}/testing/executions`
- `GET /observability/overview`
- `GET /projects/{idOrSlug}/observability/overview`
- `GET /platform/status`

## Fuentes de verdad

- Estado declarado: `config/project-catalog.yaml`.
- Estado detectado: Control API discovery desde filesystem, Git y manifests.
- Estado verificado local: Control API, Docker, fingerprints y health checks configurados.
- Calidad: SonarQube.
- Calidad y seguridad local: tests detectados, manifests de dependencias, secret scanning redaccionado y Dockerfile/Compose scanning.
- Infraestructura: manifests locales, Terraform, AWS/GCP static config, VPS artifacts, Kubernetes/Helm/Kustomize y runtime Docker.
- Discovery Fase 8: registro comun de adaptadores, cache `static-manifests`, `sourceHash`, TTL y auditoria `infrastructure.discovery.refresh`.
- Agente local Fase 9: identidad embebida, heartbeat, discovery local sanitizado, capacidades y auditoria `agent.*`.
- Infraestructura Fase 10: adaptadores `infrastructure-adapter.v1` para Docker, Compose, Terraform/OpenTofu, AWS, CloudFormation, GCP, Azure futuro, VPS, Kubernetes, GitHub/GitLab, Harness, observabilidad, registries, SMTP y object storage.
- Git y versiones Fase 11: contrato `git-version-management.v1`, comparacion local/remoto/ambiente, commit desplegado, rama de origen, ultimo pull/build y acciones Start/Restart/Rebuild/Clean/Pull/Stop/View con volumenes preservados por defecto.
- Pruebas Fase 5: catalogo cerrado, jobs locales, perfiles smoke, targets HTTP locales, metricas de load acotado y DAST pasivo.
- Despliegues Fase 6: planes, aprobaciones, apply local aprobado, verify read-only, rollback guardado y auditoria `deployment.*`.
- Documentacion viva Fase 7/12: estado verificado del hub, snapshots `docs/live`, hashes SHA-256, confianza, historial auditado `docs.snapshot`, contrato `living-documentation.v2`, secciones obligatorias, documentos `local-runtime`, `docker-compose`, `vps`, `aws`, `gcp`, `kubernetes`, metadata de commit/origen y registro de docs oficiales consultadas.
- Series temporales: Prometheus.
- Logs: Loki.
- Trazas: Tempo.
- Alertas: Alertmanager.
- Estado del hub y jobs: Control API.

El dashboard propio consolida y enlaza; no reemplaza las UI avanzadas de SonarQube o Grafana.

## Troubleshooting

- `PROJECTS_ROOT does not exist`: corregir `.env`.
- `SonarQube API not reachable`: levantar `sonarqube/` o perfil `quality`; revisar `SONAR_HOST_URL`.
- `You're not authorized`: crear proyecto en SonarQube o usar token con permisos.
- `SonarQube no valido el token`: el token es invalido/expirado, el usuario no tiene permisos o el script esta apuntando a otro `SONAR_HOST_URL`.
- `No approved template`: el repo no tiene script de test/build/Sonar detectado. Ejecutar Doctor para ver brecha.
- `No Docker Compose manifest was detected`: el proyecto no tiene `compose.yml`, `compose.yaml`, `docker-compose.yml` o `docker-compose.yaml` detectable.
- `Docker CLI is not available`: Docker Desktop no esta levantado o la API corre en Docker sin acceso al socket.
- `AUTHENTICATION_REQUIRED`: configurar la credencial externa y cargarla en la sección Configuración de la UI.
- `PRIVILEGED_EXECUTION_DISABLED`: el perfil Compose seguro no ejecuta proyectos; usar la API nativa con el opt-in documentado.
- `PROJECT_EXECUTION_FORBIDDEN`: cambiar el trust a `TRUSTED_LOCAL` con rol ADMIN solo después de revisar el repositorio.
- `PORT_CONFLICT`: un puerto declarado por el compose esta ocupado por otro contenedor/proceso. El panel muestra el owner detectado cuando Docker lo informa.
- Puerto del hub ocupado: cambiar el puerto en `.env` o apagar el servicio existente.
- `failed to resolve source metadata ... registry-1.docker.io ... no such host`: Docker Desktop no puede resolver Docker Hub. No es un error del codigo. Si la imagen local ya existe, usar `./scripts/hub-up-lite.sh` o `./scripts/hub-up-metrics.sh` sin `--build`. Para rebuild, reiniciar Docker Desktop, revisar VPN/proxy/DNS y correr `./scripts/docker-registry-doctor.sh`.
- `Tempo exited (1)` con `permission denied` en `/tmp/tempo/blocks`: el Compose incluye `tempo-init`, que prepara el volumen `hub_tempo_data` con permisos para el usuario no-root de Tempo. Reejecutar `docker compose --profile tracing up -d` o `docker compose --profile observability up -d`.

## Documentacion

- `docs/architecture.md`
- `docs/architecture/overview.md`
- `docs/architecture/components.md`
- `docs/architecture/security.md`
- `docs/architecture/local-agent.md`
- `docs/architecture/job-orchestrator.md`
- `docs/environments/local.md`
- `docs/environments/development.md`
- `docs/environments/staging.md`
- `docs/environments/production.md`
- `docs/phase-0-audit.md`
- `docs/phase-1-catalog-local-state.md`
- `docs/phase-2-observability.md`
- `docs/phase-3-quality-security.md`
- `docs/phase-4-cloud-infrastructure.md`
- `docs/phase-5-jobs-testing.md`
- `docs/phase-6-deployments.md`
- `docs/phase-7-living-documentation.md`
- `docs/phase-8-discovery-cache.md`
- `docs/phase-9-local-agent.md`
- `docs/phase-10-infrastructure-discovery.md`
- `docs/phase-11-git-versions.md`
- `docs/phase-12-living-docs-v2.md`
- `docs/operations/runbooks.md`
- `docs/operations/backups.md`
- `docs/operations/disaster-recovery.md`
- `docs/live/README.md`
- `docs/control-center-ux.md`
- `docs/project-onboarding.md`
- `docs/sonarqube-local-runbook.md`
- `docs/quality-project-audit-2026-07-24.md`
- `docs/observability.md`
- `docs/security.md`
- `docs/deployment/aws.md`
- `docs/deployment/gcp.md`
- `docs/deployment/vps.md`
- `docs/security/threat-model.md`
- `docs/security/access-control.md`
- `docs/security/secrets-management.md`
- `docs/observability/overview.md`
- `docs/testing/performance.md`
- `docs/testing/security.md`
- `docs/adrs/0001-filesystem-access.md`
- `docs/adrs/0002-runner-model.md`
- `docs/adrs/0003-observability-storage.md`
- `docs/adrs/0004-catalog-descriptor-yaml.md`
