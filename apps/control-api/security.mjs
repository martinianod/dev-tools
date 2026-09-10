import crypto from "node:crypto";

export const SECURITY_ROLES = Object.freeze({ READ: 1, OPERATE: 2, ADMIN: 3 });
export const PROJECT_TRUST = Object.freeze({ UNTRUSTED: "UNTRUSTED", TRUSTED_LOCAL: "TRUSTED_LOCAL" });

function securityError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.type = `https://quality-hub.local/problems/${code.toLowerCase()}`;
  return error;
}

function csv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

function normalizedOrigin(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw securityError(400, "INVALID_UPSTREAM_URL", "Upstream URLs must use HTTP/HTTPS without embedded credentials.");
  }
  return url.origin;
}

function isLoopbackAddress(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  return ["127.0.0.1", "::1", "localhost"].includes(normalized);
}

export function createSecurityConfig(env = process.env) {
  const apiPort = boundedInteger(env.HUB_API_PORT, 18080, 1, 65535);
  const webPort = boundedInteger(env.HUB_WEB_PORT, 18000, 1, 65535);
  const authToken = String(env.HUB_AUTH_TOKEN || "").trim();
  const actorId = String(env.HUB_AUTH_ACTOR_ID || "").trim();
  const role = String(env.HUB_AUTH_ROLE || "ADMIN").trim().toUpperCase();
  const publicBindAddress = String(env.HUB_PUBLIC_BIND_ADDRESS || env.HUB_API_HOST || "127.0.0.1").trim();
  if (authToken && authToken.length < 32) {
    throw securityError(500, "INSECURE_AUTH_CONFIGURATION", "HUB_AUTH_TOKEN must contain at least 32 characters.");
  }
  if (authToken && !actorId) {
    throw securityError(500, "INSECURE_AUTH_CONFIGURATION", "HUB_AUTH_ACTOR_ID is required when HUB_AUTH_TOKEN is configured.");
  }
  if (!(role in SECURITY_ROLES)) {
    throw securityError(500, "INSECURE_AUTH_CONFIGURATION", "HUB_AUTH_ROLE must be READ, OPERATE or ADMIN.");
  }
  if (!isLoopbackAddress(publicBindAddress) && !authToken) {
    throw securityError(500, "INSECURE_NETWORK_CONFIGURATION", "A non-loopback Control API requires externally configured authentication.");
  }

  const defaultOrigins = [
    `http://127.0.0.1:${webPort}`,
    `http://localhost:${webPort}`,
    `http://127.0.0.1:${apiPort}`,
    `http://localhost:${apiPort}`
  ];
  const configuredOrigins = csv(env.HUB_ALLOWED_ORIGINS).length ? csv(env.HUB_ALLOWED_ORIGINS) : defaultOrigins;
  const allowedOrigins = new Set();
  for (const value of configuredOrigins) {
    if (value === "*") {
      throw securityError(500, "INSECURE_CORS_CONFIGURATION", "Wildcard CORS origins are not permitted.");
    }
    let origin;
    try {
      const url = new URL(value);
      origin = url.origin;
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || value !== origin) {
        throw new Error("invalid origin");
      }
    } catch {
      throw securityError(500, "INSECURE_CORS_CONFIGURATION", "HUB_ALLOWED_ORIGINS must contain exact HTTP/HTTPS origins.");
    }
    allowedOrigins.add(origin);
  }
  const configuredUpstreamUrls = [
    env.SONAR_HOST_URL,
    env.PROMETHEUS_URL,
    env.LOKI_URL,
    env.TEMPO_URL,
    env.ALERTMANAGER_URL,
    env.GRAFANA_URL,
    env.JENKINS_URL,
    env.JENKINS_INTERNAL_URL,
    ...csv(env.HUB_ALLOWED_UPSTREAM_ORIGINS)
  ].filter(Boolean);
  const allowedUpstreamOrigins = new Set();
  for (const value of configuredUpstreamUrls) allowedUpstreamOrigins.add(normalizedOrigin(value));

  const privilegedExecutionEnabled = env.HUB_PRIVILEGED_EXECUTION_ENABLED === "1";
  if (privilegedExecutionEnabled && (!authToken || SECURITY_ROLES[role] < SECURITY_ROLES.OPERATE)) {
    throw securityError(500, "INSECURE_EXECUTION_CONFIGURATION", "Privileged local execution requires an external auth token and an OPERATE or ADMIN principal.");
  }

  return Object.freeze({
    authToken,
    actorId,
    role,
    authConfigured: Boolean(authToken),
    publicBindAddress,
    requireAuthForReads: !isLoopbackAddress(publicBindAddress),
    privilegedExecutionEnabled,
    allowedOrigins,
    allowedUpstreamOrigins,
    bodyLimitBytes: boundedInteger(env.HUB_REQUEST_BODY_LIMIT_BYTES, 1024 * 1024, 1024, 10 * 1024 * 1024),
    upstreamTimeoutMs: boundedInteger(env.HUB_UPSTREAM_TIMEOUT_MS, 5000, 50, 30000),
    upstreamResponseLimitBytes: boundedInteger(env.HUB_UPSTREAM_RESPONSE_LIMIT_BYTES, 1024 * 1024, 1024, 10 * 1024 * 1024),
    rateLimitWindowMs: boundedInteger(env.HUB_RATE_LIMIT_WINDOW_MS, 60000, 1000, 3600000),
    rateLimitMaxMutations: boundedInteger(env.HUB_RATE_LIMIT_MAX_MUTATIONS, 60, 1, 10000),
    runtimeTimeoutMs: boundedInteger(env.HUB_RUNTIME_TIMEOUT_MS, 1800000, 1000, 7200000),
    processOutputLimitBytes: boundedInteger(env.HUB_PROCESS_OUTPUT_LIMIT_BYTES, 2 * 1024 * 1024, 4096, 50 * 1024 * 1024)
  });
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function authenticateRequest(req, config) {
  const header = String(req.headers.authorization || "");
  if (!header) return { actor: "anonymous", role: "READ", authenticated: false };
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || !config.authConfigured || !safeEqual(match[1], config.authToken)) {
    throw securityError(401, "AUTHENTICATION_REQUIRED", "A valid Bearer credential is required.");
  }
  return { actor: config.actorId, role: config.role, authenticated: true };
}

export function requiredRoleForRequest(method, pathname) {
  const normalizedMethod = String(method || "GET").toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(normalizedMethod)) return "READ";
  if (normalizedMethod === "PATCH" && /^\/api\/v1\/projects\/[^/]+$/.test(pathname)) return "ADMIN";
  if (normalizedMethod === "POST" && pathname === "/api/v1/projects") return "ADMIN";
  if (normalizedMethod === "POST" && pathname === "/api/v1/projects/discover") return "ADMIN";
  if (/\/runtime\/(volumes\/delete|logs\/clear)$/.test(pathname)) return "ADMIN";
  if (/\/deployments\/(rollback|plans\/[^/]+\/(approve|reject))$/.test(pathname)) return "ADMIN";
  return "OPERATE";
}

export function authorizeRequest(principal, requiredRole, options = {}) {
  if (requiredRole === "READ" && !options.requireAuthentication) return;
  if (!principal.authenticated) {
    throw securityError(401, "AUTHENTICATION_REQUIRED", requiredRole === "READ"
      ? "Remote Control API reads require a valid Bearer credential."
      : "Sensitive mutations require a configured Bearer credential.");
  }
  if (SECURITY_ROLES[principal.role] < SECURITY_ROLES[requiredRole]) {
    throw securityError(403, "AUTHORIZATION_DENIED", `This operation requires the ${requiredRole} role.`);
  }
}

export function evaluateCors(origin, config) {
  if (!origin) return { allowed: true, origin: "" };
  if (!config.allowedOrigins.has(origin)) {
    throw securityError(403, "CORS_ORIGIN_DENIED", "The request Origin is not allowed.");
  }
  return { allowed: true, origin };
}

export function applySecurityHeaders(req, res, config, corsOrigin = "") {
  if (corsOrigin) {
    res.setHeader("Access-Control-Allow-Origin", corsOrigin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,PATCH,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type,Idempotency-Key,X-Request-ID");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  const connectSources = ["'self'", ...config.allowedOrigins].join(" ");
  res.setHeader("Content-Security-Policy", `default-src 'self'; connect-src ${connectSources}; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`);
  if (req.correlationId) res.setHeader("X-Correlation-ID", req.correlationId);
}

export function createMutationRateLimiter(config) {
  const buckets = new Map();
  return function checkMutationRateLimit(key, now = Date.now()) {
    const previous = buckets.get(key);
    const bucket = !previous || now - previous.startedAt >= config.rateLimitWindowMs
      ? { startedAt: now, count: 0 }
      : previous;
    bucket.count += 1;
    buckets.set(key, bucket);
    if (bucket.count > config.rateLimitMaxMutations) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.startedAt + config.rateLimitWindowMs - now) / 1000));
      const error = securityError(429, "RATE_LIMIT_EXCEEDED", "Too many sensitive requests. Retry later.");
      error.retryAfterSeconds = retryAfterSeconds;
      throw error;
    }
  };
}

export function validateUpstreamUrl(value, config) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw securityError(400, "INVALID_UPSTREAM_URL", "The configured upstream URL is invalid.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw securityError(400, "INVALID_UPSTREAM_URL", "Upstream URLs must use HTTP/HTTPS without credentials or fragments.");
  }
  if (!config.allowedUpstreamOrigins.has(url.origin)) {
    throw securityError(400, "UPSTREAM_NOT_ALLOWED", "The upstream origin is not explicitly allowed by server configuration.");
  }
  return url;
}

async function readLimitedResponse(response, limitBytes) {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > limitBytes) {
    throw securityError(502, "UPSTREAM_RESPONSE_TOO_LARGE", "The upstream response exceeded the configured limit.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limitBytes) {
        await reader.cancel();
        throw securityError(502, "UPSTREAM_RESPONSE_TOO_LARGE", "The upstream response exceeded the configured limit.");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

export async function fetchAllowedUpstream(value, options, config) {
  const url = validateUpstreamUrl(value, config);
  const controller = new AbortController();
  const timeoutMs = Math.min(Number(options?.timeoutMs || config.upstreamTimeoutMs), config.upstreamTimeoutMs);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: options?.method || "GET",
      headers: options?.headers || {},
      signal: controller.signal,
      redirect: "manual"
    });
    if (response.status >= 300 && response.status < 400) {
      throw securityError(502, "UPSTREAM_REDIRECT_BLOCKED", "Upstream redirects are not followed.");
    }
    const text = await readLimitedResponse(response, config.upstreamResponseLimitBytes);
    return { ok: response.ok, status: response.status, text };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw securityError(504, "UPSTREAM_TIMEOUT", "The upstream request exceeded the configured timeout.");
    }
    if (error?.status) throw error;
    throw securityError(502, "UPSTREAM_UNAVAILABLE", "The configured upstream could not be reached.");
  } finally {
    clearTimeout(timeout);
  }
}

export function normalizeProjectTrust(value) {
  const normalized = String(value || PROJECT_TRUST.UNTRUSTED).trim().toUpperCase();
  if (!(normalized in PROJECT_TRUST)) {
    throw securityError(400, "INVALID_PROJECT_TRUST", "Project trust must be UNTRUSTED or TRUSTED_LOCAL.");
  }
  return normalized;
}

export function assertProjectExecutionAllowed(project, config) {
  if (!config.privilegedExecutionEnabled) {
    throw securityError(503, "PRIVILEGED_EXECUTION_DISABLED", "Privileged local execution is disabled for this API instance.");
  }
  if (normalizeProjectTrust(project?.trust) !== PROJECT_TRUST.TRUSTED_LOCAL) {
    throw securityError(403, "PROJECT_EXECUTION_FORBIDDEN", "The project is not explicitly trusted for local code execution.");
  }
}

export function isSensitiveKey(key) {
  const normalized = String(key || "").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return [
    "token", "password", "passwd", "secret", "privatekey", "apikey", "accesskey",
    "credential", "authorization", "cookie", "session", "databaseurl", "connectionstring"
  ].some((marker) => normalized.includes(marker));
}

export function redactStructured(value, redactText = (item) => item) {
  const visit = (item, key = "") => {
    if (isSensitiveKey(key)) return "[REDACTED]";
    if (Array.isArray(item)) return item.map((entry) => visit(entry));
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).map(([entryKey, entry]) => [entryKey, visit(entry, entryKey)]));
    }
    if (typeof item === "string") return redactText(item);
    return item;
  };
  return visit(value);
}
