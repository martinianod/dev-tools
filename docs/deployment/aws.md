# AWS

## Estado Fase 4

El hub detecta AWS en modo read-only desde:

- Terraform con recursos `aws_*`.
- CloudFormation/SAM con tipos `AWS::*`.
- Serverless Framework con `provider: aws`.

No se hacen llamadas live a AWS en Fase 4. La API solo informa si hay señales de credenciales (`AWS_PROFILE` o access key por entorno), sin devolver valores.

## Drift reportado

- Manifests AWS presentes sin proveedor declarado en el descriptor.
- `0.0.0.0/0` en reglas de ingreso.
- IAM wildcard.
- S3 bucket sin cifrado declarado junto al recurso.
- Discovery live no configurado.

## Requisito para evolucion live

Antes de consultar AWS real, agregar:

- rol/usuario read-only dedicado;
- region allowlist;
- cuenta esperada por ambiente;
- auditoria de cada llamada;
- cache de inventario con TTL.
