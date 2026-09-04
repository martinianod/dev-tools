# Fase 3 - Calidad y seguridad

## Alcance implementado

La Fase 3 agrega un overview verificable de calidad y seguridad por proyecto y a nivel plataforma.

Endpoints:

```text
GET /api/v1/quality-security/overview
GET /api/v1/projects/{idOrSlug}/quality-security/overview
```

Scanners incluidos:

- Tests: templates aprobados, coverage artifacts y ultimo job local de tests/coverage/full.
- SonarQube: disponibilidad de API, `sonarProjectKey`, comando aprobado, snapshot importado y Quality Gate.
- Dependencias: manifests y lockfiles Node, Maven, Gradle, Python y Dart/Flutter.
- Secret scanning: archivos de texto con patrones locales y valores siempre redaccionados.
- Container scanning: Dockerfiles y Compose con checks de tags flotantes, root, healthcheck, docker socket, privileged, namespaces host, secrets inline y puertos expuestos.

## Contrato de estado

Estados normalizados:

- `CONFIGURED_AND_VERIFIED`: configuracion presente y scanner ejecutado sin warnings/criticos.
- `PARTIALLY_CONFIGURED`: scanner ejecutado, pero hay warnings o evidencia incompleta.
- `CONFIGURED_NOT_VERIFIED`: configuracion detectada pero sin evidencia ejecutada.
- `NOT_CONFIGURED`: no hay artefactos o configuracion soportada.
- `ERROR`: hay finding critico o fallo de evaluacion.

Los findings incluyen `severity`, `category`, `scanner`, `code`, `title`, `detail`, `evidence`, `path` relativo y `line` cuando aplica.

## Seguridad de secretos

El secret scanner no devuelve valores reales. La evidencia usa:

```text
[REDACTED:<fingerprint>]
[PLACEHOLDER]
```

El fingerprint permite agrupar repeticiones sin exponer el secreto. Si aparece un token real, la accion correcta es rotarlo aunque el hub lo muestre redaccionado.

## Limitaciones honestas

- No reemplaza `npm audit`, Trivy, gitleaks, Semgrep ni OWASP ZAP.
- No descarga bases de vulnerabilidades.
- No ejecuta installs ni scanners externos.
- La validacion de SonarQube depende de que la instancia este levantada y el token tenga permisos.
- Container scanning es estatico; no inspecciona CVEs de imagen ni capas construidas.

## Verificacion

Comandos ejecutables:

```bash
npm run check
./scripts/smoke.sh
npm test
```

Smoke valida ambos endpoints nuevos y el test de API valida que:

- existan las cinco senales de Fase 3;
- el overview global incluya proyectos;
- haya manifests de dependencias;
- el secret scanner reporte conteos numericos;
- no se filtren tokens Sonar/GitHub sin redaccion.
