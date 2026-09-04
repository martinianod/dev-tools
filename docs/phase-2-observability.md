# Fase 2 - Observabilidad

Fecha: 2026-08-05.

## Alcance implementado

Fase 2 queda acotada a observabilidad local verificable con el stack existente.

Implementado:

- Endpoint global `GET /api/v1/observability/overview`.
- Endpoint por proyecto `GET /api/v1/projects/{idOrSlug}/observability/overview`.
- Verificacion de disponibilidad de Prometheus, Grafana, Loki, Tempo y Alertmanager.
- Queries Prometheus por `project` para `up` y `probe_success`.
- Query Loki por `{project="<slug>", environment="local"}`.
- Busqueda Tempo por `service.name=<slug>`.
- Lectura de alertas Alertmanager filtradas por proyecto y plataforma.
- Links directos a Prometheus Graph, Grafana Explore y dashboard de proyecto.
- Dashboard Grafana provisionado `Project Observability`.
- Regla Prometheus `ProjectTelemetryTargetsMissing` para explicitar que todavia no hay targets no-plataforma.
- UI de "Observabilidad verificada" en la pestaña `Calidad y observabilidad`.
- Tests y smoke actualizados para validar los endpoints nuevos.

## Estados

Los estados posibles son:

- `CONFIGURED_AND_VERIFIED`
- `CONFIGURED_NOT_VERIFIED`
- `PARTIALLY_CONFIGURED`
- `NOT_CONFIGURED`
- `UNSUPPORTED`
- `ERROR`

No se muestra OK cuando no hay datos reales. Si un backend esta apagado, el estado queda en `ERROR`. Si el proyecto no tiene instrumentacion/labels, queda en `NOT_CONFIGURED`.

## Modelo por proyecto

El endpoint por proyecto devuelve:

- `metrics`: Prometheus, queries y cantidad de muestras.
- `logs`: Loki, query y cantidad de streams/lineas.
- `traces`: Tempo, busqueda por `service.name` y cantidad de trazas.
- `alerts`: Alertmanager, alertas activas/totales.
- `dashboards`: dashboard Grafana filtrado por proyecto y link Prometheus.
- `instrumentation`: evidencia detectada desde manifests.
- `services`: disponibilidad del backend de observabilidad.
- `gaps`: brechas accionables.

## Dashboards

Dashboard nuevo:

```text
config/grafana/dashboards/project-observability.json
```

UID:

```text
quality-hub-project-observability
```

Variables:

- `project`
- `environment`

Paneles:

- Project scrape up.
- HTTP probe success.
- Scrape targets by project.
- Project logs.
- Firing alerts.

## Alertas

Regla nueva:

```text
ProjectTelemetryTargetsMissing
```

Esta alerta es informativa y representa el estado real actual: Prometheus puede estar operativo aunque todavia no scrapee proyectos externos con `project!="platform"`.

## Pendientes fuera de Fase 2

- Agregar scrape configs por proyecto cuando cada proyecto exponga `metricsUrl`.
- Agregar ingestion real de logs hacia Loki desde cada runtime.
- Agregar propagacion OTLP real desde cada proyecto hacia OTel Collector/Tempo.
- Crear dashboards especificos por dominio cuando haya metricas reales.
- Vincular runbooks por alerta de proyecto.
- Definir SLOs por criticidad y ambiente.

## Verificacion

Comandos:

```bash
npm run check
./scripts/smoke.sh
./scripts/doctor.sh
```

Si se levanta observabilidad:

```bash
docker compose --profile core --profile observability up -d
curl -4 -fsS http://127.0.0.1:18080/api/v1/observability/overview
curl -4 -fsS http://127.0.0.1:18080/api/v1/projects/chedoparti-react-app/observability/overview
```
