# Production Environment

Produccion esta protegida y read-only.

Politica actual:

- `apply`: bloqueado.
- `rollback`: bloqueado sin release artifacts.
- stress/chaos/destructivas: bloqueadas.
- secretos: no expuestos.

La plataforma no debe afirmar estado saludable de produccion sin senales verificadas por ambiente.

