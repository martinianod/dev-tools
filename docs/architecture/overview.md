# Architecture Overview

El Engineering Control Center es un hub local con frontend estatico, Control API Node.js y estado JSON local.

Componentes principales:

- `apps/web`: UI operativa para proyectos, runtime, calidad, observabilidad, pruebas, despliegues y documentacion viva.
- `apps/control-api`: API y worker local sin dependencias npm externas.
- `config/project-catalog.yaml`: estado declarado de proyectos, componentes y ambientes.
- `data/state.json`: estado local verificado, jobs, snapshots, despliegues, auditoria y documentacion viva.
- `compose.yaml`: perfiles `core`, `observability`, `quality`, `ci`, `stateful` e `infra`.

El hub controla proyectos ubicados bajo `PROJECTS_ROOT`; no es un reemplazo de SonarQube, Grafana o Jenkins.

