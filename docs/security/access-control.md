# Access control

## Baseline M0

La API usa un principal Bearer local configurado exclusivamente por environment:

```dotenv
HUB_AUTH_TOKEN=<32-o-mas-caracteres-aleatorios>
HUB_AUTH_ACTOR_ID=<identidad-auditable>
HUB_AUTH_ROLE=ADMIN
```

Sin token configurado, las lecturas loopback siguen disponibles y toda mutacion falla con `401`. La UI guarda el token solamente en `sessionStorage`.

La autorizacion esta centralizada antes del routing:

- `READ`: consultas.
- `OPERATE`: operaciones mutantes no administrativas.
- `ADMIN`: alta y trust de proyectos, aprobaciones, rollback, borrado de volumenes y logs.

El actor autenticado se propaga a auditoria, jobs, planes y deployments. CORS exige origins exactos; el rate limit se aplica a mutaciones antes de autenticar para reducir intentos por fuerza bruta.

## Limites documentados

M0 no agrega usuarios persistidos, permisos por proyecto, reautenticacion ni firma de aprobaciones. El token representa un principal local por instancia y el audit sigue almacenado en el JSON mutable del MVP. La evolucion multiusuario y append-only pertenece a M1+.
