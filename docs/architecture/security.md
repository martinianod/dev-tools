# Architecture Security

Controles actuales despues de M0:

- El filesystem de proyectos queda acotado a `PROJECTS_ROOT`.
- Compose monta el project root read-only, elimina el mirror amplio RW y no entrega Docker socket al Control API.
- La API nativa usa loopback por defecto; Compose publica todos los puertos host sobre `127.0.0.1` por defecto. La exposición no-loopback falla sin auth y protege también las lecturas API/métricas cuando es explícitamente habilitada.
- Las mutaciones requieren Bearer externo y una policy central `READ`/`OPERATE`/`ADMIN`.
- Los proyectos son `UNTRUSTED` o `TRUSTED_LOCAL`; registrar no implica autorizar ejecucion.
- La UI no acepta comandos arbitrarios.
- Jobs y pruebas usan catalogos cerrados o perfiles detectados.
- Secretos se redactan antes de exponer logs, metadata, docs o responses.
- CORS usa allowlist exacta; requests y upstream responses tienen limites.
- Los upstreams HTTP usan origins configurados, redirects bloqueados y errores sanitizados.
- Cloud discovery es read-only.
- Deployments locales requieren plan y aprobacion.
- Produccion y ambientes no locales quedan bloqueados para apply/rollback.

Brechas pendientes:

- Identidades multiusuario, reautenticacion y RBAC durable; M0 usa un principal local unico.
- El modo nativo privilegiado sigue heredando permisos del usuario host.
- cAdvisor necesita mounts host read-only y Loki sigue sin auth interna; ambos quedan limitados a perfil opcional/red interna/loopback.
- Audit sigue en el store JSON mutable.
- Artifact store firmado para rollback real.
- Migracion de estado JSON a base transaccional.

Las excepciones con riesgo, alcance y milestone de eliminacion estan registradas en `docs/security.md`.
