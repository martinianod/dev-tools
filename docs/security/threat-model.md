# Threat model local

## Activos protegidos

- Repositorios dentro de `PROJECTS_ROOT`.
- Tokens de SonarQube cargados por entorno o UI.
- Docker socket local.
- Logs de jobs y runtime.
- Findings de seguridad con evidencia potencialmente sensible.

## Supuestos

- El hub corre en una maquina de desarrollo controlada.
- La API no debe exponerse fuera de `localhost` sin autenticacion/RBAC.
- Los proyectos registrados pueden contener codigo no confiable.
- Docker Desktop y el socket Docker tienen privilegios altos sobre la maquina.

## Amenazas principales

- Path traversal o symlink escape para leer fuera de `PROJECTS_ROOT`.
- Comandos arbitrarios enviados desde la UI.
- Filtracion de tokens en logs, responses o findings.
- Jenkins/runner con Docker socket ejecutando pipeline malicioso.
- Compose de proyecto con `privileged`, `docker.sock`, mounts de host o secrets inline.
- Dependencias no reproducibles o remotas sin pinning.

## Controles implementados

- `repositoryPath` relativo y validado con `realpath`.
- Acciones permitidas por allowlist.
- `spawn` con `shell:false`.
- Logs y metadata sanitizados.
- Secret scanning con evidencia redaccionada.
- Container scanning estatico para Dockerfile/Compose.
- Findings priorizados para riesgos de calidad, dependencias, secretos y contenedores.

## Riesgos aceptados

- Sin autenticacion/RBAC real en el MVP.
- Docker socket montado para Local Run Engine.
- Scanners externos de CVE/DAST/SAST aun no integrados.
- Persistencia JSON local sin cifrado.
