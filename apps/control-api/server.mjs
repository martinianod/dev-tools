import http from "node:http";
import net from "node:net";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROJECT_TRUST,
  applySecurityHeaders,
  assertProjectExecutionAllowed,
  authenticateRequest,
  authorizeRequest,
  createMutationRateLimiter,
  createSecurityConfig,
  evaluateCors,
  fetchAllowedUpstream,
  isSensitiveKey,
  normalizeProjectTrust,
  redactStructured,
  requiredRoleForRequest,
  validateUpstreamUrl
} from "./security.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const defaultProjectsRoot = path.dirname(repoRoot);

const host = process.env.HUB_API_HOST || "127.0.0.1";
const port = Number(process.env.HUB_API_PORT || 18080);
const projectsRoot = path.resolve(process.env.PROJECTS_ROOT || defaultProjectsRoot);
const hostProjectsRoot = path.resolve(process.env.HOST_PROJECTS_ROOT || process.env.PROJECTS_ROOT || defaultProjectsRoot);
const dataDir = path.resolve(process.env.HUB_DATA_DIR || path.join(repoRoot, "data"));
const stateFile = path.join(dataDir, "state.json");
const jobsDir = path.join(dataDir, "jobs");
const livingDocsExportDir = path.join(repoRoot, "docs", "live");
const catalogDescriptorFile = path.resolve(process.env.HUB_PROJECT_DESCRIPTOR || path.join(repoRoot, "config", "project-catalog.yaml"));
const maxConcurrentJobs = Number(process.env.MAX_CONCURRENT_JOBS || 1);
const jobTimeoutSeconds = Number(process.env.JOB_TIMEOUT_SECONDS || 1800);
const infrastructureDiscoveryCacheTtlMs = Number(process.env.INFRA_DISCOVERY_CACHE_TTL_MS || 300000);
const localAgentStartedAt = new Date().toISOString();
const localAgentHeartbeatTtlMs = Number(process.env.LOCAL_AGENT_HEARTBEAT_TTL_MS || 120000);
const localAgentId = slugify(process.env.HUB_LOCAL_AGENT_ID || `local-agent-${hashText(hostProjectsRoot).slice(0, 12)}`);
const localAgentVersion = process.env.HUB_LOCAL_AGENT_VERSION || "0.1.0";

const sonarHostUrl = stripTrailingSlash(process.env.SONAR_HOST_URL || "http://127.0.0.1:9000");
const prometheusUrl = stripTrailingSlash(process.env.PROMETHEUS_URL || "http://127.0.0.1:19090");
const lokiUrl = stripTrailingSlash(process.env.LOKI_URL || "http://127.0.0.1:13100");
const tempoUrl = stripTrailingSlash(process.env.TEMPO_URL || "http://127.0.0.1:13200");
const alertmanagerUrl = stripTrailingSlash(process.env.ALERTMANAGER_URL || "http://127.0.0.1:19093");
const grafanaUrl = stripTrailingSlash(process.env.GRAFANA_URL || "http://127.0.0.1:13000");
const jenkinsUrl = stripTrailingSlash(process.env.JENKINS_URL || "http://127.0.0.1:18082");
const jenkinsInternalUrl = stripTrailingSlash(process.env.JENKINS_INTERNAL_URL || "http://jenkins:8080");
const runtimeWaitHost = process.env.RUNTIME_WAIT_HOST || "host.docker.internal";
const securityConfig = createSecurityConfig({
  ...process.env,
  HUB_API_PORT: String(port),
  SONAR_HOST_URL: sonarHostUrl,
  PROMETHEUS_URL: prometheusUrl,
  LOKI_URL: lokiUrl,
  TEMPO_URL: tempoUrl,
  ALERTMANAGER_URL: alertmanagerUrl,
  GRAFANA_URL: grafanaUrl,
  JENKINS_URL: jenkinsUrl,
  JENKINS_INTERNAL_URL: jenkinsInternalUrl,
  HUB_ALLOWED_UPSTREAM_ORIGINS: [process.env.HUB_ALLOWED_UPSTREAM_ORIGINS, "http://web"].filter(Boolean).join(",")
});
const requestContext = new AsyncLocalStorage();
const checkMutationRateLimit = createMutationRateLimiter(securityConfig);

const allowedActions = new Set(["full", "doctor", "tests", "coverage", "lint", "build", "sonar", "health", "smoke", "load", "dast"]);
const allowedRuntimeActions = new Set(["start", "stop", "restart", "status", "logs", "smoke"]);
const phase11RuntimeActions = ["start", "restart", "rebuild-changed", "clean-rebuild", "pull-rebuild", "stop", "view-changes"];
const allowedRuntimeRequestActions = new Set(["start", "stop", "restart", "smoke", "start-fresh", "restart-fresh", "rebuild-changed", "clean-rebuild", "pull-rebuild"]);
const testingJobActions = new Set(["full", "doctor", "tests", "coverage", "lint", "build", "sonar", "health", "smoke", "load", "dast"]);
const internalTestingActions = new Set(["smoke", "load", "dast"]);
const localTestHostnames = new Set(["localhost", "127.0.0.1", "::1", "host.docker.internal"]);
const performanceGuardrails = {
  maxVirtualUsers: 5,
  maxDurationSeconds: 30,
  maxRequests: 120,
  perRequestTimeoutMs: 3000,
  defaultP95Ms: 1500,
  defaultErrorRate: 0.01
};
const deploymentStrategies = new Set(["smart", "rebuild", "restart"]);
const deploymentTerminalStatuses = new Set(["SUCCEEDED", "FAILED", "BLOCKED", "CANCELLED", "ROLLED_BACK"]);
const jobSubscribers = new Map();
const runningJobs = new Set();
const localRuntimeProcesses = new Map();
const localRuntimeBulkOperations = new Map();
const sourceFingerprintCache = new Map();
let state = null;
let writeChain = Promise.resolve();

const discoveryIgnoreNames = new Set([
  ".codex",
  ".docker-cache",
  ".git",
  ".gradle",
  ".gradle-cache",
  ".gradle-local",
  ".idea",
  ".m2",
  ".maven-cache",
  ".mvn-cache",
  ".next",
  ".next-e2e",
  ".npm",
  ".pnpm-store",
  ".scannerwork",
  ".turbo",
  ".vite",
  ".vscode",
  ".yarn",
  "Pods",
  "__pycache__",
  "bin",
  "build",
  "coverage",
  "dist",
  "generated",
  "node_modules",
  "out",
  "target",
  "vendor"
]);

const seedProjects = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "chedoparti-react-app",
    displayName: "Chedoparti React App",
    description: "Chedoparti platform: booking, backend, gateway and SaaS modules.",
    repositoryPath: "chedoparti-react-app",
    sonarProjectKey: "chedoparti-react-app",
    defaultBranch: "main",
    domain: "sports booking platform"
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    slug: "maria-belen-labarque-ceramic",
    displayName: "Maria Belen Labarque Ceramic",
    description: "DiTerra ceramic ecommerce and workshops platform.",
    repositoryPath: "maria-belen-labarque-ceramic",
    sonarProjectKey: "maria-belen-labarque-ceramic",
    defaultBranch: "main",
    domain: "ceramic ecommerce and workshops"
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    slug: "sistema-dietetica",
    displayName: "Sistema Dietetica",
    description: "Dietetica management system.",
    repositoryPath: "sistema_dietetica",
    sonarProjectKey: "sistema-dietetica",
    defaultBranch: "main",
    domain: "retail management"
  },
  {
    id: "44444444-4444-4444-8444-444444444444",
    slug: "giftfinder-proyect",
    displayName: "Giftfinder Proyect",
    description: "Giftfinder product and recommendation platform.",
    repositoryPath: "giftfinder-proyect",
    sonarProjectKey: "giftfinder-proyect",
    defaultBranch: "main",
    domain: "gift discovery"
  },
  {
    id: "55555555-5555-4555-8555-555555555555",
    slug: "panorama-mercados",
    displayName: "Panorama Mercados",
    description: "Market analysis and financial panorama project.",
    repositoryPath: "panorama-mercados",
    sonarProjectKey: "panorama-mercados",
    defaultBranch: "main",
    domain: "markets intelligence"
  }
];

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function nowIso() {
  return new Date().toISOString();
}

function correlationId() {
  return crypto.randomUUID();
}

function currentPrincipal() {
  return requestContext.getStore()?.principal || { actor: "system", role: "ADMIN", authenticated: true };
}

function currentActor() {
  return currentPrincipal().actor;
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function projectPublicPath(project) {
  return `/workspace/projects/${project.repositoryPath}`;
}

function runtimePublicPath(project) {
  return path.join(hostProjectsRoot, project.repositoryPath);
}

function defaultRuntimeConfig() {
  return {
    sonarHostUrl: "",
    sonarToken: "",
    jenkinsUrl: "",
    jenkinsJobName: "",
    sonarScanScope: "stable",
    sonarScannerMode: "cli",
    sonarJavascriptNodeMaxspace: "6144",
    sonarScannerJavaOpts: "-Xmx1024m",
    ci: "true",
    additionalEnv: []
  };
}

function normalizeRuntimeConfig(input = {}, current = defaultRuntimeConfig()) {
  const merged = { ...defaultRuntimeConfig(), ...(current || {}) };
  const next = { ...merged };
  const assignString = (key, maxLength = 500) => {
    if (input[key] === undefined) return;
    next[key] = sanitizeText(String(input[key] || "").trim()).slice(0, maxLength);
  };

  assignString("sonarHostUrl");
  assignString("jenkinsUrl");
  assignString("jenkinsJobName", 120);
  assignString("sonarScanScope", 40);
  assignString("sonarScannerMode", 20);
  assignString("sonarJavascriptNodeMaxspace", 20);
  assignString("sonarScannerJavaOpts", 80);
  assignString("ci", 10);

  if (input.sonarToken !== undefined && String(input.sonarToken || "").trim()) {
    throw problem(400, "SECRET_VALUE_NOT_ACCEPTED", "Secret values are not accepted in runtime configuration. Configure SONAR_TOKEN outside the API.");
  }
  // M0 removes the legacy persisted token. Secret values are resolved only from
  // the process environment at the execution boundary.
  next.sonarToken = "";

  if (next.sonarHostUrl) validateUpstreamUrl(next.sonarHostUrl, securityConfig);
  if (next.jenkinsUrl) validateUpstreamUrl(next.jenkinsUrl, securityConfig);

  if (!["stable", "backend", "frontend", "full", ""].includes(next.sonarScanScope)) {
    throw problem(400, "INVALID_RUNTIME_CONFIG", "sonarScanScope must be stable, backend, frontend or full.");
  }
  if (!["cli", "docker", ""].includes(next.sonarScannerMode)) {
    throw problem(400, "INVALID_RUNTIME_CONFIG", "sonarScannerMode must be cli or docker.");
  }
  if (!["true", "false", ""].includes(String(next.ci).toLowerCase())) {
    throw problem(400, "INVALID_RUNTIME_CONFIG", "ci must be true or false.");
  }
  next.ci = String(next.ci || "true").toLowerCase();

  if (input.additionalEnv !== undefined) {
    if (!Array.isArray(input.additionalEnv)) throw problem(400, "INVALID_RUNTIME_CONFIG", "additionalEnv must be an array.");
    next.additionalEnv = input.additionalEnv
      .map((item) => ({
        key: String(item?.key || "").trim().toUpperCase(),
        value: String(item?.value || "").trim()
      }))
      .filter((item) => item.key || item.value)
      .map((item) => {
        if (!isAllowedEnvKey(item.key) || isSensitiveKey(item.key) || looksLikeSecretValue(item.value)) {
          throw problem(400, "INVALID_ENV_KEY", `Environment variable '${item.key}' is not allowed.`);
        }
        const previous = (merged.additionalEnv || []).find((entry) => entry.key === item.key);
        const value = item.value === "[CONFIGURED]" && previous ? previous.value : item.value;
        return { key: item.key, value: sanitizeText(value).slice(0, 1000) };
      })
      .slice(0, 30);
  }

  return next;
}

function publicRuntimeConfig(project) {
  const runtimeConfig = { ...defaultRuntimeConfig(), ...(project.runtimeConfig || {}) };
  return {
    sonarHostUrl: runtimeConfig.sonarHostUrl || sonarHostUrl,
    sonarTokenConfigured: Boolean(process.env.SONAR_TOKEN),
    jenkinsUrl: runtimeConfig.jenkinsUrl || jenkinsUrl,
    jenkinsJobName: runtimeConfig.jenkinsJobName || "",
    sonarScanScope: runtimeConfig.sonarScanScope || "stable",
    sonarScannerMode: runtimeConfig.sonarScannerMode || "cli",
    sonarJavascriptNodeMaxspace: runtimeConfig.sonarJavascriptNodeMaxspace || "6144",
    sonarScannerJavaOpts: runtimeConfig.sonarScannerJavaOpts || "-Xmx1024m",
    ci: runtimeConfig.ci || "true",
    additionalEnv: (runtimeConfig.additionalEnv || []).map((item) => ({
      key: item.key,
      value: /^(VITE_|NEXT_PUBLIC_|PUBLIC_)/.test(item.key) ? item.value : "[CONFIGURED]"
    }))
  };
}

function looksLikeSecretValue(value) {
  const text = String(value || "");
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+\S+|:\/\/[^\s/:]+:[^\s/@]+@|\b(?:sqp_|gh[pousr]_|github_pat_|xox[baprs]-|sk_live_)[A-Za-z0-9_-]+/i.test(text);
}

function isAllowedEnvKey(key) {
  if (!/^[A-Z_][A-Z0-9_]{1,80}$/.test(key)) return false;
  if (isSensitiveKey(key)) return false;
  const blocked = new Set([
    "PATH",
    "HOME",
    "PWD",
    "OLDPWD",
    "SHELL",
    "USER",
    "TMPDIR",
    "HUB_POSTGRES_PASSWORD",
    "SONAR_POSTGRES_PASSWORD"
  ]);
  if (blocked.has(key)) return false;
  return (
    key === "CI" ||
    key === "NODE_ENV" ||
    key === "MAVEN_OPTS" ||
    key === "GRADLE_OPTS" ||
    key === "JAVA_TOOL_OPTIONS" ||
    key === "LOCAL_HOST" ||
    key.endsWith("_PORT") ||
    key.startsWith("APP_") ||
    key.startsWith("CORS_") ||
    key.startsWith("SONAR_") ||
    key.startsWith("VITE_") ||
    key.startsWith("NEXT_PUBLIC_") ||
    key.startsWith("PUBLIC_") ||
    ["BACKEND_URL", "FRONTEND_URL", "SCRAPER_URL", "OLLAMA_URL", "STRAPI_URL"].includes(key)
  );
}

function projectRuntimeEnv(project) {
  const runtimeConfig = { ...defaultRuntimeConfig(), ...(project.runtimeConfig || {}) };
  const env = {};
  for (const item of runtimeConfig.additionalEnv || []) {
    if (isAllowedEnvKey(item.key)) env[item.key] = item.value;
  }
  env.SONAR_HOST_URL = runtimeConfig.sonarHostUrl || sonarHostUrl;
  env.SONAR_TOKEN = process.env.SONAR_TOKEN || "";
  env.SONAR_SCAN_SCOPE = runtimeConfig.sonarScanScope || "stable";
  env.SONAR_SCANNER_MODE = runtimeConfig.sonarScannerMode || "cli";
  env.SONAR_SCANNER_DOCKER = runtimeConfig.sonarScannerMode === "docker" ? "1" : "0";
  env.SONAR_JAVASCRIPT_NODE_MAXSPACE = runtimeConfig.sonarJavascriptNodeMaxspace || "6144";
  env.SONAR_SCANNER_JAVA_OPTS = runtimeConfig.sonarScannerJavaOpts || "-Xmx1024m";
  env.CI = runtimeConfig.ci || process.env.CI || "true";
  return env;
}

function baseRuntimeAction(action) {
  if (action === "start-fresh") return "start";
  if (action === "restart-fresh") return "restart";
  if (action === "rebuild-changed") return "start";
  if (action === "clean-rebuild") return "start";
  if (action === "pull-rebuild") return "start";
  return action;
}

function actionForcesRuntimeBuild(action) {
  return action === "start-fresh" || action === "restart-fresh" || action === "clean-rebuild" || action === "pull-rebuild";
}

function sonarConnection(project) {
  const runtimeConfig = { ...defaultRuntimeConfig(), ...(project?.runtimeConfig || {}) };
  return {
    hostUrl: stripTrailingSlash(runtimeConfig.sonarHostUrl || sonarHostUrl),
    token: process.env.SONAR_TOKEN || ""
  };
}

async function loadCatalogDescriptor() {
  if (!fsSync.existsSync(catalogDescriptorFile)) {
    return {
      status: "NOT_CONFIGURED",
      path: catalogDescriptorFile,
      descriptor: { projects: [] },
      error: "Catalog descriptor file was not found."
    };
  }
  try {
    const text = await fs.readFile(catalogDescriptorFile, "utf8");
    const descriptor = normalizeCatalogDescriptor(parseCatalogDescriptorYaml(text));
    return {
      status: "CONFIGURED_AND_VERIFIED",
      path: catalogDescriptorFile,
      descriptor,
      generatedAt: nowIso()
    };
  } catch (error) {
    return {
      status: "ERROR",
      path: catalogDescriptorFile,
      descriptor: { projects: [] },
      error: sanitizeText(error.message)
    };
  }
}

function parseCatalogDescriptorYaml(text) {
  const descriptor = { projects: [] };
  let topSection = "";
  let currentProject = null;
  let projectSection = "";
  let currentNestedItem = null;

  for (const rawLine of String(text || "").split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
    const indent = rawLine.match(/^ */)?.[0].length || 0;
    const content = rawLine.trim();

    if (indent === 0) {
      currentProject = null;
      currentNestedItem = null;
      projectSection = "";
      if (content.endsWith(":")) {
        topSection = content.slice(0, -1).trim();
        if (topSection === "projects") descriptor.projects = [];
      } else {
        topSection = "";
        assignYamlProperty(descriptor, content);
      }
      continue;
    }

    if (topSection !== "projects") continue;

    if (indent === 2 && content.startsWith("- ")) {
      currentProject = {};
      currentNestedItem = null;
      projectSection = "";
      assignYamlProperty(currentProject, content.slice(2).trim());
      descriptor.projects.push(currentProject);
      continue;
    }

    if (!currentProject) continue;

    if (indent === 4) {
      currentNestedItem = null;
      if (content.endsWith(":")) {
        projectSection = content.slice(0, -1).trim();
        currentProject[projectSection] = [];
      } else {
        projectSection = "";
        assignYamlProperty(currentProject, content);
      }
      continue;
    }

    if (indent === 6 && content.startsWith("- ")) {
      if (!projectSection) continue;
      currentNestedItem = {};
      assignYamlProperty(currentNestedItem, content.slice(2).trim());
      if (!Array.isArray(currentProject[projectSection])) currentProject[projectSection] = [];
      currentProject[projectSection].push(currentNestedItem);
      continue;
    }

    if (indent === 8 && currentNestedItem) {
      assignYamlProperty(currentNestedItem, content);
    }
  }

  return descriptor;
}

function assignYamlProperty(target, line) {
  const index = line.indexOf(":");
  if (index < 0) return;
  const key = line.slice(0, index).trim();
  const rawValue = line.slice(index + 1).trim();
  if (!key) return;
  target[key] = parseYamlScalar(rawValue);
}

function parseYamlScalar(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const body = raw.slice(1, -1).trim();
    if (!body) return [];
    return body.split(",").map((item) => parseYamlScalar(item.trim()));
  }
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

function normalizeCatalogDescriptor(descriptor) {
  return {
    version: descriptor.version || 1,
    kind: sanitizeText(descriptor.kind || "quality-hub-project-catalog"),
    updatedAt: sanitizeText(descriptor.updatedAt || ""),
    owner: sanitizeText(descriptor.owner || ""),
    projects: (descriptor.projects || []).map(normalizeDescriptorProject).filter((project) => project.slug)
  };
}

function normalizeDescriptorProject(project) {
  const slug = slugify(project.slug || path.basename(String(project.repositoryPath || "")));
  return {
    id: sanitizeText(project.id || ""),
    slug,
    displayName: sanitizeText(project.displayName || slug),
    description: sanitizeText(project.description || ""),
    owner: sanitizeText(project.owner || ""),
    team: sanitizeText(project.team || ""),
    repositoryPath: sanitizeText(project.repositoryPath || slug),
    defaultBranch: sanitizeText(project.defaultBranch || "main"),
    sonarProjectKey: sanitizeText(project.sonarProjectKey || slug),
    criticality: sanitizeText(project.criticality || "medium"),
    status: sanitizeText(project.status || "ACTIVE"),
    trust: normalizeProjectTrust(project.trust || PROJECT_TRUST.UNTRUSTED),
    components: (project.components || []).map(normalizeDescriptorComponent).filter((component) => component.name),
    environments: (project.environments || []).map((environment) => normalizeDescriptorEnvironment(environment, slug)).filter((environment) => environment.name)
  };
}

function normalizeDescriptorComponent(component) {
  return {
    name: sanitizeText(component.name || ""),
    type: sanitizeText(component.type || "application"),
    path: sanitizeText(component.path || "."),
    runtime: sanitizeText(component.runtime || ""),
    source: "descriptor"
  };
}

function normalizeDescriptorEnvironment(environment, slug) {
  return {
    name: sanitizeText(environment.name || "local"),
    provider: sanitizeText(environment.provider || "local"),
    protected: Boolean(environment.protected),
    baseUrl: sanitizeText(environment.baseUrl || ""),
    healthUrl: sanitizeText(environment.healthUrl || ""),
    metricsUrl: sanitizeText(environment.metricsUrl || ""),
    source: "descriptor",
    labels: {
      project: slug,
      environment: sanitizeText(environment.name || "local")
    }
  };
}

function descriptorProjectFor(catalog, project) {
  const projects = catalog?.descriptor?.projects || [];
  return projects.find((item) => item.id && item.id === project.id)
    || projects.find((item) => item.slug === project.slug)
    || projects.find((item) => item.repositoryPath === project.repositoryPath)
    || null;
}

function descriptorSeeds(catalog) {
  if (catalog?.status !== "CONFIGURED_AND_VERIFIED") return seedProjects;
  const projects = catalog.descriptor.projects || [];
  if (!projects.length) return seedProjects;
  return projects.map((project) => ({
    id: project.id || crypto.randomUUID(),
    slug: project.slug,
    displayName: project.displayName,
    description: project.description,
    repositoryPath: project.repositoryPath,
    sonarProjectKey: project.sonarProjectKey,
    defaultBranch: project.defaultBranch,
    owner: project.owner,
    team: project.team,
    criticality: project.criticality,
    trust: project.trust,
    domain: project.team || project.owner || "local platform"
  }));
}

async function ensureDataStore() {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(jobsDir, { recursive: true });
  const catalog = await loadCatalogDescriptor();
  if (!fsSync.existsSync(stateFile)) {
    const seeded = {
      version: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      projects: [],
      environments: [],
      localRuntimes: {},
      linkValidations: {},
      jobs: [],
      qualitySnapshots: [],
      deploymentPlans: [],
      deploymentRecords: [],
      approvalRequests: [],
      livingDocsSnapshots: [],
      infrastructureDiscoverySnapshots: [],
      agents: [],
      agentHeartbeats: [],
      agentDiscoverySnapshots: [],
      auditEvents: []
    };

    for (const seed of descriptorSeeds(catalog)) {
      const discovered = await discoverRepository(seed.repositoryPath).catch((error) => ({
        exists: false,
        status: "MISCONFIGURED",
        detectedStack: ["unknown"],
        doctor: [{ level: "error", code: "DISCOVERY_FAILED", message: error.message }]
      }));
      seeded.projects.push({
        ...seed,
        detectedStack: discovered.detectedStack,
        runtimeConfig: defaultRuntimeConfig(),
        status: discovered.exists ? "ACTIVE" : "MISCONFIGURED",
        createdAt: nowIso(),
        updatedAt: nowIso()
      });
      seeded.environments.push(defaultLocalEnvironment(seed.id, seed.slug));
    }
    await fs.writeFile(stateFile, JSON.stringify(seeded, null, 2));
  }
  state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  let migrated = false;
  if (!state.localRuntimes || Array.isArray(state.localRuntimes)) {
    state.localRuntimes = {};
    migrated = true;
  }
  if (!state.linkValidations || Array.isArray(state.linkValidations)) {
    state.linkValidations = {};
    migrated = true;
  }
  if (!Array.isArray(state.deploymentPlans)) {
    state.deploymentPlans = [];
    migrated = true;
  }
  if (!Array.isArray(state.deploymentRecords)) {
    state.deploymentRecords = [];
    migrated = true;
  }
  if (!Array.isArray(state.approvalRequests)) {
    state.approvalRequests = [];
    migrated = true;
  }
  if (!Array.isArray(state.livingDocsSnapshots)) {
    state.livingDocsSnapshots = [];
    migrated = true;
  }
  if (!Array.isArray(state.infrastructureDiscoverySnapshots)) {
    state.infrastructureDiscoverySnapshots = [];
    migrated = true;
  }
  if (!Array.isArray(state.agents)) {
    state.agents = [];
    migrated = true;
  }
  if (!Array.isArray(state.agentHeartbeats)) {
    state.agentHeartbeats = [];
    migrated = true;
  }
  if (!Array.isArray(state.agentDiscoverySnapshots)) {
    state.agentDiscoverySnapshots = [];
    migrated = true;
  }
  if (ensureLocalAgentRecord()) migrated = true;
  for (const project of state.projects || []) {
    if (!project.trust) {
      const declared = descriptorProjectFor(catalog, project);
      project.trust = normalizeProjectTrust(declared?.trust || PROJECT_TRUST.UNTRUSTED);
      migrated = true;
    } else {
      project.trust = normalizeProjectTrust(project.trust);
    }
    if (!project.runtimeConfig) {
      project.runtimeConfig = defaultRuntimeConfig();
      migrated = true;
    } else {
      const previousRuntimeConfig = JSON.stringify(project.runtimeConfig);
      project.runtimeConfig = normalizeRuntimeConfig({}, project.runtimeConfig);
      if (previousRuntimeConfig !== JSON.stringify(project.runtimeConfig)) migrated = true;
    }
    if (!state.localRuntimes[project.id]) {
      state.localRuntimes[project.id] = defaultLocalRuntime(project.id, project.slug);
      migrated = true;
    }
  }
  if (migrated) await saveState();
  await refreshProjectStatuses();
}

function defaultLocalEnvironment(projectId, slug) {
  return {
    id: crypto.randomUUID(),
    projectId,
    name: "local",
    baseUrl: "",
    healthUrl: "",
    metricsUrl: "",
    lokiLabels: { project: slug, environment: "local" },
    tempoServiceName: slug,
    prometheusLabels: { project: slug, environment: "local" },
    enabled: true,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
}

function defaultLocalRuntime(projectId, slug) {
  return {
    projectId,
    projectSlug: slug,
    status: "unknown",
    action: null,
    composeFile: "",
    composeProject: "",
    error: "",
    git: null,
    sourceFingerprint: null,
    lastDeployment: null,
    freshness: {
      status: "unknown",
      checkedAt: null,
      message: "Todavia no se capturo fingerprint de fuentes para este runtime."
    },
    logs: [],
    updatedAt: nowIso()
  };
}

function localRuntimeStore(project) {
  if (!state.localRuntimes) state.localRuntimes = {};
  if (!state.localRuntimes[project.id]) {
    state.localRuntimes[project.id] = defaultLocalRuntime(project.id, project.slug);
  }
  const runtime = state.localRuntimes[project.id];
  runtime.git ??= null;
  runtime.sourceFingerprint ??= null;
  runtime.lastDeployment ??= null;
  runtime.freshness ??= {
    status: "unknown",
    checkedAt: null,
    message: "Todavia no se capturo fingerprint de fuentes para este runtime."
  };
  return runtime;
}

function addRuntimeLog(project, level, message) {
  const runtime = localRuntimeStore(project);
  runtime.logs.push({
    timestamp: nowIso(),
    level,
    message: sanitizeText(message).slice(0, 4000)
  });
  if (runtime.logs.length > 1500) runtime.logs = runtime.logs.slice(-1500);
  runtime.updatedAt = nowIso();
}

async function saveState() {
  state.updatedAt = nowIso();
  writeChain = writeChain.then(() => fs.writeFile(stateFile, JSON.stringify(state, null, 2)));
  await writeChain;
}

async function appendAudit(action, target, result, metadata = {}) {
  state.auditEvents.unshift({
    id: crypto.randomUUID(),
    actor: currentActor(),
    action,
    target,
    result,
    timestamp: nowIso(),
    correlationId: metadata.correlationId || correlationId(),
    metadata: sanitizeMetadata(metadata)
  });
  state.auditEvents = state.auditEvents.slice(0, 500);
  await saveState();
}

function sanitizeMetadata(value) {
  return redactStructured(value, sanitizeText);
}

function sanitizeText(input) {
  let output = String(input || "");
  const secrets = [
    securityConfig.authToken,
    process.env.SONAR_TOKEN,
    process.env.HUB_POSTGRES_PASSWORD,
    process.env.SONAR_POSTGRES_PASSWORD,
    ...(state?.projects || []).flatMap((project) => {
      const runtimeConfig = project.runtimeConfig || {};
      return [
        runtimeConfig.sonarToken,
        ...(runtimeConfig.additionalEnv || [])
          .filter((item) => isSensitiveKey(item.key || ""))
          .map((item) => item.value)
      ];
    })
  ].filter(Boolean);
  for (const secret of secrets) {
    output = output.split(secret).join("[REDACTED]");
  }
  output = output
    .replace(/sqp_[A-Za-z0-9]+/g, "[REDACTED_SONAR_TOKEN]")
    .replace(/(Authorization:?\s*Bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~-]+/gi, "$1[REDACTED]")
    .replace(/(Using generated security password:\s*)[^\s]+/gi, "$1[REDACTED]")
    .replace(/((?:JWT_SECRET|SIGNING_SECRET|WEBHOOK_SECRET|HMAC_SECRET|SPRING_DATASOURCE_PASSWORD|POSTGRES_PASSWORD|DB_PASSWORD)=)[^\s,]+/gi, "$1[REDACTED]")
    .replace(/(password|passwd|token|secret|api[_-]?key|credential)=([^&\s]+)/gi, "$1=[REDACTED]")
    .replace(/([?&](?:password|passwd|token|secret|api[_-]?key|credential)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/:\/\/([^\s/:]+):([^\s/@]+)@/g, "://$1:[REDACTED]@");
  if (projectsRoot) {
    output = output.split(projectsRoot).join("/workspace/projects");
  }
  if (hostProjectsRoot && hostProjectsRoot !== projectsRoot) {
    output = output.split(hostProjectsRoot).join("/workspace/projects");
  }
  return output;
}

async function canonicalProjectPath(repositoryPath) {
  if (!repositoryPath || path.isAbsolute(repositoryPath)) {
    throw problem(400, "INVALID_PROJECT_PATH", "repositoryPath must be relative to PROJECTS_ROOT.");
  }
  const rootReal = await fs.realpath(projectsRoot);
  const requested = path.resolve(rootReal, repositoryPath);
  if (!(requested === rootReal || requested.startsWith(`${rootReal}${path.sep}`))) {
    throw problem(400, "PATH_OUTSIDE_PROJECTS_ROOT", "Path escapes PROJECTS_ROOT.");
  }
  const real = await fs.realpath(requested);
  if (!(real === rootReal || real.startsWith(`${rootReal}${path.sep}`))) {
    throw problem(400, "SYMLINK_ESCAPE", "Resolved path escapes PROJECTS_ROOT.");
  }
  return real;
}

async function canonicalHostProjectPath(repositoryPath) {
  if (!repositoryPath || path.isAbsolute(repositoryPath)) {
    throw problem(400, "INVALID_PROJECT_PATH", "repositoryPath must be relative to HOST_PROJECTS_ROOT.");
  }
  const hostRootReal = await fs.realpath(hostProjectsRoot).catch(() => null);
  const root = hostRootReal || hostProjectsRoot;
  const requested = path.resolve(root, repositoryPath);
  if (!(requested === root || requested.startsWith(`${root}${path.sep}`))) {
    throw problem(400, "PATH_OUTSIDE_HOST_PROJECTS_ROOT", "Path escapes HOST_PROJECTS_ROOT.");
  }
  const real = await fs.realpath(requested).catch(() => requested);
  if (hostRootReal && !(real === hostRootReal || real.startsWith(`${hostRootReal}${path.sep}`))) {
    throw problem(400, "SYMLINK_ESCAPE", "Resolved host path escapes HOST_PROJECTS_ROOT.");
  }
  return real;
}

async function runtimeProjectPath(project, abs = null) {
  const authorized = abs || await canonicalProjectPath(project.repositoryPath);
  if (!hostProjectsRoot || hostProjectsRoot === projectsRoot) return authorized;
  const hostPath = await canonicalHostProjectPath(project.repositoryPath).catch(() => null);
  if (!hostPath || !fsSync.existsSync(hostPath)) return authorized;
  return hostPath;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function listRepositoryFiles(root, options = {}) {
  const maxDepth = options.maxDepth ?? 5;
  const matcher = options.matcher || (() => false);
  const ignoredNames = options.ignoredNames || discoveryIgnoreNames;
  const results = [];

  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".") && ![".env.example"].includes(entry.name) && entry.name !== ".git") {
        if (entry.isDirectory()) continue;
      }
      if (entry.isDirectory() && ignoredNames.has(entry.name)) continue;
      const absolutePath = path.join(dir, entry.name);
      const relativePath = path.relative(root, absolutePath);
      if (entry.isDirectory()) {
        await walk(absolutePath, depth + 1);
      } else if (matcher(entry.name, relativePath)) {
        results.push({ absolutePath, relativePath });
      }
    }
  }

  await walk(root, 0);
  return results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function relativeDir(relativeFile) {
  const dir = path.dirname(relativeFile);
  return dir === "." ? "." : dir;
}

function displayPath(relativeFile) {
  return relativeFile === "." ? "repo root" : relativeFile;
}

function detectPackageManager(abs, cwd) {
  const candidates = [path.join(abs, cwd), abs];
  for (const candidate of candidates) {
    if (fsSync.existsSync(path.join(candidate, "pnpm-lock.yaml"))) return "pnpm";
    if (fsSync.existsSync(path.join(candidate, "yarn.lock"))) return "yarn";
    if (fsSync.existsSync(path.join(candidate, "package-lock.json"))) return "npm";
  }
  return "npm";
}

function packageManagerCommand(manager, scriptName) {
  if (manager === "yarn") return { command: "yarn", args: [scriptName] };
  if (manager === "pnpm") return { command: "pnpm", args: ["run", scriptName] };
  return { command: "npm", args: ["run", scriptName] };
}

function addApprovedCommand(commands, command) {
  const key = `${command.action}|${command.command}|${command.args.join(" ")}|${command.cwd || "."}`;
  if (!commands.some((item) => `${item.action}|${item.command}|${item.args.join(" ")}|${item.cwd || "."}` === key)) {
    commands.push(command);
  }
}

function commandLabel(command) {
  const prefix = command.cwd && command.cwd !== "." ? `${command.cwd}: ` : "";
  return `${prefix}${command.command} ${command.args.join(" ")}`.trim();
}

function classifyScriptAction(scriptName) {
  const normalized = scriptName.toLowerCase();
  if (["lint", "lint:code", "check:security"].includes(normalized)) return "lint";
  if (normalized === "build" || normalized.startsWith("build:")) return "build";
  if (normalized.includes("coverage")) return "coverage";
  if (normalized === "test" || normalized.startsWith("test:") || normalized.endsWith(":test")) return "tests";
  return null;
}

function isLikelyNodeApp(packageJson) {
  const deps = { ...(packageJson?.dependencies || {}), ...(packageJson?.devDependencies || {}) };
  return Boolean(deps.next || deps.vite || deps.react || deps["@vitejs/plugin-react"] || deps.vitest || deps.jest);
}

function selectPackageScripts(scripts) {
  const names = Object.keys(scripts || {});
  const selected = [];
  const excluded = (scriptName) => {
    const lower = scriptName.toLowerCase();
    return lower.includes("watch") || lower.includes("headed") || lower.includes("visual") || lower.includes("smoke") || lower.includes("e2e");
  };
  const add = (scriptName) => {
    if (scriptName && scripts[scriptName] && !excluded(scriptName) && !selected.includes(scriptName)) {
      selected.push(scriptName);
    }
  };

  add("lint");
  add("build");
  add("test");

  const coverageCandidates = names.filter((scriptName) => scriptName.toLowerCase().includes("coverage") && !excluded(scriptName));
  const preferredCoverage = [
    "test:coverage:gate",
    "test:coverage",
    "coverage",
    "test:frontend:coverage",
    "test:backend:coverage",
    "test:unit:coverage",
    "test:backend:unit:coverage",
    "test:frontend:unit:coverage"
  ].find((scriptName) => coverageCandidates.includes(scriptName)) || coverageCandidates[0];
  add(preferredCoverage);

  if (!selected.includes("test")) {
    for (const scriptName of names) {
      const lower = scriptName.toLowerCase();
      if (excluded(scriptName) || lower.includes("coverage")) continue;
      if (lower.includes(":unit") || lower.endsWith(":test") || lower.includes("frontend") || lower.includes("backend")) add(scriptName);
      if (selected.filter((item) => classifyScriptAction(item) === "tests").length >= 2) break;
    }
  }

  return selected;
}

async function readRootComposeText(abs, names) {
  const composeName = ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"].find((name) => names.has(name));
  if (!composeName) return "";
  return fs.readFile(path.join(abs, composeName), "utf8").catch(() => "");
}

function dockerComposeBuildServiceForPackage(cwd, deps, composeText) {
  if (!composeText) return "";
  if (deps["@strapi/strapi"] && cwd !== "." && composeHasService(composeText, "strapi")) {
    return "strapi";
  }
  if (deps.next && cwd === "." && composeHasService(composeText, "frontend")) {
    return "frontend";
  }
  return "";
}

function composeHasService(composeText, serviceName) {
  const pattern = new RegExp(`^\\s{2}${escapeRegExp(serviceName)}:\\s*$`, "m");
  return pattern.test(composeText);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function detectCoverageArtifacts(abs) {
  const ignoredNames = new Set(discoveryIgnoreNames);
  ignoredNames.delete("build");
  ignoredNames.delete("coverage");
  ignoredNames.delete("target");
  const files = await listRepositoryFiles(abs, {
    maxDepth: 6,
    ignoredNames,
    matcher: (name, relativePath) => (
      name === "lcov.info" ||
      name === "jacoco.xml" ||
      relativePath.endsWith("jacocoTestReport.xml") ||
      relativePath.endsWith("site/jacoco/jacoco.xml") ||
      name === "coverage.xml"
    )
  });
  return files.map((file) => file.relativePath);
}

async function readSonarProjectKey(abs) {
  const propertiesPath = path.join(abs, "sonar-project.properties");
  const text = await fs.readFile(propertiesPath, "utf8").catch(() => "");
  const match = text.match(/^sonar\.projectKey\s*=\s*(.+)\s*$/m);
  return match ? match[1].trim() : null;
}

async function detectRepositoryComponents(abs, manifests) {
  const components = [];
  const add = (component) => {
    const normalized = {
      name: sanitizeText(component.name || ""),
      type: sanitizeText(component.type || "component"),
      path: sanitizeText(component.path || "."),
      language: sanitizeText(component.language || ""),
      source: sanitizeText(component.source || "discovery"),
      evidence: sanitizeText(component.evidence || component.path || "")
    };
    if (!normalized.name) return;
    const key = `${normalized.type}:${normalized.path}:${normalized.name}`;
    if (!components.some((item) => `${item.type}:${item.path}:${item.name}` === key)) components.push(normalized);
  };

  for (const file of manifests || []) {
    const relativePath = file.relativePath || String(file || "");
    const name = path.basename(relativePath);
    const cwd = relativeDir(relativePath);
    if (name === "package.json") {
      const packageJson = await readJsonIfExists(path.join(abs, relativePath));
      const deps = { ...(packageJson?.dependencies || {}), ...(packageJson?.devDependencies || {}) };
      const componentType = deps.next || deps.vite || deps["@vitejs/plugin-react"] ? "frontend" : "node-package";
      add({
        name: packageJson?.name || (cwd === "." ? path.basename(abs) : path.basename(cwd)),
        type: componentType,
        path: cwd,
        language: "javascript",
        evidence: relativePath
      });
      continue;
    }
    if (name === "pom.xml") {
      add({
        name: cwd === "." ? path.basename(abs) : path.basename(cwd),
        type: "maven-module",
        path: cwd,
        language: "java",
        evidence: relativePath
      });
      continue;
    }
    if (["build.gradle", "build.gradle.kts"].includes(name)) {
      add({
        name: cwd === "." ? path.basename(abs) : path.basename(cwd),
        type: "gradle-module",
        path: cwd,
        language: "java",
        evidence: relativePath
      });
      continue;
    }
    if (["pyproject.toml", "requirements.txt"].includes(name)) {
      add({
        name: cwd === "." ? path.basename(abs) : path.basename(cwd),
        type: "python-package",
        path: cwd,
        language: "python",
        evidence: relativePath
      });
      continue;
    }
    if (name === "pubspec.yaml") {
      add({
        name: cwd === "." ? path.basename(abs) : path.basename(cwd),
        type: "flutter-app",
        path: cwd,
        language: "dart",
        evidence: relativePath
      });
      continue;
    }
    if (name === "Dockerfile" || /^docker-compose[\w.-]*\.ya?ml$/i.test(name) || /^compose\.ya?ml$/i.test(name)) {
      add({
        name: cwd === "." ? "local-runtime" : `${path.basename(cwd)}-runtime`,
        type: name === "Dockerfile" ? "container-image" : "compose-runtime",
        path: cwd,
        source: "docker-discovery",
        evidence: relativePath
      });
      continue;
    }
    if (name === "Jenkinsfile") {
      add({
        name: cwd === "." ? "jenkins-pipeline" : `${path.basename(cwd)}-jenkins-pipeline`,
        type: "ci-pipeline",
        path: cwd,
        source: "ci-discovery",
        evidence: relativePath
      });
      continue;
    }
    if (name === "sonar-project.properties" || name.startsWith("sonar-project.")) {
      add({
        name: cwd === "." ? "sonarqube-config" : `${path.basename(cwd)}-sonarqube-config`,
        type: "quality-config",
        path: cwd,
        source: "quality-discovery",
        evidence: relativePath
      });
    }
  }

  return components.sort((a, b) => a.path.localeCompare(b.path) || a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
}

async function discoverRepository(repositoryPath) {
  const abs = await canonicalProjectPath(repositoryPath);
  const entries = await fs.readdir(abs, { withFileTypes: true });
  const names = new Set(entries.map((entry) => entry.name));
  const manifests = await listRepositoryFiles(abs, {
    maxDepth: 6,
    matcher: (name) => [
      "package.json",
      "pom.xml",
      "build.gradle",
      "build.gradle.kts",
      "gradlew",
      "pyproject.toml",
      "requirements.txt",
      "pubspec.yaml",
      "Dockerfile",
      "compose.yaml",
      "compose.yml",
      "docker-compose.yml",
      "docker-compose.yaml",
      "Jenkinsfile",
      "sonar-project.properties",
      "sonar-scan-local.sh"
    ].includes(name) || name.startsWith("sonar-project.") || /^docker-compose[\w.-]*\.ya?ml$/i.test(name)
  });
  const packageJsonFiles = manifests.filter((file) => path.basename(file.relativePath) === "package.json");
  const pomFiles = manifests.filter((file) => path.basename(file.relativePath) === "pom.xml");
  const gradleBuildFiles = manifests.filter((file) => ["build.gradle", "build.gradle.kts"].includes(path.basename(file.relativePath)));
  const gradlewFiles = manifests.filter((file) => path.basename(file.relativePath) === "gradlew");
  const pythonFiles = manifests.filter((file) => ["pyproject.toml", "requirements.txt"].includes(path.basename(file.relativePath)));
  const flutterFiles = manifests.filter((file) => path.basename(file.relativePath) === "pubspec.yaml");
  const dockerFiles = manifests.filter((file) => {
    const name = path.basename(file.relativePath);
    return ["Dockerfile", "compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"].includes(name) || /^docker-compose[\w.-]*\.ya?ml$/i.test(name);
  });
  const sonarScripts = manifests.filter((file) => path.basename(file.relativePath) === "sonar-scan-local.sh");
  const sonarProperties = manifests.filter((file) => path.basename(file.relativePath) === "sonar-project.properties" || path.basename(file.relativePath).startsWith("sonar-project."));
  const jenkinsFiles = manifests.filter((file) => path.basename(file.relativePath) === "Jenkinsfile");
  const rootPackageJson = await readJsonIfExists(path.join(abs, "package.json"));
  const rootComposeText = await readRootComposeText(abs, names);

  const detectedStack = new Set();
  const evidence = [];
  const approvedCommands = [];
  const instrumentation = {
    health: [],
    metrics: [],
    logs: [],
    traces: []
  };

  if (names.has(".git")) {
    detectedStack.add("git");
    evidence.push("git repository");
  }

  for (const packageFile of packageJsonFiles) {
    const packageJson = await readJsonIfExists(packageFile.absolutePath);
    if (!packageJson) continue;
    const cwd = relativeDir(packageFile.relativePath);
    const packageManager = detectPackageManager(abs, cwd);
    detectedStack.add("node");
    evidence.push(`${displayPath(packageFile.relativePath)} (${packageManager})`);
    if (packageJson?.dependencies?.next || packageJson?.devDependencies?.next || await pathExists(path.join(abs, cwd, "next.config.js")) || await pathExists(path.join(abs, cwd, "next.config.mjs"))) {
      detectedStack.add("nextjs");
    }
    if (await pathExists(path.join(abs, cwd, "vite.config.ts")) || await pathExists(path.join(abs, cwd, "vite.config.js")) || packageJson?.devDependencies?.vite) {
      detectedStack.add("vite");
    }

    const deps = { ...(packageJson.dependencies || {}), ...(packageJson.devDependencies || {}) };
    if (Object.keys(deps).some((dep) => dep.startsWith("@opentelemetry/"))) instrumentation.traces.push(`${displayPath(cwd)} has OpenTelemetry dependency`);
    if (deps["prom-client"] || deps["@opentelemetry/exporter-prometheus"]) instrumentation.metrics.push(`${displayPath(cwd)} has Prometheus metrics dependency`);
    if (deps.pino || deps.winston || deps.bunyan) instrumentation.logs.push(`${displayPath(cwd)} has structured logging dependency`);

    const scripts = packageJson?.scripts || {};
    const dockerBuildService = dockerComposeBuildServiceForPackage(cwd, deps, rootComposeText);
    if (scripts.build && dockerBuildService) {
      addApprovedCommand(approvedCommands, {
        action: "build",
        command: "docker",
        args: ["compose", "--env-file", "docker.env", "build", dockerBuildService],
        cwd: ".",
        label: `docker compose build ${dockerBuildService}`,
        source: packageFile.relativePath
      });
    }
    const scriptNames = selectPackageScripts(scripts);
    for (const scriptName of scriptNames) {
      if (scriptName === "build" && dockerBuildService) continue;
      const action = classifyScriptAction(scriptName);
      if (!action) continue;
      const { command, args } = packageManagerCommand(packageManager, scriptName);
      addApprovedCommand(approvedCommands, {
        action,
        command,
        args,
        cwd,
        label: commandLabel({ command, args, cwd }),
        source: packageFile.relativePath
      });
    }
    if (isLikelyNodeApp(packageJson) && !scriptNames.some((scriptName) => scriptName.toLowerCase().includes("coverage"))) {
      evidence.push(`${displayPath(cwd)} has no coverage script`);
    }
  }

  const mavenCommandDirs = pomFiles.some((file) => relativeDir(file.relativePath) === ".")
    ? pomFiles.filter((file) => relativeDir(file.relativePath) === ".")
    : pomFiles;
  for (const pomFile of mavenCommandDirs) {
    const cwd = relativeDir(pomFile.relativePath);
    const pomText = await fs.readFile(pomFile.absolutePath, "utf8").catch(() => "");
    detectedStack.add("maven");
    evidence.push(displayPath(pomFile.relativePath));
    if (pomText.includes("spring-boot-starter-actuator")) instrumentation.health.push(`${displayPath(cwd)} has Spring Boot Actuator`);
    if (pomText.includes("micrometer-registry-prometheus")) instrumentation.metrics.push(`${displayPath(cwd)} has Micrometer Prometheus`);
    if (pomText.includes("logstash-logback-encoder")) instrumentation.logs.push(`${displayPath(cwd)} has Logstash Logback Encoder`);
    if (pomText.includes("opentelemetry")) instrumentation.traces.push(`${displayPath(cwd)} has OpenTelemetry dependency`);
    addApprovedCommand(approvedCommands, {
      action: "tests",
      command: "mvn",
      args: ["test"],
      cwd,
      label: commandLabel({ command: "mvn", args: ["test"], cwd }),
      source: pomFile.relativePath
    });
    addApprovedCommand(approvedCommands, {
      action: "coverage",
      command: "mvn",
      args: ["verify"],
      cwd,
      label: commandLabel({ command: "mvn", args: ["verify"], cwd }),
      source: pomFile.relativePath
    });
    addApprovedCommand(approvedCommands, {
      action: "build",
      command: "mvn",
      args: ["-DskipTests", "package"],
      cwd,
      label: commandLabel({ command: "mvn", args: ["-DskipTests", "package"], cwd }),
      source: pomFile.relativePath
    });
  }

  const gradleDirs = [...new Set([...gradleBuildFiles, ...gradlewFiles].map((file) => relativeDir(file.relativePath)))]
    .filter((dir) => !dir.startsWith("chedoparti-mobile/android"));
  for (const cwd of gradleDirs) {
    detectedStack.add("gradle");
    evidence.push(cwd === "." ? "Gradle build" : `${cwd}/Gradle build`);
    const gradleText = await fs.readFile(path.join(abs, cwd, "build.gradle"), "utf8").catch(() => "");
    if (gradleText.includes("spring-boot-starter-actuator")) instrumentation.health.push(`${displayPath(cwd)} has Spring Boot Actuator`);
    if (gradleText.includes("micrometer-registry-prometheus")) instrumentation.metrics.push(`${displayPath(cwd)} has Micrometer Prometheus`);
    if (gradleText.includes("logstash-logback-encoder")) instrumentation.logs.push(`${displayPath(cwd)} has Logstash Logback Encoder`);
    if (gradleText.includes("opentelemetry")) instrumentation.traces.push(`${displayPath(cwd)} has OpenTelemetry dependency`);
    const hasWrapper = await pathExists(path.join(abs, cwd, "gradlew"));
    if (!hasWrapper) {
      evidence.push(`${displayPath(cwd)} has no gradlew wrapper; no Gradle command template was approved`);
      continue;
    }
    const gradleCommand = "./gradlew";
    addApprovedCommand(approvedCommands, {
      action: "tests",
      command: gradleCommand,
      args: ["test"],
      cwd,
      label: commandLabel({ command: gradleCommand, args: ["test"], cwd }),
      source: `${cwd}/build.gradle`
    });
    addApprovedCommand(approvedCommands, {
      action: "coverage",
      command: gradleCommand,
      args: ["test", "jacocoTestReport"],
      cwd,
      label: commandLabel({ command: gradleCommand, args: ["test", "jacocoTestReport"], cwd }),
      source: `${cwd}/build.gradle`
    });
    addApprovedCommand(approvedCommands, {
      action: "build",
      command: gradleCommand,
      args: ["build"],
      cwd,
      label: commandLabel({ command: gradleCommand, args: ["build"], cwd }),
      source: `${cwd}/build.gradle`
    });
  }

  if (pythonFiles.length) {
    detectedStack.add("python");
    evidence.push(`Python manifest (${pythonFiles.length})`);
    const cwd = relativeDir(pythonFiles[0].relativePath);
    addApprovedCommand(approvedCommands, {
      action: "tests",
      command: "python3",
      args: ["-m", "pytest"],
      cwd,
      label: commandLabel({ command: "python3", args: ["-m", "pytest"], cwd }),
      source: pythonFiles[0].relativePath
    });
  }

  for (const flutterFile of flutterFiles) {
    const cwd = relativeDir(flutterFile.relativePath);
    detectedStack.add("flutter");
    evidence.push(displayPath(flutterFile.relativePath));
    addApprovedCommand(approvedCommands, {
      action: "tests",
      command: "flutter",
      args: ["test"],
      cwd,
      label: commandLabel({ command: "flutter", args: ["test"], cwd }),
      source: flutterFile.relativePath
    });
  }

  if (dockerFiles.length) {
    detectedStack.add("docker");
    evidence.push(`Docker artifact (${dockerFiles.length})`);
  }

  if (sonarScripts.length) {
    detectedStack.add("sonarqube");
    for (const sonarScript of sonarScripts) {
      const cwd = ".";
      evidence.push(sonarScript.relativePath);
      addApprovedCommand(approvedCommands, {
        action: "sonar",
        command: "bash",
        args: [sonarScript.relativePath],
        cwd,
        label: commandLabel({ command: "bash", args: [sonarScript.relativePath], cwd }),
        source: sonarScript.relativePath
      });
    }
  } else if (sonarProperties.length) {
    detectedStack.add("sonarqube");
    const rootSonar = sonarProperties.find((file) => relativeDir(file.relativePath) === ".") || sonarProperties[0];
    evidence.push(rootSonar.relativePath);
    addApprovedCommand(approvedCommands, {
      action: "sonar",
      command: "sonar-scanner",
      args: [`-Dsonar.host.url=${sonarHostUrl}`],
      cwd: relativeDir(rootSonar.relativePath),
      label: commandLabel({ command: "sonar-scanner", args: [`-Dsonar.host.url=${sonarHostUrl}`], cwd: relativeDir(rootSonar.relativePath) }),
      source: rootSonar.relativePath
    });
  }

  if (jenkinsFiles.length) {
    detectedStack.add("jenkins");
    evidence.push(`Jenkins pipeline (${jenkinsFiles.map((file) => file.relativePath).join(", ")})`);
  }

  const coverageArtifacts = await detectCoverageArtifacts(abs);
  const sonarProjectKey = await readSonarProjectKey(abs);
  const components = await detectRepositoryComponents(abs, manifests);
  const git = await gitInfo(abs);
  const doctor = buildDoctorReport({
    exists: true,
    abs,
    packageJson: rootPackageJson,
    names,
    detectedStack: [...detectedStack],
    evidence,
    approvedCommands,
    manifests,
    components,
    instrumentation,
    coverageArtifacts,
    sonarProjectKey,
    hasJenkinsfile: jenkinsFiles.length > 0,
    git,
    hasDocker: dockerFiles.length > 0
  });

  return {
    exists: true,
    repositoryPath,
    publicPath: `/workspace/projects/${repositoryPath}`,
    detectedStack: [...detectedStack].sort(),
    evidence,
    approvedCommands,
    manifests: manifests.map((file) => file.relativePath),
    components,
    instrumentation,
    coverageArtifacts,
    sonarProjectKey,
    git,
    doctor,
    hasDocker: dockerFiles.length > 0
  };
}

async function gitInfo(abs) {
  const inside = await runSmallCommand("git", ["rev-parse", "--is-inside-work-tree"], abs);
  if (!inside.ok || inside.stdout.trim() !== "true") {
    return { isGit: false, branch: null, commit: null, dirty: false };
  }
  const root = await runSmallCommand("git", ["rev-parse", "--show-toplevel"], abs);
  const gitDir = await runSmallCommand("git", ["rev-parse", "--git-dir"], abs);
  const branch = await runSmallCommand("git", ["branch", "--show-current"], abs);
  const commit = await runSmallCommand("git", ["rev-parse", "HEAD"], abs);
  const shortCommit = await runSmallCommand("git", ["rev-parse", "--short", "HEAD"], abs);
  const log = await runSmallCommand("git", ["log", "-1", "--pretty=format:%h|%an|%ad|%s", "--date=iso"], abs);
  const status = await runSmallCommand("git", ["status", "--porcelain=v1", "--branch"], abs);
  const remote = await runSmallCommand("git", ["remote", "-v"], abs);
  const tags = await runSmallCommand("git", ["tag", "--points-at", "HEAD"], abs);
  const upstream = await runSmallCommand("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], abs);
  const aheadBehind = upstream.ok
    ? await runSmallCommand("git", ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], abs)
    : { ok: false, stdout: "" };
  const parsedStatus = parseGitStatus(status.stdout);
  const [lastHash, lastAuthor, lastDate, ...lastMessageParts] = log.ok ? log.stdout.trim().split("|") : [];
  const gitRoot = root.ok ? root.stdout.trim() : abs;
  const resolvedGitDir = gitDir.ok
    ? path.resolve(abs, gitDir.stdout.trim())
    : path.join(gitRoot, ".git");
  const operation = await gitOperationState(resolvedGitDir);
  const lastPullAt = await gitFetchHeadAt(resolvedGitDir);
  const [ahead, behind] = aheadBehind.ok
    ? aheadBehind.stdout.trim().split(/\s+/).map((value) => Number(value) || 0)
    : [parsedStatus.ahead || 0, parsedStatus.behind || 0];
  const currentBranch = branch.ok ? branch.stdout.trim() : "";
  const currentCommit = commit.ok ? commit.stdout.trim() : null;
  const primaryRemote = parsePrimaryRemote(remote.stdout);
  return {
    isGit: true,
    root: sanitizeText(gitRoot),
    branch: currentBranch || null,
    commit: currentCommit,
    shortCommit: shortCommit.ok ? shortCommit.stdout.trim() : currentCommit?.slice(0, 8) || null,
    detachedHead: !currentBranch && Boolean(currentCommit),
    lastCommit: lastHash ? {
      hash: lastHash,
      author: lastAuthor || "",
      date: lastDate || "",
      message: lastMessageParts.join("|") || ""
    } : null,
    remote: primaryRemote,
    remoteProvider: inferGitRemoteProvider(primaryRemote),
    tags: tags.ok ? tags.stdout.split(/\r?\n/).map((item) => sanitizeText(item.trim())).filter(Boolean).slice(0, 20) : [],
    currentTag: tags.ok ? tags.stdout.split(/\r?\n/).map((item) => sanitizeText(item.trim())).filter(Boolean)[0] || "" : "",
    upstream: upstream.ok ? upstream.stdout.trim() : "",
    ahead,
    behind,
    dirty: parsedStatus.dirty,
    modified: parsedStatus.modified,
    added: parsedStatus.added,
    deleted: parsedStatus.deleted,
    untracked: parsedStatus.untracked,
    conflicted: parsedStatus.conflicted,
    changes: parseGitChangedFiles(status.stdout),
    operation,
    statusBranchLine: parsedStatus.branchLine,
    statusPorcelainHash: hashText(status.stdout || ""),
    lastPullAt,
    pullEvidence: lastPullAt ? "FETCH_HEAD mtime" : "",
    refreshedAt: nowIso()
  };
}

function parseGitStatus(output) {
  const lines = String(output || "").split(/\r?\n/).filter(Boolean);
  const branchLine = lines[0]?.startsWith("## ") ? lines[0].slice(3) : "";
  const counts = {
    branchLine,
    modified: 0,
    added: 0,
    deleted: 0,
    untracked: 0,
    conflicted: 0,
    ahead: 0,
    behind: 0,
    dirty: false
  };
  const aheadMatch = branchLine.match(/ahead\s+(\d+)/i);
  const behindMatch = branchLine.match(/behind\s+(\d+)/i);
  counts.ahead = aheadMatch ? Number(aheadMatch[1]) : 0;
  counts.behind = behindMatch ? Number(behindMatch[1]) : 0;

  for (const line of lines.slice(branchLine ? 1 : 0)) {
    const x = line[0] || " ";
    const y = line[1] || " ";
    if (line.startsWith("??")) {
      counts.untracked += 1;
      continue;
    }
    if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) counts.conflicted += 1;
    if (x === "A" || y === "A") counts.added += 1;
    if (x === "D" || y === "D") counts.deleted += 1;
    if (x === "M" || y === "M" || x === "R" || y === "R" || x === "C" || y === "C") counts.modified += 1;
  }
  counts.dirty = counts.modified + counts.added + counts.deleted + counts.untracked + counts.conflicted > 0;
  return counts;
}

async function gitOperationState(gitDir) {
  const checks = [
    ["merge", "MERGE_HEAD"],
    ["cherry-pick", "CHERRY_PICK_HEAD"],
    ["revert", "REVERT_HEAD"],
    ["bisect", "BISECT_LOG"],
    ["rebase", "rebase-merge"],
    ["rebase", "rebase-apply"]
  ];
  for (const [stateName, relativePath] of checks) {
    if (await pathExists(path.join(gitDir, relativePath))) return stateName;
  }
  return "normal";
}

async function gitFetchHeadAt(gitDir) {
  const stat = await fs.stat(path.join(gitDir, "FETCH_HEAD")).catch(() => null);
  return stat?.mtime ? stat.mtime.toISOString() : "";
}

function parsePrimaryRemote(output) {
  const line = String(output || "")
    .split(/\r?\n/)
    .find((item) => /\s+\(fetch\)$/.test(item));
  if (!line) return "";
  return sanitizeGitRemoteUrl(line.replace(/\s+\(fetch\)$/, "").split(/\s+/).slice(1).join(" "));
}

function sanitizeGitRemoteUrl(value) {
  return sanitizeText(String(value || "").replace(/(https?:\/\/)[^/@\s]+@/i, "$1[REDACTED]@"));
}

function inferGitRemoteProvider(remote) {
  const value = String(remote || "").toLowerCase();
  if (!value) return "";
  if (value.includes("github.com")) return "github";
  if (value.includes("gitlab.com")) return "gitlab";
  if (value.includes("bitbucket.org")) return "bitbucket";
  if (value.includes("azure.com") || value.includes("dev.azure.com")) return "azure-devops";
  return "git";
}

function parseGitChangedFiles(output) {
  return String(output || "")
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("## "))
    .map((line) => {
      const status = line.slice(0, 2);
      const filePath = sanitizeText(line.slice(3).trim()).slice(0, 280);
      return {
        status: status.trim() || "changed",
        change: gitChangeKind(status),
        path: filePath
      };
    })
    .filter((item) => item.path)
    .slice(0, 50);
}

function gitChangeKind(status) {
  if (status === "??") return "untracked";
  if (/U/.test(status) || status === "AA" || status === "DD") return "conflicted";
  if (/A/.test(status)) return "added";
  if (/D/.test(status)) return "deleted";
  if (/R/.test(status)) return "renamed";
  if (/C/.test(status)) return "copied";
  return "modified";
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function gitFingerprintInput(git) {
  if (!git?.isGit) return "git:none";
  return JSON.stringify({
    branch: git.branch || "",
    commit: git.commit || "",
    dirty: Boolean(git.dirty),
    statusPorcelainHash: git.statusPorcelainHash || "",
    operation: git.operation || "normal"
  });
}

function shouldFingerprintFile(relativePath) {
  const normalized = relativePath.split(path.sep).join("/");
  const parts = normalized.split("/");
  if (parts.some((part) => discoveryIgnoreNames.has(part))) return false;
  if (parts.some((part) => [".git", ".scannerwork", ".cache", ".parcel-cache"].includes(part))) return false;
  if (parts.some((part) => /^(logs?|tmp|temp)$/i.test(part))) return false;
  const name = path.basename(normalized);
  if (name === ".DS_Store" || name === "Thumbs.db") return false;
  if (/^\.env($|\.)/i.test(name) && !/\.example$/i.test(name)) return false;
  if (/\.(log|tmp|cache|sqlite|sqlite3|db|pid|sock|png|jpe?g|gif|webp|mp4|mov|zip|gz|tar|7z|pdf)$/i.test(name)) return false;
  return true;
}

function nonSecretEnvFingerprintEntries(project) {
  const env = { ...runtimeDefaultEnv(project), ...projectRuntimeEnv(project) };
  return Object.entries(env)
    .filter(([key]) => !isSensitiveKey(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${String(value || "")}`);
}

async function calculateSourceFingerprint(project, abs, git = null, options = {}) {
  const ttlMs = options.ttlMs ?? 12000;
  const cacheKey = `${project.id}:${abs}`;
  const cached = sourceFingerprintCache.get(cacheKey);
  if (!options.force && cached && Date.now() - cached.createdMs < ttlMs) return cached.value;

  const effectiveGit = git || await gitInfo(abs).catch(() => ({ isGit: false, dirty: false }));
  const hash = crypto.createHash("sha256");
  const files = [];
  let skippedFiles = 0;
  let bytesHashed = 0;
  const maxFiles = options.maxFiles ?? 12000;
  const maxFileBytes = options.maxFileBytes ?? 1024 * 1024;

  hash.update(`project:${project.slug}\n`);
  hash.update(`git:${gitFingerprintInput(effectiveGit)}\n`);
  hash.update(`env:${JSON.stringify(nonSecretEnvFingerprintEntries(project))}\n`);

  async function walk(dir) {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        skippedFiles += 1;
        continue;
      }
      const absolutePath = path.join(dir, entry.name);
      const relativePath = path.relative(abs, absolutePath);
      if (!shouldFingerprintFile(relativePath)) {
        if (entry.isDirectory()) continue;
        skippedFiles += 1;
        continue;
      }
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(absolutePath).catch(() => null);
      if (!stat || stat.size > maxFileBytes) {
        skippedFiles += 1;
        continue;
      }
      const content = await fs.readFile(absolutePath).catch(() => null);
      if (!content) {
        skippedFiles += 1;
        continue;
      }
      const normalized = relativePath.split(path.sep).join("/");
      hash.update(`file:${normalized}:${content.length}:`);
      hash.update(content);
      hash.update("\n");
      files.push(normalized);
      bytesHashed += content.length;
    }
  }

  await walk(abs);
  const value = {
    algorithm: "sha256",
    value: `sha256:${hash.digest("hex")}`,
    generatedAt: nowIso(),
    filesHashed: files.length,
    bytesHashed,
    skippedFiles,
    sampleFiles: files.slice(0, 12),
    git: {
      isGit: Boolean(effectiveGit?.isGit),
      branch: effectiveGit?.branch || "",
      commit: effectiveGit?.commit || "",
      shortCommit: effectiveGit?.shortCommit || shortHash(effectiveGit?.commit),
      dirty: Boolean(effectiveGit?.dirty),
      modified: effectiveGit?.modified || 0,
      added: effectiveGit?.added || 0,
      deleted: effectiveGit?.deleted || 0,
      untracked: effectiveGit?.untracked || 0,
      ahead: effectiveGit?.ahead || 0,
      behind: effectiveGit?.behind || 0
    }
  };
  sourceFingerprintCache.set(cacheKey, { createdMs: Date.now(), value });
  return value;
}

function shortHash(value) {
  return value ? String(value).slice(0, 8) : "";
}

function runSmallCommand(command, args, cwd) {
  return new Promise((resolve) => {
    const safeArgs = command === "git"
      ? ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "credential.helper=", ...args]
      : args;
    const child = spawn(command, safeArgs, {
      cwd,
      env: command === "git"
        ? { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }
        : process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let forceKillTimer = null;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
    }, 3000);
    const consume = (chunk, stream) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > Math.min(securityConfig.processOutputLimitBytes, 256 * 1024)) {
        child.kill("SIGTERM");
        if (!forceKillTimer) forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
        return;
      }
      if (stream === "stdout") stdout += chunk.toString();
      else stderr += chunk.toString();
    };
    child.stdout.on("data", (chunk) => consume(chunk, "stdout"));
    child.stderr.on("data", (chunk) => consume(chunk, "stderr"));
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve({ ok: code === 0, code, stdout: sanitizeText(stdout), stderr: sanitizeText(stderr) });
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve({ ok: false, code: -1, stdout: sanitizeText(stdout), stderr: sanitizeText(error.message) });
    });
  });
}

function buildDoctorReport(context) {
  const detectedStack = context.detectedStack || [];
  const approvedCommands = context.approvedCommands || [];
  const commandCounts = approvedCommands.reduce((acc, command) => {
    acc[command.action] = (acc[command.action] || 0) + 1;
    return acc;
  }, {});
  const instrumentation = context.instrumentation || {};
  const report = [];
  report.push({
    level: context.exists ? "ok" : "error",
    code: "PROJECT_PATH",
    message: context.exists ? "Repository path is inside PROJECTS_ROOT." : "Repository path does not exist or is outside PROJECTS_ROOT."
  });
  report.push({
    level: context.git?.isGit ? "ok" : "warn",
    code: "GIT",
    message: context.git?.isGit ? `Git detected at ${context.git.branch || "unknown"} ${context.git.commit || ""}`.trim() : "Git repository not detected."
  });
  report.push({
    level: detectedStack.length ? "ok" : "warn",
    code: "STACK",
    message: detectedStack.length ? `Detected: ${detectedStack.join(", ")}` : "No known stack manifest detected."
  });
  report.push({
    level: context.manifests?.length ? "ok" : "warn",
    code: "MANIFESTS",
    message: context.manifests?.length ? `${context.manifests.length} relevant manifest/config file(s) detected within the repository.` : "No supported manifest was detected within the repository."
  });
  report.push({
    level: context.sonarProjectKey ? "ok" : "warn",
    code: "SONAR_PROJECT_KEY",
    message: context.sonarProjectKey ? `sonar.projectKey=${context.sonarProjectKey}` : "No sonar.projectKey found in root sonar-project.properties."
  });
  report.push({
    level: commandCounts.tests ? "ok" : "warn",
    code: "TESTS",
    message: commandCounts.tests ? `${commandCounts.tests} test command template(s) available.` : "No test command template was detected."
  });
  report.push({
    level: commandCounts.coverage ? "ok" : "warn",
    code: "COVERAGE",
    message: commandCounts.coverage ? `${commandCounts.coverage} coverage command template(s) available.` : "No coverage command template was detected."
  });
  report.push({
    level: context.coverageArtifacts?.length ? "ok" : "info",
    code: "COVERAGE_REPORTS",
    message: context.coverageArtifacts?.length ? `Existing coverage report(s): ${context.coverageArtifacts.slice(0, 6).join(", ")}${context.coverageArtifacts.length > 6 ? "..." : ""}` : "No existing LCOV, JaCoCo XML or coverage.xml artifact found yet. Generate coverage before Sonar for accurate metrics."
  });
  report.push({
    level: commandCounts.sonar ? "ok" : "warn",
    code: "SONAR_CONFIG",
    message: commandCounts.sonar ? `${commandCounts.sonar} SonarQube scan template(s) detected.` : "No local SonarQube scan configuration detected."
  });
  report.push({
    level: context.hasJenkinsfile ? "ok" : "warn",
    code: "JENKINSFILE",
    message: context.hasJenkinsfile
      ? "Jenkinsfile detected; Jenkins multibranch can execute project-defined pipeline stages."
      : "No Jenkinsfile detected at inspected depth. Jenkins multibranch jobs need a Jenkinsfile to run build/test/scan/docker image stages."
  });
  report.push({
    level: context.hasDocker ? "ok" : "info",
    code: "RUNTIME",
    message: context.hasDocker ? "Docker runtime artifacts detected." : "No Docker runtime artifact detected in the inspected depth."
  });
  report.push({
    level: instrumentation.health?.length ? "ok" : "info",
    code: "HEALTH_ENDPOINT",
    message: instrumentation.health?.length ? instrumentation.health.join("; ") : "No health/readiness instrumentation detected from manifests."
  });
  report.push({
    level: instrumentation.metrics?.length ? "ok" : "info",
    code: "METRICS",
    message: instrumentation.metrics?.length ? instrumentation.metrics.join("; ") : "No Prometheus/Micrometer metrics instrumentation detected from manifests."
  });
  report.push({
    level: instrumentation.logs?.length ? "ok" : "info",
    code: "STRUCTURED_LOGS",
    message: instrumentation.logs?.length ? instrumentation.logs.join("; ") : "No structured logging dependency detected from manifests."
  });
  report.push({
    level: instrumentation.traces?.length ? "ok" : "info",
    code: "TRACES",
    message: instrumentation.traces?.length ? instrumentation.traces.join("; ") : "No OpenTelemetry tracing dependency detected from manifests."
  });
  report.push({
    level: "info",
    code: "OBSERVABILITY",
    message: "Metrics, logs and traces are reported as Sin datos until the project runs with instrumentation and matching labels."
  });
  return report;
}

async function refreshProjectStatuses() {
  for (const project of state.projects) {
    const discovered = await discoverRepository(project.repositoryPath).catch((error) => ({
      exists: false,
      detectedStack: project.detectedStack || [],
      doctor: [{ level: "error", code: "DISCOVERY_FAILED", message: error.message }]
    }));
    project.status = discovered.exists ? "ACTIVE" : "MISCONFIGURED";
    project.detectedStack = discovered.detectedStack;
    project.updatedAt = nowIso();
  }
  await saveState();
}

function findProject(idOrSlug) {
  return state.projects.find((project) => project.id === idOrSlug || project.slug === idOrSlug);
}

function findProjectOrThrow(idOrSlug) {
  const project = findProject(idOrSlug);
  if (!project) throw problem(404, "PROJECT_NOT_FOUND", "Project was not found.");
  return project;
}

function declaredComponents(project, descriptorProject) {
  if (descriptorProject?.components?.length) return descriptorProject.components;
  return [{
    name: project.slug,
    type: "application",
    path: ".",
    runtime: "local",
    source: "registry-default"
  }];
}

function declaredEnvironments(project, descriptorProject) {
  if (descriptorProject?.environments?.length) return descriptorProject.environments;
  return state.environments
    .filter((environment) => environment.projectId === project.id)
    .map((environment) => ({
      name: environment.name,
      provider: "local",
      protected: false,
      baseUrl: environment.baseUrl || "",
      healthUrl: environment.healthUrl || "",
      metricsUrl: environment.metricsUrl || "",
      source: "state",
      labels: {
        project: project.slug,
        environment: environment.name
      }
    }));
}

function integrationStatusForRuntime(runtime = {}) {
  if (runtime.status === "running" && runtime.freshness?.status === "matched") return "CONFIGURED_AND_VERIFIED";
  if (runtime.status === "running" || runtime.status === "stale" || runtime.freshness?.status === "unverified") return "PARTIALLY_CONFIGURED";
  if (runtime.status === "stopped") return "CONFIGURED_NOT_VERIFIED";
  if (runtime.status === "not_configured") return "NOT_CONFIGURED";
  if (["error", "unavailable", "degraded"].includes(runtime.status)) return "ERROR";
  return "CONFIGURED_NOT_VERIFIED";
}

function dockerIntegrationStatus(discovered = {}, runtime = {}) {
  if (!discovered.hasDocker) return "NOT_CONFIGURED";
  if (runtime.dockerAvailable === false) return "ERROR";
  if ((runtime.resources || []).length) return "CONFIGURED_AND_VERIFIED";
  return "CONFIGURED_NOT_VERIFIED";
}

function healthCheckState(environments, runtime = {}) {
  const checks = environments
    .filter((environment) => environment.healthUrl)
    .map((environment) => ({
      name: `${environment.name}:health`,
      environment: environment.name,
      url: environment.healthUrl,
      status: runtime.status === "running" ? "CONFIGURED_NOT_VERIFIED" : "CONFIGURED_NOT_VERIFIED",
      source: environment.source || "descriptor"
    }));
  if (checks.length) return checks;
  return [{
    name: "local:health",
    environment: "local",
    url: "",
    status: "NOT_CONFIGURED",
    source: "descriptor",
    message: "No healthUrl declared for the local environment."
  }];
}

function localStateGaps({ descriptorStatus, descriptorProject, discovered, runtime, declared, detected }) {
  const gaps = [];
  if (descriptorStatus !== "CONFIGURED_AND_VERIFIED") {
    gaps.push({
      severity: descriptorStatus === "ERROR" ? "critical" : "warning",
      code: "DESCRIPTOR_NOT_VERIFIED",
      message: "Catalog descriptor is not configured and verified."
    });
  }
  if (!descriptorProject) {
    gaps.push({
      severity: "warning",
      code: "PROJECT_NOT_DECLARED",
      message: "Project exists in local state but is missing from the YAML descriptor."
    });
  }
  if (!discovered.exists) {
    gaps.push({
      severity: "critical",
      code: "REPOSITORY_NOT_DETECTED",
      message: "Repository path could not be resolved under PROJECTS_ROOT."
    });
  }
  if (!detected.components.length) {
    gaps.push({
      severity: "warning",
      code: "NO_COMPONENTS_DETECTED",
      message: "No components were detected from repository manifests."
    });
  }
  if (!declared.environments.some((environment) => environment.healthUrl)) {
    gaps.push({
      severity: "warning",
      code: "HEALTH_URL_NOT_DECLARED",
      message: "No health check URL is declared for the local environment."
    });
  }
  if (runtime.status === "stale" || runtime.freshness?.status === "stale") {
    gaps.push({
      severity: "critical",
      code: "LOCAL_RUNTIME_STALE",
      message: runtime.freshness?.message || "Local runtime does not match the current source fingerprint."
    });
  }
  if (runtime.freshness?.status === "unverified") {
    gaps.push({
      severity: "warning",
      code: "LOCAL_RUNTIME_UNVERIFIED",
      message: runtime.freshness.message || "Runtime is active without a verified deployment fingerprint."
    });
  }
  return gaps;
}

function buildLocalState(project, catalog, descriptorProject, discovered, runtime) {
  const components = declaredComponents(project, descriptorProject);
  const environments = declaredEnvironments(project, descriptorProject);
  const declared = {
    status: descriptorProject ? "CONFIGURED_NOT_VERIFIED" : "NOT_CONFIGURED",
    project: {
      id: project.id,
      slug: project.slug,
      repositoryPath: project.repositoryPath,
      defaultBranch: project.defaultBranch || descriptorProject?.defaultBranch || "main",
      criticality: project.criticality || descriptorProject?.criticality || "medium",
      owner: project.owner || descriptorProject?.owner || "",
      team: project.team || descriptorProject?.team || ""
    },
    components,
    environments
  };
  const detected = {
    status: discovered.exists ? "CONFIGURED_AND_VERIFIED" : "ERROR",
    repositoryPath: project.repositoryPath,
    stack: discovered.detectedStack || [],
    components: discovered.components || [],
    manifests: discovered.manifests || [],
    git: publicGitStatus(discovered.git),
    docker: {
      status: dockerIntegrationStatus(discovered, runtime),
      hasDocker: Boolean(discovered.hasDocker),
      composeFile: runtime.composeFile || "",
      composeProject: runtime.composeProject || ""
    }
  };
  const verified = {
    status: integrationStatusForRuntime(runtime),
    environment: "local",
    git: runtime.git || publicGitStatus(discovered.git),
    sourceFingerprint: runtime.sourceFingerprint || null,
    lastDeployment: runtime.lastDeployment || null,
    freshness: runtime.freshness || null,
    docker: {
      status: dockerIntegrationStatus(discovered, runtime),
      resources: runtime.resources || [],
      ports: runtime.ports || []
    },
    healthChecks: healthCheckState(environments, runtime),
    checkedAt: runtime.updatedAt || nowIso()
  };
  return {
    generatedAt: nowIso(),
    descriptor: {
      status: catalog?.status || "NOT_CONFIGURED",
      path: catalog?.path || catalogDescriptorFile,
      projectDeclared: Boolean(descriptorProject)
    },
    declared,
    detected,
    verified,
    gaps: localStateGaps({
      descriptorStatus: catalog?.status || "NOT_CONFIGURED",
      descriptorProject,
      discovered,
      runtime,
      declared,
      detected
    })
  };
}

async function projectDetails(project, catalog = null) {
  const loadedCatalog = catalog || await loadCatalogDescriptor();
  const descriptorProject = descriptorProjectFor(loadedCatalog, project);
  const discovered = await discoverRepository(project.repositoryPath).catch((error) => ({
    exists: false,
    detectedStack: project.detectedStack || [],
    doctor: [{ level: "error", code: "DISCOVERY_FAILED", message: error.message }],
    approvedCommands: [],
    components: [],
    manifests: [],
    hasDocker: false
  }));
  const latestSnapshot = state.qualitySnapshots.find((snapshot) => snapshot.projectId === project.id) || null;
  const latestJob = state.jobs.find((job) => job.projectId === project.id) || null;
  const localRuntime = await localRuntimeSummary(project, discovered).catch((error) => ({
    status: "unavailable",
    label: "No disponible",
    explanation: sanitizeText(error.message),
    resources: [],
    ports: [],
    composeFile: "",
    composeProject: "",
    lastAction: localRuntimeStore(project).action,
    updatedAt: localRuntimeStore(project).updatedAt
  }));
  const localState = buildLocalState(project, loadedCatalog, descriptorProject, discovered, localRuntime);
  return {
    ...project,
    owner: project.owner || descriptorProject?.owner || "",
    team: project.team || descriptorProject?.team || "",
    criticality: project.criticality || descriptorProject?.criticality || "medium",
    publicPath: projectPublicPath(project),
    detectedStack: discovered.detectedStack,
    doctor: discovered.doctor,
    git: discovered.git || null,
    descriptor: descriptorProject ? {
      status: "CONFIGURED_NOT_VERIFIED",
      path: loadedCatalog.path,
      project: descriptorProject
    } : {
      status: loadedCatalog.status === "ERROR" ? "ERROR" : "NOT_CONFIGURED",
      path: loadedCatalog.path,
      project: null
    },
    components: {
      declared: localState.declared.components,
      detected: localState.detected.components,
      verified: (localState.verified.docker.resources || []).map((resource) => ({
        name: resource.service || resource.name,
        type: "docker-container",
        status: resource.state,
        source: "docker",
        evidence: resource.name || resource.id
      }))
    },
    localState,
    approvedActions: [...new Set((discovered.approvedCommands || []).map((cmd) => cmd.action).concat(["doctor", "health"]))],
    approvedCommands: discovered.approvedCommands || [],
    manifests: discovered.manifests || [],
    instrumentation: discovered.instrumentation || {},
    coverageArtifacts: discovered.coverageArtifacts || [],
    runtimeConfig: publicRuntimeConfig(project),
    localRuntime,
    latestSnapshot,
    latestJob,
    links: sonarLinks(project),
    toolLinks: applyStoredToolLinkValidation(project, projectToolLinks(project, discovered.git || null))
  };
}

function sonarLinks(projectOrKey) {
  const projectKey = typeof projectOrKey === "string" ? projectOrKey : projectOrKey.sonarProjectKey;
  const baseUrl = typeof projectOrKey === "string" ? sonarHostUrl : sonarConnection(projectOrKey).hostUrl;
  const publicBaseUrl = baseUrl.replace("host.docker.internal", "localhost");
  const encoded = encodeURIComponent(projectKey);
  return {
    overview: `${publicBaseUrl}/dashboard?id=${encoded}`,
    issues: `${publicBaseUrl}/project/issues?id=${encoded}`,
    measures: `${publicBaseUrl}/component_measures?id=${encoded}`,
    activity: `${publicBaseUrl}/project/activity?id=${encoded}`,
    securityHotspots: `${publicBaseUrl}/security_hotspots?id=${encoded}`
  };
}

function projectToolLinks(project, git = null) {
  const runtimeConfig = { ...defaultRuntimeConfig(), ...(project.runtimeConfig || {}) };
  const sonar = sonarLinks(project);
  const repository = gitRepositoryLinks(git || {});
  const jenkins = jenkinsLinks(project, git, runtimeConfig);
  const links = [
    ...repository,
    toolLink("sonarqube", "SonarQube overview", sonar.overview, "quality", "Abre el dashboard del proyecto en SonarQube. Si devuelve 404, ejecutar el analisis Sonar del proyecto primero."),
    toolLink("sonarqube", "SonarQube issues", sonar.issues, "quality", "Issues filtrados por proyecto."),
    toolLink("sonarqube", "SonarQube measures", sonar.measures, "quality", "Metricas tecnicas del proyecto."),
    toolLink("sonarqube", "Security hotspots", sonar.securityHotspots, "quality", "Revision de hotspots de seguridad."),
    ...jenkins,
    toolLink("observability", "Grafana", "http://localhost:13000", "observability", "Dashboard local de observabilidad."),
    toolLink("observability", "Grafana proyecto", grafanaProjectDashboardUrl(project), "observability", "Dashboard de observabilidad filtrado por proyecto y ambiente local."),
    toolLink("observability", "Prometheus", "http://localhost:19090", "observability", "Prometheus local y targets."),
    toolLink("observability", "Loki", "http://localhost:13100", "observability", "Loki local para logs centralizados."),
    toolLink("observability", "Tempo", "http://localhost:13200", "observability", "Tempo local para trazas OTLP."),
    toolLink("observability", "Alertmanager", "http://localhost:19093", "observability", "Alertas locales.")
  ];
  return links.filter((link) => link.url);
}

function toolLink(provider, label, url, group, hint, extra = {}) {
  return {
    id: slugify(`${provider}-${group}-${label}`),
    provider,
    group,
    label,
    url,
    status: "unknown",
    lastValidatedAt: "",
    httpStatus: null,
    error: "",
    hint,
    ...extra
  };
}

function applyStoredToolLinkValidation(project, links) {
  const stored = state.linkValidations?.[project.id];
  if (!stored?.items?.length) return links;
  return links.map((link) => {
    const matched = stored.items.find((item) => item.id === link.id && item.url === link.url);
    if (!matched) return link;
    return {
      ...link,
      status: matched.status || link.status,
      lastValidatedAt: matched.lastValidatedAt || "",
      httpStatus: matched.httpStatus ?? null,
      responseTimeMs: matched.responseTimeMs ?? null,
      error: matched.error || "",
      hint: matched.hint || link.hint
    };
  });
}

function gitRepositoryLinks(git = {}) {
  const remote = parseGitRemoteUrl(git.remote || "");
  if (!remote?.baseUrl) return [
    toolLink("git", "Repositorio remoto", "", "source", "No se detecto remoto Git. Configurar origin para habilitar links a branches y PRs.")
  ];
  if (remote.provider === "github") {
    return [
      toolLink("github", "Repositorio", remote.baseUrl, "source", "Repositorio GitHub remoto."),
      toolLink("github", "Branches", `${remote.baseUrl}/branches`, "source", "Branches disponibles en GitHub."),
      toolLink("github", "Pull requests", `${remote.baseUrl}/pulls`, "source", "PRs abiertos y cerrados."),
      toolLink("github", "Actions", `${remote.baseUrl}/actions`, "ci", "GitHub Actions del repositorio."),
      toolLink("github", "Commits branch", `${remote.baseUrl}/commits/${encodeURIComponent(git.branch || "HEAD")}`, "source", "Commits de la rama detectada.")
    ];
  }
  if (remote.provider === "gitlab") {
    return [
      toolLink("gitlab", "Repositorio", remote.baseUrl, "source", "Repositorio GitLab remoto."),
      toolLink("gitlab", "Branches", `${remote.baseUrl}/-/branches`, "source", "Branches disponibles en GitLab."),
      toolLink("gitlab", "Merge requests", `${remote.baseUrl}/-/merge_requests`, "source", "MRs abiertos y cerrados."),
      toolLink("gitlab", "Pipelines", `${remote.baseUrl}/-/pipelines`, "ci", "Pipelines GitLab del repositorio.")
    ];
  }
  return [
    toolLink("git", "Repositorio remoto", remote.baseUrl, "source", "Repositorio remoto detectado."),
    toolLink("git", "Remote URL", remote.baseUrl, "source", "Proveedor Git no reconocido para generar links de branches/PRs.")
  ];
}

function parseGitRemoteUrl(remote) {
  const value = String(remote || "").trim().replace(/\.git$/, "");
  if (!value) return null;
  const ssh = value.match(/^git@([^:]+):(.+)$/);
  const https = value.match(/^https?:\/\/([^/]+)\/(.+)$/);
  const hostName = ssh?.[1] || https?.[1] || "";
  const repoPath = ssh?.[2] || https?.[2] || "";
  if (!hostName || !repoPath) return { provider: "git", baseUrl: value };
  const provider = hostName.includes("github.com") ? "github" : hostName.includes("gitlab.com") ? "gitlab" : "git";
  return { provider, host: hostName, repoPath, baseUrl: `https://${hostName}/${repoPath}` };
}

function jenkinsBaseUrl(project = null) {
  const runtimeConfig = { ...defaultRuntimeConfig(), ...(project?.runtimeConfig || {}) };
  return stripTrailingSlash(runtimeConfig.jenkinsUrl || jenkinsUrl);
}

function jenkinsLinks(project, git = null, runtimeConfig = null) {
  const config = { ...defaultRuntimeConfig(), ...(runtimeConfig || project.runtimeConfig || {}) };
  const base = stripTrailingSlash(config.jenkinsUrl || jenkinsUrl);
  const jobName = config.jenkinsJobName || project.slug;
  const encodedJob = encodeJenkinsJobPath(jobName);
  const encodedBranch = git?.branch ? encodeJenkinsJobPath(git.branch) : "";
  return [
    toolLink("jenkins", "Jenkins", base, "ci", "Jenkins local. Levantar con el perfil ci si no responde."),
    toolLink("jenkins", "Multibranch job", `${base}/job/${encodedJob}/`, "ci", "Job multibranch esperado para este proyecto.", { requiredSetup: "Crear multibranch job o ejecutar seed Job DSL." }),
    encodedBranch
      ? toolLink("jenkins", "Pipeline branch actual", `${base}/job/${encodedJob}/job/${encodedBranch}/`, "ci", "Pipeline Jenkins para la rama local detectada.", { requiredSetup: "La rama debe existir en el remoto y el job multibranch debe haber escaneado branches." })
      : null,
    toolLink("jenkins", "Blue Ocean", `${base}/blue/organizations/jenkins/${encodeURIComponent(jobName)}/activity`, "ci", "Vista Blue Ocean si el plugin esta instalado.")
  ].filter(Boolean);
}

function encodeJenkinsJobPath(value) {
  return String(value || "")
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/job/");
}

async function localRuntimeSummary(project, discovered = null) {
  const stored = localRuntimeStore(project);
  const abs = await canonicalProjectPath(project.repositoryPath);
  const runtimeAbs = await runtimeProjectPath(project, abs);
  const docker = await dockerStatus();
  const resources = docker.available ? await listProjectContainers(project, abs, runtimeAbs).catch(() => []) : [];
  const spec = docker.available ? await resolveComposeSpec(project, runtimeAbs, discovered, resources).catch(() => null) : null;
  const profiles = await runtimeProfiles(project, abs, runtimeAbs, discovered, spec).catch(() => []);
  const running = resources.filter((resource) => resource.state === "running");
  const exited = resources.filter((resource) => resource.state && resource.state !== "running");
  const operation = localRuntimeProcesses.get(project.id);
  const currentGit = discovered?.git || await gitInfo(abs).catch(() => stored.git || { isGit: false });
  const currentFingerprint = await calculateSourceFingerprint(project, runtimeAbs, currentGit).catch(() => null);
  const freshness = runtimeFreshness(stored, currentFingerprint, running.length > 0);

  let status = "stopped";
  let explanation = "No hay contenedores activos para este proyecto.";
  if (!docker.available) {
    status = "unavailable";
    explanation = docker.reason || "Docker CLI no esta disponible para el backend.";
  } else if (!spec && !resources.length) {
    status = "not_configured";
    explanation = "No se detecto compose local para orquestar este proyecto.";
  } else if (operation) {
    status = operation.status;
    explanation = `Accion ${operation.action} en curso.`;
  } else if (stored.status === "error") {
    status = "error";
    explanation = stored.error || "La ultima accion local termino con error.";
  } else if (freshness.status === "stale" && running.length) {
    status = "stale";
    explanation = freshness.message;
  } else if (running.length) {
    status = exited.length ? "degraded" : "running";
    explanation = exited.length
      ? `${running.length} servicio(s) corriendo y ${exited.length} detenido(s).`
      : `${running.length} servicio(s) corriendo.`;
  } else if (resources.length) {
    status = "stopped";
    explanation = `${resources.length} contenedor(es) detectados, ninguno corriendo.`;
  }

  const ports = uniquePorts(resources.flatMap((resource) => resource.ports || []));
  return {
    status,
    label: localRuntimeLabel(status),
    explanation,
    dockerAvailable: docker.available,
    dockerReason: docker.reason || "",
    composeFile: spec?.relativePath || stored.composeFile || "",
    composeProject: spec?.projectName || stored.composeProject || resources[0]?.composeProject || "",
    runtimePath: sanitizeText(runtimeAbs),
    profiles,
    resources,
    ports,
    git: publicGitStatus(currentGit),
    sourceFingerprint: publicSourceFingerprint(currentFingerprint),
    lastDeployment: publicDeploymentSnapshot(stored.lastDeployment),
    lastBuildAt: stored.lastDeployment?.finishedAt || "",
    freshness,
    logLines: (stored.logs || []).length,
    lastAction: stored.action,
    updatedAt: stored.updatedAt
  };
}

function localRuntimeLabel(status) {
  const labels = {
    unavailable: "No disponible",
    not_configured: "Sin compose",
    starting: "Iniciando",
    stopping: "Deteniendo",
    restarting: "Reiniciando",
    checking: "Validando",
    running: "Corriendo",
    degraded: "Con errores",
    stale: "Obsoleto",
    error: "Error",
    stopped: "Apagado",
    unknown: "Sin datos"
  };
  return labels[status] || "Sin datos";
}

function runtimeFreshness(runtime, currentFingerprint, isRunning) {
  const checkedAt = nowIso();
  const last = runtime.lastDeployment || null;
  if (!currentFingerprint) {
    return {
      status: "unknown",
      checkedAt,
      message: "No se pudo calcular el fingerprint actual del proyecto.",
      expected: "",
      current: ""
    };
  }
  if (!last?.expectedFingerprint) {
    return {
      status: isRunning ? "unverified" : "pending",
      checkedAt,
      message: isRunning
        ? "Hay runtime activo, pero no existe un deploy registrado con fingerprint esperado. Usar Start para registrarlo."
        : "Todavia no hay deploy local registrado con fingerprint.",
      expected: "",
      current: currentFingerprint.value
    };
  }
  if (last.expectedFingerprint !== currentFingerprint.value) {
    return {
      status: "stale",
      checkedAt,
      message: "El codigo local cambio desde el ultimo deploy exitoso. Usar Start o Rebuild changed components para recrear el runtime.",
      expected: last.expectedFingerprint,
      current: currentFingerprint.value
    };
  }
  return {
    status: last.verificationStatus || "matched",
    checkedAt,
    message: last.verificationMessage || "El fingerprint local coincide con el ultimo deploy registrado.",
    expected: last.expectedFingerprint,
    current: currentFingerprint.value
  };
}

function publicSourceFingerprint(fingerprint) {
  if (!fingerprint) return null;
  return {
    algorithm: fingerprint.algorithm,
    value: fingerprint.value,
    short: fingerprint.value ? fingerprint.value.replace(/^sha256:/, "").slice(0, 12) : "",
    generatedAt: fingerprint.generatedAt,
    filesHashed: fingerprint.filesHashed,
    bytesHashed: fingerprint.bytesHashed,
    skippedFiles: fingerprint.skippedFiles,
    sampleFiles: fingerprint.sampleFiles || []
  };
}

function publicGitStatus(git) {
  if (!git) return null;
  return {
    isGit: Boolean(git.isGit),
    root: git.root || "",
    branch: git.branch || "",
    commit: git.commit || "",
    shortCommit: git.shortCommit || shortHash(git.commit),
    detachedHead: Boolean(git.detachedHead),
    lastCommit: git.lastCommit || null,
    remote: git.remote || "",
    remoteProvider: git.remoteProvider || inferGitRemoteProvider(git.remote || ""),
    tags: Array.isArray(git.tags) ? git.tags.slice(0, 20) : [],
    currentTag: git.currentTag || (Array.isArray(git.tags) ? git.tags[0] || "" : ""),
    upstream: git.upstream || "",
    ahead: git.ahead || 0,
    behind: git.behind || 0,
    dirty: Boolean(git.dirty),
    clean: !Boolean(git.dirty),
    modified: git.modified || 0,
    added: git.added || 0,
    deleted: git.deleted || 0,
    untracked: git.untracked || 0,
    conflicted: git.conflicted || 0,
    changes: Array.isArray(git.changes) ? git.changes.slice(0, 50) : [],
    operation: git.operation || "normal",
    lastPullAt: git.lastPullAt || "",
    pullEvidence: git.pullEvidence || "",
    refreshedAt: git.refreshedAt || ""
  };
}

function publicDeploymentSnapshot(snapshot) {
  if (!snapshot) return null;
  const git = snapshot.git || null;
  return {
    id: snapshot.id,
    action: snapshot.action,
    status: snapshot.status,
    strategy: snapshot.strategy,
    startedAt: snapshot.startedAt,
    finishedAt: snapshot.finishedAt,
    lastBuildAt: snapshot.finishedAt || "",
    expectedFingerprint: snapshot.expectedFingerprint,
    expectedFingerprintShort: snapshot.expectedFingerprint ? snapshot.expectedFingerprint.replace(/^sha256:/, "").slice(0, 12) : "",
    runtimeReportedFingerprint: snapshot.runtimeReportedFingerprint || "",
    verificationStatus: snapshot.verificationStatus || "unknown",
    verificationMessage: snapshot.verificationMessage || "",
    git,
    branch: git?.branch || "",
    commit: git?.commit || "",
    shortCommit: git?.shortCommit || shortHash(git?.commit),
    tag: git?.currentTag || git?.tags?.[0] || "",
    remote: git?.remote || "",
    pullResult: snapshot.pullResult || null,
    composeFile: snapshot.composeFile || "",
    composeProject: snapshot.composeProject || "",
    resources: snapshot.resources || []
  };
}

async function platformVersionsOverview() {
  const projects = await Promise.all(state.projects.map((project) => projectVersionOverview(project)));
  const counts = {
    projects: projects.length,
    gitRepositories: projects.filter((item) => item.repository.isGit).length,
    nonGit: projects.filter((item) => !item.repository.isGit).length,
    clean: projects.filter((item) => item.repository.isGit && item.repository.clean).length,
    dirty: projects.filter((item) => item.repository.dirty).length,
    behindRemote: projects.filter((item) => (item.remote.behind || 0) > 0).length,
    aheadRemote: projects.filter((item) => (item.remote.ahead || 0) > 0).length,
    noDeployment: projects.filter((item) => !item.deployed.commit && !item.deployed.sourceFingerprint).length,
    staleDeployedVersions: projects.filter((item) => item.differences.localVsEnvironment.deployedMismatch).length
  };
  const status = counts.staleDeployedVersions
    ? "STALE_DEPLOYMENTS"
    : counts.dirty || counts.behindRemote || counts.aheadRemote
      ? "CHANGES_DETECTED"
      : "CONFIGURED_AND_VERIFIED";
  return {
    environment: "local",
    phase: "Fase 11",
    contract: "git-version-management.v1",
    generatedAt: nowIso(),
    status,
    counts,
    guardrails: versionGuardrails(),
    actions: platformVersionActions(),
    projects: projects.map((item) => ({
      projectId: item.projectId,
      projectSlug: item.projectSlug,
      displayName: item.displayName,
      status: item.status,
      branch: item.current.branch,
      commit: item.current.shortCommit,
      tag: item.current.tag,
      remote: item.remote.remote,
      clean: item.repository.clean,
      deployedCommit: item.deployed.shortCommit,
      deployedBranch: item.deployed.branch,
      lastPullAt: item.repository.lastPullAt,
      lastBuildAt: item.deployed.lastBuildAt,
      deployedMismatch: item.differences.localVsEnvironment.deployedMismatch,
      localRemoteStatus: item.differences.localVsRemote.status,
      localEnvironmentStatus: item.differences.localVsEnvironment.status
    }))
  };
}

async function projectVersionOverview(project, discovered = null) {
  const resolved = discovered || await discoverRepository(project.repositoryPath).catch(() => null);
  const runtime = await localRuntimeSummary(project, resolved).catch((error) => ({
    status: "unavailable",
    label: "No disponible",
    explanation: sanitizeText(error.message),
    profiles: [],
    git: publicGitStatus(resolved?.git),
    sourceFingerprint: null,
    lastDeployment: null,
    freshness: { status: "unknown", message: sanitizeText(error.message) }
  }));
  const git = runtime.git || publicGitStatus(resolved?.git) || { isGit: false, clean: false, changes: [] };
  const deployment = runtime.lastDeployment || null;
  const current = currentVersionSnapshot(git, runtime.sourceFingerprint);
  const deployed = deployedVersionSnapshot(deployment);
  const localVsRemote = versionLocalRemoteDiff(git);
  const localVsEnvironment = versionLocalEnvironmentDiff(current, deployed, runtime.freshness || {});
  const changes = versionDetectedChanges(git, current, deployed, localVsRemote, localVsEnvironment);
  const status = projectVersionStatus(git, deployment, localVsRemote, localVsEnvironment);
  return {
    projectId: project.id,
    projectSlug: project.slug,
    displayName: project.displayName,
    environment: "local",
    phase: "Fase 11",
    contract: "git-version-management.v1",
    generatedAt: nowIso(),
    status,
    repository: {
      isGit: Boolean(git.isGit),
      clean: Boolean(git.isGit) && !Boolean(git.dirty),
      dirty: Boolean(git.dirty),
      root: git.root || "",
      branch: git.branch || "",
      commit: git.commit || "",
      shortCommit: git.shortCommit || shortHash(git.commit),
      tag: git.currentTag || git.tags?.[0] || "",
      tags: git.tags || [],
      detachedHead: Boolean(git.detachedHead),
      remote: git.remote || "",
      remoteProvider: git.remoteProvider || inferGitRemoteProvider(git.remote || ""),
      upstream: git.upstream || "",
      operation: git.operation || "normal",
      lastPullAt: git.lastPullAt || "",
      pullEvidence: git.pullEvidence || "",
      lastBuildAt: deployed.lastBuildAt || "",
      refreshedAt: git.refreshedAt || ""
    },
    current,
    remote: {
      remote: git.remote || "",
      provider: git.remoteProvider || inferGitRemoteProvider(git.remote || ""),
      upstream: git.upstream || "",
      ahead: git.ahead || 0,
      behind: git.behind || 0,
      status: localVsRemote.status,
      lastPullAt: git.lastPullAt || "",
      pullEvidence: git.pullEvidence || ""
    },
    deployed,
    differences: {
      localVsRemote,
      localVsEnvironment,
      staleDeployedVersion: localVsEnvironment.deployedMismatch
    },
    changes,
    runtime: {
      status: runtime.status || "unknown",
      label: runtime.label || "",
      explanation: runtime.explanation || "",
      composeFile: runtime.composeFile || "",
      composeProject: runtime.composeProject || "",
      profiles: runtime.profiles || [],
      freshness: runtime.freshness || null,
      sourceFingerprint: runtime.sourceFingerprint || null,
      lastDeployment: deployment,
      volumePolicy: versionVolumePolicy(project)
    },
    guardrails: versionGuardrails(project),
    actions: versionActionCatalog(project, runtime)
  };
}

function currentVersionSnapshot(git = {}, sourceFingerprint = null) {
  return {
    isGit: Boolean(git.isGit),
    branch: git.detachedHead ? "detached HEAD" : git.branch || "",
    commit: git.commit || "",
    shortCommit: git.shortCommit || shortHash(git.commit),
    tag: git.currentTag || git.tags?.[0] || "",
    remote: git.remote || "",
    dirty: Boolean(git.dirty),
    clean: Boolean(git.isGit) && !Boolean(git.dirty),
    operation: git.operation || "normal",
    sourceFingerprint: sourceFingerprint || null,
    sourceFingerprintShort: sourceFingerprint?.short || fingerprintShortFromValue(sourceFingerprint?.value)
  };
}

function deployedVersionSnapshot(deployment) {
  const git = deployment?.git || null;
  return {
    exists: Boolean(deployment),
    action: deployment?.action || "",
    status: deployment?.status || "",
    strategy: deployment?.strategy || "",
    branch: deployment?.branch || git?.branch || "",
    commit: deployment?.commit || git?.commit || "",
    shortCommit: deployment?.shortCommit || git?.shortCommit || shortHash(git?.commit),
    tag: deployment?.tag || git?.currentTag || git?.tags?.[0] || "",
    remote: deployment?.remote || git?.remote || "",
    sourceFingerprint: deployment?.expectedFingerprint || "",
    sourceFingerprintShort: deployment?.expectedFingerprintShort || fingerprintShortFromValue(deployment?.expectedFingerprint),
    runtimeReportedFingerprint: deployment?.runtimeReportedFingerprint || "",
    verificationStatus: deployment?.verificationStatus || "unknown",
    verificationMessage: deployment?.verificationMessage || "",
    deployedAt: deployment?.finishedAt || "",
    lastBuildAt: deployment?.lastBuildAt || deployment?.finishedAt || "",
    composeFile: deployment?.composeFile || "",
    composeProject: deployment?.composeProject || "",
    resources: deployment?.resources || []
  };
}

function versionLocalRemoteDiff(git = {}) {
  if (!git?.isGit) {
    return {
      status: "NOT_GIT",
      ahead: 0,
      behind: 0,
      dirty: false,
      changedFiles: 0,
      summary: "El proyecto no es repositorio Git.",
      changes: []
    };
  }
  const ahead = git.ahead || 0;
  const behind = git.behind || 0;
  const changedFiles = gitChangedFileCount(git);
  let status = "IN_SYNC";
  if (!git.upstream) status = "NO_UPSTREAM";
  else if (ahead && behind) status = "DIVERGED";
  else if (behind) status = "REMOTE_AHEAD";
  else if (ahead) status = "LOCAL_AHEAD";
  if (git.dirty) status = status === "IN_SYNC" ? "LOCAL_CHANGES" : `${status}_WITH_LOCAL_CHANGES`;
  const parts = [];
  if (ahead) parts.push(`${ahead} commit(s) ahead`);
  if (behind) parts.push(`${behind} commit(s) behind`);
  if (changedFiles) parts.push(`${changedFiles} archivo(s) locales cambiados`);
  return {
    status,
    ahead,
    behind,
    dirty: Boolean(git.dirty),
    changedFiles,
    summary: parts.join(" · ") || (git.upstream ? "Local y remoto sin diferencias detectadas." : "No hay upstream configurado para comparar remoto."),
    changes: git.changes || []
  };
}

function versionLocalEnvironmentDiff(current, deployed, freshness = {}) {
  if (!deployed.exists) {
    return {
      status: "NO_DEPLOYMENT_RECORDED",
      deployedMismatch: false,
      commitMismatch: false,
      branchMismatch: false,
      fingerprintMismatch: false,
      runtimeFreshness: freshness.status || "unknown",
      currentFingerprint: current.sourceFingerprint?.value || "",
      deployedFingerprint: "",
      summary: "No hay commit desplegado registrado para comparar contra el repositorio local."
    };
  }
  const commitMismatch = Boolean(current.commit && deployed.commit && current.commit !== deployed.commit);
  const branchMismatch = Boolean(current.branch && deployed.branch && current.branch !== deployed.branch);
  const currentFingerprint = current.sourceFingerprint?.value || "";
  const deployedFingerprint = deployed.sourceFingerprint || "";
  const fingerprintMismatch = Boolean(currentFingerprint && deployedFingerprint && currentFingerprint !== deployedFingerprint);
  const deployedMismatch = commitMismatch || fingerprintMismatch || freshness.status === "stale";
  const status = deployedMismatch ? "MISMATCH" : "MATCHED";
  const parts = [];
  if (commitMismatch) parts.push(`commit actual ${current.shortCommit || "sin datos"} != deploy ${deployed.shortCommit || "sin datos"}`);
  if (fingerprintMismatch) parts.push(`fingerprint actual ${current.sourceFingerprintShort || "sin datos"} != deploy ${deployed.sourceFingerprintShort || "sin datos"}`);
  if (branchMismatch) parts.push(`rama activa ${current.branch || "sin datos"} != rama deploy ${deployed.branch || "sin datos"}`);
  return {
    status,
    deployedMismatch,
    commitMismatch,
    branchMismatch,
    fingerprintMismatch,
    runtimeFreshness: freshness.status || "unknown",
    currentFingerprint,
    deployedFingerprint,
    summary: parts.join(" · ") || "La version local coincide con el ultimo runtime registrado."
  };
}

function versionDetectedChanges(git, current, deployed, localVsRemote, localVsEnvironment) {
  const changedFiles = gitChangedFileCount(git);
  const rebuildRequired = !deployed.exists || localVsEnvironment.fingerprintMismatch || localVsEnvironment.status === "NO_DEPLOYMENT_RECORDED";
  const status = changedFiles || localVsRemote.ahead || localVsRemote.behind || localVsEnvironment.deployedMismatch
    ? "CHANGES_DETECTED"
    : "NO_CHANGES";
  return {
    status,
    rebuildRequired,
    changedFiles,
    dirty: Boolean(git?.dirty),
    ahead: localVsRemote.ahead || 0,
    behind: localVsRemote.behind || 0,
    currentCommit: current.shortCommit || "",
    deployedCommit: deployed.shortCommit || "",
    currentFingerprint: current.sourceFingerprintShort || "",
    deployedFingerprint: deployed.sourceFingerprintShort || "",
    summary: changeSummary(git, localVsRemote, localVsEnvironment, rebuildRequired),
    files: git?.changes || []
  };
}

function projectVersionStatus(git, deployment, localVsRemote, localVsEnvironment) {
  if (!git?.isGit) return "NOT_GIT";
  if (git.operation && git.operation !== "normal") return "GIT_OPERATION_IN_PROGRESS";
  if (localVsEnvironment.deployedMismatch) return "DEPLOYED_VERSION_STALE";
  if (!deployment) return "NO_DEPLOYMENT_RECORDED";
  if (localVsRemote.dirty || localVsRemote.ahead || localVsRemote.behind) return "CHANGES_DETECTED";
  return "CONFIGURED_AND_VERIFIED";
}

function changeSummary(git, localVsRemote, localVsEnvironment, rebuildRequired) {
  const parts = [];
  if (git?.dirty) parts.push(localChangeSummaryText(git));
  if (localVsRemote.ahead || localVsRemote.behind) parts.push(localVsRemote.summary);
  if (localVsEnvironment.deployedMismatch) parts.push(localVsEnvironment.summary);
  if (!parts.length) parts.push("No se detectaron cambios locales, remotos o de ambiente.");
  if (rebuildRequired) parts.push("Rebuild necesario para probar el commit/fingerprint actual.");
  return parts.filter(Boolean).join(" ");
}

function localChangeSummaryText(git = {}) {
  const parts = [];
  if (git.modified) parts.push(`${git.modified} modificado(s)`);
  if (git.added) parts.push(`${git.added} agregado(s)`);
  if (git.deleted) parts.push(`${git.deleted} eliminado(s)`);
  if (git.untracked) parts.push(`${git.untracked} no trackeado(s)`);
  if (git.conflicted) parts.push(`${git.conflicted} conflicto(s)`);
  return parts.join(", ") || "sin cambios locales";
}

function gitChangedFileCount(git = {}) {
  return (git.modified || 0) + (git.added || 0) + (git.deleted || 0) + (git.untracked || 0) + (git.conflicted || 0);
}

function fingerprintShortFromValue(value) {
  return value ? String(value).replace(/^sha256:/, "").slice(0, 12) : "";
}

function versionGuardrails(project = null) {
  return {
    arbitraryCommands: "blocked",
    runtimeProfiles: "closed-catalog-only",
    pullMode: "git pull --ff-only after clean worktree check",
    rebuildScope: "source-fingerprint-driven",
    defaultVolumePolicy: "preserve",
    volumeDeletion: "requires_explicit_confirmation",
    volumeConfirmationText: project ? volumeDeletionConfirmation(project) : "DELETE VOLUMES <project-slug>",
    obsoleteImages: "avoid_by_forcing_build_when_source_fingerprint_changes",
    cleanRebuild: "forces build/recreate but preserves volumes unless explicit volume delete confirmation is sent"
  };
}

function versionVolumePolicy(project) {
  return {
    default: "preserve",
    cleanRebuildPreservesVolumes: true,
    deleteVolumesEndpoint: `/api/v1/projects/${project.id}/runtime/volumes/delete`,
    confirmationRequired: true,
    confirmationText: volumeDeletionConfirmation(project),
    destructive: true
  };
}

function volumeDeletionConfirmation(project) {
  return `DELETE VOLUMES ${project.slug}`;
}

function versionActionCatalog(project, runtime = {}) {
  const profiles = new Set((runtime.profiles || []).map((profile) => profile.action));
  return phase11RuntimeActions.map((action) => {
    const isReadOnly = action === "view-changes";
    const base = isReadOnly ? "changes" : baseRuntimeAction(action);
    const enabled = isReadOnly
      ? true
      : base === "restart"
        ? profiles.has("restart") || (profiles.has("start") && profiles.has("stop"))
        : profiles.has(base);
    return {
      id: action,
      label: phase11ActionLabel(action),
      method: isReadOnly ? "GET" : "POST",
      path: isReadOnly
        ? `/api/v1/projects/${project.id}/runtime/changes`
        : `/api/v1/projects/${project.id}/runtime/${action}`,
      enabled,
      baseRuntimeAction: base,
      preservesVolumes: true,
      destructive: false,
      rebuild: phase11ActionRebuildMode(action),
      summary: phase11ActionSummary(action)
    };
  });
}

function platformVersionActions() {
  return phase11RuntimeActions
    .filter((action) => action !== "view-changes")
    .map((action) => ({
      id: `${action}-all`,
      label: `${phase11ActionLabel(action)} all`,
      method: "POST",
      path: `/api/v1/runtime/${action}-all`,
      destructive: false,
      preservesVolumes: true
    }));
}

function phase11ActionLabel(action) {
  const labels = {
    start: "Start",
    restart: "Restart",
    "rebuild-changed": "Rebuild changed components",
    "clean-rebuild": "Clean rebuild",
    "pull-rebuild": "Pull and rebuild",
    stop: "Stop",
    "view-changes": "View detected changes"
  };
  return labels[action] || action;
}

function phase11ActionRebuildMode(action) {
  if (action === "rebuild-changed") return "only_when_source_fingerprint_changed";
  if (action === "clean-rebuild") return "forced_build_and_recreate";
  if (action === "pull-rebuild") return "pull_ff_only_then_forced_build";
  if (action === "start") return "smart";
  if (action === "restart") return "smart_restart";
  return "none";
}

function phase11ActionSummary(action) {
  const summaries = {
    start: "Inicia el runtime e informa commit/rama; reconstruye solo si no hay deploy previo o cambio el fingerprint.",
    restart: "Detiene e inicia con el fingerprint actual, reconstruyendo solo si corresponde.",
    "rebuild-changed": "Recalcula cambios y reconstruye componentes solo cuando la huella de fuente difiere del ultimo deploy.",
    "clean-rebuild": "Fuerza build y recreacion de contenedores preservando volumenes por defecto.",
    "pull-rebuild": "Exige worktree limpio, hace fetch/pull fast-forward y fuerza build para evitar imagenes obsoletas.",
    stop: "Detiene el runtime local preservando volumenes.",
    "view-changes": "Refresca Git, remoto, fingerprint y diferencias contra el ambiente sin efectos laterales."
  };
  return summaries[action] || action;
}

async function projectRuntimeChanges(project) {
  const overview = await projectVersionOverview(project);
  return {
    project: project.slug,
    phase: overview.phase,
    contract: overview.contract,
    generatedAt: overview.generatedAt,
    status: overview.changes.status,
    current: overview.current,
    remote: overview.remote,
    deployed: overview.deployed,
    differences: overview.differences,
    changes: overview.changes,
    guardrails: overview.guardrails,
    actions: overview.actions.filter((action) => action.id === "view-changes" || action.id === "rebuild-changed")
  };
}

async function dockerStatus() {
  const result = await runCommandCapture("docker", ["version", "--format", "{{.Server.Version}}"], repoRoot, { timeoutMs: 5000 });
  if (result.exitCode === 0) return { available: true, version: result.stdout.trim() };
  return {
    available: false,
    reason: sanitizeText(result.stderr || result.stdout || "docker version failed")
  };
}

async function resolveComposeSpec(project, abs, discovered = null, resources = []) {
  const running = resources.find((resource) => resource.composeFiles?.length);
  const candidates = await detectComposeCandidates(abs, discovered);
  const runningFile = running?.composeFiles
    ?.map((file) => path.resolve(file))
    .find((file) => file && fsSync.existsSync(file) && (file === abs || file.startsWith(`${abs}${path.sep}`)));
  const absolutePath = runningFile || candidates[0]?.absolutePath || "";
  if (!absolutePath) return null;
  const relativePath = path.relative(abs, absolutePath);
  const config = await composeConfig(project, abs, absolutePath).catch(() => null);
  const configuredName = String(config?.name || "").trim();
  const projectName = running?.composeProject || configuredName || safeComposeProjectName(project.slug);
  return {
    absolutePath,
    relativePath,
    projectName,
    config
  };
}

async function detectComposeCandidates(abs, discovered = null) {
  const preferred = [
    "docker-compose-fullstack.yml",
    "docker-compose.fullstack.yml",
    "docker-compose.local.yml",
    "docker-compose.dev.yml",
    "compose.yaml",
    "compose.yml",
    "docker-compose.yml",
    "docker-compose.yaml",
    path.join("infrastructure", "docker", "docker-compose.yml"),
    path.join("infrastructure", "docker", "docker-compose.yaml")
  ];
  const candidates = [];
  for (const name of preferred) {
    const absolutePath = path.join(abs, name);
    if (fsSync.existsSync(absolutePath)) candidates.push({ absolutePath, relativePath: name, score: preferred.indexOf(name) });
  }
  for (const relativePath of discovered?.manifests || []) {
    const name = path.basename(relativePath);
    if (!/^compose\.ya?ml$/i.test(name) && !/^docker-compose[\w.-]*\.ya?ml$/i.test(name)) continue;
    const absolutePath = path.join(abs, relativePath);
    if (fsSync.existsSync(absolutePath)) {
      candidates.push({ absolutePath, relativePath, score: preferred.includes(name) ? preferred.indexOf(name) : 50 + relativePath.split(path.sep).length });
    }
  }
  const seen = new Set();
  return candidates
    .filter((candidate) => {
      if (seen.has(candidate.absolutePath)) return false;
      seen.add(candidate.absolutePath);
      return true;
    })
    .sort((a, b) => a.score - b.score || a.relativePath.localeCompare(b.relativePath));
}

async function composeConfig(project, abs, composeFile, extraEnv = {}) {
  const result = await runCommandCapture(
    "docker",
    [...composeBaseArgs({ absolutePath: composeFile, projectName: safeComposeProjectName(project.slug) }), "config", "--format", "json"],
    abs,
    { timeoutMs: 15000, env: { ...process.env, ...projectRuntimeEnv(project), ...extraEnv } }
  );
  if (result.exitCode !== 0) throw problem(422, "COMPOSE_CONFIG_FAILED", result.stderr || result.stdout || "docker compose config failed");
  return JSON.parse(result.stdout || "{}");
}

function safeComposeProjectName(slug) {
  return `qhub-${slugify(slug) || "project"}`.slice(0, 60);
}

function composeBaseArgs(spec) {
  const args = ["compose", "-f", spec.absolutePath];
  if (spec.projectName) args.push("-p", spec.projectName);
  return args;
}

function runtimeDefaultEnv(project) {
  const slug = project.slug;
  if (slug === "chedoparti-react-app") {
    return {
      LOCAL_RUN_BUILD: "0",
      SKIP_MOBILE: "1",
      BACKEND_HEALTH_URL: `http://${runtimeWaitHost}:8080/api/v1/actuator/health/readiness`,
      GATEWAY_HEALTH_URL: `http://${runtimeWaitHost}:8989/actuator/health/readiness`,
      FRONTEND_URL: `http://${runtimeWaitHost}:5173/`,
      ATHLO_WEB_URL: `http://${runtimeWaitHost}:3002/`
    };
  }
  if (slug === "maria-belen-labarque-ceramic") {
    return {
      LOCAL_RUN_BUILD: "0",
      FRONTEND_PORT: "12000",
      STRAPI_PORT: "11337",
      POSTGRES_PORT: "15440",
      MAILPIT_SMTP_PORT: "11025",
      MAILPIT_UI_PORT: "18025",
      GRAFANA_PORT: "13001",
      PROMETHEUS_PORT: "19091",
      LOKI_PORT: "13101",
      TEMPO_PORT: "13201",
      OTEL_GRPC_PORT: "14321",
      OTEL_HTTP_PORT: "14322",
      CADVISOR_PORT: "18082",
      NODE_EXPORTER_PORT: "19100",
      POSTGRES_EXPORTER_PORT: "19187",
      LOCAL_HOST: runtimeWaitHost,
      NEXT_PUBLIC_STRAPI_URL: "http://localhost:11337",
      NEXT_PUBLIC_SITE_URL: "http://localhost:12000",
      CORS_ORIGINS: "http://localhost:12000,http://localhost:11337"
    };
  }
  if (slug === "sistema-dietetica") {
    return {
      LOCAL_RUN_BUILD: "0",
      WEB_PORT: "15173",
      BACKEND_PORT: "18083",
      POSTGRES_PORT: "15441",
      REDIS_PORT: "16380",
      MAILPIT_SMTP_PORT: "11026",
      MAILPIT_UI_PORT: "18026",
      GRAFANA_PORT: "13002",
      PROMETHEUS_PORT: "19092",
      LOCAL_HOST: runtimeWaitHost,
      APP_FRONTEND_URL: "http://localhost:15173",
      APP_SECURITY_ALLOWED_ORIGINS: "http://localhost:15173",
      VITE_API_URL: "http://localhost:18083/api/v1",
      SMOKE_BACKEND_URL: `http://${runtimeWaitHost}:18083`,
      SMOKE_API_URL: `http://${runtimeWaitHost}:18083/api/v1`,
      SMOKE_FRONTEND_URL: `http://${runtimeWaitHost}:15173`
    };
  }
  if (slug === "giftfinder-proyect") {
    return {
      LOCAL_RUN_BUILD: "0",
      FRONTEND_PORT: "15174",
      BACKEND_PORT: "18084",
      SCRAPER_PORT: "18085",
      OLLAMA_PORT: "11435",
      POSTGRES_PORT: "15442",
      LOCAL_HOST: runtimeWaitHost,
      VITE_API_URL: "http://localhost:18084",
      CORS_ALLOWED_ORIGINS: "http://localhost:15174",
      APP_API_BASE_URL: "http://localhost:18084",
      BACKEND_URL: `http://${runtimeWaitHost}:18084`,
      FRONTEND_URL: `http://${runtimeWaitHost}:15174`,
      SCRAPER_URL: `http://${runtimeWaitHost}:18085`,
      OLLAMA_URL: `http://${runtimeWaitHost}:11435`
    };
  }
  if (slug === "panorama-mercados") {
    return {
      LOCAL_RUN_BUILD: "0",
      PORT: "12001",
      LOCAL_HOST: runtimeWaitHost,
      POSTGRES_PORT: "15443",
      REDIS_PORT: "16381"
    };
  }
  return {};
}

function runtimeTarget(action, command, args, cwd, options = {}) {
  return {
    action,
    command,
    args,
    cwd,
    env: options.env || {},
    source: options.source || command,
    label: options.label || `${command} ${args.join(" ")}`
  };
}

function forceBuildRuntimeTarget(target) {
  const args = [...target.args].filter((arg) => arg !== "--no-build");
  if (target.command === "docker") {
    const upIndex = args.findIndex((arg) => arg === "up");
    if (upIndex >= 0 && !args.includes("--build")) {
      args.splice(upIndex + 1, 0, "--build");
    }
    if (upIndex >= 0 && !args.includes("--force-recreate")) {
      args.splice(upIndex + 1, 0, "--force-recreate");
    }
  }
  return {
    ...target,
    args,
    env: { ...target.env, LOCAL_RUN_BUILD: "1" },
    label: `${target.label} (rebuild)`
  };
}

function addRuntimeTarget(map, target) {
  if (!target || !allowedRuntimeActions.has(target.action) || map.has(target.action)) return;
  map.set(target.action, target);
}

async function packageScripts(abs) {
  const pkg = await readJsonIfExists(path.join(abs, "package.json"));
  return pkg?.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
}

function scriptExists(abs, relativePath) {
  return fsSync.existsSync(path.join(abs, relativePath));
}

async function runtimeCommandProfiles(project, abs, runtimeAbs, discovered = null, spec = null) {
  const env = { ...runtimeDefaultEnv(project), ...projectRuntimeEnv(project) };
  const profiles = new Map();
  const scripts = await packageScripts(runtimeAbs);

  if (project.slug === "chedoparti-react-app" && scriptExists(runtimeAbs, "scripts/local-fullstack.sh")) {
    const source = "scripts/local-fullstack.sh";
    addRuntimeTarget(profiles, runtimeTarget("start", "bash", [source, "up", "--no-build"], runtimeAbs, { env, source, label: "Fullstack local sin mobile" }));
    addRuntimeTarget(profiles, runtimeTarget("stop", "bash", [source, "down"], runtimeAbs, { env, source, label: "Detener fullstack local" }));
    addRuntimeTarget(profiles, runtimeTarget("status", "bash", [source, "status"], runtimeAbs, { env, source, label: "Estado fullstack local" }));
    addRuntimeTarget(profiles, runtimeTarget("logs", "bash", [source, "logs"], runtimeAbs, { env, source, label: "Logs fullstack local" }));
    addRuntimeTarget(profiles, runtimeTarget("smoke", "bash", [source, "status"], runtimeAbs, { env, source, label: "Smoke/status fullstack local" }));
  }

  if (project.slug === "maria-belen-labarque-ceramic" && scripts["local:up"]) {
    addRuntimeTarget(profiles, runtimeTarget("start", "npm", ["run", "local:up"], runtimeAbs, { env, source: "package.json#local:up", label: "npm run local:up" }));
    if (scripts["local:down"]) addRuntimeTarget(profiles, runtimeTarget("stop", "npm", ["run", "local:down"], runtimeAbs, { env, source: "package.json#local:down", label: "npm run local:down" }));
    if (scripts["local:status"]) addRuntimeTarget(profiles, runtimeTarget("status", "npm", ["run", "local:status"], runtimeAbs, { env, source: "package.json#local:status", label: "npm run local:status" }));
    if (scripts["local:logs"]) addRuntimeTarget(profiles, runtimeTarget("logs", "npm", ["run", "local:logs"], runtimeAbs, { env, source: "package.json#local:logs", label: "npm run local:logs" }));
    if (scripts["local:smoke"]) addRuntimeTarget(profiles, runtimeTarget("smoke", "npm", ["run", "local:smoke"], runtimeAbs, { env, source: "package.json#local:smoke", label: "npm run local:smoke" }));
  }

  if (project.slug === "sistema-dietetica" && scriptExists(runtimeAbs, "scripts/local-fullstack.sh")) {
    const source = "scripts/local-fullstack.sh";
    addRuntimeTarget(profiles, runtimeTarget("start", "bash", [source, "up"], runtimeAbs, { env, source, label: "Fullstack local Sistema Dietetica" }));
    addRuntimeTarget(profiles, runtimeTarget("stop", "bash", [source, "down"], runtimeAbs, { env, source, label: "Detener fullstack local" }));
    addRuntimeTarget(profiles, runtimeTarget("status", "bash", [source, "status"], runtimeAbs, { env, source, label: "Estado fullstack local" }));
    addRuntimeTarget(profiles, runtimeTarget("logs", "bash", [source, "logs"], runtimeAbs, { env, source, label: "Logs fullstack local" }));
    addRuntimeTarget(profiles, runtimeTarget("smoke", "bash", [source, "smoke"], runtimeAbs, { env, source, label: "Smoke fullstack local" }));
  }

  if (project.slug === "giftfinder-proyect" && scriptExists(runtimeAbs, "scripts/run-local.sh")) {
    const source = "scripts/run-local.sh";
    addRuntimeTarget(profiles, runtimeTarget("start", "bash", [source, "up"], runtimeAbs, { env, source, label: "Run local Giftfinder" }));
    addRuntimeTarget(profiles, runtimeTarget("stop", "bash", [source, "down"], runtimeAbs, { env, source, label: "Detener Giftfinder local" }));
    addRuntimeTarget(profiles, runtimeTarget("status", "bash", [source, "status"], runtimeAbs, { env, source, label: "Estado Giftfinder local" }));
    addRuntimeTarget(profiles, runtimeTarget("logs", "bash", [source, "logs"], runtimeAbs, { env, source, label: "Logs Giftfinder local" }));
    addRuntimeTarget(profiles, runtimeTarget("smoke", "bash", [source, "smoke"], runtimeAbs, { env, source, label: "Smoke Giftfinder local" }));
  }

  if (project.slug === "panorama-mercados" && scriptExists(runtimeAbs, "scripts/local-docker.sh")) {
    const source = "scripts/local-docker.sh";
    addRuntimeTarget(profiles, runtimeTarget("start", "bash", [source, "up"], runtimeAbs, { env, source, label: "Docker local Panorama" }));
    addRuntimeTarget(profiles, runtimeTarget("stop", "bash", [source, "down"], runtimeAbs, { env, source, label: "Detener Panorama local" }));
    addRuntimeTarget(profiles, runtimeTarget("status", "bash", [source, "status"], runtimeAbs, { env, source, label: "Estado Panorama local" }));
    addRuntimeTarget(profiles, runtimeTarget("logs", "bash", [source, "logs"], runtimeAbs, { env, source, label: "Logs Panorama local" }));
    addRuntimeTarget(profiles, runtimeTarget("smoke", "bash", [source, "smoke"], runtimeAbs, { env, source, label: "Smoke Panorama local" }));
  }

  if (spec) {
    addRuntimeTarget(profiles, runtimeTarget("start", "docker", [...composeBaseArgs(spec), "up", "-d", "--remove-orphans"], runtimeAbs, { env, source: spec.relativePath, label: `Compose up ${spec.relativePath}` }));
    addRuntimeTarget(profiles, runtimeTarget("stop", "docker", [...composeBaseArgs(spec), "down", "--remove-orphans"], runtimeAbs, { env, source: spec.relativePath, label: `Compose down ${spec.relativePath}` }));
    addRuntimeTarget(profiles, runtimeTarget("status", "docker", [...composeBaseArgs(spec), "ps"], runtimeAbs, { env, source: spec.relativePath, label: `Compose ps ${spec.relativePath}` }));
    addRuntimeTarget(profiles, runtimeTarget("logs", "docker", [...composeBaseArgs(spec), "logs", "--tail", "120"], runtimeAbs, { env, source: spec.relativePath, label: `Compose logs ${spec.relativePath}` }));
  } else {
    await detectComposeCandidates(runtimeAbs, discovered);
  }

  if (profiles.has("start") && profiles.has("stop")) {
    addRuntimeTarget(profiles, runtimeTarget("restart", "internal", ["stop", "start"], runtimeAbs, {
      env,
      source: "internal",
      label: "Restart = stop + start"
    }));
  }

  return profiles;
}

async function runtimeProfiles(project, abs, runtimeAbs, discovered = null, spec = null) {
  const profiles = await runtimeCommandProfiles(project, abs, runtimeAbs, discovered, spec);
  return [...profiles.values()].map((target) => ({
    action: target.action,
    label: target.label,
    source: target.source,
    cwd: sanitizeText(target.cwd),
    available: true
  }));
}

async function resolveRuntimeTarget(project, action, abs, runtimeAbs, discovered = null, spec = null) {
  const profiles = await runtimeCommandProfiles(project, abs, runtimeAbs, discovered, spec);
  const target = profiles.get(action);
  if (!target || target.command === "internal") {
    throw problem(422, "NO_RUNTIME_PROFILE", `No approved runtime profile for ${action} in ${project.slug}.`);
  }
  return target;
}

async function listProjectContainers(project, abs, runtimeAbs = abs) {
  const result = await runCommandCapture("docker", ["ps", "-a", "--format", "{{json .}}"], repoRoot, { timeoutMs: 8000 });
  if (result.exitCode !== 0) return [];
  const rows = parseDockerJsonLines(result.stdout);
  const markers = [
    abs,
    runtimeAbs,
    project.repositoryPath,
    `/workspace/projects/${project.repositoryPath}`,
    project.slug,
    safeComposeProjectName(project.slug)
  ].filter(Boolean);
  return rows
    .filter((row) => {
      const labels = String(row.Labels || "");
      return labels.includes("com.docker.compose.") && markers.some((marker) => labels.includes(marker));
    })
    .map((row) => dockerRowToResource(row))
    .sort((a, b) => a.service.localeCompare(b.service) || a.name.localeCompare(b.name));
}

function dockerRowToResource(row) {
  const labels = String(row.Labels || "");
  const ports = extractPublishedPorts(String(row.Ports || ""));
  const service = labelValue(labels, "com.docker.compose.service") || row.Names || "service";
  return {
    id: row.ID,
    name: row.Names || row.ID,
    service,
    image: row.Image || "",
    state: String(row.State || "").toLowerCase(),
    status: row.Status || "",
    composeProject: labelValue(labels, "com.docker.compose.project") || "",
    composeFiles: (labelValue(labels, "com.docker.compose.project.config_files") || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    ports,
    urls: resourceUrls(service, ports)
  };
}

function labelValue(labels, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(labels || "").match(new RegExp(`(?:^|,)${escaped}=([^,]+)`));
  return match ? match[1] : "";
}

function parseDockerJsonLines(output) {
  return String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function extractPublishedPorts(text) {
  const ports = [];
  const regex = /(?:0\.0\.0\.0|127\.0\.0\.1|\[::\]):(\d+)(?:-(\d+))?->(\d+)(?:-(\d+))?\/(tcp|udp)/g;
  let match;
  while ((match = regex.exec(text))) {
    const hostStart = Number(match[1]);
    const hostEnd = Number(match[2] || match[1]);
    const targetStart = Number(match[3]);
    const targetEnd = Number(match[4] || match[3]);
    const count = Math.max(1, Math.min(hostEnd - hostStart, targetEnd - targetStart) + 1);
    for (let offset = 0; offset < count; offset += 1) {
      ports.push({
        host: hostStart + offset,
        target: targetStart + offset,
        protocol: match[5]
      });
    }
  }
  return uniquePorts(ports);
}

function uniquePorts(ports) {
  const seen = new Set();
  return ports.filter((port) => {
    const key = `${port.host}:${port.target}:${port.protocol}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resourceUrls(service, ports) {
  if (!ports.length) return [];
  if (/postgres|mariadb|mysql|mongo|redis|database|\bdb\b/i.test(service)) return [];
  const isLikelyHttp = /web|front|back|backend|bff|admin|public|tenant|booking|api|gateway|saas|grafana|prometheus|loki|tempo|mailpit|alert|sonar/i.test(service);
  if (!isLikelyHttp) return [];
  return ports
    .filter((port) => port.protocol === "tcp")
    .map((port) => ({ label: `localhost:${port.host}`, url: `http://localhost:${port.host}` }));
}

async function triggerLocalRuntimeAction(project, action) {
  assertProjectExecutionAllowed(project, securityConfig);
  if (!allowedRuntimeRequestActions.has(action)) {
    throw problem(400, "INVALID_RUNTIME_ACTION", "runtime action must be start, stop, restart, smoke, start-fresh, restart-fresh, rebuild-changed, clean-rebuild or pull-rebuild.");
  }
  if (localRuntimeProcesses.has(project.id)) {
    throw problem(409, "RUNTIME_BUSY", "A local runtime action is already in progress for this project.");
  }

  const abs = await canonicalProjectPath(project.repositoryPath);
  const runtimeAbs = await runtimeProjectPath(project, abs);
  const docker = await dockerStatus();
  if (!docker.available) throw problem(503, "DOCKER_UNAVAILABLE", docker.reason || "Docker CLI is not available.");
  let discovered = await discoverRepository(project.repositoryPath).catch(() => null);
  const resources = await listProjectContainers(project, abs, runtimeAbs).catch(() => []);
  const spec = await resolveComposeSpec(project, runtimeAbs, discovered, resources).catch(() => null);
  const profiles = await runtimeCommandProfiles(project, abs, runtimeAbs, discovered, spec);
  const baseAction = baseRuntimeAction(action);
  if (baseAction === "restart") {
    if (!profiles.has("stop") || !profiles.has("start")) throw problem(422, "NO_RUNTIME_PROFILE", `No approved restart profile for ${project.slug}.`);
  } else if (!profiles.has(baseAction)) {
    throw problem(422, "NO_RUNTIME_PROFILE", `No approved runtime profile for ${baseAction} in ${project.slug}.`);
  }

  const runtime = localRuntimeStore(project);
  let pullResult = null;
  if (action === "pull-rebuild") {
    pullResult = await preparePullAndRebuild(project, abs);
    discovered = await discoverRepository(project.repositoryPath).catch(() => discovered);
  }
  const currentGit = discovered?.git || await gitInfo(abs).catch(() => ({ isGit: false, dirty: false }));
  const sourceFingerprint = await calculateSourceFingerprint(project, runtimeAbs, currentGit, { force: true });
  const executionPlan = runtimeExecutionPlan(action, baseAction, runtime, sourceFingerprint);
  runtime.status = baseAction === "start" ? "starting" : baseAction === "stop" ? "stopping" : baseAction === "restart" ? "restarting" : "checking";
  runtime.action = action;
  runtime.composeFile = spec?.relativePath || runtime.composeFile || "";
  runtime.composeProject = spec?.projectName || runtime.composeProject || safeComposeProjectName(project.slug);
  runtime.error = "";
  runtime.git = publicGitStatus(currentGit);
  runtime.sourceFingerprint = publicSourceFingerprint(sourceFingerprint);
  runtime.pullResult = pullResult;
  runtime.freshness = {
    status: baseAction === "stop" ? "not_applicable" : "deploying",
    checkedAt: nowIso(),
    message: executionPlan.reason,
    expected: runtime.lastDeployment?.expectedFingerprint || "",
    current: sourceFingerprint.value
  };
  runtime.updatedAt = nowIso();
  addRuntimeLog(project, "info", `Runtime ${action} requested using approved profile in ${sanitizeText(runtimeAbs)}.`);
  addRuntimeLog(project, "info", `Git snapshot: ${currentGit?.branch || "no-branch"} ${currentGit?.shortCommit || shortHash(currentGit?.commit) || "no-commit"} dirty=${Boolean(currentGit?.dirty)}.`);
  addRuntimeLog(project, "info", `Source fingerprint: ${sourceFingerprint.value} (${sourceFingerprint.filesHashed} files).`);
  addRuntimeLog(project, "info", `Freshness strategy: ${executionPlan.strategy}. ${executionPlan.reason}`);
  if (executionPlan.forceBuild) {
    addRuntimeLog(project, "info", "Fresh runtime requested: forcing LOCAL_RUN_BUILD=1, --build/--force-recreate and bypassing --no-build where applicable.");
  }
  localRuntimeProcesses.set(project.id, {
    action,
    status: runtime.status,
    startedAt: nowIso(),
    forceBuild: executionPlan.forceBuild,
    strategy: executionPlan.strategy,
    reason: executionPlan.reason,
    git: publicGitStatus(currentGit),
    sourceFingerprint,
    pullResult
  });
  await appendAudit("runtime.action", `${project.slug}:${action}`, "QUEUED", {
    composeFile: spec?.relativePath || "",
    runtimePath: runtimeAbs,
    branch: currentGit?.branch || "",
    commit: currentGit?.commit || "",
    dirty: Boolean(currentGit?.dirty),
    sourceFingerprint: sourceFingerprint.value,
    strategy: executionPlan.strategy,
    pullBefore: pullResult?.before?.shortCommit || "",
    pullAfter: pullResult?.after?.shortCommit || ""
  });

  queueMicrotask(() => executeLocalRuntimeAction(project.id, action, abs, runtimeAbs, spec));
  return localRuntimeSummary(project, discovered);
}

async function preparePullAndRebuild(project, abs) {
  const before = await gitInfo(abs);
  if (!before?.isGit) {
    throw problem(422, "PULL_REBUILD_NOT_GIT", "Pull and rebuild requires a Git repository.");
  }
  if (before.operation && before.operation !== "normal") {
    throw problem(409, "PULL_REBUILD_GIT_OPERATION", `Pull and rebuild blocked because Git operation '${before.operation}' is in progress.`);
  }
  if (before.dirty) {
    throw problem(409, "PULL_REBUILD_DIRTY_WORKTREE", "Pull and rebuild requires a clean working tree. Use View detected changes first and commit/stash changes before pulling.");
  }
  if (!before.upstream) {
    throw problem(409, "PULL_REBUILD_NO_UPSTREAM", "Pull and rebuild requires an upstream branch for fast-forward comparison.");
  }
  addRuntimeLog(project, "info", `Pull and rebuild: fetching upstream for ${before.branch || "detached HEAD"} ${before.shortCommit || ""}.`);
  const fetch = await runCommandCapture("git", ["fetch", "--prune"], abs, { timeoutMs: 60000 });
  if (fetch.exitCode !== 0) {
    throw problem(422, "GIT_FETCH_FAILED", fetch.stderr || fetch.stdout || "git fetch --prune failed.");
  }
  const pull = await runCommandCapture("git", ["pull", "--ff-only"], abs, { timeoutMs: 60000 });
  if (pull.exitCode !== 0) {
    throw problem(409, "GIT_PULL_FF_ONLY_FAILED", pull.stderr || pull.stdout || "git pull --ff-only failed.");
  }
  const after = await gitInfo(abs);
  addRuntimeLog(project, "info", `Pull and rebuild: ${before.shortCommit || "sin commit"} -> ${after.shortCommit || "sin commit"}.`);
  await appendAudit("runtime.git_pull", `${project.slug}:pull-rebuild`, "SUCCEEDED", {
    branch: after.branch || "",
    beforeCommit: before.commit || "",
    afterCommit: after.commit || "",
    lastPullAt: after.lastPullAt || ""
  });
  return {
    before: publicGitStatus(before),
    after: publicGitStatus(after),
    fastForwardOnly: true,
    fetchedAt: after.lastPullAt || nowIso()
  };
}

async function deleteRuntimeVolumes(project, body = {}, correlation = correlationId()) {
  assertProjectExecutionAllowed(project, securityConfig);
  const required = volumeDeletionConfirmation(project);
  if (body.confirmation !== required || body.acknowledgedDataLoss !== true) {
    throw problem(409, "VOLUME_DELETE_CONFIRMATION_REQUIRED", `Volume deletion requires acknowledgedDataLoss=true and confirmation='${required}'.`);
  }
  if (localRuntimeProcesses.has(project.id)) {
    throw problem(409, "RUNTIME_BUSY", "A local runtime action is already in progress for this project.");
  }
  const abs = await canonicalProjectPath(project.repositoryPath);
  const runtimeAbs = await runtimeProjectPath(project, abs);
  const docker = await dockerStatus();
  if (!docker.available) throw problem(503, "DOCKER_UNAVAILABLE", docker.reason || "Docker CLI is not available.");
  const discovered = await discoverRepository(project.repositoryPath).catch(() => null);
  const resources = await listProjectContainers(project, abs, runtimeAbs).catch(() => []);
  const spec = await resolveComposeSpec(project, runtimeAbs, discovered, resources).catch(() => null);
  if (!spec) throw problem(422, "NO_COMPOSE_SPEC", `No Docker Compose spec detected for ${project.slug}.`);
  const target = runtimeTarget("stop", "docker", [...composeBaseArgs(spec), "down", "--volumes", "--remove-orphans"], runtimeAbs, {
    env: { ...runtimeDefaultEnv(project), ...projectRuntimeEnv(project) },
    source: spec.relativePath,
    label: `Delete Compose volumes ${spec.relativePath}`
  });
  addRuntimeLog(project, "warn", `Explicit volume deletion confirmed for ${project.slug}.`);
  await appendAudit("runtime.volumes.delete", `${project.slug}:volumes`, "QUEUED", {
    correlationId: correlation,
    composeFile: spec.relativePath,
    confirmation: "matched"
  });
  await runRuntimeTargetStreaming(project, target);
  const runtime = localRuntimeStore(project);
  runtime.status = "stopped";
  runtime.action = null;
  runtime.error = "";
  runtime.updatedAt = nowIso();
  await appendAudit("runtime.volumes.delete", `${project.slug}:volumes`, "SUCCEEDED", {
    correlationId: correlation,
    composeFile: spec.relativePath
  });
  await saveState();
  return localRuntimeSummary(project, discovered);
}

async function executeLocalRuntimeAction(projectId, action, abs, runtimeAbs, spec) {
  const project = findProjectOrThrow(projectId);
  const runtime = localRuntimeStore(project);
  const baseAction = baseRuntimeAction(action);
  const operation = localRuntimeProcesses.get(project.id) || {};
  const forceBuild = Boolean(operation.forceBuild || actionForcesRuntimeBuild(action));
  const strategy = operation.strategy || (forceBuild ? "fresh-rebuild" : "reuse-current");
  const expectedFingerprint = operation.sourceFingerprint || await calculateSourceFingerprint(project, runtimeAbs, operation.git, { force: true });
  try {
    const discovered = await discoverRepository(project.repositoryPath).catch(() => null);
    if (baseAction === "stop" || baseAction === "restart" || (baseAction === "start" && forceBuild)) {
      const target = await resolveRuntimeTarget(project, "stop", abs, runtimeAbs, discovered, spec);
      await runRuntimeTargetStreaming(project, target);
    }
    if (baseAction === "start" || baseAction === "restart") {
      const baseTarget = forceBuild
        ? forceBuildRuntimeTarget(await resolveRuntimeTarget(project, "start", abs, runtimeAbs, discovered, spec))
        : await resolveRuntimeTarget(project, "start", abs, runtimeAbs, discovered, spec);
      const target = runtimeTargetWithIdentityEnv(baseTarget, expectedFingerprint, operation.git, strategy);
      if (spec) {
        const conflicts = await detectPortConflicts(project, runtimeAbs, spec, target.env);
        if (conflicts.length) {
          const detail = conflicts.map((item) => `${item.service || "service"}:${item.port} ocupado por ${item.owner}`).join("; ");
          throw problem(409, "PORT_CONFLICT", detail);
        }
      }
      await runRuntimeTargetStreaming(project, target);
    }
    if (baseAction === "smoke") {
      const target = await resolveRuntimeTarget(project, "smoke", abs, runtimeAbs, discovered, spec);
      await runRuntimeTargetStreaming(project, target);
    }
    const resources = await listProjectContainers(project, abs, runtimeAbs).catch(() => []);
    const running = resources.filter((resource) => resource.state === "running");
    const exited = resources.filter((resource) => resource.state && resource.state !== "running");
    const postGit = await gitInfo(abs).catch(() => operation.git || { isGit: false, dirty: false });
    const postFingerprint = await calculateSourceFingerprint(project, runtimeAbs, postGit, { force: true });
    const fingerprintMatches = !["start", "restart"].includes(baseAction) || expectedFingerprint.value === postFingerprint.value;
    if (baseAction === "start" || baseAction === "restart") {
      runtime.lastDeployment = {
        id: crypto.randomUUID(),
        action,
        status: fingerprintMatches ? "SUCCEEDED" : "STALE_RUNTIME",
        strategy,
        startedAt: operation.startedAt || nowIso(),
        finishedAt: nowIso(),
        expectedFingerprint: expectedFingerprint.value,
        runtimeReportedFingerprint: "",
        verificationStatus: fingerprintMatches ? "matched" : "stale",
        verificationMessage: fingerprintMatches
          ? "El hub reconstruyo/recreo el runtime desde el fingerprint esperado. El proyecto todavia no expone endpoint de identidad propio para reportar fingerprint desde la app."
          : "Los archivos locales cambiaron durante o despues del deploy; el runtime no se marca como fresco.",
        git: operation.git || publicGitStatus(postGit),
        pullResult: operation.pullResult || null,
        composeFile: spec?.relativePath || "",
        composeProject: spec?.projectName || safeComposeProjectName(project.slug),
        resources: resources.map((resource) => ({
          id: resource.id,
          service: resource.service,
          image: resource.image,
          state: resource.state,
          ports: resource.ports
        })).slice(0, 20)
      };
    }
    runtime.git = publicGitStatus(postGit);
    runtime.sourceFingerprint = publicSourceFingerprint(postFingerprint);
    runtime.freshness = runtimeFreshness(runtime, postFingerprint, running.length > 0);
    runtime.status = baseAction === "stop"
      ? "stopped"
      : !fingerprintMatches
        ? "stale"
        : exited.length
        ? "degraded"
        : baseAction === "smoke"
          ? (running.length ? "running" : "stopped")
          : "running";
    runtime.error = "";
    addRuntimeLog(project, runtime.status === "degraded" ? "warn" : "info", `Runtime ${action} finished with status ${runtime.status}.`);
    if (!fingerprintMatches) {
      addRuntimeLog(project, "warn", `STALE_RUNTIME: expected ${expectedFingerprint.value}, current ${postFingerprint.value}.`);
    }
    await appendAudit("runtime.action", `${project.slug}:${action}`, fingerprintMatches ? "SUCCEEDED" : "STALE_RUNTIME", {
      composeFile: spec?.relativePath || "",
      sourceFingerprint: expectedFingerprint.value,
      currentFingerprint: postFingerprint.value,
      strategy
    });
  } catch (error) {
    runtime.status = "error";
    runtime.error = sanitizeText(error.message);
    addRuntimeLog(project, "error", error.message);
    if (baseAction === "start" || baseAction === "restart") {
      runtime.lastDeployment = {
        id: crypto.randomUUID(),
        action,
        status: "FAILED",
        strategy,
        startedAt: operation.startedAt || nowIso(),
        finishedAt: nowIso(),
        expectedFingerprint: expectedFingerprint?.value || "",
        runtimeReportedFingerprint: "",
        verificationStatus: "failed",
        verificationMessage: sanitizeText(error.message),
        git: operation.git || null,
        pullResult: operation.pullResult || null,
        composeFile: spec?.relativePath || "",
        composeProject: spec?.projectName || safeComposeProjectName(project.slug),
        resources: []
      };
      runtime.freshness = {
        status: "failed",
        checkedAt: nowIso(),
        message: sanitizeText(error.message),
        expected: expectedFingerprint?.value || "",
        current: ""
      };
    }
    await appendAudit("runtime.action", `${project.slug}:${action}`, "FAILED", { error: error.message, composeFile: spec?.relativePath || "", strategy });
  } finally {
    runtime.action = null;
    runtime.updatedAt = nowIso();
    localRuntimeProcesses.delete(project.id);
    await saveState();
  }
}

function runRuntimeTargetStreaming(project, target) {
  return new Promise((resolve, reject) => {
    addRuntimeLog(project, "info", `${target.label}: ${target.command} ${target.args.join(" ")} (cwd ${sanitizeText(target.cwd)})`);
    const child = spawn(target.command, target.args, {
      cwd: target.cwd,
      env: { ...process.env, ...projectRuntimeEnv(project), ...target.env },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let outputBytes = 0;
    let finished = false;
    let outputLimitExceeded = false;
    const timeout = setTimeout(() => {
      if (finished) return;
      addRuntimeLog(project, "error", `Runtime operation exceeded ${securityConfig.runtimeTimeoutMs}ms; terminating it.`);
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!finished) child.kill("SIGKILL");
      }, 5000).unref();
    }, securityConfig.runtimeTimeoutMs);
    const consume = (chunk, level) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > securityConfig.processOutputLimitBytes && !outputLimitExceeded) {
        outputLimitExceeded = true;
        addRuntimeLog(project, "error", "Runtime output exceeded the configured limit; terminating it.");
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!finished) child.kill("SIGKILL");
        }, 5000).unref();
        return;
      }
      if (outputLimitExceeded) return;
      for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) addRuntimeLog(project, level, line);
    };
    child.stdout.on("data", (chunk) => consume(chunk, "info"));
    child.stderr.on("data", (chunk) => consume(chunk, "warn"));
    child.on("error", (error) => {
      clearTimeout(timeout);
      finished = true;
      reject(problem(422, "RUNTIME_COMMAND_FAILED", sanitizeText(error.message)));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      finished = true;
      if (code === 0) resolve();
      else reject(problem(422, "RUNTIME_COMMAND_FAILED", `Approved runtime operation failed with exit code ${code ?? 1}.`));
    });
  });
}

async function detectPortConflicts(project, abs, spec, extraEnv = {}) {
  const hasProfileEnv = Object.keys(extraEnv || {}).length > 0;
  const config = hasProfileEnv
    ? await composeConfig(project, abs, spec.absolutePath, extraEnv)
    : spec.config || await composeConfig(project, abs, spec.absolutePath, extraEnv);
  const declared = [];
  for (const [service, definition] of Object.entries(config.services || {})) {
    for (const port of definition.ports || []) {
      const published = Number(port.published);
      if (!published || Number.isNaN(published)) continue;
      declared.push({ service, port: published, target: Number(port.target || 0), protocol: port.protocol || "tcp" });
    }
  }
  if (!declared.length) return [];

  const allRows = parseDockerJsonLines((await runCommandCapture("docker", ["ps", "-a", "--format", "{{json .}}"], repoRoot, { timeoutMs: 8000 })).stdout);
  const sameProjectResources = await listProjectContainers(project, abs).catch(() => []);
  const sameProjectIds = new Set(sameProjectResources.map((resource) => resource.id));
  const conflicts = [];
  for (const item of declared) {
    const owner = allRows
      .map((row) => ({ row, resource: dockerRowToResource(row) }))
      .find(({ row, resource }) => !sameProjectIds.has(row.ID) && resource.ports.some((port) => port.host === item.port && port.protocol === item.protocol));
    if (owner) {
      conflicts.push({ ...item, owner: `${owner.resource.name} (${owner.resource.composeProject || "docker"})` });
      continue;
    }
    const ownedBySameProject = sameProjectResources.some((resource) =>
      resource.ports.some((port) => port.host === item.port && port.protocol === item.protocol)
    );
    if (ownedBySameProject) continue;
    if (!(await isPortAvailable(item.port))) {
      conflicts.push({ ...item, owner: "proceso local fuera de Docker" });
    }
  }
  return conflicts;
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "0.0.0.0");
  });
}

function runtimeExecutionPlan(action, baseAction, runtime, sourceFingerprint) {
  if (!["start", "restart"].includes(baseAction)) {
    return {
      forceBuild: false,
      strategy: baseAction === "stop" ? "stop-only" : "read-only",
      reason: `La accion ${action} no requiere rebuild de fuentes.`
    };
  }
  if (actionForcesRuntimeBuild(action)) {
    if (action === "clean-rebuild") {
      return {
        forceBuild: true,
        strategy: "clean-rebuild-preserve-volumes",
        reason: "El usuario pidio clean rebuild: se fuerza build/recreacion y se preservan volumenes por defecto."
      };
    }
    if (action === "pull-rebuild") {
      return {
        forceBuild: true,
        strategy: "pull-ff-only-rebuild",
        reason: "Se hizo pull fast-forward sobre worktree limpio y se fuerza build/recreacion para evitar imagenes obsoletas."
      };
    }
    return {
      forceBuild: true,
      strategy: "fresh-rebuild",
      reason: "El usuario pidio reconstruccion explicita para tomar los ultimos cambios locales."
    };
  }
  const previous = runtime.lastDeployment?.expectedFingerprint || "";
  if (action === "rebuild-changed" && previous && previous === sourceFingerprint.value) {
    return {
      forceBuild: false,
      strategy: "changed-components-noop",
      reason: "Rebuild changed components no detecto cambios de fingerprint; se reutiliza runtime actual."
    };
  }
  if (!previous) {
    return {
      forceBuild: true,
      strategy: action === "rebuild-changed" ? "changed-components-first-deploy" : "smart-first-deploy",
      reason: "No hay deploy previo con fingerprint registrado; se fuerza build y recreacion."
    };
  }
  if (previous !== sourceFingerprint.value) {
    return {
      forceBuild: true,
      strategy: action === "rebuild-changed" ? "changed-components-source-changed" : "smart-source-changed",
      reason: "El fingerprint de fuentes cambio desde el ultimo deploy; se fuerza build y recreacion."
    };
  }
  return {
    forceBuild: false,
    strategy: "smart-reuse-current",
    reason: "El fingerprint coincide con el ultimo deploy registrado; se puede reutilizar el runtime actual."
  };
}

function runtimeTargetWithIdentityEnv(target, sourceFingerprint, git, strategy) {
  return {
    ...target,
    env: {
      ...target.env,
      RUNTIME_SOURCE_FINGERPRINT: sourceFingerprint?.value || "",
      PROJECT_SOURCE_FINGERPRINT: sourceFingerprint?.value || "",
      RUNTIME_GIT_BRANCH: git?.branch || "",
      RUNTIME_GIT_COMMIT: git?.commit || "",
      RUNTIME_GIT_DIRTY: String(Boolean(git?.dirty)),
      RUNTIME_DEPLOY_STRATEGY: strategy || "",
      RUNTIME_BUILD_TIME: nowIso()
    }
  };
}

async function localRuntimeLogs(project, tail = 240) {
  const stored = localRuntimeStore(project);
  const abs = await canonicalProjectPath(project.repositoryPath);
  const runtimeAbs = await runtimeProjectPath(project, abs);
  const resources = await listProjectContainers(project, abs, runtimeAbs).catch(() => []);
  const clearedAt = stored.clearedAt ? Date.parse(stored.clearedAt) : 0;
  const controlLines = (stored.logs || [])
    .filter((entry) => !clearedAt || Date.parse(entry.timestamp) > clearedAt)
    .map((entry) => `${entry.timestamp} hub/${entry.level.toUpperCase()} ${entry.message}`);
  const perContainerTail = Math.max(20, Math.floor(Number(tail || 240) / Math.max(resources.length, 1)));
  const containerLines = [];
  for (const resource of resources.slice(0, 16)) {
    const result = await runCommandCapture("docker", ["logs", "--timestamps", "--tail", String(perContainerTail), resource.id], repoRoot, { timeoutMs: 8000 });
    const lines = `${result.stdout || ""}\n${result.stderr || ""}`
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => {
        if (!clearedAt) return true;
        const timestamp = Date.parse(line.slice(0, 30));
        return Number.isNaN(timestamp) || timestamp > clearedAt;
      })
      .map((line) => `${resource.service} | ${sanitizeText(line)}`);
    containerLines.push(...lines);
  }
  return {
    project: project.slug,
    generatedAt: nowIso(),
    lines: [...controlLines, ...containerLines].slice(-Number(tail || 240)),
    resources: resources.length
  };
}

async function clearLocalRuntimeLogs(project) {
  const runtime = localRuntimeStore(project);
  runtime.logs = [];
  runtime.clearedAt = nowIso();
  runtime.updatedAt = nowIso();
  await saveState();
  return localRuntimeLogs(project);
}

function bulkOperationSnapshot(operation) {
  return {
    id: operation.id,
    action: operation.action,
    status: operation.status,
    createdAt: operation.createdAt,
    startedAt: operation.startedAt,
    finishedAt: operation.finishedAt,
    currentProjectId: operation.currentProjectId,
    currentProjectSlug: operation.currentProjectSlug,
    summary: operation.summary,
    items: operation.items
  };
}

async function triggerBulkRuntimeAction(action) {
  if (!securityConfig.privilegedExecutionEnabled) {
    throw problem(503, "PRIVILEGED_EXECUTION_DISABLED", "Privileged local execution is disabled for this API instance.");
  }
  for (const project of state.projects) assertProjectExecutionAllowed(project, securityConfig);
  if (!allowedRuntimeRequestActions.has(action)) {
    throw problem(400, "INVALID_RUNTIME_ACTION", "bulk runtime action must be start, stop, restart, smoke, start-fresh, restart-fresh, rebuild-changed, clean-rebuild or pull-rebuild.");
  }
  const active = [...localRuntimeBulkOperations.values()].find((operation) => operation.status === "RUNNING");
  if (active) return bulkOperationSnapshot(active);

  const operation = {
    id: crypto.randomUUID(),
    action,
    status: "RUNNING",
    createdAt: nowIso(),
    startedAt: nowIso(),
    finishedAt: null,
    currentProjectId: null,
    currentProjectSlug: "",
    summary: { total: state.projects.length, succeeded: 0, failed: 0, skipped: 0 },
    items: state.projects.map((project) => ({
      projectId: project.id,
      slug: project.slug,
      displayName: project.displayName,
      status: "PENDING",
      error: "",
      startedAt: null,
      finishedAt: null
    }))
  };
  localRuntimeBulkOperations.set(operation.id, operation);
  queueMicrotask(() => executeBulkRuntimeAction(operation.id));
  return bulkOperationSnapshot(operation);
}

async function executeBulkRuntimeAction(operationId) {
  const operation = localRuntimeBulkOperations.get(operationId);
  if (!operation) return;
  for (const item of operation.items) {
    const project = state.projects.find((candidate) => candidate.id === item.projectId);
    if (!project) {
      item.status = "SKIPPED";
      item.error = "Project is no longer registered.";
      item.finishedAt = nowIso();
      operation.summary.skipped += 1;
      continue;
    }
    operation.currentProjectId = project.id;
    operation.currentProjectSlug = project.slug;
    item.status = "RUNNING";
    item.startedAt = nowIso();
    try {
      await triggerLocalRuntimeAction(project, operation.action);
      while (localRuntimeProcesses.has(project.id)) {
        await sleep(1000);
      }
      const summary = await localRuntimeSummary(project);
      if (summary.status === "error" || summary.status === "stale") {
        const runtime = localRuntimeStore(project);
        throw problem(422, "RUNTIME_ACTION_FAILED", runtime.error || summary.explanation || "Runtime action failed.");
      }
      item.status = "SUCCEEDED";
      item.runtimeStatus = summary.status;
      item.finishedAt = nowIso();
      operation.summary.succeeded += 1;
    } catch (error) {
      item.status = "FAILED";
      item.error = sanitizeText(error.message);
      item.finishedAt = nowIso();
      operation.summary.failed += 1;
    }
  }
  operation.currentProjectId = null;
  operation.currentProjectSlug = "";
  operation.status = operation.summary.failed ? "FAILED" : "SUCCEEDED";
  operation.finishedAt = nowIso();
}

function runCommandCapture(command, args, cwd, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: options.env || process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let finished = false;
    let forceKillTimer = null;
    const outputLimitBytes = Number(options.outputLimitBytes || securityConfig.processOutputLimitBytes);
    const timeout = setTimeout(() => {
      if (!finished) {
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => {
          if (!finished) child.kill("SIGKILL");
        }, 1000);
      }
    }, options.timeoutMs || 5000);
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.byteLength;
      if (outputBytes <= outputLimitBytes) stdout += chunk.toString();
      else {
        child.kill("SIGTERM");
        if (!forceKillTimer) forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
      }
    });
    child.stderr.on("data", (chunk) => {
      outputBytes += chunk.byteLength;
      if (outputBytes <= outputLimitBytes) stderr += chunk.toString();
      else {
        child.kill("SIGTERM");
        if (!forceKillTimer) forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
      }
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      finished = true;
      resolve({ exitCode: -1, stdout: sanitizeText(stdout), stderr: sanitizeText(error.message || stderr) });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      finished = true;
      resolve({ exitCode: code ?? 1, stdout: sanitizeText(stdout), stderr: sanitizeText(stderr) });
    });
  });
}

async function createJob(project, action, requestId, options = {}) {
  assertProjectExecutionAllowed(project, securityConfig);
  if (!allowedActions.has(action)) {
    throw problem(400, "UNSUPPORTED_ACTION", `Unsupported action '${action}'.`);
  }
  const activeDuplicate = state.jobs.find(
    (job) => job.projectId === project.id && job.idempotencyKey === requestId && ["QUEUED", "PREPARING", "RUNNING"].includes(job.status)
  );
  if (requestId && activeDuplicate) return activeDuplicate;

  const git = await gitInfo(await canonicalProjectPath(project.repositoryPath)).catch(() => ({ isGit: false }));
  const job = {
    id: crypto.randomUUID(),
    projectId: project.id,
    projectSlug: project.slug,
    environment: "local",
    action,
    kind: sanitizeText(options.kind || "execution").slice(0, 40),
    testDefinitionId: sanitizeText(options.testDefinitionId || "").slice(0, 140),
    testDefinitionName: sanitizeText(options.testDefinitionName || "").slice(0, 220),
    testType: sanitizeText(options.testType || "").slice(0, 60),
    status: "QUEUED",
    stages: [],
    logs: [],
    parameters: sanitizeExecutionParameters(options.parameters || {}),
    guardrails: sanitizeExecutionGuardrails(options.guardrails || {}),
    testPlan: sanitizeTestPlan(options.testPlan || []),
    worker: {
      id: "local-job-worker",
      mode: "single-host",
      maxConcurrentJobs,
      timeoutSeconds: jobTimeoutSeconds
    },
    actor: currentActor(),
    idempotencyKey: requestId || null,
    branch: git.branch || project.defaultBranch,
    commit: git.commit || null,
    exitCode: null,
    startedAt: null,
    finishedAt: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    summary: {},
    error: null
  };
  state.jobs.unshift(job);
  state.jobs = state.jobs.slice(0, 200);
  await appendAudit("execution.create", `${project.slug}:${action}`, "QUEUED", { jobId: job.id });
  queueMicrotask(processQueue);
  return job;
}

function sanitizeExecutionParameters(parameters) {
  const safe = {};
  for (const [key, value] of Object.entries(parameters || {})) {
    const safeKey = sanitizeText(key).slice(0, 80);
    if (!safeKey) continue;
    if (isSensitiveKey(safeKey)) continue;
    if (value === null || value === undefined) {
      safe[safeKey] = value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      safe[safeKey] = value;
    } else {
      safe[safeKey] = sanitizeText(String(value)).slice(0, 300);
    }
  }
  return safe;
}

function sanitizeExecutionGuardrails(guardrails) {
  return {
    status: sanitizeText(guardrails.status || "ALLOWED").slice(0, 40),
    environment: sanitizeText(guardrails.environment || "local").slice(0, 40),
    destructive: Boolean(guardrails.destructive),
    arbitraryCommands: false,
    productionBlocked: guardrails.productionBlocked !== false,
    approvalRequired: Boolean(guardrails.approvalRequired),
    killSwitchEnv: "HUB_TEST_KILL_SWITCH",
    limits: {
      maxVirtualUsers: Number(guardrails.limits?.maxVirtualUsers || performanceGuardrails.maxVirtualUsers),
      maxDurationSeconds: Number(guardrails.limits?.maxDurationSeconds || performanceGuardrails.maxDurationSeconds),
      maxRequests: Number(guardrails.limits?.maxRequests || performanceGuardrails.maxRequests)
    },
    reasons: (guardrails.reasons || []).map((item) => sanitizeText(item).slice(0, 240)).slice(0, 12)
  };
}

function sanitizeTestPlan(testPlan) {
  return (Array.isArray(testPlan) ? testPlan : []).map((stage) => ({
    name: sanitizeText(stage.name || stage.action || "Test stage").slice(0, 220),
    action: sanitizeText(stage.action || "").slice(0, 40),
    internal: Boolean(stage.internal),
    command: sanitizeText(stage.command || "").slice(0, 80),
    args: Array.isArray(stage.args) ? stage.args.map((arg) => sanitizeText(arg).slice(0, 300)).slice(0, 20) : [],
    cwd: sanitizeText(stage.cwd || ".").slice(0, 240),
    source: sanitizeText(stage.source || "").slice(0, 240),
    testType: sanitizeText(stage.testType || "").slice(0, 60),
    testDefinitionId: sanitizeText(stage.testDefinitionId || "").slice(0, 140),
    parameters: sanitizeExecutionParameters(stage.parameters || {})
  })).filter((stage) => stage.action);
}

async function processQueue() {
  if (runningJobs.size >= maxConcurrentJobs) return;
  const next = state.jobs.find((job) => job.status === "QUEUED");
  if (!next) return;
  runningJobs.add(next.id);
  runJob(next)
    .catch(async (error) => {
      next.status = "FAILED";
      next.error = { category: "UNEXPECTED", message: sanitizeText(error.message) };
      next.finishedAt = nowIso();
      next.updatedAt = nowIso();
      await saveState();
      publishJob(next);
    })
    .finally(() => {
      runningJobs.delete(next.id);
      queueMicrotask(processQueue);
    });
}

async function runJob(job) {
  const project = findProjectOrThrow(job.projectId);
  job.status = "PREPARING";
  job.startedAt = nowIso();
  job.updatedAt = nowIso();
  addLog(job, "info", `Preparing ${job.action} for ${project.slug}`);
  await saveState();
  publishJob(job);

  const abs = await canonicalProjectPath(project.repositoryPath);
  const discovered = await discoverRepository(project.repositoryPath);
  const stages = planStages(job.action, discovered, job);

  if (!stages.length) {
    throw problem(422, "NO_APPROVED_COMMAND", `No approved template was detected for action '${job.action}'.`);
  }

  job.status = "RUNNING";
  for (const stage of stages) {
    await runStage(job, project, abs, stage);
    if (job.status === "CANCELLED") break;
  }

  if (job.status !== "CANCELLED") {
    job.status = "SUCCEEDED";
    job.exitCode = 0;
    if (stages.some((stage) => stage.action === "sonar")) {
      const snapshot = await importQualitySnapshot(project).catch((error) => {
        addLog(job, "warn", `Quality snapshot import failed: ${error.message}`);
        return null;
      });
      if (snapshot) job.summary.qualitySnapshotId = snapshot.id;
    }
  }
  job.finishedAt = nowIso();
  job.updatedAt = nowIso();
  await appendAudit("execution.finish", `${project.slug}:${job.action}`, job.status, { jobId: job.id });
  await saveState();
  publishJob(job);
}

function planStages(action, discovered, job = null) {
  if (job?.testPlan?.length) {
    return testPlanStages(job, discovered);
  }
  if (action === "doctor" || action === "health") {
    return [{ name: action === "doctor" ? "Configuration Doctor" : "Health check", action, internal: true }];
  }
  if (action === "smoke") {
    return [{ name: "Smoke local controlado", action: "smoke", internal: true, testType: "smoke" }];
  }
  if (action === "load") {
    return [{ name: "Load test HTTP local", action: "load", internal: true, testType: "load" }];
  }
  if (action === "dast") {
    return [{ name: "DAST pasivo local", action: "dast", internal: true, testType: "dast" }];
  }
  const commands = discovered.approvedCommands || [];
  if (action === "full") {
    const ordered = ["lint", "tests", "coverage", "build", "sonar"];
    const selected = ordered.flatMap((step) => commands.filter((cmd) => cmd.action === step));
    return [{ name: "Preflight", action: "doctor", internal: true }, ...selected.map(commandToStage)];
  }
  return commands.filter((cmd) => cmd.action === action).map(commandToStage);
}

function testPlanStages(job, discovered) {
  const commands = discovered.approvedCommands || [];
  return job.testPlan.map((stage) => {
    if (stage.internal) {
      if (!internalTestingActions.has(stage.action)) {
        throw problem(400, "INVALID_TEST_PLAN", `Internal test action '${stage.action}' is not supported.`);
      }
      return {
        name: stage.name,
        action: stage.action,
        internal: true,
        testType: stage.testType || stage.action,
        testDefinitionId: stage.testDefinitionId || job.testDefinitionId,
        parameters: sanitizeExecutionParameters({ ...(job.parameters || {}), ...(stage.parameters || {}) })
      };
    }
    const approved = commands.some((command) =>
      command.action === stage.action &&
      command.command === stage.command &&
      JSON.stringify(command.args || []) === JSON.stringify(stage.args || []) &&
      (command.cwd || ".") === (stage.cwd || ".")
    );
    if (!approved) {
      throw problem(400, "TEST_PLAN_NOT_APPROVED", `Command stage '${stage.name}' is not in the current approved command catalog.`);
    }
    return {
      name: stage.name,
      action: stage.action,
      internal: false,
      command: stage.command,
      args: stage.args || [],
      cwd: stage.cwd || ".",
      source: stage.source || "discovery",
      testType: stage.testType || stage.action,
      testDefinitionId: stage.testDefinitionId || job.testDefinitionId
    };
  });
}

function commandToStage(cmd) {
  return {
    name: cmd.label || cmd.action,
    action: cmd.action,
    internal: false,
    command: cmd.command,
    args: cmd.args,
    cwd: cmd.cwd || "."
  };
}

async function runStage(job, project, abs, stage) {
  const startedAt = nowIso();
  const stageRecord = { name: stage.name, action: stage.action, status: "RUNNING", startedAt, finishedAt: null, durationMs: null, exitCode: null };
  job.stages.push(stageRecord);
  addLog(job, "info", `Stage started: ${stage.name}`);
  await saveState();
  publishJob(job);

  try {
    if (stage.internal) {
      if (stage.action === "doctor") {
        const discovered = await discoverRepository(project.repositoryPath);
        job.summary.doctor = discovered.doctor;
        for (const item of discovered.doctor) {
          addLog(job, item.level === "error" ? "error" : item.level === "warn" ? "warn" : "info", `${item.code}: ${item.message}`);
        }
      } else if (stage.action === "health") {
        job.summary.health = await platformStatus();
        addLog(job, "info", "Health check completed.");
      } else if (stage.action === "smoke") {
        const summary = await runSmokeTestStage(job, project, abs, stage);
        stageRecord.summary = summary;
        job.summary.testEvidence = summary;
      } else if (stage.action === "load") {
        const summary = await runLoadTestStage(job, project, stage);
        stageRecord.summary = summary;
        job.summary.testEvidence = summary;
      } else if (stage.action === "dast") {
        const summary = await runDastTestStage(job, project, stage);
        stageRecord.summary = summary;
        job.summary.testEvidence = summary;
      } else {
        throw problem(400, "UNSUPPORTED_INTERNAL_STAGE", `Internal stage '${stage.action}' is not supported.`);
      }
      stageRecord.status = "SUCCEEDED";
      stageRecord.exitCode = 0;
    } else {
      const result = await runApprovedCommand(job, abs, stage);
      stageRecord.exitCode = result.exitCode;
      stageRecord.summary = result.summary;
      stageRecord.status = result.exitCode === 0 ? "SUCCEEDED" : "FAILED";
      if (stage.action === "sonar" && result.exitCode === 0) {
        const ceTaskId = extractCeTaskId(job.logs.map((entry) => entry.message).join("\n"));
        if (ceTaskId) {
          addLog(job, "info", `Waiting for SonarQube Compute Engine task ${ceTaskId}`);
          const ceResult = await waitForSonarTask(ceTaskId, job, project);
          job.summary.sonarComputeEngine = ceResult;
          const gate = await sonarQualityGate(project);
          job.summary.qualityGate = gate;
          addLog(job, gate.status === "OK" ? "info" : "warn", `Quality Gate: ${gate.status || "UNKNOWN"}`);
        } else {
          addLog(job, "warn", "SonarQube scanner finished but no Compute Engine task URL was detected.");
        }
      }
      if (result.exitCode !== 0) {
        job.summary.failure = {
          stage: stage.name,
          action: stage.action,
          exitCode: result.exitCode,
          output: result.summary
        };
        throw problem(422, "STAGE_FAILED", `Stage '${stage.name}' failed with exit code ${result.exitCode}.`);
      }
    }
  } catch (error) {
    stageRecord.status = "FAILED";
    job.status = "FAILED";
    job.exitCode = error.exitCode ?? 1;
    job.error = { category: error.code || "STAGE_FAILED", message: sanitizeText(error.message) };
    addLog(job, "error", job.error.message);
    throw error;
  } finally {
    stageRecord.finishedAt = nowIso();
    stageRecord.durationMs = Date.parse(stageRecord.finishedAt) - Date.parse(stageRecord.startedAt);
    job.updatedAt = nowIso();
    await saveState();
    publishJob(job);
  }
}

async function runSmokeTestStage(job, project, abs, stage) {
  const runtimeAbs = await runtimeProjectPath(project, abs);
  const discovered = await discoverRepository(project.repositoryPath).catch(() => null);
  const resources = await listProjectContainers(project, abs, runtimeAbs).catch(() => []);
  const spec = await resolveComposeSpec(project, runtimeAbs, discovered, resources).catch(() => null);
  const target = await resolveRuntimeTarget(project, "smoke", abs, runtimeAbs, discovered, spec);
  addLog(job, "info", `Smoke target: ${target.label}`);
  const result = await runRuntimeTargetForJob(job, target);
  if (result.exitCode !== 0) {
    throw problem(422, "SMOKE_FAILED", `Smoke '${target.label}' failed with exit code ${result.exitCode}.`);
  }
  return {
    type: "smoke",
    target: target.label,
    source: target.source,
    cwd: sanitizeText(target.cwd),
    lines: result.summary.lines,
    errors: result.summary.errors,
    warnings: result.summary.warnings,
    status: "passed"
  };
}

function runRuntimeTargetForJob(job, target) {
  return new Promise((resolve, reject) => {
    addLog(job, "info", `Running runtime template: ${target.command} ${target.args.join(" ")} (cwd ${sanitizeText(target.cwd)})`);
    const child = spawn(target.command, target.args, {
      cwd: target.cwd,
      env: { ...process.env, ...target.env },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const summary = createOutputSummary({ name: target.label, action: "smoke" });
    let outputBytes = 0;
    let outputLimitExceeded = false;
    let finished = false;
    let forceKillTimer = null;
    const timeout = setTimeout(() => {
      if (finished) return;
      addLog(job, "error", `Smoke timed out after ${jobTimeoutSeconds}s. Sending SIGTERM.`);
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (!finished) child.kill("SIGKILL");
      }, 5000);
    }, jobTimeoutSeconds * 1000);
    const consume = (chunk, level) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > securityConfig.processOutputLimitBytes && !outputLimitExceeded) {
        outputLimitExceeded = true;
        addLog(job, "error", "Smoke output exceeded the configured limit; terminating it.");
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => {
          if (!finished) child.kill("SIGKILL");
        }, 5000);
        return;
      }
      if (outputLimitExceeded) return;
      for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
        recordOutputLine(summary, level, line);
        addLog(job, level, line);
      }
      publishJob(job);
    };
    child.stdout.on("data", (chunk) => consume(chunk, "info"));
    child.stderr.on("data", (chunk) => consume(chunk, "warn"));
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      finished = true;
      reject(problem(422, "SMOKE_START_FAILED", sanitizeText(error.message)));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      finished = true;
      resolve({ exitCode: code ?? 1, summary: finalizeOutputSummary(summary) });
    });
  });
}

async function runLoadTestStage(job, project, stage) {
  const parameters = await normalizeLoadTestParameters(project, stage.parameters || {});
  if (process.env.HUB_TEST_KILL_SWITCH === "1") {
    throw problem(423, "TEST_KILL_SWITCH_ACTIVE", "HUB_TEST_KILL_SWITCH=1 blocks load tests.");
  }
  addLog(job, "info", `Load target: ${parameters.targetUrl}`);
  addLog(job, "info", `Load guardrails: vus=${parameters.virtualUsers}, duration=${parameters.durationSeconds}s, maxRequests=${parameters.maxRequests}.`);
  const startedMs = Date.now();
  const deadlineMs = startedMs + parameters.durationSeconds * 1000;
  let launched = 0;
  const samples = [];

  async function worker(workerId) {
    while (Date.now() < deadlineMs && launched < parameters.maxRequests) {
      launched += 1;
      const requestNo = launched;
      const sample = await timedHttpGet(parameters.targetUrl, parameters.perRequestTimeoutMs);
      sample.workerId = workerId;
      sample.requestNo = requestNo;
      samples.push(sample);
      if (sample.error && samples.length <= 5) addLog(job, "warn", `Load request ${requestNo} failed: ${sample.error}`);
      await sleep(parameters.thinkTimeMs);
    }
  }

  await Promise.all(Array.from({ length: parameters.virtualUsers }, (_item, index) => worker(index + 1)));
  const durationMs = Math.max(1, Date.now() - startedMs);
  const metrics = loadTestMetrics(samples, durationMs);
  const thresholdResult = evaluateLoadThresholds(metrics, parameters.thresholds);
  addLog(job, thresholdResult.passed ? "info" : "error", `Load result: p95=${metrics.p95Ms}ms, errorRate=${metrics.errorRate}, throughput=${metrics.throughputRps} rps.`);
  if (!thresholdResult.passed) {
    throw problem(422, "LOAD_THRESHOLDS_FAILED", thresholdResult.failures.join("; "));
  }
  return {
    type: "load",
    targetUrl: parameters.targetUrl,
    durationMs,
    requests: samples.length,
    virtualUsers: parameters.virtualUsers,
    thresholds: parameters.thresholds,
    thresholdResult,
    metrics,
    status: "passed"
  };
}

async function runDastTestStage(job, project, stage) {
  const targetUrl = await resolveTestingTargetUrl(project, stage.parameters?.targetUrl || "");
  if (process.env.HUB_TEST_KILL_SWITCH === "1") {
    throw problem(423, "TEST_KILL_SWITCH_ACTIVE", "HUB_TEST_KILL_SWITCH=1 blocks DAST tests.");
  }
  addLog(job, "info", `DAST passive target: ${targetUrl}`);
  const result = await timedHttpGet(targetUrl, performanceGuardrails.perRequestTimeoutMs, { includeHeaders: true });
  if (result.error) throw problem(422, "DAST_TARGET_UNREACHABLE", result.error);
  const headerFindings = passiveDastHeaderFindings(targetUrl, result.headers || {});
  for (const finding of headerFindings.slice(0, 8)) {
    addLog(job, finding.severity === "warning" ? "warn" : "info", `${finding.code}: ${finding.detail}`);
  }
  return {
    type: "dast",
    mode: "passive-read-only",
    targetUrl,
    statusCode: result.status,
    durationMs: result.durationMs,
    checks: {
      total: 6,
      findings: headerFindings.length,
      warnings: headerFindings.filter((finding) => finding.severity === "warning").length
    },
    findings: headerFindings,
    status: "completed_with_passive_findings"
  };
}

async function timedHttpGet(url, timeoutMs, options = {}) {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs)
    });
    response.body?.cancel?.();
    const durationMs = Date.now() - started;
    return {
      ok: response.status >= 200 && response.status < 500,
      status: response.status,
      durationMs,
      headers: options.includeHeaders ? Object.fromEntries(response.headers.entries()) : undefined
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      durationMs: Date.now() - started,
      error: sanitizeText(error.message || "request failed").slice(0, 300)
    };
  }
}

function loadTestMetrics(samples, durationMs) {
  const durations = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
  const errors = samples.filter((sample) => !sample.ok).length;
  return {
    requests: samples.length,
    errors,
    errorRate: samples.length ? Number((errors / samples.length).toFixed(4)) : 1,
    throughputRps: Number((samples.length / (durationMs / 1000)).toFixed(2)),
    p50Ms: percentile(durations, 50),
    p90Ms: percentile(durations, 90),
    p95Ms: percentile(durations, 95),
    p99Ms: percentile(durations, 99),
    minMs: durations[0] || 0,
    maxMs: durations[durations.length - 1] || 0,
    statusCodes: samples.reduce((acc, sample) => {
      const key = String(sample.status || 0);
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {})
  };
}

function percentile(sortedValues, percentileValue) {
  if (!sortedValues.length) return 0;
  const index = Math.min(sortedValues.length - 1, Math.ceil((percentileValue / 100) * sortedValues.length) - 1);
  return sortedValues[index] || 0;
}

function evaluateLoadThresholds(metrics, thresholds) {
  const failures = [];
  if (metrics.p95Ms > thresholds.p95Ms) failures.push(`p95 ${metrics.p95Ms}ms > ${thresholds.p95Ms}ms`);
  if (metrics.errorRate > thresholds.errorRate) failures.push(`error_rate ${metrics.errorRate} > ${thresholds.errorRate}`);
  return {
    passed: failures.length === 0,
    failures
  };
}

function passiveDastHeaderFindings(targetUrl, headers) {
  const findings = [];
  const url = new URL(targetUrl);
  const hasHeader = (name) => Boolean(headers[String(name).toLowerCase()]);
  const add = (severity, code, detail) => findings.push({ severity, code, detail });
  if (!hasHeader("content-security-policy")) add("warning", "CSP_MISSING", "No se detecto Content-Security-Policy.");
  if (!/nosniff/i.test(headers["x-content-type-options"] || "")) add("warning", "X_CONTENT_TYPE_OPTIONS_MISSING", "Falta X-Content-Type-Options: nosniff.");
  if (!hasHeader("x-frame-options") && !/frame-ancestors/i.test(headers["content-security-policy"] || "")) add("warning", "CLICKJACKING_HEADER_MISSING", "Falta X-Frame-Options o frame-ancestors.");
  if (!hasHeader("referrer-policy")) add("info", "REFERRER_POLICY_MISSING", "No se detecto Referrer-Policy.");
  if (url.protocol === "https:" && !hasHeader("strict-transport-security")) add("warning", "HSTS_MISSING", "HTTPS sin Strict-Transport-Security.");
  if (hasHeader("server")) add("info", "SERVER_HEADER_EXPOSED", "El header Server esta expuesto; revisar si revela tecnologia/version.");
  return findings;
}

async function normalizeLoadTestParameters(project, input = {}) {
  const targetUrl = await resolveTestingTargetUrl(project, input.targetUrl || "");
  const virtualUsers = clampNumber(input.virtualUsers, 1, performanceGuardrails.maxVirtualUsers, 1);
  const durationSeconds = clampNumber(input.durationSeconds, 1, performanceGuardrails.maxDurationSeconds, 8);
  const maxRequests = clampNumber(input.maxRequests, 1, performanceGuardrails.maxRequests, Math.min(40, performanceGuardrails.maxRequests));
  return {
    targetUrl,
    virtualUsers,
    durationSeconds,
    maxRequests,
    perRequestTimeoutMs: performanceGuardrails.perRequestTimeoutMs,
    thinkTimeMs: clampNumber(input.thinkTimeMs, 0, 1000, 100),
    thresholds: {
      p95Ms: clampNumber(input.p95Ms || input.thresholdP95Ms, 1, 10000, performanceGuardrails.defaultP95Ms),
      errorRate: clampRatio(input.errorRate ?? input.thresholdErrorRate, performanceGuardrails.defaultErrorRate)
    }
  };
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function clampRatio(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(1, Math.max(0, number));
}

async function resolveTestingTargetUrl(project, requestedUrl = "") {
  const targets = await testingHttpTargets(project);
  if (!targets.length) {
    throw problem(422, "TEST_TARGET_NOT_CONFIGURED", "No local HTTP target is configured or running for this project.");
  }
  if (!requestedUrl) return targets[0].url;
  const normalized = normalizeTestingUrl(requestedUrl);
  if (!normalized || !targets.some((target) => target.url === normalized)) {
    throw problem(400, "TEST_TARGET_NOT_ALLOWED", "Test target URL must be one of the detected local project URLs.");
  }
  return normalized;
}

async function testingHttpTargets(project) {
  const targets = [];
  const add = (url, source, label) => {
    const normalized = normalizeTestingUrl(url);
    if (!normalized) return;
    if (!targets.some((item) => item.url === normalized)) targets.push({ url: normalized, source, label });
  };

  for (const environment of state.environments.filter((item) => item.projectId === project.id && item.enabled !== false)) {
    if (environment.name !== "local" && environment.protected) continue;
    add(environment.healthUrl, `environment:${environment.name}`, "Health URL");
    add(environment.baseUrl, `environment:${environment.name}`, "Base URL");
  }

  const discovered = await discoverRepository(project.repositoryPath).catch(() => null);
  const runtime = await localRuntimeSummary(project, discovered).catch(() => ({ resources: [] }));
  for (const resource of runtime.resources || []) {
    for (const url of resource.urls || []) {
      add(url.url, `runtime:${resource.service || resource.name || "container"}`, url.label || resource.service || "Runtime URL");
    }
  }
  return targets;
}

function normalizeTestingUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(String(value).trim());
    if (!["http:", "https:"].includes(url.protocol)) return "";
    if (url.username || url.password) return "";
    if (!localTestHostnames.has(url.hostname)) return "";
    url.hash = "";
    return url.toString().replace(/\/$/, "/");
  } catch {
    return "";
  }
}

async function runApprovedCommand(job, abs, stage) {
  const cwd = path.resolve(abs, stage.cwd || ".");
  if (!(cwd === abs || cwd.startsWith(`${abs}${path.sep}`))) {
    throw problem(400, "COMMAND_CWD_ESCAPE", "Approved command cwd escapes project root.");
  }

  const project = findProjectOrThrow(job.projectId);
  const env = {
    ...process.env,
    ...projectRuntimeEnv(project)
  };

  const result = await runApprovedCommandAttempt(job, stage, cwd, env);
  if (result.exitCode === 0 || !shouldRepairNativeNodeModules(result.summary, stage)) {
    return result;
  }

  const repairArgs = npmNativeRepairArgs(cwd);
  addLog(job, "warn", `Se detectaron bindings nativos incompatibles en node_modules. Ejecutando npm ${repairArgs.join(" ")} antes de reintentar el stage.`);
  const repair = await runCommandForRepair("npm", repairArgs, cwd, env, 240000);
  for (const line of repair.output.slice(-80)) {
    addLog(job, repair.exitCode === 0 ? "info" : "warn", line);
  }
  if (repair.exitCode !== 0) {
    addLog(job, "warn", `npm ${repairArgs.join(" ")} fallo con exit code ${repair.exitCode}; se conserva el fallo original.`);
    return result;
  }

  addLog(job, "info", `npm ${repairArgs.join(" ")} finalizo correctamente. Reintentando stage aprobado.`);
  return runApprovedCommandAttempt(job, stage, cwd, env);
}

function runApprovedCommandAttempt(job, stage, cwd, env) {
  return new Promise((resolve, reject) => {
    addLog(job, "info", `Running template: ${stage.command} ${stage.args.join(" ")}`);
    const child = spawn(stage.command, stage.args, {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let finished = false;
    let outputBytes = 0;
    let outputLimitExceeded = false;
    let forceKillTimer = null;
    const timeout = setTimeout(() => {
      if (!finished) {
        addLog(job, "error", `Stage timed out after ${jobTimeoutSeconds}s. Sending SIGTERM.`);
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => {
          if (!finished) child.kill("SIGKILL");
        }, 5000);
      }
    }, jobTimeoutSeconds * 1000);

    const summary = createOutputSummary(stage);

    const consume = (chunk, level) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > securityConfig.processOutputLimitBytes && !outputLimitExceeded) {
        outputLimitExceeded = true;
        addLog(job, "error", "Stage output exceeded the configured limit; terminating it.");
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => {
          if (!finished) child.kill("SIGKILL");
        }, 5000);
        return;
      }
      if (outputLimitExceeded) return;
      for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
        recordOutputLine(summary, level, line);
        addLog(job, level, line);
      }
      publishJob(job);
    };
    child.stdout.on("data", (chunk) => consume(chunk, "info"));
    child.stderr.on("data", (chunk) => consume(chunk, "warn"));
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      finished = true;
      reject(problem(422, "COMMAND_START_FAILED", sanitizeText(error.message)));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      finished = true;
      resolve({ exitCode: code ?? 1, summary: finalizeOutputSummary(summary) });
    });
  });
}

function shouldRepairNativeNodeModules(summary, stage) {
  if (stage.command !== "npm") return false;
  const text = [
    ...(summary?.firstProblems || []),
    ...(summary?.lastLines || []),
    ...(summary?.categories || []).map((item) => item.category)
  ].join("\n");
  return /installed esbuild for another platform|@esbuild\/darwin|@esbuild\/linux|needs the .*@esbuild|failed to load native binding|cannot find native binding|@swc\/core\/binding|@rolldown\/binding|native code and needs/i.test(text);
}

function npmNativeRepairArgs(cwd) {
  const packages = nativeOptionalPackages();
  if (packages.length) {
    return ["install", "--no-save", "--package-lock=false", "--no-audit", "--no-fund", ...packages];
  }
  if (fsSync.existsSync(path.join(cwd, "package-lock.json"))) {
    return ["ci", "--no-audit", "--no-fund"];
  }
  return ["install", "--no-audit", "--no-fund"];
}

function nativeOptionalPackages() {
  if (process.platform !== "linux") return [];
  const libc = process.report?.getReport?.().header?.glibcVersionRuntime ? "gnu" : "musl";
  if (process.arch === "arm64") {
    return ["@esbuild/linux-arm64", `@swc/core-linux-arm64-${libc}`, `@rolldown/binding-linux-arm64-${libc}`];
  }
  if (process.arch === "x64") {
    return ["@esbuild/linux-x64", `@swc/core-linux-x64-${libc}`, `@rolldown/binding-linux-x64-${libc}`];
  }
  return [];
}

function runCommandForRepair(command, args, cwd, env, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const output = [];
    let outputBytes = 0;
    let outputLimitExceeded = false;
    let forceKillTimer = null;
    const timeout = setTimeout(() => {
      output.push(`Repair command timed out after ${Math.round(timeoutMs / 1000)}s.`);
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        output.push("Repair command did not stop after SIGTERM; sending SIGKILL.");
        child.kill("SIGKILL");
      }, 5000);
    }, timeoutMs);
    const capture = (chunk) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > securityConfig.processOutputLimitBytes) {
        if (!outputLimitExceeded) {
          outputLimitExceeded = true;
          output.push("Repair output exceeded the configured limit; terminating it.");
          child.kill("SIGTERM");
          forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
        }
        return;
      }
      for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
        output.push(sanitizeText(line));
      }
      if (output.length > 200) output.splice(0, output.length - 200);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve({ exitCode: code ?? 1, output });
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve({ exitCode: -1, output: [sanitizeText(error.message)] });
    });
  });
}

function createOutputSummary(stage) {
  return {
    stage: stage.name,
    action: stage.action,
    lines: 0,
    stdoutLines: 0,
    stderrLines: 0,
    errors: 0,
    warnings: 0,
    tools: new Set(),
    rules: new Map(),
    categories: new Map(),
    firstProblems: [],
    lastLines: []
  };
}

function recordOutputLine(summary, level, rawLine) {
  const line = sanitizeText(rawLine);
  summary.lines += 1;
  if (level === "warn" || /\berror\b/i.test(line)) summary.stderrLines += 1;
  else summary.stdoutLines += 1;

  const eslintTotals = line.match(/([0-9,]+)\s+problems?\s+\(([0-9,]+)\s+errors?,\s+([0-9,]+)\s+warnings?\)/i);
  if (eslintTotals) {
    summary.tools.add("eslint");
    summary.errors = Math.max(summary.errors, numberFromText(eslintTotals[2]));
    summary.warnings = Math.max(summary.warnings, numberFromText(eslintTotals[3]));
  }

  if (/\bESLint\b|eslint/i.test(line)) summary.tools.add("eslint");
  if (/\bTypeScript\b|\btsc\b|TS[0-9]{4}/.test(line)) summary.tools.add("typescript");
  if (/\bSonarQube\b|sonar-scanner|SONAR_/i.test(line)) summary.tools.add("sonarqube");
  if (/\bGradle\b|gradlew/i.test(line)) summary.tools.add("gradle");
  if (/\bMaven\b|\bmvn\b/i.test(line)) summary.tools.add("maven");

  if (/\berror\b|failed|failure|not authorized|unauthorized|forbidden|invalid token|no valido|Falta SONAR_TOKEN/i.test(line)) {
    incrementMap(summary.categories, classifyFailureLine(line));
    if (summary.firstProblems.length < 12) summary.firstProblems.push(line);
  }
  if (/\bwarning\b|\bwarn\b/i.test(line)) {
    incrementMap(summary.categories, "warning");
  }

  const eslintRule = line.match(/\s(?:error|warning)\s+.+?\s+([@a-z0-9][@a-z0-9-]*(?:\/[a-z0-9-]+){1,2})\s*$/i);
  if (eslintRule) incrementMap(summary.rules, eslintRule[1]);

  const tsRule = line.match(/\b(TS[0-9]{4})\b/);
  if (tsRule) incrementMap(summary.rules, tsRule[1]);

  summary.lastLines.push(line);
  if (summary.lastLines.length > 40) summary.lastLines.shift();
}

function finalizeOutputSummary(summary) {
  const topRules = [...summary.rules.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([rule, count]) => ({ rule, count }));
  const categories = [...summary.categories.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => ({ category, count }));
  return {
    stage: summary.stage,
    action: summary.action,
    lines: summary.lines,
    stdoutLines: summary.stdoutLines,
    stderrLines: summary.stderrLines,
    errors: summary.errors,
    warnings: summary.warnings,
    tools: [...summary.tools],
    topRules,
    categories,
    firstProblems: summary.firstProblems,
    lastLines: summary.lastLines
  };
}

function numberFromText(value) {
  return Number(String(value || "0").replace(/,/g, ""));
}

function incrementMap(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function classifyFailureLine(line) {
  if (/cannot find native binding|failed to load native binding|installed esbuild for another platform|@rolldown\/binding|@swc\/core|@esbuild\/darwin|@esbuild\/linux/i.test(line)) return "native-deps";
  if (/Falta SONAR_TOKEN|invalid token|not authorized|unauthorized|forbidden|401|403|no valido/i.test(line)) return "sonar-auth";
  if (/lint|eslint|@typescript-eslint/i.test(line)) return "lint";
  if (/TS[0-9]{4}|typescript|tsc/i.test(line)) return "typescript";
  if (/test failed|failing tests?|FAIL/i.test(line)) return "tests";
  if (/build failed|compilation failed|compile/i.test(line)) return "build";
  return "error";
}

function addLog(job, level, message) {
  job.logs.push({
    timestamp: nowIso(),
    level,
    message: sanitizeText(message).slice(0, 4000)
  });
  if (job.logs.length > 2000) job.logs = job.logs.slice(-2000);
}

function publishJob(job) {
  const subscribers = jobSubscribers.get(job.id);
  if (!subscribers) return;
  const payload = `event: job\ndata: ${JSON.stringify(job)}\n\n`;
  for (const res of subscribers) res.write(payload);
}

function extractCeTaskId(logText) {
  const match = String(logText).match(/api\/ce\/task\?id=([a-f0-9-]+)/i);
  return match ? match[1] : null;
}

async function waitForSonarTask(taskId, job, project) {
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const data = await sonarFetch(`/api/ce/task?id=${encodeURIComponent(taskId)}`, project);
    const task = data.task || {};
    if (["SUCCESS", "FAILED", "CANCELED"].includes(task.status)) {
      if (task.status !== "SUCCESS") throw problem(422, "SONAR_CE_FAILED", `SonarQube Compute Engine task ended with ${task.status}.`);
      return task;
    }
    addLog(job, "info", `SonarQube task status: ${task.status || "UNKNOWN"}`);
    await sleep(2000);
  }
  throw problem(504, "SONAR_CE_TIMEOUT", "Timed out waiting for SonarQube Compute Engine task.");
}

async function sonarQualityGate(projectOrKey) {
  const projectKey = typeof projectOrKey === "string" ? projectOrKey : projectOrKey.sonarProjectKey;
  const data = await sonarFetch(`/api/qualitygates/project_status?projectKey=${encodeURIComponent(projectKey)}`, typeof projectOrKey === "string" ? null : projectOrKey);
  return data.projectStatus || { status: "UNKNOWN" };
}

async function importQualitySnapshot(project) {
  const metricKeys = [
    "alert_status",
    "bugs",
    "vulnerabilities",
    "security_hotspots",
    "code_smells",
    "coverage",
    "duplicated_lines_density",
    "reliability_rating",
    "security_rating",
    "sqale_rating",
    "sqale_index",
    "ncloc"
  ];
  const data = await sonarFetch(
    `/api/measures/component?component=${encodeURIComponent(project.sonarProjectKey)}&metricKeys=${metricKeys.join(",")}`,
    project
  );
  const measures = Object.fromEntries((data.component?.measures || []).map((measure) => [measure.metric, measure.value]));
  const gate = await sonarQualityGate(project).catch(() => ({ status: measures.alert_status || "UNKNOWN" }));
  const snapshot = {
    id: crypto.randomUUID(),
    projectId: project.id,
    projectSlug: project.slug,
    branch: project.defaultBranch,
    pullRequest: null,
    analysisTimestamp: nowIso(),
    qualityGate: gate.status || measures.alert_status || "UNKNOWN",
    metrics: measures,
    links: sonarLinks(project),
    source: "sonarqube",
    createdAt: nowIso()
  };
  state.qualitySnapshots.unshift(snapshot);
  state.qualitySnapshots = state.qualitySnapshots.slice(0, 500);
  await saveState();
  return snapshot;
}

async function platformQualitySecurityOverview() {
  const projectReports = await Promise.all(state.projects.map(async (project) => {
    try {
      const report = await qualitySecurityOverview(project);
      return {
        projectId: project.id,
        projectSlug: project.slug,
        projectName: project.displayName,
        status: report.status,
        counts: report.counts,
        signals: report.signals,
        findings: (report.findings || []).slice(0, 20)
      };
    } catch (error) {
      const finding = qualitySecurityFinding({
        severity: "critical",
        category: "platform",
        scanner: "quality-security",
        code: "PROJECT_QUALITY_SECURITY_FAILED",
        title: "No se pudo evaluar calidad y seguridad del proyecto",
        detail: error.message,
        evidence: error.code || "quality-security overview failed",
        project
      });
      return {
        projectId: project.id,
        projectSlug: project.slug,
        projectName: project.displayName,
        status: "ERROR",
        counts: findingCounts([finding]),
        signals: {},
        findings: [finding]
      };
    }
  }));
  const findings = projectReports
    .flatMap((report) => report.findings || [])
    .sort(compareQualitySecurityFindings);
  return {
    generatedAt: nowIso(),
    environment: "local",
    status: qualitySecurityRollupStatus(projectReports.map((report) => report.status), findings),
    counts: sumFindingCounts(projectReports.map((report) => report.counts)),
    scannerPolicy: {
      execution: "read-only",
      secretValues: "redacted",
      dependencyMode: "static manifests and lockfiles",
      containerMode: "Dockerfile and Compose static checks"
    },
    projects: projectReports,
    findings: findings.slice(0, 250)
  };
}

async function qualitySecurityOverview(project) {
  let abs = "";
  let discovered = null;
  try {
    abs = await canonicalProjectPath(project.repositoryPath);
    discovered = await discoverRepository(project.repositoryPath);
  } catch (error) {
    const finding = qualitySecurityFinding({
      severity: "critical",
      category: "configuration",
      scanner: "quality-security",
      code: "PROJECT_PATH_NOT_SCANNABLE",
      title: "El repositorio no se pudo resolver para escaneo",
      detail: "La Fase 3 necesita leer el repositorio dentro de PROJECTS_ROOT para validar calidad y seguridad.",
      evidence: error.message,
      project
    });
    return {
      generatedAt: nowIso(),
      projectId: project.id,
      projectSlug: project.slug,
      environment: "local",
      status: "ERROR",
      counts: findingCounts([finding]),
      signals: {},
      tests: unavailableQualitySecuritySignal("tests", "No verificable por ruta invalida."),
      sonarqube: unavailableQualitySecuritySignal("sonarqube", "No verificable por ruta invalida."),
      dependencies: unavailableQualitySecuritySignal("dependencies", "No verificable por ruta invalida."),
      secretScanning: unavailableQualitySecuritySignal("secret-scanning", "No verificable por ruta invalida."),
      containerScanning: unavailableQualitySecuritySignal("container-scanning", "No verificable por ruta invalida."),
      findings: [finding]
    };
  }

  const [platform, tests, sonarqube, dependencies, secretScanning, containerScanning] = await Promise.all([
    platformStatus(),
    testsQualityOverview(project, discovered),
    sonarQualitySecurityOverview(project, discovered),
    dependencySecurityOverview(project, abs, discovered),
    secretSecurityOverview(project, abs),
    containerSecurityOverview(project, abs, discovered)
  ]);
  const service = serviceStatus(platform, "sonarqube");
  if (sonarqube.service?.status === "UNKNOWN") {
    sonarqube.service = {
      name: "sonarqube",
      status: service.status === "UP" ? "UP" : "DOWN",
      url: service.url || publicToolUrl("sonarqube"),
      evidence: service.status === "UP" ? "system status reachable" : service.error || service.details || "SonarQube no responde"
    };
  }
  const findings = [
    ...(tests.findings || []),
    ...(sonarqube.findings || []),
    ...(dependencies.findings || []),
    ...(secretScanning.findings || []),
    ...(containerScanning.findings || [])
  ].sort(compareQualitySecurityFindings);
  const signals = {
    tests: tests.status,
    sonarqube: sonarqube.status,
    dependencies: dependencies.status,
    secretScanning: secretScanning.status,
    containerScanning: containerScanning.status
  };
  return {
    generatedAt: nowIso(),
    projectId: project.id,
    projectSlug: project.slug,
    environment: "local",
    status: qualitySecurityRollupStatus(Object.values(signals), findings),
    counts: findingCounts(findings),
    signals,
    tests,
    sonarqube,
    dependencies,
    secretScanning,
    containerScanning,
    findings: findings.slice(0, 250)
  };
}

function unavailableQualitySecuritySignal(source, summary) {
  return {
    source,
    status: "ERROR",
    summary,
    evidence: "project path unavailable",
    findings: []
  };
}

function testsQualityOverview(project, discovered) {
  const commands = discovered.approvedCommands || [];
  const testCommands = commands.filter((command) => command.action === "tests");
  const coverageCommands = commands.filter((command) => command.action === "coverage");
  const latestRelevantJob = state.jobs.find((job) => (
    job.projectId === project.id &&
    ["tests", "coverage", "full"].includes(job.action)
  )) || null;
  const coverageArtifacts = discovered.coverageArtifacts || [];
  const findings = [];
  if (!testCommands.length) {
    findings.push(qualitySecurityFinding({
      severity: "warning",
      category: "quality",
      scanner: "tests",
      code: "TEST_COMMAND_NOT_DETECTED",
      title: "No hay template de tests aprobado",
      detail: "El hub no encontro un comando de tests seguro para ejecutar desde la UI.",
      evidence: "approvedCommands.tests=0",
      suggestedAction: "Agregar script test, Maven test, Gradle test, pytest o flutter test detectable.",
      targetTab: "quality",
      project
    }));
  }
  if (!coverageCommands.length) {
    findings.push(qualitySecurityFinding({
      severity: "warning",
      category: "quality",
      scanner: "tests",
      code: "COVERAGE_COMMAND_NOT_DETECTED",
      title: "No hay template de coverage aprobado",
      detail: "Sin coverage local, SonarQube puede importar metricas incompletas.",
      evidence: "approvedCommands.coverage=0",
      suggestedAction: "Agregar un script de coverage que genere LCOV, JaCoCo XML o coverage.xml.",
      targetTab: "quality",
      project
    }));
  }
  if (!coverageArtifacts.length) {
    findings.push(qualitySecurityFinding({
      severity: "info",
      category: "quality",
      scanner: "tests",
      code: "COVERAGE_ARTIFACT_NOT_FOUND",
      title: "No se detecto artefacto de coverage",
      detail: "Todavia no hay evidencia local de cobertura generada.",
      evidence: "coverageArtifacts=0",
      suggestedAction: "Ejecutar coverage desde el panel antes de evaluar cobertura real.",
      targetTab: "quality",
      project
    }));
  }
  if (latestRelevantJob && ["FAILED", "TIMED_OUT", "CANCELLED"].includes(latestRelevantJob.status)) {
    findings.push(qualitySecurityFinding({
      severity: latestRelevantJob.status === "CANCELLED" ? "warning" : "critical",
      category: "quality",
      scanner: "tests",
      code: "LATEST_QUALITY_JOB_FAILED",
      title: `Ultimo job de calidad ${latestRelevantJob.status}`,
      detail: "La evidencia ejecutada mas reciente no termino correctamente.",
      evidence: `job=${latestRelevantJob.id}, action=${latestRelevantJob.action}`,
      suggestedAction: "Abrir Ejecuciones y corregir la causa raiz del fallo.",
      targetTab: "executions",
      project
    }));
  }
  const verified = Boolean(latestRelevantJob?.status === "SUCCEEDED" || coverageArtifacts.length);
  return {
    source: "local-runner",
    status: qualitySecuritySignalStatus({
      configured: testCommands.length > 0,
      verified,
      findings
    }),
    summary: testCommands.length
      ? `${testCommands.length} template(s) de tests y ${coverageCommands.length} template(s) de coverage detectados.`
      : "No hay templates de tests aprobados para este proyecto.",
    evidence: `tests=${testCommands.length}, coverage=${coverageCommands.length}, artifacts=${coverageArtifacts.length}, latestJob=${latestRelevantJob?.status || "none"}`,
    approvedCommands: {
      tests: testCommands.map(publicCommandEvidence),
      coverage: coverageCommands.map(publicCommandEvidence)
    },
    coverageArtifacts,
    latestJob: latestRelevantJob ? {
      id: latestRelevantJob.id,
      action: latestRelevantJob.action,
      status: latestRelevantJob.status,
      createdAt: latestRelevantJob.createdAt,
      finishedAt: latestRelevantJob.finishedAt || ""
    } : null,
    links: [{ label: "Ejecuciones del proyecto", url: "#executions" }],
    findings
  };
}

async function sonarQualitySecurityOverview(project, discovered) {
  const findings = [];
  const sonarCommands = (discovered.approvedCommands || []).filter((command) => command.action === "sonar");
  const configured = Boolean(project.sonarProjectKey && sonarCommands.length);
  const existingSnapshot = state.qualitySnapshots.find((snapshot) => snapshot.projectId === project.id) || null;
  let snapshot = existingSnapshot;
  let service = { name: "sonarqube", status: "UNKNOWN", url: publicToolUrl("sonarqube"), evidence: "" };
  let sonarError = "";
  try {
    const system = await sonarFetch("/api/system/status", project);
    service = {
      name: "sonarqube",
      status: "UP",
      url: publicToolUrl("sonarqube"),
      evidence: `system=${system.status || "UP"}`
    };
    snapshot = await importQualitySnapshot(project).catch(() => existingSnapshot);
  } catch (error) {
    sonarError = sanitizeText(error.message);
    service = {
      name: "sonarqube",
      status: "DOWN",
      url: publicToolUrl("sonarqube"),
      evidence: sonarError
    };
  }
  if (!project.sonarProjectKey) {
    findings.push(qualitySecurityFinding({
      severity: "warning",
      category: "quality",
      scanner: "sonarqube",
      code: "SONAR_PROJECT_KEY_MISSING",
      title: "Falta sonarProjectKey",
      detail: "El proyecto no tiene clave declarada para vincularse con SonarQube.",
      evidence: "sonarProjectKey empty",
      suggestedAction: "Definir sonarProjectKey en el catalogo/proyecto.",
      targetTab: "configuration",
      project
    }));
  }
  if (!sonarCommands.length) {
    findings.push(qualitySecurityFinding({
      severity: "warning",
      category: "quality",
      scanner: "sonarqube",
      code: "SONAR_COMMAND_NOT_DETECTED",
      title: "No hay comando Sonar aprobado",
      detail: "El hub no encontro sonar-project.properties ni script local de scanner.",
      evidence: "approvedCommands.sonar=0",
      suggestedAction: "Agregar sonar-project.properties o scripts/quality/sonar-scan-local.sh compatible.",
      targetTab: "configuration",
      project
    }));
  }
  if (service.status !== "UP") {
    findings.push(qualitySecurityFinding({
      severity: "info",
      category: "quality",
      scanner: "sonarqube",
      code: "SONARQUBE_NOT_REACHABLE",
      title: "SonarQube no esta verificable",
      detail: "La Fase 3 conserva evidencia local, pero no pudo consultar la instancia Sonar activa.",
      evidence: sonarError || "SonarQube API not reachable",
      suggestedAction: "Levantar SonarQube o revisar SONAR_HOST_URL/token antes de importar Quality Gate.",
      targetTab: "quality",
      project
    }));
  }
  const gate = String(snapshot?.qualityGate || "").toUpperCase();
  if (gate && !["OK", "NONE", "UNKNOWN", "SIN DATOS"].includes(gate)) {
    findings.push(qualitySecurityFinding({
      severity: "critical",
      category: "quality",
      scanner: "sonarqube",
      code: "SONAR_QUALITY_GATE_FAILED",
      title: `Quality Gate ${gate}`,
      detail: "El ultimo snapshot importado desde SonarQube no esta en OK.",
      evidence: `qualityGate=${gate}`,
      suggestedAction: "Corregir vulnerabilities, bugs y issues criticos en SonarQube sin ocultarlos.",
      targetTab: "quality",
      project
    }));
  }
  if (!snapshot) {
    findings.push(qualitySecurityFinding({
      severity: "info",
      category: "quality",
      scanner: "sonarqube",
      code: "SONAR_SNAPSHOT_MISSING",
      title: "No hay snapshot Sonar importado",
      detail: "No existe evidencia historica de Quality Gate/cobertura para este proyecto.",
      evidence: "qualitySnapshots=0",
      suggestedAction: "Ejecutar Sonar desde el panel cuando la instancia este disponible.",
      targetTab: "quality",
      project
    }));
  }
  return {
    source: "sonarqube",
    status: qualitySecuritySignalStatus({
      configured,
      verified: Boolean(snapshot && service.status === "UP"),
      findings
    }),
    summary: snapshot
      ? `Quality Gate ${snapshot.qualityGate || "UNKNOWN"} importado ${snapshot.analysisTimestamp || ""}.`
      : configured
        ? "Sonar esta configurado, pero no hay snapshot verificado todavia."
        : "SonarQube no esta completamente configurado para este proyecto.",
    evidence: `service=${service.status}, projectKey=${project.sonarProjectKey || "missing"}, snapshot=${snapshot ? "yes" : "no"}`,
    service,
    projectKey: project.sonarProjectKey || "",
    metrics: snapshot?.metrics || {},
    snapshot: snapshot ? {
      id: snapshot.id,
      qualityGate: snapshot.qualityGate,
      analysisTimestamp: snapshot.analysisTimestamp,
      source: snapshot.source,
      links: snapshot.links
    } : null,
    links: Object.entries(sonarLinks(project)).map(([label, url]) => ({ label, url })),
    findings
  };
}

async function dependencySecurityOverview(project, abs, discovered) {
  const files = await listRepositoryFiles(abs, {
    maxDepth: 7,
    matcher: (name) => [
      "package.json",
      "package-lock.json",
      "npm-shrinkwrap.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "pom.xml",
      "build.gradle",
      "build.gradle.kts",
      "requirements.txt",
      "pyproject.toml",
      "Pipfile.lock",
      "poetry.lock",
      "uv.lock",
      "pubspec.yaml",
      "pubspec.lock"
    ].includes(name)
  });
  const findings = [];
  const manifests = [];
  const lockfiles = [];
  const packages = [];
  const lockfileSet = new Set(files.filter((file) => isDependencyLockfile(file.relativePath)).map((file) => file.relativePath));

  for (const file of files) {
    const name = path.basename(file.relativePath);
    if (isDependencyLockfile(file.relativePath)) {
      lockfiles.push(file.relativePath);
      continue;
    }
    manifests.push(file.relativePath);
    if (name === "package.json") {
      await inspectPackageJsonDependencies(project, abs, file, lockfileSet, findings, packages);
      continue;
    }
    if (name === "requirements.txt") {
      await inspectRequirementsDependencies(project, file, findings, packages);
      continue;
    }
    if (name === "pom.xml") {
      await inspectTextDependencyManifest(project, file, "maven", findings);
      continue;
    }
    if (["build.gradle", "build.gradle.kts"].includes(name)) {
      await inspectTextDependencyManifest(project, file, "gradle", findings);
      continue;
    }
    if (["pyproject.toml", "pubspec.yaml"].includes(name)) {
      await inspectTextDependencyManifest(project, file, name === "pubspec.yaml" ? "dart" : "python", findings);
    }
  }

  return {
    source: "static-dependency-scan",
    status: qualitySecuritySignalStatus({
      configured: manifests.length > 0,
      verified: manifests.length > 0,
      findings
    }),
    summary: manifests.length
      ? `${manifests.length} manifest(s), ${lockfiles.length} lockfile(s), ${packages.length} dependencia(s) inspeccionadas.`
      : "No se detectaron manifests de dependencias soportados.",
    evidence: `manifests=${manifests.length}, lockfiles=${lockfiles.length}, packages=${packages.length}`,
    manifests,
    lockfiles,
    packageCount: packages.length,
    riskyPackages: packages.filter((item) => item.risk).slice(0, 40),
    findings
  };
}

async function inspectPackageJsonDependencies(project, abs, file, lockfileSet, findings, packages) {
  const packageJson = await readJsonIfExists(file.absolutePath);
  if (!packageJson) {
    findings.push(qualitySecurityFinding({
      severity: "warning",
      category: "dependencies",
      scanner: "dependency-scan",
      code: "PACKAGE_JSON_UNREADABLE",
      title: "package.json no se pudo parsear",
      detail: "El manifest Node no es JSON valido o no se pudo leer.",
      evidence: file.relativePath,
      path: file.relativePath,
      project
    }));
    return;
  }
  const cwd = relativeDir(file.relativePath);
  const hasLockfile = hasNodeLockfile(abs, cwd, lockfileSet);
  if (!hasLockfile) {
    findings.push(qualitySecurityFinding({
      severity: "warning",
      category: "dependencies",
      scanner: "dependency-scan",
      code: "NODE_LOCKFILE_MISSING",
      title: "Dependencias Node sin lockfile",
      detail: "El paquete tiene dependencias pero no se detecto package-lock, pnpm-lock ni yarn.lock para reproducibilidad.",
      evidence: file.relativePath,
      path: file.relativePath,
      project
    }));
  }
  const scriptEntries = Object.entries(packageJson.scripts || {});
  for (const [scriptName, script] of scriptEntries) {
    if (/(curl|wget)\s+[^|;&]+[|]\s*(sh|bash)|\b(sh|bash)\s+-c\s+/i.test(String(script))) {
      findings.push(qualitySecurityFinding({
        severity: "critical",
        category: "dependencies",
        scanner: "dependency-scan",
        code: "PACKAGE_SCRIPT_REMOTE_EXECUTION",
        title: "Script npm ejecuta shell remoto",
        detail: "Los scripts de install/build no deben descargar y ejecutar codigo remoto sin pinning/verificacion.",
        evidence: `${scriptName}: ${sanitizeText(script).slice(0, 160)}`,
        path: file.relativePath,
        project
      }));
    }
  }
  const deps = {
    dependencies: packageJson.dependencies || {},
    devDependencies: packageJson.devDependencies || {},
    optionalDependencies: packageJson.optionalDependencies || {}
  };
  for (const [scope, entries] of Object.entries(deps)) {
    for (const [name, version] of Object.entries(entries)) {
      const risk = dependencyVersionRisk(name, version, hasLockfile);
      packages.push({ ecosystem: "npm", name, version: sanitizeDependencyVersion(version), scope, manifest: file.relativePath, risk: risk?.code || "" });
      if (!risk) continue;
      findings.push(qualitySecurityFinding({
        severity: risk.severity,
        category: "dependencies",
        scanner: "dependency-scan",
        code: risk.code,
        title: risk.title,
        detail: risk.detail,
        evidence: `${name}@${sanitizeDependencyVersion(version)}`,
        path: file.relativePath,
        project
      }));
    }
  }
}

async function inspectRequirementsDependencies(project, file, findings, packages) {
  const text = await fs.readFile(file.absolutePath, "utf8").catch(() => "");
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-r ") || trimmed.startsWith("--")) return;
    const name = trimmed.split(/[=<>~\s;]/)[0];
    packages.push({ ecosystem: "python", name, version: sanitizeDependencyVersion(trimmed), manifest: file.relativePath, risk: "" });
    if (/git\+|https?:\/\//i.test(trimmed)) {
      findings.push(qualitySecurityFinding({
        severity: "warning",
        category: "dependencies",
        scanner: "dependency-scan",
        code: "PYTHON_REMOTE_DEPENDENCY",
        title: "Dependencia Python remota",
        detail: "Las dependencias remotas deben fijarse por commit/hash y revisarse antes de ejecutar installs.",
        evidence: sanitizeDependencyVersion(trimmed),
        path: file.relativePath,
        line: index + 1,
        project
      }));
    } else if (!/[=]=|[=]==/.test(trimmed)) {
      findings.push(qualitySecurityFinding({
        severity: "warning",
        category: "dependencies",
        scanner: "dependency-scan",
        code: "PYTHON_DEPENDENCY_NOT_PINNED",
        title: "Dependencia Python sin version exacta",
        detail: "requirements.txt debe usar versiones reproducibles para scans y builds confiables.",
        evidence: sanitizeDependencyVersion(trimmed),
        path: file.relativePath,
        line: index + 1,
        project
      }));
    }
  });
}

async function inspectTextDependencyManifest(project, file, ecosystem, findings) {
  const text = await fs.readFile(file.absolutePath, "utf8").catch(() => "");
  const checks = [
    {
      code: "DEPENDENCY_DYNAMIC_VERSION",
      severity: "warning",
      pattern: /(?:latest\.release|latest\.integration|SNAPSHOT|version\s*[:=]\s*["'][^"']*[+][^"']*["']|:\s*["'][^"']*[+][^"']*["'])/ig,
      title: "Version dinamica en manifest de dependencias",
      detail: "Las versiones dinamicas reducen reproducibilidad y hacen menos confiables los scans."
    },
    {
      code: "DEPENDENCY_INSECURE_REPOSITORY",
      severity: "warning",
      pattern: /https?:\/\/[^\s"']+/ig,
      title: "Repositorio/dependencia por URL directa",
      detail: "Las URLs directas deben justificarse y preferir HTTPS con pinning verificable."
    }
  ];
  for (const check of checks) {
    for (const match of text.matchAll(check.pattern)) {
      if (check.code === "DEPENDENCY_INSECURE_REPOSITORY" && String(match[0]).startsWith("https://")) continue;
      findings.push(qualitySecurityFinding({
        severity: check.severity,
        category: "dependencies",
        scanner: "dependency-scan",
        code: check.code,
        title: check.title,
        detail: `${check.detail} Ecosistema: ${ecosystem}.`,
        evidence: sanitizeDependencyVersion(match[0]),
        path: file.relativePath,
        line: lineNumberAtIndex(text, match.index || 0),
        project
      }));
    }
  }
}

async function secretSecurityOverview(project, abs) {
  const candidates = await securityCandidateFiles(abs, {
    maxDepth: 8,
    maxFiles: 8000,
    maxFileBytes: 512 * 1024
  });
  const findings = [];
  let scannedFiles = 0;
  let skippedFiles = candidates.skippedFiles || 0;
  for (const file of candidates.files) {
    const buffer = await fs.readFile(file.absolutePath).catch(() => null);
    if (!buffer || !isLikelyTextBuffer(buffer)) {
      skippedFiles += 1;
      continue;
    }
    const text = buffer.toString("utf8");
    scannedFiles += 1;
    scanSecretsInText(project, file.relativePath, text, findings);
    if (findings.length >= 80) break;
  }
  return {
    source: "static-secret-scan",
    status: qualitySecuritySignalStatus({
      configured: true,
      verified: true,
      findings
    }),
    summary: findings.length
      ? `${findings.length} hallazgo(s) de secreto o placeholder sensible detectados.`
      : "No se detectaron secretos reales con los patrones locales.",
    evidence: `files=${scannedFiles}, skipped=${skippedFiles}, findings=${findings.length}`,
    scannedFiles,
    skippedFiles,
    findings
  };
}

async function containerSecurityOverview(project, abs, discovered) {
  const manifestPaths = (discovered.manifests || []).filter((relativePath) => {
    const name = path.basename(relativePath);
    return name === "Dockerfile" || ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"].includes(name) || /^docker-compose[\w.-]*\.ya?ml$/i.test(name);
  });
  const findings = [];
  const dockerfiles = [];
  const composeFiles = [];
  for (const relativePath of manifestPaths) {
    const absolutePath = path.join(abs, relativePath);
    const text = await fs.readFile(absolutePath, "utf8").catch(() => "");
    if (path.basename(relativePath) === "Dockerfile") {
      dockerfiles.push(relativePath);
      inspectDockerfileSecurity(project, relativePath, text, findings);
    } else {
      composeFiles.push(relativePath);
      inspectComposeSecurity(project, relativePath, text, findings);
    }
  }
  return {
    source: "static-container-scan",
    status: qualitySecuritySignalStatus({
      configured: manifestPaths.length > 0,
      verified: manifestPaths.length > 0,
      findings
    }),
    summary: manifestPaths.length
      ? `${dockerfiles.length} Dockerfile(s) y ${composeFiles.length} Compose file(s) inspeccionados.`
      : "No hay artefactos Docker/Compose detectados para este proyecto.",
    evidence: `dockerfiles=${dockerfiles.length}, compose=${composeFiles.length}, findings=${findings.length}`,
    dockerfiles,
    composeFiles,
    findings
  };
}

function inspectDockerfileSecurity(project, relativePath, text, findings) {
  const lines = String(text || "").split(/\r?\n/);
  let hasUser = false;
  let hasHealthcheck = false;
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const from = trimmed.match(/^FROM\s+([^\s]+)(?:\s+AS\s+\S+)?$/i);
    if (from) {
      const image = from[1];
      if (imageUsesFloatingTag(image)) {
        findings.push(qualitySecurityFinding({
          severity: "warning",
          category: "container",
          scanner: "container-scan",
          code: "CONTAINER_BASE_IMAGE_FLOATING",
          title: "Imagen base sin version fija",
          detail: "Usar tags concretos y, para builds criticos, digest sha256.",
          evidence: image,
          path: relativePath,
          line: index + 1,
          project
        }));
      }
      if (!image.includes("@sha256:")) {
        findings.push(qualitySecurityFinding({
          severity: "info",
          category: "container",
          scanner: "container-scan",
          code: "CONTAINER_BASE_IMAGE_WITHOUT_DIGEST",
          title: "Imagen base sin digest",
          detail: "Un digest reduce drift entre builds y hace mas reproducible el scan.",
          evidence: image,
          path: relativePath,
          line: index + 1,
          project
        }));
      }
    }
    if (/^USER\s+/i.test(trimmed)) {
      hasUser = true;
      if (/^USER\s+(root|0)(\s|$)/i.test(trimmed)) {
        findings.push(qualitySecurityFinding({
          severity: "warning",
          category: "container",
          scanner: "container-scan",
          code: "CONTAINER_RUNS_AS_ROOT",
          title: "Dockerfile declara USER root",
          detail: "Los contenedores de aplicacion deberian correr con usuario no-root cuando sea posible.",
          evidence: trimmed,
          path: relativePath,
          line: index + 1,
          project
        }));
      }
    }
    if (/^HEALTHCHECK\s+/i.test(trimmed)) hasHealthcheck = true;
    if (/\b(curl|wget)\b[^|;&]+[|]\s*(sh|bash)\b/i.test(trimmed)) {
      findings.push(qualitySecurityFinding({
        severity: "critical",
        category: "container",
        scanner: "container-scan",
        code: "CONTAINER_REMOTE_SCRIPT_EXECUTION",
        title: "Dockerfile ejecuta script remoto",
        detail: "Evitar curl/wget pipeado a shell; usar artefactos versionados y verificados.",
        evidence: sanitizeText(trimmed).slice(0, 180),
        path: relativePath,
        line: index + 1,
        project
      }));
    }
  });
  if (text.trim() && !hasUser) {
    findings.push(qualitySecurityFinding({
      severity: "warning",
      category: "container",
      scanner: "container-scan",
      code: "CONTAINER_USER_NOT_DECLARED",
      title: "Dockerfile no declara usuario no-root",
      detail: "Sin USER explicito, la imagen suele correr como root.",
      evidence: "USER missing",
      path: relativePath,
      project
    }));
  }
  if (text.trim() && !hasHealthcheck) {
    findings.push(qualitySecurityFinding({
      severity: "info",
      category: "container",
      scanner: "container-scan",
      code: "CONTAINER_HEALTHCHECK_MISSING",
      title: "Dockerfile sin HEALTHCHECK",
      detail: "Un healthcheck local mejora verificaciones y alertas del hub.",
      evidence: "HEALTHCHECK missing",
      path: relativePath,
      project
    }));
  }
}

function inspectComposeSecurity(project, relativePath, text, findings) {
  const lines = String(text || "").split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const lineNo = index + 1;
    const image = trimmed.match(/^image:\s*["']?([^"'\s]+)["']?/i);
    if (image && imageUsesFloatingTag(image[1])) {
      findings.push(qualitySecurityFinding({
        severity: "warning",
        category: "container",
        scanner: "container-scan",
        code: "COMPOSE_IMAGE_FLOATING_TAG",
        title: "Compose usa imagen sin version fija",
        detail: "Evitar latest o tags ausentes en servicios reproducibles.",
        evidence: image[1],
        path: relativePath,
        line: lineNo,
        project
      }));
    }
    if (/privileged:\s*true/i.test(trimmed)) {
      findings.push(qualitySecurityFinding({
        severity: "critical",
        category: "container",
        scanner: "container-scan",
        code: "COMPOSE_PRIVILEGED_CONTAINER",
        title: "Servicio Compose privilegiado",
        detail: "privileged:true entrega capacidades amplias al contenedor y requiere aprobacion explicita.",
        evidence: trimmed,
        path: relativePath,
        line: lineNo,
        project
      }));
    }
    if (/network_mode:\s*["']?host["']?/i.test(trimmed) || /\b(pid|ipc|uts):\s*["']?host["']?/i.test(trimmed)) {
      findings.push(qualitySecurityFinding({
        severity: "warning",
        category: "container",
        scanner: "container-scan",
        code: "COMPOSE_HOST_NAMESPACE",
        title: "Compose comparte namespace del host",
        detail: "Los namespaces host aumentan acoplamiento y superficie de ataque.",
        evidence: trimmed,
        path: relativePath,
        line: lineNo,
        project
      }));
    }
    if (/\/var\/run\/docker\.sock/i.test(trimmed)) {
      findings.push(qualitySecurityFinding({
        severity: "critical",
        category: "container",
        scanner: "container-scan",
        code: "COMPOSE_DOCKER_SOCKET_MOUNT",
        title: "Compose monta Docker socket",
        detail: "Montar docker.sock equivale a control amplio sobre Docker Desktop.",
        evidence: trimmed,
        path: relativePath,
        line: lineNo,
        project
      }));
    }
    if (/[-\s]\/:\//.test(trimmed) || /source:\s*["']?\/["']?$/i.test(trimmed)) {
      findings.push(qualitySecurityFinding({
        severity: "critical",
        category: "container",
        scanner: "container-scan",
        code: "COMPOSE_HOST_ROOT_MOUNT",
        title: "Compose monta raiz del host",
        detail: "Montar / del host en un contenedor no es aceptable para proyectos locales.",
        evidence: trimmed,
        path: relativePath,
        line: lineNo,
        project
      }));
    }
    const envSecret = trimmed.match(/^[-\s]*([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|ACCESS_KEY)[A-Z0-9_]*)\s*[:=]\s*(.+)$/i);
    if (envSecret && !secretValueLooksPlaceholder(envSecret[2])) {
      findings.push(qualitySecurityFinding({
        severity: "critical",
        category: "container",
        scanner: "container-scan",
        code: "COMPOSE_INLINE_SECRET",
        title: "Compose contiene secreto inline",
        detail: "Los secretos deben inyectarse por entorno/secret manager local, no declararse en compose versionable.",
        evidence: `${envSecret[1]}:${redactSecretValue(envSecret[2])}`,
        path: relativePath,
        line: lineNo,
        project
      }));
    }
    if (/0\.0\.0\.0:\d+:\d+/.test(trimmed)) {
      findings.push(qualitySecurityFinding({
        severity: "warning",
        category: "container",
        scanner: "container-scan",
        code: "COMPOSE_PORT_BINDS_ALL_INTERFACES",
        title: "Puerto publicado en todas las interfaces",
        detail: "Para entorno local preferir 127.0.0.1 cuando no se necesita acceso LAN.",
        evidence: trimmed,
        path: relativePath,
        line: lineNo,
        project
      }));
    }
  });
}

function scanSecretsInText(project, relativePath, text, findings) {
  const lines = String(text || "").split(/\r?\n/);
  const patterns = [
    {
      code: "PRIVATE_KEY_MATERIAL",
      severity: "critical",
      title: "Clave privada detectada",
      detail: "El repositorio contiene material de clave privada.",
      pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g
    },
    {
      code: "SONAR_TOKEN_LITERAL",
      severity: "critical",
      title: "Token Sonar literal detectado",
      detail: "Los tokens Sonar deben vivir fuera del repositorio.",
      pattern: /sqp_[A-Za-z0-9]{20,}/g
    },
    {
      code: "GITHUB_TOKEN_LITERAL",
      severity: "critical",
      title: "Token GitHub literal detectado",
      detail: "Los tokens GitHub deben rotarse y sacarse del repositorio.",
      pattern: /gh[pousr]_[A-Za-z0-9_]{30,}/g
    },
    {
      code: "AWS_ACCESS_KEY_LITERAL",
      severity: "critical",
      title: "AWS access key detectada",
      detail: "Las access keys no deben estar en codigo ni manifests.",
      pattern: /AKIA[0-9A-Z]{16}/g
    },
    {
      code: "GOOGLE_API_KEY_LITERAL",
      severity: "critical",
      title: "Google API key detectada",
      detail: "Las API keys deben estar fuera del repo y restringidas por origen/servicio.",
      pattern: /AIza[0-9A-Za-z_-]{35}/g
    }
  ];
  lines.forEach((line, index) => {
    if (!line || /^\s*#/.test(line)) return;
    for (const item of patterns) {
      item.pattern.lastIndex = 0;
      for (const match of line.matchAll(item.pattern)) {
        const key = match[1] || item.code;
        const value = match[2] || match[0];
        const placeholder = secretValueLooksPlaceholder(value);
        const severity = placeholder ? "info" : item.severity;
        findings.push(qualitySecurityFinding({
          severity,
          category: "security",
          scanner: "secret-scan",
          code: placeholder ? `${item.code}_PLACEHOLDER` : item.code,
          title: placeholder ? "Placeholder sensible detectado" : item.title,
          detail: placeholder
            ? "El archivo contiene una variable sensible con valor de ejemplo. No es un secreto real, pero conviene mantenerlo como placeholder claro."
            : item.detail,
          evidence: `${key}:${redactSecretValue(value)}`,
          path: relativePath,
          line: index + 1,
          project
        }));
      }
    }
    const genericPattern = genericSecretPatternFor(relativePath);
    genericPattern.lastIndex = 0;
    for (const match of line.matchAll(genericPattern)) {
      const key = match[1] || "SECRET";
      const value = match[2] || "";
      const placeholder = secretValueLooksPlaceholder(value);
      findings.push(qualitySecurityFinding({
        severity: placeholder ? "info" : "critical",
        category: "security",
        scanner: "secret-scan",
        code: placeholder ? "GENERIC_SECRET_ASSIGNMENT_PLACEHOLDER" : "GENERIC_SECRET_ASSIGNMENT",
        title: placeholder ? "Placeholder sensible detectado" : "Variable sensible con valor literal",
        detail: placeholder
          ? "El archivo contiene una variable sensible con valor de ejemplo. No es un secreto real, pero conviene mantenerlo como placeholder claro."
          : "Las variables secretas deben inyectarse por entorno local o vault, no quedar en archivos versionables.",
        evidence: `${key}:${redactSecretValue(value)}`,
        path: relativePath,
        line: index + 1,
        project
      }));
    }
  });
}

async function securityCandidateFiles(root, options = {}) {
  const maxDepth = options.maxDepth ?? 8;
  const maxFiles = options.maxFiles ?? 8000;
  const maxFileBytes = options.maxFileBytes ?? 512 * 1024;
  const files = [];
  let skippedFiles = 0;

  async function walk(dir, depth) {
    if (depth > maxDepth || files.length >= maxFiles) return;
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      skippedFiles += 1;
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        skippedFiles += 1;
        continue;
      }
      const absolutePath = path.join(dir, entry.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
      if (entry.isDirectory()) {
        if (shouldSkipSecurityPath(relativePath, true)) {
          skippedFiles += 1;
          continue;
        }
        await walk(absolutePath, depth + 1);
        continue;
      }
      if (!entry.isFile() || shouldSkipSecurityPath(relativePath, false)) {
        skippedFiles += 1;
        continue;
      }
      const stat = await fs.stat(absolutePath).catch(() => null);
      if (!stat || stat.size > maxFileBytes) {
        skippedFiles += 1;
        continue;
      }
      files.push({ absolutePath, relativePath, size: stat.size });
    }
  }

  await walk(root, 0);
  return { files, skippedFiles };
}

function shouldSkipSecurityPath(relativePath, isDirectory) {
  const normalized = String(relativePath || "").split(path.sep).join("/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => discoveryIgnoreNames.has(part))) return true;
  if (parts.some((part) => [".git", ".sonar", ".scannerwork", ".cache", ".parcel-cache", ".terraform"].includes(part))) return true;
  if (isDirectory) return false;
  const name = path.basename(normalized);
  if (name === ".DS_Store" || name === "Thumbs.db") return true;
  if (isDependencyLockfile(normalized)) return true;
  if (/\.(png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|tar|tgz|7z|mp4|mov|avi|woff2?|ttf|otf|jar|war|class|sqlite|sqlite3|db|bin|dylib|so|dll|exe)$/i.test(name)) return true;
  return false;
}

function isDependencyLockfile(relativePath) {
  return [
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "Pipfile.lock",
    "poetry.lock",
    "uv.lock",
    "pubspec.lock"
  ].includes(path.basename(relativePath));
}

function hasNodeLockfile(abs, cwd, lockfileSet) {
  const candidates = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"];
  for (const name of candidates) {
    const relative = cwd === "." ? name : `${cwd}/${name}`;
    if (lockfileSet.has(relative) || fsSync.existsSync(path.join(abs, relative))) return true;
  }
  for (const name of candidates) {
    if (lockfileSet.has(name) || fsSync.existsSync(path.join(abs, name))) return true;
  }
  return false;
}

function dependencyVersionRisk(name, version, hasLockfile) {
  const value = String(version || "").trim();
  if (!value) {
    return {
      severity: "warning",
      code: "DEPENDENCY_VERSION_MISSING",
      title: "Dependencia sin version",
      detail: "Una dependencia sin version fija no es reproducible."
    };
  }
  if (/^(latest|[*xX])$/.test(value) || /\s\|\|\s/.test(value)) {
    return {
      severity: "warning",
      code: "DEPENDENCY_FLOATING_VERSION",
      title: "Dependencia con version flotante",
      detail: "latest, * o rangos amplios impiden reproducir el resultado de scans."
    };
  }
  if (/^(git\+|github:|https?:|file:)/i.test(value)) {
    return {
      severity: /^https?:/i.test(value) ? "warning" : "info",
      code: "DEPENDENCY_NON_REGISTRY_SOURCE",
      title: "Dependencia desde fuente no-registry",
      detail: "Las dependencias por Git/URL/file requieren pinning y revision explicita."
    };
  }
  if (!hasLockfile && /^[~^><=]/.test(value)) {
    return {
      severity: "warning",
      code: "DEPENDENCY_RANGE_WITHOUT_LOCKFILE",
      title: "Rango semver sin lockfile",
      detail: "Los rangos semver sin lockfile hacen que installs y scans cambien entre ejecuciones."
    };
  }
  if (["event-stream", "flatmap-stream"].includes(String(name))) {
    return {
      severity: "critical",
      code: "DEPENDENCY_KNOWN_SUPPLY_CHAIN_RISK",
      title: "Paquete historicamente riesgoso",
      detail: "Este paquete requiere revision manual por historial de compromiso/supply chain."
    };
  }
  return null;
}

function sanitizeDependencyVersion(value) {
  return sanitizeText(String(value || "").trim()).slice(0, 180);
}

function imageUsesFloatingTag(image) {
  const value = String(image || "").trim();
  if (!value || value.includes("@sha256:")) return false;
  const lastSlash = value.lastIndexOf("/");
  const lastColon = value.lastIndexOf(":");
  if (lastColon <= lastSlash) return true;
  return value.slice(lastColon + 1) === "latest";
}

function secretValueLooksPlaceholder(value) {
  const raw = String(value || "").trim().replace(/^["']|["']$/g, "");
  if (!raw || raw.startsWith("${") || raw.startsWith("$")) return true;
  return /^(changeme|change-me|change_me|example|sample|placeholder|dummy|test|testing|local|none|null|undefined|xxxx+|<[^>]+>|your[-_].+|redacted|\[redacted\])$/i.test(raw)
    || /change-me-local-only/i.test(raw);
}

function genericSecretPatternFor(relativePath) {
  const pattern = "([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|ACCESS_KEY)[A-Z0-9_]*)\\s*[:=]\\s*[\"']?([^\"'\\s#]{8,})";
  if (isSecretConfigFile(relativePath)) return new RegExp(pattern, "ig");
  return new RegExp(`\\b${pattern}`, "g");
}

function isSecretConfigFile(relativePath) {
  const normalized = String(relativePath || "");
  const name = path.basename(normalized);
  return /^\.env($|\.)/i.test(name)
    || /(^|\/)(compose|docker-compose)[\w.-]*\.ya?ml$/i.test(normalized)
    || /\.(ya?ml|json|toml|properties|conf|config|ini|env|dotenv)$/i.test(name);
}

function isLikelyTextBuffer(buffer) {
  if (!buffer.length) return true;
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  return !sample.includes(0);
}

function redactSecretValue(value) {
  const raw = String(value || "").trim().replace(/^["']|["']$/g, "");
  if (secretValueLooksPlaceholder(raw)) return "[PLACEHOLDER]";
  return `[REDACTED:${hashText(raw).slice(0, 12)}]`;
}

function publicCommandEvidence(command) {
  return {
    action: command.action,
    label: command.label || commandLabel(command),
    cwd: command.cwd || ".",
    source: command.source || "discovery"
  };
}

function qualitySecuritySignalStatus({ configured, verified, findings = [], error = "" }) {
  if (error || findings.some((finding) => finding.severity === "critical")) return "ERROR";
  if (!configured) return "NOT_CONFIGURED";
  if (verified && !findings.some((finding) => finding.severity === "warning")) return "CONFIGURED_AND_VERIFIED";
  if (verified) return "PARTIALLY_CONFIGURED";
  return "CONFIGURED_NOT_VERIFIED";
}

function qualitySecurityRollupStatus(statuses, findings) {
  if (findings.some((finding) => finding.severity === "critical") || statuses.includes("ERROR")) return "ERROR";
  if (statuses.every((status) => status === "CONFIGURED_AND_VERIFIED")) return "CONFIGURED_AND_VERIFIED";
  if (statuses.some((status) => status === "CONFIGURED_AND_VERIFIED" || status === "PARTIALLY_CONFIGURED" || status === "CONFIGURED_NOT_VERIFIED")) return "PARTIALLY_CONFIGURED";
  return "NOT_CONFIGURED";
}

function qualitySecurityFinding(input) {
  const project = input.project || {};
  const idSource = `${project.slug || "platform"}:${input.scanner || ""}:${input.code || ""}:${input.path || ""}:${input.line || ""}:${input.evidence || ""}`;
  return {
    id: slugify(`${input.code || "finding"}-${hashText(idSource).slice(0, 10)}`),
    severity: ["critical", "warning", "info"].includes(input.severity) ? input.severity : "info",
    category: sanitizeText(input.category || "security").slice(0, 80),
    scanner: sanitizeText(input.scanner || "quality-security").slice(0, 80),
    code: sanitizeText(input.code || "FINDING").slice(0, 120),
    title: sanitizeText(input.title || "Hallazgo").slice(0, 220),
    detail: sanitizeText(input.detail || "").slice(0, 900),
    evidence: sanitizeText(input.evidence || "").slice(0, 900),
    suggestedAction: sanitizeText(input.suggestedAction || "").slice(0, 600),
    targetTab: sanitizeText(input.targetTab || "quality").slice(0, 60),
    projectId: project.id || input.projectId || "",
    projectSlug: project.slug || input.projectSlug || "",
    projectName: sanitizeText(project.displayName || input.projectName || "").slice(0, 160),
    path: sanitizeText(input.path || "").slice(0, 240),
    line: input.line ? Number(input.line) : null,
    source: sanitizeText(input.source || input.scanner || "quality-security").slice(0, 120)
  };
}

function findingCounts(findings = []) {
  return findings.reduce((acc, finding) => {
    acc.total += 1;
    acc[finding.severity] = (acc[finding.severity] || 0) + 1;
    return acc;
  }, { total: 0, critical: 0, warning: 0, info: 0 });
}

function sumFindingCounts(counts = []) {
  return counts.reduce((acc, item = {}) => {
    acc.total += Number(item.total || 0);
    acc.critical += Number(item.critical || 0);
    acc.warning += Number(item.warning || 0);
    acc.info += Number(item.info || 0);
    return acc;
  }, { total: 0, critical: 0, warning: 0, info: 0 });
}

function compareQualitySecurityFindings(a, b) {
  const rank = { critical: 0, warning: 1, info: 2 };
  return (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9)
    || String(a.projectSlug || "").localeCompare(String(b.projectSlug || ""))
    || String(a.code || "").localeCompare(String(b.code || ""));
}

function lineNumberAtIndex(text, index) {
  return String(text || "").slice(0, index).split(/\r?\n/).length;
}

async function platformTestingOverview() {
  const projectReports = await Promise.all(state.projects.map(async (project) => {
    try {
      const report = await testingOverview(project);
      return {
        projectId: project.id,
        projectSlug: project.slug,
        projectName: project.displayName,
        status: report.status,
        counts: report.counts,
        guardrails: report.guardrails,
        definitions: report.definitions.slice(0, 24),
        latestExecutions: report.executions.slice(0, 5),
        findings: report.findings.slice(0, 20)
      };
    } catch (error) {
      const finding = testingFinding({
        severity: "critical",
        code: "PROJECT_TESTING_FAILED",
        title: "No se pudo evaluar orquestador de pruebas del proyecto",
        detail: error.message,
        evidence: error.code || "testing overview failed",
        project
      });
      return {
        projectId: project.id,
        projectSlug: project.slug,
        projectName: project.displayName,
        status: "ERROR",
        counts: testingCounts([], [], [finding]),
        guardrails: platformTestingGuardrails(),
        definitions: [],
        latestExecutions: [],
        findings: [finding]
      };
    }
  }));
  const findings = projectReports.flatMap((report) => report.findings || []).sort(compareQualitySecurityFindings);
  return {
    generatedAt: nowIso(),
    environment: "local",
    status: testingRollupStatus(projectReports.map((report) => report.status), findings),
    counts: sumTestingCounts(projectReports.map((report) => report.counts)),
    workerPool: testingWorkerPool(),
    guardrails: platformTestingGuardrails(),
    projects: projectReports,
    findings: findings.slice(0, 250)
  };
}

async function testingOverview(project) {
  let abs = "";
  let discovered = null;
  try {
    abs = await canonicalProjectPath(project.repositoryPath);
    discovered = await discoverRepository(project.repositoryPath);
  } catch (error) {
    const finding = testingFinding({
      severity: "critical",
      code: "PROJECT_PATH_NOT_SCANNABLE",
      title: "El repositorio no se pudo resolver para orquestar pruebas",
      detail: "La Fase 5 necesita leer el proyecto dentro de PROJECTS_ROOT para construir un catalogo cerrado.",
      evidence: error.message,
      project
    });
    return {
      generatedAt: nowIso(),
      projectId: project.id,
      projectSlug: project.slug,
      environment: "local",
      status: "ERROR",
      counts: testingCounts([], [], [finding]),
      workerPool: testingWorkerPool(),
      guardrails: platformTestingGuardrails(),
      definitions: [],
      executions: [],
      findings: [finding]
    };
  }

  const [runtime, httpTargets] = await Promise.all([
    localRuntimeSummary(project, discovered).catch(() => ({ status: "unavailable", resources: [], profiles: [] })),
    testingHttpTargets(project).catch(() => [])
  ]);
  const definitions = await projectTestDefinitions(project, abs, discovered, runtime, httpTargets);
  const executions = state.jobs
    .filter((job) => job.projectId === project.id && testingJobActions.has(job.action))
    .map(publicTestExecution)
    .slice(0, 50);
  const findings = testingFindings(project, definitions, executions, runtime, httpTargets);
  return {
    generatedAt: nowIso(),
    projectId: project.id,
    projectSlug: project.slug,
    environment: "local",
    status: testingRollupStatus(definitions.map((definition) => definition.status), findings),
    counts: testingCounts(definitions, executions, findings),
    workerPool: testingWorkerPool(),
    guardrails: platformTestingGuardrails(),
    targets: httpTargets,
    definitions,
    executions,
    findings
  };
}

function testingWorkerPool() {
  return {
    id: "local-job-worker",
    status: "CONFIGURED_AND_VERIFIED",
    mode: "single-host",
    running: runningJobs.size,
    maxConcurrentJobs,
    timeoutSeconds: jobTimeoutSeconds,
    queueDepth: state.jobs.filter((job) => job.status === "QUEUED").length,
    evidence: "Control API in-process worker with SSE job events and sanitized logs."
  };
}

function platformTestingGuardrails() {
  return {
    execution: "closed-catalog",
    arbitraryCommands: "blocked",
    secretValues: "redacted",
    environments: {
      local: "allowed",
      production: "read-only; load, stress, chaos and active DAST blocked by default"
    },
    performance: {
      maxVirtualUsers: performanceGuardrails.maxVirtualUsers,
      maxDurationSeconds: performanceGuardrails.maxDurationSeconds,
      maxRequests: performanceGuardrails.maxRequests,
      perRequestTimeoutMs: performanceGuardrails.perRequestTimeoutMs
    },
    dast: {
      mode: "passive-read-only",
      crawling: "disabled",
      destructiveChecks: "blocked"
    },
    stress: {
      status: "BLOCKED",
      reason: "Stress tests require explicit approval workflow planned for Fase 6."
    },
    killSwitch: {
      env: "HUB_TEST_KILL_SWITCH",
      active: process.env.HUB_TEST_KILL_SWITCH === "1"
    }
  };
}

async function projectTestDefinitions(project, abs, discovered, runtime, httpTargets) {
  const definitions = [];
  const latestByAction = latestTestingJobsByAction(project);
  const add = (definition) => {
    if (!definition?.id || definitions.some((item) => item.id === definition.id)) return;
    definitions.push(definition);
  };

  for (const command of discovered.approvedCommands || []) {
    if (!["lint", "tests", "coverage", "build", "sonar"].includes(command.action)) continue;
    const testType = testTypeFromCommand(command);
    const latest = latestByAction.get(command.action) || null;
    add(commandTestDefinition(project, command, testType, latest));
  }

  const smokeProfile = (runtime.profiles || []).find((profile) => profile.action === "smoke");
  const latestSmoke = latestByAction.get("smoke") || null;
  add({
    id: "runtime-smoke-local",
    name: "Smoke local",
    type: "smoke",
    action: "smoke",
    category: "functional",
    environment: "local",
    mode: "runtime-profile",
    source: smokeProfile?.source || "runtime-discovery",
    description: "Ejecuta el perfil smoke/status aprobado del runtime local.",
    status: testDefinitionStatus({ configured: Boolean(smokeProfile), verified: latestSmoke?.status === "SUCCEEDED" }),
    canRun: Boolean(smokeProfile),
    target: { kind: "runtime", label: smokeProfile?.label || "Smoke profile not detected" },
    guardrails: testGuardrail("ALLOWED", []),
    latestExecution: latestSmoke ? publicTestExecution(latestSmoke) : null,
    evidence: smokeProfile ? [`profile=${smokeProfile.label}`, `source=${smokeProfile.source}`] : []
  });

  const latestLoad = latestByAction.get("load") || null;
  add({
    id: "http-load-local-smoke",
    name: "Load HTTP local acotado",
    type: "load",
    action: "load",
    category: "performance",
    environment: "local",
    mode: "builtin-http-load",
    source: "control-api",
    description: "Genera requests GET contra una URL local detectada, con VUs/duracion/requests limitados.",
    status: testDefinitionStatus({ configured: httpTargets.length > 0, verified: latestLoad?.status === "SUCCEEDED" }),
    canRun: httpTargets.length > 0 && process.env.HUB_TEST_KILL_SWITCH !== "1",
    target: { kind: "http", urls: httpTargets },
    guardrails: testGuardrail(httpTargets.length ? "ALLOWED" : "NOT_CONFIGURED", httpTargets.length ? [] : ["No local HTTP target detected."]),
    parameters: {
      virtualUsers: 1,
      durationSeconds: 8,
      maxRequests: 40,
      thresholds: {
        p95Ms: performanceGuardrails.defaultP95Ms,
        errorRate: performanceGuardrails.defaultErrorRate
      }
    },
    latestExecution: latestLoad ? publicTestExecution(latestLoad) : null,
    evidence: httpTargets.map((target) => `${target.source}:${target.url}`)
  });

  const latestDast = latestByAction.get("dast") || null;
  add({
    id: "dast-passive-local",
    name: "DAST pasivo local",
    type: "dast",
    action: "dast",
    category: "security",
    environment: "local",
    mode: "builtin-passive-dast",
    source: "control-api",
    description: "Hace una verificacion pasiva de headers de seguridad sobre una URL local detectada.",
    status: testDefinitionStatus({ configured: httpTargets.length > 0, verified: latestDast?.status === "SUCCEEDED" }),
    canRun: httpTargets.length > 0 && process.env.HUB_TEST_KILL_SWITCH !== "1",
    target: { kind: "http", urls: httpTargets },
    guardrails: testGuardrail(httpTargets.length ? "ALLOWED" : "NOT_CONFIGURED", httpTargets.length ? [] : ["No local HTTP target detected."]),
    latestExecution: latestDast ? publicTestExecution(latestDast) : null,
    evidence: httpTargets.map((target) => `${target.source}:${target.url}`)
  });

  add({
    id: "stress-approval-required",
    name: "Stress test controlado",
    type: "stress",
    action: "stress",
    category: "performance",
    environment: "local",
    mode: "blocked-guardrail",
    source: "policy",
    description: "Stress test modelado pero bloqueado hasta tener aprobaciones y ventanas autorizadas.",
    status: "UNSUPPORTED",
    canRun: false,
    target: { kind: "http", urls: httpTargets },
    guardrails: testGuardrail("BLOCKED", ["Stress tests require explicit approval workflow in Fase 6."]),
    latestExecution: null,
    evidence: ["production/destructive/performance guardrail active"]
  });

  return definitions.sort((a, b) => testDefinitionSortRank(a) - testDefinitionSortRank(b) || a.name.localeCompare(b.name));
}

function commandTestDefinition(project, command, testType, latest) {
  const id = slugify(`command-${command.action}-${testType}-${hashText(`${command.command}:${(command.args || []).join(" ")}:${command.cwd || "."}:${command.source || ""}`).slice(0, 10)}`);
  return {
    id,
    name: command.label || commandLabel(command),
    type: testType,
    action: command.action,
    category: testType === "sonar" ? "quality" : testType === "build" ? "build" : "functional",
    environment: "local",
    mode: "approved-command",
    source: command.source || "discovery",
    description: `Comando aprobado detectado para ${command.action}.`,
    status: testDefinitionStatus({ configured: true, verified: latest?.status === "SUCCEEDED" }),
    canRun: true,
    command: publicCommandEvidence(command),
    target: { kind: "command", cwd: command.cwd || ".", project: project.slug },
    guardrails: testGuardrail("ALLOWED", []),
    latestExecution: latest ? publicTestExecution(latest) : null,
    evidence: [`source=${command.source || "discovery"}`, `cwd=${command.cwd || "."}`],
    stage: {
      name: command.label || commandLabel(command),
      action: command.action,
      internal: false,
      command: command.command,
      args: command.args || [],
      cwd: command.cwd || ".",
      source: command.source || "discovery",
      testType,
      testDefinitionId: id
    }
  };
}

function testTypeFromCommand(command) {
  const text = `${command.action} ${command.label || ""} ${(command.args || []).join(" ")} ${command.source || ""}`.toLowerCase();
  if (command.action === "coverage") return "coverage";
  if (command.action === "lint") return "lint";
  if (command.action === "build") return "build";
  if (command.action === "sonar") return "sonar";
  if (/contract/.test(text)) return "contract";
  if (/\be2e\b|end-to-end|playwright|cypress/.test(text)) return "e2e";
  if (/integration|failsafe/.test(text)) return "integration";
  return "unit";
}

function latestTestingJobsByAction(project) {
  const map = new Map();
  for (const job of state.jobs.filter((item) => item.projectId === project.id && testingJobActions.has(item.action))) {
    if (!map.has(job.action)) map.set(job.action, job);
  }
  return map;
}

function testDefinitionStatus({ configured, verified }) {
  if (!configured) return "NOT_CONFIGURED";
  if (verified) return "CONFIGURED_AND_VERIFIED";
  return "CONFIGURED_NOT_VERIFIED";
}

function testGuardrail(status, reasons) {
  return sanitizeExecutionGuardrails({
    status,
    environment: "local",
    destructive: false,
    productionBlocked: true,
    approvalRequired: status === "BLOCKED",
    limits: performanceGuardrails,
    reasons
  });
}

function testDefinitionSortRank(definition) {
  const rank = { unit: 10, integration: 20, e2e: 30, contract: 40, smoke: 50, coverage: 60, lint: 70, build: 80, sonar: 90, load: 100, dast: 110, stress: 120 };
  return rank[definition.type] || 999;
}

function publicTestExecution(job) {
  return {
    id: job.id,
    projectId: job.projectId,
    projectSlug: job.projectSlug,
    environment: job.environment,
    action: job.action,
    kind: job.kind || "execution",
    testDefinitionId: job.testDefinitionId || "",
    testDefinitionName: job.testDefinitionName || "",
    testType: job.testType || "",
    status: job.status,
    branch: job.branch || "",
    commit: job.commit || "",
    actor: job.actor || "system",
    worker: job.worker || null,
    parameters: job.parameters || {},
    guardrails: job.guardrails || {},
    stageCount: (job.stages || []).length,
    evidence: job.summary?.testEvidence || job.summary?.failure || null,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error || null
  };
}

function testingFindings(project, definitions, executions, runtime, httpTargets) {
  const findings = [];
  const hasRunnable = definitions.some((definition) => definition.canRun);
  if (!hasRunnable) {
    findings.push(testingFinding({
      severity: "warning",
      code: "NO_RUNNABLE_TEST_DEFINITION",
      title: "No hay definiciones ejecutables de pruebas",
      detail: "El catalogo existe, pero ningun test tiene target/comando aprobado ejecutable para este proyecto.",
      evidence: `definitions=${definitions.length}`,
      project
    }));
  }
  if (!definitions.some((definition) => definition.type === "smoke" && definition.canRun)) {
    findings.push(testingFinding({
      severity: "warning",
      code: "SMOKE_TEST_NOT_CONFIGURED",
      title: "Smoke test local no configurado",
      detail: "No se detecto perfil smoke/status aprobado en el runtime local.",
      evidence: `runtimeStatus=${runtime.status || "unknown"}`,
      project
    }));
  }
  if (!httpTargets.length) {
    findings.push(testingFinding({
      severity: "info",
      code: "HTTP_TEST_TARGET_NOT_DETECTED",
      title: "No hay URL HTTP local para load/DAST",
      detail: "Load y DAST pasivo requieren baseUrl/healthUrl local o contenedores corriendo con puertos HTTP publicados.",
      evidence: "targets=0",
      project
    }));
  }
  if (!definitions.some((definition) => ["integration", "e2e", "contract"].includes(definition.type))) {
    findings.push(testingFinding({
      severity: "info",
      code: "ADVANCED_TEST_TYPES_NOT_DETECTED",
      title: "No se detectaron tests integration/e2e/contract dedicados",
      detail: "La Fase 5 no inventa comandos. Solo muestra y ejecuta scripts/manifests detectados como catalogo cerrado.",
      evidence: "integration/e2e/contract definitions=0",
      project
    }));
  }
  const latestExecution = executions[0] || null;
  if (latestExecution && ["FAILED", "TIMED_OUT", "CANCELLED"].includes(latestExecution.status)) {
    findings.push(testingFinding({
      severity: latestExecution.status === "CANCELLED" ? "warning" : "critical",
      code: "LATEST_TEST_EXECUTION_FAILED",
      title: `Ultima ejecucion de pruebas ${latestExecution.status}`,
      detail: "La evidencia mas reciente del orquestador no termino correctamente.",
      evidence: `job=${latestExecution.id}, action=${latestExecution.action}`,
      project
    }));
  }
  findings.push(testingFinding({
    severity: "info",
    code: "STRESS_TEST_BLOCKED_BY_GUARDRAIL",
    title: "Stress test bloqueado por guardrail",
    detail: "Stress/chaos/destructivas quedan bloqueadas hasta tener aprobaciones y auditoria de Fase 6.",
    evidence: "stress=BLOCKED",
    project
  }));
  return findings.sort(compareQualitySecurityFindings);
}

function testingFinding(input) {
  return qualitySecurityFinding({
    ...input,
    category: input.category || "testing",
    scanner: input.scanner || "test-orchestrator",
    targetTab: input.targetTab || "executions"
  });
}

function testingCounts(definitions = [], executions = [], findings = []) {
  const byType = definitions.reduce((acc, definition) => {
    acc[definition.type] = (acc[definition.type] || 0) + 1;
    return acc;
  }, {});
  const byStatus = definitions.reduce((acc, definition) => {
    acc[definition.status] = (acc[definition.status] || 0) + 1;
    return acc;
  }, {});
  return {
    definitions: definitions.length,
    runnable: definitions.filter((definition) => definition.canRun).length,
    blocked: definitions.filter((definition) => definition.guardrails?.status === "BLOCKED").length,
    executions: executions.length,
    latestSucceeded: executions.filter((execution) => execution.status === "SUCCEEDED").length,
    latestFailed: executions.filter((execution) => ["FAILED", "TIMED_OUT", "CANCELLED"].includes(execution.status)).length,
    byType,
    byStatus,
    findings: findingCounts(findings)
  };
}

function sumTestingCounts(counts = []) {
  return counts.reduce((acc, item = {}) => {
    acc.definitions += Number(item.definitions || 0);
    acc.runnable += Number(item.runnable || 0);
    acc.blocked += Number(item.blocked || 0);
    acc.executions += Number(item.executions || 0);
    acc.latestSucceeded += Number(item.latestSucceeded || 0);
    acc.latestFailed += Number(item.latestFailed || 0);
    acc.findings = sumFindingCounts([acc.findings, item.findings || {}]);
    for (const [key, value] of Object.entries(item.byType || {})) acc.byType[key] = (acc.byType[key] || 0) + Number(value || 0);
    for (const [key, value] of Object.entries(item.byStatus || {})) acc.byStatus[key] = (acc.byStatus[key] || 0) + Number(value || 0);
    return acc;
  }, { definitions: 0, runnable: 0, blocked: 0, executions: 0, latestSucceeded: 0, latestFailed: 0, byType: {}, byStatus: {}, findings: { total: 0, critical: 0, warning: 0, info: 0 } });
}

function testingRollupStatus(statuses, findings) {
  if (findings.some((finding) => finding.severity === "critical") || statuses.includes("ERROR")) return "ERROR";
  if (statuses.some((status) => status === "CONFIGURED_AND_VERIFIED")) return "PARTIALLY_CONFIGURED";
  if (statuses.some((status) => status === "CONFIGURED_NOT_VERIFIED" || status === "PARTIALLY_CONFIGURED")) return "CONFIGURED_NOT_VERIFIED";
  if (statuses.some((status) => status === "UNSUPPORTED")) return "NOT_CONFIGURED";
  return "NOT_CONFIGURED";
}

async function createTestingExecution(project, body = {}, idempotencyKey = null) {
  const definitionId = sanitizeText(body.definitionId || body.testDefinitionId || "").slice(0, 140);
  if (!definitionId) throw problem(400, "TEST_DEFINITION_REQUIRED", "definitionId is required.");
  const abs = await canonicalProjectPath(project.repositoryPath);
  const discovered = await discoverRepository(project.repositoryPath);
  const runtime = await localRuntimeSummary(project, discovered).catch(() => ({ status: "unavailable", resources: [], profiles: [] }));
  const targets = await testingHttpTargets(project).catch(() => []);
  const definitions = await projectTestDefinitions(project, abs, discovered, runtime, targets);
  const definition = definitions.find((item) => item.id === definitionId);
  if (!definition) throw problem(404, "TEST_DEFINITION_NOT_FOUND", "Test definition was not found in the current closed catalog.");
  validateTestingDefinitionCanRun(definition);

  const parameters = normalizeTestingExecutionParameters(definition, body.parameters || {});
  const stage = testingDefinitionStage(definition, parameters);
  return createJob(project, definition.action, idempotencyKey, {
    kind: "test",
    testDefinitionId: definition.id,
    testDefinitionName: definition.name,
    testType: definition.type,
    parameters,
    guardrails: definition.guardrails,
    testPlan: [stage]
  });
}

function validateTestingDefinitionCanRun(definition) {
  if (definition.guardrails?.status === "BLOCKED" || !definition.canRun) {
    throw problem(409, "TEST_GUARDRAIL_BLOCKED", `${definition.name} is blocked by guardrails: ${(definition.guardrails?.reasons || []).join("; ") || "not runnable"}`);
  }
  if (process.env.HUB_TEST_KILL_SWITCH === "1" && ["load", "dast", "stress"].includes(definition.type)) {
    throw problem(423, "TEST_KILL_SWITCH_ACTIVE", "HUB_TEST_KILL_SWITCH=1 blocks performance/security web tests.");
  }
}

function normalizeTestingExecutionParameters(definition, input = {}) {
  if (definition.type !== "load") {
    return sanitizeExecutionParameters({
      targetUrl: input.targetUrl || definition.target?.urls?.[0]?.url || "",
      environment: "local"
    });
  }
  return sanitizeExecutionParameters({
    targetUrl: input.targetUrl || definition.target?.urls?.[0]?.url || "",
    virtualUsers: clampNumber(input.virtualUsers, 1, performanceGuardrails.maxVirtualUsers, definition.parameters?.virtualUsers || 1),
    durationSeconds: clampNumber(input.durationSeconds, 1, performanceGuardrails.maxDurationSeconds, definition.parameters?.durationSeconds || 8),
    maxRequests: clampNumber(input.maxRequests, 1, performanceGuardrails.maxRequests, definition.parameters?.maxRequests || 40),
    p95Ms: clampNumber(input.p95Ms || input.thresholdP95Ms, 1, 10000, definition.parameters?.thresholds?.p95Ms || performanceGuardrails.defaultP95Ms),
    errorRate: clampRatio(input.errorRate ?? input.thresholdErrorRate, definition.parameters?.thresholds?.errorRate ?? performanceGuardrails.defaultErrorRate),
    environment: "local"
  });
}

function testingDefinitionStage(definition, parameters) {
  if (definition.stage) return { ...definition.stage, parameters };
  return {
    name: definition.name,
    action: definition.action,
    internal: true,
    testType: definition.type,
    testDefinitionId: definition.id,
    parameters
  };
}

async function platformDeploymentsOverview() {
  const projectReports = await Promise.all(state.projects.map(async (project) => {
    try {
      const report = await deploymentsOverview(project);
      return {
        projectId: project.id,
        projectSlug: project.slug,
        projectName: project.displayName,
        status: report.status,
        counts: report.counts,
        latestPlan: report.latestPlan,
        latestRecord: report.latestRecord,
        approvals: report.approvals.slice(0, 5),
        findings: report.findings.slice(0, 20)
      };
    } catch (error) {
      const finding = deploymentFinding({
        severity: "critical",
        code: "PROJECT_DEPLOYMENT_OVERVIEW_FAILED",
        title: "No se pudo evaluar despliegues del proyecto",
        detail: error.message,
        evidence: error.code || "deployments overview failed",
        project
      });
      return {
        projectId: project.id,
        projectSlug: project.slug,
        projectName: project.displayName,
        status: "ERROR",
        counts: deploymentCounts([], [], [finding]),
        latestPlan: null,
        latestRecord: null,
        approvals: [],
        findings: [finding]
      };
    }
  }));
  const findings = projectReports.flatMap((report) => report.findings || []).sort(compareQualitySecurityFindings);
  return {
    generatedAt: nowIso(),
    environment: "local",
    status: deploymentRollupStatus(projectReports.map((report) => report.status), findings),
    counts: sumDeploymentCounts(projectReports.map((report) => report.counts)),
    guardrails: deploymentGuardrails(),
    projects: projectReports,
    findings: findings.slice(0, 250)
  };
}

async function deploymentsOverview(project) {
  const discovered = await discoverRepository(project.repositoryPath).catch(() => null);
  const runtime = await localRuntimeSummary(project, discovered).catch((error) => ({
    status: "unavailable",
    label: "No disponible",
    explanation: sanitizeText(error.message),
    profiles: [],
    resources: [],
    freshness: { status: "unknown", message: sanitizeText(error.message) }
  }));
  const plans = state.deploymentPlans.filter((plan) => plan.projectId === project.id).map(publicDeploymentPlan);
  const records = state.deploymentRecords.filter((record) => record.projectId === project.id).map(publicDeploymentRecord);
  const approvals = state.approvalRequests.filter((approval) => approval.projectId === project.id && approval.domain === "deployment").map(publicApprovalRequest);
  const environments = deploymentEnvironments(project, runtime);
  const findings = deploymentFindings(project, runtime, plans, records, approvals, environments);
  return {
    generatedAt: nowIso(),
    projectId: project.id,
    projectSlug: project.slug,
    environment: "local",
    status: deploymentRollupStatus([...environments.map((environment) => environment.status), ...plans.map((plan) => plan.status)], findings),
    counts: deploymentCounts(plans, records, findings, approvals),
    guardrails: deploymentGuardrails(),
    environments,
    latestPlan: plans[0] || null,
    latestRecord: records[0] || null,
    plans: plans.slice(0, 50),
    records: records.slice(0, 50),
    approvals: approvals.slice(0, 50),
    audit: deploymentAuditEvents(project).slice(0, 50),
    findings
  };
}

function deploymentGuardrails() {
  return {
    execution: "approved-local-runtime-profiles",
    arbitraryCommands: "blocked",
    production: {
      defaultMode: "read-only",
      apply: "blocked",
      rollback: "blocked_without_release_artifacts",
      approval: "required",
      reauthentication: "required_in_future_rbac_phase"
    },
    local: {
      plan: "allowed",
      apply: "requires_approval",
      verify: "read-only",
      rollback: "guarded_by_artifact_availability"
    },
    destructiveActions: "blocked",
    credentials: "presence only, values never returned"
  };
}

function deploymentEnvironments(project, runtime) {
  const runtimeActions = new Set((runtime.profiles || []).map((profile) => profile.action));
  const localConfigured = runtimeActions.has("start") || runtimeActions.has("restart");
  const localVerified = runtime.lastDeployment?.status === "SUCCEEDED" && runtime.freshness?.status === "matched";
  return state.environments
    .filter((environment) => environment.projectId === project.id)
    .map((environment) => {
      const name = environment.name || "local";
      const protectedEnvironment = Boolean(environment.protected || name === "production");
      const isLocal = name === "local";
      const status = isLocal
        ? localVerified
          ? "CONFIGURED_AND_VERIFIED"
          : localConfigured
            ? "CONFIGURED_NOT_VERIFIED"
            : "NOT_CONFIGURED"
        : protectedEnvironment
          ? "CONFIGURED_NOT_VERIFIED"
          : "NOT_CONFIGURED";
      return {
        name,
        provider: isLocal ? "local" : sanitizeText(environment.provider || "unknown"),
        protected: protectedEnvironment,
        status,
        canPlan: isLocal || protectedEnvironment,
        canApply: isLocal && localConfigured,
        canVerify: isLocal,
        canRollback: isLocal,
        baseUrl: sanitizeText(environment.baseUrl || ""),
        healthUrl: sanitizeText(environment.healthUrl || ""),
        evidence: isLocal
          ? `runtime=${runtime.status || "unknown"}, profiles=${[...runtimeActions].join(",") || "none"}, freshness=${runtime.freshness?.status || "unknown"}`
          : "Non-local environments are read-only until provider deployment adapters and RBAC are configured."
      };
    });
}

async function createDeploymentPlan(project, body = {}, correlation = correlationId()) {
  const environment = sanitizeText(body.environment || "local").slice(0, 40);
  const strategy = sanitizeText(body.strategy || "smart").slice(0, 40);
  if (!deploymentStrategies.has(strategy)) {
    throw problem(400, "INVALID_DEPLOYMENT_STRATEGY", "strategy must be smart, rebuild or restart.");
  }
  const discovered = await discoverRepository(project.repositoryPath);
  const abs = await canonicalProjectPath(project.repositoryPath);
  const runtime = await localRuntimeSummary(project, discovered);
  const git = await gitInfo(abs).catch(() => discovered.git || { isGit: false });
  const fingerprint = await calculateSourceFingerprint(project, await runtimeProjectPath(project, abs), git, { force: true });
  const runtimeAction = deploymentRuntimeAction(strategy);
  const runtimeActions = new Set((runtime.profiles || []).map((profile) => profile.action));
  const environmentRecord = state.environments.find((item) => item.projectId === project.id && (item.name || "local") === environment);
  const protectedEnvironment = environment !== "local" || Boolean(environmentRecord?.protected);
  const blockers = [];
  const warnings = [];
  if (!environmentRecord && environment !== "local") blockers.push(`Environment '${environment}' is not registered.`);
  if (protectedEnvironment) blockers.push("Apply is blocked for protected/non-local environments in Fase 6.");
  if (!runtimeActions.has(runtimeAction)) blockers.push(`No approved runtime profile for ${runtimeAction}.`);
  if (runtime.status === "unavailable" || runtime.status === "not_configured") blockers.push(runtime.explanation || "Runtime is not configured.");
  if (git?.dirty) warnings.push("Git working tree has local changes.");
  if (!state.jobs.some((job) => job.projectId === project.id && job.action === "smoke" && job.status === "SUCCEEDED")) {
    warnings.push("No successful smoke execution is recorded for this project.");
  }
  const status = blockers.length ? "BLOCKED" : "READY";
  const plan = {
    id: crypto.randomUUID(),
    projectId: project.id,
    projectSlug: project.slug,
    environment,
    strategy,
    runtimeAction,
    status,
    actor: currentActor(),
    correlationId: correlation,
    approvalRequestId: "",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    sourceFingerprint: publicSourceFingerprint(fingerprint),
    git: publicGitStatus(git),
    currentRuntime: {
      status: runtime.status,
      freshness: runtime.freshness,
      composeFile: runtime.composeFile || "",
      composeProject: runtime.composeProject || "",
      resources: (runtime.resources || []).length
    },
    target: {
      environment,
      provider: environment === "local" ? "local" : sanitizeText(environmentRecord?.provider || "unknown"),
      expectedFingerprint: fingerprint.value,
      expectedFingerprintShort: fingerprint.value.replace(/^sha256:/, "").slice(0, 12)
    },
    steps: deploymentPlanSteps(strategy, runtimeAction),
    guardrails: {
      approvalRequired: status === "READY",
      protectedEnvironment,
      arbitraryCommands: "blocked",
      destructiveActions: "blocked",
      runtimeProfileRequired: true
    },
    blockers,
    warnings,
    reason: sanitizeText(body.reason || "Deployment plan generated from current local state.").slice(0, 500)
  };

  if (status === "READY") {
    const approval = createApprovalRequest(project, plan, "deployment.apply", "Aplicar despliegue local aprobado");
    plan.approvalRequestId = approval.id;
    state.approvalRequests.unshift(approval);
    state.approvalRequests = state.approvalRequests.slice(0, 300);
  }
  state.deploymentPlans.unshift(plan);
  state.deploymentPlans = state.deploymentPlans.slice(0, 200);
  await appendAudit("deployment.plan", `${project.slug}:deployment:${plan.id}`, status, { planId: plan.id, correlationId: correlation, environment, strategy });
  await saveState();
  return publicDeploymentPlan(plan);
}

function createApprovalRequest(project, plan, action, reason) {
  return {
    id: crypto.randomUUID(),
    domain: "deployment",
    projectId: project.id,
    projectSlug: project.slug,
    planId: plan.id,
    action,
    status: "PENDING",
    required: true,
    requestedBy: plan.actor,
    decidedBy: "",
    requestedAt: nowIso(),
    decidedAt: null,
    reason: sanitizeText(reason).slice(0, 400),
    evidence: `environment=${plan.environment}, strategy=${plan.strategy}, fingerprint=${plan.target.expectedFingerprintShort}`
  };
}

function deploymentPlanSteps(strategy, runtimeAction) {
  return [
    { name: "Plan", status: "READY", detail: "Calcular Git, fingerprint, runtime y guardrails." },
    { name: "Approval", status: "PENDING", detail: "Requiere aprobacion local antes de apply." },
    { name: "Apply", status: "PENDING", detail: `Ejecutar perfil runtime aprobado '${runtimeAction}' con estrategia '${strategy}'.` },
    { name: "Verify", status: "PENDING", detail: "Validar runtime, freshness, recursos y smoke/evidencia disponible." },
    { name: "Audit", status: "PENDING", detail: "Persistir eventos y resultado sanitizado." }
  ];
}

function deploymentRuntimeAction(strategy) {
  if (strategy === "rebuild") return "start-fresh";
  if (strategy === "restart") return "restart";
  return "start";
}

async function decideDeploymentApproval(project, planId, decision, reason = "", correlation = correlationId()) {
  const plan = findDeploymentPlanOrThrow(project, planId);
  const approval = state.approvalRequests.find((item) => item.id === plan.approvalRequestId && item.projectId === project.id);
  if (!approval) throw problem(404, "APPROVAL_NOT_FOUND", "Approval request was not found for this plan.");
  if (approval.status !== "PENDING") throw problem(409, "APPROVAL_ALREADY_DECIDED", "Approval request is already decided.");
  approval.status = decision === "approve" ? "APPROVED" : "REJECTED";
  approval.decidedBy = currentActor();
  approval.decidedAt = nowIso();
  approval.decisionReason = sanitizeText(reason).slice(0, 400);
  plan.updatedAt = nowIso();
  await appendAudit(`deployment.approval.${decision}`, `${project.slug}:deployment:${plan.id}`, approval.status, { planId: plan.id, approvalId: approval.id, correlationId: correlation });
  await saveState();
  return { plan: publicDeploymentPlan(plan), approval: publicApprovalRequest(approval) };
}

async function applyDeploymentPlan(project, planId, correlation = correlationId()) {
  assertProjectExecutionAllowed(project, securityConfig);
  const plan = findDeploymentPlanOrThrow(project, planId);
  if (plan.status !== "READY") throw problem(409, "DEPLOYMENT_PLAN_NOT_READY", `Plan is ${plan.status}.`);
  const approval = state.approvalRequests.find((item) => item.id === plan.approvalRequestId && item.projectId === project.id);
  if (!approval || approval.status !== "APPROVED") {
    throw problem(409, "DEPLOYMENT_APPROVAL_REQUIRED", "Deployment apply requires an approved approval request.");
  }
  if (localRuntimeProcesses.has(project.id)) throw problem(409, "RUNTIME_BUSY", "A runtime action is already in progress for this project.");
  const previousRuntime = localRuntimeStore(project);
  const record = {
    id: crypto.randomUUID(),
    projectId: project.id,
    projectSlug: project.slug,
    planId: plan.id,
    approvalRequestId: approval.id,
    operation: "apply",
    environment: plan.environment,
    strategy: plan.strategy,
    runtimeAction: plan.runtimeAction,
    status: "QUEUED",
    actor: currentActor(),
    correlationId: correlation,
    previousDeployment: previousRuntime.lastDeployment ? publicDeploymentSnapshot(previousRuntime.lastDeployment) : null,
    startedAt: nowIso(),
    finishedAt: null,
    verification: null,
    error: null
  };
  state.deploymentRecords.unshift(record);
  state.deploymentRecords = state.deploymentRecords.slice(0, 200);
  await appendAudit("deployment.apply", `${project.slug}:deployment:${record.id}`, "QUEUED", { planId: plan.id, recordId: record.id, correlationId: correlation });
  await saveState();
  queueMicrotask(() => executeDeploymentApply(record.id));
  return publicDeploymentRecord(record);
}

async function executeDeploymentApply(recordId) {
  const record = state.deploymentRecords.find((item) => item.id === recordId);
  if (!record || deploymentTerminalStatuses.has(record.status)) return;
  const project = findProjectOrThrow(record.projectId);
  try {
    record.status = "APPLYING";
    record.updatedAt = nowIso();
    await saveState();
    await triggerLocalRuntimeAction(project, record.runtimeAction);
    const deadline = Date.now() + Math.max(60000, jobTimeoutSeconds * 1000);
    while (localRuntimeProcesses.has(project.id) && Date.now() < deadline) {
      await sleep(1000);
    }
    if (localRuntimeProcesses.has(project.id)) throw problem(504, "DEPLOYMENT_APPLY_TIMEOUT", "Runtime action did not finish before deployment timeout.");
    const verification = await verifyDeploymentState(project, record);
    record.verification = verification;
    record.status = ["CONFIGURED_AND_VERIFIED", "PARTIALLY_CONFIGURED"].includes(verification.status) ? "SUCCEEDED" : "FAILED";
    record.finishedAt = nowIso();
    record.updatedAt = nowIso();
    if (record.status === "FAILED") record.error = { code: "DEPLOYMENT_VERIFY_FAILED", message: verification.summary };
    await appendAudit("deployment.apply.finish", `${project.slug}:deployment:${record.id}`, record.status, { recordId: record.id, planId: record.planId });
  } catch (error) {
    record.status = "FAILED";
    record.error = { code: error.code || "DEPLOYMENT_APPLY_FAILED", message: sanitizeText(error.message) };
    record.finishedAt = nowIso();
    record.updatedAt = nowIso();
    await appendAudit("deployment.apply.finish", `${project.slug}:deployment:${record.id}`, "FAILED", { recordId: record.id, error: error.message });
  } finally {
    await saveState();
  }
}

async function verifyDeployment(project, body = {}, correlation = correlationId()) {
  const record = body.recordId
    ? findDeploymentRecordOrThrow(project, sanitizeText(body.recordId))
    : state.deploymentRecords.find((item) => item.projectId === project.id && item.operation === "apply") || null;
  const verification = await verifyDeploymentState(project, record);
  if (record) {
    record.verification = verification;
    record.updatedAt = nowIso();
  }
  await appendAudit("deployment.verify", `${project.slug}:deployment:${record?.id || "adhoc"}`, verification.status, { recordId: record?.id || "", correlationId: correlation });
  await saveState();
  return verification;
}

async function verifyDeploymentState(project, record = null) {
  const discovered = await discoverRepository(project.repositoryPath).catch(() => null);
  const runtime = await localRuntimeSummary(project, discovered).catch((error) => ({ status: "unavailable", explanation: sanitizeText(error.message), resources: [], freshness: { status: "unknown" } }));
  const latestSmoke = state.jobs.find((job) => job.projectId === project.id && job.action === "smoke") || null;
  const checks = [
    {
      name: "runtime",
      status: ["running", "stale", "degraded", "stopped"].includes(runtime.status) ? "ok" : "error",
      evidence: runtime.explanation || runtime.status
    },
    {
      name: "freshness",
      status: runtime.freshness?.status === "matched" ? "ok" : runtime.freshness?.status === "stale" ? "error" : "warn",
      evidence: runtime.freshness?.message || runtime.freshness?.status || "unknown"
    },
    {
      name: "resources",
      status: (runtime.resources || []).some((resource) => resource.state === "running") ? "ok" : "warn",
      evidence: `running=${(runtime.resources || []).filter((resource) => resource.state === "running").length}, total=${(runtime.resources || []).length}`
    },
    {
      name: "smoke",
      status: latestSmoke?.status === "SUCCEEDED" ? "ok" : latestSmoke ? "error" : "warn",
      evidence: latestSmoke ? `job=${latestSmoke.id}, status=${latestSmoke.status}` : "no smoke evidence"
    }
  ];
  const hasError = checks.some((check) => check.status === "error");
  const hasOk = checks.some((check) => check.status === "ok");
  const status = hasError ? "ERROR" : checks.every((check) => check.status === "ok") ? "CONFIGURED_AND_VERIFIED" : hasOk ? "PARTIALLY_CONFIGURED" : "CONFIGURED_NOT_VERIFIED";
  return {
    id: crypto.randomUUID(),
    projectId: project.id,
    projectSlug: project.slug,
    recordId: record?.id || "",
    generatedAt: nowIso(),
    environment: record?.environment || "local",
    status,
    summary: deploymentVerificationSummary(status, runtime, latestSmoke),
    runtime: {
      status: runtime.status,
      label: runtime.label || "",
      freshness: runtime.freshness,
      resources: (runtime.resources || []).length,
      runningResources: (runtime.resources || []).filter((resource) => resource.state === "running").length,
      lastDeployment: runtime.lastDeployment || null
    },
    smoke: latestSmoke ? publicTestExecution(latestSmoke) : null,
    checks
  };
}

function deploymentVerificationSummary(status, runtime, latestSmoke) {
  if (status === "CONFIGURED_AND_VERIFIED") return "Runtime local, fingerprint, recursos y smoke tienen evidencia OK.";
  if (status === "PARTIALLY_CONFIGURED") return "Hay evidencia parcial de despliegue local, pero faltan recursos running, freshness matched o smoke reciente.";
  if (runtime.status === "stale") return "El runtime esta obsoleto frente al fingerprint actual.";
  if (latestSmoke && latestSmoke.status !== "SUCCEEDED") return "El smoke mas reciente no termino correctamente.";
  return runtime.explanation || "No hay evidencia suficiente para verificar el despliegue local.";
}

async function rollbackDeployment(project, body = {}, correlation = correlationId()) {
  assertProjectExecutionAllowed(project, securityConfig);
  const sourceRecord = body.recordId
    ? findDeploymentRecordOrThrow(project, sanitizeText(body.recordId))
    : state.deploymentRecords.find((item) => item.projectId === project.id && item.operation === "apply" && item.status === "SUCCEEDED") || null;
  const record = {
    id: crypto.randomUUID(),
    projectId: project.id,
    projectSlug: project.slug,
    planId: sourceRecord?.planId || "",
    approvalRequestId: "",
    operation: "rollback",
    environment: sourceRecord?.environment || "local",
    strategy: "restart-previous-runtime",
    runtimeAction: "restart",
    status: "BLOCKED",
    actor: currentActor(),
    correlationId: correlation,
    previousDeployment: sourceRecord?.previousDeployment || null,
    startedAt: nowIso(),
    finishedAt: nowIso(),
    verification: null,
    error: null
  };
  const previous = sourceRecord?.previousDeployment;
  if (!sourceRecord || !previous?.expectedFingerprint) {
    record.error = { code: "ROLLBACK_NOT_AVAILABLE", message: "No hay despliegue previo con fingerprint/artifact local registrado para rollback." };
  } else {
    const abs = await canonicalProjectPath(project.repositoryPath);
    const currentGit = await gitInfo(abs).catch(() => ({ isGit: false }));
    const currentFingerprint = await calculateSourceFingerprint(project, await runtimeProjectPath(project, abs), currentGit, { force: true });
    if (currentFingerprint.value !== previous.expectedFingerprint) {
      record.error = {
        code: "ROLLBACK_ARTIFACT_NOT_AVAILABLE",
        message: "El codigo local actual no coincide con el fingerprint previo. Fase 6 no hace git checkout ni restaura imagenes sin artifact store aprobado."
      };
    } else if (localRuntimeProcesses.has(project.id)) {
      record.error = { code: "RUNTIME_BUSY", message: "Hay una accion runtime en curso." };
    } else {
      record.status = "QUEUED";
      record.finishedAt = null;
      queueMicrotask(() => executeDeploymentRollback(record.id));
    }
  }
  state.deploymentRecords.unshift(record);
  state.deploymentRecords = state.deploymentRecords.slice(0, 200);
  await appendAudit("deployment.rollback", `${project.slug}:deployment:${record.id}`, record.status, { sourceRecordId: sourceRecord?.id || "", recordId: record.id, correlationId: correlation });
  await saveState();
  return publicDeploymentRecord(record);
}

async function executeDeploymentRollback(recordId) {
  const record = state.deploymentRecords.find((item) => item.id === recordId);
  if (!record || deploymentTerminalStatuses.has(record.status)) return;
  const project = findProjectOrThrow(record.projectId);
  try {
    record.status = "APPLYING";
    record.updatedAt = nowIso();
    await saveState();
    await triggerLocalRuntimeAction(project, "restart");
    const deadline = Date.now() + Math.max(60000, jobTimeoutSeconds * 1000);
    while (localRuntimeProcesses.has(project.id) && Date.now() < deadline) await sleep(1000);
    if (localRuntimeProcesses.has(project.id)) throw problem(504, "ROLLBACK_TIMEOUT", "Runtime rollback restart did not finish before timeout.");
    record.verification = await verifyDeploymentState(project, record);
    record.status = ["CONFIGURED_AND_VERIFIED", "PARTIALLY_CONFIGURED"].includes(record.verification.status) ? "ROLLED_BACK" : "FAILED";
    record.finishedAt = nowIso();
    record.updatedAt = nowIso();
    await appendAudit("deployment.rollback.finish", `${project.slug}:deployment:${record.id}`, record.status, { recordId: record.id });
  } catch (error) {
    record.status = "FAILED";
    record.error = { code: error.code || "ROLLBACK_FAILED", message: sanitizeText(error.message) };
    record.finishedAt = nowIso();
    record.updatedAt = nowIso();
    await appendAudit("deployment.rollback.finish", `${project.slug}:deployment:${record.id}`, "FAILED", { recordId: record.id, error: error.message });
  } finally {
    await saveState();
  }
}

function deploymentFindings(project, runtime, plans, records, approvals, environments) {
  const findings = [];
  if (!environments.some((environment) => environment.name === "local" && environment.canApply)) {
    findings.push(deploymentFinding({
      severity: "warning",
      code: "LOCAL_DEPLOY_APPLY_NOT_CONFIGURED",
      title: "Apply local no esta configurado",
      detail: "No hay perfil runtime start/restart aprobado para ejecutar apply local.",
      evidence: runtime.explanation || runtime.status,
      project
    }));
  }
  if (approvals.some((approval) => approval.status === "PENDING")) {
    findings.push(deploymentFinding({
      severity: "info",
      code: "DEPLOYMENT_APPROVAL_PENDING",
      title: "Hay aprobaciones de despliegue pendientes",
      detail: "Apply queda bloqueado hasta aprobar explicitamente el plan.",
      evidence: `pending=${approvals.filter((approval) => approval.status === "PENDING").length}`,
      project
    }));
  }
  if (!records.some((record) => record.status === "SUCCEEDED")) {
    findings.push(deploymentFinding({
      severity: "info",
      code: "DEPLOYMENT_APPLY_NOT_EXECUTED",
      title: "No hay apply exitoso de Fase 6",
      detail: "Todavia no existe evidencia de apply creado desde el orquestador de despliegues.",
      evidence: `records=${records.length}`,
      project
    }));
  }
  if (!records.some((record) => record.previousDeployment?.expectedFingerprint)) {
    findings.push(deploymentFinding({
      severity: "info",
      code: "ROLLBACK_BASELINE_MISSING",
      title: "Rollback sin baseline verificable",
      detail: "Rollback real necesita un despliegue previo con fingerprint/artifact local disponible.",
      evidence: "previousDeployment=missing",
      project
    }));
  }
  const failed = records.find((record) => ["FAILED", "BLOCKED"].includes(record.status));
  if (failed?.status === "FAILED") {
    findings.push(deploymentFinding({
      severity: "critical",
      code: "LATEST_DEPLOYMENT_OPERATION_FAILED",
      title: "Operacion de despliegue fallida",
      detail: failed.error?.message || "Una operacion de despliegue termino en FAILED.",
      evidence: `record=${failed.id}, operation=${failed.operation}`,
      project
    }));
  } else if (failed?.status === "BLOCKED") {
    findings.push(deploymentFinding({
      severity: "info",
      code: "LATEST_DEPLOYMENT_OPERATION_BLOCKED",
      title: "Operacion de despliegue bloqueada por guardrail",
      detail: failed.error?.message || "Una operacion de despliegue quedo bloqueada por politica.",
      evidence: `record=${failed.id}, operation=${failed.operation}`,
      project
    }));
  }
  return findings.sort(compareQualitySecurityFindings);
}

function deploymentFinding(input) {
  return qualitySecurityFinding({
    ...input,
    category: input.category || "deployment",
    scanner: input.scanner || "deployment-orchestrator",
    targetTab: input.targetTab || "environment"
  });
}

function deploymentCounts(plans = [], records = [], findings = [], approvals = []) {
  return {
    plans: plans.length,
    readyPlans: plans.filter((plan) => plan.status === "READY").length,
    blockedPlans: plans.filter((plan) => plan.status === "BLOCKED").length,
    records: records.length,
    succeeded: records.filter((record) => record.status === "SUCCEEDED" || record.status === "ROLLED_BACK").length,
    failed: records.filter((record) => record.status === "FAILED").length,
    pendingApprovals: approvals.filter((approval) => approval.status === "PENDING").length,
    findings: findingCounts(findings)
  };
}

function sumDeploymentCounts(counts = []) {
  return counts.reduce((acc, item = {}) => {
    acc.plans += Number(item.plans || 0);
    acc.readyPlans += Number(item.readyPlans || 0);
    acc.blockedPlans += Number(item.blockedPlans || 0);
    acc.records += Number(item.records || 0);
    acc.succeeded += Number(item.succeeded || 0);
    acc.failed += Number(item.failed || 0);
    acc.pendingApprovals += Number(item.pendingApprovals || 0);
    acc.findings = sumFindingCounts([acc.findings, item.findings || {}]);
    return acc;
  }, { plans: 0, readyPlans: 0, blockedPlans: 0, records: 0, succeeded: 0, failed: 0, pendingApprovals: 0, findings: { total: 0, critical: 0, warning: 0, info: 0 } });
}

function deploymentRollupStatus(statuses, findings) {
  if (findings.some((finding) => finding.severity === "critical") || statuses.includes("ERROR")) return "ERROR";
  if (statuses.some((status) => status === "CONFIGURED_AND_VERIFIED" || status === "READY" || status === "SUCCEEDED")) return "PARTIALLY_CONFIGURED";
  if (statuses.some((status) => status === "CONFIGURED_NOT_VERIFIED" || status === "PENDING")) return "CONFIGURED_NOT_VERIFIED";
  if (statuses.some((status) => status === "BLOCKED")) return "PARTIALLY_CONFIGURED";
  return "NOT_CONFIGURED";
}

function publicDeploymentPlan(plan) {
  if (!plan) return null;
  const approval = state.approvalRequests.find((item) => item.id === plan.approvalRequestId) || null;
  return {
    id: plan.id,
    projectId: plan.projectId,
    projectSlug: plan.projectSlug,
    environment: plan.environment,
    strategy: plan.strategy,
    runtimeAction: plan.runtimeAction,
    status: plan.status,
    actor: plan.actor,
    approvalRequestId: plan.approvalRequestId || "",
    approval: approval ? publicApprovalRequest(approval) : { required: Boolean(plan.guardrails?.approvalRequired), status: plan.status === "BLOCKED" ? "BLOCKED" : "NOT_REQUIRED" },
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    sourceFingerprint: plan.sourceFingerprint,
    git: plan.git,
    currentRuntime: plan.currentRuntime,
    target: plan.target,
    steps: plan.steps || [],
    guardrails: plan.guardrails || {},
    blockers: plan.blockers || [],
    warnings: plan.warnings || [],
    reason: plan.reason || ""
  };
}

function publicDeploymentRecord(record) {
  if (!record) return null;
  return {
    id: record.id,
    projectId: record.projectId,
    projectSlug: record.projectSlug,
    planId: record.planId || "",
    approvalRequestId: record.approvalRequestId || "",
    operation: record.operation,
    environment: record.environment,
    strategy: record.strategy,
    runtimeAction: record.runtimeAction,
    status: record.status,
    actor: record.actor,
    previousDeployment: record.previousDeployment || null,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    verification: record.verification || null,
    error: record.error || null
  };
}

function publicApprovalRequest(approval) {
  if (!approval) return null;
  return {
    id: approval.id,
    domain: approval.domain,
    projectId: approval.projectId,
    projectSlug: approval.projectSlug,
    planId: approval.planId,
    action: approval.action,
    status: approval.status,
    required: Boolean(approval.required),
    requestedBy: approval.requestedBy,
    decidedBy: approval.decidedBy || "",
    requestedAt: approval.requestedAt,
    decidedAt: approval.decidedAt,
    reason: approval.reason || "",
    decisionReason: approval.decisionReason || "",
    evidence: approval.evidence || ""
  };
}

function deploymentAuditEvents(project) {
  return (state.auditEvents || [])
    .filter((event) => String(event.action || "").startsWith("deployment.") && String(event.target || "").startsWith(`${project.slug}:deployment`))
    .map((event) => ({
      id: event.id,
      action: event.action,
      target: event.target,
      result: event.result,
      timestamp: event.timestamp,
      actor: event.actor,
      correlationId: event.correlationId,
      metadata: event.metadata || {}
    }));
}

function findDeploymentPlanOrThrow(project, planId) {
  const plan = state.deploymentPlans.find((item) => item.projectId === project.id && item.id === planId);
  if (!plan) throw problem(404, "DEPLOYMENT_PLAN_NOT_FOUND", "Deployment plan was not found.");
  return plan;
}

function findDeploymentRecordOrThrow(project, recordId) {
  const record = state.deploymentRecords.find((item) => item.projectId === project.id && item.id === recordId);
  if (!record) throw problem(404, "DEPLOYMENT_RECORD_NOT_FOUND", "Deployment record was not found.");
  return record;
}

async function platformLivingDocsOverview() {
  const projectReports = await Promise.all(state.projects.map(async (project) => {
    try {
      const report = await projectLivingDocsOverview(project, { includeMarkdown: false });
      return {
        projectId: project.id,
        projectSlug: project.slug,
        projectName: project.displayName,
        status: report.status,
        phase: report.phase,
        contract: report.contract,
        confidence: report.confidence,
        counts: report.counts,
        latestSnapshot: report.latestSnapshot,
        documents: (report.documents || []).map((doc) => ({
          id: doc.id,
          title: doc.title,
          provider: doc.provider,
          environment: doc.environment,
          status: doc.status,
          confidenceScore: doc.metadata?.confidenceScore || 0,
          unverifiedSections: doc.metadata?.unverifiedSections?.length || 0
        })),
        findings: report.findings
      };
    } catch (error) {
      return {
        projectId: project.id,
        projectSlug: project.slug,
        projectName: project.displayName,
        status: "ERROR",
        phase: "Fase 12",
        contract: "living-documentation.v2",
        confidence: { score: 0, status: "ERROR", label: "Sin confianza", signals: [] },
        counts: { guides: 0, runbooks: 0, diagrams: 0, documents: 0, requiredSections: 0, unverifiedSections: 0, history: 0, findings: 1 },
        latestSnapshot: null,
        documents: [],
        findings: [livingDocsFinding(project, "critical", "LIVING_DOCS_PROJECT_FAILED", "No se pudo generar documentacion viva", error.message, error.code || "docs overview failed")]
      };
    }
  }));
  const findings = projectReports.flatMap((report) => report.findings || []).sort(compareQualitySecurityFindings);
  const score = projectReports.length
    ? Math.round(projectReports.reduce((sum, report) => sum + Number(report.confidence?.score || 0), 0) / projectReports.length)
    : 0;
  return {
    generatedAt: nowIso(),
    environment: "local",
    phase: "Fase 12",
    contract: "living-documentation.v2",
    status: livingDocsStatusFromScore(score, findings),
    confidence: {
      score,
      status: livingDocsStatusFromScore(score, findings),
      label: livingDocsConfidenceLabel(score)
    },
    counts: {
      projects: projectReports.length,
      guides: projectReports.reduce((sum, report) => sum + Number(report.counts?.guides || 0), 0),
      runbooks: projectReports.reduce((sum, report) => sum + Number(report.counts?.runbooks || 0), 0),
      diagrams: projectReports.reduce((sum, report) => sum + Number(report.counts?.diagrams || 0), 0),
      documents: projectReports.reduce((sum, report) => sum + Number(report.counts?.documents || 0), 0),
      requiredSections: projectReports.reduce((sum, report) => sum + Number(report.counts?.requiredSections || 0), 0),
      unverifiedSections: projectReports.reduce((sum, report) => sum + Number(report.counts?.unverifiedSections || 0), 0),
      snapshots: state.livingDocsSnapshots.length,
      findings: findings.length
    },
    guardrails: livingDocsGuardrails(),
    inventory: livingDocsInventory(),
    projects: projectReports,
    findings: findings.slice(0, 200)
  };
}

async function projectLivingDocsOverview(project, options = {}) {
  const catalog = await loadCatalogDescriptor();
  const details = await projectDetails(project, catalog);
  const [observability, qualitySecurity, infrastructure, deployments, testing, versions] = await Promise.all([
    safeLivingDocsReport("observability", () => observabilityOverview(project)),
    safeLivingDocsReport("quality-security", () => qualitySecurityOverview(project)),
    safeLivingDocsReport("infrastructure", () => infrastructureOverview(project)),
    safeLivingDocsReport("deployments", () => deploymentsOverview(project)),
    safeLivingDocsReport("testing", () => testingOverview(project)),
    safeLivingDocsReport("versions", () => projectVersionOverview(project))
  ]);
  const context = {
    project: details,
    observability,
    qualitySecurity,
    infrastructure,
    deployments,
    testing,
    versions,
    catalog
  };
  const signals = livingDocsConfidenceSignals(context);
  const confidence = livingDocsConfidence(signals);
  const guides = livingDocsGuides(context);
  const runbooks = livingDocsRunbooks(context);
  const diagrams = livingDocsDiagrams(context);
  const requiredSections = livingDocsRequiredSections(context);
  const officialDocs = livingDocsOfficialDocsRecord(context);
  const documents = livingDocsGeneratedDocuments(context, requiredSections, confidence, officialDocs);
  const unverifiedSections = requiredSections.filter((section) => section.required && section.status !== "CONFIGURED_AND_VERIFIED");
  const history = livingDocsHistory(project);
  const inventory = livingDocsInventory(project);
  const latestSnapshot = history.snapshots[0] || null;
  const baseFindings = livingDocsFindings(project, confidence, signals, history, inventory, requiredSections, documents, officialDocs);
  const sourceHash = livingDocsSourceHash({
    projectId: project.id,
    projectSlug: project.slug,
    environment: "local",
    guardrails: livingDocsGuardrails(),
    confidence,
    guides,
    runbooks,
    diagrams,
    requiredSections: stableLivingDocsSections(requiredSections),
    documents: stableLivingDocsDocuments(documents),
    officialDocs,
    inventory: stableLivingDocsInventory(inventory),
    findings: stableLivingDocsFindings(baseFindings)
  });
  const baseReport = {
    generatedAt: nowIso(),
    projectId: project.id,
    projectSlug: project.slug,
    projectName: project.displayName,
    environment: "local",
    phase: "Fase 12",
    contract: "living-documentation.v2",
    status: livingDocsStatusFromScore(confidence.score, baseFindings),
    guardrails: livingDocsGuardrails(),
    confidence,
    requiredSections,
    unverifiedSections,
    documents,
    officialDocs,
    guides,
    runbooks,
    diagrams,
    history,
    inventory,
    latestSnapshot,
    findings: baseFindings,
    sourceHash,
    sourceHashShort: shortDocHash(sourceHash),
    counts: {
      guides: guides.length,
      runbooks: runbooks.length,
      diagrams: diagrams.length,
      documents: documents.length,
      requiredSections: requiredSections.length,
      verifiedSections: requiredSections.filter((section) => section.status === "CONFIGURED_AND_VERIFIED").length,
      unverifiedSections: unverifiedSections.length,
      history: history.entries.length,
      findings: baseFindings.length
    }
  };
  const markdown = buildProjectLivingDocsMarkdown(baseReport, context);
  const markdownHash = hashString(markdown);
  const findings = [...baseFindings];
  if (!options.suppressSnapshotStaleness && latestSnapshot?.sourceHash && latestSnapshot.sourceHash !== sourceHash) {
    findings.push(livingDocsFinding(project, "info", "LIVING_DOCS_SNAPSHOT_STALE", "Snapshot de documentacion desactualizado", "La evidencia verificada actual no coincide con el ultimo snapshot exportado.", `latest=${latestSnapshot.sourceHashShort || shortDocHash(latestSnapshot.sourceHash)}, current=${shortDocHash(sourceHash)}`));
  } else if (!options.suppressSnapshotStaleness && latestSnapshot && !latestSnapshot.sourceHash) {
    findings.push(livingDocsFinding(project, "info", "LIVING_DOCS_SNAPSHOT_LEGACY_HASH", "Snapshot sin hash estable de evidencia", "El snapshot existe, pero fue creado antes del hash estable de Fase 7. Crear un nuevo snapshot para cerrar la comparacion.", `snapshot=${latestSnapshot.id}`));
  }
  const report = {
    ...baseReport,
    status: livingDocsStatusFromScore(confidence.score, findings),
    findings,
    counts: { ...baseReport.counts, findings: findings.length },
    markdownHash,
    markdownHashShort: shortDocHash(markdownHash)
  };
  const finalMarkdown = buildProjectLivingDocsMarkdown(report, context);
  return {
    ...report,
    markdownHash: hashString(finalMarkdown),
    markdownHashShort: shortDocHash(hashString(finalMarkdown)),
    markdown: options.includeMarkdown === false ? "" : finalMarkdown
  };
}

async function safeLivingDocsReport(name, builder) {
  try {
    return await builder();
  } catch (error) {
    return {
      generatedAt: nowIso(),
      status: "ERROR",
      source: name,
      error: sanitizeText(error.message)
    };
  }
}

function livingDocsGuardrails() {
  return {
    phase: "Fase 12",
    contract: "living-documentation.v2",
    source: "verified-local-state",
    arbitraryContent: "blocked",
    secretValues: "redacted",
    exportPath: "docs/live",
    writes: "snapshot_only",
    audit: "docs.snapshot",
    cloudMutation: "blocked",
    officialDocs: "recorded_only_when_verified",
    genericInstructions: "blocked"
  };
}

function livingDocsConfidenceSignals(context) {
  const project = context.project;
  const runtime = project.localRuntime || {};
  const localState = project.localState || {};
  const deployments = context.deployments || {};
  const testing = context.testing || {};
  const qualitySecurity = context.qualitySecurity || {};
  const observability = context.observability || {};
  const infrastructure = context.infrastructure || {};
  return [
    livingDocsSignal("Estado declarado", localState.declared?.status, "Descriptor YAML, componentes y ambientes declarados."),
    livingDocsSignal("Discovery local", localState.detected?.status, `${(project.manifests || []).length} manifests, stack=${(project.detectedStack || []).join(",") || "sin stack"}.`),
    livingDocsSignal("Runtime verificado", runtime.freshness?.status === "matched" ? "CONFIGURED_AND_VERIFIED" : runtime.status === "running" ? "PARTIALLY_CONFIGURED" : runtime.status === "error" ? "ERROR" : "CONFIGURED_NOT_VERIFIED", runtime.freshness?.message || runtime.explanation || "Sin evidencia de runtime."),
    livingDocsSignal("Calidad y seguridad", qualitySecurity.status, `${qualitySecurity.counts?.critical || 0} criticos, ${qualitySecurity.counts?.warning || 0} warnings.`),
    livingDocsSignal("Observabilidad", observability.status, `metrics=${observability.metrics?.status || "UNKNOWN"}, logs=${observability.logs?.status || "UNKNOWN"}, traces=${observability.traces?.status || "UNKNOWN"}.`),
    livingDocsSignal("Infraestructura", infrastructure.status, `${infrastructure.counts?.resources || 0} recursos detectados, drift=${infrastructure.drift?.status || "UNKNOWN"}.`),
    livingDocsSignal("Pruebas", testing.status, `${testing.counts?.runnable || 0} ejecutables, ${testing.counts?.blocked || 0} bloqueadas.`),
    livingDocsSignal("Despliegues", deployments.status, `${deployments.counts?.succeeded || 0} exitosos, ${deployments.counts?.pendingApprovals || 0} aprobaciones pendientes.`)
  ];
}

function livingDocsSignal(name, status, evidence) {
  const normalized = String(status || "NOT_CONFIGURED");
  return {
    name,
    status: normalized,
    score: livingDocsStatusScore(normalized),
    evidence: sanitizeText(evidence || "")
  };
}

function livingDocsConfidence(signals) {
  const score = signals.length
    ? Math.round(signals.reduce((sum, signal) => sum + Number(signal.score || 0), 0) / signals.length)
    : 0;
  return {
    score,
    status: livingDocsStatusFromScore(score, []),
    label: livingDocsConfidenceLabel(score),
    signals
  };
}

function livingDocsStatusScore(status) {
  const normalized = String(status || "").toUpperCase();
  if (["CONFIGURED_AND_VERIFIED", "OK", "UP", "SUCCEEDED", "READY", "MATCHED", "RUNNING", "NO_DRIFT_DETECTED"].includes(normalized)) return 100;
  if (["PARTIALLY_CONFIGURED", "CONFIGURED_NOT_VERIFIED", "DRIFT_DETECTED", "STALE"].includes(normalized)) return 65;
  if (["NOT_CONFIGURED", "UNKNOWN", "BLOCKED", "UNSUPPORTED"].includes(normalized)) return 35;
  if (["ERROR", "FAILED", "MISCONFIGURED"].includes(normalized)) return 0;
  return 50;
}

function livingDocsStatusFromScore(score, findings = []) {
  if (findings.some((finding) => finding.severity === "critical")) return "ERROR";
  if (score >= 85) return "CONFIGURED_AND_VERIFIED";
  if (score >= 60) return "PARTIALLY_CONFIGURED";
  if (score >= 35) return "CONFIGURED_NOT_VERIFIED";
  return "NOT_CONFIGURED";
}

function livingDocsConfidenceLabel(score) {
  if (score >= 85) return "Alta";
  if (score >= 60) return "Media";
  if (score >= 35) return "Baja";
  return "Sin confianza";
}

function livingDocsRequiredSections(context) {
  const project = context.project;
  const runtime = project.localRuntime || {};
  const qualitySecurity = context.qualitySecurity || {};
  const observability = context.observability || {};
  const infrastructure = context.infrastructure || {};
  const deployments = context.deployments || {};
  const testing = context.testing || {};
  const versions = context.versions || {};
  const localState = project.localState || {};
  const declaredComponents = project.components?.declared || [];
  const detectedComponents = project.components?.detected || [];
  const verifiedComponents = project.components?.verified || [];
  const requiredVariables = localAgentRequiredVariables(project, { detectedStack: project.detectedStack || [] });
  const requiredSecrets = requiredVariables.filter((item) => /(TOKEN|PASSWORD|SECRET|KEY)$/i.test(item.name || ""));
  const buildCommands = (project.approvedCommands || []).filter((command) => command.action === "build");
  const testDefinitions = testing.definitions || [];
  const migrationManifests = (project.manifests || []).filter((item) => /migrations?|flyway|liquibase|prisma|typeorm/i.test(item));
  const externalLinks = (project.toolLinks || []).filter((link) => link.provider && link.url);
  const failedJobs = state.jobs.filter((job) => job.projectId === project.id && job.status === "FAILED").length;
  const failedDeployments = state.deploymentRecords.filter((record) => record.projectId === project.id && record.status === "FAILED").length;
  const adapters = infrastructure.adapters || {};
  const configuredAdapters = Object.values(adapters).filter((adapter) => !["NOT_CONFIGURED", "UNSUPPORTED"].includes(String(adapter.status || "").toUpperCase()));
  const infraResources = infrastructure.resources || [];
  const findings = [
    ...(qualitySecurity.findings || []),
    ...(infrastructure.findings || []),
    ...(deployments.findings || []),
    ...(testing.findings || [])
  ];

  return [
    livingDocsSection("architecture", "Arquitectura", declaredComponents.length || detectedComponents.length || infraResources.length ? "CONFIGURED_AND_VERIFIED" : "CONFIGURED_NOT_VERIFIED", `${project.displayName} usa stack ${(project.detectedStack || []).join(", ") || "sin stack detectado"}.`, `components=${declaredComponents.length + detectedComponents.length}, resources=${infraResources.length}`),
    livingDocsSection("components", "Componentes", declaredComponents.length || detectedComponents.length || verifiedComponents.length ? "CONFIGURED_AND_VERIFIED" : "NOT_CONFIGURED", `${declaredComponents.length} declarados, ${detectedComponents.length} detectados, ${verifiedComponents.length} verificados.`, `declared=${declaredComponents.length}, detected=${detectedComponents.length}, verified=${verifiedComponents.length}`),
    livingDocsSection("diagram", "Diagrama", "CONFIGURED_AND_VERIFIED", "Se genera diagrama Mermaid desde runtime, deploys y evidencia viva.", "diagrams=runtime-topology,deployment-flow,evidence-flow"),
    livingDocsSection("dependencies", "Dependencias", qualitySecurity.dependencies?.status || "CONFIGURED_NOT_VERIFIED", qualitySecurity.dependencies?.summary || "Dependencias derivadas de manifests soportados.", qualitySecurity.dependencies?.evidence || `manifests=${(qualitySecurity.dependencies?.manifests || []).length}`),
    livingDocsSection("ports", "Puertos", (runtime.ports || []).length ? "CONFIGURED_AND_VERIFIED" : "CONFIGURED_NOT_VERIFIED", `${(runtime.ports || []).length} puerto(s) publicados/asignados por runtime local.`, (runtime.ports || []).slice(0, 8).map((port) => `${port.host}->${port.target}/${port.protocol}`).join(", ") || "ports=0"),
    livingDocsSection("required-variables", "Variables requeridas", requiredVariables.length ? "CONFIGURED_AND_VERIFIED" : "CONFIGURED_NOT_VERIFIED", requiredVariables.length ? `${requiredVariables.length} variable(s) requeridas detectadas sin valores.` : "No hay variables requeridas detectadas por el agente local.", requiredVariables.map((item) => `${item.name}:${item.configured ? "configured" : "missing"}`).join(", ") || "requiredVariables=0"),
    livingDocsSection("required-secrets", "Secretos requeridos", requiredSecrets.length ? "CONFIGURED_AND_VERIFIED" : "CONFIGURED_NOT_VERIFIED", requiredSecrets.length ? `${requiredSecrets.length} secreto(s) requeridos referenciados sin valores.` : "No hay secretos requeridos detectados; no se muestran valores.", requiredSecrets.map((item) => item.name).join(", ") || "requiredSecrets=0"),
    livingDocsSection("run-commands", "Comandos de ejecucion", (runtime.profiles || []).length ? "CONFIGURED_AND_VERIFIED" : "CONFIGURED_NOT_VERIFIED", `${(runtime.profiles || []).length} perfil(es) aprobados para runtime local.`, (runtime.profiles || []).map((profile) => profile.action).join(", ") || "profiles=0"),
    livingDocsSection("build", "Build", buildCommands.length || runtime.lastDeployment ? "CONFIGURED_AND_VERIFIED" : "CONFIGURED_NOT_VERIFIED", buildCommands.length ? `${buildCommands.length} comando(s) build detectados.` : "Build inferido por Local Run Engine o pendiente de declarar.", buildCommands.map((command) => command.label || command.source || command.action).slice(0, 8).join(", ") || `lastBuildAt=${runtime.lastBuildAt || versions.deployed?.lastBuildAt || ""}`),
    livingDocsSection("tests", "Tests", testDefinitions.length ? "CONFIGURED_AND_VERIFIED" : "CONFIGURED_NOT_VERIFIED", `${testDefinitions.length} definicion(es) de prueba en catalogo cerrado.`, `runnable=${testing.counts?.runnable || 0}, blocked=${testing.counts?.blocked || 0}`),
    livingDocsSection("deployment", "Despliegue", deployments.status || "CONFIGURED_NOT_VERIFIED", "Plan, aprobacion, apply y verify se documentan desde Fase 6.", `plans=${deployments.counts?.plans || 0}, records=${deployments.counts?.records || 0}`),
    livingDocsSection("rollback", "Rollback", deployments.records?.some((record) => record.previousDeployment?.expectedFingerprint) ? "CONFIGURED_AND_VERIFIED" : "CONFIGURED_NOT_VERIFIED", "Rollback requiere baseline/fingerprint o artifact store verificable.", `records=${deployments.counts?.records || 0}, succeeded=${deployments.counts?.succeeded || 0}`),
    livingDocsSection("migrations", "Migraciones", migrationManifests.length ? "CONFIGURED_NOT_VERIFIED" : "NOT_CONFIGURED", migrationManifests.length ? `${migrationManifests.length} manifest(s) de migracion detectados.` : "No se detectaron migrations/Flyway/Liquibase/Prisma/TypeORM.", migrationManifests.slice(0, 8).join(", ") || "migrations=0"),
    livingDocsSection("backups", "Backups", fsSync.existsSync(path.join(repoRoot, "docs/operations/backups.md")) ? "CONFIGURED_NOT_VERIFIED" : "NOT_CONFIGURED", "Runbook de backups existe a nivel plataforma; restore real por proyecto debe verificarse aparte.", "docs/operations/backups.md"),
    livingDocsSection("restore", "Restauracion", fsSync.existsSync(path.join(repoRoot, "docs/operations/disaster-recovery.md")) ? "CONFIGURED_NOT_VERIFIED" : "NOT_CONFIGURED", "Disaster recovery esta documentado a nivel plataforma; pruebas de restore por proyecto no se marcan como verificadas sin evidencia.", "docs/operations/disaster-recovery.md"),
    livingDocsSection("observability", "Observabilidad", observability.status || "CONFIGURED_NOT_VERIFIED", `metrics=${observability.metrics?.status || "UNKNOWN"}, logs=${observability.logs?.status || "UNKNOWN"}, traces=${observability.traces?.status || "UNKNOWN"}, alerts=${observability.alerts?.status || "UNKNOWN"}.`, `generatedAt=${observability.generatedAt || ""}`),
    livingDocsSection("security", "Seguridad", qualitySecurity.status || "CONFIGURED_NOT_VERIFIED", `${qualitySecurity.counts?.critical || 0} criticos, ${qualitySecurity.counts?.warning || 0} warnings desde seguridad/calidad.`, `secretScanning=${qualitySecurity.secretScanning?.status || "UNKNOWN"}, containerScanning=${qualitySecurity.containerScanning?.status || "UNKNOWN"}`),
    livingDocsSection("incidents", "Incidentes", failedJobs || failedDeployments ? "PARTIALLY_CONFIGURED" : "CONFIGURED_NOT_VERIFIED", failedJobs || failedDeployments ? `${failedJobs} job(s) fallidos y ${failedDeployments} despliegue(s) fallidos registrados.` : "No hay registro formal de incidentes; se usa historial de jobs/deployments/auditoria como evidencia operativa.", `failedJobs=${failedJobs}, failedDeployments=${failedDeployments}`),
    livingDocsSection("troubleshooting", "Troubleshooting", fsSync.existsSync(path.join(repoRoot, "docs/operations/runbooks.md")) ? "CONFIGURED_AND_VERIFIED" : "CONFIGURED_NOT_VERIFIED", "Runbooks operativos generados desde estados verificados y findings actuales.", "docs/operations/runbooks.md"),
    livingDocsSection("external-integrations", "Integraciones externas", externalLinks.length || configuredAdapters.length ? "CONFIGURED_AND_VERIFIED" : "CONFIGURED_NOT_VERIFIED", `${externalLinks.length} link(s) de herramientas y ${configuredAdapters.length} adaptador(es) con evidencia.`, [...externalLinks.map((link) => link.provider), ...configuredAdapters.map((adapter) => adapter.name)].slice(0, 12).join(", ") || "integrations=0"),
    livingDocsSection("approximate-costs", "Costos aproximados", infraResources.length ? "CONFIGURED_NOT_VERIFIED" : "NOT_CONFIGURED", "La plataforma lista recursos detectados, pero no calcula costos cloud live sin adaptadores/credenciales temporales verificados.", `resources=${infraResources.length}, liveCloudCalls=${infrastructure.adapterPolicy?.liveCloudCalls || "disabled"}`),
    livingDocsSection("limitations", "Limitaciones", "CONFIGURED_AND_VERIFIED", `${findings.length} finding(s) y ${configuredAdapters.length} adaptador(es) documentan limites reales sin ocultarlos.`, `findings=${findings.length}`)
  ];
}

function livingDocsSection(id, title, status, summary, evidence, extra = {}) {
  const normalized = String(status || "CONFIGURED_NOT_VERIFIED").toUpperCase();
  return {
    id,
    title,
    required: true,
    status: normalized,
    verified: normalized === "CONFIGURED_AND_VERIFIED",
    summary: sanitizeText(summary || "").slice(0, 420),
    evidence: sanitizeText(evidence || "").slice(0, 420),
    ...extra
  };
}

function livingDocsOfficialDocsRecord() {
  return {
    status: "NOT_CONSULTED",
    policy: "La generacion automatica usa estado local verificado. Solo se registran docs oficiales cuando fueron consultadas explicitamente y se puede citar fecha/fuente.",
    consulted: [],
    consultedAt: "",
    requiredBeforeVerifiedCloudDocs: true
  };
}

function livingDocsGeneratedDocuments(context, requiredSections, confidence, officialDocs) {
  const project = context.project;
  const runtime = project.localRuntime || {};
  const infrastructure = context.infrastructure || {};
  const adapters = infrastructure.adapters || {};
  const baseSections = requiredSections.map((section) => section.id);
  const providerSpecs = [
    {
      id: "local-runtime",
      title: "Ejecucion local",
      environment: "local",
      provider: "local",
      status: runtime.status === "running" && runtime.freshness?.status === "matched" ? "CONFIGURED_AND_VERIFIED" : runtime.status === "error" ? "ERROR" : "CONFIGURED_NOT_VERIFIED",
      summary: runtime.explanation || "Runtime local gestionado por perfiles aprobados.",
      evidence: `branch=${context.versions?.current?.branch || project.git?.branch || ""}, commit=${context.versions?.current?.shortCommit || shortHash(project.git?.commit)}`
    },
    {
      id: "docker-compose",
      title: "Docker Compose",
      environment: "local",
      provider: "docker-compose",
      status: adapters["docker-compose"]?.status || (runtime.composeFile ? "CONFIGURED_NOT_VERIFIED" : "NOT_CONFIGURED"),
      summary: runtime.composeFile ? `Compose activo ${runtime.composeFile}.` : "No se detecto compose activo.",
      evidence: `composeFile=${runtime.composeFile || ""}, resources=${(runtime.resources || []).length}`
    },
    livingDocsProviderDocumentSpec("vps", "VPS", adapters.vps),
    livingDocsProviderDocumentSpec("aws", "AWS", adapters.aws),
    livingDocsProviderDocumentSpec("gcp", "Google Cloud", adapters.gcp),
    livingDocsProviderDocumentSpec("kubernetes", "Kubernetes", adapters.kubernetes)
  ];

  return providerSpecs.map((spec) => ({
    id: spec.id,
    title: spec.title,
    environment: spec.environment || spec.id,
    provider: spec.provider || spec.id,
    status: spec.status || "NOT_CONFIGURED",
    summary: sanitizeText(spec.summary || "").slice(0, 420),
    evidence: sanitizeText(spec.evidence || "").slice(0, 420),
    coveredSections: baseSections,
    metadata: livingDocsDocumentMetadata(context, confidence, requiredSections, officialDocs, spec),
    sections: requiredSections.map((section) => ({
      id: section.id,
      title: section.title,
      status: section.status,
      summary: section.summary,
      evidence: section.evidence
    }))
  }));
}

function livingDocsProviderDocumentSpec(id, title, adapter = null) {
  return {
    id,
    title,
    environment: id,
    provider: id,
    status: adapter?.status || "NOT_CONFIGURED",
    summary: adapter?.summary || `${title} no tiene evidencia verificada en los manifests actuales.`,
    evidence: adapter?.evidence?.[0]?.detail || adapter?.evidence || `adapter=${id}`
  };
}

function livingDocsDocumentMetadata(context, confidence, requiredSections, officialDocs, spec) {
  const project = context.project;
  const versions = context.versions || {};
  const current = versions.current || {};
  const repository = versions.repository || {};
  const unverifiedSections = requiredSections
    .filter((section) => section.status !== "CONFIGURED_AND_VERIFIED")
    .map((section) => ({
      id: section.id,
      title: section.title,
      status: section.status,
      evidence: section.evidence
    }));
  return {
    generatedFromCommit: current.commit || repository.commit || project.git?.commit || "",
    generatedFromShortCommit: current.shortCommit || repository.shortCommit || shortHash(project.git?.commit),
    generatedFromBranch: current.branch || repository.branch || project.git?.branch || project.defaultBranch || "",
    generatedFromTag: current.tag || repository.tag || project.git?.currentTag || "",
    generatedAt: nowIso(),
    infrastructureVerifiedAt: context.infrastructure?.generatedAt || "",
    infrastructureStatus: context.infrastructure?.status || "UNKNOWN",
    integrationsVerifiedAt: latestIso([
      context.observability?.generatedAt,
      context.qualitySecurity?.generatedAt,
      context.deployments?.generatedAt,
      context.testing?.generatedAt,
      context.versions?.generatedAt
    ]),
    integrationsStatus: {
      observability: context.observability?.status || "UNKNOWN",
      qualitySecurity: context.qualitySecurity?.status || "UNKNOWN",
      deployments: context.deployments?.status || "UNKNOWN",
      testing: context.testing?.status || "UNKNOWN",
      versions: context.versions?.status || "UNKNOWN"
    },
    confidenceScore: confidence.score,
    confidenceLabel: confidence.label,
    unverifiedSections,
    officialDocsConsulted: officialDocs.consulted || [],
    officialDocsConsultedAt: officialDocs.consultedAt || "",
    targetProvider: spec.provider || spec.id,
    targetEnvironment: spec.environment || spec.id
  };
}

function latestIso(values = []) {
  return values
    .filter(Boolean)
    .sort((a, b) => String(b).localeCompare(String(a)))[0] || "";
}

function livingDocsGuides(context) {
  const project = context.project;
  const runtime = project.localRuntime || {};
  const deployments = context.deployments || {};
  const testing = context.testing || {};
  const observability = context.observability || {};
  return [
    {
      id: "local-onboarding",
      title: "Guia de onboarding local",
      status: project.localState?.descriptor?.projectDeclared ? "CONFIGURED_AND_VERIFIED" : "CONFIGURED_NOT_VERIFIED",
      summary: `${project.displayName} vive en ${runtimePublicPath(project)} y se registra como ${project.slug}.`,
      steps: [
        `Abrir el proyecto ${project.slug} en el panel.`,
        `Revisar descriptor y componentes declarados para ${project.repositoryPath}.`,
        `Validar links del proyecto antes de ejecutar acciones.`,
        `Usar Configuration Doctor si cambia SONAR_HOST_URL, Jenkins o runtime.`
      ],
      evidence: `stack=${(project.detectedStack || []).join(",") || "sin stack"}`
    },
    {
      id: "runtime-operations",
      title: "Guia de runtime local",
      status: runtime.freshness?.status === "matched" ? "CONFIGURED_AND_VERIFIED" : "PARTIALLY_CONFIGURED",
      summary: runtime.explanation || "El Local Run Engine usa perfiles aprobados.",
      steps: [
        "Usar Start para recalcular Git y fingerprint.",
        "Usar Rebuild changed components o Clean rebuild para diagnosticar caches o imagenes dudosas.",
        "Consultar Terminal / logs si el runtime queda degraded o error.",
        "No ejecutar comandos fuera de perfiles aprobados desde el navegador."
      ],
      evidence: `freshness=${runtime.freshness?.status || "unknown"}, services=${(runtime.resources || []).length}`
    },
    {
      id: "deployment-cycle",
      title: "Guia Plan / Apply / Verify / Rollback",
      status: deployments.status || "CONFIGURED_NOT_VERIFIED",
      summary: "Fase 6 separa plan, aprobacion, apply, verify y rollback guardado.",
      steps: [
        "Generar plan local y revisar blockers/warnings.",
        "Aprobar apply solo si el plan queda READY.",
        "Ejecutar apply y esperar registro terminal.",
        "Ejecutar verify read-only.",
        "Usar rollback solo si existe baseline/artifact verificable."
      ],
      evidence: `records=${deployments.counts?.records || 0}, succeeded=${deployments.counts?.succeeded || 0}`
    },
    {
      id: "testing-observability",
      title: "Guia de pruebas y observabilidad",
      status: livingDocsStatusFromScore(Math.round((livingDocsStatusScore(testing.status) + livingDocsStatusScore(observability.status)) / 2), []),
      summary: "La evidencia operativa cruza catalogo de pruebas, jobs, metrics, logs, traces y alertas.",
      steps: [
        "Ejecutar smoke desde el catalogo cerrado.",
        "Usar load solo con targets HTTP locales detectados.",
        "Revisar dashboard Project Observability por project label.",
        "No tratar ausencia de datos como exito."
      ],
      evidence: `tests=${testing.counts?.definitions || 0}, metrics=${observability.metrics?.status || "UNKNOWN"}`
    }
  ];
}

function livingDocsRunbooks(context) {
  const project = context.project;
  const runtime = project.localRuntime || {};
  const deployments = context.deployments || {};
  const qualitySecurity = context.qualitySecurity || {};
  const observability = context.observability || {};
  return [
    {
      id: "runtime-stale-or-failed",
      title: "Runtime obsoleto o fallido",
      trigger: "freshness stale, failed, unverified o runtime error/degraded",
      status: ["matched", "not_applicable"].includes(runtime.freshness?.status) ? "CONFIGURED_AND_VERIFIED" : "PARTIALLY_CONFIGURED",
      steps: [
        "Abrir Gestion de entorno.",
        "Revisar fingerprint actual y ultimo deploy.",
        "Ejecutar Start.",
        "Si falla, abrir Terminal / logs y revisar primer error sanitizado.",
        "Repetir verify despues del runtime."
      ],
      evidence: runtime.freshness?.message || runtime.explanation || "Sin evidencia de runtime."
    },
    {
      id: "sonarqube-auth",
      title: "SonarQube no autorizado o sin snapshot",
      trigger: "Quality Gate sin datos, token invalido, 401, 403 o SonarQube apagado",
      status: qualitySecurity.sonarqube?.status || "CONFIGURED_NOT_VERIFIED",
      steps: [
        "Confirmar SONAR_HOST_URL del proyecto.",
        "Cargar SONAR_TOKEN desde Configuracion; el API no lo devuelve al navegador.",
        "Ejecutar tests/coverage antes de Sonar si falta coverage.",
        "Ejecutar Sonar y revisar Compute Engine/Quality Gate."
      ],
      evidence: qualitySecurity.sonarqube?.summary || "SonarQube sin evidencia completa."
    },
    {
      id: "deployment-rollback-blocked",
      title: "Rollback bloqueado",
      trigger: "ROLLBACK_NOT_AVAILABLE o ROLLBACK_ARTIFACT_NOT_AVAILABLE",
      status: deployments.records?.some((record) => record.operation === "rollback" && record.status === "BLOCKED") ? "PARTIALLY_CONFIGURED" : "CONFIGURED_AND_VERIFIED",
      steps: [
        "Leer el error del registro rollback.",
        "Confirmar que existe apply exitoso previo.",
        "No hacer git checkout manual desde Fase 7.",
        "Crear artifact store/versionado antes de afirmar rollback real entre revisiones."
      ],
      evidence: deployments.latestRecord?.error?.code || "Rollback sin bloqueo reciente."
    },
    {
      id: "observability-gap",
      title: "Sin senales de observabilidad",
      trigger: "metrics, logs o traces NOT_CONFIGURED/ERROR",
      status: observability.status || "CONFIGURED_NOT_VERIFIED",
      steps: [
        "Abrir Grafana Project Observability.",
        "Validar que Prometheus/Loki/Tempo esten UP.",
        "Revisar labels project/environment.",
        "Agregar instrumentacion real en el repo externo antes de marcar verificado."
      ],
      evidence: `metrics=${observability.metrics?.status || "UNKNOWN"}, logs=${observability.logs?.status || "UNKNOWN"}, traces=${observability.traces?.status || "UNKNOWN"}`
    }
  ];
}

function livingDocsDiagrams(context) {
  const project = context.project;
  const runtime = project.localRuntime || {};
  const serviceNames = (runtime.resources || []).slice(0, 6).map((resource) => resource.service || resource.name).filter(Boolean);
  const services = serviceNames.length ? serviceNames : ["runtime local"];
  const serviceNodes = services.map((service, index) => `  Compose --> S${index}["${mermaidLabel(service)}"]`).join("\n");
  return [
    {
      id: "runtime-topology",
      title: "Topologia local verificada",
      type: "mermaid",
      status: runtime.resources?.length ? "CONFIGURED_AND_VERIFIED" : "CONFIGURED_NOT_VERIFIED",
      code: [
        "flowchart LR",
        '  UI["Web UI"] --> API["Control API"]',
        '  API --> LRE["Local Run Engine"]',
        `  LRE --> Repo["${mermaidLabel(project.repositoryPath)}"]`,
        `  LRE --> Compose["${mermaidLabel(runtime.composeFile || "compose no detectado")}"]`,
        serviceNodes
      ].filter(Boolean).join("\n")
    },
    {
      id: "deployment-flow",
      title: "Plan Apply Verify Rollback",
      type: "mermaid",
      status: context.deployments?.status || "CONFIGURED_NOT_VERIFIED",
      code: [
        "flowchart TD",
        '  Plan["Plan"] --> Approval["Aprobacion"]',
        '  Approval --> Apply["Apply local aprobado"]',
        '  Apply --> Verify["Verify read-only"]',
        '  Verify --> Audit["Auditoria deployment.*"]',
        '  Verify --> Rollback["Rollback guardado"]',
        '  Rollback --> Guardrail["Artifact/fingerprint guardrail"]'
      ].join("\n")
    },
    {
      id: "evidence-flow",
      title: "Flujo de evidencia viva",
      type: "mermaid",
      status: context.observability?.status || "CONFIGURED_NOT_VERIFIED",
      code: [
        "flowchart LR",
        `  Repo["${mermaidLabel(project.slug)}"] --> Discovery["Discovery"]`,
        '  Discovery --> Docs["Documentacion viva"]',
        '  Jobs["Jobs y pruebas"] --> Docs',
        '  Deploy["Despliegues"] --> Docs',
        '  Obs["Metrics Logs Traces Alerts"] --> Docs',
        '  Docs --> Snapshot["Snapshot docs/live"]'
      ].join("\n")
    }
  ];
}

function livingDocsHistory(project) {
  const snapshots = (state.livingDocsSnapshots || [])
    .filter((snapshot) => snapshot.projectId === project.id)
    .map(publicLivingDocsSnapshot)
    .slice(0, 20);
  const jobs = state.jobs
    .filter((job) => job.projectId === project.id)
    .slice(0, 20)
    .map((job) => ({
      id: job.id,
      type: "job",
      action: job.action,
      status: job.status,
      timestamp: job.finishedAt || job.updatedAt || job.createdAt,
      evidence: `${job.action} ${job.status}`
    }));
  const deployments = state.deploymentRecords
    .filter((record) => record.projectId === project.id)
    .slice(0, 20)
    .map((record) => ({
      id: record.id,
      type: "deployment",
      action: record.operation,
      status: record.status,
      timestamp: record.finishedAt || record.startedAt,
      evidence: `${record.operation} ${record.status}`
    }));
  const audit = (state.auditEvents || [])
    .filter((event) => String(event.target || "").includes(project.slug) || event.metadata?.projectId === project.id)
    .slice(0, 20)
    .map((event) => ({
      id: event.id,
      type: "audit",
      action: event.action,
      status: event.result,
      timestamp: event.timestamp,
      evidence: event.target
    }));
  const entries = [...snapshots.map((snapshot) => ({
    id: snapshot.id,
    type: "docs-snapshot",
    action: "docs.snapshot",
    status: snapshot.status,
    timestamp: snapshot.generatedAt,
    evidence: snapshot.exportPath || snapshot.markdownHashShort
  })), ...jobs, ...deployments, ...audit]
    .filter((entry) => entry.timestamp)
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
    .slice(0, 60);
  return { snapshots, entries };
}

function livingDocsInventory(project = null) {
  const paths = [
    "README.md",
    "AGENTS.md",
    "PROMPT_MASTER_PLATFORM.md",
    "docs/architecture/overview.md",
    "docs/architecture/components.md",
    "docs/architecture/security.md",
    "docs/architecture/local-agent.md",
    "docs/architecture/job-orchestrator.md",
    "docs/architecture.md",
    "docs/environments/local.md",
    "docs/environments/development.md",
    "docs/environments/staging.md",
    "docs/environments/production.md",
    "docs/phase-0-audit.md",
    "docs/phase-1-catalog-local-state.md",
    "docs/phase-2-observability.md",
    "docs/phase-3-quality-security.md",
    "docs/phase-4-cloud-infrastructure.md",
    "docs/phase-5-jobs-testing.md",
    "docs/phase-6-deployments.md",
    "docs/phase-7-living-documentation.md",
    "docs/phase-8-discovery-cache.md",
    "docs/phase-9-local-agent.md",
    "docs/phase-10-infrastructure-discovery.md",
    "docs/phase-11-git-versions.md",
    "docs/phase-12-living-docs-v2.md",
    "docs/security/access-control.md",
    "docs/operations/backups.md",
    "docs/operations/disaster-recovery.md",
    "docs/operations/runbooks.md",
    "docs/observability/overview.md",
    "docs/testing/performance.md",
    "docs/adr/README.md",
    "docs/live/README.md"
  ];
  if (project) paths.push(`docs/live/${project.slug}.md`);
  const items = paths.map((relativePath) => {
    const abs = path.join(repoRoot, relativePath);
    const exists = fsSync.existsSync(abs);
    return {
      path: relativePath,
      status: exists ? "CONFIGURED_AND_VERIFIED" : "NOT_CONFIGURED",
      required: !relativePath.startsWith("docs/live/") || relativePath === "docs/live/README.md",
      evidence: exists ? "file exists in workspace" : "file missing"
    };
  });
  return {
    generatedAt: nowIso(),
    items,
    counts: {
      total: items.length,
      present: items.filter((item) => item.status === "CONFIGURED_AND_VERIFIED").length,
      missing: items.filter((item) => item.status !== "CONFIGURED_AND_VERIFIED").length
    }
  };
}

function livingDocsFindings(project, confidence, signals, history, inventory, requiredSections = [], documents = [], officialDocs = null) {
  const findings = [];
  if (confidence.score < 60) {
    findings.push(livingDocsFinding(project, "warning", "LIVING_DOCS_CONFIDENCE_LOW", "Confianza baja en documentacion viva", "Varias fuentes verificadas estan incompletas o no configuradas.", `score=${confidence.score}`));
  }
  for (const signal of signals.filter((item) => ["ERROR", "NOT_CONFIGURED"].includes(String(item.status).toUpperCase())).slice(0, 5)) {
    findings.push(livingDocsFinding(project, signal.status === "ERROR" ? "warning" : "info", "LIVING_DOCS_SOURCE_NOT_VERIFIED", `Fuente no verificada: ${signal.name}`, signal.evidence || "Sin evidencia.", `status=${signal.status}`));
  }
  if (!history.snapshots.length) {
    findings.push(livingDocsFinding(project, "info", "LIVING_DOCS_SNAPSHOT_MISSING", "Sin snapshot exportado de documentacion viva", "La documentacion se genera por API, pero aun no hay snapshot historico para este proyecto.", "snapshots=0"));
  }
  const missingRequired = inventory.items.filter((item) => item.required && item.status !== "CONFIGURED_AND_VERIFIED");
  if (missingRequired.length) {
    findings.push(livingDocsFinding(project, "info", "LIVING_DOCS_REQUIRED_FILE_MISSING", "Faltan documentos vivos requeridos", missingRequired.slice(0, 4).map((item) => item.path).join(", "), `missing=${missingRequired.length}`));
  }
  const unverifiedSections = requiredSections.filter((section) => section.required && section.status !== "CONFIGURED_AND_VERIFIED");
  if (unverifiedSections.length) {
    findings.push(livingDocsFinding(project, "info", "LIVING_DOCS_PHASE12_SECTIONS_UNVERIFIED", "Secciones obligatorias sin verificacion completa", unverifiedSections.slice(0, 6).map((section) => `${section.title}:${section.status}`).join(", "), `unverifiedSections=${unverifiedSections.length}`));
  }
  const unverifiedDocuments = documents.filter((document) => document.status !== "CONFIGURED_AND_VERIFIED");
  if (unverifiedDocuments.length) {
    findings.push(livingDocsFinding(project, "info", "LIVING_DOCS_PHASE12_DOCUMENTS_UNVERIFIED", "Documentos por ambiente/proveedor sin verificacion completa", unverifiedDocuments.slice(0, 6).map((document) => `${document.title}:${document.status}`).join(", "), `documents=${unverifiedDocuments.length}`));
  }
  if (officialDocs?.status === "NOT_CONSULTED") {
    findings.push(livingDocsFinding(project, "info", "LIVING_DOCS_OFFICIAL_DOCS_NOT_CONSULTED", "Documentacion oficial no consultada por la generacion automatica", "El snapshot registra esta ausencia explicitamente; no se inventan fuentes externas.", "officialDocs=0"));
  }
  return findings.sort(compareQualitySecurityFindings);
}

function livingDocsFinding(project, severity, code, title, detail, evidence) {
  return qualitySecurityFinding({
    severity,
    category: "documentation",
    scanner: "living-docs",
    code,
    title,
    detail: sanitizeText(detail),
    evidence: sanitizeText(evidence),
    suggestedAction: "Regenerar documentacion viva y corregir la fuente verificada incompleta.",
    targetTab: "docs",
    project
  });
}

function buildProjectLivingDocsMarkdown(report, context) {
  const project = context.project;
  const primaryDocument = (report.documents || [])[0] || {};
  const primaryMetadata = primaryDocument.metadata || {};
  const lines = [
    `# Documentacion viva - ${project.displayName}`,
    "",
    `Generado: ${report.generatedAt}`,
    `Proyecto: ${project.slug}`,
    `Repositorio: ${runtimePublicPath(project)}`,
    `Contrato: ${report.contract || "living-documentation.v2"}`,
    `Fase: ${report.phase || "Fase 12"}`,
    `Commit de origen: ${primaryMetadata.generatedFromShortCommit || "sin commit"} (${primaryMetadata.generatedFromBranch || "sin rama"})`,
    `Infraestructura verificada: ${primaryMetadata.infrastructureVerifiedAt || "sin verificacion"} (${primaryMetadata.infrastructureStatus || "UNKNOWN"})`,
    `Integraciones verificadas: ${primaryMetadata.integrationsVerifiedAt || "sin verificacion"}`,
    `Documentacion oficial consultada: ${(report.officialDocs?.consulted || []).length ? (report.officialDocs.consulted || []).map((doc) => doc.title || doc.url).join(", ") : "no consultada por generacion automatica"}`,
    `Fecha consulta docs oficiales: ${report.officialDocs?.consultedAt || "sin consulta"}`,
    `Estado: ${report.status}`,
    `Confianza: ${report.confidence.label} (${report.confidence.score}/100)`,
    `Hash evidencia: ${report.sourceHashShort || "pendiente"}`,
    "",
    "## Cobertura obligatoria Fase 12",
    "",
    "| Seccion | Estado | Evidencia |",
    "| --- | --- | --- |",
    ...(report.requiredSections || []).map((section) => `| ${markdownCell(section.title)} | ${markdownCell(section.status)} | ${markdownCell(section.evidence || section.summary)} |`),
    "",
    "## Documentos por ambiente y proveedor",
    "",
    "| Documento | Ambiente | Proveedor | Estado | Commit | No verificadas |",
    "| --- | --- | --- | --- | --- | ---: |",
    ...(report.documents || []).map((doc) => `| ${markdownCell(doc.title)} | ${markdownCell(doc.environment)} | ${markdownCell(doc.provider)} | ${markdownCell(doc.status)} | ${markdownCell(doc.metadata?.generatedFromShortCommit || "sin commit")} | ${(doc.metadata?.unverifiedSections || []).length} |`),
    "",
    "## Secciones no verificadas",
    "",
    ...((report.unverifiedSections || []).length ? report.unverifiedSections.map((section) => `- ${section.title}: ${section.status} - ${section.evidence || section.summary}`) : ["- Sin secciones obligatorias pendientes de verificacion."]),
    "",
    "## Confianza",
    "",
    "| Fuente | Estado | Score | Evidencia |",
    "| --- | --- | ---: | --- |",
    ...report.confidence.signals.map((signal) => `| ${markdownCell(signal.name)} | ${markdownCell(signal.status)} | ${signal.score} | ${markdownCell(signal.evidence)} |`),
    "",
    "## Guias",
    "",
    ...report.guides.flatMap((guide) => [
      `### ${guide.title}`,
      "",
      `Estado: ${guide.status}`,
      "",
      guide.summary,
      "",
      ...guide.steps.map((step) => `- ${step}`),
      "",
      `Evidencia: ${guide.evidence}`,
      ""
    ]),
    "## Runbooks",
    "",
    ...report.runbooks.flatMap((runbook) => [
      `### ${runbook.title}`,
      "",
      `Trigger: ${runbook.trigger}`,
      "",
      `Estado: ${runbook.status}`,
      "",
      ...runbook.steps.map((step) => `- ${step}`),
      "",
      `Evidencia: ${runbook.evidence}`,
      ""
    ]),
    "## Diagramas",
    "",
    ...report.diagrams.flatMap((diagram) => [
      `### ${diagram.title}`,
      "",
      `Estado: ${diagram.status}`,
      "",
      "```mermaid",
      diagram.code,
      "```",
      ""
    ]),
    "## Historial reciente",
    "",
    "| Tipo | Accion | Estado | Fecha | Evidencia |",
    "| --- | --- | --- | --- | --- |",
    ...(report.history.entries.length ? report.history.entries.slice(0, 20).map((entry) => `| ${markdownCell(entry.type)} | ${markdownCell(entry.action)} | ${markdownCell(entry.status)} | ${markdownCell(entry.timestamp)} | ${markdownCell(entry.evidence)} |`) : ["| sin historial | - | - | - | - |"]),
    "",
    "## Findings",
    "",
    ...(report.findings.length ? report.findings.map((finding) => `- ${finding.severity}: ${finding.code} - ${finding.detail}`) : ["- Sin findings de documentacion viva abiertos."]),
    ""
  ];
  return `${lines.join("\n")}\n`;
}

async function createLivingDocsSnapshot(project, body = {}, correlation = correlationId()) {
  const report = await projectLivingDocsOverview(project, { suppressSnapshotStaleness: true });
  const exportRequested = body.export !== false;
  let exportPath = "";
  if (exportRequested) {
    await fs.mkdir(livingDocsExportDir, { recursive: true });
    const target = path.join(livingDocsExportDir, `${project.slug}.md`);
    if (!target.startsWith(`${livingDocsExportDir}${path.sep}`)) throw problem(403, "DOCS_EXPORT_PATH_ESCAPE", "Invalid living docs export path.");
    await fs.writeFile(target, report.markdown, "utf8");
    exportPath = path.relative(repoRoot, target);
  }
  const snapshot = {
    id: crypto.randomUUID(),
    projectId: project.id,
    projectSlug: project.slug,
    phase: report.phase,
    contract: report.contract,
    status: report.status,
    confidenceScore: report.confidence.score,
    confidenceLabel: report.confidence.label,
    sourceHash: report.sourceHash,
    sourceHashShort: report.sourceHashShort,
    markdownHash: report.markdownHash,
    markdownHashShort: report.markdownHashShort,
    exportPath,
    generatedAt: nowIso(),
    counts: report.counts,
    documents: (report.documents || []).map((doc) => ({
      id: doc.id,
      title: doc.title,
      provider: doc.provider,
      environment: doc.environment,
      status: doc.status,
      generatedFromShortCommit: doc.metadata?.generatedFromShortCommit || "",
      unverifiedSections: doc.metadata?.unverifiedSections?.length || 0
    })).slice(0, 20),
    requiredSections: (report.requiredSections || []).map((section) => ({
      id: section.id,
      title: section.title,
      status: section.status
    })).slice(0, 40),
    findings: report.findings.map((finding) => ({ severity: finding.severity, code: finding.code, title: finding.title })).slice(0, 20)
  };
  state.livingDocsSnapshots.unshift(snapshot);
  state.livingDocsSnapshots = state.livingDocsSnapshots.slice(0, 250);
  await appendAudit("docs.snapshot", `${project.slug}:docs:${snapshot.id}`, snapshot.status, { snapshotId: snapshot.id, projectId: project.id, exportPath, markdownHash: report.markdownHash, sourceHash: report.sourceHash, correlationId: correlation });
  await saveState();
  return {
    snapshot: publicLivingDocsSnapshot(snapshot),
    exportPath,
    report: {
      projectSlug: report.projectSlug,
      phase: report.phase,
      contract: report.contract,
      status: report.status,
      confidence: report.confidence,
      sourceHash: report.sourceHash,
      sourceHashShort: report.sourceHashShort,
      markdownHash: report.markdownHash,
      markdownHashShort: report.markdownHashShort,
      counts: report.counts,
      requiredSections: report.requiredSections,
      documents: report.documents,
      officialDocs: report.officialDocs,
      findings: report.findings
    }
  };
}

function publicLivingDocsSnapshot(snapshot) {
  if (!snapshot) return null;
  return {
    id: snapshot.id,
    projectId: snapshot.projectId,
    projectSlug: snapshot.projectSlug,
    phase: snapshot.phase || "Fase 12",
    contract: snapshot.contract || "living-documentation.v2",
    status: snapshot.status,
    confidenceScore: snapshot.confidenceScore,
    confidenceLabel: snapshot.confidenceLabel,
    sourceHash: snapshot.sourceHash || "",
    sourceHashShort: snapshot.sourceHashShort || shortDocHash(snapshot.sourceHash),
    markdownHash: snapshot.markdownHash,
    markdownHashShort: snapshot.markdownHashShort || shortDocHash(snapshot.markdownHash),
    exportPath: snapshot.exportPath || "",
    generatedAt: snapshot.generatedAt,
    counts: snapshot.counts || {},
    documents: snapshot.documents || [],
    requiredSections: snapshot.requiredSections || [],
    findings: snapshot.findings || []
  };
}

function hashString(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value || "")).digest("hex")}`;
}

function livingDocsSourceHash(source) {
  return hashString(JSON.stringify(source));
}

function stableLivingDocsFindings(findings) {
  return (findings || [])
    .filter((finding) => !String(finding.code || "").startsWith("LIVING_DOCS_SNAPSHOT_"))
    .map((finding) => ({
      severity: finding.severity,
      code: finding.code,
      title: finding.title,
      detail: finding.detail,
      evidence: finding.evidence
    }));
}

function stableLivingDocsInventory(inventory) {
  return {
    items: (inventory?.items || []).map((item) => ({
      path: item.path,
      status: item.status,
      required: Boolean(item.required),
      evidence: item.evidence
    }))
  };
}

function stableLivingDocsSections(sections = []) {
  return sections.map((section) => ({
    id: section.id,
    status: section.status,
    summary: section.summary,
    evidence: section.evidence
  }));
}

function stableLivingDocsDocuments(documents = []) {
  return documents.map((document) => ({
    id: document.id,
    provider: document.provider,
    environment: document.environment,
    status: document.status,
    coveredSections: document.coveredSections,
    metadata: {
      generatedFromCommit: document.metadata?.generatedFromCommit || "",
      generatedFromBranch: document.metadata?.generatedFromBranch || "",
      infrastructureStatus: document.metadata?.infrastructureStatus || "",
      integrationsStatus: document.metadata?.integrationsStatus || {},
      unverifiedSections: (document.metadata?.unverifiedSections || []).map((section) => ({ id: section.id, status: section.status })),
      officialDocsConsulted: document.metadata?.officialDocsConsulted || []
    }
  }));
}

function shortDocHash(value) {
  return String(value || "").replace(/^sha256:/, "").slice(0, 12);
}

function markdownCell(value) {
  return sanitizeText(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function mermaidLabel(value) {
  return sanitizeText(value).replace(/["\\]/g, " ").slice(0, 80);
}

function localAgentCapabilities() {
  return [
    "project_registration",
    "filesystem_discovery",
    "git_status",
    "remote_diff_metadata",
    "language_detection",
    "framework_detection",
    "dependency_manager_detection",
    "docker_manifest_detection",
    "docker_runtime_inventory",
    "process_port_inventory",
    "healthcheck_detection",
    "observability_tool_detection",
    "coverage_artifact_detection",
    "test_script_detection",
    "approved_command_catalog",
    "secret_value_redaction",
    "auditable_heartbeat"
  ];
}

function localAgentSecurityPolicy() {
  return {
    phase: "Fase 9",
    type: "embedded-local-agent",
    permissions: "minimum-local-workspace-read plus approved runtime actions",
    workspaceRoot: "/workspace/projects",
    secretValues: "resolved_only_at_execution_boundary_never_returned",
    arbitraryCommands: "blocked",
    credentialLifetime: "short-lived-required-for-future-remote-agent",
    transport: "loopback-or-docker-network-local",
    heartbeatTtlSeconds: Math.round(localAgentHeartbeatTtlMs / 1000),
    revocation: "supported-by-status",
    signedUpdates: "required-for-external-agent-future"
  };
}

function ensureLocalAgentRecord() {
  if (!state) return false;
  state.agents ||= [];
  const identity = localAgentIdentity();
  let agent = state.agents.find((item) => item.id === identity.id);
  let changed = false;
  if (!agent) {
    agent = {
      ...identity,
      status: "CONNECTED",
      registeredAt: nowIso(),
      lastHeartbeatAt: localAgentStartedAt,
      revokedAt: "",
      revocationReason: "",
      projectsDetected: 0,
      discoveryErrors: 0
    };
    state.agents.unshift(agent);
    changed = true;
  }
  for (const [key, value] of Object.entries(identity)) {
    if (JSON.stringify(agent[key]) !== JSON.stringify(value)) {
      agent[key] = value;
      changed = true;
    }
  }
  if (agent.status !== "REVOKED" && agent.status !== "CONNECTED") {
    agent.status = "CONNECTED";
    changed = true;
  }
  const heartbeatAt = Date.parse(agent.lastHeartbeatAt || "");
  const processStartedAt = Date.parse(localAgentStartedAt);
  if (agent.status !== "REVOKED" && Number.isFinite(processStartedAt) && (!Number.isFinite(heartbeatAt) || heartbeatAt < processStartedAt)) {
    agent.lastHeartbeatAt = localAgentStartedAt;
    changed = true;
  }
  return changed;
}

function localAgentIdentity() {
  return {
    id: localAgentId,
    name: "Control API Local Agent",
    type: "embedded",
    version: localAgentVersion,
    deviceId: hashString(`${hostProjectsRoot}:${repoRoot}`).replace(/^sha256:/, "").slice(0, 16),
    hostRoot: hostProjectsRoot,
    projectsRoot,
    capabilities: localAgentCapabilities(),
    security: localAgentSecurityPolicy()
  };
}

function localAgentRecord() {
  ensureLocalAgentRecord();
  return state.agents.find((item) => item.id === localAgentId);
}

function latestAgentHeartbeat(agentId = localAgentId) {
  return (state.agentHeartbeats || []).find((item) => item.agentId === agentId) || null;
}

function latestAgentDiscoverySnapshot(agentId = localAgentId) {
  return (state.agentDiscoverySnapshots || []).find((item) => item.agentId === agentId) || null;
}

function localAgentStatus(agent) {
  if (!agent || agent.status === "REVOKED") return "DISCONNECTED";
  const heartbeatAt = Date.parse(agent.lastHeartbeatAt || localAgentStartedAt);
  if (!Number.isFinite(heartbeatAt)) return "DISCONNECTED";
  return Date.now() - heartbeatAt <= localAgentHeartbeatTtlMs ? "CONNECTED" : "DISCONNECTED";
}

async function agentsOverview() {
  const agent = localAgentRecord();
  const heartbeat = latestAgentHeartbeat(agent.id);
  const discovery = latestAgentDiscoverySnapshot(agent.id);
  const publicAgent = publicLocalAgent(agent, heartbeat, discovery);
  return {
    generatedAt: nowIso(),
    environment: "local",
    policy: localAgentSecurityPolicy(),
    counts: {
      agents: 1,
      connected: publicAgent.status === "CONNECTED" ? 1 : 0,
      disconnected: publicAgent.status === "CONNECTED" ? 0 : 1,
      projectsDetected: discovery?.projectCount || publicAgent.projectsDetected || 0,
      discoveryErrors: discovery?.errorCount || publicAgent.discoveryErrors || 0
    },
    agents: [publicAgent],
    latestDiscovery: publicAgent.latestDiscovery
  };
}

function publicLocalAgent(agent, heartbeat = null, discovery = null) {
  const status = localAgentStatus(agent);
  return {
    id: agent.id,
    name: agent.name,
    type: agent.type,
    version: agent.version,
    status,
    connected: status === "CONNECTED",
    deviceId: agent.deviceId,
    hostRoot: "/workspace/projects",
    projectsRoot: "/workspace/projects",
    registeredAt: agent.registeredAt,
    lastHeartbeatAt: heartbeat?.timestamp || agent.lastHeartbeatAt || localAgentStartedAt,
    heartbeatAgeSeconds: Math.max(0, Math.round((Date.now() - Date.parse(heartbeat?.timestamp || agent.lastHeartbeatAt || localAgentStartedAt)) / 1000)),
    capabilities: agent.capabilities || [],
    security: agent.security || localAgentSecurityPolicy(),
    projectsDetected: discovery?.projectCount || agent.projectsDetected || 0,
    discoveryErrors: discovery?.errorCount || agent.discoveryErrors || 0,
    revokedAt: agent.revokedAt || "",
    latestHeartbeat: heartbeat ? publicAgentHeartbeat(heartbeat) : null,
    latestDiscovery: discovery ? publicAgentDiscoverySnapshot(discovery) : null
  };
}

function publicAgentHeartbeat(heartbeat) {
  return {
    id: heartbeat.id,
    agentId: heartbeat.agentId,
    status: heartbeat.status,
    timestamp: heartbeat.timestamp,
    version: heartbeat.version,
    projectCount: heartbeat.projectCount || 0,
    errorCount: heartbeat.errorCount || 0,
    evidence: heartbeat.evidence || ""
  };
}

function publicAgentDiscoverySnapshot(snapshot) {
  return {
    id: snapshot.id,
    agentId: snapshot.agentId,
    status: snapshot.status,
    sourceHash: snapshot.sourceHash,
    sourceHashShort: snapshot.sourceHashShort || shortDocHash(snapshot.sourceHash),
    generatedAt: snapshot.generatedAt,
    durationMs: snapshot.durationMs || 0,
    projectCount: snapshot.projectCount || 0,
    errorCount: snapshot.errorCount || 0,
    projects: snapshot.projects || [],
    errors: snapshot.errors || []
  };
}

async function recordLocalAgentHeartbeat(body = {}, correlation = correlationId()) {
  const agent = localAgentRecord();
  if (agent.status === "REVOKED") throw problem(423, "LOCAL_AGENT_REVOKED", "Local agent is revoked.");
  const discovery = latestAgentDiscoverySnapshot(agent.id);
  const heartbeat = {
    id: crypto.randomUUID(),
    agentId: agent.id,
    status: "CONNECTED",
    timestamp: nowIso(),
    version: localAgentVersion,
    projectCount: discovery?.projectCount || state.projects.length,
    errorCount: discovery?.errorCount || 0,
    evidence: sanitizeText(body.evidence || "control-api embedded heartbeat").slice(0, 240)
  };
  state.agentHeartbeats.unshift(heartbeat);
  state.agentHeartbeats = state.agentHeartbeats.slice(0, 250);
  agent.lastHeartbeatAt = heartbeat.timestamp;
  agent.status = "CONNECTED";
  agent.projectsDetected = heartbeat.projectCount;
  agent.discoveryErrors = heartbeat.errorCount;
  await appendAudit("agent.heartbeat", agent.id, heartbeat.status, {
    agentId: agent.id,
    projectCount: heartbeat.projectCount,
    errorCount: heartbeat.errorCount,
    correlationId: correlation
  });
  return {
    agent: publicLocalAgent(agent, heartbeat, discovery),
    heartbeat: publicAgentHeartbeat(heartbeat)
  };
}

async function refreshLocalAgentDiscovery(body = {}, correlation = correlationId()) {
  const agent = localAgentRecord();
  if (agent.status === "REVOKED") throw problem(423, "LOCAL_AGENT_REVOKED", "Local agent is revoked.");
  const started = Date.now();
  const scopeProjectId = sanitizeText(body.projectId || "");
  const projects = scopeProjectId
    ? state.projects.filter((project) => project.id === scopeProjectId || project.slug === scopeProjectId)
    : state.projects;
  if (scopeProjectId && !projects.length) throw problem(404, "AGENT_PROJECT_NOT_FOUND", "Project not found for local agent discovery.");
  const results = await Promise.all(projects.map((project) => localAgentProjectDiscovery(project)));
  const errors = results.filter((item) => item.status === "ERROR").map((item) => ({
    projectId: item.projectId,
    projectSlug: item.projectSlug,
    code: item.errorCode || "DISCOVERY_ERROR",
    message: item.error || "Discovery failed"
  }));
  const sourceHash = hashString(JSON.stringify(results.map(stableAgentProjectDiscovery)));
  const snapshot = {
    id: crypto.randomUUID(),
    agentId: agent.id,
    status: errors.length ? "PARTIALLY_CONFIGURED" : "CONFIGURED_AND_VERIFIED",
    sourceHash,
    sourceHashShort: shortDocHash(sourceHash),
    generatedAt: nowIso(),
    durationMs: Date.now() - started,
    projectCount: results.length,
    errorCount: errors.length,
    projects: results,
    errors
  };
  state.agentDiscoverySnapshots.unshift(snapshot);
  state.agentDiscoverySnapshots = state.agentDiscoverySnapshots.slice(0, 100);
  agent.projectsDetected = snapshot.projectCount;
  agent.discoveryErrors = snapshot.errorCount;
  agent.lastDiscoveryAt = snapshot.generatedAt;
  await appendAudit("agent.discovery.refresh", `${agent.id}:projects:${snapshot.projectCount}`, snapshot.status, {
    agentId: agent.id,
    snapshotId: snapshot.id,
    sourceHash: snapshot.sourceHash,
    projectCount: snapshot.projectCount,
    errorCount: snapshot.errorCount,
    correlationId: correlation
  });
  return {
    agent: publicLocalAgent(agent, latestAgentHeartbeat(agent.id), snapshot),
    snapshot: publicAgentDiscoverySnapshot(snapshot)
  };
}

async function localAgentProjectDiscovery(project) {
  try {
    const abs = await canonicalProjectPath(project.repositoryPath);
    const [discovered, runtime] = await Promise.all([
      discoverRepository(project.repositoryPath),
      localRuntimeSummary(project).catch((error) => ({ status: "error", resources: [], ports: [], profiles: [], error: sanitizeText(error.message) }))
    ]);
    const requiredVariables = localAgentRequiredVariables(project, discovered);
    const manifestPaths = (discovered.manifests || []).map(localAgentManifestPath).filter(Boolean);
    return {
      projectId: project.id,
      projectSlug: project.slug,
      name: project.displayName,
      status: "CONFIGURED_AND_VERIFIED",
      path: runtimePublicPath(project),
      repositoryPath: project.repositoryPath,
      git: publicGitStatus(discovered.git),
      stack: discovered.detectedStack || [],
      languages: localAgentLanguages(discovered.detectedStack || []),
      frameworks: localAgentFrameworks(discovered.detectedStack || []),
      dependencyManagers: localAgentDependencyManagers(discovered.detectedStack || [], manifestPaths),
      dockerfiles: manifestPaths.filter((item) => path.basename(item).includes("Dockerfile") || path.basename(item) === "Dockerfile").slice(0, 20),
      composeFiles: manifestPaths.filter((item) => /compose|docker-compose/i.test(path.basename(item))).slice(0, 20),
      containers: (runtime.resources || []).length,
      ports: (runtime.ports || []).length,
      processes: localAgentProcesses(runtime),
      publishedPorts: localAgentPublishedPorts(runtime),
      localServices: localAgentLocalServices(runtime),
      healthChecks: (discovered.instrumentation?.health || []).length,
      observability: {
        metrics: (discovered.instrumentation?.metrics || []).length,
        logs: (discovered.instrumentation?.logs || []).length,
        traces: (discovered.instrumentation?.traces || []).length
      },
      coverageArtifacts: (discovered.coverageArtifacts || []).length,
      testCommands: (discovered.approvedCommands || []).filter((command) => command.action === "tests").length,
      buildCommands: (discovered.approvedCommands || []).filter((command) => command.action === "build").length,
      requiredVariables,
      errors: (discovered.doctor || []).filter((item) => item.level === "error").map((item) => ({ code: item.code, message: sanitizeText(item.message) })).slice(0, 10),
      evidence: `${manifestPaths.length} manifests, ${(runtime.resources || []).length} containers, ${(runtime.ports || []).length} ports`
    };
  } catch (error) {
    return {
      projectId: project.id,
      projectSlug: project.slug,
      name: project.displayName,
      status: "ERROR",
      errorCode: error.code || "LOCAL_AGENT_DISCOVERY_FAILED",
      error: sanitizeText(error.message),
      path: runtimePublicPath(project),
      repositoryPath: project.repositoryPath,
      git: null,
      stack: [],
      languages: [],
      frameworks: [],
      dependencyManagers: [],
      dockerfiles: [],
      composeFiles: [],
      containers: 0,
      ports: 0,
      processes: [],
      publishedPorts: [],
      localServices: [],
      healthChecks: 0,
      observability: { metrics: 0, logs: 0, traces: 0 },
      coverageArtifacts: 0,
      testCommands: 0,
      buildCommands: 0,
      requiredVariables: [],
      errors: [{ code: error.code || "LOCAL_AGENT_DISCOVERY_FAILED", message: sanitizeText(error.message) }],
      evidence: "discovery failed"
    };
  }
}

function stableAgentProjectDiscovery(project = {}) {
  return {
    projectId: project.projectId,
    projectSlug: project.projectSlug,
    status: project.status,
    repositoryPath: project.repositoryPath,
    git: project.git ? {
      isGit: project.git.isGit,
      branch: project.git.branch,
      commit: project.git.commit,
      dirty: project.git.dirty,
      ahead: project.git.ahead,
      behind: project.git.behind
    } : null,
    stack: project.stack,
    languages: project.languages,
    frameworks: project.frameworks,
    dependencyManagers: project.dependencyManagers,
    dockerfiles: project.dockerfiles,
    composeFiles: project.composeFiles,
    containers: project.containers,
    ports: project.ports,
    processes: project.processes,
    publishedPorts: project.publishedPorts,
    localServices: project.localServices,
    healthChecks: project.healthChecks,
    observability: project.observability,
    coverageArtifacts: project.coverageArtifacts,
    testCommands: project.testCommands,
    buildCommands: project.buildCommands,
    requiredVariables: project.requiredVariables,
    errors: project.errors
  };
}

function localAgentProcesses(runtime = {}) {
  return (runtime.resources || []).slice(0, 30).map((resource) => ({
    type: "docker-container",
    id: sanitizeText(resource.id || "").slice(0, 16),
    name: sanitizeText(resource.name || ""),
    service: sanitizeText(resource.service || ""),
    image: sanitizeText(resource.image || ""),
    state: sanitizeText(resource.state || "unknown"),
    status: sanitizeText(resource.status || ""),
    composeProject: sanitizeText(resource.composeProject || ""),
    ports: localAgentPortList(resource.ports || [])
  }));
}

function localAgentPublishedPorts(runtime = {}) {
  return localAgentPortList(runtime.ports || []);
}

function localAgentLocalServices(runtime = {}) {
  return (runtime.resources || []).slice(0, 30).map((resource) => ({
    name: sanitizeText(resource.service || resource.name || ""),
    container: sanitizeText(resource.name || ""),
    state: sanitizeText(resource.state || "unknown"),
    composeProject: sanitizeText(resource.composeProject || ""),
    ports: localAgentPortList(resource.ports || []),
    urls: (resource.urls || []).slice(0, 10).map((url) => ({
      label: sanitizeText(url.label || ""),
      url: sanitizeText(url.url || "")
    }))
  }));
}

function localAgentPortList(ports = []) {
  return uniquePorts(ports || []).slice(0, 60).map((port) => ({
    host: Number(port.host || 0),
    target: Number(port.target || 0),
    protocol: sanitizeText(port.protocol || "tcp")
  }));
}

function localAgentLanguages(stack = []) {
  const set = new Set();
  if (stack.includes("node") || stack.includes("nextjs") || stack.includes("vite")) set.add("javascript/typescript");
  if (stack.includes("maven") || stack.includes("gradle")) set.add("java/kotlin");
  if (stack.includes("python")) set.add("python");
  if (stack.includes("flutter")) set.add("dart");
  return [...set].sort();
}

function localAgentFrameworks(stack = []) {
  return stack.filter((item) => ["nextjs", "vite", "flutter", "sonarqube", "jenkins", "docker"].includes(item)).sort();
}

function localAgentDependencyManagers(stack = [], manifests = []) {
  const managers = new Set();
  if (stack.includes("node")) managers.add("npm/pnpm/yarn");
  if (stack.includes("maven")) managers.add("maven");
  if (stack.includes("gradle")) managers.add("gradle");
  if (stack.includes("python")) managers.add("pip");
  if (stack.includes("flutter")) managers.add("pub");
  if ((manifests || []).some((item) => /package-lock|pnpm-lock|yarn.lock/i.test(item))) managers.add("node-lockfile");
  return [...managers].sort();
}

function localAgentManifestPath(item) {
  if (!item) return "";
  if (typeof item === "string") return item;
  return item.relativePath || item.path || "";
}

function localAgentRequiredVariables(project, discovered = {}) {
  const variables = new Set();
  if (project.sonarProjectKey || (discovered.detectedStack || []).includes("sonarqube")) variables.add("SONAR_TOKEN");
  if ((discovered.detectedStack || []).includes("sonarqube")) variables.add("SONAR_HOST_URL");
  if ((discovered.detectedStack || []).includes("jenkins")) variables.add("JENKINS_URL");
  return [...variables].map((name) => ({
    name,
    configured: name === "SONAR_TOKEN" ? Boolean(process.env.SONAR_TOKEN) : Boolean(process.env[name] || project.runtimeConfig?.[runtimeConfigKeyForVariable(name)]),
    value: "[REDACTED]"
  }));
}

function runtimeConfigKeyForVariable(name) {
  if (name === "SONAR_HOST_URL") return "sonarHostUrl";
  if (name === "JENKINS_URL") return "jenkinsUrl";
  return name;
}

const infrastructureAdapterCatalog = Object.freeze([
  {
    name: "local",
    mode: "local-runtime+static",
    description: "Adaptador paraguas local para runtime Docker, Compose y manifests locales.",
    capabilities: ["static_manifest_scan", "runtime_inventory", "connectivity_check", "drift_static"],
    timeoutMs: 8000,
    rateLimit: { windowSeconds: 60, maxRequests: 120 },
    liveCalls: "local-only"
  },
  {
    name: "docker",
    mode: "local-runtime",
    description: "Docker Engine local por socket/CLI aprobado, inventario de contenedores e imagenes sin mutaciones.",
    capabilities: ["runtime_inventory", "container_state_detection", "image_reference_detection", "connectivity_check"],
    timeoutMs: 8000,
    rateLimit: { windowSeconds: 60, maxRequests: 120 },
    liveCalls: "local-only"
  },
  {
    name: "docker-compose",
    mode: "static-manifest+local-runtime",
    description: "Docker Compose por manifests y labels de runtime local.",
    capabilities: ["static_manifest_scan", "service_detection", "port_detection", "drift_static"],
    timeoutMs: 8000,
    rateLimit: { windowSeconds: 60, maxRequests: 120 },
    liveCalls: "local-only"
  },
  {
    name: "terraform",
    mode: "static-manifest",
    description: "Terraform/OpenTofu por inspeccion estatica de recursos y backend.",
    capabilities: ["static_manifest_scan", "drift_static", "iac_risk_detection"],
    timeoutMs: 5000,
    rateLimit: { windowSeconds: 60, maxRequests: 60 },
    liveCalls: "disabled"
  },
  {
    name: "opentofu",
    mode: "static-manifest",
    description: "OpenTofu compatible con modulos Terraform; no ejecuta plan/apply.",
    capabilities: ["static_manifest_scan", "drift_static", "iac_risk_detection"],
    timeoutMs: 5000,
    rateLimit: { windowSeconds: 60, maxRequests: 60 },
    liveCalls: "disabled"
  },
  {
    name: "aws",
    mode: "static-discovery",
    description: "AWS por Terraform, CloudFormation, SAM o Serverless. Discovery live bloqueado hasta credenciales temporales.",
    capabilities: ["static_manifest_scan", "credential_presence", "drift_static"],
    timeoutMs: 5000,
    rateLimit: { windowSeconds: 60, maxRequests: 30 },
    liveCalls: "disabled",
    credentialRefs: ["AWS_PROFILE", "AWS_REGION", "AWS_ACCESS_KEY_ID"]
  },
  {
    name: "cloudformation",
    mode: "static-template",
    description: "CloudFormation, SAM y Serverless por templates YAML/JSON sin llamadas live a AWS.",
    capabilities: ["static_manifest_scan", "iam_risk_detection", "resource_detection", "drift_static"],
    timeoutMs: 5000,
    rateLimit: { windowSeconds: 60, maxRequests: 30 },
    liveCalls: "disabled",
    credentialRefs: ["AWS_PROFILE", "AWS_REGION"]
  },
  {
    name: "gcp",
    mode: "static-discovery",
    description: "Google Cloud por Terraform, Cloud Build, Firebase o App Engine. Discovery live bloqueado por defecto.",
    capabilities: ["static_manifest_scan", "credential_presence", "drift_static"],
    timeoutMs: 5000,
    rateLimit: { windowSeconds: 60, maxRequests: 30 },
    liveCalls: "disabled",
    credentialRefs: ["GOOGLE_APPLICATION_CREDENTIALS", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"]
  },
  {
    name: "azure",
    mode: "future-static-discovery",
    description: "Azure/Bicep/ARM como extension futura. Discovery live permanece deshabilitado.",
    capabilities: ["static_manifest_scan", "credential_presence", "future_live_adapter_contract"],
    timeoutMs: 5000,
    rateLimit: { windowSeconds: 60, maxRequests: 30 },
    liveCalls: "disabled",
    credentialRefs: ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_SUBSCRIPTION_ID"],
    future: true
  },
  {
    name: "vps",
    mode: "static-discovery",
    description: "VPS por systemd, nginx, Caddy, Ansible o scripts de deploy. No abre SSH.",
    capabilities: ["static_manifest_scan", "deploy_script_risk_detection"],
    timeoutMs: 5000,
    rateLimit: { windowSeconds: 60, maxRequests: 30 },
    liveCalls: "disabled"
  },
  {
    name: "kubernetes",
    mode: "static-discovery",
    description: "Kubernetes, Helm y Kustomize por manifests. API live bloqueada hasta contexto controlado.",
    capabilities: ["static_manifest_scan", "credential_presence", "workload_risk_detection", "drift_static"],
    timeoutMs: 5000,
    rateLimit: { windowSeconds: 60, maxRequests: 30 },
    liveCalls: "disabled",
    credentialRefs: ["KUBECONFIG"]
  },
  {
    name: "github",
    mode: "link-validation",
    description: "GitHub se usa para links derivados y validacion read-only sin tokens del navegador.",
    capabilities: ["link_validation", "repository_metadata_static"],
    timeoutMs: 5000,
    rateLimit: { windowSeconds: 60, maxRequests: 20 },
    liveCalls: "read-only"
  },
  {
    name: "gitlab",
    mode: "link-validation",
    description: "GitLab se usa para links derivados y validacion read-only sin tokens del navegador.",
    capabilities: ["link_validation", "repository_metadata_static"],
    timeoutMs: 5000,
    rateLimit: { windowSeconds: 60, maxRequests: 20 },
    liveCalls: "read-only"
  },
  {
    name: "harness",
    mode: "static-pipeline",
    description: "Harness por manifests de pipeline y referencias declaradas, sin API tokens.",
    capabilities: ["pipeline_manifest_detection", "credential_presence", "secret_presence_only"],
    timeoutMs: 5000,
    rateLimit: { windowSeconds: 60, maxRequests: 20 },
    liveCalls: "disabled",
    credentialRefs: ["HARNESS_ACCOUNT_ID", "HARNESS_PROJECT_ID", "HARNESS_API_KEY"]
  },
  {
    name: "jenkins",
    mode: "service-link",
    description: "Jenkins local opcional, validado por URL configurada y links del proyecto.",
    capabilities: ["connectivity_check", "pipeline_link_validation"],
    timeoutMs: 5000,
    rateLimit: { windowSeconds: 60, maxRequests: 20 },
    liveCalls: "read-only"
  },
  {
    name: "sonarqube",
    mode: "service-link",
    description: "SonarQube local opcional, sin devolver tokens ni issues con secretos.",
    capabilities: ["connectivity_check", "quality_snapshot_import"],
    timeoutMs: 10000,
    rateLimit: { windowSeconds: 60, maxRequests: 20 },
    liveCalls: "read-only"
  },
  {
    name: "grafana",
    mode: "observability-link",
    description: "Grafana se valida como dashboard local de observabilidad.",
    capabilities: ["dashboard_link_validation", "connectivity_check"],
    timeoutMs: 4000,
    rateLimit: { windowSeconds: 60, maxRequests: 30 },
    liveCalls: "read-only"
  },
  {
    name: "prometheus",
    mode: "observability-query",
    description: "Prometheus se consulta con queries acotadas y timeouts cortos.",
    capabilities: ["metrics_query", "target_discovery", "connectivity_check"],
    timeoutMs: 4000,
    rateLimit: { windowSeconds: 60, maxRequests: 60 },
    liveCalls: "read-only"
  },
  {
    name: "loki",
    mode: "observability-query",
    description: "Loki se consulta con limites de streams y ventanas cortas.",
    capabilities: ["logs_query", "connectivity_check"],
    timeoutMs: 4000,
    rateLimit: { windowSeconds: 60, maxRequests: 30 },
    liveCalls: "read-only"
  },
  {
    name: "tempo",
    mode: "observability-query",
    description: "Tempo se consulta para trazas por etiquetas del proyecto.",
    capabilities: ["traces_search", "connectivity_check"],
    timeoutMs: 5000,
    rateLimit: { windowSeconds: 60, maxRequests: 30 },
    liveCalls: "read-only"
  },
  {
    name: "opentelemetry",
    mode: "static-config+observability-link",
    description: "OpenTelemetry por Collector config, SDKs detectados e integraciones de trazas.",
    capabilities: ["collector_config_detection", "sdk_detection", "traces_pipeline_detection"],
    timeoutMs: 5000,
    rateLimit: { windowSeconds: 60, maxRequests: 30 },
    liveCalls: "read-only"
  },
  {
    name: "registry",
    mode: "static-discovery",
    description: "Registries de imagenes se infieren desde manifests sin publicar artefactos.",
    capabilities: ["image_reference_detection", "digest_gap_detection"],
    timeoutMs: 5000,
    rateLimit: { windowSeconds: 60, maxRequests: 30 },
    liveCalls: "disabled"
  },
  {
    name: "object-storage",
    mode: "static-discovery",
    description: "Buckets y object storage S3/GCS/Azure/MinIO por manifests y variables declaradas.",
    capabilities: ["bucket_detection", "object_storage_policy_detection", "secret_presence_only"],
    timeoutMs: 5000,
    rateLimit: { windowSeconds: 60, maxRequests: 30 },
    liveCalls: "disabled",
    credentialRefs: ["AWS_PROFILE", "GOOGLE_APPLICATION_CREDENTIALS", "AZURE_SUBSCRIPTION_ID", "S3_ENDPOINT", "MINIO_ENDPOINT"]
  },
  {
    name: "smtp",
    mode: "static-discovery",
    description: "SMTP/proveedores de email se documentan por configuracion declarada, sin enviar correos.",
    capabilities: ["static_config_detection", "secret_presence_only"],
    timeoutMs: 3000,
    rateLimit: { windowSeconds: 60, maxRequests: 10 },
    liveCalls: "disabled"
  }
]);

function infrastructureDiscoveryPolicy() {
  return {
    phase: "Fase 10",
    adapterInterfaceVersion: "infrastructure-adapter.v1",
    execution: "read-only",
    arbitraryCommands: "blocked",
    liveCloudCalls: "disabled",
    cache: "enabled",
    cacheTtlSeconds: Math.round(infrastructureDiscoveryCacheTtlMs / 1000),
    cacheScope: "static-manifests",
    credentials: "presence only, values never returned",
    permanentKeys: "discouraged",
    preferredCloudAuth: ["oidc", "workload_identity", "temporary_roles", "least_privilege_service_accounts"],
    refreshAudit: "infrastructure.discovery.refresh"
  };
}

function infrastructureAdapterDefinitions() {
  return infrastructureAdapterCatalog.map((definition) => publicInfrastructureAdapterDefinition(definition));
}

function publicInfrastructureAdapterDefinition(definition) {
  const enabled = infrastructureAdapterEnabled(definition.name);
  return {
    interfaceVersion: "infrastructure-adapter.v1",
    name: definition.name,
    mode: definition.mode,
    description: definition.description,
    capabilities: [...definition.capabilities],
    timeoutMs: definition.timeoutMs,
    rateLimit: definition.rateLimit,
    enabled,
    future: Boolean(definition.future),
    activation: infrastructureAdapterActivation(definition, enabled),
    liveCalls: definition.liveCalls,
    credentialRefs: [...(definition.credentialRefs || [])],
    credentialState: adapterCredentialState(definition.name),
    secretPolicy: infrastructureAdapterSecretPolicy(),
    validationContract: infrastructureAdapterValidationContract(definition),
    connectivityContract: infrastructureAdapterConnectivityContract(definition),
    evidenceContract: {
      emits: ["status", "resourceCount", "manifestCount", "findingCount", "summary", "evidence"],
      secrets: "redacted"
    },
    errorContract: {
      shape: ["severity", "code", "title", "detail", "evidence"],
      userFacing: true
    }
  };
}

function infrastructureAdapterActivation(definition, enabled = infrastructureAdapterEnabled(definition.name)) {
  return {
    enabled,
    defaultEnabled: true,
    enableEnv: "INFRA_ADAPTERS_ENABLED",
    disableEnv: "INFRA_ADAPTERS_DISABLED",
    future: Boolean(definition.future)
  };
}

function infrastructureAdapterSecretPolicy() {
  return {
    valuesReturned: false,
    valuesLogged: false,
    credentialRefsOnly: true,
    redaction: "names and presence only"
  };
}

function infrastructureAdapterValidationContract(definition) {
  return {
    config: "manifest_or_environment_presence",
    timeoutMs: definition.timeoutMs,
    rateLimit: definition.rateLimit,
    secrets: "presence_only"
  };
}

function infrastructureAdapterConnectivityContract(definition) {
  return {
    mode: definition.liveCalls,
    liveCloudCalls: definition.liveCalls === "disabled" ? "blocked" : "read-only",
    timeoutMs: definition.timeoutMs,
    rateLimit: definition.rateLimit
  };
}

function infrastructureAdapterEnabled(adapter) {
  const enabledSet = csvSet(process.env.INFRA_ADAPTERS_ENABLED || "");
  const disabledSet = csvSet(process.env.INFRA_ADAPTERS_DISABLED || "");
  if (enabledSet.size) return enabledSet.has(adapter);
  return !disabledSet.has(adapter);
}

function csvSet(value) {
  return new Set(String(value || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
}

function infrastructureAdapterDefinition(adapter) {
  return infrastructureAdapterCatalog.find((definition) => definition.name === adapter) || null;
}

function adapterCredentialState(adapter) {
  if ([
    "local",
    "docker",
    "docker-compose",
    "terraform",
    "opentofu",
    "vps",
    "registry",
    "smtp",
    "github",
    "gitlab",
    "jenkins",
    "sonarqube",
    "grafana",
    "prometheus",
    "loki",
    "tempo",
    "opentelemetry"
  ].includes(adapter)) return "not_required";
  if (adapterLiveCredentialsAvailable(adapter)) return "configured";
  if (adapterConfiguredByEnvironment(adapter)) return "partially_configured";
  return "not_configured";
}

async function platformInfrastructureAdapterRegistry() {
  const platform = await platformStatus().catch((error) => ({ services: [], error: sanitizeText(error.message) }));
  const projectReports = await Promise.all(state.projects.map(async (project) => {
    try {
      const report = await infrastructureOverview(project, { platformStatus: platform });
      return {
        projectId: project.id,
        projectSlug: project.slug,
        projectName: project.displayName,
        status: report.status,
        counts: report.counts,
        discoveryCache: report.discoveryCache,
        adapters: report.adapters
      };
    } catch (error) {
      return {
        projectId: project.id,
        projectSlug: project.slug,
        projectName: project.displayName,
        status: "ERROR",
        error: sanitizeText(error.message),
        counts: infrastructureCounts([], []),
        discoveryCache: null,
        adapters: {}
      };
    }
  }));
  return {
    generatedAt: nowIso(),
    environment: "local",
    policy: infrastructureDiscoveryPolicy(),
    adapters: infrastructureAdapterDefinitions(),
    cache: infrastructureDiscoveryCacheSummary(),
    projects: projectReports
  };
}

async function projectInfrastructureAdapterRegistry(project) {
  const report = await infrastructureOverview(project);
  return {
    generatedAt: nowIso(),
    projectId: project.id,
    projectSlug: project.slug,
    environment: "local",
    policy: infrastructureDiscoveryPolicy(),
    adapters: Object.values(report.adapters || {}),
    discoveryCache: report.discoveryCache,
    counts: report.counts,
    findings: report.findings || []
  };
}

function infrastructureDiscoveryCacheSummary() {
  const snapshots = state.infrastructureDiscoverySnapshots || [];
  return {
    ttlSeconds: Math.round(infrastructureDiscoveryCacheTtlMs / 1000),
    snapshots: snapshots.length,
    latest: publicInfrastructureDiscoverySnapshot(snapshots[0] || null),
    byProject: state.projects.map((project) => {
      const latest = latestInfrastructureDiscoverySnapshot(project.id);
      return {
        projectId: project.id,
        projectSlug: project.slug,
        snapshot: publicInfrastructureDiscoverySnapshot(latest)
      };
    })
  };
}

function latestInfrastructureDiscoverySnapshot(projectId) {
  return (state.infrastructureDiscoverySnapshots || []).find((snapshot) => snapshot.projectId === projectId && snapshot.scope === "static-manifests") || null;
}

async function platformInfrastructureOverview() {
  const platform = await platformStatus().catch((error) => ({ services: [], error: sanitizeText(error.message) }));
  const projectReports = await Promise.all(state.projects.map(async (project) => {
    try {
      const report = await infrastructureOverview(project, { platformStatus: platform });
      return {
        projectId: project.id,
        projectSlug: project.slug,
        projectName: project.displayName,
        status: report.status,
        counts: report.counts,
        adapters: report.adapters,
        drift: report.drift,
        resources: report.resources.slice(0, 30)
      };
    } catch (error) {
      const finding = infrastructureFinding({
        severity: "critical",
        adapter: "platform",
        code: "PROJECT_INFRASTRUCTURE_FAILED",
        title: "No se pudo evaluar infraestructura del proyecto",
        detail: error.message,
        evidence: error.code || "infrastructure overview failed",
        project
      });
      return {
        projectId: project.id,
        projectSlug: project.slug,
        projectName: project.displayName,
        status: "ERROR",
        counts: infrastructureCounts([], [finding]),
        adapters: {},
        drift: { status: "ERROR", findings: [finding] },
        resources: []
      };
    }
  }));
  const resources = projectReports.flatMap((report) => report.resources || []);
  const findings = projectReports.flatMap((report) => report.drift?.findings || []);
  return {
    generatedAt: nowIso(),
    environment: "local",
    status: infrastructureRollupStatus(projectReports.map((report) => report.status), findings),
    counts: sumInfrastructureCounts(projectReports.map((report) => report.counts)),
    adapterPolicy: {
      ...infrastructureDiscoveryPolicy(),
      discoveryMode: "static manifests plus local runtime state"
    },
    adapterRegistry: infrastructureAdapterDefinitions(),
    cache: infrastructureDiscoveryCacheSummary(),
    projects: projectReports,
    resources: resources.slice(0, 150),
    findings: findings.sort(compareInfrastructureFindings).slice(0, 120)
  };
}

async function infrastructureOverview(project, options = {}) {
  let abs = "";
  let discovered = null;
  try {
    abs = await canonicalProjectPath(project.repositoryPath);
    discovered = await discoverRepository(project.repositoryPath);
  } catch (error) {
    const finding = infrastructureFinding({
      severity: "critical",
      adapter: "platform",
      code: "PROJECT_PATH_NOT_SCANNABLE",
      title: "El repositorio no se pudo resolver para discovery de infraestructura",
      detail: "La Fase 4 necesita leer manifests dentro de PROJECTS_ROOT.",
      evidence: error.message,
      project
    });
    return {
      generatedAt: nowIso(),
      projectId: project.id,
      projectSlug: project.slug,
      environment: "local",
      status: "ERROR",
      counts: infrastructureCounts([], [finding]),
      adapters: {},
      adapterRegistry: infrastructureAdapterDefinitions(),
      discoveryCache: null,
      resources: [],
      manifests: [],
      drift: { status: "ERROR", findings: [finding] },
      findings: [finding]
    };
  }

  const [catalog, runtime, staticInventory, platform] = await Promise.all([
    loadCatalogDescriptor(),
    localRuntimeSummary(project, discovered).catch(() => ({ status: "unavailable", resources: [], ports: [], profiles: [], freshness: null })),
    cachedInfrastructureInventory(project, abs, options),
    options.platformStatus ? Promise.resolve(options.platformStatus) : platformStatus().catch((error) => ({ services: [], error: sanitizeText(error.message) }))
  ]);
  const descriptorProject = descriptorProjectFor(catalog, project);
  const declared = infrastructureDeclaredState(project, descriptorProject);
  const runtimeResources = infrastructureRuntimeResources(project, runtime);
  const integrationResources = infrastructureIntegrationResources(project, discovered, platform);
  const resources = [...staticInventory.resources, ...runtimeResources, ...integrationResources].sort(compareInfrastructureResources);
  const manifests = [...new Set(staticInventory.manifests.map((item) => item.path))].sort();
  const findings = [
    ...staticInventory.findings,
    ...infrastructureDriftFindings(project, declared, resources, runtime, manifests)
  ].sort(compareInfrastructureFindings);
  const adapters = infrastructureAdapters(project, resources, findings, runtime, staticInventory, platform);
  return {
    generatedAt: nowIso(),
    projectId: project.id,
    projectSlug: project.slug,
    environment: "local",
    status: infrastructureRollupStatus(Object.values(adapters).map((adapter) => adapter.status), findings),
    counts: infrastructureCounts(resources, findings),
    adapterPolicy: infrastructureDiscoveryPolicy(),
    declared,
    adapters,
    adapterRegistry: Object.values(adapters),
    discoveryCache: staticInventory.cache || null,
    resources,
    manifests,
    drift: {
      status: findings.some((finding) => finding.severity === "critical") ? "ERROR" : findings.some((finding) => finding.severity === "warning") ? "DRIFT_DETECTED" : "NO_DRIFT_DETECTED",
      findings
    },
    findings
  };
}

async function cachedInfrastructureInventory(project, abs, options = {}) {
  const now = Date.now();
  const latest = latestInfrastructureDiscoverySnapshot(project.id);
  if (!options.forceRefresh && latest?.inventory && Date.parse(latest.expiresAt || "") > now) {
    const inventory = cloneInfrastructureInventory(latest.inventory);
    return {
      ...inventory,
      cache: {
        status: "HIT",
        id: latest.id,
        sourceHash: latest.sourceHash,
        sourceHashShort: latest.sourceHashShort || shortDocHash(latest.sourceHash),
        generatedAt: latest.generatedAt,
        expiresAt: latest.expiresAt,
        ttlSeconds: latest.ttlSeconds,
        ageSeconds: Math.max(0, Math.round((now - Date.parse(latest.generatedAt || nowIso())) / 1000))
      }
    };
  }

  const started = Date.now();
  const inventory = await discoverInfrastructureInventory(project, abs);
  const sourceHash = infrastructureInventoryHash(inventory);
  const snapshot = {
    id: crypto.randomUUID(),
    projectId: project.id,
    projectSlug: project.slug,
    scope: "static-manifests",
    status: infrastructureDiscoverySnapshotStatus(inventory),
    sourceHash,
    sourceHashShort: shortDocHash(sourceHash),
    generatedAt: nowIso(),
    expiresAt: new Date(Date.now() + infrastructureDiscoveryCacheTtlMs).toISOString(),
    ttlSeconds: Math.round(infrastructureDiscoveryCacheTtlMs / 1000),
    durationMs: Date.now() - started,
    manifestCount: inventory.manifests.length,
    resourceCount: inventory.resources.length,
    findingCount: inventory.findings.length,
    adapterRuns: infrastructureStaticAdapterRuns(inventory),
    inventory: cloneInfrastructureInventory(inventory)
  };
  state.infrastructureDiscoverySnapshots = [
    snapshot,
    ...(state.infrastructureDiscoverySnapshots || []).filter((item) => !(item.projectId === project.id && item.scope === "static-manifests"))
  ].slice(0, 100);
  await saveState();
  return {
    ...inventory,
    cache: {
      status: latest ? "REFRESHED" : "MISS",
      id: snapshot.id,
      sourceHash: snapshot.sourceHash,
      sourceHashShort: snapshot.sourceHashShort,
      generatedAt: snapshot.generatedAt,
      expiresAt: snapshot.expiresAt,
      ttlSeconds: snapshot.ttlSeconds,
      ageSeconds: 0,
      durationMs: snapshot.durationMs
    }
  };
}

function cloneInfrastructureInventory(inventory = {}) {
  return {
    manifests: JSON.parse(JSON.stringify(inventory.manifests || [])),
    resources: JSON.parse(JSON.stringify(inventory.resources || [])),
    findings: JSON.parse(JSON.stringify(inventory.findings || []))
  };
}

function infrastructureInventoryHash(inventory = {}) {
  return hashString(JSON.stringify({
    manifests: (inventory.manifests || []).map((item) => ({
      path: item.path,
      adapter: item.adapter,
      kind: item.kind
    })).sort((a, b) => String(a.path).localeCompare(String(b.path))),
    resources: (inventory.resources || []).map((item) => ({
      provider: item.provider,
      source: item.source,
      type: item.type,
      name: item.name,
      namespace: item.namespace,
      parent: item.parent,
      status: item.status,
      path: item.path,
      line: item.line
    })).sort(compareInfrastructureResources),
    findings: (inventory.findings || []).map((item) => ({
      severity: item.severity,
      adapter: item.adapter,
      code: item.code,
      title: item.title,
      detail: item.detail,
      evidence: item.evidence,
      path: item.path,
      line: item.line
    })).sort(compareInfrastructureFindings)
  }));
}

function infrastructureDiscoverySnapshotStatus(inventory = {}) {
  const findings = inventory.findings || [];
  if (findings.some((finding) => finding.severity === "critical")) return "ERROR";
  if (findings.some((finding) => finding.severity === "warning")) return "PARTIALLY_CONFIGURED";
  return "CONFIGURED_AND_VERIFIED";
}

function infrastructureStaticAdapterRuns(inventory = {}) {
  const manifests = inventory.manifests || [];
  const resources = inventory.resources || [];
  const findings = inventory.findings || [];
  return infrastructureAdapterCatalog.map((definition) => {
    const adapterManifests = manifests.filter((item) => item.adapter === definition.name);
    const adapterResources = resources.filter((item) => infrastructureAdapterResourceMatch(definition.name, item));
    const adapterFindings = findings.filter((item) => item.adapter === definition.name);
    return {
      adapter: definition.name,
      status: infrastructureStatus({
        configured: adapterManifests.length > 0 || adapterResources.length > 0 || adapterConfiguredByEnvironment(definition.name),
        verified: false,
        findings: adapterFindings
      }),
      mode: definition.mode,
      manifestCount: adapterManifests.length,
      resourceCount: adapterResources.length,
      findingCount: adapterFindings.length,
      liveCalls: definition.liveCalls
    };
  });
}

function publicInfrastructureDiscoverySnapshot(snapshot) {
  if (!snapshot) return null;
  return {
    id: snapshot.id,
    projectId: snapshot.projectId,
    projectSlug: snapshot.projectSlug,
    scope: snapshot.scope,
    status: snapshot.status,
    sourceHash: snapshot.sourceHash,
    sourceHashShort: snapshot.sourceHashShort || shortDocHash(snapshot.sourceHash),
    generatedAt: snapshot.generatedAt,
    expiresAt: snapshot.expiresAt,
    ttlSeconds: snapshot.ttlSeconds,
    durationMs: snapshot.durationMs || 0,
    manifestCount: snapshot.manifestCount || 0,
    resourceCount: snapshot.resourceCount || 0,
    findingCount: snapshot.findingCount || 0,
    adapterRuns: snapshot.adapterRuns || []
  };
}

async function refreshInfrastructureDiscovery(project, body = {}, correlation = correlationId()) {
  const requestedAdapter = sanitizeText(body.adapter || "all").toLowerCase();
  if (requestedAdapter !== "all" && !infrastructureAdapterDefinition(requestedAdapter)) {
    throw problem(400, "INFRASTRUCTURE_ADAPTER_UNSUPPORTED", "Unsupported infrastructure adapter.");
  }
  const report = await infrastructureOverview(project, { forceRefresh: true, requestedAdapter });
  await appendAudit("infrastructure.discovery.refresh", `${project.slug}:infrastructure:${requestedAdapter}`, report.status, {
    projectId: project.id,
    adapter: requestedAdapter,
    snapshotId: report.discoveryCache?.id || "",
    sourceHash: report.discoveryCache?.sourceHash || "",
    correlationId: correlation
  });
  return {
    projectId: project.id,
    projectSlug: project.slug,
    status: report.status,
    policy: infrastructureDiscoveryPolicy(),
    discoveryCache: report.discoveryCache,
    adapters: requestedAdapter === "all"
      ? Object.values(report.adapters || {})
      : Object.values(report.adapters || {}).filter((adapter) => adapter.name === requestedAdapter),
    counts: report.counts,
    findings: report.findings || []
  };
}

async function discoverInfrastructureInventory(project, abs) {
  const files = await listRepositoryFiles(abs, {
    maxDepth: 8,
    matcher: (name, relativePath) => isInfrastructureManifest(name, relativePath)
  });
  const resources = [];
  const findings = [];
  const manifests = [];
  for (const file of files) {
    const text = await fs.readFile(file.absolutePath, "utf8").catch(() => "");
    const normalized = file.relativePath.split(path.sep).join("/");
    manifests.push({
      path: normalized,
      adapter: infrastructureManifestAdapter(normalized, text),
      kind: infrastructureManifestKind(normalized)
    });
    if (/\.tf$/i.test(normalized)) inspectTerraform(project, normalized, text, resources, findings);
    else if (isDockerfileManifestPath(normalized)) inspectDockerfileInfrastructure(project, normalized, text, resources, findings);
    else if (isKubernetesManifestPath(normalized, text)) inspectKubernetesManifest(project, normalized, text, resources, findings);
    else if (isComposeManifestPath(normalized)) inspectComposeInfrastructure(project, normalized, text, resources, findings);
    else if (/Chart\.ya?ml$/i.test(normalized)) inspectHelmChart(project, normalized, text, resources);
    else if (/kustomization\.ya?ml$/i.test(path.basename(normalized))) inspectKustomize(project, normalized, text, resources);
    else if (isCloudFormationManifestPath(normalized, text)) inspectCloudFormationManifest(project, normalized, text, resources, findings);
    else if (isAzureManifestPath(normalized, text)) inspectAzureManifest(project, normalized, text, resources, findings);
    else if (isHarnessManifestPath(normalized, text)) inspectHarnessManifest(project, normalized, text, resources, findings);
    else if (isOpenTelemetryManifestPath(normalized, text)) inspectOpenTelemetryManifest(project, normalized, text, resources, findings);
    else if (isObjectStorageManifestPath(normalized, text)) inspectObjectStorageManifest(project, normalized, text, resources, findings);
    else if (isGcpManifestPath(normalized, text)) inspectGcpManifest(project, normalized, text, resources, findings);
    else if (isAwsManifestPath(normalized, text)) inspectAwsManifest(project, normalized, text, resources, findings);
    else if (isVpsManifestPath(normalized)) inspectVpsManifest(project, normalized, text, resources, findings);
  }
  return { manifests, resources, findings };
}

function isInfrastructureManifest(name, relativePath) {
  const normalized = String(relativePath || name).split(path.sep).join("/");
  const base = path.basename(normalized);
  if (/^Dockerfile(\..+)?$/i.test(base) || /^docker-compose[\w.-]*\.ya?ml$/i.test(base) || /^compose\.ya?ml$/i.test(base)) return true;
  if (/\.tf$/i.test(base) || base === ".terraform.lock.hcl") return true;
  if (/\.bicep$/i.test(base) || ["azuredeploy.json", "azure-pipelines.yml", "azure-pipelines.yaml"].includes(base)) return true;
  if (/\.cfn\.(json|ya?ml)$/i.test(base) || /cloudformation/i.test(normalized)) return true;
  if (/(^|\/)\.harness\//i.test(normalized) || /(^|\/)harness\//i.test(normalized)) return true;
  if (/(^|\/)(otel|opentelemetry)\//i.test(normalized) || /otel-collector|opentelemetry/i.test(base)) return true;
  if (/(^|\/)(storage|buckets|object-storage|minio|s3|gcs)\//i.test(normalized) && /\.(ya?ml|json|tf)$/i.test(base)) return true;
  if (/Chart\.ya?ml$/i.test(base) || /kustomization\.ya?ml$/i.test(base)) return true;
  if (/(^|\/)(k8s|kubernetes|manifests|helm|charts)\//i.test(normalized) && /\.ya?ml$/i.test(base)) return true;
  if (["serverless.yml", "serverless.yaml", "template.yaml", "template.yml", "sam.yaml", "sam.yml"].includes(base)) return true;
  if (["cloudbuild.yaml", "cloudbuild.yml", "app.yaml", "firebase.json", "gcloud.json"].includes(base)) return true;
  if (/(^|\/)(deploy|deployment|infra|infrastructure|ops|ansible|coolify|nginx|caddy|systemd)\//i.test(normalized) && /\.(ya?ml|json|conf|service|sh)$/i.test(base)) return true;
  if (/(nginx\.conf|Caddyfile|\.service)$/i.test(base)) return true;
  return false;
}

function infrastructureManifestAdapter(relativePath, text = "") {
  const normalized = String(relativePath || "");
  if (/\.tf$/i.test(normalized)) {
    if (/\bazurerm_[a-z0-9_]+/i.test(text) || /provider\s+"azurerm"/i.test(text)) return "azure";
    if (/\baws_[a-z0-9_]+/i.test(text) || /provider\s+"aws"/i.test(text)) return "aws";
    if (/\bgoogle_[a-z0-9_]+/i.test(text) || /provider\s+"google"/i.test(text)) return "gcp";
    if (/\bkubernetes_[a-z0-9_]+/i.test(text) || /provider\s+"kubernetes"/i.test(text)) return "kubernetes";
    return "terraform";
  }
  if (isDockerfileManifestPath(normalized)) return "docker";
  if (isComposeManifestPath(normalized)) return "docker-compose";
  if (isKubernetesManifestPath(normalized, text)) return "kubernetes";
  if (isCloudFormationManifestPath(normalized, text)) return "cloudformation";
  if (isAzureManifestPath(normalized, text)) return "azure";
  if (isHarnessManifestPath(normalized, text)) return "harness";
  if (isOpenTelemetryManifestPath(normalized, text)) return "opentelemetry";
  if (isObjectStorageManifestPath(normalized, text)) return "object-storage";
  if (isGcpManifestPath(normalized, text)) return "gcp";
  if (isAwsManifestPath(normalized, text)) return "aws";
  if (isVpsManifestPath(normalized)) return "vps";
  return "infrastructure";
}

function infrastructureManifestKind(relativePath) {
  const base = path.basename(relativePath);
  if (/\.tf$/i.test(base)) return "terraform";
  if (isComposeManifestPath(relativePath)) return "compose";
  if (isDockerfileManifestPath(relativePath)) return "dockerfile";
  if (/\.bicep$/i.test(base)) return "bicep";
  if (isCloudFormationManifestPath(relativePath, "")) return "cloudformation";
  if (isOpenTelemetryManifestPath(relativePath, "")) return "opentelemetry";
  if (isHarnessManifestPath(relativePath, "")) return "harness";
  if (/Chart\.ya?ml$/i.test(base)) return "helm-chart";
  if (/kustomization\.ya?ml$/i.test(base)) return "kustomize";
  if (/\.(ya?ml)$/i.test(base)) return "yaml";
  if (/\.(json)$/i.test(base)) return "json";
  if (/\.service$/i.test(base)) return "systemd";
  return "file";
}

function inspectDockerfileInfrastructure(project, relativePath, text, resources, findings) {
  resources.push(infrastructureResource({
    project,
    provider: "local",
    source: "dockerfile",
    type: "dockerfile",
    name: path.basename(relativePath),
    path: relativePath,
    status: "DECLARED"
  }));
  for (const match of String(text || "").matchAll(/^\s*FROM\s+([^\s]+)(?:\s+AS\s+([A-Za-z0-9_.-]+))?/gim)) {
    const image = sanitizeText(match[1] || "");
    resources.push(infrastructureResource({
      project,
      provider: "local",
      source: "dockerfile",
      type: "container-image",
      name: image,
      parent: path.basename(relativePath),
      path: relativePath,
      line: lineNumberAtIndex(text, match.index || 0),
      status: "DECLARED"
    }));
    if (/:latest$/i.test(image) || !/[:@]/.test(image)) {
      findings.push(infrastructureFinding({
        severity: "info",
        adapter: "docker",
        code: "DOCKER_BASE_IMAGE_NOT_PINNED",
        title: "Imagen base Docker no fijada",
        detail: "Usar tags concretos o digest reduce drift entre builds.",
        evidence: image,
        path: relativePath,
        line: lineNumberAtIndex(text, match.index || 0),
        project
      }));
    }
  }
  if (/^\s*USER\s+root\s*$/im.test(text) || !/^\s*USER\s+/im.test(text)) {
    findings.push(infrastructureFinding({
      severity: "info",
      adapter: "docker",
      code: "DOCKER_USER_NOT_DECLARED",
      title: "Dockerfile sin usuario no-root declarado",
      detail: "Declarar USER no-root cuando la imagen no requiere privilegios elevados.",
      evidence: "USER not declared or root",
      path: relativePath,
      project
    }));
  }
}

function inspectTerraform(project, relativePath, text, resources, findings) {
  const hasBackend = /terraform\s*{[\s\S]*backend\s+"/m.test(text);
  for (const match of text.matchAll(/resource\s+"([^"]+)"\s+"([^"]+)"/g)) {
    const type = match[1];
    const name = match[2];
    const provider = terraformProviderFromType(type);
    resources.push(infrastructureResource({
      project,
      provider,
      source: "terraform",
      type,
      name,
      path: relativePath,
      line: lineNumberAtIndex(text, match.index || 0),
      status: "DECLARED"
    }));
    if (isObjectStorageResourceType(provider, type)) {
      resources.push(infrastructureResource({
        project,
        provider: "object-storage",
        source: "terraform",
        type,
        name,
        path: relativePath,
        line: lineNumberAtIndex(text, match.index || 0),
        status: "DECLARED",
        evidence: provider
      }));
    }
  }
  if (/\baws_s3_bucket\b/i.test(text) && !/server_side_encryption|aws_s3_bucket_server_side_encryption_configuration/i.test(text)) {
    findings.push(infrastructureFinding({
      severity: "warning",
      adapter: "aws",
      code: "AWS_S3_ENCRYPTION_NOT_DECLARED",
      title: "S3 sin cifrado declarado junto al bucket",
      detail: "Los buckets Terraform deben declarar cifrado o asociar aws_s3_bucket_server_side_encryption_configuration.",
      evidence: "aws_s3_bucket without encryption resource in same file",
      path: relativePath,
      project
    }));
  }
  if (/\b0\.0\.0\.0\/0\b/.test(text) && /(ingress|cidr_blocks|source_ranges)/i.test(text)) {
    findings.push(infrastructureFinding({
      severity: "warning",
      adapter: terraformProviderFromText(text),
      code: "CLOUD_PUBLIC_INGRESS",
      title: "Regla de ingreso publica",
      detail: "Las reglas 0.0.0.0/0 deben justificarse y limitarse por puerto/origen.",
      evidence: "0.0.0.0/0",
      path: relativePath,
      line: lineNumberAtIndex(text, text.indexOf("0.0.0.0/0")),
      project
    }));
  }
  if (/\.tf$/i.test(relativePath) && !hasBackend && /resource\s+"/.test(text)) {
    findings.push(infrastructureFinding({
      severity: "info",
      adapter: "terraform",
      code: "TERRAFORM_BACKEND_NOT_DECLARED_IN_FILE",
      title: "Terraform sin backend en el archivo inspeccionado",
      detail: "Si este modulo se aplica en equipo, declarar backend remoto evita drift por estado local.",
      evidence: "backend not found in file",
      path: relativePath,
      project
    }));
  }
}

function inspectKubernetesManifest(project, relativePath, text, resources, findings) {
  const docs = String(text || "").split(/^---\s*$/m);
  for (const doc of docs) {
    const kind = yamlScalar(doc, "kind");
    const name = yamlNestedScalar(doc, "metadata", "name") || yamlScalar(doc, "name");
    if (!kind || !name) continue;
    resources.push(infrastructureResource({
      project,
      provider: "kubernetes",
      source: "kubernetes-manifest",
      type: kind,
      name,
      namespace: yamlNestedScalar(doc, "metadata", "namespace") || "default",
      path: relativePath,
      line: lineNumberAtIndex(text, text.indexOf(doc)),
      status: "DECLARED"
    }));
    if (/kind:\s*Service/i.test(doc) && /type:\s*LoadBalancer/i.test(doc)) {
      findings.push(infrastructureFinding({
        severity: "warning",
        adapter: "kubernetes",
        code: "K8S_LOADBALANCER_SERVICE",
        title: "Service LoadBalancer expone trafico externamente",
        detail: "Confirmar que el acceso publico sea intencional y tenga controles de red/TLS.",
        evidence: `${kind}/${name}`,
        path: relativePath,
        project
      }));
    }
    if (/privileged:\s*true/i.test(doc) || /hostNetwork:\s*true/i.test(doc)) {
      findings.push(infrastructureFinding({
        severity: "critical",
        adapter: "kubernetes",
        code: "K8S_PRIVILEGED_OR_HOST_NETWORK",
        title: "Workload Kubernetes con privilegios altos",
        detail: "privileged o hostNetwork deben evitarse salvo excepcion aprobada.",
        evidence: `${kind}/${name}`,
        path: relativePath,
        project
      }));
    }
    if (/kind:\s*(Deployment|StatefulSet|DaemonSet|Job|CronJob)/i.test(doc) && !/readinessProbe:/i.test(doc)) {
      findings.push(infrastructureFinding({
        severity: "info",
        adapter: "kubernetes",
        code: "K8S_READINESS_PROBE_MISSING",
        title: "Workload sin readinessProbe",
        detail: "La readiness probe permite despliegues y drift checks mas confiables.",
        evidence: `${kind}/${name}`,
        path: relativePath,
        project
      }));
    }
  }
}

function inspectComposeInfrastructure(project, relativePath, text, resources, findings) {
  const lines = String(text || "").split(/\r?\n/);
  let inServices = false;
  let currentService = "";
  let currentIndent = 0;
  let serviceIndent = 0;
  lines.forEach((line, index) => {
    const indent = line.match(/^ */)?.[0].length || 0;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    if (/^services:\s*$/.test(trimmed)) {
      inServices = true;
      currentService = "";
      currentIndent = indent;
      serviceIndent = indent + 2;
      return;
    }
    if (inServices && indent <= currentIndent && /^[a-zA-Z0-9_-]+:\s*$/.test(trimmed)) inServices = false;
    if (!inServices) return;
    const service = line.match(/^ {2,}([a-zA-Z0-9_.-]+):\s*$/);
    if (service && indent === serviceIndent) {
      currentService = service[1];
      resources.push(infrastructureResource({
        project,
        provider: "local",
        source: "docker-compose",
        type: "compose-service",
        name: currentService,
        path: relativePath,
        line: index + 1,
        status: "DECLARED"
      }));
      return;
    }
    if (currentService && /^image:\s*/i.test(trimmed)) {
      const image = trimmed.replace(/^image:\s*/i, "").replace(/^["']|["']$/g, "");
      resources.push(infrastructureResource({
        project,
        provider: "local",
        source: "docker-compose",
        type: "container-image",
        name: image,
        parent: currentService,
        path: relativePath,
        line: index + 1,
        status: "DECLARED"
      }));
    }
    if (currentService && /0\.0\.0\.0:\d+:\d+/.test(trimmed)) {
      findings.push(infrastructureFinding({
        severity: "warning",
        adapter: "docker-compose",
        code: "COMPOSE_PORT_PUBLIC_BIND",
        title: "Puerto Compose publicado en todas las interfaces",
        detail: "Para desarrollo local preferir 127.0.0.1 cuando no haga falta acceso externo.",
        evidence: trimmed,
        path: relativePath,
        line: index + 1,
        project
      }));
    }
  });
}

function inspectHelmChart(project, relativePath, text, resources) {
  const name = yamlScalar(text, "name") || path.basename(path.dirname(relativePath)) || "helm-chart";
  resources.push(infrastructureResource({
    project,
    provider: "kubernetes",
    source: "helm",
    type: "helm-chart",
    name,
    path: relativePath,
    status: "DECLARED"
  }));
}

function inspectKustomize(project, relativePath, text, resources) {
  resources.push(infrastructureResource({
    project,
    provider: "kubernetes",
    source: "kustomize",
    type: "kustomization",
    name: yamlScalar(text, "namePrefix") || path.basename(path.dirname(relativePath)) || "kustomization",
    path: relativePath,
    status: "DECLARED"
  }));
}

function inspectVpsManifest(project, relativePath, text, resources, findings) {
  const base = path.basename(relativePath);
  const type = /\.service$/i.test(base) ? "systemd-service" : /nginx\.conf/i.test(base) ? "nginx-config" : /Caddyfile/i.test(base) ? "caddy-config" : /ansible/i.test(relativePath) ? "ansible" : "vps-artifact";
  resources.push(infrastructureResource({
    project,
    provider: "vps",
    source: "vps",
    type,
    name: base,
    path: relativePath,
    status: "DECLARED"
  }));
  if (/sshpass|StrictHostKeyChecking=no|curl\s+[^|;&]+[|]\s*(sh|bash)/i.test(text)) {
    findings.push(infrastructureFinding({
      severity: "warning",
      adapter: "vps",
      code: "VPS_DEPLOY_SCRIPT_RISK",
      title: "Script VPS con patron riesgoso",
      detail: "Evitar sshpass, desactivar host key checking o ejecutar scripts remotos sin verificacion.",
      evidence: "sshpass/StrictHostKeyChecking/curl|sh",
      path: relativePath,
      project
    }));
  }
}

function inspectCloudFormationManifest(project, relativePath, text, resources, findings) {
  const templateType = /serverless/i.test(relativePath) ? "serverless" : /sam/i.test(relativePath) ? "sam" : "cloudformation";
  let count = 0;
  for (const match of text.matchAll(/Type:\s*(AWS::[A-Za-z0-9:]+)/g)) {
    count += 1;
    const type = match[1];
    resources.push(infrastructureResource({
      project,
      provider: "aws",
      source: templateType,
      type,
      name: `${path.basename(relativePath)}:${type}`,
      path: relativePath,
      line: lineNumberAtIndex(text, match.index || 0),
      status: "DECLARED"
    }));
    if (/^AWS::S3::Bucket$/i.test(type)) {
      resources.push(infrastructureResource({
        project,
        provider: "object-storage",
        source: templateType,
        type,
        name: `${path.basename(relativePath)}:S3Bucket`,
        path: relativePath,
        line: lineNumberAtIndex(text, match.index || 0),
        status: "DECLARED",
        evidence: "aws"
      }));
    }
  }
  for (const match of text.matchAll(/"Type"\s*:\s*"((?:AWS)::[A-Za-z0-9:]+)"/g)) {
    count += 1;
    const type = match[1];
    resources.push(infrastructureResource({
      project,
      provider: "aws",
      source: templateType,
      type,
      name: `${path.basename(relativePath)}:${type}`,
      path: relativePath,
      line: lineNumberAtIndex(text, match.index || 0),
      status: "DECLARED"
    }));
    if (/^AWS::S3::Bucket$/i.test(type)) {
      resources.push(infrastructureResource({
        project,
        provider: "object-storage",
        source: templateType,
        type,
        name: `${path.basename(relativePath)}:S3Bucket`,
        path: relativePath,
        line: lineNumberAtIndex(text, match.index || 0),
        status: "DECLARED",
        evidence: "aws"
      }));
    }
  }
  if (!count) {
    resources.push(infrastructureResource({
      project,
      provider: "aws",
      source: templateType,
      type: "cloudformation-template",
      name: path.basename(relativePath),
      path: relativePath,
      status: "DECLARED"
    }));
  }
  if (/Effect:\s*Allow[\s\S]{0,300}Action:\s*["']?\*["']?/i.test(text) || /Resource:\s*["']?\*["']?/i.test(text)) {
    findings.push(infrastructureFinding({
      severity: "warning",
      adapter: "cloudformation",
      code: "CLOUDFORMATION_WILDCARD_IAM",
      title: "CloudFormation declara IAM wildcard",
      detail: "Actions o resources wildcard deben reemplazarse por permisos minimos.",
      evidence: "Action/Resource wildcard",
      path: relativePath,
      project
    }));
  }
}

function inspectAzureManifest(project, relativePath, text, resources, findings) {
  const base = path.basename(relativePath);
  let detected = false;
  for (const match of text.matchAll(/resource\s+([A-Za-z0-9_]+)\s+'(Microsoft\.[^@']+)@[^']+'/g)) {
    detected = true;
    resources.push(infrastructureResource({
      project,
      provider: "azure",
      source: "bicep",
      type: match[2],
      name: match[1],
      path: relativePath,
      line: lineNumberAtIndex(text, match.index || 0),
      status: "DECLARED"
    }));
    if (/Microsoft\.Storage\/storageAccounts/i.test(match[2])) {
      resources.push(infrastructureResource({
        project,
        provider: "object-storage",
        source: "bicep",
        type: match[2],
        name: match[1],
        path: relativePath,
        line: lineNumberAtIndex(text, match.index || 0),
        status: "DECLARED",
        evidence: "azure"
      }));
    }
  }
  for (const match of text.matchAll(/"type"\s*:\s*"(Microsoft\.[^"]+)"/g)) {
    detected = true;
    resources.push(infrastructureResource({
      project,
      provider: "azure",
      source: "arm",
      type: match[1],
      name: `${base}:${match[1]}`,
      path: relativePath,
      line: lineNumberAtIndex(text, match.index || 0),
      status: "DECLARED"
    }));
  }
  if (!detected) {
    resources.push(infrastructureResource({
      project,
      provider: "azure",
      source: /pipeline/i.test(base) ? "azure-pipelines" : "azure-static",
      type: /pipeline/i.test(base) ? "pipeline" : "azure-manifest",
      name: base,
      path: relativePath,
      status: "DECLARED"
    }));
  }
  if (/Owner|Contributor/i.test(text) && /roleDefinitionId|roleAssignment|authorization/i.test(text)) {
    findings.push(infrastructureFinding({
      severity: "warning",
      adapter: "azure",
      code: "AZURE_BROAD_ROLE_DECLARED",
      title: "Rol Azure amplio declarado",
      detail: "Owner o Contributor deben reemplazarse por roles minimos por recurso.",
      evidence: "Owner/Contributor",
      path: relativePath,
      project
    }));
  }
}

function inspectHarnessManifest(project, relativePath, text, resources, findings) {
  const name = yamlScalar(text, "name") || yamlNestedScalar(text, "pipeline", "name") || path.basename(relativePath);
  resources.push(infrastructureResource({
    project,
    provider: "harness",
    source: "harness-static",
    type: /pipeline/i.test(text) ? "pipeline" : "harness-manifest",
    name,
    path: relativePath,
    status: "DECLARED"
  }));
  if (/apiKey|token|secret:\s*[^<\s{]/i.test(text)) {
    findings.push(infrastructureFinding({
      severity: "warning",
      adapter: "harness",
      code: "HARNESS_SECRET_LITERAL_RISK",
      title: "Harness podria contener secreto literal",
      detail: "Usar referencias a secrets manager o variables protegidas; no guardar tokens en manifests.",
      evidence: "secret-like key detected",
      path: relativePath,
      project
    }));
  }
}

function inspectOpenTelemetryManifest(project, relativePath, text, resources, findings) {
  const sections = ["receivers", "processors", "exporters", "service"].filter((section) => new RegExp(`^\\s*${section}:\\s*$`, "mi").test(text));
  resources.push(infrastructureResource({
    project,
    provider: "opentelemetry",
    source: "otel-static",
    type: "collector-config",
    name: path.basename(relativePath),
    path: relativePath,
    status: "DECLARED",
    evidence: sections.join(", ")
  }));
  for (const exporter of ["otlp", "prometheus", "loki", "tempo", "logging"].filter((name) => new RegExp(`^\\s{2,}${name}[/\\w-]*:`, "mi").test(text))) {
    resources.push(infrastructureResource({
      project,
      provider: "opentelemetry",
      source: "otel-static",
      type: "exporter",
      name: exporter,
      path: relativePath,
      status: "DECLARED"
    }));
  }
  if (!/exporters:\s*/i.test(text)) {
    findings.push(infrastructureFinding({
      severity: "info",
      adapter: "opentelemetry",
      code: "OTEL_EXPORTERS_NOT_DECLARED",
      title: "OpenTelemetry sin exporters declarados",
      detail: "El Collector debe declarar exporters para validar el pipeline de trazas/metricas/logs.",
      evidence: "exporters missing",
      path: relativePath,
      project
    }));
  }
}

function inspectObjectStorageManifest(project, relativePath, text, resources, findings) {
  const bucketMatches = [
    ...text.matchAll(/\b(?:bucket|bucketName|s3Bucket|gcsBucket|containerName)\s*[:=]\s*["']?([A-Za-z0-9_.-]{3,})["']?/gi)
  ];
  if (!bucketMatches.length) {
    resources.push(infrastructureResource({
      project,
      provider: "object-storage",
      source: "static-config",
      type: "object-storage-config",
      name: path.basename(relativePath),
      path: relativePath,
      status: "DECLARED"
    }));
  }
  for (const match of bucketMatches.slice(0, 20)) {
    resources.push(infrastructureResource({
      project,
      provider: "object-storage",
      source: "static-config",
      type: "bucket",
      name: match[1],
      path: relativePath,
      line: lineNumberAtIndex(text, match.index || 0),
      status: "DECLARED"
    }));
  }
  if (/public-read|allUsers|AllowPublicAccess|blockPublicAccess:\s*false/i.test(text)) {
    findings.push(infrastructureFinding({
      severity: "warning",
      adapter: "object-storage",
      code: "OBJECT_STORAGE_PUBLIC_ACCESS_RISK",
      title: "Object storage con acceso publico posible",
      detail: "Confirmar politicas publicas, CORS y URLs firmadas antes de exponer buckets.",
      evidence: "public access marker",
      path: relativePath,
      project
    }));
  }
}

function inspectGcpManifest(project, relativePath, text, resources, findings) {
  const base = path.basename(relativePath);
  const type = base.startsWith("cloudbuild") ? "cloud-build" : base === "firebase.json" ? "firebase" : base === "app.yaml" ? "app-engine" : "gcp-manifest";
  resources.push(infrastructureResource({
    project,
    provider: "gcp",
    source: "gcp-static",
    type,
    name: base,
    path: relativePath,
    status: "DECLARED"
  }));
  for (const match of text.matchAll(/\b(?:storageBucket|bucket|bucketName)\s*[:=]\s*["']?([A-Za-z0-9_.-]{3,})["']?/gi)) {
    resources.push(infrastructureResource({
      project,
      provider: "object-storage",
      source: "gcp-static",
      type: "bucket",
      name: match[1],
      path: relativePath,
      line: lineNumberAtIndex(text, match.index || 0),
      status: "DECLARED",
      evidence: "gcp"
    }));
  }
  if (/roles\/owner|primitiveRoles\/owner/i.test(text)) {
    findings.push(infrastructureFinding({
      severity: "critical",
      adapter: "gcp",
      code: "GCP_OWNER_ROLE_DECLARED",
      title: "Rol Owner declarado",
      detail: "Evitar Owner; usar roles minimos por servicio.",
      evidence: "roles/owner",
      path: relativePath,
      project
    }));
  }
}

function inspectAwsManifest(project, relativePath, text, resources, findings) {
  const templateType = /serverless/i.test(relativePath) ? "serverless" : /sam|template/i.test(relativePath) ? "cloudformation" : "aws-manifest";
  for (const match of text.matchAll(/Type:\s*(AWS::[A-Za-z0-9:]+)/g)) {
    const type = match[1];
    resources.push(infrastructureResource({
      project,
      provider: "aws",
      source: templateType,
      type,
      name: `${path.basename(relativePath)}:${type}`,
      path: relativePath,
      line: lineNumberAtIndex(text, match.index || 0),
      status: "DECLARED"
    }));
    if (/^AWS::S3::Bucket$/i.test(type)) {
      resources.push(infrastructureResource({
        project,
        provider: "object-storage",
        source: templateType,
        type,
        name: `${path.basename(relativePath)}:S3Bucket`,
        path: relativePath,
        line: lineNumberAtIndex(text, match.index || 0),
        status: "DECLARED",
        evidence: "aws"
      }));
    }
  }
  if (/Effect:\s*Allow[\s\S]{0,300}Action:\s*["']?\*["']?/i.test(text) || /Resource:\s*["']?\*["']?/i.test(text)) {
    findings.push(infrastructureFinding({
      severity: "warning",
      adapter: "aws",
      code: "AWS_WILDCARD_IAM",
      title: "IAM wildcard declarado",
      detail: "Actions o resources wildcard deben reemplazarse por permisos minimos.",
      evidence: "Action/Resource wildcard",
      path: relativePath,
      project
    }));
  }
}

function infrastructureDeclaredState(project, descriptorProject) {
  const environments = declaredEnvironments(project, descriptorProject);
  return {
    components: declaredComponents(project, descriptorProject),
    environments,
    providers: [...new Set(environments.map((environment) => environment.provider || "local"))].sort()
  };
}

function infrastructureRuntimeResources(project, runtime) {
  return (runtime.resources || []).map((resource) => infrastructureResource({
    project,
    provider: "local",
    source: "docker-runtime",
    type: "running-container",
    name: resource.service || resource.name || resource.id,
    status: resource.state === "running" ? "VERIFIED_RUNNING" : "DETECTED",
    evidence: resource.name || resource.id,
    metadata: {
      ports: resource.ports || [],
      urls: resource.urls || []
    }
  }));
}

function infrastructureIntegrationResources(project, discovered = {}, platform = {}) {
  const resources = [];
  const remote = parseGitRemoteUrl(discovered?.git?.remote || "");
  if (remote?.provider === "github" || remote?.provider === "gitlab") {
    resources.push(infrastructureResource({
      project,
      provider: remote.provider,
      source: "git-remote",
      type: "repository",
      name: remote.repoPath || remote.baseUrl,
      status: "DETECTED",
      evidence: remote.baseUrl
    }));
  }
  const instrumentation = discovered?.instrumentation || {};
  if ((instrumentation.traces || []).length || (discovered?.detectedStack || []).includes("opentelemetry")) {
    resources.push(infrastructureResource({
      project,
      provider: "opentelemetry",
      source: "repository-instrumentation",
      type: "sdk-or-traces",
      name: project.slug,
      status: "DETECTED",
      evidence: (instrumentation.traces || []).slice(0, 3).join("; ")
    }));
  }
  const servicesByName = new Map((platform.services || []).map((service) => [service.name, service]));
  for (const name of ["jenkins", "sonarqube", "grafana", "prometheus", "loki", "tempo"]) {
    const service = servicesByName.get(name);
    if (!service) continue;
    resources.push(infrastructureResource({
      project,
      provider: name,
      source: "platform-service",
      type: "service-connectivity",
      name,
      status: service.status === "UP" ? "VERIFIED_RUNNING" : "DETECTED",
      evidence: service.status === "UP" ? "health endpoint reachable" : service.error || service.details || "service not reachable",
      metadata: {
        profile: service.profile || "",
        required: service.required !== false,
        url: service.url || ""
      }
    }));
  }
  return resources;
}

function infrastructureAdapters(project, resources, findings, runtime, staticInventory = {}, platform = {}) {
  const adapters = {};
  const manifests = staticInventory.manifests || [];
  for (const definition of infrastructureAdapterCatalog) {
    const adapter = definition.name;
    const adapterResources = resources.filter((resource) => infrastructureAdapterResourceMatch(adapter, resource));
    const adapterFindings = findings.filter((finding) => finding.adapter === adapter);
    const adapterManifests = manifests.filter((manifest) => manifest.adapter === adapter);
    const enabled = infrastructureAdapterEnabled(adapter);
    const detectedConfigured = adapterResources.length > 0 || adapterManifests.length > 0 || adapterConfiguredByEnvironment(adapter);
    const configured = enabled && detectedConfigured;
    const verified = enabled && infrastructureAdapterVerified(adapter, adapterResources, runtime, platform);
    adapters[adapter] = {
      interfaceVersion: "infrastructure-adapter.v1",
      name: adapter,
      status: infrastructureStatus({ configured, verified, findings: adapterFindings }),
      mode: definition.mode,
      description: definition.description,
      enabled,
      activation: infrastructureAdapterActivation(definition, enabled),
      liveCalls: definition.liveCalls,
      capabilities: [...definition.capabilities],
      timeoutMs: definition.timeoutMs,
      rateLimit: definition.rateLimit,
      configured,
      verified,
      credentialRefs: [...(definition.credentialRefs || [])],
      credentialState: adapterCredentialState(adapter),
      secretPolicy: infrastructureAdapterSecretPolicy(),
      validation: infrastructureAdapterValidation(adapter, configured, adapterManifests, adapterResources, adapterFindings),
      connectivity: infrastructureAdapterConnectivity(adapter, definition, verified, configured, adapterResources),
      evidence: infrastructureAdapterEvidence(adapter, adapterResources, adapterManifests, verified),
      errors: infrastructureAdapterErrors(adapterFindings),
      manifestCount: adapterManifests.length,
      resourceCount: adapterResources.length,
      findingCount: adapterFindings.length,
      cache: staticInventory.cache ? {
        status: staticInventory.cache.status,
        snapshotId: staticInventory.cache.id || "",
        sourceHashShort: staticInventory.cache.sourceHashShort || "",
        generatedAt: staticInventory.cache.generatedAt || "",
        expiresAt: staticInventory.cache.expiresAt || ""
      } : null,
      summary: infrastructureAdapterSummary(adapter, adapterResources, adapterManifests, verified)
    };
  }
  return adapters;
}

function infrastructureAdapterVerified(adapter, resources = [], runtime = {}, platform = {}) {
  if (["local", "docker", "docker-compose"].includes(adapter)) {
    return resources.some((resource) => resource.status === "VERIFIED_RUNNING") || runtime.status === "running";
  }
  if (["jenkins", "sonarqube", "grafana", "prometheus", "loki", "tempo"].includes(adapter)) {
    const service = (platform.services || []).find((item) => item.name === adapter);
    return service?.status === "UP";
  }
  if (adapter === "opentelemetry") {
    return resources.some((resource) => resource.status === "VERIFIED_RUNNING" || resource.source === "otel-static");
  }
  return adapterLiveCredentialsAvailable(adapter);
}

function infrastructureAdapterValidation(adapter, configured, manifests = [], resources = [], findings = []) {
  return {
    status: findings.some((finding) => finding.severity === "critical")
      ? "ERROR"
      : configured
        ? "CONFIGURED"
        : "NOT_CONFIGURED",
    configSources: [
      manifests.length ? "manifest" : "",
      resources.length ? "resource" : "",
      adapterConfiguredByEnvironment(adapter) ? "environment" : ""
    ].filter(Boolean),
    manifestCount: manifests.length,
    resourceCount: resources.length,
    findingCount: findings.length,
    credentialState: adapterCredentialState(adapter),
    secretValuesReturned: false
  };
}

function infrastructureAdapterConnectivity(adapter, definition, verified, configured, resources = []) {
  const liveDisabled = definition.liveCalls === "disabled";
  return {
    attempted: !liveDisabled && configured,
    mode: definition.liveCalls,
    status: verified
      ? "VERIFIED"
      : liveDisabled
        ? "SKIPPED_LIVE_DISABLED"
        : configured
          ? "NOT_VERIFIED"
          : "NOT_CONFIGURED",
    timeoutMs: definition.timeoutMs,
    rateLimit: definition.rateLimit,
    evidence: verified
      ? "connectivity evidence present"
      : liveDisabled
        ? "live checks blocked by policy"
        : resources[0]?.evidence || "no connectivity evidence"
  };
}

function infrastructureAdapterEvidence(adapter, resources = [], manifests = [], verified = false) {
  const manifestEvidence = manifests.slice(0, 5).map((manifest) => `manifest:${manifest.path}`);
  const resourceEvidence = resources.slice(0, 8).map((resource) => `${resource.source}:${resource.type}:${resource.name}`);
  const verificationEvidence = verified ? [`verified:${adapter}`] : [];
  return [...verificationEvidence, ...manifestEvidence, ...resourceEvidence];
}

function infrastructureAdapterErrors(findings = []) {
  return findings
    .filter((finding) => finding.severity === "critical" || finding.severity === "warning")
    .slice(0, 10)
    .map((finding) => ({
      severity: finding.severity,
      code: finding.code,
      title: finding.title,
      detail: finding.detail,
      evidence: finding.evidence
    }));
}

function infrastructureAdapterResourceMatch(adapter, resource = {}) {
  if (adapter === "terraform") return resource.provider === "terraform" || resource.source === "terraform";
  if (adapter === "opentofu") return resource.source === "terraform";
  if (adapter === "docker") return resource.source === "dockerfile" || ["running-container", "container-image", "dockerfile"].includes(resource.type);
  if (adapter === "docker-compose") return resource.source === "docker-compose" || resource.type === "compose-service";
  if (adapter === "cloudformation") return ["cloudformation", "sam", "serverless"].includes(resource.source);
  if (adapter === "registry") return resource.type === "container-image" || /image/i.test(resource.type || "");
  if (adapter === "object-storage") return resource.provider === "object-storage";
  return resource.provider === adapter;
}

function infrastructureDriftFindings(project, declared, resources, runtime, manifests) {
  const findings = [];
  const declaredProviders = new Set(declared.providers || []);
  const descriptorOptionalProviders = new Set([
    "docker",
    "docker-compose",
    "github",
    "gitlab",
    "jenkins",
    "harness",
    "sonarqube",
    "grafana",
    "prometheus",
    "loki",
    "tempo",
    "opentelemetry",
    "registry",
    "smtp"
  ]);
  const detectedProviders = new Set(resources.map((resource) => resource.provider));
  for (const provider of detectedProviders) {
    if (provider === "local" || descriptorOptionalProviders.has(provider) || declaredProviders.has(provider)) continue;
    findings.push(infrastructureFinding({
      severity: "warning",
      adapter: provider,
      code: "INFRA_PROVIDER_NOT_DECLARED",
      title: `Proveedor ${provider} detectado pero no declarado`,
      detail: "El descriptor YAML debe declarar los ambientes/proveedores operativos que el repo contiene.",
      evidence: `detectedProvider=${provider}`,
      suggestedAction: "Actualizar config/project-catalog.yaml con el ambiente/proveedor o retirar manifests obsoletos.",
      project
    }));
  }
  for (const provider of declaredProviders) {
    if (provider === "local" || detectedProviders.has(provider)) continue;
    findings.push(infrastructureFinding({
      severity: "info",
      adapter: provider,
      code: "DECLARED_PROVIDER_WITHOUT_MANIFEST",
      title: `Proveedor ${provider} declarado sin manifests detectados`,
      detail: "El descriptor declara el proveedor, pero el discovery no encontro manifests asociados.",
      evidence: `declaredProvider=${provider}`,
      project
    }));
  }
  if ((runtime.status === "stale" || runtime.freshness?.status === "stale") && manifests.some((item) => isComposeManifestPath(item))) {
    findings.push(infrastructureFinding({
      severity: "warning",
      adapter: "local",
      code: "LOCAL_RUNTIME_INFRA_DRIFT",
      title: "Runtime local obsoleto frente a manifests/codigo",
      detail: runtime.freshness?.message || "El fingerprint actual no coincide con el ultimo deploy local.",
      evidence: fingerprintEvidence(runtime),
      suggestedAction: "Usar Start o Rebuild changed components para recrear runtime local.",
      project
    }));
  }
  const declaredComponentPaths = new Set((declared.components || []).map((component) => component.path || "."));
  const composeServices = resources.filter((resource) => resource.type === "compose-service");
  if (composeServices.length && declaredComponentPaths.size <= 1) {
    findings.push(infrastructureFinding({
      severity: "info",
      adapter: "local",
      code: "COMPOSE_SERVICES_NOT_DECLARED_AS_COMPONENTS",
      title: "Compose tiene servicios no modelados como componentes",
      detail: "Declarar componentes mejora drift, owners y observabilidad por servicio.",
      evidence: composeServices.slice(0, 8).map((resource) => resource.name).join(", "),
      suggestedAction: "Agregar componentes al descriptor YAML para los servicios principales.",
      project
    }));
  }
  for (const adapter of ["aws", "gcp", "kubernetes"]) {
    if (detectedProviders.has(adapter) && !adapterLiveCredentialsAvailable(adapter)) {
      findings.push(infrastructureFinding({
        severity: "info",
        adapter,
        code: "LIVE_DISCOVERY_NOT_CONFIGURED",
        title: `Discovery live ${adapter} no configurado`,
        detail: "Fase 4 ejecuta discovery estatico. Para drift real contra cloud se necesitan credenciales/contexts controlados.",
        evidence: `${adapter} credentials/context not configured`,
        project
      }));
    }
  }
  return findings;
}

function infrastructureResource(input) {
  const idSource = `${input.project?.slug || ""}:${input.provider}:${input.source}:${input.type}:${input.name}:${input.path}:${input.line || ""}`;
  return {
    id: slugify(`${input.provider}-${input.type}-${input.name}-${hashText(idSource).slice(0, 8)}`),
    projectId: input.project?.id || "",
    projectSlug: input.project?.slug || "",
    provider: sanitizeText(input.provider || "local"),
    source: sanitizeText(input.source || "static"),
    type: sanitizeText(input.type || "resource"),
    name: sanitizeText(input.name || "unnamed").slice(0, 180),
    namespace: sanitizeText(input.namespace || "").slice(0, 120),
    parent: sanitizeText(input.parent || "").slice(0, 160),
    status: sanitizeText(input.status || "DETECTED"),
    path: sanitizeText(input.path || "").slice(0, 240),
    line: input.line ? Number(input.line) : null,
    evidence: sanitizeText(input.evidence || "").slice(0, 500),
    metadata: input.metadata || {}
  };
}

function infrastructureFinding(input) {
  const project = input.project || {};
  const idSource = `${project.slug || "platform"}:${input.adapter || ""}:${input.code || ""}:${input.path || ""}:${input.line || ""}:${input.evidence || ""}`;
  return {
    id: slugify(`${input.code || "finding"}-${hashText(idSource).slice(0, 10)}`),
    severity: ["critical", "warning", "info"].includes(input.severity) ? input.severity : "info",
    category: "infrastructure",
    adapter: sanitizeText(input.adapter || "local").slice(0, 80),
    code: sanitizeText(input.code || "INFRASTRUCTURE_FINDING").slice(0, 120),
    title: sanitizeText(input.title || "Hallazgo de infraestructura").slice(0, 220),
    detail: sanitizeText(input.detail || "").slice(0, 900),
    evidence: sanitizeText(input.evidence || "").slice(0, 900),
    suggestedAction: sanitizeText(input.suggestedAction || "").slice(0, 600),
    targetTab: "environment",
    projectId: project.id || input.projectId || "",
    projectSlug: project.slug || input.projectSlug || "",
    projectName: sanitizeText(project.displayName || input.projectName || "").slice(0, 160),
    path: sanitizeText(input.path || "").slice(0, 240),
    line: input.line ? Number(input.line) : null,
    source: sanitizeText(input.source || input.adapter || "infrastructure").slice(0, 120)
  };
}

function infrastructureStatus({ configured, verified, findings = [] }) {
  if (findings.some((finding) => finding.severity === "critical")) return "ERROR";
  if (!configured) return "NOT_CONFIGURED";
  if (verified && !findings.some((finding) => finding.severity === "warning")) return "CONFIGURED_AND_VERIFIED";
  if (verified || findings.length) return "PARTIALLY_CONFIGURED";
  return "CONFIGURED_NOT_VERIFIED";
}

function infrastructureRollupStatus(statuses, findings) {
  if (findings.some((finding) => finding.severity === "critical") || statuses.includes("ERROR")) return "ERROR";
  if (statuses.every((status) => status === "CONFIGURED_AND_VERIFIED" || status === "NOT_CONFIGURED")) return "CONFIGURED_AND_VERIFIED";
  if (statuses.some((status) => status === "PARTIALLY_CONFIGURED" || status === "CONFIGURED_NOT_VERIFIED")) return "PARTIALLY_CONFIGURED";
  return "NOT_CONFIGURED";
}

function infrastructureCounts(resources = [], findings = []) {
  const byProvider = resources.reduce((acc, resource) => {
    acc[resource.provider] = (acc[resource.provider] || 0) + 1;
    return acc;
  }, {});
  return {
    resources: resources.length,
    findings: findings.length,
    critical: findings.filter((finding) => finding.severity === "critical").length,
    warning: findings.filter((finding) => finding.severity === "warning").length,
    info: findings.filter((finding) => finding.severity === "info").length,
    providers: byProvider
  };
}

function sumInfrastructureCounts(counts = []) {
  return counts.reduce((acc, item = {}) => {
    acc.resources += Number(item.resources || 0);
    acc.findings += Number(item.findings || 0);
    acc.critical += Number(item.critical || 0);
    acc.warning += Number(item.warning || 0);
    acc.info += Number(item.info || 0);
    for (const [provider, count] of Object.entries(item.providers || {})) {
      acc.providers[provider] = (acc.providers[provider] || 0) + Number(count || 0);
    }
    return acc;
  }, { resources: 0, findings: 0, critical: 0, warning: 0, info: 0, providers: {} });
}

function compareInfrastructureResources(a, b) {
  return String(a.provider).localeCompare(String(b.provider))
    || String(a.type).localeCompare(String(b.type))
    || String(a.name).localeCompare(String(b.name))
    || String(a.path).localeCompare(String(b.path));
}

function compareInfrastructureFindings(a, b) {
  const rank = { critical: 0, warning: 1, info: 2 };
  return (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9)
    || String(a.projectSlug || "").localeCompare(String(b.projectSlug || ""))
    || String(a.adapter || "").localeCompare(String(b.adapter || ""))
    || String(a.code || "").localeCompare(String(b.code || ""));
}

function terraformProviderFromType(type) {
  if (String(type).startsWith("aws_")) return "aws";
  if (String(type).startsWith("google_")) return "gcp";
  if (String(type).startsWith("azurerm_")) return "azure";
  if (String(type).startsWith("kubernetes_")) return "kubernetes";
  return "terraform";
}

function terraformProviderFromText(text) {
  if (/\baws_/i.test(text)) return "aws";
  if (/\bgoogle_/i.test(text)) return "gcp";
  if (/\bazurerm_/i.test(text)) return "azure";
  if (/\bkubernetes_/i.test(text)) return "kubernetes";
  return "terraform";
}

function isDockerfileManifestPath(relativePath) {
  return /^Dockerfile(\..+)?$/i.test(path.basename(String(relativePath || "")));
}

function isComposeManifestPath(relativePath) {
  const base = path.basename(String(relativePath || ""));
  return /^docker-compose[\w.-]*\.ya?ml$/i.test(base) || /^compose\.ya?ml$/i.test(base);
}

function isCloudFormationManifestPath(relativePath, text = "") {
  const normalized = String(relativePath || "");
  const base = path.basename(normalized);
  return ["serverless.yml", "serverless.yaml", "template.yaml", "template.yml", "sam.yaml", "sam.yml"].includes(base)
    || /\.cfn\.(json|ya?ml)$/i.test(base)
    || /cloudformation/i.test(normalized)
    || /AWS::[A-Za-z0-9:]+/.test(text);
}

function isKubernetesManifestPath(relativePath, text = "") {
  const normalized = String(relativePath || "");
  if (/Chart\.ya?ml$/i.test(normalized) || /kustomization\.ya?ml$/i.test(path.basename(normalized))) return true;
  return /(^|\/)(k8s|kubernetes|manifests|helm|charts)\//i.test(normalized)
    || (/apiVersion:\s*[^\n]+/i.test(text) && /kind:\s*(Deployment|Service|Ingress|ConfigMap|Secret|Namespace|StatefulSet|DaemonSet|Job|CronJob|HorizontalPodAutoscaler)/i.test(text));
}

function isAzureManifestPath(relativePath, text = "") {
  const normalized = String(relativePath || "");
  const base = path.basename(normalized);
  return /\.bicep$/i.test(base)
    || ["azuredeploy.json", "azure-pipelines.yml", "azure-pipelines.yaml"].includes(base)
    || /Microsoft\.[A-Za-z]+\/[A-Za-z]+/i.test(text)
    || /provider\s+"azurerm"|\bazurerm_[a-z0-9_]+/i.test(text);
}

function isHarnessManifestPath(relativePath, text = "") {
  const normalized = String(relativePath || "");
  return /(^|\/)\.harness\//i.test(normalized)
    || /(^|\/)harness\//i.test(normalized)
    || (/pipeline:\s*/i.test(text) && /harness|orgIdentifier|projectIdentifier|identifier:/i.test(text));
}

function isOpenTelemetryManifestPath(relativePath, text = "") {
  const normalized = String(relativePath || "");
  const base = path.basename(normalized);
  return /(^|\/)(otel|opentelemetry)\//i.test(normalized)
    || /otel-collector|opentelemetry/i.test(base)
    || (/receivers:\s*/i.test(text) && /exporters:\s*/i.test(text) && /service:\s*/i.test(text));
}

function isObjectStorageManifestPath(relativePath, text = "") {
  const normalized = String(relativePath || "");
  const base = path.basename(normalized);
  return /(^|\/)(storage|buckets|object-storage|minio|s3|gcs)\//i.test(normalized) && /\.(ya?ml|json|tf|env|conf)$/i.test(base)
    || /\b(s3Bucket|gcsBucket|bucketName|MINIO_ENDPOINT|S3_ENDPOINT)\b/i.test(text);
}

function isAwsManifestPath(relativePath, text = "") {
  const base = path.basename(String(relativePath || ""));
  return ["serverless.yml", "serverless.yaml", "template.yaml", "template.yml", "sam.yaml", "sam.yml"].includes(base)
    || /AWS::[A-Za-z0-9:]+/.test(text)
    || /provider:\s*aws/i.test(text);
}

function isGcpManifestPath(relativePath, text = "") {
  const base = path.basename(String(relativePath || ""));
  return ["cloudbuild.yaml", "cloudbuild.yml", "app.yaml", "firebase.json", "gcloud.json"].includes(base)
    || /gcloud|google_cloud|google_project|roles\/[a-z.]+/i.test(text);
}

function isObjectStorageResourceType(provider, type) {
  const value = String(type || "");
  if (provider === "aws" && /s3_bucket|AWS::S3::Bucket/i.test(value)) return true;
  if (provider === "gcp" && /storage_bucket|google_storage_bucket/i.test(value)) return true;
  if (provider === "azure" && /storage_account|Microsoft\.Storage\/storageAccounts/i.test(value)) return true;
  return false;
}

function isVpsManifestPath(relativePath) {
  const normalized = String(relativePath || "");
  const base = path.basename(normalized);
  return /(nginx\.conf|Caddyfile|\.service)$/i.test(base)
    || /(^|\/)(deploy|deployment|infra|infrastructure|ops|ansible|coolify|nginx|caddy|systemd)\//i.test(normalized);
}

function yamlScalar(text, key) {
  const escaped = escapeRegExp(key);
  const match = String(text || "").match(new RegExp(`^\\s*${escaped}:\\s*['"]?([^'"\\n#]+)['"]?\\s*$`, "m"));
  return match ? sanitizeText(match[1].trim()) : "";
}

function yamlNestedScalar(text, parent, key) {
  const lines = String(text || "").split(/\r?\n/);
  let inParent = false;
  let parentIndent = 0;
  for (const line of lines) {
    const indent = line.match(/^ */)?.[0].length || 0;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (!inParent && trimmed === `${parent}:`) {
      inParent = true;
      parentIndent = indent;
      continue;
    }
    if (inParent && indent <= parentIndent) return "";
    if (inParent) {
      const match = trimmed.match(new RegExp(`^${escapeRegExp(key)}:\\s*['"]?([^'"#]+)['"]?\\s*$`));
      if (match) return sanitizeText(match[1].trim());
    }
  }
  return "";
}

function adapterConfiguredByEnvironment(adapter) {
  if (adapter === "aws") return Boolean(process.env.AWS_PROFILE || process.env.AWS_REGION || process.env.AWS_ACCESS_KEY_ID);
  if (adapter === "cloudformation") return Boolean(process.env.AWS_PROFILE || process.env.AWS_REGION || process.env.AWS_ACCESS_KEY_ID);
  if (adapter === "gcp") return Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT);
  if (adapter === "azure") return Boolean(process.env.AZURE_TENANT_ID || process.env.AZURE_CLIENT_ID || process.env.AZURE_SUBSCRIPTION_ID);
  if (adapter === "kubernetes") return Boolean(process.env.KUBECONFIG);
  if (adapter === "harness") return Boolean(process.env.HARNESS_ACCOUNT_ID || process.env.HARNESS_PROJECT_ID || process.env.HARNESS_API_KEY);
  if (adapter === "object-storage") return Boolean(process.env.S3_ENDPOINT || process.env.MINIO_ENDPOINT || process.env.AWS_PROFILE || process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.AZURE_SUBSCRIPTION_ID);
  return false;
}

function adapterLiveCredentialsAvailable(adapter) {
  if (adapter === "aws") return Boolean(process.env.AWS_PROFILE || (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY));
  if (adapter === "cloudformation") return Boolean(process.env.AWS_PROFILE || (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY));
  if (adapter === "gcp") return Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT);
  if (adapter === "azure") return Boolean(process.env.AZURE_TENANT_ID && process.env.AZURE_CLIENT_ID && process.env.AZURE_SUBSCRIPTION_ID);
  if (adapter === "kubernetes") return Boolean(process.env.KUBECONFIG);
  if (adapter === "harness") return Boolean(process.env.HARNESS_ACCOUNT_ID && process.env.HARNESS_PROJECT_ID && process.env.HARNESS_API_KEY);
  if (adapter === "object-storage") return Boolean(process.env.S3_ENDPOINT || process.env.MINIO_ENDPOINT || process.env.AWS_PROFILE || process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.AZURE_SUBSCRIPTION_ID);
  return false;
}

function infrastructureAdapterSummary(adapter, resources = [], manifests = [], verified = false) {
  if (!resources.length && !manifests.length) return `${adapter} no detectado en manifests inspeccionados.`;
  const live = verified ? "con credenciales/contexto disponible" : "sin verificacion live";
  return `${resources.length} recurso(s) y ${manifests.length} manifest(s) ${adapter} detectados por discovery estatico, ${live}.`;
}

async function sonarFetch(apiPath, project = null) {
  const headers = {};
  const connection = sonarConnection(project);
  if (connection.token) {
    headers.Authorization = `Basic ${Buffer.from(`${connection.token}:`).toString("base64")}`;
  }
  return fetchJson(`${connection.hostUrl}${apiPath}`, { headers, timeoutMs: 10000 });
}

async function fetchJson(url, options = {}) {
  const response = await fetchAllowedUpstream(url, options, securityConfig);
  if (!response.ok) {
    throw problem(response.status, "UPSTREAM_ERROR", `The configured upstream returned status ${response.status}.`);
  }
  try {
    return response.text ? JSON.parse(response.text) : {};
  } catch {
    throw problem(502, "INVALID_UPSTREAM_RESPONSE", "The configured upstream returned invalid JSON.");
  }
}

async function fetchText(url, options = {}) {
  try {
    return await fetchAllowedUpstream(url, options, securityConfig);
  } catch (error) {
    return { ok: false, status: Number(error.status || 0), text: sanitizeText(error.code || "UPSTREAM_UNAVAILABLE") };
  }
}

async function validateProjectToolLinks(project) {
  const discovered = await discoverRepository(project.repositoryPath).catch(() => null);
  const links = projectToolLinks(project, discovered?.git || null);
  const validated = [];
  for (const link of links) {
    validated.push(await validateToolLink(project, link));
  }
  const result = {
    project: project.slug,
    generatedAt: nowIso(),
    items: validated
  };
  state.linkValidations ??= {};
  state.linkValidations[project.id] = result;
  await saveState();
  return result;
}

async function validateToolLink(project, link) {
  if (!link.url) {
    return {
      ...link,
      status: "missing",
      lastValidatedAt: nowIso(),
      error: "URL no configurada."
    };
  }
  if (link.provider === "sonarqube" && link.label === "SonarQube overview") {
    return validateSonarProjectLink(project, link);
  }
  const started = Date.now();
  const result = await fetchText(toolValidationUrl(project, link), { timeoutMs: 5000 });
  const durationMs = Date.now() - started;
  const status = classifyToolLinkStatus(link, result);
  return {
    ...link,
    status,
    lastValidatedAt: nowIso(),
    httpStatus: result.status,
    responseTimeMs: durationMs,
    error: status === "ok" ? "" : compactHttpError(result),
    hint: status === "ok" ? link.hint : actionableLinkHint(link, result)
  };
}

function toolValidationUrl(project, link) {
  const url = new URL(link.url);
  if (link.provider === "sonarqube") return replaceUrlOrigin(url, sonarConnection(project).hostUrl);
  if (link.provider === "jenkins") return replaceUrlOrigin(url, jenkinsValidationBase(project));
  if (link.provider === "observability") {
    const byLabel = {
      grafana: `${grafanaUrl}/api/health`,
      "grafana-proyecto": `${grafanaUrl}/api/health`,
      prometheus: `${prometheusUrl}/-/ready`,
      loki: `${lokiUrl}/ready`,
      tempo: `${tempoUrl}/ready`,
      alertmanager: `${alertmanagerUrl}/-/ready`
    };
    const mapped = byLabel[slugify(link.label)];
    if (mapped && /\/(api\/health|ready|-\/ready)$/i.test(mapped)) return mapped;
    return replaceUrlOrigin(url, mapped || link.url);
  }
  return link.url;
}

function replaceUrlOrigin(url, baseUrl) {
  const base = new URL(baseUrl);
  url.protocol = base.protocol;
  url.host = base.host;
  return url.toString();
}

function jenkinsValidationBase(project) {
  const base = jenkinsBaseUrl(project);
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(base)) return jenkinsInternalUrl;
  return base;
}

function classifyToolLinkStatus(link, result) {
  if (result.ok || [301, 302].includes(result.status)) return "ok";
  if (link.provider === "github" || link.provider === "gitlab") {
    if ([401, 403, 404].includes(result.status)) return "blocked";
  }
  if ([401, 403].includes(result.status)) return "ok";
  return "failed";
}

function compactHttpError(result) {
  return result.status ? `HTTP ${result.status}` : "Sin respuesta HTTP";
}

async function validateSonarProjectLink(project, link) {
  const started = Date.now();
  try {
    await sonarFetch("/api/system/status", project);
  } catch (error) {
    return {
      ...link,
      status: "failed",
      lastValidatedAt: nowIso(),
      httpStatus: error.status || 0,
      responseTimeMs: Date.now() - started,
      error: sanitizeText(error.message),
      hint: "SonarQube no responde o SONAR_HOST_URL apunta a una instancia incorrecta. Levantar SonarQube y revisar Proyecto -> Configuracion."
    };
  }
  try {
    await sonarFetch(`/api/components/show?component=${encodeURIComponent(project.sonarProjectKey)}`, project);
    return {
      ...link,
      status: "ok",
      lastValidatedAt: nowIso(),
      httpStatus: 200,
      responseTimeMs: Date.now() - started,
      error: "",
      hint: "Proyecto disponible en SonarQube."
    };
  } catch (error) {
    const authLike = /401|403|not authorized|unauthorized|forbidden/i.test(error.message);
    return {
      ...link,
      status: authLike ? "blocked" : "missing",
      lastValidatedAt: nowIso(),
      httpStatus: error.status || 0,
      responseTimeMs: Date.now() - started,
      error: sanitizeText(error.message),
      hint: authLike
        ? "El token Sonar no tiene permisos o es invalido. Crear token en la misma instancia y cargarlo en Configuracion."
        : `El projectKey '${project.sonarProjectKey}' no existe todavia en SonarQube. Ejecutar Sonar desde el panel para crearlo/importarlo.`
    };
  }
}

function actionableLinkHint(link, details = "") {
  const status = typeof details === "object" ? details.status : 0;
  if (link.provider === "github" || link.provider === "gitlab") {
    if ([401, 403, 404].includes(status)) {
      return "El repositorio puede ser privado o requerir sesion/token. El link sirve en el navegador si estas autenticado; para validar via backend hay que configurar credenciales de Git.";
    }
    return "El remoto Git no fue accesible desde este entorno. Verificar red, permisos o que el repositorio exista.";
  }
  if (link.provider === "jenkins") {
    return "Jenkins no responde o el job todavia no existe. Levantar perfil ci y ejecutar/crear el multibranch job.";
  }
  if (link.provider === "sonarqube") {
    return "SonarQube no responde, el proyecto no existe o el token no tiene permisos.";
  }
  if (link.provider === "observability") {
    return "El servicio de observabilidad no responde desde control-api. Levantar el perfil observability o revisar la red Docker del hub.";
  }
  return link.hint || "Validacion fallida; revisar disponibilidad y configuracion del upstream.";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function platformStatus() {
  const checks = await Promise.all([
    Promise.resolve({
      name: "control-api",
      status: "UP",
      url: publicToolUrl("control-api"),
      profile: "core",
      required: true,
      details: "API local saludable."
    }),
    checkText("web", "http://web/", { profile: "core", required: true }),
    checkJson("sonarqube", `${sonarHostUrl}/api/system/status`, { profile: "quality", required: false }),
    checkText("jenkins", `${jenkinsValidationBase()}/login`, { profile: "ci", required: false }),
    checkText("prometheus", `${prometheusUrl}/-/ready`, { profile: "metrics", required: false }),
    checkText("grafana", `${grafanaUrl}/api/health`, { profile: "metrics", required: false }),
    checkText("loki", `${lokiUrl}/ready`, { profile: "logging", required: false }),
    checkText("tempo", `${tempoUrl}/ready`, { profile: "tracing", required: false }),
    checkText("alertmanager", `${alertmanagerUrl}/-/ready`, { profile: "alerting", required: false })
  ]);
  return {
    generatedAt: nowIso(),
    projectsRoot: "/workspace/projects",
    hostProjectsRoot: "/workspace/projects",
    hostMirrorConfigured: false,
    services: checks
  };
}

async function buildImprovementReport(options = {}) {
  const scope = options.scope === "project" ? "project" : "all";
  const selectedProject = scope === "project" ? findProjectOrThrow(options.projectId || "") : null;
  const [platform, details] = await Promise.all([
    platformStatus(),
    Promise.all((selectedProject ? [selectedProject] : state.projects).map(projectDetails))
  ]);

  const rawItems = [
    ...platformFindings(platform),
    ...details.flatMap(projectFindings)
  ];
  const items = rawItems
    .map((item, index) => normalizeImprovementFinding(item, index))
    .sort(compareImprovementFindings);
  const report = {
    generatedAt: nowIso(),
    scope,
    projectId: selectedProject?.id || "",
    counts: improvementCounts(items),
    platform: improvementPlatformSummary(platform),
    projectSummaries: details.map(improvementProjectSummary),
    items
  };
  report.promptMarkdown = sanitizeImprovementText(renderMasterPrompt(report));
  return report;
}

function platformFindings(platform) {
  const findings = [];
  for (const service of platform.services || []) {
    if (service.status === "UP") continue;
    const required = service.required !== false;
    findings.push({
      severity: required ? "critical" : "info",
      category: "platform",
      title: required ? `Servicio requerido caido: ${service.name}` : `Servicio opcional apagado: ${service.name}`,
      detail: required
        ? "El dashboard depende de este servicio para operar correctamente."
        : `Este servicio pertenece al perfil ${service.profile || "opcional"} y no es necesario en modo liviano.`,
      evidence: service.error || service.details || `status=${service.status}`,
      suggestedAction: required
        ? "Levantar el perfil core y revisar logs del servicio requerido."
        : `Levantar el perfil ${service.profile || "correspondiente"} solo cuando se necesite esta capacidad.`,
      targetTab: "",
      source: "platform/status",
      links: service.url ? [{ label: service.name, url: service.url }] : []
    });
  }
  return findings;
}

function projectFindings(project) {
  const findings = [];
  const runtime = project.localRuntime || {};
  const runtimeProfiles = runtime.profiles || [];
  const runtimeConfig = project.runtimeConfig || {};
  const latestJob = project.latestJob || null;
  const snapshot = project.latestSnapshot || null;
  const gate = String(snapshot?.qualityGate || "").toUpperCase();
  const hasRuntimeProfile = (action) => runtimeProfiles.some((profile) => profile.action === action && profile.available !== false);
  const projectLinks = project.toolLinks || [];

  for (const item of project.doctor || []) {
    if (item.level === "ok") continue;
    findings.push({
      severity: item.level === "error" ? "critical" : "warning",
      category: categoryFromDoctorCode(item.code),
      project,
      title: `${item.code}: ${item.level === "error" ? "bloqueante" : "requiere atencion"}`,
      detail: item.message || "Configuration Doctor reporto una brecha.",
      evidence: item.code,
      suggestedAction: actionFromDoctorCode(item.code),
      targetTab: item.code === "RUNTIME" ? "environment" : "configuration",
      source: "project/doctor",
      links: projectActionLinks(project, ["github", "jenkins", "sonarqube"])
    });
  }

  if (["error", "unavailable", "degraded"].includes(runtime.status)) {
    findings.push({
      severity: runtime.status === "degraded" ? "warning" : "critical",
      category: "runtime",
      project,
      title: `Runtime local ${runtime.label || runtime.status || "con error"}`,
      detail: runtime.explanation || "La ultima accion de runtime termino con error o no esta disponible.",
      evidence: runtime.error || runtime.explanation || runtime.status,
      suggestedAction: "Abrir Terminal / logs, revisar el script aprobado y volver a levantar con ultimos cambios.",
      targetTab: "terminal",
      source: "project/runtime",
      links: []
    });
  }
  if (runtime.status === "stale" || (runtime.freshness?.status === "stale" && runtime.status === "running")) {
    findings.push({
      severity: "critical",
      category: "runtime",
      project,
      title: "Runtime obsoleto respecto del codigo local",
      detail: runtime.explanation || runtime.freshness?.message || "El fingerprint actual no coincide con el ultimo deploy registrado.",
      evidence: fingerprintEvidence(runtime),
      suggestedAction: "Usar Start, Rebuild changed components o Clean rebuild para recrear contenedores con el codigo actual.",
      targetTab: "terminal",
      source: "project/runtime/freshness",
      links: []
    });
  }
  if (runtime.freshness?.status === "stale" && !["running", "stale"].includes(runtime.status)) {
    findings.push({
      severity: "info",
      category: "runtime",
      project,
      title: "Ultimo deploy local quedo viejo",
      detail: "El codigo local cambio desde el ultimo deploy registrado, pero no hay runtime activo usando esa version.",
      evidence: fingerprintEvidence(runtime),
      suggestedAction: "Cuando necesites levantar el proyecto, usar Start para registrar un deploy fresco.",
      targetTab: "environment",
      source: "project/runtime/freshness",
      links: []
    });
  }
  if (runtime.freshness?.status === "unverified") {
    findings.push({
      severity: "warning",
      category: "runtime",
      project,
      title: "Runtime activo sin evidencia de deploy",
      detail: runtime.freshness.message || "Hay contenedores activos, pero no hay fingerprint de deploy registrado.",
      evidence: fingerprintEvidence(runtime),
      suggestedAction: "Levantar el entorno desde el panel para registrar fingerprint y freshness.",
      targetTab: "environment",
      source: "project/runtime/freshness",
      links: []
    });
  }
  if (!hasRuntimeProfile("start")) {
    findings.push({
      severity: "warning",
      category: "runtime",
      project,
      title: "Perfil de start no detectado",
      detail: "El panel no encontro un perfil aprobado para levantar el proyecto.",
      evidence: "profiles=start missing",
      suggestedAction: "Agregar un script local aprobado o ajustar discovery para exponer start/stop/status/logs.",
      targetTab: "configuration",
      source: "project/runtime/profiles",
      links: projectActionLinks(project, ["github"])
    });
  }
  if (!hasRuntimeProfile("logs")) {
    findings.push({
      severity: "info",
      category: "runtime",
      project,
      title: "Perfil de logs no detectado",
      detail: "La terminal del panel no puede consultar logs propios del proyecto si el perfil logs no existe.",
      evidence: "profiles=logs missing",
      suggestedAction: "Agregar soporte logs al script local aprobado.",
      targetTab: "configuration",
      source: "project/runtime/profiles",
      links: projectActionLinks(project, ["github"])
    });
  }

  if (latestJob && ["FAILED", "TIMED_OUT", "CANCELLED"].includes(latestJob.status)) {
    const job = jobFindingContext(latestJob);
    findings.push({
      severity: latestJob.status === "CANCELLED" ? "warning" : job.severity,
      category: job.category,
      project,
      title: job.title,
      detail: job.detail,
      evidence: job.evidence,
      suggestedAction: job.suggestedAction,
      targetTab: job.targetTab,
      source: "project/executions/latest",
      links: projectActionLinks(project, ["sonarqube", "jenkins", "github"])
    });
  }

  if (!runtimeConfig.sonarTokenConfigured) {
    findings.push({
      severity: "info",
      category: "quality",
      project,
      title: "Token Sonar no configurado para ejecuciones locales",
      detail: "Los scans locales de SonarQube necesitan credenciales de la instancia activa.",
      evidence: "sonarTokenConfigured=false",
      suggestedAction: "Cargar un token Sonar valido desde Configuracion del proyecto.",
      targetTab: "configuration",
      source: "project/runtimeConfig",
      links: projectActionLinks(project, ["sonarqube"])
    });
  }
  if (!(project.approvedCommands || []).some((command) => command.action === "sonar")) {
    findings.push({
      severity: "warning",
      category: "quality",
      project,
      title: "Comando Sonar no aprobado",
      detail: "Discovery no encontro un template seguro para ejecutar analisis Sonar en este repo.",
      evidence: "approvedCommands.sonar missing",
      suggestedAction: "Agregar sonar-project.properties o script de calidad compatible con el hub.",
      targetTab: "configuration",
      source: "project/discovery",
      links: projectActionLinks(project, ["github", "sonarqube"])
    });
  }
  if (gate && !["OK", "NONE", "UNKNOWN", "SIN DATOS"].includes(gate)) {
    findings.push({
      severity: "critical",
      category: "quality",
      project,
      title: `Quality Gate ${gate}`,
      detail: "El ultimo snapshot importado de SonarQube no esta en OK.",
      evidence: `qualityGate=${gate}`,
      suggestedAction: "Abrir SonarQube, priorizar vulnerabilities/bugs/critical y corregir sin ocultar deuda real.",
      targetTab: "quality",
      source: "project/quality/latestSnapshot",
      links: projectActionLinks(project, ["sonarqube"])
    });
  }
  if (!snapshot) {
    findings.push({
      severity: "info",
      category: "quality",
      project,
      title: "Sin snapshot Sonar importado",
      detail: "Todavia no hay Quality Gate, cobertura ni metricas reales importadas para este proyecto.",
      evidence: "latestSnapshot=null",
      suggestedAction: "Ejecutar analisis local o validar configuracion Sonar antes de evaluar salud.",
      targetTab: "quality",
      source: "project/quality/latestSnapshot",
      links: projectActionLinks(project, ["sonarqube"])
    });
  }

  const gitLinks = projectLinks.filter((link) => ["github", "gitlab", "git"].includes(link.provider));
  if (!gitLinks.some((link) => link.url)) {
    findings.push({
      severity: "info",
      category: "source-control",
      project,
      title: "Repositorio remoto no enlazado",
      detail: "No hay link usable a branches o pull requests desde el catalogo.",
      evidence: project.git?.remote ? "remote no parseable" : "remote missing",
      suggestedAction: "Configurar origin remoto o revisar el formato del remote Git.",
      targetTab: "configuration",
      source: "project/toolLinks",
      links: []
    });
  }
  addToolLinkFinding(findings, project, "jenkins", "ci", "Jenkins no validado", "Validar Jenkins y el multibranch job para este proyecto.");
  addToolLinkFinding(findings, project, "sonarqube", "quality", "SonarQube no validado", "Validar que el proyecto exista y sea accesible en SonarQube.");

  return findings;
}

function normalizeImprovementFinding(item, index) {
  const projectId = item.project?.id || item.projectId || "";
  const projectSlug = item.project?.slug || item.projectSlug || "";
  const prefix = projectSlug || item.category || "platform";
  return {
    id: slugify(`${prefix}-${item.category}-${item.title}-${index}`) || `finding-${index}`,
    severity: ["critical", "warning", "info"].includes(item.severity) ? item.severity : "info",
    category: sanitizeImprovementText(item.category || "platform").slice(0, 80),
    projectId,
    projectSlug,
    projectName: sanitizeImprovementText(item.project?.displayName || item.projectName || "").slice(0, 160),
    title: sanitizeImprovementText(item.title || "Hallazgo").slice(0, 220),
    detail: sanitizeImprovementText(item.detail || "").slice(0, 800),
    evidence: sanitizeImprovementText(item.evidence || "").slice(0, 1200),
    suggestedAction: sanitizeImprovementText(item.suggestedAction || "").slice(0, 800),
    targetTab: sanitizeImprovementText(item.targetTab || "").slice(0, 40),
    source: sanitizeImprovementText(item.source || "").slice(0, 120),
    links: (item.links || [])
      .filter((link) => link?.url)
      .slice(0, 4)
      .map((link) => ({
        label: sanitizeImprovementText(link.label || link.provider || "link").slice(0, 80),
        url: sanitizeImprovementText(link.url).slice(0, 600)
      }))
  };
}

function sanitizeImprovementText(value) {
  return sanitizeText(value)
    .replace(/\bSONAR_TOKEN\b/g, "token Sonar")
    .replace(/\b[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|PRIVATE_KEY|API_KEY|ACCESS_KEY)[A-Z0-9_]*\b/g, "[REDACTED_SECRET_NAME]")
    .replace(/password=/gi, "[REDACTED_PASSWORD_PARAM]=");
}

function compareImprovementFindings(a, b) {
  const severityRank = { critical: 0, warning: 1, info: 2 };
  return (severityRank[a.severity] ?? 3) - (severityRank[b.severity] ?? 3)
    || String(a.projectSlug || "").localeCompare(String(b.projectSlug || ""))
    || String(a.category || "").localeCompare(String(b.category || ""))
    || String(a.title || "").localeCompare(String(b.title || ""));
}

function improvementCounts(items) {
  const counts = { critical: 0, warning: 0, info: 0, byCategory: {} };
  for (const item of items) {
    counts[item.severity] = (counts[item.severity] || 0) + 1;
    counts.byCategory[item.category] = (counts.byCategory[item.category] || 0) + 1;
  }
  return counts;
}

function improvementPlatformSummary(platform) {
  return {
    generatedAt: platform.generatedAt,
    projectsRoot: platform.projectsRoot,
    hostMirrorConfigured: platform.hostMirrorConfigured,
    services: (platform.services || []).map((service) => ({
      name: service.name,
      status: service.status,
      profile: service.profile || "",
      required: service.required !== false,
      url: service.url || "",
      evidence: sanitizeText(service.error || service.details || "").slice(0, 240)
    }))
  };
}

function improvementProjectSummary(project) {
  const runtime = project.localRuntime || {};
  const git = runtime.git || project.git || {};
  const latestJob = project.latestJob || null;
  return {
    id: project.id,
    slug: project.slug,
    displayName: project.displayName,
    repositoryPath: project.repositoryPath,
    status: project.status,
    git: git?.isGit ? {
      branch: git.branch || "",
      commit: git.shortCommit || String(git.commit || "").slice(0, 8),
      dirty: Boolean(git.dirty),
      changes: Number(git.changes || 0)
    } : { isGit: false },
    runtime: {
      status: runtime.status || "",
      label: runtime.label || "",
      explanation: sanitizeText(runtime.explanation || "").slice(0, 260),
      resources: (runtime.resources || []).length,
      ports: (runtime.ports || []).length,
      freshness: runtime.freshness?.status || ""
    },
    quality: {
      sonarProjectKey: project.sonarProjectKey || "",
      qualityGate: project.latestSnapshot?.qualityGate || "",
      analysisTimestamp: project.latestSnapshot?.analysisTimestamp || ""
    },
    latestJob: latestJob ? {
      action: latestJob.action,
      status: latestJob.status,
      createdAt: latestJob.createdAt,
      finishedAt: latestJob.finishedAt || "",
      failureStage: latestJob.summary?.failure?.stage || ""
    } : null
  };
}

function renderMasterPrompt(report) {
  const lines = [
    "# Prompt maestro para mejorar el Engineering Control Center y proyectos gestionados",
    "",
    "## Rol",
    "Actua como Lead Developer, SRE y QA Automation. Tu objetivo es revisar, corregir, testear y validar de punta a punta el hub local y los proyectos registrados sin ocultar deuda tecnica real.",
    "",
    "## Reglas operativas",
    "- Preservar cambios existentes del usuario y trabajar con ellos.",
    "- No borrar volumenes Docker ni datos persistentes salvo pedido explicito.",
    "- No imprimir, copiar ni persistir secretos; usar placeholders cuando haga falta documentar credenciales.",
    "- No usar supresiones, exclusiones ni comentarios para ocultar issues reales de calidad.",
    "- Priorizar fallos criticos, runtime local, configuracion faltante, CI/CD y luego mejoras observables.",
    "- Despues de cada correccion, ejecutar checks unitarios, integracion y smoke aplicables.",
    "",
    "## Contexto del sistema",
    `- Generado: ${report.generatedAt}`,
    `- Alcance: ${report.scope}${report.projectId ? ` (${report.projectId})` : ""}`,
    `- Hallazgos: ${report.counts.critical} critical, ${report.counts.warning} warning, ${report.counts.info} info`,
    `- Workspace: ${report.platform.projectsRoot || "sin datos"}`,
    `- Host mirror configurado: ${report.platform.hostMirrorConfigured ? "si" : "no"}`,
    "",
    "## Servicios de plataforma",
    ...report.platform.services.map((service) => `- ${service.required ? "requerido" : "opcional"} ${service.name}: ${service.status} (${service.profile || "sin perfil"})${service.evidence ? ` - ${service.evidence}` : ""}`),
    "",
    "## Proyectos",
    ...report.projectSummaries.flatMap((project) => [
      `### ${project.displayName} (${project.slug})`,
      `- Ruta: ${project.repositoryPath}`,
      `- Git: ${project.git?.isGit === false ? "no detectado" : `${project.git.branch || "sin branch"} @ ${project.git.commit || "sin commit"} · dirty=${project.git.dirty ? "si" : "no"} · cambios=${project.git.changes || 0}`}`,
      `- Runtime: ${project.runtime.label || project.runtime.status || "sin datos"} · freshness=${project.runtime.freshness || "sin datos"} · recursos=${project.runtime.resources} · puertos=${project.runtime.ports}`,
      `- Calidad: gate=${project.quality.qualityGate || "sin snapshot"} · sonarKey=${project.quality.sonarProjectKey || "sin key"} · ultimoAnalisis=${project.quality.analysisTimestamp || "sin datos"}`,
      `- Ultimo job: ${project.latestJob ? `${project.latestJob.action} ${project.latestJob.status}${project.latestJob.failureStage ? ` en ${project.latestJob.failureStage}` : ""}` : "sin ejecuciones"}`
    ]),
    "",
    "## Hallazgos priorizados",
    ...report.items.map((item, index) => [
      `${index + 1}. [${item.severity.toUpperCase()}] ${item.projectSlug || "platform"} · ${item.category} · ${item.title}`,
      `   - Detalle: ${item.detail || "sin detalle"}`,
      `   - Evidencia: ${item.evidence || "sin evidencia"}`,
      `   - Accion sugerida: ${item.suggestedAction || "analizar y proponer correccion"}`,
      item.targetTab ? `   - Donde revisar en el hub: ${item.targetTab}` : ""
    ].filter(Boolean).join("\n")),
    "",
    "## Checklist de aceptacion",
    "- Reproducir o confirmar cada fallo antes de modificar.",
    "- Implementar correcciones acotadas y documentar cualquier configuracion nueva.",
    "- Ejecutar checks del hub: npm run check y npm test.",
    "- Ejecutar checks/smoke especificos de cada proyecto afectado.",
    "- Confirmar que los CTAs del hub abren el tab correcto y que los errores quedan explicados con accion concreta.",
    "- Dejar el prompt/report actualizado despues de las correcciones."
  ];
  return sanitizeText(lines.join("\n"));
}

function categoryFromDoctorCode(code) {
  const value = String(code || "").toUpperCase();
  if (/RUNTIME|DOCKER|COMPOSE/.test(value)) return "runtime";
  if (/JENKINS|CI/.test(value)) return "ci";
  if (/SONAR|COVERAGE|QUALITY/.test(value)) return "quality";
  if (/GIT|REPO/.test(value)) return "source-control";
  if (/OTEL|PROMETHEUS|LOKI|TEMPO|ALERT/.test(value)) return "observability";
  return "configuration";
}

function actionFromDoctorCode(code) {
  const category = categoryFromDoctorCode(code);
  if (category === "runtime") return "Revisar scripts locales aprobados, Docker y perfiles start/stop/status/logs.";
  if (category === "ci") return "Agregar o corregir Jenkinsfile y validar multibranch job.";
  if (category === "quality") return "Completar configuracion Sonar/cobertura y ejecutar analisis.";
  if (category === "source-control") return "Corregir remoto Git, branch o metadata del repositorio.";
  if (category === "observability") return "Levantar perfiles de observabilidad o instrumentar health/metrics/logs/traces.";
  return "Completar la configuracion faltante desde el panel del proyecto.";
}

function fingerprintEvidence(runtime) {
  return [
    runtime.freshness?.status ? `freshness=${runtime.freshness.status}` : "",
    runtime.freshness?.current ? `current=${String(runtime.freshness.current).slice(0, 20)}` : "",
    runtime.freshness?.expected ? `expected=${String(runtime.freshness.expected).slice(0, 20)}` : "",
    runtime.sourceFingerprint?.short ? `source=${runtime.sourceFingerprint.short}` : ""
  ].filter(Boolean).join(" · ");
}

function jobFindingContext(job) {
  const failedStage = [...(job.stages || [])].reverse().find((stage) => stage.status === "FAILED");
  const failureOutput = job.summary?.failure?.output || failedStage?.summary || {};
  const categories = failureOutput.categories || [];
  const failureText = [
    job.error?.message,
    job.summary?.failure?.stage,
    failedStage?.name,
    ...(job.logs || []).slice(-40).map((entry) => entry.message)
  ].filter(Boolean).join("\n");
  const detectedCategory = classifyFailureLine(failureText);
  const firstCategory = detectedCategory !== "error" ? detectedCategory : categories[0]?.category || detectedCategory;
  const category = firstCategory === "sonar-auth" ? "quality" : ["lint", "typescript", "tests", "build"].includes(firstCategory) ? "quality" : "configuration";
  const stageName = failedStage?.name || job.summary?.failure?.stage || job.action;
  const evidence = [
    `job=${job.action}`,
    `status=${job.status}`,
    stageName ? `stage=${stageName}` : "",
    failureOutput.errors ? `errors=${failureOutput.errors}` : "",
    failureOutput.warnings ? `warnings=${failureOutput.warnings}` : "",
    ...(failureOutput.firstProblems || []).slice(0, 3)
  ].filter(Boolean).join(" · ");
  return {
    category,
    severity: ["sonar-auth", "native-deps"].includes(firstCategory) ? "warning" : "critical",
    title: job.status === "TIMED_OUT" ? `Timeout en ${stageName}` : `Ultima ejecucion fallo en ${stageName}`,
    detail: job.error?.message || `La ultima ejecucion ${job.action} termino en ${job.status}.`,
    evidence,
    suggestedAction: suggestedActionFromFailure(firstCategory),
    targetTab: ["sonar-auth", "native-deps"].includes(firstCategory) ? "configuration" : "executions"
  };
}

function suggestedActionFromFailure(category) {
  if (category === "sonar-auth") return "Revisar URL de SonarQube, credenciales cargadas y permisos del proyecto.";
  if (category === "native-deps") return "Corregir el entorno del runner: usar build Docker/runner aislado o instalar los optional native packages de Linux sin contaminar node_modules del host.";
  if (category === "lint") return "Abrir el resumen de lint, agrupar por reglas repetidas y corregir primero errores bloqueantes.";
  if (category === "typescript") return "Corregir errores TypeScript y validar build/test despues.";
  if (category === "tests") return "Ejecutar tests fallidos localmente, corregir fixtures o codigo y repetir smoke.";
  if (category === "build") return "Reproducir build, corregir compilacion/dependencias y reconstruir imagen si aplica.";
  return "Abrir la ejecucion, leer el resumen traducido y resolver la causa raiz.";
}

function projectActionLinks(project, providers = []) {
  const allowed = new Set(providers);
  return (project.toolLinks || [])
    .filter((link) => allowed.has(link.provider) && link.url)
    .slice(0, 4)
    .map((link) => ({ label: link.label, url: link.url }));
}

function addToolLinkFinding(findings, project, provider, category, title, suggestedAction) {
  const links = (project.toolLinks || []).filter((link) => link.provider === provider);
  if (!links.length) return;
  const ok = links.some((link) => link.status === "ok");
  if (ok) return;
  const failed = links.find((link) => ["failed", "missing"].includes(link.status));
  const blocked = links.find((link) => link.status === "blocked");
  const status = failed?.status || blocked?.status || "unknown";
  findings.push({
    severity: failed ? "warning" : "info",
    category,
    project,
    title,
    detail: failed?.hint || blocked?.hint || links[0].hint || suggestedAction,
    evidence: `${provider} status=${status}`,
    suggestedAction,
    targetTab: category === "ci" ? "configuration" : "quality",
    source: "project/toolLinks",
    links: links.filter((link) => link.url).slice(0, 4).map((link) => ({ label: link.label, url: link.url }))
  });
}

async function checkJson(name, url, metadata = {}) {
  try {
    const data = name === "sonarqube" ? await sonarFetch("/api/system/status") : await fetchJson(url);
    return { name, status: "UP", url: publicToolUrl(name), data, ...metadata };
  } catch (error) {
    return { name, status: "DOWN", url: publicToolUrl(name), error: sanitizeText(error.message), ...metadata };
  }
}

async function checkText(name, url, metadata = {}) {
  const result = await fetchText(url);
  const details = result.ok
    ? (name === "web" ? "Web UI responde." : "Ready endpoint responded.")
    : (result.status ? `HTTP ${result.status}` : sanitizeText(result.text).slice(0, 80));
  return {
    name,
    status: result.ok ? "UP" : "DOWN",
    url: publicToolUrl(name),
    details,
    ...metadata
  };
}

function publicToolUrl(name) {
  const publicUrls = {
    "control-api": "http://localhost:18080",
    web: "http://localhost:18000",
    sonarqube: sonarHostUrl.replace("host.docker.internal", "localhost"),
    jenkins: jenkinsUrl.replace("host.docker.internal", "localhost"),
    prometheus: "http://localhost:19090",
    loki: "http://localhost:13100",
    tempo: "http://localhost:13200",
    alertmanager: "http://localhost:19093",
    grafana: "http://localhost:13000"
  };
  return publicUrls[name] || "";
}

function observabilityStatus({ backendUp = false, configured = false, verified = false, partial = false, error = "" } = {}) {
  if (verified) return "CONFIGURED_AND_VERIFIED";
  if (error) return "ERROR";
  if (!configured) return "NOT_CONFIGURED";
  if (!backendUp) return "ERROR";
  if (partial) return "PARTIALLY_CONFIGURED";
  return "CONFIGURED_NOT_VERIFIED";
}

function publicGrafanaUrl(pathname = "", params = {}) {
  const url = new URL(publicToolUrl("grafana") || grafanaUrl);
  url.pathname = pathname;
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function grafanaProjectDashboardUrl(project) {
  return publicGrafanaUrl("/d/quality-hub-project-observability/project-observability", {
    orgId: "1",
    "var-project": project.slug,
    "var-environment": "local"
  });
}

function grafanaExploreUrl(datasource, query) {
  const encoded = JSON.stringify({
    datasource,
    queries: [{ refId: "A", datasource: { uid: datasource }, expr: query, query }],
    range: { from: "now-1h", to: "now" }
  });
  return publicGrafanaUrl("/explore", { orgId: "1", left: encoded });
}

function prometheusGraphUrl(query) {
  const url = new URL(publicToolUrl("prometheus") || prometheusUrl);
  url.pathname = "/graph";
  url.searchParams.set("g0.expr", query);
  url.searchParams.set("g0.tab", "1");
  url.searchParams.set("g0.range_input", "1h");
  return url.toString();
}

async function prometheusInstantQuery(query) {
  const started = Date.now();
  try {
    const data = await fetchJson(`${prometheusUrl}/api/v1/query?${new URLSearchParams({ query })}`, { timeoutMs: 4000 });
    const result = data?.data?.result || [];
    return {
      ok: data.status === "success",
      query,
      resultType: data?.data?.resultType || "",
      sampleCount: Array.isArray(result) ? result.length : 0,
      durationMs: Date.now() - started,
      result: Array.isArray(result) ? result.slice(0, 12).map(sanitizePrometheusSample) : []
    };
  } catch (error) {
    return {
      ok: false,
      query,
      sampleCount: 0,
      durationMs: Date.now() - started,
      error: sanitizeText(error.message)
    };
  }
}

function sanitizePrometheusSample(sample) {
  return {
    metric: sanitizeMetadata(sample.metric || {}),
    value: Array.isArray(sample.value) ? [sample.value[0], sanitizeText(sample.value[1])] : []
  };
}

async function prometheusTargets() {
  try {
    const data = await fetchJson(`${prometheusUrl}/api/v1/targets?state=active`, { timeoutMs: 4000 });
    const targets = data?.data?.activeTargets || [];
    return targets.map((target) => ({
      health: sanitizeText(target.health || ""),
      job: sanitizeText(target.labels?.job || ""),
      project: sanitizeText(target.labels?.project || ""),
      scrapeUrl: sanitizeText(target.scrapeUrl || ""),
      lastScrape: sanitizeText(target.lastScrape || ""),
      lastError: sanitizeText(target.lastError || "")
    }));
  } catch {
    return [];
  }
}

async function prometheusRules() {
  try {
    const data = await fetchJson(`${prometheusUrl}/api/v1/rules`, { timeoutMs: 4000 });
    return (data?.data?.groups || []).flatMap((group) => (group.rules || []).map((rule) => ({
      group: sanitizeText(group.name || ""),
      name: sanitizeText(rule.name || ""),
      type: sanitizeText(rule.type || ""),
      state: sanitizeText(rule.state || ""),
      health: sanitizeText(rule.health || ""),
      query: sanitizeText(rule.query || "")
    })));
  } catch {
    return [];
  }
}

async function lokiInstantQuery(query) {
  const started = Date.now();
  try {
    const data = await fetchJson(`${lokiUrl}/loki/api/v1/query_range?${new URLSearchParams({ query, limit: "20", direction: "BACKWARD" })}`, { timeoutMs: 4000 });
    const result = data?.data?.result || [];
    return {
      ok: data.status === "success",
      query,
      streamCount: Array.isArray(result) ? result.length : 0,
      lineCount: Array.isArray(result) ? result.reduce((count, stream) => count + (stream.values?.length || 0), 0) : 0,
      durationMs: Date.now() - started,
      result: Array.isArray(result) ? result.slice(0, 6).map((stream) => ({
        labels: sanitizeMetadata(stream.stream || {}),
        values: (stream.values || []).slice(0, 3).map((value) => [value[0], sanitizeText(value[1])])
      })) : []
    };
  } catch (error) {
    return {
      ok: false,
      query,
      streamCount: 0,
      lineCount: 0,
      durationMs: Date.now() - started,
      error: sanitizeText(error.message)
    };
  }
}

async function tempoServiceSearch(serviceName) {
  const started = Date.now();
  const tags = `service.name=${serviceName}`;
  try {
    const data = await fetchJson(`${tempoUrl}/api/search?${new URLSearchParams({ tags, limit: "20" })}`, { timeoutMs: 5000 });
    const traces = data?.traces || [];
    return {
      ok: true,
      tags,
      traceCount: Array.isArray(traces) ? traces.length : 0,
      durationMs: Date.now() - started,
      traces: Array.isArray(traces) ? traces.slice(0, 8).map((trace) => ({
        traceID: sanitizeText(trace.traceID || trace.traceId || ""),
        rootServiceName: sanitizeText(trace.rootServiceName || ""),
        rootTraceName: sanitizeText(trace.rootTraceName || ""),
        startTimeUnixNano: sanitizeText(trace.startTimeUnixNano || "")
      })) : []
    };
  } catch (error) {
    return {
      ok: false,
      tags,
      traceCount: 0,
      durationMs: Date.now() - started,
      error: sanitizeText(error.message)
    };
  }
}

async function alertmanagerAlertsForProject(project) {
  try {
    const alerts = await fetchJson(`${alertmanagerUrl}/api/v2/alerts`, { timeoutMs: 4000 });
    return Array.isArray(alerts)
      ? alerts
        .filter((alert) => alert.labels?.project === project.slug || alert.labels?.project === "platform")
        .map((alert) => ({
          status: sanitizeText(alert.status?.state || ""),
          labels: sanitizeMetadata(alert.labels || {}),
          annotations: sanitizeMetadata(alert.annotations || {}),
          startsAt: sanitizeText(alert.startsAt || ""),
          endsAt: sanitizeText(alert.endsAt || "")
        }))
      : [];
  } catch {
    return [];
  }
}

function serviceStatus(platform, name) {
  return platform.services.find((service) => service.name === name) || { name, status: "DOWN", required: false };
}

function serviceIsUp(platform, name) {
  return serviceStatus(platform, name).status === "UP";
}

function hasObservabilityInstrumentation(instrumentation = {}, signal) {
  return Array.isArray(instrumentation[signal]) && instrumentation[signal].length > 0;
}

function observabilityEvidence(text, extra = {}) {
  return {
    checkedAt: nowIso(),
    detail: sanitizeText(text || ""),
    ...extra
  };
}

async function platformObservabilityOverview() {
  const platform = await platformStatus();
  const [targets, rules, alerts] = await Promise.all([
    serviceIsUp(platform, "prometheus") ? prometheusTargets() : Promise.resolve([]),
    serviceIsUp(platform, "prometheus") ? prometheusRules() : Promise.resolve([]),
    serviceIsUp(platform, "alertmanager") ? fetchJson(`${alertmanagerUrl}/api/v2/alerts`, { timeoutMs: 4000 }).catch(() => []) : Promise.resolve([])
  ]);
  return {
    generatedAt: nowIso(),
    environment: "local",
    services: platform.services
      .filter((service) => ["prometheus", "grafana", "loki", "tempo", "alertmanager"].includes(service.name))
      .map((service) => ({
        name: service.name,
        profile: service.profile,
        status: service.status === "UP" ? "CONFIGURED_AND_VERIFIED" : "ERROR",
        url: service.url,
        evidence: service.status === "UP" ? "ready endpoint responded" : service.error || "service is down"
      })),
    prometheus: {
      status: serviceIsUp(platform, "prometheus") ? "CONFIGURED_AND_VERIFIED" : "ERROR",
      targets,
      rules
    },
    alertmanager: {
      status: serviceIsUp(platform, "alertmanager") ? "CONFIGURED_AND_VERIFIED" : "ERROR",
      alerts: Array.isArray(alerts) ? alerts.length : 0
    },
    dashboards: [
      {
        name: "Quality Hub Overview",
        provider: "grafana",
        status: serviceIsUp(platform, "grafana") ? "CONFIGURED_AND_VERIFIED" : "ERROR",
        url: publicGrafanaUrl("/d/quality-hub-overview/quality-hub-overview", { orgId: "1" })
      },
      {
        name: "Project Observability",
        provider: "grafana",
        status: serviceIsUp(platform, "grafana") ? "CONFIGURED_AND_VERIFIED" : "ERROR",
        url: publicGrafanaUrl("/d/quality-hub-project-observability/project-observability", { orgId: "1" })
      }
    ]
  };
}

async function observabilityOverview(project) {
  const [platform, discovered, runtime] = await Promise.all([
    platformStatus(),
    discoverRepository(project.repositoryPath).catch(() => ({ instrumentation: {}, manifests: [] })),
    localRuntimeSummary(project).catch(() => ({ status: "unavailable", resources: [], ports: [], logLines: 0 }))
  ]);
  const instrumentation = discovered.instrumentation || {};
  const localEnvironment = state.environments.find((environment) => environment.projectId === project.id && environment.name === "local") || defaultLocalEnvironment(project.id, project.slug);
  const metricQuery = `up{project="${project.slug}"}`;
  const probeQuery = `probe_success{project="${project.slug}"}`;
  const logQuery = `{project="${project.slug}", environment="local"}`;
  const serviceName = localEnvironment.tempoServiceName || project.slug;
  const [metricResult, probeResult, logResult, traceResult, alerts] = await Promise.all([
    serviceIsUp(platform, "prometheus") ? prometheusInstantQuery(metricQuery) : Promise.resolve({ ok: false, query: metricQuery, sampleCount: 0, error: "Prometheus is down." }),
    serviceIsUp(platform, "prometheus") ? prometheusInstantQuery(probeQuery) : Promise.resolve({ ok: false, query: probeQuery, sampleCount: 0, error: "Prometheus is down." }),
    serviceIsUp(platform, "loki") ? lokiInstantQuery(logQuery) : Promise.resolve({ ok: false, query: logQuery, streamCount: 0, lineCount: 0, error: "Loki is down." }),
    serviceIsUp(platform, "tempo") ? tempoServiceSearch(serviceName) : Promise.resolve({ ok: false, tags: `service.name=${serviceName}`, traceCount: 0, error: "Tempo is down." }),
    serviceIsUp(platform, "alertmanager") ? alertmanagerAlertsForProject(project) : Promise.resolve([])
  ]);
  const metricsConfigured = Boolean(localEnvironment.metricsUrl || hasObservabilityInstrumentation(instrumentation, "metrics"));
  const healthConfigured = Boolean(localEnvironment.healthUrl || hasObservabilityInstrumentation(instrumentation, "health"));
  const logsConfigured = hasObservabilityInstrumentation(instrumentation, "logs");
  const tracesConfigured = hasObservabilityInstrumentation(instrumentation, "traces");
  const metricsVerified = metricResult.sampleCount > 0 || probeResult.sampleCount > 0;
  const logsVerified = logResult.lineCount > 0 || Number(runtime.logLines || 0) > 0;
  const tracesVerified = traceResult.traceCount > 0;
  const activeAlerts = alerts.filter((alert) => alert.status === "active");
  return {
    generatedAt: nowIso(),
    projectSlug: project.slug,
    environment: "local",
    status: ["prometheus", "grafana", "loki", "tempo", "alertmanager"].some((name) => serviceIsUp(platform, name)) ? "RUNNING" : "UNKNOWN",
    metrics: {
      source: "prometheus",
      status: observabilityStatus({
        backendUp: serviceIsUp(platform, "prometheus"),
        configured: metricsConfigured || healthConfigured,
        verified: metricsVerified,
        partial: metricsConfigured || healthConfigured,
        error: serviceIsUp(platform, "prometheus") ? "" : metricResult.error
      }),
      query: metricQuery,
      probeQuery,
      sampleCount: metricResult.sampleCount,
      probeSampleCount: probeResult.sampleCount,
      summary: !serviceIsUp(platform, "prometheus")
        ? "Prometheus no esta disponible; las metricas del proyecto no pudieron verificarse."
        : metricsVerified
        ? "Prometheus encontro series para este proyecto."
        : metricsConfigured || healthConfigured
          ? "Hay instrumentacion o health declarado, pero Prometheus no devolvio muestras con project label."
          : "No hay metricas ni health checks configurados para este proyecto.",
      evidence: observabilityEvidence(metricResult.error || `samples=${metricResult.sampleCount}, probes=${probeResult.sampleCount}`),
      links: [
        { label: "Prometheus metric query", url: prometheusGraphUrl(metricQuery) },
        { label: "Grafana Prometheus explore", url: grafanaExploreUrl("Prometheus", metricQuery) }
      ]
    },
    logs: {
      source: "loki",
      status: observabilityStatus({
        backendUp: serviceIsUp(platform, "loki"),
        configured: logsConfigured,
        verified: logResult.lineCount > 0,
        partial: logsConfigured,
        error: serviceIsUp(platform, "loki") ? "" : logResult.error
      }),
      query: logQuery,
      streamCount: logResult.streamCount,
      lineCount: logResult.lineCount,
      localRuntimeLogLines: Number(runtime.logLines || 0),
      summary: !serviceIsUp(platform, "loki")
        ? "Loki no esta disponible; los logs centralizados no pudieron verificarse."
        : logResult.lineCount > 0
        ? "Loki devolvio logs centralizados para este proyecto."
        : logsConfigured
          ? "Hay logging estructurado detectado, pero Loki no tiene streams con esos labels."
          : "No hay ingesta Loki configurada para este proyecto.",
      evidence: observabilityEvidence(logResult.error || `streams=${logResult.streamCount}, lines=${logResult.lineCount}, localRuntimeLogLines=${runtime.logLines || 0}`),
      links: [
        { label: "Grafana Loki explore", url: grafanaExploreUrl("Loki", logQuery) }
      ]
    },
    traces: {
      source: "tempo",
      status: observabilityStatus({
        backendUp: serviceIsUp(platform, "tempo"),
        configured: tracesConfigured,
        verified: tracesVerified,
        partial: tracesConfigured,
        error: serviceIsUp(platform, "tempo") ? "" : traceResult.error
      }),
      serviceName,
      query: traceResult.tags,
      traceCount: traceResult.traceCount,
      summary: !serviceIsUp(platform, "tempo")
        ? "Tempo no esta disponible; las trazas no pudieron verificarse."
        : tracesVerified
        ? "Tempo encontro trazas para el service.name del proyecto."
        : tracesConfigured
          ? "Hay dependencias OpenTelemetry detectadas, pero Tempo no devolvio trazas."
          : "No hay tracing configurado para este proyecto.",
      evidence: observabilityEvidence(traceResult.error || `traces=${traceResult.traceCount}`),
      links: [
        { label: "Grafana Tempo explore", url: grafanaExploreUrl("Tempo", `{service.name=\"${serviceName}\"}`) }
      ]
    },
    alerts: {
      source: "alertmanager",
      status: observabilityStatus({
        backendUp: serviceIsUp(platform, "alertmanager"),
        configured: true,
        verified: serviceIsUp(platform, "alertmanager"),
        error: serviceIsUp(platform, "alertmanager") ? "" : "Alertmanager is down."
      }),
      active: activeAlerts.length,
      total: alerts.length,
      items: alerts,
      links: [
        { label: "Alertmanager", url: publicToolUrl("alertmanager") }
      ]
    },
    dashboards: [
      {
        name: "Project Observability",
        provider: "grafana",
        status: observabilityStatus({
          backendUp: serviceIsUp(platform, "grafana"),
          configured: true,
          verified: serviceIsUp(platform, "grafana"),
          error: serviceIsUp(platform, "grafana") ? "" : "Grafana is down."
        }),
        url: grafanaProjectDashboardUrl(project)
      },
      {
        name: "Prometheus expression",
        provider: "prometheus",
        status: serviceIsUp(platform, "prometheus") ? "CONFIGURED_AND_VERIFIED" : "ERROR",
        url: prometheusGraphUrl(metricQuery)
      }
    ],
    instrumentation,
    services: ["prometheus", "grafana", "loki", "tempo", "alertmanager"].map((name) => {
      const service = serviceStatus(platform, name);
      return {
        name,
        profile: service.profile || "",
        status: service.status === "UP" ? "CONFIGURED_AND_VERIFIED" : "ERROR",
        evidence: service.status === "UP" ? "ready endpoint responded" : service.error || "service down",
        url: service.url || publicToolUrl(name)
      };
    }),
    gaps: [
      metricsVerified || metricsConfigured || healthConfigured ? null : "Metricas/health no configurados para project label.",
      logResult.lineCount > 0 || logsConfigured ? null : "Logs Loki no configurados para project/environment labels.",
      tracesVerified || tracesConfigured ? null : "Traces Tempo no configuradas para service.name.",
      serviceIsUp(platform, "grafana") ? null : "Grafana apagado; dashboard no verificable."
    ].filter(Boolean).map((message) => ({ severity: "warning", message }))
  };
}

function problem(status, code, detail) {
  const error = new Error(detail);
  error.status = status;
  error.code = code;
  error.type = `https://quality-hub.local/problems/${code.toLowerCase()}`;
  return error;
}

async function requestBody(req) {
  const declaredLength = Number(req.headers["content-length"] || 0);
  if (declaredLength > securityConfig.bodyLimitBytes) {
    throw problem(413, "PAYLOAD_TOO_LARGE", "Request body exceeds the configured limit.");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > securityConfig.bodyLimitBytes) {
      throw problem(413, "PAYLOAD_TOO_LARGE", "Request body exceeds the configured limit.");
    }
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks, size).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw problem(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
}

function send(res, status, body, headers = {}) {
  const payload = body === undefined ? "" : JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(payload);
}

function sendText(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(body);
}

function prometheusMetrics() {
  const byStatus = state.jobs.reduce((acc, job) => {
    acc[job.status] = (acc[job.status] || 0) + 1;
    return acc;
  }, {});
  const lines = [
    "# HELP quality_hub_projects_total Registered projects.",
    "# TYPE quality_hub_projects_total gauge",
    `quality_hub_projects_total ${state.projects.length}`,
    "# HELP quality_hub_jobs_total Jobs by status.",
    "# TYPE quality_hub_jobs_total gauge"
  ];
  for (const [status, count] of Object.entries(byStatus)) {
    lines.push(`quality_hub_jobs_total{status="${status}"} ${count}`);
  }
  lines.push("# HELP quality_hub_running_jobs Running jobs.");
  lines.push("# TYPE quality_hub_running_jobs gauge");
  lines.push(`quality_hub_running_jobs ${runningJobs.size}`);
  lines.push("# HELP quality_hub_quality_snapshots_total Imported quality snapshots.");
  lines.push("# TYPE quality_hub_quality_snapshots_total gauge");
  lines.push(`quality_hub_quality_snapshots_total ${state.qualitySnapshots.length}`);
  return `${lines.join("\n")}\n`;
}

function sendProblem(res, req, error) {
  const status = error.status || 500;
  const headers = { "Content-Type": "application/problem+json; charset=utf-8" };
  if (error.retryAfterSeconds) headers["Retry-After"] = String(error.retryAfterSeconds);
  let instance = "/";
  try {
    instance = new URL(req.url, "http://localhost").pathname;
  } catch {
    instance = "/";
  }
  send(res, status, {
    type: error.type || "about:blank",
    title: error.code || "INTERNAL_ERROR",
    status,
    detail: sanitizeText(error.message || "Unexpected error."),
    instance,
    correlationId: req.correlationId
  }, headers);
}

async function serveStatic(req, res, pathname) {
  const webRoot = path.resolve(repoRoot, "apps/web");
  const target = pathname === "/" ? path.join(webRoot, "index.html") : path.resolve(webRoot, `.${pathname}`);
  if (!(target === webRoot || target.startsWith(`${webRoot}${path.sep}`))) {
    sendProblem(res, req, problem(403, "STATIC_PATH_ESCAPE", "Invalid static path."));
    return;
  }
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error("not file");
    const ext = path.extname(target);
    const contentTypes = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml"
    };
    res.writeHead(200, { "Content-Type": contentTypes[ext] || "application/octet-stream" });
    fsSync.createReadStream(target).pipe(res);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

async function handleRoute(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split("/").filter(Boolean);

  try {
    if (url.pathname === "/healthz") {
      send(res, 200, { status: "UP", timestamp: nowIso() });
      return;
    }
    if (url.pathname === "/metrics") {
      sendText(res, 200, prometheusMetrics());
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      await serveStatic(req, res, url.pathname);
      return;
    }
    if (parts[0] !== "api" || parts[1] !== "v1") {
      throw problem(404, "API_NOT_FOUND", "API route not found.");
    }

    if (req.method === "GET" && parts[2] === "security" && parts[3] === "session") {
      const principal = req.securityPrincipal;
      send(res, 200, {
        authentication: securityConfig.authConfigured ? "CONFIGURED" : "READ_ONLY",
        actor: principal.authenticated ? principal.actor : "anonymous",
        role: principal.role,
        authenticated: principal.authenticated,
        privilegedExecution: securityConfig.privilegedExecutionEnabled ? "ENABLED_LOCAL" : "DISABLED",
        projectTrust: Object.values(PROJECT_TRUST),
        bodyLimitBytes: securityConfig.bodyLimitBytes,
        allowedOrigins: [...securityConfig.allowedOrigins]
      });
      return;
    }

    if (req.method === "GET" && parts[2] === "platform" && parts[3] === "status") {
      send(res, 200, await platformStatus());
      return;
    }

    if (req.method === "GET" && parts[2] === "catalog" && parts[3] === "descriptor") {
      const catalog = await loadCatalogDescriptor();
      send(res, 200, {
        status: catalog.status,
        path: catalog.path,
        generatedAt: catalog.generatedAt || nowIso(),
        error: catalog.error || "",
        descriptor: catalog.descriptor
      });
      return;
    }

    if (req.method === "GET" && parts[2] === "improvements" && parts.length === 3) {
      send(res, 200, await buildImprovementReport({
        scope: url.searchParams.get("scope") || "all",
        projectId: url.searchParams.get("projectId") || ""
      }));
      return;
    }

    if (req.method === "GET" && parts[2] === "docs" && parts[3] === "overview") {
      send(res, 200, await platformLivingDocsOverview());
      return;
    }

    if (req.method === "GET" && parts[2] === "observability" && parts[3] === "overview") {
      send(res, 200, await platformObservabilityOverview());
      return;
    }

    if (req.method === "GET" && parts[2] === "quality-security" && parts[3] === "overview") {
      send(res, 200, await platformQualitySecurityOverview());
      return;
    }

    if (req.method === "GET" && parts[2] === "infrastructure" && parts[3] === "overview") {
      send(res, 200, await platformInfrastructureOverview());
      return;
    }

    if (req.method === "GET" && parts[2] === "infrastructure" && parts[3] === "adapters") {
      send(res, 200, await platformInfrastructureAdapterRegistry());
      return;
    }

    if (req.method === "GET" && parts[2] === "deployments" && parts[3] === "overview") {
      send(res, 200, await platformDeploymentsOverview());
      return;
    }

    if (req.method === "GET" && parts[2] === "testing" && parts[3] === "overview") {
      send(res, 200, await platformTestingOverview());
      return;
    }

    if (parts[2] === "agents") {
      if (req.method === "GET" && parts[3] === "overview") {
        send(res, 200, await agentsOverview());
        return;
      }
      if (req.method === "POST" && parts[3] === "heartbeat") {
        const body = await requestBody(req);
        send(res, 200, await recordLocalAgentHeartbeat(body, req.correlationId));
        return;
      }
      if (req.method === "POST" && parts[3] === "discovery" && parts[4] === "refresh") {
        const body = await requestBody(req);
        send(res, 200, await refreshLocalAgentDiscovery(body, req.correlationId));
        return;
      }
    }

    if (parts[2] === "runtime") {
      if (req.method === "POST" && ["start-all", "stop-all", "restart-all", "smoke-all", "start-fresh-all", "restart-fresh-all", "rebuild-changed-all", "clean-rebuild-all", "pull-rebuild-all"].includes(parts[3])) {
        const action = parts[3].replace(/-all$/, "");
        send(res, 202, await triggerBulkRuntimeAction(action));
        return;
      }
      if (req.method === "GET" && parts[3] === "bulk" && parts[4]) {
        const operation = localRuntimeBulkOperations.get(parts[4]);
        if (!operation) throw problem(404, "BULK_RUNTIME_NOT_FOUND", "Bulk runtime operation not found.");
        send(res, 200, bulkOperationSnapshot(operation));
        return;
      }
    }

    if (req.method === "GET" && parts[2] === "versions" && parts[3] === "overview") {
      send(res, 200, await platformVersionsOverview());
      return;
    }

    if (req.method === "GET" && parts[2] === "projects" && parts.length === 3) {
      const catalog = await loadCatalogDescriptor();
      const details = await Promise.all(state.projects.map((project) => projectDetails(project, catalog)));
      send(res, 200, { items: details, total: details.length });
      return;
    }

    if (req.method === "POST" && parts[2] === "projects" && parts[3] === "discover") {
      const body = await requestBody(req);
      const discovered = await discoverRepository(body.repositoryPath);
      send(res, 200, discovered);
      return;
    }

    if (req.method === "POST" && parts[2] === "projects" && parts.length === 3) {
      const body = await requestBody(req);
      const repositoryPath = String(body.repositoryPath || "").trim();
      const discovered = await discoverRepository(repositoryPath);
      const slug = slugify(body.slug || path.basename(repositoryPath));
      if (!slug) throw problem(400, "INVALID_SLUG", "slug is required.");
      if (state.projects.some((project) => project.slug === slug)) throw problem(409, "PROJECT_EXISTS", "Project slug already exists.");
      const project = {
        id: crypto.randomUUID(),
        slug,
        displayName: body.displayName || slug,
        description: body.description || "",
        repositoryPath,
        detectedStack: discovered.detectedStack,
        sonarProjectKey: body.sonarProjectKey || slug,
        defaultBranch: body.defaultBranch || discovered.git?.branch || "main",
        runtimeConfig: normalizeRuntimeConfig(body.runtimeConfig || {}),
        trust: PROJECT_TRUST.UNTRUSTED,
        status: "ACTIVE",
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      state.projects.push(project);
      state.environments.push(defaultLocalEnvironment(project.id, project.slug));
      state.localRuntimes[project.id] = defaultLocalRuntime(project.id, project.slug);
      await appendAudit("project.create", project.slug, "SUCCEEDED", { correlationId: req.correlationId });
      send(res, 201, await projectDetails(project));
      return;
    }

    if (parts[2] === "projects" && parts[3]) {
      const project = findProjectOrThrow(parts[3]);

      if (req.method === "GET" && parts.length === 4) {
        send(res, 200, await projectDetails(project));
        return;
      }
      if (req.method === "PATCH" && parts.length === 4) {
        const body = await requestBody(req);
        let shouldClearLinkValidation = false;
        for (const key of ["displayName", "description", "defaultBranch", "sonarProjectKey"]) {
          if (body[key] !== undefined) {
            if (["defaultBranch", "sonarProjectKey"].includes(key) && project[key] !== body[key]) shouldClearLinkValidation = true;
            project[key] = body[key];
          }
        }
        if (body.repositoryPath !== undefined) {
          await discoverRepository(body.repositoryPath);
          if (project.repositoryPath !== body.repositoryPath) shouldClearLinkValidation = true;
          project.repositoryPath = body.repositoryPath;
        }
        if (body.runtimeConfig !== undefined) {
          const previousRuntimeConfig = JSON.stringify(project.runtimeConfig || {});
          project.runtimeConfig = normalizeRuntimeConfig(body.runtimeConfig, project.runtimeConfig);
          if (previousRuntimeConfig !== JSON.stringify(project.runtimeConfig || {})) shouldClearLinkValidation = true;
        }
        if (body.trust !== undefined) {
          project.trust = normalizeProjectTrust(body.trust);
        }
        if (shouldClearLinkValidation && state.linkValidations) delete state.linkValidations[project.id];
        project.updatedAt = nowIso();
        await appendAudit("project.patch", project.slug, "SUCCEEDED", { correlationId: req.correlationId });
        send(res, 200, await projectDetails(project));
        return;
      }
      if (req.method === "GET" && parts[4] === "environments") {
        send(res, 200, { items: state.environments.filter((env) => env.projectId === project.id) });
        return;
      }
      if (parts[4] === "git" && (req.method === "GET" || req.method === "POST")) {
        const abs = await canonicalProjectPath(project.repositoryPath);
        const git = await gitInfo(abs);
        send(res, 200, { project: project.slug, git: publicGitStatus(git) });
        return;
      }
      if (req.method === "GET" && parts[4] === "freshness") {
        const runtime = await localRuntimeSummary(project);
        send(res, 200, {
          project: project.slug,
          status: runtime.status,
          freshness: runtime.freshness,
          sourceFingerprint: runtime.sourceFingerprint,
          lastDeployment: runtime.lastDeployment,
          git: runtime.git
        });
        return;
      }
      if (req.method === "GET" && parts[4] === "local-state") {
        const catalog = await loadCatalogDescriptor();
        const descriptorProject = descriptorProjectFor(catalog, project);
        const discovered = await discoverRepository(project.repositoryPath).catch((error) => ({
          exists: false,
          detectedStack: project.detectedStack || [],
          doctor: [{ level: "error", code: "DISCOVERY_FAILED", message: error.message }],
          approvedCommands: [],
          components: [],
          manifests: [],
          hasDocker: false
        }));
        const runtime = await localRuntimeSummary(project, discovered);
        send(res, 200, {
          project: project.slug,
          localState: buildLocalState(project, catalog, descriptorProject, discovered, runtime)
        });
        return;
      }
      if (req.method === "GET" && parts[4] === "runtime-identity") {
        const runtime = await localRuntimeSummary(project);
        send(res, 200, {
          project: project.slug,
          environment: "local",
          runtimeIdentity: {
            git: runtime.git,
            sourceFingerprint: runtime.sourceFingerprint,
            lastDeployment: runtime.lastDeployment,
            freshness: runtime.freshness,
            resources: runtime.resources
          }
        });
        return;
      }
      if (parts[4] === "versions") {
        if (req.method === "GET" && parts[5] === "overview") {
          send(res, 200, await projectVersionOverview(project));
          return;
        }
        if (req.method === "GET" && parts[5] === "changes") {
          send(res, 200, await projectRuntimeChanges(project));
          return;
        }
      }
      if (req.method === "GET" && parts[4] === "links") {
        const discovered = await discoverRepository(project.repositoryPath).catch(() => null);
        send(res, 200, {
          project: project.slug,
          generatedAt: state.linkValidations?.[project.id]?.generatedAt || "",
          items: applyStoredToolLinkValidation(project, projectToolLinks(project, discovered?.git || null))
        });
        return;
      }
      if (req.method === "POST" && parts[4] === "links" && parts[5] === "validate") {
        send(res, 200, await validateProjectToolLinks(project));
        return;
      }
      if (parts[4] === "docs") {
        if (req.method === "GET" && parts[5] === "overview") {
          send(res, 200, await projectLivingDocsOverview(project));
          return;
        }
        if (req.method === "GET" && parts[5] === "documents") {
          const report = await projectLivingDocsOverview(project, { includeMarkdown: false });
          send(res, 200, {
            project: project.slug,
            phase: report.phase,
            contract: report.contract,
            generatedAt: report.generatedAt,
            documents: report.documents,
            requiredSections: report.requiredSections,
            unverifiedSections: report.unverifiedSections,
            officialDocs: report.officialDocs,
            counts: {
              documents: report.counts.documents,
              requiredSections: report.counts.requiredSections,
              verifiedSections: report.counts.verifiedSections,
              unverifiedSections: report.counts.unverifiedSections
            }
          });
          return;
        }
        if (req.method === "POST" && parts[5] === "snapshot") {
          const body = await requestBody(req);
          send(res, 201, await createLivingDocsSnapshot(project, body, req.correlationId));
          return;
        }
      }
      if (parts[4] === "runtime") {
        if (req.method === "GET" && parts.length === 5) {
          send(res, 200, await localRuntimeSummary(project));
          return;
        }
        if (req.method === "GET" && parts[5] === "changes") {
          send(res, 200, await projectRuntimeChanges(project));
          return;
        }
        if (req.method === "POST" && allowedRuntimeRequestActions.has(parts[5])) {
          send(res, 202, await triggerLocalRuntimeAction(project, parts[5]));
          return;
        }
        if (req.method === "POST" && parts[5] === "volumes" && parts[6] === "delete") {
          const body = await requestBody(req);
          send(res, 200, await deleteRuntimeVolumes(project, body, req.correlationId));
          return;
        }
        if (req.method === "GET" && parts[5] === "logs") {
          const tail = Number(url.searchParams.get("tail") || 240);
          send(res, 200, await localRuntimeLogs(project, tail));
          return;
        }
        if (req.method === "POST" && parts[5] === "logs" && parts[6] === "clear") {
          send(res, 200, await clearLocalRuntimeLogs(project));
          return;
        }
      }
      if (req.method === "POST" && parts[4] === "doctor") {
        const discovered = await discoverRepository(project.repositoryPath);
        send(res, 200, { project: project.slug, report: discovered.doctor, discovered });
        return;
      }
      if (req.method === "POST" && parts[4] === "executions") {
        const body = await requestBody(req);
        const action = body.action || "full";
        const idempotencyKey = req.headers["idempotency-key"] || body.idempotencyKey || null;
        const job = await createJob(project, action, idempotencyKey);
        send(res, 202, job);
        return;
      }
      if (req.method === "GET" && parts[4] === "executions") {
        send(res, 200, { items: state.jobs.filter((job) => job.projectId === project.id) });
        return;
      }
      if (req.method === "GET" && parts[4] === "quality" && parts[5] === "summary") {
        const snapshot = await importQualitySnapshot(project).catch(() => state.qualitySnapshots.find((item) => item.projectId === project.id) || null);
        send(res, 200, { project: project.slug, snapshot, links: sonarLinks(project) });
        return;
      }
      if (req.method === "GET" && parts[4] === "quality" && parts[5] === "history") {
        send(res, 200, { items: state.qualitySnapshots.filter((item) => item.projectId === project.id) });
        return;
      }
      if (req.method === "GET" && parts[4] === "quality" && parts[5] === "issues") {
        const issues = await sonarFetch(`/api/issues/search?componentKeys=${encodeURIComponent(project.sonarProjectKey)}&ps=100`, project).catch((error) => ({
          error: sanitizeText(error.message),
          issues: []
        }));
        send(res, 200, issues);
        return;
      }
      if (req.method === "GET" && parts[4] === "quality-security" && parts[5] === "overview") {
        send(res, 200, await qualitySecurityOverview(project));
        return;
      }
      if (req.method === "GET" && parts[4] === "infrastructure" && parts[5] === "overview") {
        send(res, 200, await infrastructureOverview(project));
        return;
      }
      if (parts[4] === "infrastructure" && parts[5] === "adapters" && req.method === "GET") {
        send(res, 200, await projectInfrastructureAdapterRegistry(project));
        return;
      }
      if (parts[4] === "infrastructure" && parts[5] === "refresh" && req.method === "POST") {
        const body = await requestBody(req);
        send(res, 200, await refreshInfrastructureDiscovery(project, body, req.correlationId));
        return;
      }
      if (parts[4] === "deployments") {
        if (req.method === "GET" && parts[5] === "overview") {
          send(res, 200, await deploymentsOverview(project));
          return;
        }
        if (req.method === "POST" && parts[5] === "plan") {
          const body = await requestBody(req);
          send(res, 201, await createDeploymentPlan(project, body, req.correlationId));
          return;
        }
        if (req.method === "POST" && parts[5] === "plans" && parts[6] && ["approve", "reject"].includes(parts[7])) {
          const body = await requestBody(req);
          const decision = parts[7] === "approve" ? "approve" : "reject";
          send(res, 200, await decideDeploymentApproval(project, parts[6], decision, body.reason || "", req.correlationId));
          return;
        }
        if (req.method === "POST" && parts[5] === "plans" && parts[6] && parts[7] === "apply") {
          send(res, 202, await applyDeploymentPlan(project, parts[6], req.correlationId));
          return;
        }
        if (req.method === "POST" && parts[5] === "verify") {
          const body = await requestBody(req);
          send(res, 200, await verifyDeployment(project, body, req.correlationId));
          return;
        }
        if (req.method === "POST" && parts[5] === "rollback") {
          const body = await requestBody(req);
          send(res, 202, await rollbackDeployment(project, body, req.correlationId));
          return;
        }
      }
      if (parts[4] === "testing") {
        if (req.method === "GET" && parts[5] === "overview") {
          send(res, 200, await testingOverview(project));
          return;
        }
        if (req.method === "GET" && parts[5] === "executions") {
          send(res, 200, {
            project: project.slug,
            items: state.jobs
              .filter((job) => job.projectId === project.id && testingJobActions.has(job.action))
              .map(publicTestExecution)
          });
          return;
        }
        if (req.method === "POST" && parts[5] === "executions") {
          const body = await requestBody(req);
          const idempotencyKey = req.headers["idempotency-key"] || body.idempotencyKey || null;
          send(res, 202, await createTestingExecution(project, body, idempotencyKey));
          return;
        }
      }
      if (req.method === "GET" && parts[4] === "observability" && parts[5] === "overview") {
        send(res, 200, await observabilityOverview(project));
        return;
      }
      if (req.method === "GET" && ["metrics", "logs", "traces", "alerts", "health"].includes(parts[4])) {
        send(res, 200, await observabilityOverview(project));
        return;
      }
    }

    if (parts[2] === "executions" && parts[3]) {
      const job = state.jobs.find((item) => item.id === parts[3]);
      if (!job) throw problem(404, "JOB_NOT_FOUND", "Execution job was not found.");
      if (req.method === "GET" && parts.length === 4) {
        send(res, 200, job);
        return;
      }
      if (req.method === "POST" && parts[4] === "cancel") {
        if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(job.status)) {
          throw problem(409, "JOB_ALREADY_TERMINAL", "The job is already in a terminal state.");
        }
        job.status = "CANCELLED";
        job.finishedAt = nowIso();
        job.updatedAt = nowIso();
        addLog(job, "warn", "Cancellation requested. Running child process termination is best-effort in MVP.");
        await appendAudit("execution.cancel", job.id, "CANCELLED", { correlationId: req.correlationId });
        await saveState();
        publishJob(job);
        send(res, 202, job);
        return;
      }
      if (req.method === "GET" && parts[4] === "events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
          "X-Correlation-ID": req.correlationId
        });
        res.write(`event: job\ndata: ${JSON.stringify(job)}\n\n`);
        const subscribers = jobSubscribers.get(job.id) || new Set();
        subscribers.add(res);
        jobSubscribers.set(job.id, subscribers);
        req.on("close", () => {
          subscribers.delete(res);
          if (!subscribers.size) jobSubscribers.delete(job.id);
        });
        return;
      }
    }

    throw problem(404, "ROUTE_NOT_FOUND", "Route not found.");
  } catch (error) {
    sendProblem(res, req, error);
  }
}

async function route(req, res) {
  const requestedId = String(req.headers["x-request-id"] || "");
  req.correlationId = /^[A-Za-z0-9._:-]{1,128}$/.test(requestedId) ? requestedId : correlationId();
  let corsOrigin = "";
  let principal = { actor: "anonymous", role: "READ", authenticated: false };
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    corsOrigin = evaluateCors(String(req.headers.origin || ""), securityConfig).origin;
    applySecurityHeaders(req, res, securityConfig, corsOrigin);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    const requiredRole = requiredRoleForRequest(req.method, url.pathname);
    if (requiredRole !== "READ") {
      const remoteAddress = req.socket?.remoteAddress || "unknown";
      checkMutationRateLimit(`${remoteAddress}:mutation`);
    }
    try {
      principal = authenticateRequest(req, securityConfig);
      const protectedRemoteRead = securityConfig.requireAuthForReads
        && (url.pathname.startsWith("/api/") || url.pathname === "/metrics");
      authorizeRequest(principal, requiredRole, { requireAuthentication: protectedRemoteRead });
    } catch (error) {
      if (state) {
        await requestContext.run({ principal }, () => appendAudit("security.authorization", url.pathname, "DENIED", {
          correlationId: req.correlationId,
          method: req.method,
          requiredRole,
          reason: error.code || "AUTHORIZATION_DENIED"
        }));
      }
      throw error;
    }
    req.securityPrincipal = principal;
    await requestContext.run({ principal }, async () => {
      await handleRoute(req, res);
      if (requiredRole !== "READ" && state) {
        await appendAudit("security.request", url.pathname, res.statusCode < 400 ? "SUCCEEDED" : "FAILED", {
          correlationId: req.correlationId,
          method: req.method,
          requiredRole,
          statusCode: res.statusCode
        });
      }
    });
  } catch (error) {
    if (!res.headersSent) {
      applySecurityHeaders(req, res, securityConfig, corsOrigin);
      sendProblem(res, req, error);
    } else {
      res.end();
    }
  }
}

await ensureDataStore();

const server = http.createServer(route);
server.on("error", (error) => {
  console.error(`Quality hub API failed to listen on ${host}:${port}: ${error.code || error.message}`);
  process.exit(1);
});
server.listen(port, host, () => {
  console.log(`Quality hub API listening on http://${host}:${port}`);
  console.log(`PROJECTS_ROOT=${sanitizeText(projectsRoot)}`);
  console.log(`HOST_PROJECTS_ROOT=${sanitizeText(hostProjectsRoot)}`);
  console.log(`SONAR_HOST_URL=${sonarHostUrl}`);
  console.log(`AUTHENTICATION=${securityConfig.authConfigured ? "configured" : "read-only"}`);
  console.log(`PRIVILEGED_EXECUTION=${securityConfig.privilegedExecutionEnabled ? "enabled-local" : "disabled"}`);
});
