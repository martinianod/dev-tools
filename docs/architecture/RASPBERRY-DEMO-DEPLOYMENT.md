# PROMPT MAESTRO — CheDoparti Raspberry Pi 4 Demo Server

## Rol

Actuá como **Principal Software Architect + Senior DevSecOps/SRE + Platform Engineer**, con experiencia práctica en:

- Java 21 / Spring Boot.
- React / Vite / Next.js si existieran en el repositorio.
- Docker / Docker Compose.
- PostgreSQL.
- Redis.
- Cloudflare Tunnel.
- Tailscale / Tailscale SSH.
- GitHub Actions.
- Container registries.
- Linux hardening.
- ARM64 / AMD64 multi-platform builds.
- CI/CD.
- Observabilidad.
- Backups y disaster recovery.
- Seguridad de aplicaciones web multi-tenant.
- Migraciones reproducibles entre edge/on-premise, VPS y cloud.

Tu misión es **auditar, diseñar e implementar un perfil de despliegue seguro y reproducible de CheDoparti sobre una Raspberry Pi 4**, pensado inicialmente para demos y pilotos reales con clubes, pero preparado para migrar posteriormente a una VPS o cloud sin rediseñar la aplicación.

---

# 0. REGLAS FUNDAMENTALES

Estas reglas son obligatorias.

1. **NO asumir la arquitectura actual.**
   - Inspeccioná el repositorio real.
   - No reutilices ciegamente documentación histórica.
   - No asumas que siguen existiendo servicios como `institutions-service` o `booking-service`.
   - Detectá qué componentes existen hoy.

2. **NO romper el entorno local actual.**
   - El actual flujo Docker/local debe seguir funcionando.
   - Los nuevos archivos deben ser aditivos.
   - No elimines ni reemplaces Compose existentes hasta demostrar paridad.
   - Si detectás configuraciones legacy, documentalas antes de retirarlas.

3. **NO desplegar los ~19 contenedores automáticamente.**
   - Determiná cuáles son realmente necesarios para CheDoparti Core.
   - Separá Core, SaaS Control Plane, Athlo, observabilidad y tooling.
   - El entorno Raspberry debe ejecutar sólo el mínimo conjunto funcional requerido por el piloto.

4. **NO exponer bases de datos, Redis, Actuator, Docker API, Grafana, Prometheus, Swagger ni backends internos directamente a Internet.**

5. **NO hacer port-forwarding del router doméstico salvo justificación excepcional documentada.**
   - Preferir Cloudflare Tunnel para tráfico público HTTPS.
   - Preferir Tailscale para administración.

6. **NO almacenar secrets en Git.**
   - Nunca versionar tokens, passwords, claves privadas, JWT secrets, Cloudflare tokens, Tailscale auth keys o credenciales de base de datos.
   - Crear únicamente `.env.example`, documentación y referencias a secret stores.

7. **NO usar certificados autofirmados para el acceso del club.**
   - La URL pública debe utilizar TLS válido.

8. **NO utilizar `latest` como única estrategia de versionado.**
   - Toda release desplegable debe ser identificable por versión, tag o commit SHA.

9. **NO compilar en la Raspberry como flujo normal de deployment.**
   - CI debe construir las imágenes.
   - Raspberry debe hacer `pull` y ejecutar.
   - Sólo permitir build local en la Pi como mecanismo de emergencia documentado.

10. **Las imágenes propias deben soportar como mínimo:**
    - `linux/arm64`
    - `linux/amd64`

11. **Toda modificación debe estar respaldada por validación.**
    - Tests.
    - Health checks.
    - Smoke tests.
    - Security checks.
    - Rollback verificable.

12. Si alguna decisión depende del hardware real de la Raspberry —RAM, almacenamiento, sistema operativo, arquitectura— detectalo automáticamente cuando sea posible y documentá cualquier dato que deba aportar el operador.

---

# 1. OBJETIVO DE ARQUITECTURA

El resultado final debe permitir este flujo:

```text
                              INTERNET
                                 │
                                 │ HTTPS
                                 ▼
                       demo.chedoparti.com
                                 │
                                 ▼
                         Cloudflare Edge
                                 │
                         Cloudflare Tunnel
                                 │
═════════════════════════════════╪════════════════════════════
                                 │
                       Raspberry Pi 4
                                 │
                 ┌───────────────┼───────────────┐
                 │               │               │
                 ▼               ▼               ▼
              Frontend       Gateway/BFF       Backend
                                                 │
                                     ┌───────────┴───────────┐
                                     ▼                       ▼
                                 PostgreSQL                 Redis
                                  PRIVATE                   PRIVATE
```

Administración:

```text
Notebook del administrador
        │
        ▼
     Tailscale
        │
        ▼
 Raspberry Pi 4
        │
        ▼
 SSH / operaciones
```

La Raspberry debe comportarse como **runtime de demo/staging**, no como una máquina artesanal dependiente de pasos manuales.

---

# 2. FASE 1 — AUDITORÍA OBLIGATORIA DEL REPOSITORIO

Antes de modificar código o infraestructura, inspeccioná exhaustivamente el workspace.

Generá:

```text
docs/deployment/raspberry/AUDIT.md
```

Debe incluir como mínimo:

## 2.1 Estructura del repositorio

Identificá:

- monorepo o multi-repo.
- aplicaciones.
- servicios.
- backends.
- frontends.
- gateways.
- BFF.
- bases de datos.
- Redis.
- workers.
- schedulers.
- WebSockets/SSE.
- servicios SaaS.
- Athlo.
- servicios legacy.
- herramientas de observabilidad.
- herramientas sólo de desarrollo.

## 2.2 Estado Git

Para cada repositorio detectado:

- path.
- remote.
- rama actual.
- commit SHA.
- dirty/clean.
- tags relevantes.

No modificar cambios locales del usuario.

## 2.3 Inventario Docker

Para cada:

- `Dockerfile`.
- `docker-compose*.yml`.
- perfil.
- override.
- network.
- volume.

Documentar:

| Servicio | Imagen | Build | Puertos | Networks | Volumes | Depends On | Healthcheck | Uso |
|---|---|---|---|---|---|---|---|---|

## 2.4 Mapa de comunicaciones

Construí un diagrama real:

```text
frontend
    ↓
gateway / BFF
    ↓
backend
    ↓
postgres / redis
```

pero basado en configuración/código real.

Identificá:

- URLs hardcodeadas.
- CORS.
- REST.
- WebSocket.
- SSE.
- callbacks.
- OAuth.
- JWT.
- SMTP.
- almacenamiento de archivos.
- servicios externos.
- analytics.
- weather provider si existe.
- pagos si existen.
- cualquier webhook.

## 2.5 Clasificación de servicios

Clasificá cada contenedor como:

- `CORE_REQUIRED`
- `CORE_OPTIONAL`
- `SAAS_CONTROL_PLANE`
- `ATHLO`
- `OBSERVABILITY`
- `DEV_ONLY`
- `LEGACY`
- `UNKNOWN`

No elimines los `UNKNOWN`; investigalos.

## 2.6 Perfil mínimo Raspberry

Determiná el conjunto mínimo necesario para:

- login.
- multi-tenancy.
- socios.
- instituciones.
- canchas.
- reservas.
- precios.
- torneos.
- notificaciones necesarias para demo.
- panel administrativo.
- cualquier flujo crítico actualmente implementado.

Producí:

```text
docs/deployment/raspberry/SERVICE-SELECTION.md
```

explicando por qué cada servicio entra o queda fuera.

---

# 3. FASE 2 — EVALUACIÓN DE RECURSOS

Detectá:

```bash
uname -m
cat /etc/os-release
free -h
df -h
lsblk
docker version
docker compose version
```

y cualquier dato equivalente disponible.

Generá:

```text
docs/deployment/raspberry/CAPACITY.md
```

Analizá:

- Raspberry Pi 4 RAM disponible.
- swap.
- CPU.
- almacenamiento.
- microSD vs SSD.
- espacio Docker.
- consumo aproximado por servicio.
- JVM heap actual.
- PostgreSQL.
- Redis.
- logs.

Si la Pi tiene 4 GB o menos, diseñá un perfil agresivamente liviano.

Si tiene 8 GB, seguir priorizando eficiencia.

## Recomendación de almacenamiento

Para pilotos que generen datos reales:

- recomendar SSD USB 3.0.
- evitar depender de microSD para PostgreSQL.
- documentar filesystem y montaje.
- documentar backup externo.

No borres ni reformatees discos automáticamente.

---

# 4. FASE 3 — NUEVA ESTRUCTURA DE DEPLOYMENT

Crear, adaptando nombres a la estructura real:

```text
compose/
├── compose.core.yml
├── compose.demo.yml
├── compose.observability.yml
├── compose.saas.yml
└── compose.dev.yml
```

y:

```text
deploy/
└── raspberry/
    ├── README.md
    ├── install.sh
    ├── bootstrap.sh
    ├── hardening.sh
    ├── deploy.sh
    ├── rollback.sh
    ├── backup.sh
    ├── restore.sh
    ├── healthcheck.sh
    ├── smoke-test.sh
    ├── status.sh
    └── uninstall-demo.sh
```

Además:

```text
docs/deployment/raspberry/
├── AUDIT.md
├── ARCHITECTURE.md
├── SERVICE-SELECTION.md
├── CAPACITY.md
├── SECURITY.md
├── OPERATIONS.md
├── BACKUP-RESTORE.md
├── TROUBLESHOOTING.md
├── DISASTER-RECOVERY.md
└── MIGRATION-TO-VPS.md
```

No crear scripts ficticios: todos deben ser ejecutables, idempotentes cuando corresponda y usar `set -Eeuo pipefail`.

---

# 5. DOCKER COMPOSE — REQUISITOS

## 5.1 Redes

Crear redes separadas según necesidad.

Ejemplo conceptual:

```text
public-edge
app-network
data-network
observability-network
```

PostgreSQL y Redis sólo deben pertenecer a redes internas necesarias.

## 5.2 Puertos

Revisar todos los `ports:`.

En demo:

- PostgreSQL: sin host port.
- Redis: sin host port.
- Backend interno: no público.
- Prometheus: no público.
- Grafana: no público.
- Actuator: no público.
- Docker API/socket: nunca público.

Exponer únicamente lo imprescindible hacia Cloudflare Tunnel.

## 5.3 Healthchecks

Todo servicio crítico debe tener healthcheck real.

Orden conceptual:

```text
postgres healthy
    ↓
redis healthy
    ↓
backend healthy
    ↓
gateway healthy
    ↓
frontend healthy
```

No depender únicamente de `depends_on` sin health conditions cuando la versión de Compose permita un mecanismo apropiado.

## 5.4 Restart

Servicios persistentes:

```yaml
restart: unless-stopped
```

o equivalente justificado.

## 5.5 Logging

Configurar rotación para evitar llenar el SSD:

```text
max-size
max-file
```

No imprimir:

- passwords.
- JWT completos.
- refresh tokens.
- cookies.
- Authorization header.
- credenciales DB.
- secretos.

## 5.6 Resource limits

Definir límites razonables por servicio.

Para JVM:

- revisar `-Xms`.
- revisar `-Xmx`.
- preferir `-XX:MaxRAMPercentage`.
- evitar reservar memoria innecesaria.

Documentar valores elegidos y evidencia.

---

# 6. MULTI-ARCH BUILD

Todas las imágenes propias deben poder construirse para:

```text
linux/amd64
linux/arm64
```

Usar Docker Buildx.

Resultado esperado:

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --tag REGISTRY/IMAGE:VERSION \
  --tag REGISTRY/IMAGE:GIT_SHA \
  --push .
```

No hardcodear registry real si no está configurado.

Validar manifiesto multi-platform.

Generar scripts o workflow reutilizable.

---

# 7. CONTAINER REGISTRY

Detectar qué registry usa el proyecto.

Preferencia:

1. GitHub Container Registry si el repositorio está en GitHub.
2. Registry ya existente en el proyecto.
3. Otro registry configurado por el usuario.

No crear dependencia nueva sin necesidad.

Aplicar:

- mínimo privilegio.
- imágenes privadas cuando corresponda.
- tags inmutables para releases.
- SHA.
- versión semántica si el proyecto la utiliza.

---

# 8. CI/CD

Crear o adaptar workflows.

Objetivo:

```text
push / PR
    ↓
lint
    ↓
unit tests
    ↓
integration tests
    ↓
security checks
    ↓
build
    ↓
multi-platform images
    ↓
registry
    ↓
manual/controlled deploy to demo
```

Crear como mínimo, si GitHub Actions corresponde:

```text
.github/workflows/ci.yml
.github/workflows/container-build.yml
.github/workflows/deploy-demo.yml
```

No duplicar workflows existentes; reutilizar los actuales.

## Deploy demo

Debe ser:

- controlado.
- auditable.
- preferentemente manual mediante `workflow_dispatch` o estrategia existente.
- sin incluir secretos en logs.

No hacer deploy automático a la Raspberry desde un PR no confiable.

---

# 9. CLOUDFLARE TUNNEL

Objetivo:

```text
https://demo.chedoparti.com
```

No asumir que el dominio ya está disponible.

Crear soporte para:

```text
cloudflared
```

preferentemente en Docker o como servicio host, justificando la elección.

## Reglas

- no port-forwarding doméstico.
- túnel iniciado desde la Raspberry.
- TLS válido.
- origin interno no expuesto.
- token en secret.
- jamás versionar credenciales Cloudflare.
- documentar creación manual del túnel cuando requiera intervención humana.

Crear:

```text
docs/deployment/raspberry/CLOUDFLARE.md
```

con instrucciones exactas.

La configuración debe admitir variable:

```text
CHEDOPARTI_DEMO_HOSTNAME=demo.chedoparti.com
```

sin hardcodearla en múltiples sitios.

---

# 10. CLOUDFLARE ACCESS — PILOTO PRIVADO

Preparar opcionalmente un modo:

```text
PRIVATE_DEMO=true
```

para que la aplicación esté precedida por Cloudflare Access.

Objetivo:

```text
Internet
    ↓
Cloudflare Access
    ↓
usuarios autorizados
    ↓
CheDoparti login
```

No reemplazar la autenticación propia de CheDoparti.

Cloudflare Access es una capa perimetral adicional para el piloto.

Documentar cómo permitir:

- emails concretos del club.
- administradores.
- revocación.

No crear bypass hacia backend.

---

# 11. TAILSCALE

Usar Tailscale para administración privada.

Objetivo:

```text
notebook admin
    ↓
tailnet
    ↓
raspberry
```

Configurar/documentar:

- instalación.
- device naming.
- ACLs.
- tags si corresponden.
- SSH privado.
- Tailscale SSH si se adopta.
- check mode para accesos sensibles si aplica.

Nunca publicar SSH directamente a Internet como opción predeterminada.

Crear:

```text
docs/deployment/raspberry/TAILSCALE.md
```

---

# 12. LINUX HARDENING

Crear:

```text
deploy/raspberry/hardening.sh
```

pero NO ejecutar cambios destructivos sin validación.

Debe contemplar:

## Usuario

- evitar trabajo cotidiano como root.
- usuario dedicado de deployment si conviene.
- sudo controlado.

## SSH

Si Tailscale gestiona acceso:

- no requerir puerto 22 público.
- deshabilitar password login cuando sea seguro.
- mantener mecanismo de recuperación documentado.

## Firewall

Configurar UFW/nftables según OS.

Base conceptual:

```bash
ufw default deny incoming
ufw default allow outgoing
```

Abrir únicamente lo realmente necesario.

Advertencia: Docker puede interactuar con iptables/nftables; verificar comportamiento real y no asumir que UFW por sí solo protege ports publicados por Docker.

## Sistema

- security updates.
- timezone.
- NTP.
- hostname.
- log rotation.
- disk monitoring.

No activar unattended upgrades que puedan reiniciar servicios críticos sin evaluar política.

---

# 13. SEGURIDAD DE CHEDOPARTI

Antes de permitir usuarios externos, ejecutar auditoría.

Revisar obligatoriamente:

- IDOR/BOLA.
- autorización por tenant.
- horizontal privilege escalation.
- vertical privilege escalation.
- Spring Method Security.
- JWT validation.
- refresh tokens.
- expiración.
- secrets.
- CORS.
- CSRF según arquitectura.
- rate limiting.
- brute force.
- account lockout si aplica.
- security headers.
- HSTS.
- CSP.
- X-Frame-Options o frame-ancestors.
- X-Content-Type-Options.
- Referrer-Policy.
- cookies Secure/HttpOnly/SameSite.
- input validation.
- SQL injection.
- XSS.
- upload validation.
- SSRF si consume URLs externas.
- open redirect.
- mass assignment.
- error leakage.
- stack traces.
- Actuator.
- Swagger/OpenAPI.
- debug endpoints.
- admin endpoints.
- WebSocket/SSE auth.
- webhooks.
- file/media access.
- tenant data isolation.
- logs.

## Gate crítico

Si detectás vulnerabilidades críticas que permiten:

- acceso a datos de otro tenant.
- bypass de autenticación.
- exposición de secretos.
- ejecución remota.
- acceso público a DB/Redis.
- acceso no autorizado a Actuator sensible.

marcar el ambiente:

```text
NOT_SAFE_FOR_EXTERNAL_DEMO
```

y no declarar el deployment listo hasta corregirlas.

---

# 14. SECRETS

Crear:

```text
.env.demo.example
```

Nunca:

```text
.env.demo
```

versionado.

Ejemplo de variables esperables, adaptadas al proyecto real:

```text
CHEDOPARTI_ENV=demo

DATABASE_NAME=
DATABASE_USER=
DATABASE_PASSWORD=

REDIS_PASSWORD=

JWT_SECRET=
JWT_ISSUER=
JWT_AUDIENCE=

CLOUDFLARE_TUNNEL_TOKEN=

PUBLIC_BASE_URL=
ALLOWED_ORIGINS=

SMTP_HOST=
SMTP_USER=
SMTP_PASSWORD=
```

No inventar variables que el código no usa: mapear las reales y proponer nuevas sólo cuando sean necesarias.

---

# 15. BACKUPS

Crear estrategia real de PostgreSQL.

Scripts:

```text
deploy/raspberry/backup.sh
deploy/raspberry/restore.sh
```

## Requisitos

- `pg_dump` consistente.
- timestamp.
- compresión.
- checksum.
- logs.
- verificación.
- retention.
- almacenamiento fuera del contenedor.
- copia externa recomendada.

Política inicial sugerida, configurable:

```text
7 daily
4 weekly
3 monthly
```

No asumir que esa retención es obligatoria; parametrizar.

## Restore test

Crear procedimiento para:

```text
backup
    ↓
temporary database
    ↓
restore
    ↓
schema validation
    ↓
smoke test
```

Un backup que nunca fue restaurado no debe considerarse validado.

---

# 16. DISASTER RECOVERY

Documentar escenarios:

1. Raspberry pierde energía.
2. Docker daemon falla.
3. contenedor backend no levanta.
4. PostgreSQL no inicia.
5. SSD lleno.
6. microSD falla.
7. Raspberry muere.
8. Internet doméstico cae.
9. Cloudflare Tunnel cae.
10. release nueva rompe funcionalidad.
11. migración Flyway falla.
12. secreto comprometido.

Para cada caso:

- detección.
- impacto.
- recuperación.
- RPO.
- RTO estimado cuando pueda determinarse.
- rollback.

---

# 17. DEPLOYMENT SCRIPT

Crear:

```text
deploy/raspberry/deploy.sh
```

Debe realizar como mínimo:

```text
1. preflight
2. verificar arquitectura
3. verificar Docker
4. verificar Compose
5. verificar disco
6. verificar memoria
7. verificar secrets requeridos
8. comprobar acceso al registry
9. registrar versión actual
10. backup DB
11. pull nuevas imágenes
12. aplicar deployment
13. esperar healthchecks
14. ejecutar smoke tests
15. comprobar URL pública si está configurada
16. registrar versión nueva
17. limpiar imágenes huérfanas con política segura
```

Debe fallar rápido y emitir mensajes claros.

No mostrar secretos.

---

# 18. ROLLBACK

Crear:

```text
deploy/raspberry/rollback.sh
```

No depender de `latest`.

Mantener metadata del deployment anterior.

Ejemplo:

```text
current:
  frontend: 1.8.4
  backend: 1.8.4

previous:
  frontend: 1.8.3
  backend: 1.8.3
```

Si hay Flyway/Liquibase:

- analizar compatibilidad de rollback.
- no revertir schema destructivamente de forma automática.
- aplicar expand/contract cuando corresponda.
- documentar incompatibilidades.

---

# 19. SMOKE TESTS

Crear:

```text
deploy/raspberry/smoke-test.sh
```

Validar, adaptado a endpoints reales:

- frontend responde.
- health backend.
- login básico controlado si existe usuario técnico seguro.
- DB connectivity.
- Redis connectivity.
- tenant resolution.
- endpoint público crítico.
- gateway routing.
- CORS.
- WebSocket/SSE si son críticos.

No almacenar contraseña real en el script.

---

# 20. STATUS

Crear:

```text
deploy/raspberry/status.sh
```

Debe mostrar:

```text
Environment
Hostname
Git/Release
Container image tags
Container health
CPU
RAM
Disk
PostgreSQL status
Redis status
Tunnel status
Tailscale status
Last backup
Public URL
```

Nunca mostrar valores secretos.

---

# 21. OBSERVABILIDAD

No levantar automáticamente todo el stack pesado actual en la Raspberry.

Auditar:

- Grafana.
- Prometheus.
- Loki.
- Promtail/Alloy si existe.
- Tempo.
- OTEL Collector.
- exporters.

Elegir uno de estos modos:

## `observability=minimal`

- healthchecks.
- Docker logs rotados.
- Actuator privado.
- métricas mínimas.
- OTEL Collector si el costo es razonable.

## `observability=full`

Sólo si la capacidad de la Pi lo soporta y existe una razón.

Preferir enviar telemetría a infraestructura externa cuando exista.

Actuator nunca debe quedar público.

---

# 22. EMAILS Y NOTIFICACIONES

En demo:

- no usar Mailpit como proveedor público.
- Mailpit puede seguir siendo dev-only.
- si el club debe recibir emails reales, integrar proveedor configurado.
- evitar envíos masivos accidentales.
- usar `demo`/sandbox mode si el proveedor lo permite.
- registrar claramente ambiente.

No enviar emails a usuarios reales durante smoke tests sin consentimiento/configuración explícita.

---

# 23. DATOS DEL PILOTO

Distinguir:

```text
seed/demo data
```

de:

```text
real pilot data
```

Si el club empieza a cargar información real:

- tratarla como persistente.
- incluirla en backups.
- no resetear DB en deploy.
- nunca usar `docker compose down -v` en scripts normales.
- no ejecutar seeds destructivos.

---

# 24. MIGRACIÓN A VPS

Crear:

```text
docs/deployment/raspberry/MIGRATION-TO-VPS.md
```

Diseñar el deployment para que el proceso futuro sea:

```text
Raspberry ARM64
        ↓
backup
        ↓
VPS AMD64
        ↓
restore
        ↓
pull misma release
        ↓
healthchecks
        ↓
switch DNS/tunnel
```

No cambiar lógica de aplicación.

El objetivo es:

```text
build once
deploy anywhere
```

Variables dependientes de ambiente deben permanecer externas al artefacto.

---

# 25. DNS Y URLS

Centralizar:

```text
PUBLIC_BASE_URL
API_BASE_URL
WS_BASE_URL
```

o nombres equivalentes ya existentes.

Eliminar hardcodes como:

```text
localhost
127.0.0.1
192.168.x.x
```

del código que vaya a producción/demo.

No romper el ambiente local: usar configuración por ambiente.

---

# 26. CORS

No usar:

```text
*
```

con credentials.

Demo debe permitir únicamente origins esperados.

Ejemplo conceptual:

```text
https://demo.chedoparti.com
```

Si existen múltiples frontends, generar allowlist explícita.

---

# 27. RATE LIMITING

Auditar dónde se implementa actualmente:

- Cloudflare.
- gateway.
- backend.
- ambos.

Aplicar defense in depth sin duplicación absurda.

Proteger especialmente:

- login.
- register.
- password reset.
- OTP.
- endpoints costosos.
- búsquedas.
- uploads.
- webhooks.

Evitar bloquear usuarios legítimos del mismo club/NAT.

---

# 28. POSTGRESQL

Configurar para hardware limitado.

Revisar:

- `shared_buffers`.
- `work_mem`.
- `maintenance_work_mem`.
- connections.
- Hikari pool.
- indexes.
- slow queries.
- autovacuum.
- WAL.
- storage.

No aplicar tuning arbitrario: medir hardware y carga.

Crear persistencia fuera del lifecycle del contenedor.

---

# 29. REDIS

Revisar si Redis es:

- cache.
- lock.
- sessions.
- queue.
- rate limiter.
- pub/sub.

Configurar memoria máxima si corresponde.

No publicarlo.

Configurar persistencia sólo si la semántica real lo necesita.

---

# 30. FRONTEND

Build de producción.

No servir Vite dev server al club.

Usar:

- build estático servido por Nginx/Caddy o mecanismo actual.
- headers.
- caching.
- compression.
- SPA fallback correcto.

No contener secretos en variables frontend.

Todo dato incluido en bundle debe considerarse público.

---

# 31. GATEWAY / BFF

Auditar si ambos son realmente necesarios.

No eliminar ninguno durante este trabajo salvo evidencia fuerte, tests y decisión documentada.

Identificar responsabilidades:

## Gateway

- routing.
- auth perimetral.
- rate limiting.
- CORS.
- headers.

## BFF

- agregación.
- view-models.
- APIs específicas de frontend.

Si hay duplicación:

```text
docs/architecture/GATEWAY-BFF-REVIEW.md
```

pero no hacer refactor arquitectónico masivo como side-effect del deploy Raspberry.

---

# 32. SAAS Y ATHLO

No asumir que pertenecen al runtime del piloto.

Auditar relaciones.

Si SaaS Control Plane es necesario para:

- tenant provisioning.
- plan.
- subscription.
- login.
- feature flags.

incluir únicamente los servicios indispensables.

Si no son necesarios para runtime:

- mantenerlos fuera de `compose.demo.yml`.

Athlo igual.

---

# 33. PRUEBAS DE CARGA

No lanzar pruebas agresivas contra la Pi mientras usuarios reales la utilizan.

Crear perfil de test controlado.

Medir:

- RPS.
- p50.
- p95.
- p99.
- CPU.
- RAM.
- DB pool.
- GC.
- error rate.

Determinar límite seguro orientativo.

Documentar que Raspberry Demo no equivale a capacidad de producción.

---

# 34. DOCUMENTACIÓN OPERATIVA

El README principal del deployment debe permitir a otra persona realizar:

## Primera instalación

```text
fresh Raspberry
→ OS
→ Docker
→ Tailscale
→ Cloudflare
→ secrets
→ pull images
→ deploy
→ health
→ demo URL
```

## Deploy

Un comando.

## Rollback

Un comando.

## Backup

Un comando.

## Restore

Un procedimiento seguro.

## Status

Un comando.

---

# 35. VARIABLES DE HARDWARE

No asumir modelo exacto.

Detectar:

```text
Pi 4 RAM
ARM architecture
SSD
temperature
disk capacity
```

Si temperatura o throttling son preocupantes:

- recomendar cooling.
- documentar.
- no inventar datos.

---

# 36. UPS

No es requisito de software, pero incluir recomendación operativa para piloto:

```text
Raspberry
+
SSD
+
router
+
UPS
```

Documentar que un corte de energía del router invalida acceso aunque la Pi siga encendida.

---

# 37. DEFINICIÓN DE READY

El ambiente sólo puede etiquetarse:

```text
READY_FOR_CLUB_PILOT
```

cuando:

- imágenes ARM64 funcionan.
- imágenes AMD64 están disponibles para migración.
- frontend carga.
- backend healthy.
- DB persistente.
- Redis privado.
- login funciona.
- tenant isolation validado.
- critical authorization tests pasan.
- ningún secret está en Git.
- ningún puerto interno está público.
- URL HTTPS válida.
- Cloudflare Tunnel operativo.
- administración privada operativa.
- backups funcionan.
- restore fue probado.
- rollback fue probado.
- restart tras reboot fue probado.
- logs rotan.
- disco tiene margen.
- smoke tests pasan.
- documentación está completa.

En caso contrario informar:

```text
NOT_READY
```

junto a blockers concretos.

---

# 38. REBOOT TEST

Realizar o dejar automatizado/indicado un test:

```text
sudo reboot
```

y verificar después:

```text
Docker activo
containers activos
healthchecks green
Cloudflare Tunnel conectado
Tailscale conectado
URL pública operativa
DB intacta
```

No reiniciar una máquina del usuario sin autorización explícita.

---

# 39. SECURITY CHECKLIST FINAL

Generar:

```text
docs/deployment/raspberry/SECURITY-CHECKLIST.md
```

con checkboxes reales para:

- [ ] DB no publicada.
- [ ] Redis no publicado.
- [ ] SSH no público.
- [ ] Docker socket no público.
- [ ] TLS válido.
- [ ] Cloudflare Tunnel.
- [ ] Access opcional.
- [ ] Tailscale ACL.
- [ ] secrets fuera de Git.
- [ ] JWT seguro.
- [ ] Method Security.
- [ ] IDOR tests.
- [ ] tenant isolation.
- [ ] Actuator privado.
- [ ] Swagger privado.
- [ ] rate limiting.
- [ ] CORS exacto.
- [ ] headers.
- [ ] logs sin secretos.
- [ ] backup.
- [ ] restore.
- [ ] rollback.
- [ ] reboot recovery.
- [ ] disk monitoring.
- [ ] resource limits.

---

# 40. ENTREGABLE FINAL

Al terminar, entregar un reporte:

```text
docs/deployment/raspberry/IMPLEMENTATION-REPORT.md
```

Debe contener:

## Arquitectura detectada

Servicios reales.

## Arquitectura Raspberry resultante

Diagrama.

## Servicios incluidos

Tabla.

## Servicios excluidos

Tabla y razón.

## Archivos creados

Lista.

## Archivos modificados

Lista.

## Seguridad

Controles implementados.

## CI/CD

Flujo.

## Deployment

Comando exacto.

## URL

Cómo configurarla.

## Administración

Cómo conectarse.

## Backups

Estado.

## Restore

Estado.

## Rollback

Estado.

## Recursos

RAM/CPU/storage estimados y medidos.

## Issues encontrados

Clasificación:

```text
BLOCKER
CRITICAL
HIGH
MEDIUM
LOW
```

## Estado

Uno de:

```text
READY_FOR_CLUB_PILOT
READY_WITH_LIMITATIONS
NOT_READY
```

## Próximos pasos

Ordenados por prioridad.

---

# 41. FORMA DE TRABAJO

Trabajá incrementalmente.

Secuencia obligatoria:

```text
AUDIT
  ↓
PLAN
  ↓
IMPLEMENT
  ↓
TEST
  ↓
SECURITY REVIEW
  ↓
BACKUP/RESTORE TEST
  ↓
ROLLBACK TEST
  ↓
DOCUMENT
```

No hagas una reescritura masiva.

No borres infraestructura existente por comodidad.

Antes de cada cambio importante verificá dependencias.

Si encontrás contradicciones entre documentación y código, el código/configuración runtime vigente tiene prioridad y la discrepancia debe documentarse.

---

# 42. PRINCIPIO DE PORTABILIDAD

Todo lo implementado debe facilitar:

```text
LOCAL
   ↓
RASPBERRY DEMO
   ↓
VPS STAGING
   ↓
VPS/CLOUD PRODUCTION
```

Sin forks de aplicación.

Las diferencias deben concentrarse en:

- configuración.
- secrets.
- Compose.
- infraestructura.
- sizing.

No en lógica de negocio.

---

# 43. RESULTADO ESPERADO

Al completar esta tarea, CheDoparti debe poder desplegarse así:

```bash
./deploy/raspberry/deploy.sh
```

y verificarse así:

```bash
./deploy/raspberry/status.sh
./deploy/raspberry/smoke-test.sh
```

Con acceso público:

```text
https://demo.chedoparti.com
```

o hostname configurable equivalente.

Administración:

```text
Tailscale → Raspberry
```

Persistencia:

```text
SSD → PostgreSQL volumes + backups
```

Build:

```text
CI → linux/amd64 + linux/arm64 → Registry
```

Migración futura:

```text
Raspberry → VPS
```

sin necesidad de rediseñar CheDoparti.

---

# 44. PRIMERA RESPUESTA QUE DEBÉS DAR

Antes de modificar nada, devolvé exclusivamente un resumen de auditoría con:

1. arquitectura detectada;
2. servicios obligatorios para CheDoparti Core;
3. servicios opcionales;
4. servicios que no deberían correr en Raspberry;
5. RAM/storage estimados;
6. puertos actualmente expuestos;
7. riesgos de seguridad detectados;
8. dependencias que impiden separar servicios;
9. plan exacto de implementación;
10. archivos que proponés crear/modificar.

Después de esa auditoría, continuá con la implementación incremental sólo cuando el entorno y las dependencias estén suficientemente comprendidos.

No inventes componentes que no existan.

No marques el sistema como listo si no podés demostrarlo.
