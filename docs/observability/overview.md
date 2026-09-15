# Observability Overview

Stack local:

- Prometheus: `http://localhost:19090`
- Grafana: `http://localhost:13000`
- Loki: `http://localhost:13100`
- Tempo: `http://localhost:13200`
- Alertmanager: `http://localhost:19093`

OTLP desde procesos host: `127.0.0.1:14317` (gRPC) y `127.0.0.1:14318` (HTTP). Blackbox y cAdvisor son internos y no exponen UI host.

El dashboard `Project Observability` se filtra por proyecto. El hub no infiere salud si una senal no esta configurada o no devuelve muestras.
