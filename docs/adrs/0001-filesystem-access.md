# ADR 0001: Acceso a filesystem por workspace permitido

## Estado

Aceptado.

## Contexto

El hub debe asociar carpetas locales de proyectos sin exponer el filesystem del host al navegador ni montar rutas amplias.

## Decision

Usar `PROJECTS_ROOT` como raiz permitida. La API guarda `repositoryPath` relativo, resuelve `realpath` y rechaza rutas absolutas, traversal y symlinks que escapen del root.

## Consecuencias

- El usuario debe ubicar proyectos bajo una raiz comun.
- El worker puede ejecutar templates aprobados dentro de esas carpetas.
- No hay acceso arbitrario desde frontend.
