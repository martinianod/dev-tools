# Fase 5 - Jobs y pruebas

## Alcance implementado

La Fase 5 agrega un orquestador de pruebas sobre la cola de jobs local existente.

Endpoints:

```text
GET /api/v1/testing/overview
GET /api/v1/projects/{idOrSlug}/testing/overview
GET /api/v1/projects/{idOrSlug}/testing/executions
POST /api/v1/projects/{idOrSlug}/testing/executions
```

## Contrato

Cada proyecto expone:

- `definitions`: catalogo cerrado de pruebas detectadas.
- `executions`: evidencia historica derivada de jobs locales.
- `guardrails`: limites y bloqueos efectivos.
- `workerPool`: estado del worker local.
- `targets`: URLs HTTP locales permitidas para load/DAST.
- `findings`: brechas de configuracion, evidencia o guardrails.

Tipos cubiertos:

- `unit`, `integration`, `e2e`, `contract`: desde comandos aprobados detectados.
- `smoke`: desde perfiles runtime locales aprobados.
- `load`: HTTP GET local con limites estrictos.
- `dast`: DAST pasivo read-only de headers HTTP.
- `stress`: modelado, pero bloqueado por guardrail.

## Guardrails

- No acepta comandos arbitrarios desde la UI o API.
- No acepta URLs externas para load/DAST; solo `localhost`, `127.0.0.1`, `::1` y `host.docker.internal`.
- No transmite secretos ni muestra valores sensibles.
- `HUB_TEST_KILL_SWITCH=1` bloquea load y DAST.
- Load test limitado a:
  - `maxVirtualUsers=5`
  - `maxDurationSeconds=30`
  - `maxRequests=120`
  - `perRequestTimeoutMs=3000`
- DAST es pasivo: no crawler, no fuzzing, no login, no writes.
- Stress, chaos y pruebas destructivas quedan bloqueadas hasta aprobaciones de Fase 6.

## Evidencia guardada

Cada ejecucion conserva en el job:

- proyecto
- ambiente
- branch
- commit
- actor local
- worker
- definicion de prueba
- parametros sanitizados
- guardrails aplicados
- stages
- logs sanitizados
- resumen de metricas o findings pasivos

## Estados

- `CONFIGURED_AND_VERIFIED`: definicion configurada con ultimo job exitoso.
- `CONFIGURED_NOT_VERIFIED`: definicion detectable pero sin ejecucion exitosa reciente.
- `NOT_CONFIGURED`: falta target o perfil requerido.
- `UNSUPPORTED`: capacidad modelada pero bloqueada por politica.
- `ERROR`: hay ejecucion fallida critica o error de discovery.

## Limitaciones

- Load test es intencionalmente pequeño; no reemplaza k6/JMeter/Gatling.
- DAST no reemplaza OWASP ZAP ni escaneos autenticados.
- Stress test no se ejecuta sin workflow de aprobacion.
- Produccion permanece protegida por defecto.

## Verificacion

```bash
npm run check
./scripts/smoke.sh
HUB_TEST_BASE_URL=http://127.0.0.1:18080 npm test
```

El smoke valida ambos endpoints y el test exige catalogo cerrado, worker local, load, DAST y stress bloqueado.
