# Disaster Recovery

Recuperacion actual:

- Reinstalar dependencias no requiere `npm install` porque el hub usa Node built-in.
- Levantar core: `docker compose --profile core up -d`.
- Estado del hub: restaurar `data/state.json` desde backup externo si existe.
- SonarQube: usar scripts bajo `sonarqube/scripts/`.

Limitaciones:

- No hay artifact store para rollback cross-version.
- No hay DR automatizado de Prometheus/Loki/Tempo.
- No hay RPO/RTO garantizado para el hub.

