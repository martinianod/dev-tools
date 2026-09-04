# SonarQube local global

Esta carpeta contiene una instalacion local, global y reutilizable de SonarQube Community para varios proyectos. Vive fuera de los repositorios de aplicacion para no mezclar infraestructura compartida con codigo de negocio.

Ruta implementada en esta maquina:

```bash
/Users/martiniano/Documents/dev-tools/sonarqube
```

La ruta literal `/Users/martiniano/dev-tools` no existe actualmente. Si mas adelante queres usar exactamente `~/dev-tools/sonarqube`, move esta carpeta o crea un alias/symlink de forma explicita.

## Levantar

```bash
cd /Users/martiniano/Documents/dev-tools/sonarqube
./scripts/up.sh
```

El primer `up` crea `.env` desde `.env.example`. Revisalo si necesitas cambiar puerto o credenciales locales de PostgreSQL.

## Entrar

URL local:

```text
http://localhost:9000
```

Credenciales iniciales:

```text
admin/admin
```

SonarQube obliga o recomienda cambiar la contrasena en el primer ingreso.

## Crear proyectos

Crear cada proyecto manualmente en la UI de SonarQube con una `projectKey` estable:

| Proyecto | Project key local |
| --- | --- |
| chedoparti-react-app | `chedoparti-react-app` |
| maria-belen-labarque-ceramic | `maria-belen-labarque-ceramic` |
| sistema_dietetica | `sistema-dietetica` |
| giftfinder-proyect | `giftfinder-proyect` |
| panorama-mercados | `panorama-mercados` |

`giftfinder-proyect` conserva la grafia real del repo para no romper convenciones existentes. Si algun dia se renombra el repo a `giftfinder-project`, se puede crear una key nueva o migrar el historial.

## Crear token

En SonarQube:

```text
My Account -> Security -> Generate Tokens
```

Exportar el token solo en la terminal local:

```bash
export SONAR_HOST_URL=http://localhost:9000
export SONAR_TOKEN=<token-generado-en-sonarqube-local>
```

No guardes tokens en Git, `.env`, logs ni documentacion.

Un intento fallido de analisis no consume ni invalida el token. Si parece que necesitas crear uno nuevo en cada corrida, revisa expiracion, permisos del usuario, project key y que el scanner dentro de Docker use `host.docker.internal` para llegar al SonarQube del host. Si el token fue expuesto en logs/chats, revocalo por seguridad.

## Analizar

Cada proyecto tiene su propio script:

```bash
cd /path/to/project
export SONAR_HOST_URL=http://localhost:9000
export SONAR_TOKEN=<token>
./scripts/quality/sonar-scan-local.sh
```

Si el proyecto contiene Java, genera bytecode antes del scan. El script local avisa si faltan directorios de clases compiladas.

## Apagar

```bash
cd /Users/martiniano/Documents/dev-tools/sonarqube
./scripts/down.sh
```

Esto no borra volumenes. Usuarios, proyectos, tokens, historico de analisis y quality gates quedan persistidos.

## Reset completo

```bash
cd /Users/martiniano/Documents/dev-tools/sonarqube
./scripts/reset.sh
```

`reset.sh` pide escribir `RESET-SONARQUBE` y luego ejecuta `docker compose down -v`. Esto borra los volumenes y elimina usuarios, proyectos, tokens, historico, quality gates y configuracion interna.

## Espacio en disco

```bash
./scripts/disk-usage.sh
```

Docker Desktop en macOS guarda gran parte del espacio dentro de su VM interna, por eso `du -sh` de esta carpeta no representa todo el uso real.

Esta configuracion usa volumenes explicitos `local_sonarqube_data`, `local_sonarqube_db_data`, `local_sonarqube_extensions` y `local_sonarqube_logs`. En esta maquina tambien existen volumenes legacy `sonarqube_sonarqube_*`; se dejan sin montar para evitar borrar o migrar datos anteriores de forma implicita.

## Backups

Crear backup:

```bash
./scripts/backup-db.sh
```

Restaurar backup:

```bash
./scripts/restore-db.sh backups/sonarqube-YYYYMMDD-HHMMSS.dump
```

El restore detiene temporalmente el contenedor SonarQube y mantiene PostgreSQL activo para restaurar.

## Buenas practicas

- No levantar SonarQube por defecto con cada proyecto.
- Levantarlo solo cuando se quiera revisar calidad o despues de cambios grandes.
- No mezclar la base de datos de SonarQube con bases de datos de aplicaciones.
- No commitear `.env` con credenciales reales.
- Hacer backups si esta instancia pasa a ser persistente.
- Para VPS/Coolify, usar HTTPS, dominio propio, PostgreSQL dedicado, volumenes persistentes y backups.
- No usar `docker system prune -a --volumes` como limpieza normal; puede borrar datos de otros proyectos.

## GitHub Actions

GitHub Actions no puede acceder a `http://localhost:9000` de esta Mac. El flujo local queda manual. Para CI con SonarQube self-hosted se necesita:

- URL publica HTTPS, por ejemplo `https://sonar.midominio.com`; o
- self-hosted runner dentro de la misma red que SonarQube.

Con SonarQube Community el uso recomendado es analisis local y, en una VPS futura, analisis de `main`/`develop`. Los PRs deberian seguir protegidos por lint, typecheck, tests, audit, Trivy, Semgrep y herramientas equivalentes.

Mas detalles:

- `docs/analyze-projects.md`
- `docs/project-audit.md`
- `docs/vps-coolify.md`
