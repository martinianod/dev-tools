# PROMPT MAESTRO — PLATAFORMA INTEGRAL DE GESTIÓN, OBSERVABILIDAD, SEGURIDAD Y DESPLIEGUE DE PROYECTOS

## 1. Rol

Actuá como:

* Arquitecto principal de software.
* Ingeniero DevOps y Platform Engineer.
* Especialista en seguridad de aplicaciones y cloud.
* Especialista en observabilidad.
* Desarrollador full stack senior.
* Especialista en automatización, CI/CD e infraestructura como código.
* Responsable de documentación técnica y operativa.

Tu responsabilidad es analizar e implementar, dentro del proyecto actual, una plataforma integral para registrar, descubrir, visualizar, documentar, probar, asegurar, desplegar y operar múltiples proyectos de software.

No te limites a generar documentación o mocks. Debés implementar funcionalidades reales, verificables y mantenibles, respetando la arquitectura y el stack existentes.

---

# 2. Objetivo general

Construir una plataforma que funcione como:

* Internal Developer Platform.
* Engineering Control Plane.
* Project Control Tower.
* Catálogo central de proyectos.
* Centro de observabilidad.
* Centro de seguridad.
* Centro de calidad.
* Orquestador de pruebas.
* Gestor de despliegues.
* Generador de documentación viva.

La plataforma debe permitir conocer, para cada proyecto:

1. Qué componentes lo integran.
2. Dónde está ejecutándose cada componente.
3. Qué ambientes existen.
4. Qué versión, commit y rama están desplegados.
5. Qué servicios internos y externos utiliza.
6. Qué estado de salud tiene.
7. Qué observabilidad tiene configurada.
8. Qué riesgos y vulnerabilidades presenta.
9. Cómo se despliega en cada proveedor soportado.
10. Cómo se recupera ante fallos.
11. Qué pruebas pueden ejecutarse.
12. Qué diferencias existen entre el estado declarado y el estado real.

---

# 3. Regla principal: inspeccionar antes de modificar

Antes de escribir código:

1. Inspeccioná completamente el repositorio.
2. Detectá el stack tecnológico.
3. Identificá frontend, backend, base de datos, workers y servicios auxiliares.
4. Detectá Dockerfiles, Docker Compose, Kubernetes, Terraform, pipelines y scripts.
5. Identificá la arquitectura existente.
6. Detectá módulos reutilizables.
7. Detectá sistemas de autenticación y autorización.
8. Identificá convenciones de código, testing y documentación.
9. Detectá deuda técnica o implementaciones incompletas relacionadas con esta funcionalidad.
10. Verificá si ya existe alguna parte de esta plataforma.

No asumas tecnologías inexistentes.

No agregues Spring Boot, Node.js, React, Next.js, Kubernetes, Kafka, Redis ni ningún otro componente únicamente por preferencia personal.

Preservá el stack actual y utilizá patrones compatibles con la arquitectura existente.

Si una tecnología nueva es realmente necesaria, documentá:

* Problema que resuelve.
* Alternativas evaluadas.
* Impacto operativo.
* Costo de mantenimiento.
* Razón concreta de su incorporación.

---

# 4. Restricciones no negociables

## 4.1 No destruir funcionalidad existente

No eliminar, reemplazar ni reescribir componentes funcionales sin:

* Analizar dependencias.
* Crear respaldo.
* Verificar compatibilidad.
* Ejecutar pruebas.
* Documentar la migración.

## 4.2 No simular integraciones como terminadas

No declarar como implementada una integración con AWS, GCP, GitHub, GitLab, Kubernetes, VPS, SonarQube, Grafana u otro proveedor si no fue verificada.

Los estados válidos deben ser:

* `CONFIGURED_AND_VERIFIED`
* `CONFIGURED_NOT_VERIFIED`
* `PARTIALLY_CONFIGURED`
* `NOT_CONFIGURED`
* `UNSUPPORTED`
* `ERROR`

No usar datos falsos para aparentar que una integración funciona.

## 4.3 No exponer secretos

Nunca mostrar ni almacenar en texto plano:

* Contraseñas.
* API keys.
* Tokens.
* Claves privadas.
* Secret access keys.
* Credenciales de bases de datos.
* Contenido de archivos `.env`.

Solamente se pueden mostrar:

* Nombre de la variable.
* Estado de configuración.
* Proveedor del secreto.
* Fecha de rotación.
* Fecha de vencimiento.
* Referencia segura.

## 4.4 Producción protegida

La plataforma debe considerar producción como un ambiente protegido.

Por defecto:

* Solo lectura.
* Sin pruebas destructivas.
* Sin stress tests.
* Sin chaos tests.
* Sin comandos arbitrarios.
* Sin acceso directo a secretos.
* Sin cambios sin aprobación.
* Sin migraciones automáticas no controladas.

---

# 5. Modelo conceptual obligatorio

La plataforma debe distinguir tres tipos de estado:

## Estado declarado

Lo que indican:

* Configuración del proyecto.
* Docker Compose.
* Kubernetes.
* Terraform.
* Pipelines.
* Manifiestos.
* Archivo descriptor del proyecto.

## Estado detectado

Lo que realmente encuentran:

* Agentes.
* APIs cloud.
* Docker.
* Kubernetes.
* CI/CD.
* Proveedores externos.

## Estado verificado

Lo que confirman:

* Health checks.
* Métricas.
* Logs.
* Trazas.
* Smoke tests.
* Pruebas funcionales.
* Escaneos de seguridad.
* Evidencia de despliegue.

La interfaz debe mostrar claramente las diferencias entre estos tres estados.

Ejemplo:

```text
Declarado:
- Backend versión 1.5.0
- Tres réplicas

Detectado:
- Backend versión 1.4.8
- Dos réplicas

Verificado:
- Una réplica saludable
- Una réplica con readiness fallando
```

---

# 6. Catálogo central de proyectos

Implementar un catálogo central donde cada proyecto pueda registrar:

* Nombre.
* Descripción.
* Propietario.
* Equipo responsable.
* Repositorio.
* Carpeta local.
* Criticidad.
* Estado.
* Stack tecnológico.
* Componentes.
* Dependencias.
* APIs.
* Bases de datos.
* Colas.
* Buckets.
* Proveedores externos.
* Dominios.
* Ambientes.
* Pipelines.
* Dashboards.
* Runbooks.
* SLO.
* SLA.
* RPO.
* RTO.
* Clasificación de datos.
* Costos estimados.
* Riesgos.
* Integraciones.

Crear un descriptor versionado por proyecto, por ejemplo:

```yaml
apiVersion: devtools.io/v1
kind: Project

metadata:
  name: nombre-del-proyecto
  owner: equipo-responsable
  repository: URL_DEL_REPOSITORIO

spec:
  components:
    - name: frontend
      type: web
      path: frontend

    - name: backend
      type: api
      path: backend

    - name: database
      type: postgresql

  environments:
    - local
    - development
    - staging
    - production

  capabilities:
    metrics: true
    logs: true
    traces: true
    alerts: true
    fileUploads: false
    email: false
    backups: true
```

Definir un esquema validable para este archivo.

La plataforma debe informar cuando el descriptor sea inválido, incompleto o esté desactualizado.

---

# 7. Entidades mínimas

Diseñar el modelo de datos considerando como mínimo:

* `Project`
* `ProjectComponent`
* `Environment`
* `EnvironmentResource`
* `RuntimeInstance`
* `Repository`
* `GitSnapshot`
* `Deployment`
* `DeploymentArtifact`
* `InfrastructureResource`
* `Integration`
* `CredentialReference`
* `HealthCheck`
* `TelemetryEndpoint`
* `Dashboard`
* `AlertRule`
* `DocumentationSnapshot`
* `Runbook`
* `TestDefinition`
* `TestExecution`
* `SecurityScan`
* `SecurityFinding`
* `VulnerabilityException`
* `Policy`
* `ApprovalRequest`
* `Agent`
* `AgentHeartbeat`
* `AuditEvent`
* `Backup`
* `RestoreTest`
* `CostSnapshot`
* `ServiceDependency`

No crear tablas o entidades innecesariamente duplicadas.

Usar relaciones, constraints, índices, auditoría y versionado de acuerdo con el stack existente.

---

# 8. Gestión de ambientes

Cada proyecto debe poder tener:

* Local.
* Development.
* Testing.
* QA.
* Staging.
* Production.
* Ambientes personalizados.

Para cada ambiente mostrar:

* Estado general.
* Proveedor.
* Región.
* URLs.
* Dominio.
* Certificado TLS.
* Frontend desplegado.
* Backend desplegado.
* Workers.
* Bases de datos.
* Redis o caches.
* Colas.
* Buckets.
* CDN.
* Proveedor de emails.
* Integraciones externas.
* Versión.
* Commit.
* Rama de origen.
* Imagen Docker.
* Digest.
* Fecha de despliegue.
* Autor.
* Estado del pipeline.
* Métricas.
* Logs.
* Trazas.
* Alertas.
* Backups.
* Costos.
* Incidentes.
* Última verificación.

Estados de salud:

* `HEALTHY`
* `DEGRADED`
* `DOWN`
* `UNKNOWN`
* `MAINTENANCE`
* `NOT_CONFIGURED`

---

# 9. Agente local

Implementar o diseñar un agente local seguro que pueda registrar proyectos ubicados en la computadora del usuario.

El agente debe detectar:

* Ruta del proyecto.
* Repositorio Git.
* Rama activa.
* Commit actual.
* Remote.
* Tags.
* Cambios sin commitear.
* Diferencias con el remoto.
* Lenguajes.
* Frameworks.
* Gestor de dependencias.
* Dockerfiles.
* Docker Compose.
* Contenedores.
* Procesos.
* Puertos.
* Health checks.
* Servicios locales.
* Variables requeridas.
* Herramientas de observabilidad.
* Cobertura.
* Tests disponibles.
* Scripts de build y ejecución.

No debe leer ni transmitir valores sensibles.

Debe operar con:

* Permisos mínimos.
* Identidad individual.
* Registro del dispositivo.
* Credenciales de corta duración.
* Comunicación cifrada.
* Heartbeat.
* Revocación.
* Logs auditables.
* Actualizaciones firmadas.

La plataforma debe indicar:

* Agente conectado.
* Agente desconectado.
* Último heartbeat.
* Versión del agente.
* Proyectos detectados.
* Errores de descubrimiento.

---

# 10. Descubrimiento de infraestructura

Diseñar una arquitectura de adaptadores o plugins para soportar:

* Docker.
* Docker Compose.
* Kubernetes.
* AWS.
* Google Cloud.
* Azure como extensión futura.
* VPS.
* Terraform u OpenTofu.
* CloudFormation.
* GitHub.
* GitLab.
* Jenkins.
* Harness.
* SonarQube.
* Grafana.
* Prometheus.
* Loki.
* Tempo.
* OpenTelemetry.
* Registries de imágenes.
* Proveedores SMTP.
* Buckets y object storage.

Cada adaptador debe:

1. Tener una interfaz común.
2. Declarar sus capacidades.
3. Validar configuración.
4. Probar conectividad.
5. Manejar timeouts.
6. Manejar rate limits.
7. No registrar secretos.
8. Emitir evidencia.
9. Reportar errores entendibles.
10. Poder activarse o desactivarse.

Las integraciones cloud deben utilizar preferentemente:

* OIDC.
* Workload Identity.
* Roles temporales.
* Service accounts con permisos mínimos.
* Credenciales de corta duración.

Evitar claves permanentes.

---

# 11. Gestión de Git y versiones

Para cada proyecto y despliegue mostrar:

* Si es repositorio Git.
* Rama actual.
* Commit.
* Tag.
* Remote.
* Estado limpio o con cambios.
* Commit desplegado.
* Rama que originó el despliegue.
* Diferencias entre local, remoto y ambiente.
* Si la versión desplegada ya no coincide con el repositorio.
* Fecha del último pull.
* Fecha del último build.

Al levantar nuevamente un proyecto local:

1. Debe detectar los cambios actuales.
2. Debe reconstruir únicamente lo necesario.
3. Debe evitar ejecutar imágenes obsoletas.
4. Debe permitir un modo limpio con rebuild completo.
5. Debe informar qué commit se está probando.
6. Debe informar la rama activa.
7. Debe preservar volúmenes cuando corresponda.
8. Debe permitir eliminar volúmenes solamente con confirmación explícita.

Crear acciones diferenciadas:

* `Start`
* `Restart`
* `Rebuild changed components`
* `Clean rebuild`
* `Pull and rebuild`
* `Stop`
* `View detected changes`

---

# 12. Documentación viva

La plataforma debe generar y mantener documentación actualizada por proyecto y ambiente.

La documentación debe incluir:

* Arquitectura.
* Componentes.
* Diagrama.
* Dependencias.
* Puertos.
* Variables requeridas.
* Secretos requeridos, sin mostrar valores.
* Comandos de ejecución.
* Build.
* Tests.
* Despliegue.
* Rollback.
* Migraciones.
* Backups.
* Restauración.
* Observabilidad.
* Seguridad.
* Incidentes.
* Troubleshooting.
* Integraciones externas.
* Costos aproximados.
* Limitaciones.

Generar documentación específica para:

* Ejecución local.
* Docker Compose.
* VPS.
* AWS.
* Google Cloud.
* Kubernetes, si aplica.

Para cada documento registrar:

* Commit de origen.
* Fecha de generación.
* Infraestructura verificada.
* Integraciones verificadas.
* Nivel de confianza.
* Secciones no verificadas.
* Documentación oficial consultada.
* Fecha de consulta.

No generar instrucciones genéricas desconectadas del proyecto.

Ejemplo:

```text
Generado desde commit: abc123
Infraestructura verificada: 2026-08-04
Nivel de confianza: 91 %
Pendiente de verificar: credenciales de AWS staging
```

---

# 13. Servicios de archivos e imágenes

Si un proyecto carga imágenes o archivos, detectar y documentar:

* Endpoints de carga.
* Tipos permitidos.
* Tamaño máximo.
* Ubicación de almacenamiento.
* Bucket.
* Proveedor.
* Región.
* CDN.
* CORS.
* URLs firmadas.
* Políticas públicas y privadas.
* Antivirus o análisis antimalware.
* Cifrado.
* Versionado.
* Lifecycle.
* Retención.
* Backups.
* Eliminación.
* Datos huérfanos.

Emitir una alerta crítica si se detecta almacenamiento persistente dentro del filesystem efímero de un contenedor.

Soportar configuraciones para:

* S3.
* Google Cloud Storage.
* MinIO.
* Filesystem persistente en VPS.

---

# 14. Emails y notificaciones

Si un proyecto envía emails o notificaciones, registrar:

* Proveedor.
* SMTP o API.
* Remitentes.
* Dominios.
* Templates.
* Colas.
* Reintentos.
* Dead-letter queue.
* Webhooks.
* Bounce handling.
* Límites.
* Entregabilidad.
* SPF.
* DKIM.
* DMARC.
* Alertas.
* Métricas.
* Credenciales referenciadas.
* Fecha de rotación.

Para local debe soportarse una herramienta como Mailpit o equivalente, si es compatible con el stack existente.

No enviar correos reales desde pruebas locales o automatizadas sin configuración explícita.

---

# 15. Observabilidad obligatoria

Cada proyecto debe declarar o implementar:

* Métricas.
* Logs estructurados.
* Trazas.
* Correlation ID.
* Health checks.
* Readiness.
* Liveness.
* Alertas.
* Dashboards.
* SLO.
* Monitoreo de dependencias.

Utilizar OpenTelemetry cuando sea compatible y razonable.

Integrar, cuando corresponda:

* Prometheus.
* Grafana.
* Loki.
* Tempo.
* OpenTelemetry Collector.
* Exporters.
* Herramientas equivalentes ya existentes.

La plataforma debe mostrar:

* Latencia p50, p95 y p99.
* Requests por segundo.
* Tasa de errores.
* Disponibilidad.
* Saturación.
* CPU.
* Memoria.
* Disco.
* Conexiones.
* Pool de base de datos.
* Errores externos.
* Colas.
* Retries.
* Timeouts.

Todos los dashboards y enlaces deben verificarse.

No considerar finalizada la integración si el enlace existe pero el dashboard no recibe datos.

---

# 16. Calidad y testing

Por proyecto, detectar y gestionar:

* Tests unitarios.
* Tests de integración.
* Tests end-to-end.
* Contract tests.
* Cobertura.
* Lint.
* SonarQube.
* Complejidad.
* Duplicación.
* Deuda técnica.
* Dependencias desactualizadas.

Crear botones o jobs para:

* Ejecutar build.
* Ejecutar tests unitarios.
* Ejecutar integración.
* Ejecutar E2E.
* Ejecutar cobertura.
* Ejecutar SonarQube.
* Ejecutar smoke tests.

Cada ejecución debe guardar:

* Proyecto.
* Ambiente.
* Commit.
* Rama.
* Comando o job autorizado.
* Parámetros.
* Inicio.
* Fin.
* Usuario.
* Resultado.
* Logs.
* Evidencias.
* Métricas.
* Artefactos.

---

# 17. Pruebas de performance

Agregar soporte para:

* Smoke test.
* Load test.
* Stress test.
* Spike test.
* Soak test.
* Breakpoint test.
* Failover test.
* Chaos test controlado.

Permitir herramientas como k6, JMeter, Gatling u otra compatible.

Cada prueba debe definir:

* Ambiente objetivo.
* URL.
* Escenario.
* Usuarios virtuales.
* Ramp-up.
* Duración.
* Requests máximos.
* Thresholds.
* Datos de prueba.
* Operaciones excluidas.
* Kill switch.
* Condiciones de detención.

Resultados mínimos:

* Throughput.
* p50.
* p90.
* p95.
* p99.
* Error rate.
* Timeouts.
* CPU.
* Memoria.
* Saturación.
* Base de datos.
* Comparación con ejecuciones anteriores.

Los thresholds deben poder bloquear un despliegue.

Ejemplo:

```text
p95 < 300 ms
error_rate < 1 %
availability >= 99 %
```

---

# 18. Guardrails de performance y caos

No permitir pruebas de carga o estrés mediante comandos arbitrarios.

Implementar:

* Catálogo cerrado de pruebas.
* Parámetros validados.
* Límites máximos.
* Timeouts.
* Rate limits.
* Kill switch.
* Presupuesto máximo.
* Permisos por ambiente.
* Aprobaciones.
* Auditoría.

En producción:

* Stress test bloqueado por defecto.
* Chaos test bloqueado por defecto.
* DAST activo bloqueado por defecto.
* Pruebas destructivas bloqueadas.
* Requerir aprobación adicional.
* Requerir reautenticación.
* Requerir ventana autorizada.

---

# 19. Seguridad dentro de cada proyecto

Implementar o integrar controles para:

* SAST.
* SCA.
* DAST.
* Secret scanning.
* Container scanning.
* IaC scanning.
* SBOM.
* Licencias.
* Firmas de artefactos.
* Provenance.
* Configuración cloud.
* Runtime security.
* TLS.
* Headers.
* CORS.
* Autenticación.
* Autorización.
* Rate limiting.
* Auditoría.
* Protección contra bots.
* Gestión de sesiones.
* Gestión de secretos.

Herramientas posibles, según compatibilidad:

* SonarQube.
* Semgrep.
* Gitleaks.
* Trivy.
* OWASP Dependency-Check.
* OWASP ZAP.
* CycloneDX.
* Syft.
* Grype.
* Cosign.
* Falco.

No incorporar todas obligatoriamente si generan duplicación. Elegir la combinación adecuada y justificarla.

---

# 20. Riesgos que debe detectar la plataforma

Como mínimo:

* Secretos expuestos.
* Variables inseguras.
* Buckets públicos.
* Bases de datos expuestas.
* Puertos administrativos públicos.
* Actuator o endpoints internos expuestos.
* Certificados vencidos.
* Dependencias vulnerables.
* Imágenes vulnerables.
* Contenedores privilegiados.
* Uso de root.
* CORS permisivo.
* Ausencia de rate limiting.
* Autenticación débil.
* Falta de MFA.
* Roles excesivos.
* Tokens sin expiración.
* Logs con datos sensibles.
* Backups inexistentes.
* Backups no probados.
* Imágenes sin firma.
* Artefactos sin SBOM.
* Drift de infraestructura.
* Rama o commit desconocido en producción.
* Falta de rollback.
* Falta de health checks.
* Falta de observabilidad.
* Configuración distinta entre ambientes.

Clasificar hallazgos:

* Critical.
* High.
* Medium.
* Low.
* Informational.

Cada hallazgo debe incluir:

* Descripción.
* Evidencia.
* Recurso afectado.
* Ambiente.
* Impacto.
* Probabilidad.
* Recomendación.
* Estado.
* Responsable.
* Fecha límite.
* Excepción aprobada.
* Fecha de vencimiento de la excepción.

---

# 21. Seguridad de la propia plataforma

Esta plataforma tiene acceso sensible. Implementar defensa en profundidad.

## Autenticación

* SSO cuando esté disponible.
* MFA.
* Passkeys o WebAuthn como opción preferente.
* Sesiones de corta duración.
* Reautenticación para acciones críticas.
* Protección contra session fixation.
* Cookies seguras.
* Rotación de tokens.
* Revocación.

## Autorización

Implementar RBAC y, si corresponde, ABAC.

Roles mínimos:

* Viewer.
* Developer.
* Operator.
* Production Operator.
* Security.
* Approver.
* Administrator.

Los permisos deben restringirse por:

* Proyecto.
* Ambiente.
* Acción.
* Tipo de recurso.
* Criticidad.

## Ejecución segura

Todos los jobs deben correr en:

* Workers aislados.
* Contenedores efímeros.
* Usuario no root.
* Filesystem de solo lectura cuando sea posible.
* Sin modo privilegiado.
* CPU limitada.
* Memoria limitada.
* Timeout.
* Red restringida.
* Imágenes confiables.
* Parámetros validados.

No permitir una terminal web genérica para ejecutar comandos sobre los proyectos.

## SSRF

Implementar:

* Allowlist de destinos.
* Validación de URLs.
* Bloqueo de metadata cloud.
* Validación de DNS.
* Restricción de redes privadas.
* Proxy de egreso cuando corresponda.
* Timeouts.
* Límites de respuesta.

## Auditoría

Registrar de forma inmutable:

* Login.
* Logout.
* Accesos fallidos.
* Cambios de permisos.
* Lectura de recursos críticos.
* Ejecución de jobs.
* Despliegues.
* Rollbacks.
* Rotación de secretos.
* Aprobaciones.
* Cambios de configuración.
* Excepciones de seguridad.

---

# 22. Despliegues

Implementar una sección de despliegues con:

* Proyecto.
* Ambiente.
* Versión.
* Commit.
* Rama.
* Tag.
* Imagen.
* Digest.
* Autor.
* Pipeline.
* Estado.
* Duración.
* Artefactos.
* Evidencia.
* Smoke test.
* Fecha.
* Rollback disponible.

Acciones:

* Validar configuración.
* Generar plan.
* Construir.
* Publicar artefacto.
* Desplegar.
* Verificar.
* Hacer rollback.

Separar siempre:

```text
Plan
Apply
Verify
Rollback
```

No ejecutar cambios cloud destructivos sin mostrar previamente el plan.

Las migraciones de base de datos deben:

* Estar versionadas.
* Tener compatibilidad hacia atrás cuando sea posible.
* Ejecutarse de forma controlada.
* Tener estrategia de recuperación.
* No depender de cambios manuales no documentados.

---

# 23. Backups y recuperación

Por proyecto y ambiente registrar:

* Tipo de backup.
* Proveedor.
* Frecuencia.
* Retención.
* Cifrado.
* Último backup.
* Resultado.
* RPO.
* RTO.
* Última restauración probada.

Agregar acciones:

* Validar configuración.
* Ejecutar backup.
* Probar restauración en ambiente aislado.
* Ver evidencia.
* Ver historial.

No considerar un backup como confiable si nunca fue restaurado exitosamente.

---

# 24. Interfaz de usuario

Crear una interfaz profesional, clara y responsive.

Secciones mínimas por proyecto:

1. Overview.
2. Components.
3. Environments.
4. Topology.
5. Deployments.
6. Observability.
7. Logs.
8. Traces.
9. Alerts.
10. Quality.
11. Security.
12. Performance.
13. Infrastructure.
14. Dependencies.
15. Storage and Files.
16. Email and Notifications.
17. Backups.
18. Documentation.
19. Runbooks.
20. Costs.
21. Audit.
22. Settings.

La página principal debe mostrar:

* Estado general por proyecto.
* Ambiente.
* Riesgos críticos.
* Despliegues fallidos.
* Certificados próximos a vencer.
* Backups fallidos.
* Alertas.
* Vulnerabilidades críticas.
* Drift.
* Agentes desconectados.

No saturar la interfaz con información técnica sin jerarquía.

Usar:

* Estados claros.
* Badges.
* Tooltips.
* Filtros.
* Búsquedas.
* Vistas resumidas.
* Drill-down.
* Mensajes de error accionables.
* Fechas de última actualización.
* Indicadores de datos no verificados.

---

# 25. Score de madurez

Calcular un score explicable por proyecto y ambiente.

Categorías:

* Availability.
* Observability.
* Security.
* Performance.
* Quality.
* Backups.
* Documentation.
* Supply Chain.
* Configuration.
* Deployment Readiness.

Nunca mostrar solamente el número.

Debe indicarse:

* Cómo se calculó.
* Qué controles aprobaron.
* Qué controles fallaron.
* Qué acciones mejorarían el score.
* Qué controles son obligatorios para producción.

---

# 26. Estrategia de implementación

No implementar todo en un único cambio.

Trabajar en fases incrementales.

## Fase 0 — Auditoría

Entregables:

* Arquitectura actual.
* Stack.
* Componentes.
* Riesgos.
* Funcionalidad existente.
* Gaps.
* Plan.
* ADR inicial.

## Fase 1 — Catálogo y estado local

Implementar:

* Proyectos.
* Componentes.
* Ambientes.
* Descriptor YAML.
* Git.
* Rama.
* Commit.
* Docker.
* Health checks.
* Estado local.

## Fase 2 — Observabilidad

Implementar:

* Métricas.
* Logs.
* Trazas.
* Dashboards.
* Alertas.
* Enlaces verificados.

## Fase 3 — Calidad y seguridad

Implementar:

* Tests.
* SonarQube.
* Dependencias.
* Secret scanning.
* Container scanning.
* Findings.

## Fase 4 — Cloud e infraestructura

Implementar:

* Adaptadores.
* Descubrimiento.
* Drift.
* AWS.
* GCP.
* VPS.
* Kubernetes si corresponde.

## Fase 5 — Jobs y pruebas

Implementar:

* Orquestador.
* Workers.
* Smoke.
* Load.
* Stress.
* DAST.
* Evidencias.
* Guardrails.

## Fase 6 — Despliegues

Implementar:

* Plan.
* Apply.
* Verify.
* Rollback.
* Aprobaciones.
* Auditoría.

## Fase 7 — Documentación viva

Implementar:

* Guías.
* Runbooks.
* Diagramas.
* Confianza.
* Historial.

Cada fase debe quedar funcional antes de continuar.

---

# 27. Flujo de trabajo obligatorio

Para cada fase:

1. Analizar.
2. Diseñar.
3. Identificar archivos a modificar.
4. Implementar.
5. Ejecutar build.
6. Ejecutar tests.
7. Ejecutar linters.
8. Ejecutar escaneos aplicables.
9. Levantar el sistema.
10. Verificar endpoints.
11. Verificar interfaz.
12. Documentar.
13. Registrar riesgos pendientes.
14. Actualizar el estado de implementación.

No avanzar ocultando errores.

Corregir la causa raíz, no solamente el síntoma.

---

# 28. Archivos de documentación requeridos

Crear o actualizar:

```text
README.md
AGENTS.md
docs/architecture/overview.md
docs/architecture/components.md
docs/architecture/security.md
docs/architecture/local-agent.md
docs/architecture/job-orchestrator.md
docs/environments/local.md
docs/environments/development.md
docs/environments/staging.md
docs/environments/production.md
docs/deployment/aws.md
docs/deployment/gcp.md
docs/deployment/vps.md
docs/security/threat-model.md
docs/security/access-control.md
docs/security/secrets-management.md
docs/operations/runbooks.md
docs/operations/backups.md
docs/operations/disaster-recovery.md
docs/observability/overview.md
docs/testing/performance.md
docs/testing/security.md
docs/adr/
```

Crear solamente los documentos que tengan contenido real y específico.

No llenar documentación con texto genérico.

---

# 29. Criterios de aceptación

Una funcionalidad no se considera terminada hasta que:

* Compila.
* Tiene tests.
* Funciona en ejecución real.
* No rompe funcionalidad existente.
* Tiene manejo de errores.
* Tiene autorización.
* Tiene auditoría.
* No expone secretos.
* Tiene documentación.
* Tiene evidencia verificable.
* Tiene estados de carga, vacío y error en la UI.
* Tiene criterios de rollback cuando aplica.

Para integraciones:

* Debe probarse conectividad.
* Debe mostrarse la última verificación.
* Debe diferenciarse configurada de verificada.
* Debe manejar credenciales ausentes.
* Debe manejar permisos insuficientes.
* Debe manejar timeouts y rate limits.

---

# 30. Resultado esperado al finalizar cada iteración

Presentar un informe con:

## Resumen

* Qué se implementó.
* Qué cambió.
* Qué quedó operativo.

## Archivos

* Archivos creados.
* Archivos modificados.
* Archivos eliminados.
* Razón de cada cambio.

## Verificación

* Build.
* Tests.
* Cobertura.
* Lint.
* Escaneos.
* Servicios levantados.
* URLs verificadas.

## Seguridad

* Riesgos corregidos.
* Riesgos pendientes.
* Secretos detectados.
* Permisos requeridos.

## Configuración

* Variables requeridas.
* Credenciales requeridas.
* Integraciones pendientes.
* Comandos de ejecución.

## Pendientes

* Bloqueos reales.
* Funciones no verificadas.
* Próxima fase recomendada.

No afirmar que algo quedó completo si no fue ejecutado y verificado.

---

# 31. Primera tarea

Comenzá realizando la Fase 0.

Inspeccioná el repositorio actual y entregá:

1. Arquitectura actual.
2. Stack tecnológico real.
3. Componentes existentes.
4. Flujo actual de ejecución.
5. Infraestructura existente.
6. Integraciones existentes.
7. Estado de observabilidad.
8. Estado de seguridad.
9. Estado de testing.
10. Estado de documentación.
11. Riesgos prioritarios.
12. Funcionalidades reutilizables.
13. Funcionalidades faltantes.
14. Propuesta de arquitectura.
15. Plan de implementación por fases.
16. Archivos que deberán modificarse.
17. Backlog priorizado.
18. Criterios de aceptación.

Después de completar y documentar la Fase 0, comenzá la Fase 1 únicamente si la arquitectura y el repositorio permiten hacerlo sin asumir información inexistente.

Priorizá una implementación segura, incremental, verificable y mantenible.
