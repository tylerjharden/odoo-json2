#!/usr/bin/env node
/**
 * Remote MCP (Streamable HTTP) + OAuth 2.1 so Cursor can Connect / Logout
 * on Configure (one slot per surface). Cursor does not draw Notion's named
 * account list for third-party plugins.
 *
 * Each OAuth login is one Odoo instance (Dev / Test / Prod / custom).
 * Cursor stores the token; this process stores the API key. Tools stay
 * odoo_call + odoo_version. Prod is never selected unless that account's
 * token is on the request.
 */

import { createServer } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SERVER_VERSION,
  handleJsonRpc,
  parseOdooOrigin,
  isProductionEnvironment,
  normalizeEnvironmentName,
  displayEnvironmentName,
} from "./server.mjs";

const ACCESS_TTL_MS = 8 * 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_PORT = Number(process.env.PORT || 8788);

const CURSOR_REDIRECTS = [
  "https://www.cursor.com/agents/mcp/oauth/callback",
  "http://localhost:8787/callback",
  "cursor://anysphere.cursor-mcp/oauth/callback",
];

function log(...args) {
  process.stderr.write(
    args.map((a) => (typeof a === "string" ? a : a instanceof Error ? a.stack || a.message : JSON.stringify(a))).join(" ") +
      "\n"
  );
}

function token() {
  return randomBytes(32).toString("base64url");
}

function sha256Base64Url(value) {
  return createHash("sha256").update(value).digest("base64url");
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

const BLOB_API = process.env.VERCEL_BLOB_API_URL || "https://vercel.com/api/blob";
const BLOB_API_VERSION = "12";
const DEFAULT_BLOB_PATH = "odoo-json2-oauth-store.json";
const DEFAULT_KV_KEY = "odoo-json2-oauth-store";

export function emptyStore() {
  return { clients: {}, codes: {}, tokens: {}, accounts: {} };
}

function normalizeStore(parsed) {
  return {
    clients: (parsed && parsed.clients) || {},
    codes: (parsed && parsed.codes) || {},
    tokens: (parsed && parsed.tokens) || {},
    accounts: (parsed && parsed.accounts) || {},
  };
}

export function createMemoryStore(initial = emptyStore()) {
  let data = structuredClone(initial);
  return {
    read() {
      return data;
    },
    write(next) {
      data = next;
    },
  };
}

export function createFileStore(filePath) {
  const path = resolve(filePath);
  mkdirSync(dirname(path), { recursive: true });
  return {
    read() {
      try {
        return normalizeStore(JSON.parse(readFileSync(path, "utf8")));
      } catch {
        return emptyStore();
      }
    },
    write(next) {
      writeFileSync(path, JSON.stringify(next), { mode: 0o600 });
    },
  };
}

export function createSharedJsonStore(backend) {
  if (!backend.data) backend.data = emptyStore();
  return {
    read() {
      return structuredClone(backend.data);
    },
    write(next) {
      backend.data = structuredClone(next);
    },
  };
}

export function parseBlobStoreId(token) {
  const parts = String(token || "").split("_");
  return parts[3] || "";
}

export function createBlobJsonStore(options = {}) {
  const token = options.token || process.env.BLOB_READ_WRITE_TOKEN || "";
  const pathname = options.pathname || process.env.ODOO_JSON2_BLOB_PATH || DEFAULT_BLOB_PATH;
  const fetchImpl = options.fetchImpl || fetch;
  const access = options.access || "private";
  const apiUrl = (options.apiUrl || BLOB_API).replace(/\/$/, "");
  const storeId = options.storeId || parseBlobStoreId(token);

  return {
    async read() {
      if (!storeId) throw new Error("Vercel Blob store id missing from BLOB_READ_WRITE_TOKEN");
      const url = new URL(`https://${storeId}.${access}.blob.vercel-storage.com/${pathname}`);
      url.searchParams.set("cache", "0");
      const res = await fetchImpl(url.toString(), {
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.status === 404) return emptyStore();
      if (!res.ok) {
        throw new Error(`blob get ${res.status}: ${await res.text()}`);
      }
      try {
        return normalizeStore(JSON.parse(await res.text()));
      } catch {
        return emptyStore();
      }
    },
    async write(next) {
      const params = new URLSearchParams({ pathname });
      const res = await fetchImpl(`${apiUrl}/?${params}`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${token}`,
          "x-api-version": BLOB_API_VERSION,
          "x-content-type": "application/json",
          "x-add-random-suffix": "0",
          "x-allow-overwrite": "1",
          "x-vercel-blob-access": access,
          "x-cache-control-max-age": "60",
        },
        body: JSON.stringify(next),
      });
      if (!res.ok) {
        throw new Error(`blob put ${res.status}: ${await res.text()}`);
      }
    },
  };
}

export function createKvJsonStore(options = {}) {
  const base = (options.url || process.env.KV_REST_API_URL || "").replace(/\/$/, "");
  const token = options.token || process.env.KV_REST_API_TOKEN || "";
  const key = options.key || process.env.ODOO_JSON2_KV_KEY || DEFAULT_KV_KEY;
  const fetchImpl = options.fetchImpl || fetch;

  async function command(argv) {
    const res = await fetchImpl(base, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(argv),
    });
    if (!res.ok) {
      throw new Error(`kv ${argv[0]} ${res.status}: ${await res.text()}`);
    }
    return res.json();
  }

  return {
    async read() {
      const body = await command(["GET", key]);
      if (body.result == null) return emptyStore();
      try {
        const parsed = typeof body.result === "string" ? JSON.parse(body.result) : body.result;
        return normalizeStore(parsed);
      } catch {
        return emptyStore();
      }
    },
    async write(next) {
      await command(["SET", key, JSON.stringify(next)]);
    },
  };
}

export function createRuntimeStore(env = process.env) {
  if (env.BLOB_READ_WRITE_TOKEN) {
    return createBlobJsonStore({
      token: env.BLOB_READ_WRITE_TOKEN,
      pathname: env.ODOO_JSON2_BLOB_PATH || DEFAULT_BLOB_PATH,
    });
  }
  if (env.KV_REST_API_URL && env.KV_REST_API_TOKEN) {
    return createKvJsonStore({
      url: env.KV_REST_API_URL,
      token: env.KV_REST_API_TOKEN,
      key: env.ODOO_JSON2_KV_KEY || DEFAULT_KV_KEY,
    });
  }
  return createFileStore(env.ODOO_JSON2_STORE || resolve("data/store.json"));
}

async function readStore(store) {
  const value = store.read();
  return value && typeof value.then === "function" ? await value : value;
}

async function writeStore(store, next) {
  const value = store.write(next);
  if (value && typeof value.then === "function") await value;
}

async function mutate(store, fn) {
  const next = structuredClone(await readStore(store));
  const result = fn(next);
  await writeStore(store, next);
  return result;
}

async function prune(store, now = Date.now()) {
  await mutate(store, (data) => {
    for (const [id, row] of Object.entries(data.codes)) {
      if (row.exp < now) delete data.codes[id];
    }
    for (const [id, row] of Object.entries(data.tokens)) {
      if (row.exp < now) delete data.tokens[id];
    }
  });
}

function publicOrigin(req, fallback) {
  const explicit = (process.env.ODOO_JSON2_PUBLIC_URL || fallback || "").trim().replace(/\/$/, "");
  if (explicit) return explicit;
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

const ACCOUNT_SUFFIXES = new Set(["dev", "test", "prod"]);

function mcpResource(origin, suffix = "") {
  const base = `${origin.replace(/\/$/, "")}/mcp`;
  return suffix ? `${base}/${suffix}` : base;
}

export function parseMcpPath(pathname) {
  if (pathname === "/mcp" || pathname === "/") return { suffix: "", locked: "" };
  const match = /^\/mcp\/(dev|test|prod)\/?$/.exec(pathname || "");
  if (!match) return null;
  return { suffix: match[1], locked: match[1] };
}

export function lockedAccountFromAuthorizeQuery(query = {}) {
  const resource = String(query.resource || "");
  const fromResource = /\/mcp\/(dev|test|prod)\/?$/.exec(resource);
  if (fromResource) return fromResource[1];
  const hint = normalizeEnvironmentName(query.login_hint || query.account || "");
  return ACCOUNT_SUFFIXES.has(hint) ? hint : "";
}

function isAllowedRedirect(uri, registered = []) {
  if (!uri) return false;
  if (CURSOR_REDIRECTS.includes(uri)) return true;
  if (registered.includes(uri)) return true;
  try {
    const url = new URL(uri);
    return url.hostname === "localhost" || url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

function json(res, status, body, extraHeaders = {}) {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "Authorization, Content-Type, Mcp-Session-Id, Accept",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    ...extraHeaders,
  });
  res.end(raw);
}

function text(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(body);
}

function unauthorized(res, origin, suffix = "") {
  const metadata = suffix
    ? `${origin}/.well-known/oauth-protected-resource/mcp/${suffix}`
    : `${origin}/.well-known/oauth-protected-resource`;
  json(
    res,
    401,
    { error: "invalid_token", error_description: "Connect from the plugin Configure sheet (Environment Local → Connect)." },
    { "www-authenticate": `Bearer realm="odoo-json2", resource_metadata="${metadata}"` }
  );
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseForm(raw) {
  return Object.fromEntries(new URLSearchParams(raw));
}

export function authorizationServerMetadata(origin) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["default", "odoo"],
  };
}

export function protectedResourceMetadata(origin, suffix = "") {
  return {
    resource: mcpResource(origin, suffix),
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    scopes_supported: ["default", "odoo"],
    resource_name: suffix ? `odoo-json2 ${suffix}` : "odoo-json2 MCP",
  };
}

function authorizePage({ origin, query, error, locked = "" }) {
  const q = new URLSearchParams(query).toString();
  const err = error ? `<p class="err">${escapeHtml(error)}</p>` : "";
  const lockLabel = locked ? displayEnvironmentName(locked) : "";
  const accountSelect = locked
    ? `<input type="hidden" name="account" value="${escapeHtml(locked)}">
  <p>This MCP URL is <strong>${escapeHtml(lockLabel)}</strong>. Prod is never selected unless this URL is /mcp/prod.</p>`
    : `<label for="account">Account</label>
  <select id="account" name="account" required>
    <option value="" selected disabled>Choose Dev, Test, or Prod…</option>
    <option value="dev">Dev</option>
    <option value="test">Test</option>
    <option value="prod">Prod (explicit only)</option>
    <option value="custom">Custom name…</option>
  </select>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Connect an Odoo account</title>
<style>
  body { font: 15px/1.4 system-ui, sans-serif; max-width: 32rem; margin: 2rem auto; padding: 0 1rem; color: #111; }
  label { display: block; margin: .75rem 0 .25rem; font-weight: 600; }
  input, select { width: 100%; padding: .5rem .6rem; box-sizing: border-box; }
  button { margin-top: 1.25rem; padding: .6rem 1rem; font-weight: 600; }
  .err { color: #b00020; }
  .hint { color: #555; font-size: 13px; }
</style></head><body>
<h1>Connect an Odoo account</h1>
<p>Connect this Cursor surface (Local, Cloud, or Cloud — ipp). Named Dev / Test / Prod slots are the <code>/mcp/dev</code>, <code>/mcp/test</code>, and <code>/mcp/prod</code> MCP URLs.</p>
${err}
<form method="post" action="/oauth/authorize?${escapeHtml(q)}">
  ${accountSelect}
  <label for="account_custom">Custom name</label>
  <input id="account_custom" name="account_custom" placeholder="staging" autocomplete="off">
  <label for="url">Odoo URL</label>
  <input id="url" name="url" required placeholder="https://ipp-dev.odoo.com" autocomplete="off">
  <label for="database">Database</label>
  <input id="database" name="database" required placeholder="database name" autocomplete="off">
  <label for="api_key">API key</label>
  <input id="api_key" name="api_key" type="password" required autocomplete="off">
  <p class="hint">Preferences → Account Security → New API Key. Stored on this MCP host, not in the plugin repo.</p>
  <button type="submit">Connect account</button>
</form>
<p class="hint">Issuer ${escapeHtml(origin)}</p>
</body></html>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function verifyPkce(verifier, challenge) {
  if (!verifier || !challenge) return false;
  return safeEqual(sha256Base64Url(verifier), challenge);
}

function bearer(req) {
  const header = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : "";
}

async function lookupAccount(store, accessToken) {
  if (!accessToken) return null;
  const data = await readStore(store);
  const row = data.tokens[accessToken];
  if (!row || row.kind !== "access" || row.exp < Date.now()) return null;
  return data.accounts[row.accountId] || null;
}

export function createHttpHandler(options = {}) {
  const store = options.store || createMemoryStore();
  const fallbackOrigin = (options.publicUrl || process.env.ODOO_JSON2_PUBLIC_URL || "").replace(/\/$/, "");

  return async (req, res) => {
    try {
      const origin = publicOrigin(req, fallbackOrigin);
      const url = new URL(req.url || "/", origin);

      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "Authorization, Content-Type, Mcp-Session-Id, Accept",
          "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
        });
        res.end();
        return;
      }

      const prmMatch = /^\/\.well-known\/oauth-protected-resource(?:\/mcp(?:\/(dev|test|prod))?)?$/.exec(url.pathname);
      if (req.method === "GET" && prmMatch) {
        json(res, 200, protectedResourceMetadata(origin, prmMatch[1] || ""));
        return;
      }

      if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
        json(res, 200, authorizationServerMetadata(origin));
        return;
      }

      if (req.method === "POST" && url.pathname === "/oauth/register") {
        const raw = await readBody(req);
        let body = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          json(res, 400, { error: "invalid_client_metadata" });
          return;
        }
        const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u) => isAllowedRedirect(u)) : [];
        if (!redirectUris.length) {
          json(res, 400, { error: "invalid_redirect_uri", error_description: "Register a Cursor or localhost redirect URI." });
          return;
        }
        const clientId = token();
        await mutate(store, (data) => {
          data.clients[clientId] = {
            client_id: clientId,
            redirect_uris: redirectUris,
            token_endpoint_auth_method: "none",
            client_name: body.client_name || "cursor",
          };
        });
        json(res, 201, {
          client_id: clientId,
          redirect_uris: redirectUris,
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        });
        return;
      }

      if (url.pathname === "/oauth/authorize" && req.method === "GET") {
        const params = Object.fromEntries(url.searchParams);
        const locked = lockedAccountFromAuthorizeQuery(params);
        text(res, 200, authorizePage({ origin, query: params, locked }), "text/html; charset=utf-8");
        return;
      }

      if (url.pathname === "/oauth/authorize" && req.method === "POST") {
        const raw = await readBody(req);
        const form = parseForm(raw);
        const params = Object.fromEntries(url.searchParams);
        const clientId = params.client_id || "";
        const redirectUri = params.redirect_uri || "";
        const state = params.state || "";
        const challenge = params.code_challenge || "";
        const method = params.code_challenge_method || "S256";
        const client = (await readStore(store)).clients[clientId];
        const locked = lockedAccountFromAuthorizeQuery(params);
        if (!client || !isAllowedRedirect(redirectUri, client.redirect_uris)) {
          text(res, 400, authorizePage({ origin, query: params, locked, error: "Unknown OAuth client or redirect URI." }), "text/html; charset=utf-8");
          return;
        }
        if (method !== "S256" || !challenge) {
          text(res, 400, authorizePage({ origin, query: params, locked, error: "PKCE S256 is required." }), "text/html; charset=utf-8");
          return;
        }
        let accountName = locked || normalizeEnvironmentName(form.account === "custom" ? form.account_custom : form.account);
        if (locked && accountName !== locked) {
          text(res, 400, authorizePage({ origin, query: params, locked, error: `This MCP URL is locked to ${displayEnvironmentName(locked)}.` }), "text/html; charset=utf-8");
          return;
        }
        if (!accountName) {
          text(res, 400, authorizePage({ origin, query: params, locked, error: "Choose an account name. Prod is never the default." }), "text/html; charset=utf-8");
          return;
        }
        let originOdoo;
        try {
          originOdoo = parseOdooOrigin(form.url, "Odoo URL");
        } catch (err) {
          text(res, 400, authorizePage({ origin, query: params, locked, error: err.message }), "text/html; charset=utf-8");
          return;
        }
        const apiKey = String(form.api_key || "").trim();
        const database = String(form.database || "").trim();
        if (!apiKey || !database) {
          text(res, 400, authorizePage({ origin, query: params, locked, error: "API key and database are required." }), "text/html; charset=utf-8");
          return;
        }
        const accountId = token();
        const code = token();
        await mutate(store, (data) => {
          data.accounts[accountId] = {
            id: accountId,
            name: accountName,
            label: displayEnvironmentName(accountName),
            url: originOdoo,
            apiKey,
            database,
            urlVar: "connected account",
            keyVar: "connected account API key",
            dbVar: "connected account database",
            production: isProductionEnvironment(accountName),
          };
          data.codes[code] = {
            clientId,
            redirectUri,
            challenge,
            accountId,
            exp: Date.now() + CODE_TTL_MS,
          };
        });
        const next = new URL(redirectUri);
        next.searchParams.set("code", code);
        if (state) next.searchParams.set("state", state);
        res.writeHead(302, { location: next.toString(), "cache-control": "no-store" });
        res.end();
        return;
      }

      if (url.pathname === "/oauth/token" && req.method === "POST") {
        await prune(store);
        const raw = await readBody(req);
        const form = raw.includes("=") ? parseForm(raw) : raw ? JSON.parse(raw) : {};
        if (form.grant_type === "authorization_code") {
          const row = (await readStore(store)).codes[form.code];
          if (!row || row.exp < Date.now() || row.clientId !== form.client_id || row.redirectUri !== form.redirect_uri || !verifyPkce(form.code_verifier, row.challenge)) {
            json(res, 400, { error: "invalid_grant" });
            return;
          }
          const access = token();
          const refresh = token();
          await mutate(store, (data) => {
            delete data.codes[form.code];
            data.tokens[access] = { kind: "access", accountId: row.accountId, exp: Date.now() + ACCESS_TTL_MS };
            data.tokens[refresh] = { kind: "refresh", accountId: row.accountId, exp: Date.now() + REFRESH_TTL_MS };
          });
          json(res, 200, {
            access_token: access,
            refresh_token: refresh,
            token_type: "bearer",
            expires_in: Math.floor(ACCESS_TTL_MS / 1000),
            scope: "odoo",
          });
          return;
        }
        if (form.grant_type === "refresh_token") {
          const row = (await readStore(store)).tokens[form.refresh_token];
          if (!row || row.kind !== "refresh" || row.exp < Date.now()) {
            json(res, 400, { error: "invalid_grant" });
            return;
          }
          const access = token();
          await mutate(store, (data) => {
            data.tokens[access] = { kind: "access", accountId: row.accountId, exp: Date.now() + ACCESS_TTL_MS };
          });
          json(res, 200, {
            access_token: access,
            refresh_token: form.refresh_token,
            token_type: "bearer",
            expires_in: Math.floor(ACCESS_TTL_MS / 1000),
            scope: "odoo",
          });
          return;
        }
        json(res, 400, { error: "unsupported_grant_type" });
        return;
      }

      const mcpPath = parseMcpPath(url.pathname);
      if (mcpPath) {
        if (req.method === "GET") {
          const account = await lookupAccount(store, bearer(req));
          if (!account || (mcpPath.locked && account.name !== mcpPath.locked)) {
            unauthorized(res, origin, mcpPath.suffix);
            return;
          }
          json(res, 200, { status: "ok", account: account.name, production: account.production === true });
          return;
        }
        if (req.method !== "POST") {
          json(res, 405, { error: "method_not_allowed" });
          return;
        }
        const account = await lookupAccount(store, bearer(req));
        if (!account || (mcpPath.locked && account.name !== mcpPath.locked)) {
          unauthorized(res, origin, mcpPath.suffix);
          return;
        }
        const raw = await readBody(req);
        let message;
        try {
          message = JSON.parse(raw);
        } catch {
          json(res, 400, { error: "invalid_json" });
          return;
        }
        const response = await handleJsonRpc(message, { instance: account });
        if (response == null) {
          res.writeHead(202, { "access-control-allow-origin": "*" });
          res.end();
          return;
        }
        json(res, 200, response, { "mcp-session-id": req.headers["mcp-session-id"] || token() });
        return;
      }

      json(res, 404, { error: "not_found" });
    } catch (err) {
      log(err);
      json(res, 500, { error: "server_error" });
    }
  };
}

export function startHttp(options = {}) {
  const port = options.port ?? DEFAULT_PORT;
  const server = createServer(createHttpHandler(options));

  return new Promise((resolveStart) => {
    server.listen(port, () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      resolveStart({
        server,
        port: actualPort,
        close: () =>
          new Promise((resolveClose) => {
            server.close(() => resolveClose());
          }),
      });
    });
  });
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === self) {
  startHttp({ store: createRuntimeStore() }).then(({ port }) => {
    log(`odoo-json2 ${SERVER_VERSION} HTTP MCP on :${port} (OAuth accounts)`);
  });
}
