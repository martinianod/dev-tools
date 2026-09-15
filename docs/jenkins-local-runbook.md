# Jenkins local runbook

## Objetivo

Jenkins complementa GitHub Actions con pipelines locales multibranch gestionados desde el Engineering Control Center. No reemplaza los checks remotos existentes; permite validar ramas locales/remotas, ejecutar stages completos y construir imagen Docker final cuando el pipeline termina OK.

## Levantar Jenkins

```bash
cd /Users/martiniano/Documents/dev-tools
docker compose --profile core --profile ci up -d --build jenkins
```

La primera construccion necesita acceso a Docker Hub para resolver `jenkins/jenkins` y descargar plugins. Si aparece `DeadlineExceeded` o `failed to resolve source metadata`, el problema esta antes de Jenkins: Docker Desktop no esta resolviendo/alcanzando el registry. Corregir DNS/proxy/red o precargar la imagen base antes de reintentar.

## Baseline de version y reproducibilidad

La imagen usa explicitamente Jenkins LTS `2.568.3` con Eclipse Temurin Java 21 (`jenkins/jenkins:2.568.3-lts-jdk21`). Esta LTS fue elegida porque es la linea estable vigente, incluye las correcciones de seguridad publicadas para Jenkins Core en septiembre de 2026 y satisface los requisitos minimos del conjunto actual de plugins. Jenkins `2.555.1` y posteriores requieren Java 21 o 25; este proyecto conserva Java 21 por ser una version LTS soportada y por mantener el cambio acotado al baseline del controller.

Referencias: [Jenkins LTS changelog](https://www.jenkins.io/changelog-stable/), [Java support policy](https://www.jenkins.io/doc/book/platform-information/support-policy-java/) y [security advisories](https://www.jenkins.io/security/advisories/).

`config/jenkins/plugins.txt` fija versiones exactas. Incluye los plugins funcionales directos, `authorize-project` requerido por `queueItemAuthenticator` en JCasC y pins transitivos de seguridad para evitar resolver revisiones vulnerables. El build usa Jenkins Plugin Installation Manager con `--latest=false`: las dependencias se resuelven desde esos artefactos exactos y sus minimos declarados, sin adoptar silenciosamente el ultimo plugin disponible.

Para actualizar el baseline:

1. Revisar la LTS y los advisories oficiales de Jenkins Core y plugins.
2. Resolver el archivo pinneado con Plugin Installation Manager contra el core candidato usando `--latest=false` y security warnings habilitados.
3. Actualizar core y plugins en el mismo cambio; no bajar plugins para forzar compatibilidad.
4. Construir la imagen, confirmar `java -version`, arrancar con un `JENKINS_HOME` de prueba y validar JCasC, health, logs y hardening antes de promoverla.

No reutilizar un volumen persistente como primera prueba de una actualizacion: validarla primero con un volumen aislado y conservar cualquier volumen anterior hasta completar el plan de rollback.

UI:

```text
http://localhost:18082
```

M0 no provee credenciales funcionales por defecto. Antes de activar el perfil, definir externamente:

```dotenv
JENKINS_ADMIN_ID=<identidad-local>
JENKINS_ADMIN_PASSWORD=<secreto-externo>
JENKINS_URL=http://localhost:18082/
```

## Jobs generados

La configuracion como codigo vive en:

```text
config/jenkins/casc.yaml
config/jenkins/plugins.txt
config/jenkins/seed/jobs.groovy
```

`jobs.groovy` crea un multibranch job por proyecto con remoto Git detectado:

- `chedoparti-react-app`
- `maria-belen-labarque-ceramic`
- `sistema-dietetica`
- `giftfinder-proyect`

`panorama-mercados` queda pendiente porque la carpeta local no es repositorio Git. Para habilitarlo: inicializar/asociar remoto Git conscientemente y agregar su remote a `config/jenkins/seed/jobs.groovy`.

Cada job escanea branches cada 5 minutos. Esto es intencional para entorno local: GitHub no puede llamar webhooks hacia `localhost` salvo que Jenkins este publicado con HTTPS o uses un tunnel seguro.

## Requisito por proyecto

Cada repositorio debe tener un `Jenkinsfile` en la raiz. Sin ese archivo, Jenkins puede detectar la branch pero no puede ejecutar pipeline.

Pipeline minimo recomendado por proyecto:

```groovy
pipeline {
  agent any
  options { timestamps() }
  stages {
    stage('Checkout') { steps { checkout scm } }
    stage('Quality') { steps { sh './scripts/quality/quality-check-local.sh || npm run check || true' } }
    stage('Sonar') { steps { sh './scripts/quality/sonar-scan-local.sh' } }
    // Docker image requiere un runner aislado posterior a M0.
  }
}
```

Ese ejemplo debe adaptarse al script real de cada repo; no debe commitearse sin validar stack, secretos y comandos disponibles.

## Docker

Desde M0, Jenkins corre non-root, no monta `/var/run/docker.sock`, no monta los proyectos host y no publica el puerto de agentes. Los pipelines que necesiten construir imagenes Docker quedan bloqueados hasta migrar a un runner aislado; no debe reintroducirse el socket como workaround.

`/tmp` es un tmpfs acotado a 1536 MiB. Jenkins Temporary Space Monitor permanece activo y requiere al menos 1 GiB libre para mantener online el Built-In Node; el limite anterior de 128 MiB lo dejaba offline aun con el volumen de Jenkins disponible. El tamaño del tmpfs es un maximo, no memoria reservada por adelantado. Si el nodo queda offline, comprobar `df -h /tmp` y el motivo en `/computer/api/json` antes de cambiar el monitor o aumentar recursos.

## Desde el dashboard

En cada proyecto:

1. Abrir `Resumen` o `Calidad y observabilidad`.
2. Revisar `Herramientas del proyecto`.
3. Abrir `Branches`, `Pull requests` y `Jenkins`.
4. Usar `Validar links`.

Si Jenkins falla, el panel debe mostrar:

- Jenkins no levantado.
- Job multibranch inexistente.
- Branch no escaneada.
- `Jenkinsfile` faltante.
- Autenticacion pendiente.
