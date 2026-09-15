#!/usr/bin/env bash
set -euo pipefail
set +x

sonar_url="http://sonarqube:9000"

if [ -z "${SONAR_ADMIN_PASSWORD:-}" ] \
  || [ "${SONAR_ADMIN_PASSWORD}" = "admin" ] \
  || [ "${#SONAR_ADMIN_PASSWORD}" -lt 12 ] \
  || [[ ! "${SONAR_ADMIN_PASSWORD}" =~ [A-Z] ]] \
  || [[ ! "${SONAR_ADMIN_PASSWORD}" =~ [a-z] ]] \
  || [[ ! "${SONAR_ADMIN_PASSWORD}" =~ [0-9] ]] \
  || [[ ! "${SONAR_ADMIN_PASSWORD}" =~ [^a-zA-Z0-9] ]]; then
  echo "SONAR_ADMIN_PASSWORD must be supplied externally and satisfy the SonarQube password policy." >&2
  exit 1
fi

for attempt in $(seq 1 90); do
  if curl --fail --silent --show-error --max-time 5 \
    "${sonar_url}/api/system/status" \
    | grep -q '"status":"UP"'; then
    break
  fi
  if [ "${attempt}" -eq 90 ]; then
    echo "SonarQube credential bootstrap timed out waiting for application readiness." >&2
    exit 1
  fi
  sleep 5
done

if curl --fail --silent --show-error --max-time 5 \
  --user admin:admin \
  "${sonar_url}/api/authentication/validate" \
  | grep -q '"valid":true'; then
  curl --fail --silent --show-error --max-time 10 \
    --user admin:admin \
    --request POST \
    --data-urlencode "login=admin" \
    --data-urlencode "previousPassword=admin" \
    --data-urlencode "password=${SONAR_ADMIN_PASSWORD}" \
    "${sonar_url}/api/users/change_password" \
    >/dev/null
  echo "SonarQube default administrator credential rotated."
else
  echo "SonarQube default administrator credential already disabled; preserving existing credentials."
fi

if curl --fail --silent --show-error --max-time 5 \
  --user admin:admin \
  "${sonar_url}/api/authentication/validate" \
  | grep -q '"valid":true'; then
  echo "SonarQube default administrator credential remains active." >&2
  exit 1
fi

if ! curl --fail --silent --show-error --max-time 5 \
  --user "admin:${SONAR_ADMIN_PASSWORD}" \
  "${sonar_url}/api/authentication/validate" \
  | grep -q '"valid":true'; then
  echo "SonarQube external administrator credential validation failed." >&2
  exit 1
fi

echo "SonarQube security bootstrap completed."
