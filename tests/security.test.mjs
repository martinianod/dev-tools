import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertProjectExecutionAllowed,
  authorizeRequest,
  createMutationRateLimiter,
  createSecurityConfig,
  fetchAllowedUpstream,
  redactStructured,
  requiredRoleForRequest
} from "../apps/control-api/security.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const authToken = "m0-test-token-that-is-longer-than-thirty-two-characters";
const allowedOrigin = "http://127.0.0.1:18000";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForApi(baseUrl, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Security test API exited with ${child.exitCode}.`);
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {
      // Startup is still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Security test API did not become ready.");
}

async function startHub({ heartbeatTtlMs } = {}) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-tools-m0-"));
  const projectsRoot = path.join(tempRoot, "projects");
  const dataDir = path.join(tempRoot, "data");
  await fs.mkdir(projectsRoot, { recursive: true });
  const port = await freePort();
  const child = spawn(process.execPath, ["apps/control-api/server.mjs"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HUB_API_HOST: "127.0.0.1",
      HUB_API_PORT: String(port),
      HUB_WEB_PORT: "18000",
      HUB_DATA_DIR: dataDir,
      PROJECTS_ROOT: projectsRoot,
      HOST_PROJECTS_ROOT: projectsRoot,
      HUB_AUTH_TOKEN: authToken,
      HUB_AUTH_ACTOR_ID: "m0-security-test",
      HUB_AUTH_ROLE: "ADMIN",
      HUB_ALLOWED_ORIGINS: allowedOrigin,
      HUB_REQUEST_BODY_LIMIT_BYTES: "1024",
      HUB_PRIVILEGED_EXECUTION_ENABLED: "0",
      HUB_RATE_LIMIT_MAX_MUTATIONS: "1000",
      HUB_UPSTREAM_TIMEOUT_MS: "100",
      ...(heartbeatTtlMs ? { LOCAL_AGENT_HEARTBEAT_TTL_MS: String(heartbeatTtlMs) } : {})
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { logs += chunk.toString(); });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForApi(baseUrl, child);
  } catch (error) {
    child.kill("SIGTERM");
    throw new Error(`${error.message}\n${logs.slice(-2000)}`);
  }
  return {
    baseUrl,
    dataDir,
    projectsRoot,
    tempRoot,
    child,
    async stop() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));
      }
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  };
}

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${authToken}`, ...extra };
}

async function responseJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

test("M0 security boundary protects the live API hermetically", async (t) => {
  const hub = await startHub();
  t.after(() => hub.stop());

  await t.test("anonymous mutation is denied", async () => {
    const response = await fetch(`${hub.baseUrl}/api/v1/agents/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    assert.equal(response.status, 401);
    assert.equal((await responseJson(response)).title, "AUTHENTICATION_REQUIRED");
  });

  await t.test("authorized mutation records the configured actor", async () => {
    const response = await fetch(`${hub.baseUrl}/api/v1/agents/heartbeat`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ evidence: "m0 test" })
    });
    assert.equal(response.status, 200);
    await response.text();
    const state = JSON.parse(await fs.readFile(path.join(hub.dataDir, "state.json"), "utf8"));
    assert.ok(state.auditEvents.some((event) => event.actor === "m0-security-test"));
    assert.doesNotMatch(JSON.stringify(state.auditEvents), new RegExp(authToken));
  });

  await t.test("CORS permits only configured local origins", async () => {
    const allowed = await fetch(`${hub.baseUrl}/healthz`, { headers: { Origin: allowedOrigin } });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("access-control-allow-origin"), allowedOrigin);
    const denied = await fetch(`${hub.baseUrl}/healthz`, { headers: { Origin: "https://attacker.invalid" } });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get("access-control-allow-origin"), null);
    assert.equal((await responseJson(denied)).title, "CORS_ORIGIN_DENIED");
  });

  await t.test("security headers are present", async () => {
    const response = await fetch(`${hub.baseUrl}/healthz`);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  });

  await t.test("oversized and malformed JSON bodies are rejected", async () => {
    const oversized = await fetch(`${hub.baseUrl}/api/v1/agents/heartbeat`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ evidence: "x".repeat(2048) })
    });
    assert.equal(oversized.status, 413);
    assert.equal((await responseJson(oversized)).title, "PAYLOAD_TOO_LARGE");

    const malformed = await fetch(`${hub.baseUrl}/api/v1/agents/heartbeat`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: "{"
    });
    assert.equal(malformed.status, 400);
    assert.equal((await responseJson(malformed)).title, "INVALID_JSON");
  });

  await t.test("SSRF origins not configured by the server are rejected", async () => {
    const response = await fetch(`${hub.baseUrl}/api/v1/projects/chedoparti-react-app`, {
      method: "PATCH",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ runtimeConfig: { sonarHostUrl: "http://169.254.169.254/latest/meta-data" } })
    });
    assert.equal(response.status, 400);
    assert.equal((await responseJson(response)).title, "UPSTREAM_NOT_ALLOWED");
  });

  await t.test("path traversal and symlink escapes are rejected", async () => {
    const outside = path.join(hub.tempRoot, "outside");
    await fs.mkdir(outside);
    const traversal = await fetch(`${hub.baseUrl}/api/v1/projects/discover`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ repositoryPath: "../outside" })
    });
    assert.equal(traversal.status, 400);
    assert.equal((await responseJson(traversal)).title, "PATH_OUTSIDE_PROJECTS_ROOT");

    await fs.symlink(outside, path.join(hub.projectsRoot, "escaped-link"));
    const symlink = await fetch(`${hub.baseUrl}/api/v1/projects/discover`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ repositoryPath: "escaped-link" })
    });
    assert.equal(symlink.status, 400);
    assert.equal((await responseJson(symlink)).title, "SYMLINK_ESCAPE");
  });

  await t.test("privileged and unexpected operations are denied", async () => {
    const disabled = await fetch(`${hub.baseUrl}/api/v1/projects/chedoparti-react-app/runtime/start`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: "{}"
    });
    assert.equal(disabled.status, 503);
    assert.equal((await responseJson(disabled)).title, "PRIVILEGED_EXECUTION_DISABLED");

    const unexpected = await fetch(`${hub.baseUrl}/api/v1/projects/chedoparti-react-app/runtime/shell`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ command: "sh" })
    });
    assert.equal(unexpected.status, 404);
    assert.equal((await responseJson(unexpected)).title, "ROUTE_NOT_FOUND");
  });

  await t.test("secret values are rejected and never echoed", async () => {
    const secret = "sqp_M0MustNeverBeReturned123456789";
    const response = await fetch(`${hub.baseUrl}/api/v1/projects/chedoparti-react-app`, {
      method: "PATCH",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ runtimeConfig: { sonarToken: secret } })
    });
    const text = await response.text();
    assert.equal(response.status, 400);
    assert.doesNotMatch(text, new RegExp(secret));
    assert.match(text, /SECRET_VALUE_NOT_ACCEPTED/);
  });
});

test("embedded local agent connectivity follows startup, TTL and heartbeat", async (t) => {
  const heartbeatTtlMs = 10000;
  const hub = await startHub({ heartbeatTtlMs });
  t.after(() => hub.stop());

  const initialResponse = await fetch(`${hub.baseUrl}/api/v1/agents/overview`);
  assert.equal(initialResponse.status, 200);
  const initial = await responseJson(initialResponse);
  assert.equal(initial.agents[0].status, "CONNECTED");

  await new Promise((resolve) => setTimeout(resolve, heartbeatTtlMs + 100));
  const expiredResponse = await fetch(`${hub.baseUrl}/api/v1/agents/overview`);
  assert.equal(expiredResponse.status, 200);
  const expired = await responseJson(expiredResponse);
  assert.equal(expired.agents[0].status, "DISCONNECTED");

  const heartbeatResponse = await fetch(`${hub.baseUrl}/api/v1/agents/heartbeat`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ evidence: "agent lifecycle test" })
  });
  assert.equal(heartbeatResponse.status, 200);
  const heartbeat = await responseJson(heartbeatResponse);
  assert.equal(heartbeat.heartbeat.status, "CONNECTED");
  assert.equal(heartbeat.agent.connected, true);

  const connectedResponse = await fetch(`${hub.baseUrl}/api/v1/agents/overview`);
  assert.equal(connectedResponse.status, 200);
  const connected = await responseJson(connectedResponse);
  assert.equal(connected.agents[0].status, "CONNECTED");
  assert.equal(connected.agents[0].connected, true);
});

test("M0 authorization, trust, rate limiting and structured redaction are centralized", () => {
  assert.equal(requiredRoleForRequest("GET", "/api/v1/projects"), "READ");
  assert.equal(requiredRoleForRequest("POST", "/api/v1/projects/x/runtime/start"), "OPERATE");
  assert.equal(requiredRoleForRequest("POST", "/api/v1/projects/x/runtime/volumes/delete"), "ADMIN");
  assert.throws(
    () => authorizeRequest({ actor: "operator", role: "OPERATE", authenticated: true }, "ADMIN"),
    (error) => error.code === "AUTHORIZATION_DENIED"
  );

  const executionConfig = createSecurityConfig({
    HUB_AUTH_TOKEN: authToken,
    HUB_AUTH_ACTOR_ID: "operator",
    HUB_AUTH_ROLE: "OPERATE",
    HUB_PRIVILEGED_EXECUTION_ENABLED: "1"
  });
  assert.throws(
    () => assertProjectExecutionAllowed({ trust: "UNTRUSTED" }, executionConfig),
    (error) => error.code === "PROJECT_EXECUTION_FORBIDDEN"
  );

  const rateConfig = createSecurityConfig({ HUB_RATE_LIMIT_MAX_MUTATIONS: "1" });
  const limit = createMutationRateLimiter(rateConfig);
  limit("local", 1000);
  assert.throws(() => limit("local", 1001), (error) => error.code === "RATE_LIMIT_EXCEEDED");

  assert.throws(
    () => createSecurityConfig({ HUB_ALLOWED_ORIGINS: "*" }),
    (error) => error.code === "INSECURE_CORS_CONFIGURATION"
  );
  assert.throws(
    () => createSecurityConfig({ HUB_API_HOST: "0.0.0.0" }),
    (error) => error.code === "INSECURE_NETWORK_CONFIGURATION"
  );

  assert.deepEqual(
    redactStructured({ actor: "operator", nested: { databaseUrl: "postgres://user:pass@db/app", safe: "ok" } }),
    { actor: "operator", nested: { databaseUrl: "[REDACTED]", safe: "ok" } }
  );
});

test("M0 upstream client enforces timeout without following arbitrary targets", async (t) => {
  const server = http.createServer(() => {});
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const config = createSecurityConfig({
    HUB_ALLOWED_UPSTREAM_ORIGINS: origin,
    HUB_UPSTREAM_TIMEOUT_MS: "50"
  });
  await assert.rejects(
    () => fetchAllowedUpstream(`${origin}/hang`, { timeoutMs: 50 }, config),
    (error) => error.code === "UPSTREAM_TIMEOUT"
  );
});

test("M0 Compose defaults bind locally and remove root-equivalent sockets", async () => {
  const compose = await fs.readFile(path.join(repoRoot, "compose.yaml"), "utf8");
  const serverSource = await fs.readFile(path.join(repoRoot, "apps/control-api/server.mjs"), "utf8");
  const sonarCompose = await fs.readFile(path.join(repoRoot, "sonarqube/docker-compose.yml"), "utf8");
  const sonarBootstrap = await fs.readFile(path.join(repoRoot, "sonarqube/scripts/bootstrap-credentials.sh"), "utf8");
  assert.doesNotMatch(compose, /\/var\/run\/docker\.sock/);
  assert.doesNotMatch(compose, /\/Users\/martiniano/);
  assert.doesNotMatch(compose, /user:\s*["']?0:0/);
  assert.doesNotMatch(compose, /GF_AUTH_ANONYMOUS_ENABLED:\s*["']true/);
  assert.doesNotMatch(compose, /ADMIN_PASSWORD:\s*admin/);
  for (const line of compose.split(/\r?\n/).filter((item) => /^\s+-\s+"\$\{.*:\d+"/.test(item))) {
    assert.match(line, /\$\{HUB_BIND_ADDRESS:-127\.0\.0\.1\}/);
  }
  const hubPostgresBlock = compose.split("  hub-postgres:")[1].split("  redis:")[0];
  const redisBlock = compose.split("  redis:")[1].split("  sonarqube:")[0];
  const webBlock = compose.split("  web:")[1].split("  hub-postgres:")[0];
  const sonarBlock = compose.split("  sonarqube:")[1].split("  sonarqube-credential-bootstrap:")[0];
  const sonarBootstrapBlock = compose.split("  sonarqube-credential-bootstrap:")[1].split("  sonarqube-gateway:")[0];
  const sonarGatewayBlock = compose.split("  sonarqube-gateway:")[1].split("  sonar-postgres:")[0];
  const standaloneSonarBlock = sonarCompose.split("  sonarqube:")[1].split("  sonarqube-credential-bootstrap:")[0];
  const standaloneGatewayBlock = sonarCompose.split("  sonarqube-gateway:")[1].split("  sonarqube-db:")[0];
  const blackboxBlock = compose.split("  blackbox:")[1].split("  jenkins:")[0];
  const cadvisorBlock = compose.split("  cadvisor:")[1].split("volumes:")[0];
  assert.doesNotMatch(hubPostgresBlock, /\n\s+ports:/);
  assert.doesNotMatch(redisBlock, /\n\s+ports:/);
  assert.match(webBlock, /nginxinc\/nginx-unprivileged:1\.27\.5-alpine/);
  assert.match(webBlock, /user:\s*"101:101"/);
  assert.match(webBlock, /cap_drop:\s*\["ALL"\]/);
  assert.match(webBlock, /:8080"/);
  assert.doesNotMatch(sonarBlock, /wget/);
  assert.doesNotMatch(sonarBlock, /\n\s+ports:/);
  assert.doesNotMatch(sonarBlock, /hub-quality-host/);
  assert.match(sonarBlock, /api\/system\/status/);
  assert.match(sonarBlock, /api\/authentication\/validate/);
  assert.match(sonarBootstrapBlock, /SONAR_ADMIN_PASSWORD/);
  assert.match(sonarBootstrapBlock, /bootstrap-credentials\.sh/);
  assert.match(sonarBootstrap, /api\/users\/change_password/);
  assert.match(sonarBootstrap, /SONAR_ADMIN_PASSWORD/);
  assert.match(sonarBootstrap, /api\/authentication\/validate/);
  assert.match(sonarGatewayBlock, /service_completed_successfully/);
  assert.match(sonarGatewayBlock, /"127\.0\.0\.1:\$\{SONARQUBE_PORT:-9000\}:8080"/);
  assert.match(sonarGatewayBlock, /hub-quality-host/);
  assert.doesNotMatch(blackboxBlock, /\n\s+ports:/);
  assert.match(blackboxBlock, /9115\/\-\/ready/);
  assert.doesNotMatch(cadvisorBlock, /\n\s+ports:/);
  assert.match(compose, /hub-quality-host:\n/);
  assert.match(compose, /hub-observability-host:\n/);
  assert.match(compose, /hub-quality:\n\s+internal:\s+true/);
  assert.match(compose, /hub-observability:\n\s+internal:\s+true/);
  assert.match(serverSource, /HUB_API_HOST \|\| "127\.0\.0\.1"/);
  assert.match(sonarCompose, /"127\.0\.0\.1:\$\{SONARQUBE_PORT:-9000\}:8080"/);
  assert.match(sonarCompose, /SONAR_ADMIN_PASSWORD/);
  assert.doesNotMatch(standaloneSonarBlock, /wget|\n\s+ports:/);
  assert.match(standaloneGatewayBlock, /service_completed_successfully/);
  assert.match(standaloneGatewayBlock, /"127\.0\.0\.1:\$\{SONARQUBE_PORT:-9000\}:8080"/);
  assert.match(sonarCompose, /sonarqube-net:\n\s+name:.*\n\s+internal: true/);
});
