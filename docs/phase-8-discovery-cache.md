# Fase 8 - Discovery de adaptadores y cache

Fase 8 endurece el discovery de infraestructura con un registro comun de adaptadores, politica read-only, cache con TTL y refresh auditado.

## Alcance implementado

- Registro comun de adaptadores en `GET /api/v1/infrastructure/adapters`.
- Registro por proyecto en `GET /api/v1/projects/{idOrSlug}/infrastructure/adapters`.
- Refresh read-only en `POST /api/v1/projects/{idOrSlug}/infrastructure/refresh`.
- Cache persistente de manifests estaticos bajo `HUB_DATA_DIR/state.json`.
- UI en `Calidad y observabilidad` con `Discovery y cache` y boton `Refrescar discovery`.
- Auditoria `infrastructure.discovery.refresh`.

## Adaptadores declarados

El registro cubre:

- `local`
- `terraform`
- `aws`
- `gcp`
- `vps`
- `kubernetes`
- `github`
- `gitlab`
- `jenkins`
- `sonarqube`
- `grafana`
- `prometheus`
- `loki`
- `tempo`
- `registry`
- `smtp`

Cada adaptador expone `capabilities`, `mode`, `timeoutMs`, `rateLimit`, `credentialRefs`, `credentialState`, `liveCalls` y `enabled`.

## Cache

El cache guarda solo inventario estatico derivado de manifests: recursos, findings y rutas inspeccionadas. No guarda secretos ni resultados de comandos arbitrarios.

- TTL por defecto: 300 segundos.
- Variable: `INFRA_DISCOVERY_CACHE_TTL_MS`.
- Scope: `static-manifests`.
- Hash: `sourceHash` SHA-256 estable sobre manifests, recursos y findings.

El runtime Docker se sigue leyendo en cada overview; solo el inventario estatico de manifests usa cache.

## Guardrails

- Cloud live discovery sigue deshabilitado.
- No se ejecutan `aws`, `gcloud`, `kubectl`, `terraform` ni SSH.
- Credenciales se reportan por presencia/nombre de variable, nunca por valor.
- Refresh queda auditado localmente.
- Produccion y cloud siguen read-only.

