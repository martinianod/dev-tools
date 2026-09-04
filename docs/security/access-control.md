# Access Control

Estado actual:

- No hay RBAC real ni login multiusuario.
- El actor auditado es `local-user`.
- Las acciones sensibles se reducen por guardrails tecnicos:
  - comandos cerrados,
  - paths permitidos,
  - cloud read-only,
  - aprobacion explicita para deployment local.

Pendiente:

- usuarios,
- roles,
- permisos por proyecto,
- reautenticacion para apply/rollback,
- firma de aprobaciones.

