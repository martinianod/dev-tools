# VPS

## Estado Fase 4

El hub detecta VPS/servidores propios desde:

- `nginx.conf`.
- `Caddyfile`.
- unidades `*.service`.
- carpetas `deploy`, `ops`, `ansible`, `coolify`, `systemd`.

El discovery es estatico. No se abre SSH ni se ejecutan scripts remotos.

## Drift reportado

- Manifests VPS presentes sin proveedor declarado.
- Scripts con `sshpass`, `StrictHostKeyChecking=no` o `curl | sh`.

## Requisito para evolucion live

- inventario host allowlist;
- usuario read-only para checks;
- comandos permitidos por host;
- timeouts cortos;
- evidencia sanitizada.
