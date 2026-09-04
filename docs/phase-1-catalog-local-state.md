# Fase 1 - Catalogo y estado local

Fecha: 2026-08-04.

## Alcance implementado

Fase 1 queda limitada al estado local del hub y proyectos registrados bajo `PROJECTS_ROOT`.

Implementado:

- Descriptor YAML central en `config/project-catalog.yaml`.
- Endpoint `GET /api/v1/catalog/descriptor`.
- Modelo por proyecto con estado declarado, detectado y verificado.
- Endpoint `GET /api/v1/projects/{idOrSlug}/local-state`.
- Inventario de componentes declarado desde YAML.
- Inventario de componentes detectado desde manifests.
- Recursos verificados desde runtime local y Docker cuando existen contenedores asociados.
- Gaps accionables para descriptor ausente, proyecto no declarado, componentes no detectados, health URL ausente y runtime obsoleto o no verificado.
- UI con panel "Estado local Fase 1" y "Inventario de componentes".
- Smoke y tests actualizados para validar los endpoints nuevos.

## Descriptor YAML

Ruta por defecto:

```text
config/project-catalog.yaml
```

Override operativo:

```bash
HUB_PROJECT_DESCRIPTOR=/ruta/descriptor.yaml npm start
```

Subconjunto soportado por el parser interno:

- Propiedades escalares de catalogo.
- `projects`.
- Para cada proyecto: propiedades escalares, `components` y `environments`.
- Para cada componente o ambiente: propiedades escalares.

El parser es intencionalmente acotado para no agregar dependencias npm al runtime.

## Estado declarado

Fuente:

- `config/project-catalog.yaml`.
- Fallback a estado local solo para ambientes existentes si el descriptor no declara ambientes.

Campos principales:

- proyecto
- owner
- team
- criticality
- components
- environments

## Estado detectado

Fuente:

- filesystem bajo `PROJECTS_ROOT`
- Git
- manifests
- Dockerfile/Compose
- Jenkinsfile
- `sonar-project.properties`

Componentes detectados:

- `frontend` o `node-package` desde `package.json`.
- `maven-module` desde `pom.xml`.
- `gradle-module` desde `build.gradle` o `build.gradle.kts`.
- `python-package` desde `pyproject.toml` o `requirements.txt`.
- `flutter-app` desde `pubspec.yaml`.
- `container-image` desde `Dockerfile`.
- `compose-runtime` desde Compose.
- `ci-pipeline` desde `Jenkinsfile`.
- `quality-config` desde SonarQube properties.

## Estado verificado

Fuente:

- Git capturado por el hub.
- fingerprint de fuentes.
- ultimo deploy local registrado.
- recursos Docker asociados por labels.
- puertos publicados.
- health checks declarados.

Los health checks no se consideran OK si no hay `healthUrl` declarado y verificado. En ese caso el estado queda como `NOT_CONFIGURED`.

## Estados validos

Para integraciones y subestados se usan:

- `CONFIGURED_AND_VERIFIED`
- `CONFIGURED_NOT_VERIFIED`
- `PARTIALLY_CONFIGURED`
- `NOT_CONFIGURED`
- `UNSUPPORTED`
- `ERROR`

## Pendientes fuera de Fase 1

- Verificacion HTTP activa de health checks por ambiente cuando existan URLs declaradas.
- CRUD del descriptor desde UI.
- Migracion de `data/state.json` a PostgreSQL.
- RBAC y autenticacion.
- Cloud discovery.
- Observabilidad profunda por proyecto.
- Seguridad/dependency/container scanning.

## Comandos de verificacion

```bash
npm run check
npm test
./scripts/smoke.sh
./scripts/doctor.sh
```
