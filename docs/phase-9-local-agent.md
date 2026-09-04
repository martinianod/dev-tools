# Fase 9 - Agente local

Fase 9 formaliza el agente local embebido en Control API como identidad auditable para discovery local. El objetivo es exponer estado, capacidades, heartbeat y snapshots sin abrir comandos arbitrarios ni revelar secretos.

## Alcance implementado

- Identidad estable del agente en `GET /api/v1/agents/overview`.
- Heartbeat auditable en `POST /api/v1/agents/heartbeat`.
- Discovery local bajo demanda en `POST /api/v1/agents/discovery/refresh`.
- UI en el panel principal con estado, identidad, seguridad, ultimo snapshot y acciones controladas.
- Inventario por proyecto de Git, tags, stack, manifests, runtime Docker, procesos, servicios locales, puertos, health checks, observabilidad, artefactos de cobertura y comandos aprobados.
- Auditoria `agent.heartbeat` y `agent.discovery.refresh`.

## Politica de seguridad

El agente corre como componente embebido del Control API local. Su politica declarada es:

- `secretValues`: `never_read_or_returned`.
- `arbitraryCommands`: `blocked`.
- Permisos: lectura minima del workspace local y acciones runtime previamente aprobadas.
- Transporte: loopback o red Docker local.
- Heartbeat con TTL configurable por `LOCAL_AGENT_HEARTBEAT_TTL_MS`.
- Revocacion prevista por estado `REVOKED`.

La fase no introduce daemon externo, credenciales persistentes nuevas, actualizaciones remotas ni mutaciones cloud.

## Discovery

El refresh recorre los proyectos registrados y compone un snapshot estable con hash SHA-256. Cada proyecto reporta:

- estado de Git sanitizado;
- tags asociados al commit actual;
- lenguajes, frameworks y gestores de dependencias detectados;
- Dockerfiles y Compose manifests;
- containers, procesos Docker, servicios locales y puertos publicados observados;
- health checks, metricas, logs y trazas detectadas;
- comandos de test/build aprobados;
- variables requeridas por nombre y estado de configuracion, siempre con valor `[REDACTED]`.

Los errores quedan asociados al proyecto afectado y el snapshot completo usa estado `PARTIALLY_CONFIGURED` cuando hay brechas.

## Guardrails

- No lee ni retorna valores de tokens.
- No ejecuta comandos libres desde UI/API.
- No realiza llamadas live a providers cloud.
- No escribe fuera del estado local del hub y de los snapshots documentales ya controlados.
- Todo heartbeat y refresh queda auditado con correlation id.
