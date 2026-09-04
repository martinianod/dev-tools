# Gestion de secretos

## Regla base

Los secretos no van en `config/project-catalog.yaml`, `compose.yaml`, scripts versionables, docs ni codigo fuente.

Permitido:

- Variables de entorno locales.
- Configuracion runtime del proyecto desde la UI para `SONAR_TOKEN`.
- `.env` local no versionado.

No permitido:

- Tokens `sqp_*` en archivos.
- GitHub PATs en scripts.
- Claves privadas.
- Passwords o API keys inline en Compose.

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
3. Cargarlo por entorno/UI local.
4. Reejecutar `GET /api/v1/projects/{idOrSlug}/quality-security/overview`.
