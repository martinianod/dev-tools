# Onboarding de proyectos

## Proyectos iniciales

| Slug | Carpeta relativa | Sonar key |
| --- | --- | --- |
| `chedoparti-react-app` | `chedoparti-react-app` | `chedoparti-react-app` |
| `maria-belen-labarque-ceramic` | `maria-belen-labarque-ceramic` | `maria-belen-labarque-ceramic` |
| `sistema-dietetica` | `sistema_dietetica` | `sistema-dietetica` |
| `giftfinder-proyect` | `giftfinder-proyect` | `giftfinder-proyect` |
| `panorama-mercados` | `panorama-mercados` | `panorama-mercados` |

`maria-belen-labarque-ceramic` corresponde a DiTerra/ecommerce y talleres de ceramica. No debe mezclar conceptos de Chedoparti.

## Flujo seguro

1. El usuario configura `PROJECTS_ROOT`.
2. El usuario registra una carpeta relativa.
3. La API resuelve `realpath`.
4. Se rechaza path traversal, rutas absolutas y symlinks que escapen del root.
5. Discovery detecta stack y comandos aprobados.
6. Configuration Doctor muestra brechas.
7. El usuario decide ejecutar una accion.

## Discovery

Detecta:

- Git.
- Node y scripts relevantes `test`, `lint`, `build` y un coverage preferido por package.
- Next.js y Vite.
- Maven.
- Gradle.
- Python.
- Flutter.
- Docker.
- SonarQube local.

## Configuration Doctor

Reporta:

- Path permitido.
- Git branch/commit.
- Stack detectado.
- Tests.
- Coverage.
- SonarQube config.
- Runtime Docker.
- Estado de observabilidad.

## Correcciones automaticas

El hub no permite comandos arbitrarios desde el navegador. Para esta pasada se aplicaron archivos Sonar externos de forma explicita y los originales staged quedan en `external-overrides/`.

Estado actual:

- `chedoparti-react-app`: script Sonar estabilizado con `SONAR_SCAN_SCOPE`.
- `maria-belen-labarque-ceramic`: configuracion existente detectada.
- `sistema_dietetica`: configuracion Sonar local agregada.
- `giftfinder-proyect`: configuracion existente detectada.
- `panorama-mercados`: configuracion Sonar local agregada; coverage pendiente porque no existe script/reporte.

Ver detalles operativos en `docs/sonarqube-local-runbook.md`.
