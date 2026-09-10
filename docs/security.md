# Seguridad

## Baseline M0

M0 convierte el hub en un control plane local fail-closed. Los endpoints de lectura pueden consultarse sin credencial desde loopback; toda mutacion requiere un principal Bearer configurado externamente. El perfil Docker `core` no tiene Docker socket ni permisos de escritura sobre los proyectos.

Esto no es IAM enterprise ni el aislamiento definitivo del futuro Target Agent. Es una frontera minima, centralizada y extensible.

## Red y CORS

- La API nativa escucha en `127.0.0.1` por defecto.
- Dentro del contenedor escucha en `0.0.0.0` porque Docker necesita alcanzar el proceso, pero Compose publica exclusivamente en `${HUB_BIND_ADDRESS:-127.0.0.1}`.
- Un bind publico no-loopback sin auth impide el arranque; con auth, tambien las lecturas `/api/*` y `/metrics` requieren Bearer.
- Todos los puertos administrativos publicados usan el mismo bind loopback.
- PostgreSQL y Redis no publican puertos al host.
- `hub-quality` y `hub-observability` son redes Docker internas.
- CORS solo acepta origins exactos de `HUB_ALLOWED_ORIGINS`; no usa wildcard ni refleja origins arbitrarios.

No cambiar `HUB_BIND_ADDRESS` o `HUB_API_HOST` a una interfaz remota sin credenciales, firewall y revision de la frontera de confianza.

## Authentication y authorization

Variables externas:

```dotenv
HUB_AUTH_TOKEN=<32-o-mas-caracteres-aleatorios>
HUB_AUTH_ACTOR_ID=<identidad-auditable>
HUB_AUTH_ROLE=ADMIN
```

El token no tiene default y nunca se versiona. Si falta, la API queda en modo read-only: las mutaciones responden `401 AUTHENTICATION_REQUIRED`.

Roles centralizados:

- `READ`: consultas.
- `OPERATE`: heartbeat, refresh, jobs, runtime y operaciones no destructivas.
- `ADMIN`: alta/cambio de proyectos, trust, aprobaciones, rollback, borrado de volumenes y logs.

No hay checks `if user == ...` distribuidos por handlers. La policy se calcula antes del routing y el actor autenticado se propaga a auditoria, jobs, planes, aprobaciones y deployments.

La UI conserva temporalmente el token del hub en `sessionStorage`; no lo guarda en estado de proyecto ni `localStorage`.

## Filesystem y trust de proyectos

La API solo acepta `repositoryPath` relativo a `PROJECTS_ROOT`:

- rechaza rutas absolutas y traversal;
- compara `realpath` del root y destino;
- rechaza symlinks que escapan del root;
- sanea rutas en logs y errores.

La inspeccion Git read-only deshabilita hooks, fsmonitor, credential helpers y configuracion global/system para no convertir discovery de un repo no confiable en ejecucion implicita.

Compose monta una sola raiz portable `${PROJECTS_ROOT}` en `/workspace/projects:ro`. Se eliminaron el segundo mirror del host y el mount read-write de todo Documents. Las superficies de escritura del contenedor son el volumen de estado, caches y `docs/live`.

Cada proyecto tiene trust explicito:

- `UNTRUSTED`: discovery read-only; no ejecuta codigo.
- `TRUSTED_LOCAL`: permite perfiles locales solo cuando el boundary privilegiado esta habilitado y el principal tiene autorizacion.

Los cinco proyectos originales declaran `TRUSTED_LOCAL` en el catalogo versionado. Un proyecto creado por API inicia siempre como `UNTRUSTED`.

## Execution boundary

El frontend nunca aporta comandos. Las operaciones derivan de sets cerrados y perfiles detectados, se ejecutan con `shell:false`, path canonico, timeout, limite de output, redaccion y auditoria.

El perfil Compose `core` fuerza:

```dotenv
HUB_PRIVILEGED_EXECUTION_ENABLED=0
```

y no monta `/var/run/docker.sock`. En ese modo, runtime, jobs y apply/rollback que ejecuten codigo responden `503 PRIVILEGED_EXECUTION_DISABLED`.

La compatibilidad con Local Run Engine existe solo en ejecucion nativa explicita:

1. bind `127.0.0.1`;
2. auth externa configurada;
3. `HUB_PRIVILEGED_EXECUTION_ENABLED=1`;
4. proyecto `TRUSTED_LOCAL`;
5. Docker CLI bajo el usuario local, sin API container root.

Esta frontera reduce el riesgo P0, pero el proceso nativo aun posee los permisos de su usuario. El aislamiento definitivo corresponde al futuro agente/runner local tipado, no a M0.

## Request y abuse guards

- Body default: 1 MiB, configurable con `HUB_REQUEST_BODY_LIMIT_BYTES`; exceso devuelve 413.
- Mutaciones: 60 solicitudes por minuto por principal/direccion, configurable.
- Correlation IDs del cliente se aceptan solo con caracteres y longitud acotados.
- Headers: CSP, deny framing, nosniff, no-referrer y Permissions Policy.

El rate limiter es en memoria y single-instance. Se reinicia con el proceso y no reemplaza un gateway distribuido.

## SSRF y upstreams

Todas las lecturas HTTP salientes generales pasan por una validacion central:

- HTTP/HTTPS unicamente;
- origin exacto configurado por el servidor;
- sin credentials embebidas ni fragments;
- redirects bloqueados;
- timeout global maximo;
- respuesta maxima de 1 MiB por defecto;
- mensajes de error sin URL ni body upstream.

`SONAR_HOST_URL`, `JENKINS_URL` y demas origins globales quedan automaticamente allowlisted. Origins adicionales requieren `HUB_ALLOWED_UPSTREAM_ORIGINS`. La API no acepta un destino arbitrario enviado por un request web.

## Secretos

`SONAR_TOKEN`, auth, Grafana, Jenkins y passwords de base solo se resuelven desde environment externo. M0 deja de aceptar `sonarToken` en runtime config y elimina el valor legacy durante la migracion del estado.

`additionalEnv` es exclusivamente no secreto:

- claves sensibles se rechazan semanticamente, no solo por sufijo;
- valores con apariencia de credential, URL autenticada, Bearer o private key se rechazan;
- valores no publicos se muestran como `[CONFIGURED]` en la API/UI;
- solo prefijos `VITE_`, `NEXT_PUBLIC_` y `PUBLIC_` muestran valor.

La redaccion estructural cubre metadata sensible y la redaccion textual elimina valores conocidos, tokens, Authorization y URLs con credenciales. Ningun problem response incluye query string, stack trace, comando completo o body upstream.

## Docker Compose hardening

Aplicado segun compatibilidad de imagen:

- `restart: unless-stopped` en servicios persistentes;
- loopback explicito en puertos host;
- `read_only`, `tmpfs`, `cap_drop: ALL` y `no-new-privileges` donde son compatibles;
- control-api non-root y sin socket;
- Jenkins non-root, sin socket, sin project mount y sin agent port;
- Grafana sin anonymous access ni admin inicial por defecto;
- PostgreSQL/Redis internos;
- limites de memoria para core y servicios opcionales.

Credenciales vacias hacen que los perfiles stateful/quality/CI fallen cerrados hasta que el operador las provea externamente.

### Acceso de red por servicio

| Servicio | Host local | Control plane/containers | Salida externa |
| --- | --- | --- | --- |
| control-api | API loopback | `hub-core`, `hub-quality`, `hub-observability` | si, por `hub-core`, para links/configuracion aprobada |
| web | UI loopback | `hub-core` hacia control-api | no requerida |
| PostgreSQL / Redis | no publicado | `hub-core` | no requerida |
| SonarQube / sonar-postgres | Sonar UI loopback; DB no | `hub-quality` interna | no por defecto; plugins requieren una activacion revisada |
| Prometheus | UI loopback | `hub-observability` y `hub-core` | solo lo necesario para targets accesibles desde core |
| Grafana / Loki / Tempo / OTel / Alertmanager / Blackbox | puertos loopback cuando aplica | `hub-observability` interna | no por defecto |
| Jenkins | UI loopback | `hub-core`; sin Docker socket ni project mounts | si, para SCM/dependencias bajo el perfil CI |
| cAdvisor | UI loopback | `hub-observability` interna | no requerida |

## SECURITY_EXCEPTIONS

### M0-CADVISOR-001

- **Riesgo:** cAdvisor conserva mounts read-only de `/`, `/var/run`, `/sys` y Docker data para inventario.
- **Motivo:** son necesarios para su funcion y no existe aun un collector con interfaz mas estrecha.
- **Alcance:** perfil opcional `infra/observability`, puerto loopback, root filesystem read-only, sin capabilities y `no-new-privileges`.
- **Mitigacion temporal:** no activar el perfil en hosts no confiables; preferir metricas del runtime.
- **Eliminacion:** milestone de observabilidad/runner aislado posterior a M1.

### M0-LOCAL-EXEC-001

- **Riesgo:** el modo nativo opt-in ejecuta codigo `TRUSTED_LOCAL` con permisos del usuario host y puede controlar Docker.
- **Motivo:** preserva el Local Run Engine sin devolver Docker socket a la API containerizada.
- **Alcance:** loopback, auth obligatoria, trust explicito, allowlists, timeout/output limit y auditoria.
- **Mitigacion temporal:** mantener deshabilitado salvo uso interactivo y revisar el repositorio antes de cambiar trust.
- **Eliminacion:** futuro execution/target agent tipado.

### M0-LOKI-001

- **Riesgo:** Loki mantiene `auth_enabled: false`.
- **Motivo:** el despliegue actual es single-tenant local y no incorpora proxy de autenticacion en M0.
- **Alcance:** red interna y puerto host loopback.
- **Mitigacion temporal:** no exponer `HUB_BIND_ADDRESS` al LAN.
- **Eliminacion:** hardening de observabilidad posterior.

## Auditoria

Cada request mutante registra actor, action, resource, timestamp, correlation ID, rol requerido, resultado y status. Los eventos de dominio mantienen su evidencia adicional sanitizada.

Limitacion conocida: el audit permanece en el JSON mutable del MVP. Integridad append-only, firma y almacenamiento separado pertenecen a M1+.
