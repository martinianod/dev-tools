# Agent Operating Guide

This workspace is the local Engineering Control Center. Treat it as a control plane, not as one of the managed project repositories.

## Rules

- Keep actions inside `/Users/martiniano/Documents/dev-tools` unless the user explicitly asks for managed project changes.
- Do not run arbitrary project commands from the UI or API. Use discovered approved commands, runtime profiles and closed catalogs.
- Never expose token values in API responses, logs, docs snapshots or UI text.
- Validate changes with `npm run check`, `./scripts/smoke.sh` and `HUB_TEST_BASE_URL=http://127.0.0.1:18080 npm test` when the real stack is running.
- Production/cloud mutation is blocked until RBAC, provider adapters and release artifacts exist.

## Phase Status

- Fases 0-6 are implemented in the local hub.
- Fase 7 adds living documentation generated from verified local state: guides, runbooks, Mermaid diagrams, confidence signals, history and snapshots under `docs/live/`.
- Fase 8 adds the infrastructure adapter registry, read-only discovery cache, source hashes and audited refresh actions.
- Fase 9 adds the embedded local agent identity, heartbeat, sanitized discovery snapshots, UI panel and audited `agent.*` actions.
- Fase 10 completes the infrastructure adapter contract with `infrastructure-adapter.v1`, explicit Docker/Compose/cloud/SCM/CI/observability/storage adapters, validation, connectivity, evidence, errors and secret guardrails.
- Fase 11 adds `git-version-management.v1`: local/remote/environment version comparison, deployed commit/branch evidence, last pull/build metadata, differentiated runtime actions and explicit confirmation before volume deletion.
- Fase 12 extends living documentation with `living-documentation.v2`: mandatory section coverage, environment/provider documents, source commit metadata, official-docs consultation registry, non-generic instructions and UI/API validation.
