// Saltline server: serves the game and asks Microsoft-Decision-1 on Microsoft Foundry what each
// Gull (drone) and Hound (robot dog) should do next. Credentials never reach the browser.

import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDecisionClient, DecisionError, MODEL_NAME } from "./lib/decisions.js";
import { foundryAuth, resolveFoundryConfig } from "./lib/foundry.js";
import { buildRequest, parseDecision } from "./lib/prompts.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
try {
  // Optional, git-ignored settings (FOUNDRY_ENDPOINT, ...). Real environment variables win.
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch (err) {
  if (err?.code !== "ENOENT") throw err;
}

const PORT = Number(process.env.PORT) || 8731;
const HOST = process.env.HOST || "127.0.0.1";
const VERBOSE = process.env.LOG_DECISIONS === "1";
// Caps so a server left running can't run up an unbounded bill.
const MAX_IN_FLIGHT = 24;
const DAILY_CALL_LIMIT = Number(process.env.DAILY_CALL_LIMIT) || 20_000;
const DAILY_LIMIT_REACHED = "Daily AI decision limit reached";
const NOT_CONFIGURED = "FOUNDRY_ENDPOINT is not configured on the server";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};
// Only the game itself is served: never .env, server.js or lib/.
const STATIC_FILE = /^\/(?:(?:js|css)\/[\w-]+\.(?:js|css))$/;
const ROUTES = { "/api/gull": "gull", "/api/hound": "hound" };

const foundry = resolveFoundryConfig();
const MODEL = `${MODEL_NAME} (${foundry.deployment})`;
const getHeaders = foundryAuth(foundry);
const client = foundry.endpoint
  ? createDecisionClient({ endpoint: foundry.endpoint, deployment: foundry.deployment, getHeaders, timeoutMs: 6000 })
  : null;
// Fetch the first Entra ID token at startup so the first decision doesn't wait for it.
if (client) getHeaders().catch((err) => console.warn(`[auth] ${err.message}`));

const LOOPBACK = ["127.0.0.1", "localhost", "::1"].includes(HOST);
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);

let inFlight = 0;
const stats = { calls: 0, errors: 0, inputTokens: 0, latencyMs: 0 };
const daily = { date: "", calls: 0 };

function dailyLimitReached() {
  const date = new Date().toISOString().slice(0, 10);
  if (date !== daily.date) Object.assign(daily, { date, calls: 0 });
  return daily.calls >= DAILY_CALL_LIMIT;
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": MIME[".json"],
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function readJson(req, maxBytes) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
      req.resume();
      reject(httpError(415, "Expected Content-Type: application/json"));
      return;
    }
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return reject(httpError(413, "Payload too large"));
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(httpError(400, "Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// Only the game page itself may spend model calls: block other origins and DNS rebinding.
function isTrustedRequest(req) {
  const host = req.headers.host ?? "";
  if (LOOPBACK && !ALLOWED_HOSTS.has(host)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function handleDecision(kind, req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
  if (!isTrustedRequest(req)) return sendJson(res, 403, { error: "Forbidden origin" });
  if (!client) return sendJson(res, 503, { error: NOT_CONFIGURED });
  if (inFlight >= MAX_IN_FLIGHT) return sendJson(res, 429, { error: "Too many decisions in flight" });
  if (dailyLimitReached()) return sendJson(res, 429, { error: DAILY_LIMIT_REACHED });

  let request;
  try {
    request = buildRequest(kind, await readJson(req, 8 * 1024));
  } catch (err) {
    return sendJson(res, err.status ?? 400, { error: err.message });
  }

  inFlight++;
  daily.calls++;
  try {
    const result = await client.ask(request);
    stats.calls++;
    stats.latencyMs += result.latencyMs;
    stats.inputTokens += result.usage?.input_tokens ?? 0;
    const decision = parseDecision(kind, result);
    if (VERBOSE) console.log(`[decisions] ${kind} ${result.latencyMs}ms ${JSON.stringify(decision)}`);
    return sendJson(res, 200, {
      ...decision,
      latencyMs: result.latencyMs,
      inputTokens: result.usage?.input_tokens ?? null,
      model: result.model,
    });
  } catch (err) {
    stats.errors++;
    const upstream = err instanceof DecisionError;
    console.warn(`[decisions] ${kind} failed: ${err.message}${upstream && err.status ? ` (HTTP ${err.status})` : ""}`);
    const status = upstream ? (err.status === 429 ? 429 : 502) : 500;
    return sendJson(res, status, { error: err.message, code: upstream ? err.code : null });
  } finally {
    inFlight--;
  }
}

async function serveStatic(pathname, req, res) {
  const relative = pathname === "/" ? "/index.html" : pathname;
  if (relative !== "/index.html" && !STATIC_FILE.test(relative)) return sendJson(res, 404, { error: "Not found" });
  const filePath = path.join(ROOT, relative);
  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(req.method === "HEAD" ? undefined : data);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    if (pathname === "/api/status") {
      return sendJson(res, 200, { configured: Boolean(client), model: MODEL, keySource: foundry.authSource });
    }
    const kind = ROUTES[pathname];
    if (kind) return await handleDecision(kind, req, res);
    if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "Method not allowed" });
    if (pathname === "/favicon.ico") {
      res.writeHead(204);
      return res.end();
    }
    return await serveStatic(pathname, req, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: "Internal server error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Saltline is running at http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  console.log(
    client
      ? `Gulls and Hounds decide with ${MODEL} at ${foundry.endpoint} (auth: ${foundry.authSource})`
      : "FOUNDRY_ENDPOINT not set: Gulls and Hounds use the game's built-in AI.",
  );
});

const summary = setInterval(() => {
  if (!stats.calls && !stats.errors) return;
  const avg = stats.calls ? Math.round(stats.latencyMs / stats.calls) : 0;
  const cost = (stats.inputTokens / 1e6) * 0.04;
  console.log(
    `[decisions] ${stats.calls} calls, ${stats.errors} errors, avg ${avg} ms, ${stats.inputTokens} input tokens (~$${cost.toFixed(4)})`,
  );
  Object.assign(stats, { calls: 0, errors: 0, inputTokens: 0, latencyMs: 0 });
}, 30_000);
summary.unref();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
