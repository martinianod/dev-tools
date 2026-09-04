# Engineering Control Center UX

## Objetivo

La interfaz autenticada/local no se presenta como una landing de herramientas. Funciona como workspace operativo para responder rapido:

- que proyectos estan registrados;
- cuales estan saludables, en warning o criticos;
- que analisis falta ejecutar;
- que herramienta esta configurada;
- cual es la siguiente accion por proyecto.

Las herramientas quedan como implementacion: SonarQube, Prometheus, Grafana, Loki, Tempo y Alertmanager aparecen despues de la lectura operativa de proyectos, salud, riesgos y acciones.

## Superficies

### Workspace operativo

Primera pantalla de uso diario:

- header compacto con busqueda global, entorno y accion `Agregar proyecto`;
- resumen global de proyectos, warnings, criticos, analisis pendientes y servicios UP;
- catalogo filtrable por estado con tabs e indicadores visuales;
- inventario vertical de proyectos para escanear estado, stack, runtime local y metricas base;
- Action Center con notificaciones urgentes accionables, no un segundo listado de proyectos.

### Proyecto

Cada proyecto se trata como producto independiente con navegacion propia:

- Resumen
- Gestion de entorno
- Calidad y observabilidad
- Terminal
- Ejecuciones
- Configuracion

El detalle se abre como drawer lateral amplio para mantener foco en un solo proyecto sin tapar el contexto completo del dashboard. El resumen responde si esta saludable, si paso Quality Gate, cuando fue analizado y que conviene revisar primero.

### Local Run Engine

La pestaña `Gestion de entorno` permite operar el entorno local del proyecto sin salir del panel:

- `Start`
- `Restart`
- `Rebuild changed components`
- `Clean rebuild`
- `Pull and rebuild`
- `Stop`
- `View detected changes`

La UI muestra:

- estado local: apagado, iniciando, corriendo, obsoleto, error o degradado;
- evidencia de frescura: rama Git, commit, dirty state, fingerprint actual y ultimo deploy registrado;
- compose detectado;
- contenedores asociados al proyecto;
- puertos publicados;
- botones para abrir servicios en `localhost`.

`Start` es la accion primaria: refresca Git, calcula fingerprint y reconstruye/recrea cuando detecta cambios locales. Si un contenedor sigue corriendo pero el fingerprint actual ya no coincide con el ultimo deploy exitoso, el dashboard lo marca como `Runtime obsoleto` y lo eleva al Action Center. `Rebuild changed components`, `Clean rebuild` y `Pull and rebuild` cubren los modos diferenciados de Fase 11.

Cuando hay colisiones de puertos, el error debe nombrar el puerto, servicio y owner detectado. Si Docker no puede identificar el owner, se informa como proceso local externo.

### Onboarding

Agregar proyecto usa un checklist progresivo:

1. Seleccionar carpeta.
2. Detectar stack tecnologico.
3. Detectar Docker y servicios.
4. Detectar Git.
5. Validar SonarQube.
6. Validar links de GitHub/GitLab, branches, PRs/MRs, Jenkins, SonarQube y observabilidad.
6. Validar instrumentacion.
7. Detectar health.
8. Detectar metricas.
9. Detectar logs/trazas.
10. Mostrar brechas.
11. Aplicar configuraciones disponibles.
12. Ejecutar primera validacion.

## Estados

Estados operativos usados en UI:

- `Healthy`
- `Warning`
- `Critical`
- `Offline`
- `Not configured`
- `Running`
- `Analysis pending`
- `Unknown`

Cada estado tiene etiqueta textual, color semantico, indicador visual y explicacion. La UI no depende solo del color.

Los fallos de ejecucion no reemplazan indefinidamente la salud del proyecto con `Analysis failed`. Se interpretan como:

- `Not configured` cuando falta token, host o setup ejecutable.
- `Warning` cuando fallo lint, tests o build.
- `Critical` cuando falla el Quality Gate o el doctor reporta errores bloqueantes.

## Componentes

Componentes del sistema visual:

- `ProjectCard`
- `HealthBadge`
- `MetricCard`
- `StatusIndicator`
- `EnvironmentSelector`
- `EmptyState`
- `CommandMenu`
- `IntegrationCard`
- `AlertCard`
- `RunAnalysisButton`
- `SetupChecklist`
- `RuntimeConfigForm`
- `JobDigest`
- `LocalRunEngine`
- `ResourceTable`
- `VisualDoctorChecklist`

## Configuracion por proyecto

La pestaña `Configuracion` incluye variables de ejecucion por proyecto:

- `SONAR_HOST_URL`
- `SONAR_TOKEN` redaccionado; queda en data local del hub y el API solo devuelve si esta configurado
- `SONAR_SCAN_SCOPE`
- `SONAR_SCANNER_MODE`
- `SONAR_JAVASCRIPT_NODE_MAXSPACE`
- `SONAR_SCANNER_JAVA_OPTS`
- `CI`
- variables adicionales permitidas por whitelist

El usuario no necesita exportar variables por consola para ejecutar desde el panel.

## Jobs y logs

El drawer de ejecucion muestra primero un resumen digerido:

- stage que fallo;
- errores y advertencias;
- reglas mas repetidas;
- categorias detectadas;
- primeros problemas relevantes.

El log completo queda colapsado para diagnostico profundo.

La pestaña `Terminal` del proyecto muestra logs del runtime local. No reemplaza una terminal del sistema: ofrece lectura, limpieza visual y descarga del log sanitizado para diagnostico rapido.

## Configuration Doctor

El doctor se presenta como checklist visual tipo semaforo:

- OK para configuracion lista.
- Warning para cobertura parcial o recomendacion.
- Critical para bloqueo operativo.

El objetivo es que el usuario vea el proximo bloqueo accionable sin leer texto plano largo.

## Principios

- Operacion primero, tecnologia despues.
- `Sin datos` no equivale a OK.
- Las acciones son contextuales: ejecutar analisis, configurar Sonar, revisar lint/tests/build o abrir calidad.
- No se mezclan comandos arbitrarios desde navegador.
- El dashboard propio consolida; SonarQube y Grafana siguen siendo fuentes profundas.
- Jenkins aparece como CI/CD local opcional. Para ejecutar pipelines por branch necesita jobs multibranch y un `Jenkinsfile` en cada repo. En local se usa scan/polling; para webhooks reales de GitHub se necesita exponer Jenkins con HTTPS o usar un tunnel seguro.
