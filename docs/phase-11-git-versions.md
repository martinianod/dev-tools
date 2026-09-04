# Fase 11 - Gestion de Git y versiones

Fase 11 agrega el contrato `git-version-management.v1` para comparar repositorio local, remoto Git y runtime desplegado. El objetivo es saber que commit/rama se esta probando, si el deploy local quedo obsoleto y que accion cerrada corresponde ejecutar.

## API

- `GET /api/v1/versions/overview`: resumen de plataforma con repositorios Git, worktrees dirty, diferencias contra remoto y deploys obsoletos.
- `GET /api/v1/projects/{idOrSlug}/versions/overview`: snapshot por proyecto con repo, rama, commit, tag, remote, ultimo pull, ultimo build, commit desplegado, rama de origen, fingerprint y diferencias.
- `GET /api/v1/projects/{idOrSlug}/runtime/changes`: vista read-only de cambios detectados.
- `POST /api/v1/projects/{idOrSlug}/runtime/{action}`: acciones cerradas `start`, `restart`, `rebuild-changed`, `clean-rebuild`, `pull-rebuild` y `stop`.
- `POST /api/v1/projects/{idOrSlug}/runtime/volumes/delete`: borrado de volumenes solo con `acknowledgedDataLoss=true` y `confirmation="DELETE VOLUMES <project-slug>"`.

## Acciones

- `Start`: calcula Git/fingerprint e inicia; reconstruye si no hay deploy previo o si cambio la huella.
- `Restart`: detiene e inicia con la version actual, reconstruyendo solo si corresponde.
- `Rebuild changed components`: reconstruye cuando el fingerprint actual difiere del ultimo deploy registrado.
- `Clean rebuild`: fuerza build y recreacion de contenedores, preservando volumenes por defecto.
- `Pull and rebuild`: exige worktree limpio, upstream configurado y `git pull --ff-only`; luego fuerza build para evitar imagenes obsoletas.
- `Stop`: detiene el runtime preservando volumenes.
- `View detected changes`: refresca diferencias sin efectos laterales.

## Evidencia

Cada overview incluye:

- `repository`: si es Git, branch, commit, tag, remote, clean/dirty, ultimo pull y proveedor remoto.
- `current`: version local actual y fingerprint de fuente.
- `deployed`: commit, rama, tag, remote, estrategia, fingerprint y fecha de ultimo build registrado.
- `differences.localVsRemote`: ahead/behind, dirty y archivos cambiados.
- `differences.localVsEnvironment`: mismatch de commit, branch y fingerprint contra runtime.
- `runtime.volumePolicy`: preservacion por defecto y token de confirmacion para borrar volumenes.

## Guardrails

- No hay comandos arbitrarios desde UI o API.
- `pull-rebuild` se bloquea con worktree dirty, operacion Git en curso o upstream faltante.
- `clean-rebuild` no borra volumenes.
- Borrar volumenes requiere confirmacion explicita y no se ejecuta en smoke/tests.
- Los remotes se sanitizan para no exponer credenciales embebidas.
