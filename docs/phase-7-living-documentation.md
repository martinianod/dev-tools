# Fase 7 - Documentacion viva

Fase 7 convierte el estado verificado del hub en documentacion operativa generada, auditable y versionable.

## Alcance implementado

- Overview global: `GET /api/v1/docs/overview`.
- Overview por proyecto: `GET /api/v1/projects/{idOrSlug}/docs/overview`.
- Documentos por ambiente/proveedor desde Fase 12: `GET /api/v1/projects/{idOrSlug}/docs/documents`.
- Snapshot por proyecto: `POST /api/v1/projects/{idOrSlug}/docs/snapshot`.
- UI en la pestaña `Documentacion viva`.
- Export opcional a `docs/live/{projectSlug}.md`.
- Auditoria `docs.snapshot`.

## Fuentes

La documentacion viva se genera desde fuentes que ya existen en el hub:

- Descriptor YAML y estado declarado/detectado/verificado.
- Runtime local, Git, fingerprint y contenedores.
- Calidad y seguridad.
- Observabilidad.
- Infraestructura y drift.
- Pruebas y jobs.
- Despliegues y auditoria.

## Contenido generado

Cada proyecto expone:

- Guias operativas especificas del proyecto.
- Runbooks con triggers y pasos concretos.
- Diagramas Mermaid de topologia, despliegue y flujo de evidencia.
- Senales de confianza con score por fuente.
- Historial reciente de snapshots, jobs, deployments y auditoria.
- Markdown completo para snapshot.
- Desde Fase 12, matriz obligatoria, documentos `local-runtime`, `docker-compose`, `vps`, `aws`, `gcp`, `kubernetes` y metadata verificable.

## Confianza

La confianza no se declara manualmente. Se calcula desde estados verificados:

- `CONFIGURED_AND_VERIFIED`, `SUCCEEDED`, `READY`, `RUNNING`: alta.
- `PARTIALLY_CONFIGURED`, `CONFIGURED_NOT_VERIFIED`, `STALE`: media.
- `NOT_CONFIGURED`, `UNKNOWN`, `BLOCKED`: baja.
- `ERROR`, `FAILED`, `MISCONFIGURED`: cero.

Si el score baja de 60 o hay fuentes sin verificar, el modulo crea findings de documentacion.

## Snapshot

`POST /docs/snapshot` registra un snapshot con:

- estado,
- score de confianza,
- `sourceHash` SHA-256 de la evidencia verificada estable,
- hash SHA-256 del Markdown como metadato del snapshot,
- ruta exportada,
- findings resumidos,
- timestamp.

Cuando `export` no es `false`, el Markdown se escribe en `docs/live/{projectSlug}.md`. El endpoint solo escribe dentro de `docs/live/`.

El detector de snapshot obsoleto compara `sourceHash`, no el contenido completo del Markdown. Esto evita falsos positivos por campos volatiles como `generatedAt` o historial reciente.

## Guardrails

- No se aceptan comandos arbitrarios.
- No se consultan secretos ni se imprimen valores sensibles.
- Produccion/cloud permanece read-only.
- Los snapshots son auditados con `docs.snapshot`.
- En Docker, `docs/` se monta en `/app/docs` para que los snapshots exportados queden en el workspace del host.
- El historial se basa en eventos locales persistidos.
