# ADR 0004: Descriptor YAML de catalogo local

## Estado

Aceptado.

## Contexto

La plataforma necesita separar estado declarado, detectado y verificado. Antes de esta decision, el catalogo vivia principalmente en `data/state.json`, que es estado mutable local y no una declaracion versionable.

## Decision

Agregar `config/project-catalog.yaml` como descriptor declarado central para proyectos, componentes y ambientes locales. La API lo lee en runtime y lo expone por `GET /api/v1/catalog/descriptor`.

El parser YAML es un subconjunto interno y acotado para evitar dependencias npm nuevas en el runtime actual.

## Consecuencias

- El estado declarado queda versionado y revisable.
- `data/state.json` sigue siendo store operativo local, no contrato declarado.
- La UI y la API pueden mostrar diferencias entre declarado, detectado y verificado.
- YAML avanzado fuera del subconjunto soportado debe incorporarse con una dependencia o parser dedicado en una fase posterior.
