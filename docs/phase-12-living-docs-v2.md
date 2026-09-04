# Fase 12 - Documentacion viva v2

Fase 12 completa el contrato `living-documentation.v2`. La documentacion ya no es solo un Markdown generado: cada proyecto expone una matriz obligatoria de secciones, documentos especificos por ambiente/proveedor y metadata verificable para saber de donde salio la evidencia.

## Metadata del documento

| Campo | Valor |
| --- | --- |
| Fecha de actualizacion | 2026-08-06 |
| Infraestructura verificada | API local, discovery, adaptadores e inventario desde endpoints del hub |
| Integraciones verificadas | quality-security, observability, infrastructure, deployments, testing y versions |
| Docs oficiales consultadas | No consultadas por esta generacion local |
| Nivel de confianza | Derivado por API desde senales verificadas, no asignado manualmente |
| Secciones no verificadas | Expuestas por `requiredSections` y `documents[].metadata.unverifiedSections` |

## Alcance implementado

- Overview global: `GET /api/v1/docs/overview`.
- Overview por proyecto: `GET /api/v1/projects/{idOrSlug}/docs/overview`.
- Documentos por ambiente/proveedor: `GET /api/v1/projects/{idOrSlug}/docs/documents`.
- Snapshot por proyecto: `POST /api/v1/projects/{idOrSlug}/docs/snapshot`.
- UI en la pestaña `Documentacion viva` con metadata, cobertura obligatoria, documentos por proveedor, fuentes oficiales, confianza, guias, runbooks, diagramas, historial, inventario y findings.
- Export opcional a `docs/live/{projectSlug}.md`.
- Auditoria `docs.snapshot`.

## Secciones obligatorias

Cada proyecto debe reportar estas secciones, con estado y evidencia:

| Seccion | Fuente local |
| --- | --- |
| Arquitectura | descriptor, componentes, recursos e infraestructura |
| Componentes | componentes declarados, detectados y verificados |
| Diagrama | Mermaid generado desde runtime, deployments y flujo de evidencia |
| Dependencias | manifests y scanner de calidad/seguridad |
| Puertos | runtime local y Docker/Compose |
| Variables requeridas | configuracion permitida por el agente local |
| Secretos requeridos | nombres de secretos, nunca valores |
| Comandos de ejecucion | perfiles aprobados y acciones cerradas |
| Build | comandos aprobados y ultimo build conocido |
| Tests | catalogo cerrado de pruebas |
| Despliegue | planes, aprobaciones, apply y verify |
| Rollback | registros previos, baseline y guardrails |
| Migraciones | manifests de migrations, Flyway, Liquibase, Prisma o TypeORM |
| Backups | runbooks de operaciones |
| Restauracion | disaster recovery y evidencia de restore |
| Observabilidad | metrics, logs, traces y alertas |
| Seguridad | secret scanning, dependencias, SonarQube y container scanning |
| Incidentes | jobs, deployments y auditoria fallida |
| Troubleshooting | runbooks operativos |
| Integraciones externas | links, adaptadores y herramientas detectadas |
| Costos aproximados | recursos detectados y limite de calculo cloud live |
| Limitaciones | findings y brechas reales |

Una seccion no verificada no bloquea la generacion, pero queda marcada como `CONFIGURED_NOT_VERIFIED`, `NOT_CONFIGURED`, `PARTIALLY_CONFIGURED` o `ERROR`. El sistema no convierte ausencia de evidencia en exito.

## Documentos generados

`GET /api/v1/projects/{idOrSlug}/docs/documents` devuelve documentos logicos para:

- `local-runtime`: ejecucion local y estado del repositorio.
- `docker-compose`: Compose, servicios y recursos detectados.
- `vps`: evidencia VPS cuando exista.
- `aws`: evidencia AWS cuando exista.
- `gcp`: evidencia Google Cloud cuando exista.
- `kubernetes`: evidencia Kubernetes/Helm/Kustomize cuando exista.

Cada documento incluye:

- `generatedFromCommit`, `generatedFromShortCommit`, `generatedFromBranch` y `generatedFromTag`.
- Fecha de generacion.
- Infraestructura verificada y fecha.
- Integraciones verificadas y fecha.
- Score/confianza.
- Secciones no verificadas.
- Docs oficiales consultadas y fecha.
- Proveedor y ambiente destino.

## Docs oficiales

La generacion automatica no consulta internet ni inventa fuentes externas. El campo `officialDocs` queda en `NOT_CONSULTED` salvo que una fase futura incorpore consulta explicita y verificable de documentacion oficial, con fuente y fecha.

Esto evita instrucciones genericas desconectadas de la plataforma local. Cuando una seccion depende de cloud real o de un proveedor externo sin credenciales verificadas, queda como no verificada.

## Guardrails

- Fuente: estado local verificado.
- Secretos: solo nombres/referencias; valores redaccionados.
- Comandos arbitrarios: bloqueados.
- Mutaciones cloud/produccion: bloqueadas.
- Writes: solo snapshots bajo `docs/live/`.
- Auditoria: `docs.snapshot`.
- Instrucciones genericas: bloqueadas por contrato.

## Validacion

Validacion local sin stack persistente:

```bash
npm run check
./scripts/smoke.sh
```

Validacion contra stack real:

```bash
HUB_TEST_BASE_URL=http://127.0.0.1:18080 npm test
curl -4 -fsS http://127.0.0.1:18080/api/v1/docs/overview
curl -4 -fsS http://127.0.0.1:18080/api/v1/projects/chedoparti-react-app/docs/documents
```

La UI se valida abriendo `http://127.0.0.1:18000`, seleccionando un proyecto y revisando la pestaña `Documentacion viva`.
