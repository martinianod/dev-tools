# Testing de seguridad

## Validaciones actuales

La Fase 3 cubre checks locales read-only:

- Secret scanning con redaccion.
- Dependency manifest scanning.
- Dockerfile/Compose scanning.
- Verificacion de SonarQube cuando esta disponible.
- Findings normalizados en API y UI.

La Fase 5 agrega DAST pasivo:

- Solo `GET` contra targets HTTP locales detectados.
- Sin crawling.
- Sin fuzzing.
- Sin autenticacion.
- Sin writes.
- Headers evaluados: CSP, `X-Content-Type-Options`, anti-clickjacking, referrer policy, HSTS cuando aplica y exposicion de `Server`.

## Comandos

```bash
npm run check
./scripts/smoke.sh
npm test
```

El smoke levanta una API temporal y consulta:

```text
/api/v1/quality-security/overview
/api/v1/projects/chedoparti-react-app/quality-security/overview
/api/v1/testing/overview
/api/v1/projects/chedoparti-react-app/testing/overview
```

## Pendiente

- gitleaks o equivalente para reglas mantenidas.
- npm/pnpm/yarn audit con lockfiles reales.
- Trivy/Grype para imagenes.
- Semgrep u otro SAST configurable.
- DAST activo con OWASP ZAP cuando existan aprobaciones, ventanas y targets seguros.
- Politicas de excepciones con expiracion y aprobador.
