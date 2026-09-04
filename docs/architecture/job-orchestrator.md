# Job Orchestrator

El orquestador crea jobs asincronicos para acciones aprobadas:

- `doctor`
- `tests`
- `coverage`
- `lint`
- `build`
- `sonar`
- `health`
- `smoke`
- `load`
- `dast`

Cada job registra:

- proyecto,
- rama y commit,
- etapas,
- logs sanitizados,
- resumen de fallos,
- timestamps,
- estado terminal.

La concurrencia por defecto es `MAX_CONCURRENT_JOBS=1`. Stress y acciones destructivas siguen bloqueadas por guardrails.

