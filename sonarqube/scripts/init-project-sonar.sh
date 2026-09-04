#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 /path/to/project project-key \"Project Name\""
}

project_root="${1:-}"
project_key="${2:-}"
project_name="${3:-}"

if [ -z "$project_root" ] || [ -z "$project_key" ] || [ -z "$project_name" ]; then
  usage
  exit 1
fi

if [ ! -d "$project_root" ]; then
  echo "ERROR: project path does not exist: $project_root"
  exit 1
fi

project_root="$(cd "$project_root" && pwd)"
mkdir -p "$project_root/scripts/quality" "$project_root/docs/quality"

join_by_comma() {
  local IFS=","
  echo "$*"
}

detected_sources=()
for candidate in src app apps packages backend frontend server client; do
  if [ -d "$project_root/$candidate" ]; then
    detected_sources+=("$candidate")
  fi
done

if [ ${#detected_sources[@]} -eq 0 ]; then
  while IFS= read -r nested_src; do
    detected_sources+=("${nested_src#$project_root/}")
  done < <(find "$project_root" \
    \( -path '*/node_modules' -o -path '*/dist' -o -path '*/build' -o -path '*/target' -o -path '*/coverage' -o -path '*/.next' -o -path '*/.gradle' \) -prune -o \
    -maxdepth 4 -type d -name src -print | sort)
fi

if [ ${#detected_sources[@]} -gt 0 ]; then
  sonar_sources="$(join_by_comma "${detected_sources[@]}")"
else
  sonar_sources="TODO"
fi

write_file() {
  local target="$1"
  local content="$2"

  if [ -f "$target" ]; then
    echo "$target already exists."
    printf "Overwrite? Type YES to continue: "
    read -r answer
    if [ "$answer" != "YES" ]; then
      echo "Skipped $target"
      return 0
    fi
  fi

  printf "%s" "$content" > "$target"
  echo "Wrote $target"
}

write_file "$project_root/sonar-project.properties" "sonar.projectKey=$project_key
sonar.projectName=$project_name
sonar.sourceEncoding=UTF-8

sonar.sources=$sonar_sources

sonar.test.inclusions=**/*.test.*,**/*.spec.*,**/tests/**,**/__tests__/**

sonar.exclusions=**/node_modules/**,**/dist/**,**/build/**,**/.gradle/**,**/.idea/**,**/.vscode/**,**/coverage/**,**/target/**,**/out/**,**/.next/**,**/ios/**,**/android/**,**/Pods/**,**/vendor/**,**/generated/**,**/.expo/**,**/.turbo/**,**/.cache/**,**/*.min.js,**/*.map,**/*.lock,**/package-lock.json,**/yarn.lock,**/pnpm-lock.yaml
sonar.coverage.exclusions=**/*.test.*,**/*.spec.*,**/tests/**,**/__tests__/**,**/generated/**,**/*.config.*,**/config/**
"

write_file "$project_root/scripts/quality/sonar-scan-local.sh" "#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=\"\$(cd \"\$(dirname \"\${BASH_SOURCE[0]}\")/../..\" && pwd)\"
cd \"\$ROOT_DIR\"

SONAR_HOST_URL=\"\${SONAR_HOST_URL:-http://localhost:9000}\"
SONAR_JAVASCRIPT_NODE_MAXSPACE=\"\${SONAR_JAVASCRIPT_NODE_MAXSPACE:-4096}\"
SONAR_SCANNER_OPTS=\"\${SONAR_SCANNER_OPTS:--Xmx2048m}\"

if [ -z \"\${SONAR_TOKEN:-}\" ]; then
  echo \"ERROR: SONAR_TOKEN is required.\"
  echo \"Create a token in SonarQube UI: My Account -> Security -> Generate Tokens.\"
  echo \"Then run: export SONAR_TOKEN=<token>\"
  exit 1
fi

export SONAR_TOKEN
export SONAR_SCANNER_OPTS

if ! command -v sonar-scanner >/dev/null 2>&1; then
  echo \"ERROR: sonar-scanner is not installed or not available in PATH.\"
  echo \"Install it locally, or run the Docker alternative documented in docs/quality/sonarqube-local.md.\"
  exit 1
fi

echo \"Running SonarQube analysis for \$(basename \"\$ROOT_DIR\")\"
echo \"SONAR_HOST_URL=\$SONAR_HOST_URL\"
echo \"SONAR_JAVASCRIPT_NODE_MAXSPACE=\$SONAR_JAVASCRIPT_NODE_MAXSPACE\"

sonar-scanner \
  -Dsonar.host.url=\"\$SONAR_HOST_URL\" \
  -Dsonar.javascript.node.maxspace=\"\$SONAR_JAVASCRIPT_NODE_MAXSPACE\"

echo \"Analysis submitted. Open: \$SONAR_HOST_URL\"
"

chmod +x "$project_root/scripts/quality/sonar-scan-local.sh"

write_file "$project_root/docs/quality/sonarqube-local.md" "# SonarQube local

Project key: \`$project_key\`

## Run

\`\`\`bash
cd /Users/martiniano/Documents/dev-tools/sonarqube
./scripts/up.sh

cd $project_root
export SONAR_HOST_URL=http://localhost:9000
export SONAR_TOKEN=<token>
./scripts/quality/sonar-scan-local.sh
\`\`\`

Review \`sonar-project.properties\` before the first scan. If \`sonar.sources=TODO\`, replace it with real productive source directories.
"

echo "Project SonarQube local files initialized for $project_root"
