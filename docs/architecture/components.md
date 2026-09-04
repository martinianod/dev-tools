# Components

## Web UI

Sirve HTML/CSS/JS desde `apps/web`. Consume exclusivamente `/api/v1/*` y no recibe secretos.

## Control API

`apps/control-api/server.mjs` implementa:

- discovery local,
- worker de jobs,
- Local Run Engine,
- scanners de calidad/seguridad,
- observabilidad,
- infraestructura,
- testing,
- despliegues,
- documentacion viva.

## State Store

El MVP persiste en JSON bajo `HUB_DATA_DIR/state.json`. Las entidades actuales incluyen proyectos, ambientes, runtimes, jobs, snapshots de calidad, planes/registros de despliegue, aprobaciones, snapshots de documentacion y auditoria.

## External Tools

SonarQube, Prometheus, Grafana, Loki, Tempo, Alertmanager y Jenkins son integraciones opcionales por perfil Docker.

