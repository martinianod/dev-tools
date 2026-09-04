# Fase 6 - Despliegues

Fase 6 agrega un orquestador local de despliegues con plan, aprobacion, apply, verificacion, rollback guardado y auditoria.

## Alcance implementado

- Overview global: `GET /api/v1/deployments/overview`.
- Overview por proyecto: `GET /api/v1/projects/{idOrSlug}/deployments/overview`.
- Plan local: `POST /api/v1/projects/{idOrSlug}/deployments/plan`.
- Aprobacion o rechazo: `POST /api/v1/projects/{idOrSlug}/deployments/plans/{planId}/approve|reject`.
- Apply aprobado: `POST /api/v1/projects/{idOrSlug}/deployments/plans/{planId}/apply`.
- Verify read-only: `POST /api/v1/projects/{idOrSlug}/deployments/verify`.
- Rollback guardado: `POST /api/v1/projects/{idOrSlug}/deployments/rollback`.
- UI en `Gestion de entorno` con el ciclo `Plan / Apply / Verify / Rollback`.
- Auditoria persistida en `state.auditEvents` con acciones `deployment.*`.

## Modelo operativo

El orquestador no acepta comandos libres. `apply` solo puede disparar perfiles ya aprobados por el Local Run Engine:

- `smart` -> `start`
- `rebuild` -> `start-fresh`
- `restart` -> `restart`

Un plan calcula:

- ambiente destino
- estrategia
- perfil runtime que se ejecutaria
- Git branch/commit/dirty state
- fingerprint de fuentes
- runtime actual y freshness
- pasos esperados
- blockers y warnings
- aprobacion requerida

Si el ambiente es `local`, existe un perfil runtime aprobado y el runtime esta configurado, el plan queda `READY` y crea una aprobacion `PENDING`. Si falta algun requisito, queda `BLOCKED` y no puede aplicarse.

## Guardrails

- Produccion y ambientes no locales quedan en modo read-only durante Fase 6.
- `apply` sobre produccion queda bloqueado hasta tener RBAC, reautenticacion y adaptadores cloud aprobados.
- Acciones destructivas y comandos arbitrarios quedan bloqueados.
- Los valores de credenciales nunca se devuelven al navegador.
- `apply` local requiere aprobacion explicita del plan.
- `verify` es read-only.
- `rollback` no hace `git checkout`, no restaura imagenes ni toca artifact stores no declarados.

## Rollback

Rollback se registra como operacion auditable. Solo se encola si existe una operacion previa con baseline verificable y el fingerprint local actual coincide con el fingerprint esperado de ese baseline.

Cuando no hay baseline/artifact local verificable, rollback devuelve un registro `BLOCKED` con error sanitizado. Ese bloqueo es intencional: evita afirmar una restauracion que el hub no puede ejecutar de forma segura.

## Estados

Planes:

- `READY`
- `BLOCKED`

Aprobaciones:

- `PENDING`
- `APPROVED`
- `REJECTED`

Registros:

- `QUEUED`
- `APPLYING`
- `SUCCEEDED`
- `FAILED`
- `BLOCKED`
- `ROLLED_BACK`

Verificacion:

- `CONFIGURED_AND_VERIFIED`
- `PARTIALLY_CONFIGURED`
- `CONFIGURED_NOT_VERIFIED`
- `ERROR`

## Validacion

La validacion automatizada cubre:

- `npm run check`
- `./scripts/smoke.sh`
- `HUB_TEST_BASE_URL=http://127.0.0.1:18080 npm test`

`scripts/smoke.sh` levanta una API temporal con data efimera, consulta los overviews de despliegue, genera un plan local, aprueba planes `READY`, ejecuta `verify` read-only y valida que `rollback` quede `QUEUED` o `BLOCKED` segun evidencia disponible.

## Limites pendientes

- RBAC real y reautenticacion por usuario.
- Artifact store versionado para rollback real entre revisiones.
- Adaptadores cloud/VPS/Kubernetes de apply.
- Promocion entre ambientes.
- Deployments firmados por release/tag.
