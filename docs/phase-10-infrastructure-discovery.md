# Fase 10 - Descubrimiento de infraestructura

Fase 10 completa el contrato de adaptadores de infraestructura. La plataforma mantiene discovery read-only, cache con `sourceHash` y auditoria, pero ahora cada adaptador declara una interfaz comun con activacion, validacion, conectividad, evidencia, errores y politica de secretos.

## Adaptadores soportados

- `local`
- `docker`
- `docker-compose`
- `terraform`
- `opentofu`
- `aws`
- `cloudformation`
- `gcp`
- `azure` como extension futura
- `vps`
- `kubernetes`
- `github`
- `gitlab`
- `harness`
- `jenkins`
- `sonarqube`
- `grafana`
- `prometheus`
- `loki`
- `tempo`
- `opentelemetry`
- `registry`
- `object-storage`
- `smtp`

## Interfaz comun

Cada adaptador expone:

- `interfaceVersion`: `infrastructure-adapter.v1`.
- `capabilities`.
- `timeoutMs`.
- `rateLimit`.
- `activation`: estado y variables `INFRA_ADAPTERS_ENABLED` / `INFRA_ADAPTERS_DISABLED`.
- `validation`: fuentes de configuracion, recursos, manifests, findings y estado de credenciales.
- `connectivity`: modo, si se intento o se omitio por politica, timeout y evidencia.
- `secretPolicy`: valores no retornados, no logueados y solo referencias por nombre/presencia.
- `evidence`: manifests, recursos y pruebas de conectividad sanitizadas.
- `errors`: hallazgos accionables con severidad, codigo, titulo, detalle y evidencia.

## Discovery implementado

El scanner detecta, sin mutaciones:

- Dockerfiles e imagenes base.
- Docker Compose, servicios y puertos publicados.
- Terraform/OpenTofu, backend y recursos.
- CloudFormation, SAM y Serverless.
- Kubernetes, Helm y Kustomize.
- Azure Bicep, ARM y pipelines como extension futura.
- VPS por systemd, nginx, Caddy, Ansible y scripts de deploy.
- GitHub/GitLab desde remote Git.
- Harness desde manifests de pipeline.
- Servicios locales del hub para Jenkins, SonarQube, Grafana, Prometheus, Loki y Tempo.
- OpenTelemetry por Collector config o SDKs detectados.
- Registries desde referencias de imagen.
- Object storage por S3, GCS, Azure Storage, MinIO o configuraciones de bucket.
- SMTP por configuracion declarada.

## Guardrails

- No ejecuta `aws`, `gcloud`, `az`, `kubectl`, `terraform`, `tofu`, `harness` ni SSH.
- Cloud live discovery permanece deshabilitado hasta credenciales temporales/OIDC/RBAC.
- Credenciales permanentes se desalientan; se prefieren OIDC, Workload Identity, roles temporales y service accounts con permisos minimos.
- Los valores sensibles nunca se retornan en API, UI, logs ni snapshots.
- `POST /api/v1/projects/{idOrSlug}/infrastructure/refresh` recalcula cache local y audita `infrastructure.discovery.refresh`.
