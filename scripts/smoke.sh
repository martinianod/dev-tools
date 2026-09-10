#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

npm run check

tmp_dir="$(mktemp -d)"
projects_root="${PROJECTS_ROOT:-$(dirname "$ROOT_DIR")}"
auth_token="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
cleanup() {
  if [ -n "${server_pid:-}" ]; then
    kill "$server_pid" >/dev/null 2>&1 || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

HUB_DATA_DIR="$tmp_dir/data" \
PROJECTS_ROOT="$projects_root" \
HUB_API_PORT=18180 \
HUB_AUTH_TOKEN="$auth_token" \
HUB_AUTH_ACTOR_ID="smoke-runner" \
HUB_AUTH_ROLE=ADMIN \
HUB_PRIVILEGED_EXECUTION_ENABLED=0 \
node apps/control-api/server.mjs >"$tmp_dir/server.log" 2>&1 &
server_pid=$!

ready=0
for _ in $(seq 1 120); do
  if curl -4 -fsS http://127.0.0.1:18180/healthz >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done

if [ "$ready" -ne 1 ]; then
  echo "API did not become ready. Last server log lines:"
  tail -n 80 "$tmp_dir/server.log" || true
  exit 1
fi

curl -4 -fsS http://127.0.0.1:18180/api/v1/projects >/dev/null
curl -4 -fsS http://127.0.0.1:18180/api/v1/catalog/descriptor >/dev/null
curl -4 -fsS http://127.0.0.1:18180/api/v1/projects/chedoparti-react-app/git >/dev/null
curl -4 -fsS http://127.0.0.1:18180/api/v1/projects/chedoparti-react-app/freshness >/dev/null
curl -4 -fsS http://127.0.0.1:18180/api/v1/projects/chedoparti-react-app/local-state >/dev/null
curl -4 -fsS http://127.0.0.1:18180/api/v1/projects/chedoparti-react-app/runtime-identity >/dev/null
curl -4 -fsS http://127.0.0.1:18180/api/v1/projects/chedoparti-react-app/links >/dev/null
curl -4 -fsS http://127.0.0.1:18180/api/v1/observability/overview >/dev/null
curl -4 -fsS http://127.0.0.1:18180/api/v1/projects/chedoparti-react-app/observability/overview >/dev/null
curl -4 -fsS http://127.0.0.1:18180/api/v1/agents/overview >/dev/null
curl -4 -fsS http://127.0.0.1:18180/api/v1/quality-security/overview >/dev/null
curl -4 -fsS http://127.0.0.1:18180/api/v1/projects/chedoparti-react-app/quality-security/overview >/dev/null
curl -4 -fsS http://127.0.0.1:18180/api/v1/infrastructure/overview >/dev/null
curl -4 -fsS http://127.0.0.1:18180/api/v1/infrastructure/adapters >/dev/null
curl -4 -fsS http://127.0.0.1:18180/api/v1/projects/chedoparti-react-app/infrastructure/overview >/dev/null
curl -4 -fsS http://127.0.0.1:18180/api/v1/projects/chedoparti-react-app/infrastructure/adapters >/dev/null
curl -4 -fsS http://127.0.0.1:18180/api/v1/versions/overview >/dev/null
curl -4 -fsS http://127.0.0.1:18180/api/v1/projects/chedoparti-react-app/versions/overview >/dev/null
curl -4 -fsS http://127.0.0.1:18180/api/v1/projects/chedoparti-react-app/runtime/changes >/dev/null
curl -4 -fsS http://127.0.0.1:18180/api/v1/deployments/overview >/dev/null
curl -4 -fsS http://127.0.0.1:18180/api/v1/projects/chedoparti-react-app/deployments/overview >/dev/null
curl -4 -fsS http://127.0.0.1:18180/api/v1/docs/overview >/dev/null
curl -4 -fsS http://127.0.0.1:18180/api/v1/projects/chedoparti-react-app/docs/overview >/dev/null
curl -4 -fsS http://127.0.0.1:18180/api/v1/projects/chedoparti-react-app/docs/documents >/dev/null
curl -4 -fsS http://127.0.0.1:18180/api/v1/testing/overview >/dev/null
curl -4 -fsS http://127.0.0.1:18180/api/v1/projects/chedoparti-react-app/testing/overview >/dev/null
curl -4 -fsS http://127.0.0.1:18180/api/v1/platform/status >/dev/null
curl -4 -fsS http://127.0.0.1:18180/metrics | grep -q "quality_hub_projects_total"

HUB_TEST_AUTH_TOKEN="$auth_token" node --input-type=module <<'NODE'
import assert from "node:assert/strict";

const baseUrl = "http://127.0.0.1:18180";
const authToken = process.env.HUB_TEST_AUTH_TOKEN;
async function postJson(path, body, expectedStatus) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
    body: JSON.stringify(body || {})
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  assert.equal(response.status, expectedStatus, `${path} should return ${expectedStatus}: ${text}`);
  return data;
}

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  assert.equal(response.status, 200, `${path} should return 200: ${text}`);
  return data;
}

const plan = await postJson("/api/v1/projects/chedoparti-react-app/deployments/plan", {
  environment: "local",
  strategy: "smart"
}, 201);
assert.match(plan.status, /^(READY|BLOCKED)$/);
assert.equal(plan.guardrails.arbitraryCommands, "blocked");

if (plan.status === "READY") {
  assert.equal(plan.approval.status, "PENDING");
  const decision = await postJson(`/api/v1/projects/chedoparti-react-app/deployments/plans/${plan.id}/approve`, {
    reason: "smoke approval"
  }, 200);
  assert.equal(decision.approval.status, "APPROVED");
}

const verification = await postJson("/api/v1/projects/chedoparti-react-app/deployments/verify", {}, 200);
assert.match(verification.status, /^(CONFIGURED_AND_VERIFIED|CONFIGURED_NOT_VERIFIED|PARTIALLY_CONFIGURED|ERROR)$/);

const rollback = await postJson("/api/v1/projects/chedoparti-react-app/deployments/rollback", {}, 503);
assert.equal(rollback.title, "PRIVILEGED_EXECUTION_DISABLED");

const agentHeartbeat = await postJson("/api/v1/agents/heartbeat", { evidence: "smoke heartbeat" }, 200);
assert.equal(agentHeartbeat.heartbeat.status, "CONNECTED");

const agentDiscovery = await postJson("/api/v1/agents/discovery/refresh", {}, 200);
assert.match(agentDiscovery.snapshot.sourceHash, /^sha256:/);
assert.equal(agentDiscovery.snapshot.projectCount, 5);

const infrastructureRefresh = await postJson("/api/v1/projects/chedoparti-react-app/infrastructure/refresh", { adapter: "local" }, 200);
assert.equal(infrastructureRefresh.projectSlug, "chedoparti-react-app");
assert.equal(infrastructureRefresh.policy.liveCloudCalls, "disabled");
assert.equal(infrastructureRefresh.policy.phase, "Fase 10");
assert.match(infrastructureRefresh.discoveryCache.sourceHash, /^sha256:/);

const adapters = await getJson("/api/v1/infrastructure/adapters");
for (const adapterName of ["docker", "docker-compose", "cloudformation", "azure", "harness", "opentelemetry", "object-storage"]) {
  const adapter = adapters.adapters.find((item) => item.name === adapterName);
  assert.ok(adapter, `${adapterName} adapter exists`);
  assert.equal(adapter.interfaceVersion, "infrastructure-adapter.v1");
  assert.equal(adapter.secretPolicy.valuesReturned, false);
}

const composeRefresh = await postJson("/api/v1/projects/chedoparti-react-app/infrastructure/refresh", { adapter: "docker-compose" }, 200);
assert.equal(composeRefresh.adapters.length, 1);
assert.equal(composeRefresh.adapters[0].name, "docker-compose");
assert.ok(composeRefresh.adapters[0].validation);
assert.ok(composeRefresh.adapters[0].connectivity);

const versions = await getJson("/api/v1/projects/chedoparti-react-app/versions/overview");
assert.equal(versions.phase, "Fase 11");
assert.equal(versions.contract, "git-version-management.v1");
assert.equal(versions.runtime.volumePolicy.default, "preserve");
for (const actionName of ["start", "restart", "rebuild-changed", "clean-rebuild", "pull-rebuild", "stop", "view-changes"]) {
  assert.ok(versions.actions.some((action) => action.id === actionName), `${actionName} action exists`);
}
const versionChanges = await getJson("/api/v1/projects/chedoparti-react-app/runtime/changes");
assert.equal(versionChanges.phase, "Fase 11");
assert.ok(versionChanges.differences.localVsRemote);
const blockedVolumeDelete = await postJson("/api/v1/projects/chedoparti-react-app/runtime/volumes/delete", {}, 503);
assert.equal(blockedVolumeDelete.title, "PRIVILEGED_EXECUTION_DISABLED");

const platformDocs = await getJson("/api/v1/docs/overview");
assert.equal(platformDocs.phase, "Fase 12");
assert.equal(platformDocs.contract, "living-documentation.v2");
assert.equal(platformDocs.guardrails.genericInstructions, "blocked");
assert.ok(platformDocs.counts.documents >= platformDocs.projects.length);
assert.ok(platformDocs.inventory.items.some((item) => item.path === "docs/phase-12-living-docs-v2.md" && item.status === "CONFIGURED_AND_VERIFIED"));

const projectDocs = await getJson("/api/v1/projects/chedoparti-react-app/docs/overview");
assert.equal(projectDocs.phase, "Fase 12");
assert.equal(projectDocs.contract, "living-documentation.v2");
assert.ok(projectDocs.requiredSections.some((section) => section.id === "architecture"));
assert.ok(projectDocs.requiredSections.some((section) => section.id === "required-secrets"));
assert.ok(projectDocs.requiredSections.some((section) => section.id === "approximate-costs"));
assert.ok(projectDocs.documents.some((document) => document.id === "local-runtime"));
assert.ok(projectDocs.documents.some((document) => document.id === "aws"));
assert.equal(projectDocs.officialDocs.status, "NOT_CONSULTED");
assert.match(projectDocs.markdown, /Cobertura obligatoria Fase 12/);
assert.match(projectDocs.markdown, /Documentos por ambiente y proveedor/);
assert.doesNotMatch(JSON.stringify(projectDocs), /sqp_[A-Za-z0-9]+/);
assert.doesNotMatch(JSON.stringify(projectDocs), /\bSONAR_TOKEN\s*=\s*[^,\s"']+/);

const projectDocDocuments = await getJson("/api/v1/projects/chedoparti-react-app/docs/documents");
assert.equal(projectDocDocuments.phase, "Fase 12");
assert.equal(projectDocDocuments.contract, "living-documentation.v2");
assert.equal(projectDocDocuments.counts.documents, projectDocDocuments.documents.length);
assert.ok(projectDocDocuments.documents.every((document) => Array.isArray(document.metadata.unverifiedSections)));

const docsSnapshot = await postJson("/api/v1/projects/chedoparti-react-app/docs/snapshot", { export: false }, 201);
assert.equal(docsSnapshot.snapshot.projectSlug, "chedoparti-react-app");
assert.equal(docsSnapshot.snapshot.phase, "Fase 12");
assert.equal(docsSnapshot.snapshot.contract, "living-documentation.v2");
assert.match(docsSnapshot.snapshot.markdownHash, /^sha256:/);
assert.ok(docsSnapshot.snapshot.documents.length >= 6);
assert.ok(docsSnapshot.snapshot.requiredSections.length >= 22);
assert.equal(docsSnapshot.report.contract, "living-documentation.v2");
assert.equal(docsSnapshot.exportPath, "");
NODE

HUB_TEST_BASE_URL=http://127.0.0.1:18180 HUB_TEST_AUTH_TOKEN="$auth_token" node --test tests/*.test.mjs

echo "Smoke test passed on http://127.0.0.1:18180"
