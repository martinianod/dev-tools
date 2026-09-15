import assert from "node:assert/strict";
import test from "node:test";

const baseUrl = process.env.HUB_TEST_BASE_URL || "http://127.0.0.1:18080";
const authToken = process.env.HUB_TEST_AUTH_TOKEN || "";

async function fetchJson(path) {
  const response = await fetch(`${baseUrl}${path}`);
  assert.equal(response.status, 200, `${path} should return 200`);
  return response.json();
}

async function postJson(path, body = {}, expectedStatus = 200) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {})
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  assert.equal(response.status, expectedStatus, `${path} should return ${expectedStatus}: ${text}`);
  return data;
}

async function apiAvailable() {
  try {
    const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}

test("running hub API exposes project tool links, git, freshness and static UI", async (t) => {
  if (!(await apiAvailable())) {
    t.skip(`hub API is not running at ${baseUrl}`);
    return;
  }

  const projects = await fetchJson("/api/v1/projects");
  assert.equal(projects.total, 5);
  const chedoparti = projects.items.find((item) => item.slug === "chedoparti-react-app");
  assert.ok(chedoparti, "seed project exists");
  assert.equal(chedoparti.descriptor.status, "CONFIGURED_NOT_VERIFIED");
  assert.ok(chedoparti.components.declared.length >= 1);
  assert.ok(Array.isArray(chedoparti.components.detected));
  assert.equal(chedoparti.localState.descriptor.projectDeclared, true);
  assert.ok(chedoparti.localState.declared);
  assert.ok(chedoparti.localState.detected);
  assert.ok(chedoparti.localState.verified);
  assert.ok(chedoparti.toolLinks.some((link) => link.provider === "github" && link.label === "Branches"));
  assert.ok(chedoparti.toolLinks.some((link) => link.provider === "github" && link.label === "Pull requests"));
  assert.ok(chedoparti.toolLinks.some((link) => link.provider === "sonarqube"));
  assert.ok(chedoparti.toolLinks.some((link) => link.provider === "jenkins"));

  const descriptor = await fetchJson("/api/v1/catalog/descriptor");
  assert.equal(descriptor.status, "CONFIGURED_AND_VERIFIED");
  assert.equal(descriptor.descriptor.projects.length, 5);
  assert.ok(descriptor.path.endsWith("config/project-catalog.yaml"));

  const localState = await fetchJson("/api/v1/projects/chedoparti-react-app/local-state");
  assert.equal(localState.project, "chedoparti-react-app");
  assert.equal(localState.localState.descriptor.projectDeclared, true);
  assert.ok(localState.localState.declared.components.length >= 1);
  assert.ok(Array.isArray(localState.localState.detected.components));

  const git = await fetchJson("/api/v1/projects/chedoparti-react-app/git");
  assert.equal(typeof git.git.isGit, "boolean");
  if (git.git.isGit) assert.ok(git.git.commit);

  const freshness = await fetchJson("/api/v1/projects/chedoparti-react-app/freshness");
  assert.ok(freshness.sourceFingerprint?.value?.startsWith("sha256:"));

  const links = await fetchJson("/api/v1/projects/chedoparti-react-app/links");
  assert.ok(links.items.some((link) => link.group === "ci" && link.provider === "jenkins"));

  const platform = await fetchJson("/api/v1/platform/status");
  const requiredServices = platform.services.filter((service) => service.required !== false).map((service) => service.name).sort();
  assert.deepEqual(requiredServices, ["control-api", "web"]);
  assert.ok(platform.services.some((service) => service.name === "sonarqube" && service.required === false && service.profile === "quality"));
  assert.ok(platform.services.some((service) => service.name === "prometheus" && service.required === false && service.profile === "metrics"));

  const securitySession = await fetchJson("/api/v1/security/session");
  assert.match(securitySession.authentication, /^(CONFIGURED|READ_ONLY)$/);
  assert.match(securitySession.privilegedExecution, /^(ENABLED_LOCAL|DISABLED)$/);

  const agents = await fetchJson("/api/v1/agents/overview");
  assert.equal(agents.policy.phase, "Fase 9");
  assert.equal(agents.policy.secretValues, "resolved_only_at_execution_boundary_never_returned");
  assert.equal(agents.policy.arbitraryCommands, "blocked");
  assert.equal(agents.counts.agents, 1);
  const localAgent = agents.agents[0];
  assert.ok(localAgent);
  assert.equal(localAgent.name, "Control API Local Agent");
  assert.equal(localAgent.type, "embedded");
  assert.match(localAgent.status, /^(CONNECTED|DISCONNECTED)$/);
  assert.equal(localAgent.connected, localAgent.status === "CONNECTED");
  assert.ok(localAgent.capabilities.includes("git_status"));

  const heartbeat = await postJson("/api/v1/agents/heartbeat", { evidence: "test heartbeat" }, 200);
  assert.equal(heartbeat.heartbeat.status, "CONNECTED");
  assert.equal(heartbeat.agent.connected, true);
  const agentsAfterHeartbeat = await fetchJson("/api/v1/agents/overview");
  assert.equal(agentsAfterHeartbeat.agents[0].status, "CONNECTED");
  assert.equal(agentsAfterHeartbeat.agents[0].connected, true);

  const agentDiscovery = await postJson("/api/v1/agents/discovery/refresh", {}, 200);
  assert.match(agentDiscovery.snapshot.sourceHash, /^sha256:/);
  assert.equal(agentDiscovery.snapshot.projectCount, 5);
  const agentProject = agentDiscovery.snapshot.projects.find((project) => project.projectSlug === "chedoparti-react-app");
  assert.ok(agentProject);
  assert.ok(Array.isArray(agentProject.git.tags));
  assert.ok(Array.isArray(agentProject.processes));
  assert.ok(Array.isArray(agentProject.publishedPorts));
  assert.ok(Array.isArray(agentProject.localServices));
  assert.ok(agentDiscovery.snapshot.projects.every((project) => Array.isArray(project.requiredVariables)));
  assert.doesNotMatch(JSON.stringify(agentDiscovery), /sqp_[A-Za-z0-9]+/);
  assert.doesNotMatch(JSON.stringify(agentDiscovery), /\bSONAR_TOKEN\s*=\s*[^,\s"']+/);

  const platformObservability = await fetchJson("/api/v1/observability/overview");
  assert.equal(platformObservability.environment, "local");
  assert.ok(platformObservability.services.some((service) => service.name === "prometheus"));
  assert.ok(platformObservability.dashboards.some((dashboard) => dashboard.name === "Project Observability"));

  const projectObservability = await fetchJson("/api/v1/projects/chedoparti-react-app/observability/overview");
  assert.equal(projectObservability.projectSlug, "chedoparti-react-app");
  for (const signal of ["metrics", "logs", "traces", "alerts"]) {
    assert.ok(projectObservability[signal], `${signal} signal exists`);
    assert.match(projectObservability[signal].status, /^(CONFIGURED_AND_VERIFIED|CONFIGURED_NOT_VERIFIED|PARTIALLY_CONFIGURED|NOT_CONFIGURED|UNSUPPORTED|ERROR)$/);
  }
  assert.ok(projectObservability.dashboards.some((dashboard) => dashboard.name === "Project Observability"));
  assert.ok(projectObservability.metrics.links.some((link) => link.label.includes("Prometheus")));
  assert.ok(projectObservability.logs.links.some((link) => link.label.includes("Loki")));
  assert.ok(projectObservability.traces.links.some((link) => link.label.includes("Tempo")));

  const platformQualitySecurity = await fetchJson("/api/v1/quality-security/overview");
  assert.equal(platformQualitySecurity.environment, "local");
  assert.ok(platformQualitySecurity.projects.some((item) => item.projectSlug === "chedoparti-react-app"));
  assert.ok(platformQualitySecurity.scannerPolicy.secretValues === "redacted");

  const projectQualitySecurity = await fetchJson("/api/v1/projects/chedoparti-react-app/quality-security/overview");
  assert.equal(projectQualitySecurity.projectSlug, "chedoparti-react-app");
  for (const signal of ["tests", "sonarqube", "dependencies", "secretScanning", "containerScanning"]) {
    assert.ok(projectQualitySecurity[signal], `${signal} signal exists`);
    assert.match(projectQualitySecurity[signal].status, /^(CONFIGURED_AND_VERIFIED|CONFIGURED_NOT_VERIFIED|PARTIALLY_CONFIGURED|NOT_CONFIGURED|ERROR)$/);
  }
  assert.ok(projectQualitySecurity.dependencies.manifests.length >= 1);
  assert.equal(typeof projectQualitySecurity.secretScanning.scannedFiles, "number");
  assert.ok(Array.isArray(projectQualitySecurity.findings));
  assert.doesNotMatch(JSON.stringify(projectQualitySecurity), /sqp_[A-Za-z0-9]+/);
  assert.doesNotMatch(JSON.stringify(projectQualitySecurity), /gh[pousr]_[A-Za-z0-9_]+/);

  const platformInfrastructure = await fetchJson("/api/v1/infrastructure/overview");
  assert.equal(platformInfrastructure.environment, "local");
  assert.ok(platformInfrastructure.projects.some((item) => item.projectSlug === "chedoparti-react-app"));
  assert.equal(platformInfrastructure.adapterPolicy.liveCloudCalls, "disabled");
  assert.equal(platformInfrastructure.adapterPolicy.phase, "Fase 10");
  assert.equal(platformInfrastructure.adapterPolicy.adapterInterfaceVersion, "infrastructure-adapter.v1");
  assert.equal(platformInfrastructure.adapterPolicy.cache, "enabled");
  const phase10Adapters = [
    "local",
    "docker",
    "docker-compose",
    "terraform",
    "opentofu",
    "aws",
    "cloudformation",
    "gcp",
    "azure",
    "vps",
    "kubernetes",
    "github",
    "gitlab",
    "harness",
    "jenkins",
    "sonarqube",
    "grafana",
    "prometheus",
    "loki",
    "tempo",
    "opentelemetry",
    "registry",
    "object-storage",
    "smtp"
  ];
  for (const adapterName of phase10Adapters) {
    const adapter = platformInfrastructure.adapterRegistry.find((item) => item.name === adapterName);
    assert.ok(adapter, `${adapterName} adapter is registered`);
    assert.equal(adapter.interfaceVersion, "infrastructure-adapter.v1");
    assert.ok(Array.isArray(adapter.capabilities));
    assert.equal(typeof adapter.timeoutMs, "number");
    assert.equal(typeof adapter.rateLimit.maxRequests, "number");
    assert.equal(adapter.secretPolicy.valuesReturned, false);
    assert.ok(adapter.validationContract);
    assert.ok(adapter.connectivityContract);
    assert.ok(adapter.activation);
  }
  assert.equal(platformInfrastructure.cache.ttlSeconds > 0, true);

  const platformInfrastructureAdapters = await fetchJson("/api/v1/infrastructure/adapters");
  assert.equal(platformInfrastructureAdapters.policy.liveCloudCalls, "disabled");
  assert.ok(platformInfrastructureAdapters.adapters.every((adapter) => Array.isArray(adapter.capabilities)));
  assert.ok(platformInfrastructureAdapters.adapters.some((adapter) => adapter.name === "aws" && adapter.credentialRefs.includes("AWS_PROFILE")));
  assert.ok(platformInfrastructureAdapters.adapters.some((adapter) => adapter.name === "azure" && adapter.future === true));
  assert.ok(platformInfrastructureAdapters.adapters.some((adapter) => adapter.name === "object-storage" && adapter.credentialRefs.includes("MINIO_ENDPOINT")));
  assert.ok(platformInfrastructureAdapters.projects.some((item) => item.projectSlug === "chedoparti-react-app"));

  const projectInfrastructure = await fetchJson("/api/v1/projects/chedoparti-react-app/infrastructure/overview");
  assert.equal(projectInfrastructure.projectSlug, "chedoparti-react-app");
  for (const adapter of phase10Adapters) {
    assert.ok(projectInfrastructure.adapters[adapter], `${adapter} adapter exists`);
    assert.match(projectInfrastructure.adapters[adapter].status, /^(CONFIGURED_AND_VERIFIED|CONFIGURED_NOT_VERIFIED|PARTIALLY_CONFIGURED|NOT_CONFIGURED|ERROR)$/);
    assert.ok(Array.isArray(projectInfrastructure.adapters[adapter].capabilities));
    assert.equal(typeof projectInfrastructure.adapters[adapter].timeoutMs, "number");
    assert.ok(projectInfrastructure.adapters[adapter].validation, `${adapter} validation exists`);
    assert.ok(projectInfrastructure.adapters[adapter].connectivity, `${adapter} connectivity exists`);
    assert.equal(projectInfrastructure.adapters[adapter].secretPolicy.valuesReturned, false);
    assert.ok(Array.isArray(projectInfrastructure.adapters[adapter].evidence));
    assert.ok(Array.isArray(projectInfrastructure.adapters[adapter].errors));
  }
  assert.ok(projectInfrastructure.adapters.github.resourceCount >= 1);
  assert.ok(projectInfrastructure.adapters.docker.resourceCount >= 1);
  assert.ok(projectInfrastructure.adapters["docker-compose"].resourceCount >= 1);
  assert.ok(projectInfrastructure.discoveryCache);
  assert.match(projectInfrastructure.discoveryCache.sourceHash, /^sha256:/);
  assert.ok(Array.isArray(projectInfrastructure.resources));
  assert.ok(projectInfrastructure.counts.resources >= 1);
  assert.ok(projectInfrastructure.drift);

  const projectInfrastructureAdapters = await fetchJson("/api/v1/projects/chedoparti-react-app/infrastructure/adapters");
  assert.equal(projectInfrastructureAdapters.projectSlug, "chedoparti-react-app");
  assert.equal(projectInfrastructureAdapters.policy.refreshAudit, "infrastructure.discovery.refresh");
  assert.ok(projectInfrastructureAdapters.adapters.some((adapter) => adapter.name === "local" && adapter.liveCalls === "local-only"));
  assert.ok(projectInfrastructureAdapters.adapters.some((adapter) => adapter.name === "docker-compose" && adapter.validation));

  const platformVersions = await fetchJson("/api/v1/versions/overview");
  assert.equal(platformVersions.phase, "Fase 11");
  assert.equal(platformVersions.contract, "git-version-management.v1");
  assert.equal(platformVersions.guardrails.volumeDeletion, "requires_explicit_confirmation");
  assert.ok(platformVersions.projects.some((item) => item.projectSlug === "chedoparti-react-app"));
  assert.ok(platformVersions.actions.some((action) => action.id === "rebuild-changed-all"));
  assert.ok(platformVersions.actions.some((action) => action.id === "clean-rebuild-all"));
  assert.ok(platformVersions.actions.some((action) => action.id === "pull-rebuild-all"));

  const projectVersions = await fetchJson("/api/v1/projects/chedoparti-react-app/versions/overview");
  assert.equal(projectVersions.projectSlug, "chedoparti-react-app");
  assert.equal(projectVersions.phase, "Fase 11");
  assert.equal(projectVersions.contract, "git-version-management.v1");
  assert.equal(typeof projectVersions.repository.isGit, "boolean");
  assert.ok(projectVersions.current);
  assert.ok(projectVersions.remote);
  assert.ok(projectVersions.deployed);
  assert.ok(projectVersions.differences.localVsRemote);
  assert.ok(projectVersions.differences.localVsEnvironment);
  assert.ok(projectVersions.changes);
  assert.equal(projectVersions.runtime.volumePolicy.default, "preserve");
  for (const actionName of ["start", "restart", "rebuild-changed", "clean-rebuild", "pull-rebuild", "stop", "view-changes"]) {
    assert.ok(projectVersions.actions.some((action) => action.id === actionName), `${actionName} action exists`);
  }
  assert.doesNotMatch(JSON.stringify(projectVersions), /gh[pousr]_[A-Za-z0-9_]+/);

  const projectChanges = await fetchJson("/api/v1/projects/chedoparti-react-app/runtime/changes");
  assert.equal(projectChanges.phase, "Fase 11");
  assert.equal(projectChanges.contract, "git-version-management.v1");
  assert.ok(projectChanges.changes);
  assert.ok(projectChanges.differences.localVsEnvironment);

  const volumeDeleteStatus = securitySession.privilegedExecution === "DISABLED" ? 503 : 409;
  const blockedVolumeDelete = await postJson("/api/v1/projects/chedoparti-react-app/runtime/volumes/delete", {}, volumeDeleteStatus);
  assert.equal(blockedVolumeDelete.title, securitySession.privilegedExecution === "DISABLED" ? "PRIVILEGED_EXECUTION_DISABLED" : "VOLUME_DELETE_CONFIRMATION_REQUIRED");

  const refreshedInfrastructure = await postJson("/api/v1/projects/chedoparti-react-app/infrastructure/refresh", { adapter: "local" }, 200);
  assert.equal(refreshedInfrastructure.projectSlug, "chedoparti-react-app");
  assert.equal(refreshedInfrastructure.policy.liveCloudCalls, "disabled");
  assert.match(refreshedInfrastructure.discoveryCache.sourceHash, /^sha256:/);
  assert.equal(refreshedInfrastructure.adapters.length, 1);
  assert.equal(refreshedInfrastructure.adapters[0].name, "local");

  const refreshedComposeInfrastructure = await postJson("/api/v1/projects/chedoparti-react-app/infrastructure/refresh", { adapter: "docker-compose" }, 200);
  assert.equal(refreshedComposeInfrastructure.adapters.length, 1);
  assert.equal(refreshedComposeInfrastructure.adapters[0].name, "docker-compose");
  assert.ok(refreshedComposeInfrastructure.adapters[0].connectivity);

  const platformDeployments = await fetchJson("/api/v1/deployments/overview");
  assert.equal(platformDeployments.environment, "local");
  assert.equal(platformDeployments.guardrails.production.defaultMode, "read-only");
  assert.equal(platformDeployments.guardrails.production.apply, "blocked");
  assert.equal(platformDeployments.guardrails.arbitraryCommands, "blocked");
  assert.ok(platformDeployments.projects.some((item) => item.projectSlug === "chedoparti-react-app"));

  const projectDeployments = await fetchJson("/api/v1/projects/chedoparti-react-app/deployments/overview");
  assert.equal(projectDeployments.projectSlug, "chedoparti-react-app");
  assert.equal(projectDeployments.guardrails.local.apply, "requires_approval");
  assert.ok(Array.isArray(projectDeployments.environments));
  assert.ok(projectDeployments.environments.some((environment) => environment.name === "local"));
  assert.ok(Array.isArray(projectDeployments.plans));
  assert.ok(Array.isArray(projectDeployments.records));
  assert.ok(Array.isArray(projectDeployments.approvals));
  assert.ok(Array.isArray(projectDeployments.audit));
  assert.ok(Array.isArray(projectDeployments.findings));

  const platformDocs = await fetchJson("/api/v1/docs/overview");
  assert.equal(platformDocs.environment, "local");
  assert.equal(platformDocs.phase, "Fase 12");
  assert.equal(platformDocs.contract, "living-documentation.v2");
  assert.equal(platformDocs.guardrails.source, "verified-local-state");
  assert.equal(platformDocs.guardrails.secretValues, "redacted");
  assert.equal(platformDocs.guardrails.genericInstructions, "blocked");
  assert.ok(platformDocs.counts.documents >= platformDocs.projects.length, "platform docs should expose generated docs per project");
  assert.ok(platformDocs.counts.requiredSections >= platformDocs.projects.length * 20, "platform docs should expose required section coverage");
  assert.ok(platformDocs.projects.some((item) => item.projectSlug === "chedoparti-react-app"));
  const phase7Doc = platformDocs.inventory.items.find((item) => item.path === "docs/phase-7-living-documentation.md");
  assert.equal(phase7Doc?.status, "CONFIGURED_AND_VERIFIED");
  const phase8Doc = platformDocs.inventory.items.find((item) => item.path === "docs/phase-8-discovery-cache.md");
  assert.equal(phase8Doc?.status, "CONFIGURED_AND_VERIFIED");
  const phase9Doc = platformDocs.inventory.items.find((item) => item.path === "docs/phase-9-local-agent.md");
  assert.equal(phase9Doc?.status, "CONFIGURED_AND_VERIFIED");
  const phase10Doc = platformDocs.inventory.items.find((item) => item.path === "docs/phase-10-infrastructure-discovery.md");
  assert.equal(phase10Doc?.status, "CONFIGURED_AND_VERIFIED");
  const phase11Doc = platformDocs.inventory.items.find((item) => item.path === "docs/phase-11-git-versions.md");
  assert.equal(phase11Doc?.status, "CONFIGURED_AND_VERIFIED");
  const phase12Doc = platformDocs.inventory.items.find((item) => item.path === "docs/phase-12-living-docs-v2.md");
  assert.equal(phase12Doc?.status, "CONFIGURED_AND_VERIFIED");

  const projectDocs = await fetchJson("/api/v1/projects/chedoparti-react-app/docs/overview");
  assert.equal(projectDocs.projectSlug, "chedoparti-react-app");
  assert.equal(projectDocs.phase, "Fase 12");
  assert.equal(projectDocs.contract, "living-documentation.v2");
  assert.equal(projectDocs.guardrails.exportPath, "docs/live");
  assert.equal(projectDocs.guardrails.officialDocs, "recorded_only_when_verified");
  assert.ok(projectDocs.confidence.score >= 0);
  assert.match(projectDocs.sourceHash, /^sha256:/);
  assert.ok(Array.isArray(projectDocs.requiredSections));
  assert.ok(projectDocs.requiredSections.length >= 22);
  for (const sectionId of ["architecture", "components", "diagram", "dependencies", "ports", "required-variables", "required-secrets", "run-commands", "build", "tests", "deployment", "rollback", "migrations", "backups", "restore", "observability", "security", "incidents", "troubleshooting", "external-integrations", "approximate-costs", "limitations"]) {
    assert.ok(projectDocs.requiredSections.some((section) => section.id === sectionId), `${sectionId} required section exists`);
  }
  assert.ok(Array.isArray(projectDocs.documents));
  assert.ok(projectDocs.documents.length >= 6);
  for (const documentId of ["local-runtime", "docker-compose", "vps", "aws", "gcp", "kubernetes"]) {
    const document = projectDocs.documents.find((item) => item.id === documentId);
    assert.ok(document, `${documentId} document exists`);
    assert.equal(document.metadata.targetProvider, document.provider);
    assert.ok(Array.isArray(document.metadata.unverifiedSections));
    assert.ok(document.coveredSections.includes("architecture"));
    assert.ok(document.coveredSections.includes("security"));
  }
  assert.equal(projectDocs.officialDocs.status, "NOT_CONSULTED");
  assert.equal(projectDocs.officialDocs.consulted.length, 0);
  assert.ok(projectDocs.guides.some((guide) => guide.title.includes("onboarding")));
  assert.ok(projectDocs.runbooks.some((runbook) => runbook.title.includes("Runtime")));
  assert.ok(projectDocs.diagrams.some((diagram) => diagram.type === "mermaid"));
  assert.ok(Array.isArray(projectDocs.history.entries));
  assert.ok(projectDocs.markdown.includes("# Documentacion viva"));
  assert.ok(projectDocs.markdown.includes("Cobertura obligatoria Fase 12"));
  assert.ok(projectDocs.markdown.includes("Documentos por ambiente y proveedor"));
  assert.ok(projectDocs.markdown.includes("Documentacion oficial consultada"));
  assert.ok(projectDocs.markdown.includes("Costos aproximados"));
  assert.doesNotMatch(JSON.stringify(projectDocs), /sqp_[A-Za-z0-9]+/);
  assert.doesNotMatch(JSON.stringify(projectDocs), /\bSONAR_TOKEN\s*=\s*[^,\s"']+/);

  const projectDocDocuments = await fetchJson("/api/v1/projects/chedoparti-react-app/docs/documents");
  assert.equal(projectDocDocuments.project, "chedoparti-react-app");
  assert.equal(projectDocDocuments.phase, "Fase 12");
  assert.equal(projectDocDocuments.contract, "living-documentation.v2");
  assert.equal(projectDocDocuments.counts.documents, projectDocDocuments.documents.length);
  assert.ok(projectDocDocuments.requiredSections.some((section) => section.id === "troubleshooting"));
  assert.ok(projectDocDocuments.documents.some((doc) => doc.id === "local-runtime"));
  assert.equal(projectDocDocuments.officialDocs.status, "NOT_CONSULTED");

  const docsSnapshot = await postJson("/api/v1/projects/chedoparti-react-app/docs/snapshot", { export: false }, 201);
  assert.equal(docsSnapshot.snapshot.projectSlug, "chedoparti-react-app");
  assert.equal(docsSnapshot.snapshot.phase, "Fase 12");
  assert.equal(docsSnapshot.snapshot.contract, "living-documentation.v2");
  assert.equal(docsSnapshot.snapshot.sourceHash, docsSnapshot.report.sourceHash);
  assert.ok(docsSnapshot.snapshot.markdownHash.startsWith("sha256:"));
  assert.ok(docsSnapshot.snapshot.sourceHash.startsWith("sha256:"));
  assert.ok(docsSnapshot.snapshot.documents.length >= 6);
  assert.ok(docsSnapshot.snapshot.requiredSections.length >= 22);
  assert.equal(docsSnapshot.report.contract, "living-documentation.v2");
  assert.ok(docsSnapshot.report.documents.length >= 6);
  assert.equal(docsSnapshot.exportPath, "");
  const projectDocsAfterSnapshot = await fetchJson("/api/v1/projects/chedoparti-react-app/docs/overview");
  assert.equal(projectDocsAfterSnapshot.latestSnapshot.id, docsSnapshot.snapshot.id);
  if (projectDocsAfterSnapshot.latestSnapshot.sourceHash === projectDocsAfterSnapshot.sourceHash) {
    assert.ok(!projectDocsAfterSnapshot.findings.some((finding) => finding.code === "LIVING_DOCS_SNAPSHOT_STALE"));
  } else {
    assert.ok(projectDocsAfterSnapshot.findings.some((finding) => finding.code === "LIVING_DOCS_SNAPSHOT_STALE"));
  }

  const platformTesting = await fetchJson("/api/v1/testing/overview");
  assert.equal(platformTesting.environment, "local");
  assert.equal(platformTesting.guardrails.execution, "closed-catalog");
  assert.equal(platformTesting.guardrails.arbitraryCommands, "blocked");
  assert.ok(platformTesting.projects.some((item) => item.projectSlug === "chedoparti-react-app"));
  assert.ok(platformTesting.workerPool.id === "local-job-worker");

  const projectTesting = await fetchJson("/api/v1/projects/chedoparti-react-app/testing/overview");
  assert.equal(projectTesting.projectSlug, "chedoparti-react-app");
  assert.ok(projectTesting.workerPool);
  assert.equal(projectTesting.guardrails.dast.mode, "passive-read-only");
  assert.ok(projectTesting.counts.definitions >= 1);
  assert.ok(projectTesting.definitions.some((definition) => definition.mode === "approved-command" || definition.mode === "runtime-profile"));
  assert.ok(projectTesting.definitions.some((definition) => definition.type === "load"));
  assert.ok(projectTesting.definitions.some((definition) => definition.type === "dast"));
  const stressDefinition = projectTesting.definitions.find((definition) => definition.type === "stress");
  assert.ok(stressDefinition);
  assert.equal(stressDefinition.canRun, false);
  assert.equal(stressDefinition.guardrails.status, "BLOCKED");
  assert.ok(Array.isArray(projectTesting.executions));
  assert.ok(Array.isArray(projectTesting.findings));

  const improvements = await fetchJson("/api/v1/improvements");
  assert.equal(improvements.scope, "all");
  assert.equal(typeof improvements.promptMarkdown, "string");
  assert.ok(improvements.promptMarkdown.includes("Prompt maestro"));
  assert.ok(Array.isArray(improvements.items));
  assert.ok(improvements.counts);
  const serializedImprovements = JSON.stringify(improvements);
  assert.doesNotMatch(serializedImprovements, /sqp_[A-Za-z0-9]+/);
  assert.doesNotMatch(serializedImprovements, /\bSONAR_TOKEN\b/);
  assert.doesNotMatch(serializedImprovements, /password=/i);

  const appResponse = await fetch(`${baseUrl}/app.js`);
  assert.equal(appResponse.status, 200);
  const app = await appResponse.text();
  assert.match(app, /Herramientas del proyecto/);
  assert.match(app, /Validar links/);
  assert.match(app, /Jenkins/);
  assert.match(app, /loadImprovements/);
  assert.match(app, /Prompt maestro/);
  assert.match(app, /Estado local Fase 1/);
  assert.match(app, /Inventario de componentes/);
  assert.match(app, /loadProjectObservability/);
  assert.match(app, /Observabilidad verificada/);
  assert.match(app, /loadProjectQualitySecurity/);
  assert.match(app, /Calidad y seguridad verificada/);
  assert.match(app, /Secret scanning/);
  assert.match(app, /loadProjectInfrastructure/);
  assert.match(app, /Infraestructura y cloud/);
  assert.match(app, /Fase 10/);
  assert.match(app, /Refrescar discovery/);
  assert.match(app, /Discovery y cache/);
  assert.match(app, /runInfrastructureAction/);
  assert.match(app, /Drift y brechas/);
  assert.match(app, /loadProjectVersions/);
  assert.match(app, /Fase 11 · Git y versiones/);
  assert.match(app, /Rebuild changed components/);
  assert.match(app, /Clean rebuild/);
  assert.match(app, /Pull and rebuild/);
  assert.match(app, /View detected changes/);
  assert.match(app, /runVersionAction/);
  assert.match(app, /Fase 9/);
  assert.match(app, /Agente local/);
  assert.match(app, /runAgentAction/);
  assert.match(app, /Heartbeat del agente/);
  assert.match(app, /loadProjectDeployments/);
  assert.match(app, /Despliegues Fase 6/);
  assert.match(app, /Plan \/ Apply \/ Verify \/ Rollback/);
  assert.match(app, /Auditoria de despliegues/);
  assert.match(app, /runDeploymentAction/);
  assert.match(app, /loadProjectLivingDocs/);
  assert.match(app, /Fase 12 · Documentacion viva/);
  assert.match(app, /Metadata verificable/);
  assert.match(app, /Cobertura obligatoria/);
  assert.match(app, /Documentos por ambiente y proveedor/);
  assert.match(app, /Documentacion oficial consultada/);
  assert.match(app, /Crear snapshot/);
  assert.match(app, /Hash evidencia/);
  assert.match(app, /runLivingDocsAction/);
  assert.match(app, /loadProjectTesting/);
  assert.match(app, /Orquestador de pruebas/);
  assert.match(app, /Catalogo de pruebas/);
  assert.match(app, /startTestingExecution/);
});
