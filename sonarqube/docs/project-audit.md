# Auditoria inicial

Fecha local: 2026-07-08.

## Entorno

- Usuario: `martiniano`
- Sistema: macOS Darwin 24.6.0 arm64
- Docker: `Docker version 27.4.1`
- Docker Compose: `v5.1.4`
- Puerto 9000: sin proceso escuchando durante la auditoria (`lsof -i :9000` sin salida)
- Contenedores Sonar: ninguno (`docker ps -a --filter name=sonar` sin resultados)
- Volumenes Sonar legacy detectados: `sonarqube_sonarqube_data`, `sonarqube_sonarqube_db_data`, `sonarqube_sonarqube_extensions`, `sonarqube_sonarqube_logs`
- La instalacion nueva usa volumenes `local_sonarqube_data`, `local_sonarqube_db_data`, `local_sonarqube_extensions`, `local_sonarqube_logs` para no forzar una migracion destructiva de los datos legacy.
- Al montar los volumenes legacy, SonarQube arranco pero reporto `DB_MIGRATION_NEEDED`. Se eligio aislar una instalacion limpia y dejar esos datos anteriores sin borrar ni migrar implicitamente.
- `docker system df`: 70 imagenes, 54 contenedores, 107 volumenes locales, 255 entradas de build cache

La primera llamada a `docker system df` fue bloqueada por permisos del socket dentro del sandbox y se repitio con escalacion aprobada.

## Rutas encontradas

Configuradas:

- `/Users/martiniano/Documents/chedoparti-react-app`
- `/Users/martiniano/Documents/maria-belen-labarque-ceramic`
- `/Users/martiniano/Documents/portfolio_fullstack`
- `/Users/martiniano/Documents/giftfinder-proyect`

Descartadas para no tocar copias temporales o duplicadas:

- `/Users/martiniano/.codex/worktrees/*/chedoparti-react-app`
- `/Users/martiniano/Documents/chedoparti/.backup-20260112-154752/chedoparti-react-app`
- `/Users/martiniano/Documents/chedoparti/frontend/chedoparti-react-app`
- `/Users/martiniano/Documents/forks/maria-belen-labarque-ceramic`
- `/Users/martiniano/Downloads/chedoparti-react-app`

## Estado Git

- `chedoparti-react-app`: limpio antes de esta tarea.
- `maria-belen-labarque-ceramic`: tenia `backend/src/extensions/documentation/public/index.html` modificado.
- `portfolio_fullstack`: tenia varios cambios previos y carpetas nuevas como `ai-orchestrator/`, `control-tower-web/`, `infra/` y `nginx/`.
- `giftfinder-proyect`: tenia muchos cambios previos en backend, frontend, scraper y microservicios.

No se revirtio ningun cambio existente.

## SonarCloud y workflows

`chedoparti-react-app` tenia:

- `.github/workflows/sonar.yml`
- `sonar-project.properties` apuntando a `https://sonarcloud.io`
- `SONAR_TOKEN` en el workflow
- `sonar.organization=martinianod`
- `sonar.projectKey=martinianod_chedoparti-react-app`

Estrategia aplicada:

- preservar el workflow SonarCloud;
- mover la configuracion Cloud a `sonar-project.cloud.properties`;
- dejar `sonar-project.properties` como configuracion local/self-hosted;
- hacer que el workflow Cloud use `-Dproject.settings=sonar-project.cloud.properties`.

Los otros tres proyectos no tenian referencias a SonarCloud/SonarQube en `.github/workflows` durante la auditoria.

## LOC medido con cloc

| Proyecto | Scope global auditado | Scope Sonar local |
| --- | ---: | ---: |
| chedoparti-react-app | 486895 code LOC | 111015 code LOC |
| maria-belen-labarque-ceramic | 164570 code LOC | 105516 code LOC |
| portfolio_fullstack | 19396 code LOC | 12748 code LOC |
| giftfinder-proyect | 157572 code LOC | 18999 code LOC |

Los scopes globales excluyeron dependencias, builds, coverage, caches y artefactos generados comunes. El scope Sonar local usa las rutas productivas definidas en cada `sonar-project.properties`.
