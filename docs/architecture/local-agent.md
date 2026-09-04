# Local Agent

El agente local es el Control API ejecutandose en esta maquina o dentro del contenedor `control-api`. Desde Fase 9 tiene identidad estable, heartbeat, discovery local sanitizado y auditoria propia.

Responsabilidades:

- Resolver rutas dentro de `PROJECTS_ROOT`.
- Exponer identidad, capacidades y estado en `GET /api/v1/agents/overview`.
- Registrar heartbeat en `POST /api/v1/agents/heartbeat`.
- Generar snapshots de discovery local en `POST /api/v1/agents/discovery/refresh`.
- Ejecutar comandos aprobados con `spawn(..., shell:false)`.
- Leer Docker, Git y manifests.
- Mantener logs sanitizados.
- Publicar SSE para jobs.
- Auditar acciones.
- Redaccionar valores de secretos y reportar solo presencia/configuracion.

No hace:

- Mutaciones cloud.
- Comandos arbitrarios ingresados desde navegador.
- Escrituras fuera del workspace del hub, salvo acciones explicitas sobre proyectos cuando el usuario lo pida en Codex.
- Lectura o devolucion de valores de tokens.
