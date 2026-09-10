# Gestion de secretos

## Regla base

Los secretos no van en `config/project-catalog.yaml`, `compose.yaml`, scripts versionables, docs ni codigo fuente.

Permitido:

- Variables de entorno locales.
- Secret manager externo que inyecte variables al proceso.
- `.env` local no versionado.

No permitido:

- Tokens `sqp_*` en archivos.
- GitHub PATs en scripts.
- Claves privadas.
- Passwords o API keys inline en Compose.
- Secretos enviados por la UI o guardados en runtime config.

`SONAR_TOKEN`, `HUB_AUTH_TOKEN`, credenciales de Grafana/Jenkins y passwords de bases se resuelven solo desde environment. El backend rechaza `sonarToken` y claves/valores sensibles en `additionalEnv`; los valores no publicos se representan como `[CONFIGURED]`.

## Redaccion

El backend sanitiza logs y findings antes de devolverlos al navegador.

Patrones cubiertos:

- Sonar `sqp_*`
- `Authorization: Bearer`
- `password=`, `token=`, `secret=`
- variables sensibles conocidas
- fingerprints de secret scanning en vez de valores reales

## Rotacion

Si un secreto aparece en una terminal, chat, screenshot, log o archivo versionable:

1. Revocarlo en el proveedor.
2. Crear uno nuevo.
3. Cargarlo por environment o secret manager externo.
4. Reejecutar `GET /api/v1/projects/{idOrSlug}/quality-security/overview`.
