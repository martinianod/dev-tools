# VPS/Coolify para SonarQube self-hosted

## Arquitectura

```text
Internet
  -> HTTPS reverse proxy / Coolify
  -> SonarQube container
  -> PostgreSQL SonarQube dedicado
  -> persistent volumes
```

## Requisitos

- VPS con RAM suficiente para SonarQube y Elasticsearch embebido.
- Disco persistente.
- PostgreSQL dedicado para SonarQube.
- Backups probados.
- HTTPS.
- Dominio o subdominio, por ejemplo `https://sonar.midominio.com`.

## GitHub Actions

GitHub-hosted runners no pueden llegar a `http://localhost:9000` de tu Mac. Para CI hay dos opciones:

- publicar SonarQube con HTTPS; o
- usar un self-hosted runner dentro de la misma red que SonarQube.

Variables/secrets esperados:

```bash
gh secret set SONAR_TOKEN --repo <owner>/<repo>
gh variable set SONAR_HOST_URL --repo <owner>/<repo> --body "https://sonar.midominio.com"
```

Tambien se puede guardar la URL como secret:

```bash
gh secret set SONAR_HOST_URL --repo <owner>/<repo>
```

`SONAR_TOKEN` debe generarse dentro de SonarQube self-hosted. No es un GitHub PAT y no es un token de SonarCloud.

## SonarQube Community

Community no debe disenar el flujo principal como SonarCloud o Developer Edition para PR analysis completo y multiples branches. Recomendacion:

- local: analisis manual despues de cambios grandes;
- VPS/Coolify: analisis en push a `main` y `develop`;
- PRs: proteger con ESLint, TypeScript, tests, Gradle/JUnit, JaCoCo, audit, Trivy, Semgrep y checks equivalentes.

## Backups

Minimo:

- backup periodico de PostgreSQL;
- backup de volumenes persistentes;
- prueba de restore;
- retencion definida.

Para esta instalacion local, `scripts/backup-db.sh` usa `pg_dump -Fc` y `scripts/restore-db.sh` usa `pg_restore --clean --if-exists`.

## Limpieza segura

Apagar sin borrar:

```bash
cd /Users/martiniano/Documents/dev-tools/sonarqube
./scripts/down.sh
```

Borrar solo SonarQube local:

```bash
cd /Users/martiniano/Documents/dev-tools/sonarqube
./scripts/reset.sh
```

Evitar `docker system prune -a --volumes` como procedimiento normal, porque puede borrar imagenes, caches y volumenes de otros proyectos.
