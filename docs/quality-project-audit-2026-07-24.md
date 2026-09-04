# Quality project audit 2026-07-24

## Resumen

El discovery final del hub detecta los cinco proyectos y todos tienen template Sonar. Las brechas que quedan son reales y no deben falsearse:

- `panorama-mercados` no es un repo Git desde `/Users/martiniano/Documents/panorama-mercados`.
- `panorama-mercados` no tiene coverage configurado.
- Observabilidad por proyecto sigue en `Sin datos` hasta que cada app corra instrumentada y emita metricas/logs/trazas con labels.

## Estado por proyecto

| Proyecto | Stack | Sonar | Coverage | Warnings |
| --- | --- | --- | --- | --- |
| `chedoparti-react-app` | Docker, Git, Gradle, Next.js, Node, SonarQube, Vite | Script estabilizado con scopes | JaCoCo + LCOV detectados | ninguno |
| `maria-belen-labarque-ceramic` | Docker, Git, Next.js, Node, SonarQube | Existente | LCOV frontend/backend detectado | ninguno |
| `sistema-dietetica` | Docker, Git, Maven, Node, SonarQube, Vite | Agregado | JaCoCo detectado; LCOV web soportado | ninguno |
| `giftfinder-proyect` | Docker, Git, Gradle, Node, Python, SonarQube, Vite | Existente | JaCoCo detectado | ninguno |
| `panorama-mercados` | Docker, Next.js, Node, SonarQube | Agregado | Pendiente | `GIT`, `COVERAGE` |

## Archivos externos aplicados

`/Users/martiniano/Documents/chedoparti-react-app`:

- `scripts/quality/sonar-scan-local.sh`
- `sonar-project.properties`

`/Users/martiniano/Documents/sistema_dietetica`:

- `scripts/quality/sonar-scan-local.sh`
- `sonar-project.properties`

`/Users/martiniano/Documents/panorama-mercados`:

- `scripts/quality/sonar-scan-local.sh`
- `sonar-project.properties`

Los archivos staged quedan tambien en `external-overrides/` dentro de este hub como referencia auditable.

## Evidencia local

- `npm run check`: OK.
- `docker compose config`: OK.
- `docker compose build control-api`: OK.
- Toolchain dentro de la imagen `control-api`: bash, Git, OpenJDK 21, Maven 3.9.9, Python 3.12.13 y SonarScanner CLI 8.0.1.
- Discovery final: 5/5 proyectos activos; 5/5 con template Sonar.
- Scripts Sonar nuevos: `bash -n` OK y validacion temprana de token invalido sin exponer el token.

## Cambios de Chedoparti para el error reportado

- Se dejo de pasar el token como argumento `-Dsonar.token=...`.
- Se usa `SONAR_TOKEN` por entorno.
- Se agrega validacion temprana del token contra SonarQube.
- Se agrega `SONAR_SCAN_SCOPE=stable|backend|frontend|full`.
- El default `stable` reduce el scope TS/JS para evitar el fallo visto al resolver un `tsconfig.sonar.json` monolitico.
- Se agregan Java libraries desde `build/sonar/runtime-classpath.txt` cuando se ejecuta scanner nativo.
- Se agrega cache local `.sonar`.

## Pendientes deliberados

- No se creo coverage para `panorama-mercados` porque el repo no tiene `test:coverage` ni dependencia de coverage declarada.
- No se instrumento telemetria en cada app externa en esta pasada; el hub ya muestra `Sin datos` honestamente.
- No se ejecuto un scan real con token valido porque el token pegado en el chat debe revocarse y no debe reutilizarse.
