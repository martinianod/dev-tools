# Runbooks Operativos

Los runbooks vivos se generan por proyecto desde `GET /api/v1/projects/{idOrSlug}/docs/overview`.

## Runtime obsoleto o fallido

Trigger:

- `freshness=stale`
- `freshness=failed`
- `runtime=error`
- `runtime=degraded`

Pasos:

1. Abrir `Gestion de entorno`.
2. Revisar fingerprint actual y ultimo deploy.
3. Ejecutar `Start`.
4. Si falla, abrir `Terminal / logs`.
5. Ejecutar `Verify` de despliegues o smoke segun corresponda.

## SonarQube sin snapshot

Trigger:

- Quality Gate sin datos.
- `401`, `403`, `not authorized`.
- SonarQube local apagado.

Pasos:

1. Confirmar `SONAR_HOST_URL`.
2. Configurar `SONAR_TOKEN` en el environment externo del backend y reiniciar la API; la UI no acepta ni persiste secretos de herramientas.
3. Ejecutar tests/coverage si faltan artefactos.
4. Ejecutar Sonar.
5. Revisar Quality Gate y Compute Engine.

## Rollback bloqueado

Trigger:

- `ROLLBACK_NOT_AVAILABLE`.
- `ROLLBACK_ARTIFACT_NOT_AVAILABLE`.

Pasos:

1. Leer el registro de rollback en `Despliegues Fase 6`.
2. Confirmar si existe apply exitoso previo.
3. No ejecutar `git checkout` ni restaurar imagenes manualmente desde el hub.
4. Incorporar artifact store verificable antes de afirmar rollback real.

## Observabilidad incompleta

Trigger:

- Metrics, logs o traces en `NOT_CONFIGURED` o `ERROR`.

Pasos:

1. Abrir Grafana `Project Observability`.
2. Confirmar Prometheus, Loki y Tempo.
3. Revisar labels `project` y `environment`.
4. Agregar instrumentacion real en el repo externo.
5. Regenerar documentacion viva.
