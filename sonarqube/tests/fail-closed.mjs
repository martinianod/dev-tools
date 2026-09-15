import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const composeFile = path.join(repoRoot, "sonarqube/docker-compose.yml");
const testId = `m0sg${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
const adminPassword = `${crypto.randomBytes(18).toString("hex")}Aa1!`;
const databasePassword = crypto.randomBytes(24).toString("hex");
const testPort = Number(process.env.SONAR_GATE_TEST_PORT || 9000);
const baseUrl = `http://127.0.0.1:${testPort}`;

function run(command, args, env, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-20000); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-20000); });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function safeOutput(result) {
  return `${result.stdout}\n${result.stderr}`
    .replaceAll(adminPassword, "[REDACTED]")
    .replaceAll(databasePassword, "[REDACTED]")
    .slice(-1200);
}

async function request(pathname, options = {}) {
  try {
    return await fetch(`${baseUrl}${pathname}`, {
      ...options,
      signal: AbortSignal.timeout(2500)
    });
  } catch {
    return null;
  }
}

async function portIsFree() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(testPort, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function inspect(name) {
  const result = await run("docker", ["inspect", name], process.env, 20000);
  if (result.code !== 0) return null;
  return JSON.parse(result.stdout)[0];
}

async function waitFor(predicate, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("Timed out waiting for SonarQube test condition");
}

function scenario(flavor) {
  const name = `${testId}${flavor === "main" ? "m" : "s"}`;
  const env = {
    ...process.env,
    SONAR_ADMIN_PASSWORD: "",
    SONARQUBE_PORT: String(testPort),
    SONARQUBE_BIND_ADDRESS: "0.0.0.0",
    HUB_BIND_ADDRESS: "0.0.0.0",
    SONAR_POSTGRES_PASSWORD: databasePassword,
    POSTGRES_PASSWORD: databasePassword
  };
  if (flavor === "standalone") {
    Object.assign(env, {
      SONARQUBE_CONTAINER_NAME: `${name}-sonarqube`,
      SONARQUBE_BOOTSTRAP_CONTAINER_NAME: `${name}-bootstrap`,
      SONARQUBE_GATEWAY_CONTAINER_NAME: `${name}-gateway`,
      SONARQUBE_DB_CONTAINER_NAME: `${name}-db`,
      SONARQUBE_DATA_VOLUME: `${name}-data`,
      SONARQUBE_EXTENSIONS_VOLUME: `${name}-extensions`,
      SONARQUBE_LOGS_VOLUME: `${name}-logs`,
      SONARQUBE_DB_VOLUME: `${name}-db-data`,
      SONARQUBE_INTERNAL_NETWORK: `${name}-internal`,
      SONARQUBE_HOST_NETWORK: `${name}-host`
    });
  }
  const prefix = flavor === "main"
    ? ["compose", "-p", name, "--profile", "quality"]
    : ["compose", "-p", name, "-f", composeFile];
  return {
    name,
    flavor,
    env,
    command: (args, password = "") => run("docker", [...prefix, ...args], {
      ...env,
      SONAR_ADMIN_PASSWORD: password
    }),
    container: (service) => flavor === "main" ? `${name}-${service}-1` : `${name}-${service === "sonarqube-credential-bootstrap" ? "bootstrap" : service === "sonarqube-gateway" ? "gateway" : service === "sonarqube" ? "sonarqube" : "db"}`
  };
}

async function assertNoHostExposure(item) {
  assert.equal(await request("/api/system/status"), null, `${item.flavor}: host endpoint became reachable before bootstrap success`);
  const sonar = await inspect(item.container("sonarqube"));
  if (sonar) assert.equal(sonar.HostConfig.PortBindings?.["9000/tcp"], undefined, `${item.flavor}: SonarQube published its own port`);
  const gateway = await inspect(item.container("sonarqube-gateway"));
  assert(!gateway || gateway.State.Status !== "running", `${item.flavor}: gateway started after bootstrap failure`);
}

async function assertAuth(password, expectedValid) {
  const response = await request("/api/authentication/validate", {
    headers: { Authorization: `Basic ${Buffer.from(`admin:${password}`).toString("base64")}` }
  });
  assert(response && response.status === 200, "authentication endpoint unavailable");
  assert.equal((await response.json()).valid, expectedValid);
}

async function assertHardening(item, gateway) {
  const sonar = await inspect(item.container("sonarqube"));
  assert.equal(sonar.HostConfig.Privileged, false);
  assert(sonar.HostConfig.SecurityOpt?.includes("no-new-privileges:true"));
  assert(!sonar.Mounts.some((mount) => mount.Type === "bind" && mount.RW), "SonarQube has a writable host bind");
  assert(!sonar.Mounts.some((mount) => /docker\.sock/.test(`${mount.Source} ${mount.Destination}`)), "SonarQube has a Docker socket");
  assert.equal(Object.keys(sonar.NetworkSettings.Networks).length, 1, "SonarQube is attached to a host-edge network");
  assert.equal(gateway.HostConfig.Privileged, false);
  assert.equal(gateway.HostConfig.ReadonlyRootfs, true);
  assert(gateway.HostConfig.SecurityOpt?.includes("no-new-privileges:true"));
  assert(gateway.HostConfig.CapDrop?.includes("ALL"));
  const inspection = await run("docker", ["exec", item.container("sonarqube"), "sh", "-c", "id -u; grep ^CapEff: /proc/1/status; grep ^NoNewPrivs: /proc/1/status"], process.env, 20000);
  assert.equal(inspection.code, 0, safeOutput(inspection));
  const [uid, caps, noNewPrivs] = inspection.stdout.trim().split("\n");
  assert.equal(uid, "1000");
  assert.match(caps, /^CapEff:\s+0+$/);
  assert.match(noNewPrivs, /^NoNewPrivs:\s+1$/);
}

async function exercise(flavor) {
  assert(await portIsFree(), `127.0.0.1:${testPort} is already in use`);
  const item = scenario(flavor);
  const dbService = flavor === "main" ? "sonar-postgres" : "sonarqube-db";
  console.log(`${flavor}: isolated project ${item.name}; persistent test volumes will be preserved`);
  try {
    const configResult = await item.command(["config", "--format", "json"]);
    assert.equal(configResult.code, 0, safeOutput(configResult));
    const config = JSON.parse(configResult.stdout);
    assert(!config.services.sonarqube.ports, "SonarQube must have no host port");
    assert.equal(config.services["sonarqube-gateway"].ports[0].host_ip, "127.0.0.1");
    assert.equal(config.services["sonarqube-gateway"].depends_on["sonarqube-credential-bootstrap"].condition, "service_completed_successfully");

    const missing = await item.command(["up", "-d", "--no-build", "sonarqube-gateway"]);
    assert.notEqual(missing.code, 0, `${flavor}: missing-secret startup unexpectedly succeeded`);
    const missingBootstrap = await inspect(item.container("sonarqube-credential-bootstrap"));
    assert.equal(missingBootstrap?.State.ExitCode, 1, `${flavor}: missing-secret bootstrap did not fail: ${safeOutput(missing)}`);
    const missingLogs = await item.command(["logs", "--no-color", "sonarqube-credential-bootstrap"]);
    assert.equal(missingLogs.code, 0, safeOutput(missingLogs));
    assert(missingLogs.stdout.includes("must be supplied externally") || missingLogs.stderr.includes("must be supplied externally"));
    assert.doesNotMatch(`${missingLogs.stdout}\n${missingLogs.stderr}`, /generated|fallback/i);
    await assertNoHostExposure(item);
    console.log(`${flavor}: missing external secret rejected; no host endpoint`);

    const invalid = await item.command(["up", "-d", "--no-build", "sonarqube-gateway"], "short");
    assert.notEqual(invalid.code, 0, `${flavor}: invalid-secret startup unexpectedly succeeded`);
    const invalidBootstrap = await inspect(item.container("sonarqube-credential-bootstrap"));
    assert.equal(invalidBootstrap?.State.ExitCode, 1, `${flavor}: invalid-secret bootstrap did not fail`);
    const invalidLogs = await item.command(["logs", "--no-color", "sonarqube-credential-bootstrap"], "short");
    assert.equal(invalidLogs.code, 0, safeOutput(invalidLogs));
    assert(!invalidLogs.stdout.includes("short") && !invalidLogs.stderr.includes("short"), `${flavor}: invalid secret was logged`);
    assert.doesNotMatch(`${invalidLogs.stdout}\n${invalidLogs.stderr}`, /generated|fallback/i);
    await assertNoHostExposure(item);
    console.log(`${flavor}: invalid external secret rejected; no host endpoint`);

    const valid = await item.command(["up", "-d", "--no-build", "sonarqube-gateway"], adminPassword);
    assert.equal(valid.code, 0, `${flavor}: valid startup failed: ${safeOutput(valid)}`);
    const gateway = await waitFor(async () => {
      const value = await inspect(item.container("sonarqube-gateway"));
      return value?.State.Health?.Status === "healthy" ? value : null;
    });
    const bootstrap = await inspect(item.container("sonarqube-credential-bootstrap"));
    assert.equal(bootstrap?.State.ExitCode, 0, `${flavor}: bootstrap did not succeed`);
    assert(new Date(gateway.State.StartedAt) >= new Date(bootstrap.State.FinishedAt), `${flavor}: gateway started before bootstrap completed`);
    const status = await request("/api/system/status");
    assert.equal(status?.status, 200);
    assert.equal((await status.json()).status, "UP");
    const ui = await request("/");
    assert.equal(ui?.status, 200);
    await assertAuth("admin", false);
    await assertAuth(adminPassword, true);
    assert.deepEqual(gateway.HostConfig.PortBindings?.["8080/tcp"]?.map((binding) => binding.HostIp), ["127.0.0.1"]);
    assert.deepEqual(gateway.HostConfig.PortBindings?.["8080/tcp"]?.map((binding) => binding.HostPort), [String(testPort)]);
    const db = await inspect(item.container(dbService));
    assert(!db?.HostConfig.PortBindings || Object.keys(db.HostConfig.PortBindings).length === 0, `${flavor}: PostgreSQL published a host port`);
    await assertHardening(item, gateway);
    const bootstrapLogs = await item.command(["logs", "--no-color", "sonarqube-credential-bootstrap"], adminPassword);
    assert.equal(bootstrapLogs.code, 0, safeOutput(bootstrapLogs));
    assert(!bootstrapLogs.stdout.includes(adminPassword) && !bootstrapLogs.stderr.includes(adminPassword), `${flavor}: bootstrap log exposed the external credential`);
    console.log(`${flavor}: gateway healthy after bootstrap; loopback-only port; default denied; external credential accepted`);

    const second = await item.command(["run", "--rm", "--no-deps", "sonarqube-credential-bootstrap"], adminPassword);
    assert.equal(second.code, 0, `${flavor}: idempotent bootstrap failed: ${safeOutput(second)}`);
    assert(second.stdout.includes("preserving existing credentials"), `${flavor}: second bootstrap did not detect secure state`);
    await assertAuth("admin", false);
    await assertAuth(adminPassword, true);
    console.log(`${flavor}: second bootstrap idempotent; credential unchanged`);
  } finally {
    const stopped = await item.command(["down"]);
    if (stopped.code !== 0) console.error(`${flavor}: isolated cleanup failed: ${safeOutput(stopped)}`);
    else console.log(`${flavor}: removed only isolated containers/networks; volumes preserved`);
  }
}

const requestedFlavor = process.argv[2];
const flavors = requestedFlavor ? [requestedFlavor] : ["main", "standalone"];
for (const flavor of flavors) {
  assert(["main", "standalone"].includes(flavor), `Unknown Compose flavor: ${flavor}`);
  await exercise(flavor);
}
