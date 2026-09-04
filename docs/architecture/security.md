# Architecture Security

Controles actuales:

- El filesystem de proyectos queda acotado a `PROJECTS_ROOT`.
- La UI no acepta comandos arbitrarios.
- Jobs y pruebas usan catalogos cerrados o perfiles detectados.
- Secretos se redactan antes de exponer logs, metadata, docs o responses.
- Cloud discovery es read-only.
- Deployments locales requieren plan y aprobacion.
- Produccion y ambientes no locales quedan bloqueados para apply/rollback.

Brechas pendientes:

- Autenticacion/RBAC real.
- Reautenticacion para acciones sensibles.
- Artifact store firmado para rollback real.
- Migracion de estado JSON a base transaccional.

