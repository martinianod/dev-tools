# Jenkins local runbook

## Objetivo

Jenkins complementa GitHub Actions con pipelines locales multibranch gestionados desde el Engineering Control Center. No reemplaza los checks remotos existentes; permite validar ramas locales/remotas, ejecutar stages completos y construir imagen Docker final cuando el pipeline termina OK.

## Levantar Jenkins

```bash
cd /Users/martiniano/Documents/dev-tools
docker compose --profile core --profile ci up -d --build jenkins
```

La primera construccion necesita acceso a Docker Hub para resolver `jenkins/jenkins` y descargar plugins. Si aparece `DeadlineExceeded` o `failed to resolve source metadata`, el problema esta antes de Jenkins: Docker Desktop no esta resolviendo/alcanzando el registry. Corregir DNS/proxy/red o precargar la imagen base antes de reintentar.

UI:

```text
http://localhost:18082
```

Credenciales default locales:

```text
admin / admin
```

Cambiar con `.env`:

```dotenv
JENKINS_ADMIN_ID=admin
JENKINS_ADMIN_PASSWORD=una-password-local
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
    stage('Docker image') { steps { sh 'docker compose build' } }
  }
}
```

Ese ejemplo debe adaptarse al script real de cada repo; no debe commitearse sin validar stack, secretos y comandos disponibles.

## Docker

El servicio Jenkins monta `/var/run/docker.sock` para construir imagenes Docker desde pipelines. Esto da permisos altos sobre Docker Desktop. Es aceptable solo para entorno local controlado y esta documentado como riesgo en `docs/security.md`.

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
