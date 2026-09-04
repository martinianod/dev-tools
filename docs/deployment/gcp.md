# GCP

## Estado Fase 4

El hub detecta GCP en modo read-only desde:

- Terraform con recursos `google_*`.
- `cloudbuild.yaml`.
- `app.yaml`.
- `firebase.json`.

No se ejecuta `gcloud` ni se consulta Cloud Asset Inventory. La API solo indica si hay contexto por entorno (`GOOGLE_APPLICATION_CREDENTIALS`, `GCLOUD_PROJECT` o `GOOGLE_CLOUD_PROJECT`), sin exponer valores.

## Drift reportado

- Manifests GCP presentes sin proveedor declarado.
- Roles amplios como `roles/owner`.
- Discovery live no configurado.

## Requisito para evolucion live

- service account read-only por proyecto;
- project allowlist;
- scopes minimos;
- cache de assets;
- separacion estricta entre discovery y deploy.
