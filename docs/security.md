# Seguridad

## Filesystem

La API solo acepta `repositoryPath` relativo a `PROJECTS_ROOT`.

Controles:

- Rechazo de rutas absolutas.
- `realpath` del root y del destino.
- Rechazo de traversal.
- Rechazo de symlinks que escapan del root.
- Rutas absolutas sanitizadas en logs.

No se monta `/`, `$HOME` ni disco completo.

## Ejecucion

El frontend no puede enviar comandos arbitrarios. Cada accion usa templates detectados:

- npm scripts conocidos.
- Maven.
- Gradle.
- Python pytest.
- Flutter test.
- Sonar scanner/script local.

Los procesos se ejecutan con `spawn` y `shell: false`.

## Secretos

`SONAR_TOKEN` puede vivir en variable de entorno del backend o en la configuracion runtime del proyecto. Si se carga desde la UI, queda persistido en la data local del hub (`HUB_DATA_DIR`/volumen Docker), no en Git. El API no lo devuelve al frontend; solo informa si esta configurado.

`config/project-catalog.yaml` es una fuente declarada versionable. No debe contener tokens, passwords, connection strings, claves privadas ni variables `.env`; solamente metadata operativa no secreta como owner, team, criticality, rutas relativas, componentes y ambientes.

Los scripts locales usan `SONAR_TOKEN` por entorno y no agregan `-Dsonar.token=...` a los argumentos del scanner. Esto reduce exposicion en logs de procesos y errores. Si un token fue pegado en chats, capturas o logs, hay que revocarlo aunque SonarQube no lo invalide automaticamente.

Sanitizacion de logs:

- `sqp_*`
- Authorization Bearer.
- `password=`, `token=`, `secret=`.
- valores de variables sensibles conocidas.

Fase 3 agrega `GET /api/v1/projects/{idOrSlug}/quality-security/overview` con secret scanning read-only. Los findings no devuelven el valor real: usan `[REDACTED:<fingerprint>]` o `[PLACEHOLDER]`.

## Docker

El perfil `core` levanta solo `control-api` y `web` para reducir consumo diario. `control-api` monta `/var/run/docker.sock` para habilitar Local Run Engine. El perfil `ci` monta el mismo socket en Jenkins para permitir build de imagenes Docker desde pipelines. En Docker Desktop, ambos servicios corren como `root` dentro del contenedor para poder abrir ese socket.

`hub-postgres` y `redis` quedan fuera de `core` y viven en el perfil opcional `stateful`; el backend actual usa persistencia JSON en `HUB_DATA_DIR`.

Este montaje permite que la API ejecute Docker en la maquina local. Por eso el hub debe tratarse como herramienta local de desarrollo, no como servicio publico.

Controles aplicados:

- La UI no envia comandos Docker arbitrarios.
- Las acciones permitidas son `start`, `stop`, `restart`, `smoke`, `start-fresh`, `restart-fresh`, `rebuild-changed`, `clean-rebuild` y `pull-rebuild`.
- La API ejecuta `docker compose` con `shell: false`.
- El compose file debe existir dentro del `repositoryPath` autorizado por `PROJECTS_ROOT`.
- Antes de `up`, se valida conflicto de puertos contra Docker y contra procesos locales.
- `pull-rebuild` requiere worktree limpio, upstream configurado y `git pull --ff-only`.
- `clean-rebuild` preserva volumenes por defecto; borrar volumenes requiere `acknowledgedDataLoss=true` y confirmacion textual exacta.
- Los contenedores y puertos se listan desde labels Docker y se muestran por proyecto.
- Los logs pasan por sanitizacion antes de persistirse o mostrarse.
- Fase 3 inspecciona Dockerfiles y Compose para detectar `privileged:true`, Docker socket, mounts de `/`, namespaces host, secrets inline, tags flotantes y falta de `USER`/`HEALTHCHECK`.

Riesgo aceptado para MVP local:

- Cualquier proceso con acceso al Docker socket tiene control amplio sobre Docker Desktop.
- Un Jenkinsfile malicioso tambien tendria ese alcance si se ejecuta en el Jenkins local con Docker socket montado.

Mitigaciones recomendadas para evolucion:

- Reemplazar socket directo por Docker socket proxy con allowlist.
- Agregar autenticacion y RBAC antes de exponer la API fuera de `localhost`.
- Separar runners por proyecto si se ejecuta en una maquina compartida.

## Autorizacion

El MVP local no implementa login. La API ya separa acciones costosas y registra audit events. La siguiente fase debe agregar roles:

- `ADMIN`
- `OPERATOR`
- `VIEWER`

## Auditoria

Se registra:

- accion
- target
- resultado
- timestamp
- correlation ID
- metadata sanitizada
