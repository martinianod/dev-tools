# Fase 0 - Auditoria

Fecha: 2026-08-04.

## Arquitectura actual

El proyecto es un Engineering Control Center local. La raiz no es un repo Git; funciona como workspace de herramientas y plataforma local.

Componentes actuales:

- `apps/control-api/server.mjs`: API Node.js sin dependencias externas de npm, worker local, registry de proyectos, discovery, jobs, Local Run Engine, adaptadores SonarQube y observabilidad.
- `apps/web`: UI estatica servida por la API en modo nativo o por Nginx en Docker.
- `compose.yaml`: perfiles `core`, `metrics`, `logging`, `tracing`, `alerting`, `observability`, `quality`, `ci`, `stateful` e `infra`.
- `data/state.json`: persistencia JSON local para proyectos, ambientes, jobs, snapshots, runtime y auditoria.
- `config/`: Prometheus, Grafana, Loki, Tempo, OTel Collector, Alertmanager, Blackbox y Jenkins CasC.
- `sonarqube/`: instalacion local reusable de SonarQube con scripts de backup, restore, reset y analisis.

## Stack real

- Backend: Node.js ESM sobre APIs built-in (`http`, `fs`, `child_process`, `crypto`).
- Frontend: HTML, CSS y JavaScript vanilla.
- Contenedores: Docker Compose.
- Calidad: SonarQube local y SonarScanner CLI dentro de la imagen de API.
- CI local: Jenkins LTS con Configuration as Code.
- Observabilidad: Prometheus, Grafana, Loki, Tempo, OTel Collector, Alertmanager, Blackbox y cAdvisor.
- Persistencia: JSON local actual; PostgreSQL y Redis existen como perfil opcional `stateful`, no como dependencia runtime del core.

## Flujo actual de ejecucion

Modo nativo:

```bash
npm start
```

Modo liviano:

```bash
./scripts/hub-up-lite.sh
```

Modo observabilidad:

```bash
./scripts/hub-up-metrics.sh
docker compose --profile core --profile observability up -d
```

La API registra proyectos bajo `PROJECTS_ROOT`, descubre manifests, expone endpoints REST/SSE y ejecuta solo acciones aprobadas. El navegador no puede enviar comandos arbitrarios.

## Infraestructura existente

- Dockerfiles para API/worker y Jenkins.
- Compose local con perfiles separados por costo operativo.
- Healthchecks para servicios core y varios servicios auxiliares.
- Volumenes Docker nombrados para datos locales.
- Montaje de Docker socket en `control-api` y `jenkins` para orquestacion local.
- Prometheus scrapea el hub y servicios configurados; Grafana usa provisioning.

No se detectaron Kubernetes, Terraform, AWS ni GCP configurados en este workspace.

## Integraciones existentes

- SonarQube: configurado y consumido por API; verificacion depende de `SONAR_HOST_URL` y token opcional.
- Jenkins: configuracion local opcional con jobs multibranch.
- Git/GitHub/GitLab: discovery local de branch, commit, estado dirty, remoto y links derivados.
- Docker: discovery y control local por Compose cuando hay manifests aprobados.
- Grafana/Prometheus/Loki/Tempo/Alertmanager: enlaces y estado de servicios locales.

## Observabilidad

Estado actual:

- El hub expone `/metrics`.
- Prometheus, Grafana, Loki, Tempo, OTel Collector, Alertmanager y Blackbox estan provisionados por Compose.
- La UI diferencia servicios requeridos de opcionales.
- La observabilidad por proyecto externo todavia depende de que cada proyecto emita metricas, logs y trazas con labels compatibles.

Gap: no hay dashboards verificados por proyecto externo ni traces/logs reales por proyecto hasta instrumentar cada runtime.

## Seguridad

Controles existentes:

- `repositoryPath` debe ser relativo a `PROJECTS_ROOT`.
- `realpath` evita traversal y symlinks fuera del workspace permitido.
- `spawn` usa `shell: false`.
- Acciones permitidas por allowlist.
- Sanitizacion de logs y metadata para tokens, passwords, bearer headers y secretos comunes.
- El API no devuelve `SONAR_TOKEN`, solo indica si esta configurado.
- Produccion no esta modelada como ambiente operable; el sistema actual es local.

Riesgos:

- Docker socket otorga poder amplio sobre Docker Desktop.
- No hay autenticacion/RBAC.
- La persistencia JSON local no tiene migraciones ni concurrencia fuerte.
- Jenkins local con Docker socket hereda riesgo de Jenkinsfiles no confiables.

## Testing y documentacion

Testing actual:

- `npm run check`: sintaxis Node y JS frontend.
- `npm test`: test de API si hay server disponible.
- `scripts/smoke.sh`: levanta API temporal y valida endpoints core.
- `scripts/doctor.sh`: valida herramientas, puertos y Compose.

Documentacion existente:

- `README.md`.
- `docs/architecture.md`.
- `docs/security.md`.
- `docs/observability.md`.
- runbooks de Jenkins y SonarQube.
- ADRs 0001, 0002 y 0003.

## Funcionalidades reutilizables

- Discovery multi-stack.
- Local Run Engine.
- Jobs asincronicos con SSE.
- Sanitizacion de salida.
- Estado Git y fingerprint de fuentes.
- Validacion de links.
- Reporte de mejoras.
- Provisioning de observabilidad local.

## Funcionalidades faltantes

- Descriptor YAML como fuente declarada versionada.
- Vista explicita declarado/detectado/verificado por proyecto.
- Componentes como inventario formal.
- Health checks declarados y verificados por ambiente.
- RBAC/autenticacion.
- Persistencia con migraciones.
- Cloud discovery.
- Escaneos de seguridad integrados.
- Evidencias firmes para observabilidad por proyecto.

## Propuesta de arquitectura

Mantener el stack actual y cerrar brechas por capas:

1. Catalogo declarado desde YAML central.
2. Discovery detectado desde filesystem, Git y manifests.
3. Estado verificado desde runtime local, Docker, fingerprint, health checks y snapshots.
4. Adaptadores externos agregados fase por fase con estado `CONFIGURED_AND_VERIFIED`, `CONFIGURED_NOT_VERIFIED`, `PARTIALLY_CONFIGURED`, `NOT_CONFIGURED`, `UNSUPPORTED` o `ERROR`.

## Backlog priorizado

1. Fase 1: descriptor YAML, componentes y estado local declarado/detectado/verificado.
2. Fase 2: observabilidad por proyecto con queries verificadas y dashboards por labels.
3. Fase 3: seguridad y calidad con secret/dependency/container scanning.
4. Fase 4: adaptadores cloud solo si hay credenciales y proveedores reales.
5. Fase 5: orquestador de pruebas con evidencias.
6. Fase 6: despliegues con aprobaciones, rollback y auditoria.
7. Fase 7: documentacion viva generada desde estado verificado.

## Criterios de aceptacion

- El sistema compila.
- Tests y smoke pasan.
- No se exponen secretos.
- El descriptor se lee desde archivo real.
- La API muestra estados separado en declarado, detectado y verificado.
- La UI muestra gaps accionables sin simular exito.
- La documentacion registra riesgos y pendientes.
