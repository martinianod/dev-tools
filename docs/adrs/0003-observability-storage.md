# ADR 0003: No duplicar series temporales

## Estado

Aceptado.

## Contexto

Prometheus, Loki y Tempo ya son backends especializados para series, logs y trazas.

## Decision

El hub guarda snapshots, metadata y estado de integraciones. No copia series temporales completas a su store local.

## Consecuencias

- Menor volumen y menor riesgo de datos inconsistentes.
- El dashboard debe degradar parcialmente si un backend externo cae.
- Las queries historicas avanzadas siguen viviendo en Grafana/SonarQube.
