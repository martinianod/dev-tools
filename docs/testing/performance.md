# Performance Testing

Fase 5 habilita load HTTP local acotado.

Guardrails actuales:

- hosts permitidos: `localhost`, `127.0.0.1`, `::1`, `host.docker.internal`.
- max VUs: 5.
- duracion maxima: 30 segundos.
- max requests: 120.
- timeout por request: 3000 ms.

Stress permanece bloqueado hasta aprobaciones/RBAC y limites especificos por proyecto.

