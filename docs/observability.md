# Observabilidad

## Objetivo

Consolidar estado operativo sin duplicar series temporales en la base del hub.

Fuentes:

- Prometheus para metricas.
- Loki para logs.
- Tempo para trazas.
- Alertmanager para alertas.
- Grafana para dashboards detallados.

## Perfiles Docker

Modo recomendado para uso diario:

```bash
./scripts/hub-up-metrics.sh
```

Esto levanta `core + metrics`: `control-api`, `web`, `prometheus` y `grafana`.

Perfiles especializados:

- `logging`: Loki.
- `tracing`: Tempo, `tempo-init` y OTel Collector.
- `alerting`: Alertmanager y Blackbox.
- `observability`: stack completo para diagnostico profundo.

Grafana, Loki, Tempo, OTel y Alertmanager conservan acceso host exclusivamente loopback porque la UI del hub o procesos locales los consumen. Se conectan tambien a `hub-observability-host`, una red no interna acotada al dominio de observabilidad, mientras `hub-observability` sigue siendo interna. Blackbox y cAdvisor son `INTERNAL_ONLY`: Prometheus los consulta por red Docker y no publican puertos al host.

Para apagar servicios pesados sin borrar volumenes:

```bash
./scripts/hub-down-heavy.sh
```

## Labels obligatorios

Cada proyecto instrumentado debe emitir:

- `service.name`
- `service.namespace`
- `deployment.environment.name`
- `service.version` o Git SHA
- `project`
- `environment`

Evitar labels de alta cardinalidad como email, user ID, request ID o URL cruda.

## Metricas

Minimo recomendado:

- RED: rate, errors, duration.
- USE: utilization, saturation, errors.
- Jobs: cola, duracion, errores.
- JVM cuando aplique.
- DB pool cuando aplique.

Los percentiles deben calcularse desde histogramas, no agregando percentiles.

## Logs

Formato recomendado: JSON estructurado.

Campos:

- timestamp
- level
- service
- environment
- logger
- message
- trace_id
- span_id
- correlation_id

Los tokens, cookies, authorization headers, passwords y PII deben redactarse antes de salir de la app.

## Trazas

Usar OTLP hacia Collector:

- gRPC: `http://localhost:14317`
- HTTP: `http://localhost:14318`

Propagacion: W3C Trace Context.

Tempo usa el volumen nombrado `hub_tempo_data`. El servicio `tempo-init` prepara ese volumen antes de arrancar Tempo para evitar fallos de permisos manteniendo el proceso principal sin root.

## Salud de collectors

Blackbox soporta `/-/ready`; Compose usa ese endpoint como healthcheck real. OTel Collector usa una imagen distroless sin shell ni cliente HTTP, por lo que no se agrega un Docker healthcheck que no pueda ejecutarse de forma fiable. La extension oficial `health_check` queda habilitada en `otel-collector:13133` sobre la red interna y se verifica operacionalmente desde un cliente autorizado de esa red. El estado `running` por si solo no se considera prueba de readiness.

## Alertas locales

Reglas base incluidas:

- `QualityHubServiceDown`
- `QualityHubTargetMissing`
- `LocalEndpointProbeFailed`
- `ProjectTelemetryTargetsMissing`

Los proyectos externos deben sumar reglas por servicio una vez instrumentados y scrapeados.

## Endpoints del hub

Overview global:

```text
GET /api/v1/observability/overview
```

Overview por proyecto:

```text
GET /api/v1/projects/{idOrSlug}/observability/overview
```

El endpoint por proyecto consulta Prometheus, Loki, Tempo y Alertmanager con timeouts cortos y devuelve estados normalizados. No marca una senal como verificada si el backend no devuelve muestras, streams, trazas o alertas reales.

## Dashboard por proyecto

Grafana provisiona:

```text
Project Observability
uid: quality-hub-project-observability
```

Variables:

- `project`
- `environment`

Los links del catalogo abren este dashboard filtrado por proyecto local.

## Sin datos

Si un proyecto no esta corriendo o no emite telemetria, el dashboard muestra `Sin datos`. No se muestra `0%`, `UP` ni exito ficticio.
