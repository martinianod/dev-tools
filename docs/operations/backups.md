# Backups

Backups conocidos en este workspace:

- SonarQube local tiene `sonarqube/scripts/backup-db.sh`.
- Restore local disponible en `sonarqube/scripts/restore-db.sh`.
- El hub persiste estado en `data/state.json`; todavia no hay backup automatico del estado del hub.

Politica:

- Un backup no se considera confiable si nunca fue restaurado.
- Fase 7 solo documenta y expone evidencia; no marca backups como verificados sin restore real.

Pendiente:

- backup versionado de `data/state.json`,
- restore drill del hub,
- evidencia de ultima restauracion probada,
- RPO/RTO por ambiente.

