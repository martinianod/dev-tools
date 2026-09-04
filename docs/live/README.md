# Living Documentation Snapshots

Este directorio contiene snapshots Markdown exportados por Fase 7/12.

Los archivos se generan desde `POST /api/v1/projects/{idOrSlug}/docs/snapshot` y quedan vinculados a un evento de auditoria `docs.snapshot`.

Cada snapshot tiene un `sourceHash` estable de evidencia verificada. Si ese hash coincide con el overview actual, el snapshot sigue vigente aunque cambien timestamps o historial operativo.

Desde Fase 12 el snapshot tambien incluye contrato `living-documentation.v2`, matriz obligatoria de secciones, documentos por ambiente/proveedor, metadata de commit/origen, infraestructura e integraciones verificadas y registro explicito de documentacion oficial consultada.

No editar estos snapshots para corregir el estado operativo: corregir primero la fuente verificada del hub y regenerar el snapshot.
