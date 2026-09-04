# Arquitectura

## Contexto encontrado

La raiz `/Users/martiniano/Documents/dev-tools` contenia infraestructura SonarQube reusable en `sonarqube/` y no contenia una aplicacion web o API previa. Por eso el hub se implementa como plataforma nueva dentro de esta raiz, sin reescribir la instalacion SonarQube existente.

## Componentes

```text
Browser
  |
  | HTTP
  v
Web UI static
  |
  | HTTP/SSE
  v
Control API + local worker
  |---- Project Registry
  |---- Discovery / Configuration Doctor
  |---- Job Orchestrator
  |---- Local Run Engine
  |---- SonarQube Adapter
  |---- Observability Adapter
  |---- Quality & Security Scanner
  |---- Infrastructure Discovery / Drift
  |---- Deployment Orchestrator
  |---- Living Documentation Generator
  |---- Catalog Descriptor Reader
  |
  |---- JSON state MVP
  `---- YAML declared catalog

Tools
  |---- SonarQube
  |---- Prometheus
  |---- Grafana
  |---- Loki
  |---- Tempo
  `---- Alertmanager
```

## Decisiones

- Frontend estatico para evitar dependencias de red en el MVP.
- Control API con Node.js built-in para tener un worker real sin paquetes externos.
- Persistencia JSON local inicial, con contrato API preparado para migrar a PostgreSQL.
- Descriptor YAML central para estado declarado de proyectos, componentes y ambientes.
- Comandos de ejecucion derivados exclusivamente de templates detectados.
- No se monta `/` ni `$HOME`.
- El perfil Docker monta `/var/run/docker.sock` solo para Local Run Engine local.
- `PROJECTS_ROOT` es el unico punto de acceso a repositorios.

## Modelo logico

### Project

- `id`
- `slug`
- `displayName`
- `description`
- `owner`
- `team`
- `criticality`
- `repositoryPath` relativo a `PROJECTS_ROOT`
- `detectedStack`
- `sonarProjectKey`
- `defaultBranch`
- `status`
- timestamps

### Environment

- `projectId`
- `name`
- `baseUrl`
- `healthUrl`
- `metricsUrl`
- labels Loki/Prometheus
- `tempoServiceName`
- `enabled`

### Component

- `name`
- `type`
- `path`
- `language`
- `source`
- `evidence`

### LocalState

- `declared`: descriptor YAML y ambientes declarados.
- `detected`: discovery desde filesystem, Git, manifests y Docker.
- `verified`: runtime local, fingerprint, contenedores, puertos y health checks configurados.
- `gaps`: diferencias accionables entre los tres estados.

### ExecutionJob

- `id`
- `projectId`
- `action`
- `status`
- `branch`
- `commit`
- `stages`
- `logs`
- `summary`
- `error`
- timestamps

### LocalRuntime

- `projectId`
- `status`
- `action`
- `composeFile`
- `composeProject`
- recursos Docker detectados
- puertos publicados
- logs sanitizados
- timestamps

### QualitySnapshot

- `projectId`
- `qualityGate`
- SonarQube measures
- links
- timestamp

### ObservabilityOverview

- `projectSlug`
- `environment`
- `metrics`: estado, queries Prometheus, muestras y links.
- `logs`: estado, query Loki, streams, lineas y logs locales.
- `traces`: estado, busqueda Tempo por `service.name`.
- `alerts`: estado y alertas Alertmanager.
- `dashboards`: dashboards Grafana verificados.
- `services`: disponibilidad de backends de observabilidad.
- `gaps`: brechas accionables.

### QualitySecurityOverview

- `projectSlug`
- `environment`
- `tests`: templates aprobados, coverage artifacts y ultimo job de tests/coverage.
- `sonarqube`: estado de servicio, `projectKey`, snapshot importado y links Sonar.
- `dependencies`: manifests, lockfiles, conteo de paquetes y riesgos de versionado/supply chain.
- `secretScanning`: archivos inspeccionados y findings con valores redaccionados.
- `containerScanning`: Dockerfiles/Compose inspeccionados y riesgos de runtime.
- `findings`: hallazgos normalizados con severidad, scanner, evidencia sanitizada, path relativo y accion sugerida.

### InfrastructureOverview

- `projectSlug`
- `environment`
- `declared`: componentes, ambientes y providers desde descriptor YAML.
- `adapters`: registro comun de adaptadores con estado, capacidades, timeouts, rate limits, credenciales por referencia y cache.
- `discoveryCache`: snapshot de manifests estaticos con TTL y `sourceHash`.
- `resources`: recursos detectados por manifests o runtime local.
- `manifests`: archivos de infraestructura inspeccionados.
- `drift`: findings entre descriptor, manifests y runtime local.

Fase 4 es read-only, Fase 8 agrego cache y Fase 10 completa el contrato de adaptadores. No ejecuta `aws`, `gcloud`, `az`, `kubectl`, `terraform`, `tofu`, `harness` ni scripts remotos. El refresh de discovery solo recalcula cache local y audita `infrastructure.discovery.refresh`.

### InfrastructureAdapterV1

- `interfaceVersion`: `infrastructure-adapter.v1`.
- `activation`: alta/baja por `INFRA_ADAPTERS_ENABLED` o `INFRA_ADAPTERS_DISABLED`.
- `validation`: manifiestos, recursos, credenciales por presencia y findings.
- `connectivity`: estado de prueba local/read-only o salto por politica.
- `secretPolicy`: valores nunca retornados ni logueados.
- `evidence`: manifests, recursos y pruebas sanitizadas.
- `errors`: severidad, codigo, titulo, detalle y evidencia entendible.

### TestingOverview

- `projectSlug`
- `environment`
- `definitions`: catalogo cerrado de pruebas y comandos/perfiles aprobados.
- `executions`: jobs de prueba con commit, branch, worker, parametros y evidencia.
- `guardrails`: limites de performance, bloqueo de comandos arbitrarios, DAST pasivo y kill switch.
- `workerPool`: worker local, concurrencia y cola.
- `targets`: URLs HTTP locales permitidas para load/DAST.
- `findings`: brechas de pruebas, evidencias faltantes y capacidades bloqueadas.

Fase 5 no ejecuta load/stress/DAST contra produccion. Load y DAST solo aceptan targets HTTP locales detectados; stress queda bloqueado hasta aprobaciones.

### DeploymentOverview

- `projectSlug`
- `environment`
- `environments`: ambientes declarados y capacidades de plan/apply/verify/rollback.
- `plans`: planes con estrategia, fingerprint, Git, runtime esperado, blockers y aprobacion.
- `approvals`: solicitudes y decisiones para `deployment.apply`.
- `records`: registros de apply/rollback con verificacion y error sanitizado.
- `audit`: eventos `deployment.*`.
- `guardrails`: produccion read-only, comandos arbitrarios bloqueados y apply local con aprobacion.
- `findings`: brechas de despliegue, aprobaciones pendientes y rollback sin baseline.

Fase 6 solo ejecuta `apply` local mediante perfiles aprobados del Local Run Engine. Produccion, cloud y acciones destructivas quedan bloqueadas hasta RBAC, reautenticacion, adapters de provider y artifact store verificable.

### LivingDocsOverview

- `projectSlug`
- `confidence`: score global y senales por fuente verificada.
- `guides`: guias operativas especificas del proyecto.
- `runbooks`: triggers, pasos y evidencia para incidentes frecuentes.
- `diagrams`: diagramas Mermaid generados desde runtime, despliegues y evidencia.
- `history`: snapshots, jobs, deployments y auditoria reciente.
- `inventory`: documentos presentes/faltantes del workspace.
- `markdown`: version exportable de la documentacion viva.
- `findings`: brechas de confianza, snapshots faltantes o fuentes no verificadas.

Fase 7 no inventa estados. Genera documentacion desde fuentes ya verificadas por el hub y marca confianza baja cuando faltan datos. Los snapshots se exportan solo bajo `docs/live/` y quedan auditados como `docs.snapshot`. La vigencia se calcula con `sourceHash` estable de evidencia, separado del `markdownHash` del contenido exportado.

### LocalAgentOverview

- `policy`: fase, permisos, transporte, TTL de heartbeat y guardrails.
- `agents`: identidad embebida, estado conectado/desconectado, capacidades y ultimo heartbeat.
- `latestDiscovery`: snapshot sanitizado por proyecto con Git, tags, stack, manifests, runtime, procesos, servicios locales, puertos, health checks y variables requeridas redaccionadas.
- `counts`: agentes, conexion, proyectos detectados y errores de discovery.

Fase 9 modela al agente local como el propio Control API embebido. No introduce daemon separado, no ejecuta comandos arbitrarios y no devuelve valores de secretos. El heartbeat y el refresh de discovery quedan auditados como `agent.heartbeat` y `agent.discovery.refresh`.

## Flujo de job

```text
POST /executions
  -> validar action
  -> resolver proyecto dentro de PROJECTS_ROOT
  -> detectar templates aprobados
  -> QUEUED
  -> PREPARING
  -> RUNNING stages
  -> si Sonar: esperar Compute Engine task
  -> consultar Quality Gate
  -> importar snapshot
  -> SUCCEEDED/FAILED
```

## Flujo de prueba Fase 5

```text
GET /testing/overview
  -> detectar comandos aprobados, perfiles smoke y targets HTTP locales
  -> calcular guardrails y evidencias

POST /testing/executions
  -> validar definitionId del catalogo cerrado
  -> validar guardrails y kill switch
  -> crear job con testPlan sanitizado
  -> worker ejecuta stage aprobado o interno read-only
  -> persistir logs, metricas y findings pasivos
```

## Flujo de despliegue Fase 6

```text
POST /deployments/plan
  -> validar ambiente y estrategia
  -> resolver proyecto dentro de PROJECTS_ROOT
  -> calcular Git, fingerprint, runtime y guardrails
  -> READY + approval PENDING o BLOCKED

POST /deployments/plans/{id}/approve
  -> marcar aprobacion APPROVED
  -> auditar decision

POST /deployments/plans/{id}/apply
  -> exigir plan READY y aprobacion APPROVED
  -> encolar registro apply
  -> ejecutar perfil runtime aprobado
  -> verificar runtime, freshness, recursos y smoke
  -> SUCCEEDED/FAILED + auditoria

POST /deployments/verify
  -> read-only runtime/fingerprint/resources/smoke

POST /deployments/rollback
  -> exigir baseline previo verificable
  -> encolar restart guardado o devolver BLOCKED
```

## Flujo de documentacion viva Fase 7/12

```text
GET /docs/overview
  -> resumir confianza por proyecto
  -> inspeccionar inventario documental
  -> exponer findings de documentacion

GET /projects/{id}/docs/overview
  -> leer estado declarado/detectado/verificado
  -> cruzar quality, observability, infrastructure, testing y deployments
  -> incorporar Git/versiones, infraestructura e integraciones verificadas
  -> calcular confianza por fuente
  -> generar matriz obligatoria de secciones Fase 12
  -> generar documentos local-runtime, docker-compose, vps, aws, gcp y kubernetes
  -> calcular sourceHash de evidencia estable
  -> generar guias, runbooks, diagramas e historial
  -> producir Markdown y markdownHash

GET /projects/{id}/docs/documents
  -> devolver documentos especificos por ambiente/proveedor
  -> exponer metadata de commit, generacion, infraestructura, integraciones y docs oficiales
  -> listar secciones no verificadas sin afirmar exito

POST /projects/{id}/docs/snapshot
  -> regenerar Markdown
  -> opcionalmente escribir docs/live/{slug}.md
  -> registrar snapshot en estado local
  -> auditar docs.snapshot
```

## Flujo de agente local Fase 9

```text
GET /agents/overview
  -> asegurar identidad local embebida
  -> calcular estado por heartbeat TTL
  -> exponer politica, capacidades y ultimo discovery

POST /agents/heartbeat
  -> registrar heartbeat CONNECTED
  -> actualizar proyectos/errores conocidos
  -> auditar agent.heartbeat

POST /agents/discovery/refresh
  -> recorrer proyectos registrados
  -> detectar Git, tags, stack, manifests, runtime, procesos, servicios, puertos y variables requeridas
  -> redaccionar secretos y calcular sourceHash
  -> persistir snapshot y auditar agent.discovery.refresh
```

## Flujo de discovery de adaptadores Fase 8

```text
GET /infrastructure/adapters
  -> listar adaptadores, capacidades, timeouts, rate limits y cache

GET /projects/{id}/infrastructure/overview
  -> leer cache static-manifests si sigue vigente
  -> combinar cache estatico con runtime Docker actual
  -> calcular drift y estados por adaptador

POST /projects/{id}/infrastructure/refresh
  -> validar adapter solicitado
  -> recalcular manifests estaticos sin llamadas cloud live
  -> persistir snapshot con sourceHash y TTL
  -> auditar infrastructure.discovery.refresh
```

## Flujo de adaptadores Fase 10

```text
GET /infrastructure/adapters
  -> listar adaptadores infrastructure-adapter.v1
  -> exponer capacidades, activacion, timeouts, rate limits y politica de secretos

GET /projects/{id}/infrastructure/overview
  -> detectar Docker, Compose, Terraform/OpenTofu, CloudFormation, Kubernetes, Azure, VPS, SCM, CI, observabilidad, registries, SMTP y object storage
  -> validar configuracion por manifest/recurso/entorno sin valores sensibles
  -> probar conectividad local/read-only cuando aplica
  -> reportar evidencia y errores entendibles por adaptador

POST /projects/{id}/infrastructure/refresh
  -> recalcular discovery estatico
  -> respetar activacion de adaptadores
  -> persistir sourceHash y auditar refresh
```

## Flujo de Git y versiones Fase 11

```text
GET /versions/overview
  -> consolidar estado Git, remoto, fingerprint y deploy local por proyecto
  -> reportar worktrees dirty, ahead/behind y versiones desplegadas obsoletas

GET /projects/{id}/versions/overview
  -> detectar repositorio Git, rama, commit, tag, remote y ultimo pull
  -> comparar fingerprint/commit local contra ultimo deploy registrado
  -> exponer acciones cerradas Start, Restart, Rebuild changed components, Clean rebuild, Pull and rebuild, Stop y View detected changes

POST /projects/{id}/runtime/pull-rebuild
  -> bloquear si hay cambios locales, operacion Git en curso o falta upstream
  -> ejecutar git fetch --prune y git pull --ff-only
  -> forzar build/recreate preservando volumenes

POST /projects/{id}/runtime/volumes/delete
  -> exigir acknowledgedDataLoss=true y confirmation exacto
  -> ejecutar compose down --volumes solo despues de confirmacion explicita
```

## Flujo de runtime local

```text
POST /projects/{id}/runtime/start|stop|restart
  -> validar action
  -> resolver proyecto dentro de PROJECTS_ROOT
  -> verificar Docker CLI/socket
  -> detectar compose file aprobado
  -> resolver compose project name
  -> validar conflictos de puertos
  -> ejecutar docker compose up/down con shell:false
  -> importar recursos, puertos y logs
  -> actualizar estado local del proyecto
```

## Estados

Jobs:

- `QUEUED`
- `PREPARING`
- `RUNNING`
- `SUCCEEDED`
- `FAILED`
- `CANCELLED`
- `TIMED_OUT` reservado

Projects:

- `ACTIVE`
- `MISCONFIGURED`
- `DISABLED` reservado

Local runtime:

- `stopped`
- `starting`
- `running`
- `stopping`
- `restarting`
- `degraded`
- `error`
- `unavailable`

Deployments:

- `READY`
- `BLOCKED`
- `PENDING`
- `APPROVED`
- `REJECTED`
- `QUEUED`
- `APPLYING`
- `SUCCEEDED`
- `FAILED`
- `ROLLED_BACK`

Living documentation:

- `CONFIGURED_AND_VERIFIED`
- `PARTIALLY_CONFIGURED`
- `CONFIGURED_NOT_VERIFIED`
- `NOT_CONFIGURED`
- `ERROR`

## Multiambiente

El MVP ejecuta localmente. Para `dev`, `staging` y `prod`, la arquitectura reserva `Environment`, `ExecutionProvider` y adaptadores de observabilidad por ambiente. No se asume acceso a filesystem remoto.
