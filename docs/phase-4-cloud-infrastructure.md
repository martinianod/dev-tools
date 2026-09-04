# Fase 4 - Cloud e infraestructura

## Alcance implementado

La Fase 4 agrega discovery read-only de infraestructura, adaptadores normalizados y drift estatico.

Endpoints:

```text
GET /api/v1/infrastructure/overview
GET /api/v1/projects/{idOrSlug}/infrastructure/overview
```

Adaptadores incluidos:

- `local`: Dockerfile, Docker Compose y runtime local Docker.
- `aws`: Terraform AWS, CloudFormation/SAM y Serverless.
- `gcp`: Terraform Google, Cloud Build, App Engine y Firebase.
- `vps`: nginx, Caddy, systemd, Ansible/Coolify/deploy scripts.
- `kubernetes`: manifests Kubernetes, Helm y Kustomize.

## Contrato

Cada overview devuelve:

- `adapters`: estado por adaptador, modo, credential state y conteos.
- `resources`: recursos declarados/detectados con provider, source, type, name, path y line.
- `drift`: findings entre descriptor, manifests y runtime local.
- `counts`: recursos, findings y distribucion por provider.

Estados:

- `CONFIGURED_AND_VERIFIED`: adapter configurado y verificado localmente.
- `PARTIALLY_CONFIGURED`: manifests detectados con warnings o sin live verification.
- `CONFIGURED_NOT_VERIFIED`: configuracion detectada sin verificacion runtime/live.
- `NOT_CONFIGURED`: no hay manifests ni credenciales/contexto.
- `ERROR`: hay finding critico.

## Drift cubierto

- Proveedor detectado en manifests pero no declarado en `config/project-catalog.yaml`.
- Proveedor declarado sin manifests detectados.
- Runtime local obsoleto cuando hay Compose y freshness stale.
- Compose con servicios no modelados como componentes.
- AWS/GCP/Kubernetes detectados sin credenciales/contexto live.
- Riesgos puntuales: S3 sin cifrado declarado, ingress publico, Kubernetes privilegiado/hostNetwork, LoadBalancer, scripts VPS riesgosos, IAM wildcard.

## Limitaciones

- No ejecuta `aws`, `gcloud`, `kubectl` ni `terraform`.
- No consulta inventario real de cloud.
- No aplica cambios ni destruye recursos.
- No reemplaza drift real de Terraform plan, AWS Config, GCP Asset Inventory o Kubernetes API.

La fase deja el contrato preparado para enchufar live discovery en fases posteriores con credenciales controladas.

## Verificacion

```bash
npm run check
./scripts/smoke.sh
HUB_TEST_BASE_URL=http://127.0.0.1:18080 npm test
```

El smoke valida ambos endpoints y el test exige los cinco adaptadores normalizados.
