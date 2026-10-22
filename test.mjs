#!/usr/bin/env node
/**
 * MCP stdio smoke test + mocked JSON-2 odoo_call.
 * Does not contact a real Odoo and does not use a live API key.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import {
  handleJsonRpc,
  parseOdooOrigin,
  assertPathSegment,
  buildOdooCall,
  isEntrypoint,
  loadEnvironments,
  resolveEnvironment,
  isProductionEnvironment,
  listTools,
  SERVER_VERSION,
  pickEnvironment,
} from "./server.mjs";
import {
  startHttp,
  createMemoryStore,
  createBlobJsonStore,
  createKvJsonStore,
  createRuntimeStore,
  createFileStore,
  parseBlobStoreId,
  selectStoreBackend,
  createPostgresJsonStore,
  emptyStore,
  OAUTH_MAPS,
  STORE_KINDS,
  authorizationServerMetadata,
  protectedResourceMetadata,
  parseMcpPath,
  lockedAccountFromAuthorizeQuery,
} from "./http.mjs";
import { runStoreCli } from "./store-cli.mjs";

const realFetch = globalThis.fetch.bind(globalThis);

const root = dirname(fileURLToPath(import.meta.url));
const DECO_ADDICT = [{ id: 25, name: "Deco Addict" }];

let failed = 0;
let passed = 0;

function ok(name) {
  passed += 1;
  process.stderr.write(`ok  ${name}\n`);
}

function fail(name, err) {
  failed += 1;
  process.stderr.write(`not ok  ${name}\n  ${err && err.stack ? err.stack : err}\n`);
}

function check(name, fn) {
  try {
    fn();
    ok(name);
  } catch (err) {
    fail(name, err);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    fail(name, err);
  }
}

function toolText(rpc) {
  assert.equal(rpc.jsonrpc, "2.0");
  assert.ok(rpc.result);
  assert.ok(Array.isArray(rpc.result.content));
  return rpc.result.content.map((c) => c.text).join("\n");
}

class StdioClient {
  constructor(child) {
    this.child = child;
    this.buf = "";
    this.queue = [];
    this.waiters = [];
    this.stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      this.buf += chunk;
      let nl;
      while ((nl = this.buf.indexOf("\n")) !== -1) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(msg);
        else this.queue.push(msg);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
  }

  send(obj) {
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  sendContentLength(obj) {
    const body = JSON.stringify(obj);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  }

  recv(timeoutMs = 5000) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for MCP response")), timeoutMs);
      this.waiters.push({
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
      });
    });
  }

  async request(id, method, params) {
    this.send({ jsonrpc: "2.0", id, method, params });
    const msg = await this.recv();
    assert.equal(msg.id, id);
    return msg;
  }

  close() {
    try {
      this.child.stdin.end();
    } catch {
      /* ignore */
    }
    this.child.kill("SIGTERM");
  }
}

function spawnServer(env = {}, entry = join(root, "server.mjs")) {
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return new StdioClient(child);
}

const fetchCalls = [];

function mockResponse(status, body, contentType = "application/json; charset=utf-8") {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => (String(n).toLowerCase() === "content-type" ? contentType : null) },
    async text() {
      return raw;
    },
    async json() {
      return JSON.parse(raw);
    },
  };
}

function installMockFetch() {
  fetchCalls.length = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : String(input.url);
    fetchCalls.push({
      url,
      method: init.method || "GET",
      headers: { ...(init.headers || {}) },
      body: init.body ?? null,
    });

    if (url.endsWith("/web/version") && (init.method || "GET") === "GET") {
      return mockResponse(200, { version: "19.0", version_info: [19, 0, 0, "final", 0, ""] });
    }

    if (url.endsWith("/json/2/res.partner/search_read")) {
      return mockResponse(200, DECO_ADDICT);
    }

    if (url.endsWith("/json/2/res.partner/unlink")) {
      return mockResponse(401, {
        name: "werkzeug.exceptions.Unauthorized",
        message: "Invalid apikey",
        arguments: ["Invalid apikey", 401],
        context: {},
        debug:
          'Traceback (most recent call last):\n  File "/opt/Odoo/community/odoo/http.py", line 2212, in _transactioning\n    raise werkzeug.exceptions.Unauthorized(\n',
      });
    }

    return mockResponse(404, { name: "NotFound", message: "unmocked URL" });
  };
}

// --- unit: origin + path segments ---

check("parseOdooOrigin accepts https origin", () => {
  assert.equal(parseOdooOrigin("https://mycompany.odoo.com"), "https://mycompany.odoo.com");
  assert.equal(parseOdooOrigin("https://mycompany.odoo.com/"), "https://mycompany.odoo.com");
});

check("parseOdooOrigin prepends https when scheme is omitted", () => {
  assert.equal(parseOdooOrigin("mycompany.odoo.com"), "https://mycompany.odoo.com");
  assert.equal(parseOdooOrigin("mycompany.odoo.com/"), "https://mycompany.odoo.com");
  assert.equal(parseOdooOrigin("  mycompany.odoo.com  "), "https://mycompany.odoo.com");
  assert.equal(parseOdooOrigin("http://localhost:8069"), "http://localhost:8069");
});

check("parseOdooOrigin rejects a path", () => {
  assert.throws(() => parseOdooOrigin("https://mycompany.odoo.com/json/2"), /origin only/);
  assert.throws(() => parseOdooOrigin("https://host/json/2"), /origin only/);
});

check("isEntrypoint follows npm bin symlinks", () => {
  const self = fileURLToPath(new URL("./server.mjs", import.meta.url));
  assert.equal(isEntrypoint(self, new URL("./server.mjs", import.meta.url).href), true);
  const dir = join(tmpdir(), `odoo-json2-bin-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const link = join(dir, "odoo-json2");
  symlinkSync(self, link);
  assert.equal(isEntrypoint(link, new URL("./server.mjs", import.meta.url).href), true);
  assert.equal(isEntrypoint(join(root, "test.mjs"), new URL("./server.mjs", import.meta.url).href), false);
});

check("assertPathSegment rejects slash and ..", () => {
  assert.equal(assertPathSegment("model", "res.partner"), "res.partner");
  assert.throws(() => assertPathSegment("model", "res/partner"), /invalid path segment/);
  assert.throws(() => assertPathSegment("method", ".."), /invalid path segment/);
  assert.throws(() => assertPathSegment("model", "res.partner/../evil"), /invalid path segment/);
  assert.throws(() => assertPathSegment("model", ""), /non-empty/);
});

check("buildOdooCall uses lowercase bearer and always sends X-Odoo-Database", () => {
  const searchRead = buildOdooCall({
    origin: "https://mycompany.example.com",
    apiKey: "test-key",
    database: "mycompany",
    model: "res.partner",
    method: "search_read",
    context: { lang: "en_US" },
    params: { domain: [["name", "ilike", "%deco%"]], fields: ["name"] },
  });
  assert.equal(searchRead.url, "https://mycompany.example.com/json/2/res.partner/search_read");
  assert.equal(searchRead.headers.Authorization, "bearer test-key");
  assert.equal(searchRead.headers["Content-Type"], "application/json; charset=utf-8");
  assert.equal(searchRead.headers["User-Agent"], "odoo-json2");
  assert.equal(searchRead.headers["X-Odoo-Database"], "mycompany");
  assert.deepEqual(searchRead.body, {
    context: { lang: "en_US" },
    domain: [["name", "ilike", "%deco%"]],
    fields: ["name"],
  });

  const read = buildOdooCall({
    origin: "https://mycompany.example.com",
    apiKey: "test-key",
    database: "mycompany",
    model: "res.partner",
    method: "read",
    ids: [25],
    params: { fields: ["name"] },
  });
  assert.equal(read.headers["X-Odoo-Database"], "mycompany");
  assert.deepEqual(read.body, { ids: [25], fields: ["name"] });
});

// --- MCP stdio: initialize + tools/list (+ ping, Content-Length) ---

await checkAsync("MCP stdio initialize, tools/list, ping", async () => {
  const client = spawnServer({
    ODOO_URL: "https://mycompany.example.com",
    ODOO_API_KEY: "test-key-not-live",
  });
  try {
    const init = await client.request(1, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "odoo-json2-test", version: "0.0.0" },
    });
    assert.equal(init.result.protocolVersion, "2025-03-26");
    assert.deepEqual(init.result.capabilities, { tools: {} });
    assert.equal(SERVER_VERSION, "0.3.2");
    assert.deepEqual(init.result.serverInfo, { name: "odoo-json2", version: SERVER_VERSION });

    client.send({ jsonrpc: "2.0", method: "notifications/initialized" });

    const listed = await client.request(2, "tools/list", {});
    const names = listed.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["odoo_call", "odoo_version"]);
    const call = listed.result.tools.find((t) => t.name === "odoo_call");
    assert.ok(call.inputSchema.required.includes("model"));
    assert.ok(call.inputSchema.required.includes("method"));

    const pong = await client.request(3, "ping");
    assert.deepEqual(pong.result, {});

    client.sendContentLength({ jsonrpc: "2.0", id: 4, method: "ping" });
    const pong2 = await client.recv();
    assert.equal(pong2.id, 4);
    assert.deepEqual(pong2.result, {});
  } finally {
    client.close();
  }
});

await checkAsync("MCP stdio via npm-style bin symlink (npx launch)", async () => {
  const dir = join(tmpdir(), `odoo-json2-npx-${process.pid}`);
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  const link = join(dir, "node_modules", ".bin", "odoo-json2");
  symlinkSync(join(root, "server.mjs"), link);
  const client = spawnServer({}, link);
  try {
    const init = await client.request(1, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "odoo-json2-test", version: "0.0.0" },
    });
    assert.deepEqual(init.result.serverInfo, { name: "odoo-json2", version: SERVER_VERSION });
    const listed = await client.request(2, "tools/list", {});
    assert.deepEqual(listed.result.tools.map((t) => t.name).sort(), ["odoo_call", "odoo_version"]);
  } finally {
    client.close();
  }
});

await checkAsync("MCP stdio via package bin wrapper", async () => {
  const client = spawnServer({}, join(root, "bin", "odoo-json2.mjs"));
  try {
    const listed = await client.request(1, "tools/list", {});
    assert.deepEqual(listed.result.tools.map((t) => t.name).sort(), ["odoo_call", "odoo_version"]);
  } finally {
    client.close();
  }
});

// --- mocked JSON-2 (docs deco/company search_read) ---

installMockFetch();
process.env.ODOO_URL = "https://mycompany.example.com";
process.env.ODOO_API_KEY = "test-key-not-live";
process.env.ODOO_DATABASE = "mycompany";

await checkAsync("odoo_call search_read returns docs Deco Addict payload", async () => {
  fetchCalls.length = 0;
  const rpc = await handleJsonRpc({
    jsonrpc: "2.0",
    id: 10,
    method: "tools/call",
    params: {
      name: "odoo_call",
      arguments: {
        model: "res.partner",
        method: "search_read",
        context: { lang: "en_US" },
        params: {
          domain: [
            ["name", "ilike", "%deco%"],
            ["is_company", "=", true],
          ],
          fields: ["name"],
        },
      },
    },
  });
  assert.equal(rpc.result.isError, undefined);
  const text = toolText(rpc);
  assert.match(text, /Deco Addict/);
  assert.match(text, /"id": 25/);
  assert.equal(fetchCalls.length, 1);
  const call = fetchCalls[0];
  assert.equal(call.method, "POST");
  assert.equal(call.url, "https://mycompany.example.com/json/2/res.partner/search_read");
  assert.equal(call.headers.Authorization, "bearer test-key-not-live");
  assert.equal(call.headers["X-Odoo-Database"], "mycompany");
  assert.equal(call.headers["User-Agent"], "odoo-json2");
  assert.deepEqual(JSON.parse(call.body), {
    context: { lang: "en_US" },
    domain: [
      ["name", "ilike", "%deco%"],
      ["is_company", "=", true],
    ],
    fields: ["name"],
  });
});

await checkAsync("odoo_version GET /web/version without Authorization or database", async () => {
  const prevDb = process.env.ODOO_DATABASE;
  const prevKey = process.env.ODOO_API_KEY;
  delete process.env.ODOO_DATABASE;
  delete process.env.ODOO_API_KEY;
  fetchCalls.length = 0;
  try {
    const rpc = await handleJsonRpc({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "odoo_version", arguments: {} },
    });
    const text = toolText(rpc);
    assert.match(text, /"version": "19.0"/);
    assert.match(text, /"account": "default"/);
    assert.match(text, /"origin": "https:\/\/mycompany.example.com"/);
    assert.equal(fetchCalls[0].url, "https://mycompany.example.com/web/version");
    assert.equal(fetchCalls[0].method, "GET");
    assert.equal(fetchCalls[0].headers.Authorization, undefined);
    assert.equal(fetchCalls[0].headers["X-Odoo-Database"], undefined);
  } finally {
    process.env.ODOO_DATABASE = prevDb;
    process.env.ODOO_API_KEY = prevKey;
  }
});

await checkAsync("HTTP error omits debug traceback by default", async () => {
  const rpc = await handleJsonRpc({
    jsonrpc: "2.0",
    id: 12,
    method: "tools/call",
    params: { name: "odoo_call", arguments: { model: "res.partner", method: "unlink", ids: [25] } },
  });
  assert.equal(rpc.result.isError, true);
  const text = toolText(rpc);
  assert.match(text, /HTTP 401/);
  assert.match(text, /werkzeug.exceptions.Unauthorized/);
  assert.match(text, /Invalid apikey/);
  assert.doesNotMatch(text, /Traceback/);
});

await checkAsync("missing ODOO_API_KEY is a clear tool error", async () => {
  const prev = process.env.ODOO_API_KEY;
  delete process.env.ODOO_API_KEY;
  try {
    const rpc = await handleJsonRpc({
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: { name: "odoo_call", arguments: { model: "res.partner", method: "search_read" } },
    });
    assert.equal(rpc.result.isError, true);
    assert.match(toolText(rpc), /ODOO_API_KEY is not set/);
  } finally {
    process.env.ODOO_API_KEY = prev;
  }
});

await checkAsync("missing ODOO_DATABASE on odoo_call is a clear tool error", async () => {
  const prev = process.env.ODOO_DATABASE;
  delete process.env.ODOO_DATABASE;
  try {
    const rpc = await handleJsonRpc({
      jsonrpc: "2.0",
      id: 15,
      method: "tools/call",
      params: { name: "odoo_call", arguments: { model: "res.partner", method: "search_read" } },
    });
    assert.equal(rpc.result.isError, true);
    assert.match(toolText(rpc), /ODOO_DATABASE is not set/);
  } finally {
    process.env.ODOO_DATABASE = prev;
  }
});

await checkAsync("invalid model does not call fetch", async () => {
  fetchCalls.length = 0;
  const rpc = await handleJsonRpc({
    jsonrpc: "2.0",
    id: 14,
    method: "tools/call",
    params: { name: "odoo_call", arguments: { model: "res.partner/../evil", method: "search_read" } },
  });
  assert.equal(rpc.result.isError, true);
  assert.match(toolText(rpc), /invalid path segment/);
  assert.equal(fetchCalls.length, 0);
});

const MULTI_ENV = {
  ODOO_ENVIRONMENTS: "dev,test,prod",
  ODOO_DEV_URL: "https://dev.example.com",
  ODOO_DEV_API_KEY: "dev-key",
  ODOO_DEV_DATABASE: "dev-db",
  ODOO_TEST_URL: "https://test.example.com",
  ODOO_TEST_API_KEY: "test-key",
  ODOO_TEST_DATABASE: "test-db",
  ODOO_PROD_URL: "https://prod.example.com",
  ODOO_PROD_API_KEY: "prod-key",
  ODOO_PROD_DATABASE: "prod-db",
};

check("loadEnvironments ignores pipeline leftovers such as ODOO_BASE_URL", () => {
  const instances = loadEnvironments({
    ODOO_URL: "https://legacy.example.com",
    ODOO_API_KEY: "legacy-key",
    ODOO_DATABASE: "legacy-db",
    ODOO_BASE_URL: "https://sandbox.example.com",
    ODOO_BASE_API_KEY: "",
  });
  assert.deepEqual(
    instances.map((i) => i.name),
    ["default"]
  );
});

check("ODOO_ENVIRONMENTS can name a custom instance", () => {
  const instances = loadEnvironments({
    ODOO_ENVIRONMENTS: "qa",
    ODOO_QA_URL: "https://qa.example.com",
    ODOO_QA_API_KEY: "qa-key",
    ODOO_QA_DATABASE: "qa-db",
  });
  assert.deepEqual(
    instances.map((i) => i.name),
    ["qa"]
  );
});

check("loadEnvironments discovers Dev/Test/Prod and ignores legacy trio", () => {
  const instances = loadEnvironments({
    ...MULTI_ENV,
    ODOO_URL: "https://legacy.example.com",
    ODOO_API_KEY: "legacy-key",
    ODOO_DATABASE: "legacy-db",
  });
  assert.deepEqual(
    instances.map((i) => i.name),
    ["dev", "test", "prod"]
  );
  assert.equal(isProductionEnvironment("prod"), true);
  assert.equal(isProductionEnvironment("dev"), false);
});

check("resolveEnvironment never silently picks Prod", () => {
  assert.equal(resolveEnvironment("dev", MULTI_ENV).url, "https://dev.example.com");
  assert.equal(resolveEnvironment("PROD", MULTI_ENV).name, "prod");
  assert.throws(() => resolveEnvironment(undefined, MULTI_ENV), /never the implicit default/);
  assert.throws(() => resolveEnvironment("", MULTI_ENV), /Environment Local → Connect/);
});

check("tools/list has no environment enum — account is host-selected", () => {
  const tools = listTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    ["odoo_call", "odoo_version"]
  );
  assert.equal(tools[0].inputSchema.properties.environment, undefined);
  assert.equal(tools[0].inputSchema.required.includes("environment"), false);
  assert.ok(tools[0].inputSchema.required.includes("model"));
});

await checkAsync("stdio multi-instance without a connected account does not fetch", async () => {
  fetchCalls.length = 0;
  const rpc = await handleJsonRpc(
    {
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: { name: "odoo_call", arguments: { model: "res.partner", method: "search_read" } },
    },
    { env: MULTI_ENV }
  );
  assert.equal(rpc.result.isError, true);
  assert.match(toolText(rpc), /Environment Local → Connect/);
  assert.equal(fetchCalls.length, 0);
});

await checkAsync("connected account instance is used instead of env default", async () => {
  fetchCalls.length = 0;
  const rpc = await handleJsonRpc(
    {
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: { name: "odoo_call", arguments: { model: "res.partner", method: "search_read" } },
    },
    {
      env: MULTI_ENV,
      instance: {
        name: "test",
        url: "https://test.example.com",
        apiKey: "test-key",
        database: "test-db",
        urlVar: "connected account",
        keyVar: "connected account API key",
        dbVar: "connected account database",
      },
    }
  );
  assert.equal(rpc.result.isError, undefined);
  assert.match(toolText(rpc), /Deco Addict/);
  assert.equal(fetchCalls[0].url, "https://test.example.com/json/2/res.partner/search_read");
  assert.equal(fetchCalls[0].headers.Authorization, "bearer test-key");
});

await checkAsync("explicit Prod account is allowed and still not implicit", async () => {
  fetchCalls.length = 0;
  const rpc = await handleJsonRpc(
    {
      jsonrpc: "2.0",
      id: 22,
      method: "tools/call",
      params: { name: "odoo_version", arguments: {} },
    },
    {
      instance: {
        name: "prod",
        url: "https://prod.example.com",
        apiKey: "prod-key",
        database: "prod-db",
        urlVar: "connected account",
        keyVar: "connected account API key",
        dbVar: "connected account database",
      },
    }
  );
  assert.match(toolText(rpc), /"account": "prod"/);
  assert.equal(fetchCalls[0].url, "https://prod.example.com/web/version");
});

function pkce() {
  const verifier = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

await checkAsync("HTTP OAuth connect Dev then call odoo_version on that account", async () => {
  installMockFetch();
  const store = createMemoryStore();
  const http = await startHttp({ store, port: 0 });
  const base = `http://127.0.0.1:${http.port}`;
  try {
    const prm = await (await realFetch(`${base}/.well-known/oauth-protected-resource`)).json();
    assert.equal(prm.resource, `${base}/mcp`);
    assert.deepEqual(authorizationServerMetadata(base).grant_types_supported, ["authorization_code", "refresh_token"]);
    assert.equal(protectedResourceMetadata(base).authorization_servers[0], base);

    const unauth = await realFetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    assert.equal(unauth.status, 401);
    assert.match(unauth.headers.get("www-authenticate") || "", /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource\/mcp"/);
    assert.equal(unauth.headers.get("access-control-expose-headers"), "WWW-Authenticate, Mcp-Session-Id");

    const registered = await (
      await realFetch(`${base}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "cursor-test",
          redirect_uris: ["http://localhost:8787/callback"],
          token_endpoint_auth_method: "none",
        }),
      })
    ).json();
    const { verifier, challenge } = pkce();
    const authorizeUrl = `${base}/oauth/authorize?response_type=code&client_id=${registered.client_id}&redirect_uri=${encodeURIComponent("http://localhost:8787/callback")}&code_challenge=${challenge}&code_challenge_method=S256&state=s1`;
    const form = new URLSearchParams({
      account: "dev",
      url: "https://dev.example.com",
      database: "dev-db",
      api_key: "dev-key",
    });
    const posted = await realFetch(authorizeUrl, { method: "POST", body: form, redirect: "manual" });
    assert.equal(posted.status, 302);
    const location = new URL(posted.headers.get("location"));
    assert.equal(location.searchParams.get("state"), "s1");
    const code = location.searchParams.get("code");

    const tokenBody = await (
      await realFetch(`${base}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: registered.client_id,
          redirect_uri: "http://localhost:8787/callback",
          code_verifier: verifier,
        }),
      })
    ).json();
    assert.ok(tokenBody.access_token);

    fetchCalls.length = 0;
    const mcp = await (
      await realFetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${tokenBody.access_token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "odoo_version", arguments: {} } }),
      })
    ).json();
    assert.match(mcp.result.content[0].text, /"account": "dev"/);
    assert.equal(fetchCalls[0].url, "https://dev.example.com/web/version");

    const listed = await (
      await realFetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${tokenBody.access_token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/list" }),
      })
    ).json();
    assert.deepEqual(
      listed.result.tools.map((t) => t.name),
      ["odoo_call", "odoo_version"]
    );
    assert.equal(listed.result.tools[0].inputSchema.properties.environment, undefined);
    assert.deepEqual(
      Object.keys(store.read()),
      OAUTH_MAPS.map((map) => map.name)
    );
  } finally {
    await http.close();
  }
});

await checkAsync("Notion dynamic registration and PKCE S256", async () => {
  const notionRedirect = "https://app.notion.com/workflows/mcp/oauth/callback";
  const store = createMemoryStore();
  const http = await startHttp({ store, port: 0 });
  const base = `http://127.0.0.1:${http.port}`;
  try {
    const rejected = await realFetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Notion",
        redirect_uris: ["https://evil.example/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).error, "invalid_redirect_uri");
    assert.deepEqual(Object.keys((await store.read()).clients), []);

    const registeredResponse = await realFetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: "Notion",
        redirect_uris: [notionRedirect],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: "mcp",
      }),
    });
    assert.equal(registeredResponse.status, 201);
    const registered = await registeredResponse.json();
    assert.equal(registered.client_name, "Notion");
    assert.equal(registered.token_endpoint_auth_method, "none");
    assert.equal(registered.client_secret, undefined);
    assert.deepEqual(registered.redirect_uris, [notionRedirect]);

    const { verifier, challenge } = pkce();
    const authorizeUrl = `${base}/oauth/authorize?response_type=code&client_id=${registered.client_id}&redirect_uri=${encodeURIComponent(notionRedirect)}&code_challenge=${challenge}&code_challenge_method=S256&state=notion-state&scope=mcp&resource=${encodeURIComponent(`${base}/mcp`)}`;
    const posted = await realFetch(authorizeUrl, {
      method: "POST",
      body: new URLSearchParams({
        account: "dev",
        url: "https://dev.example.com",
        database: "dev-db",
        api_key: "dev-key",
      }),
      redirect: "manual",
    });
    assert.equal(posted.status, 302);
    const location = new URL(posted.headers.get("location"));
    assert.equal(location.origin + location.pathname, notionRedirect);
    assert.equal(location.searchParams.get("state"), "notion-state");
    assert.equal(location.searchParams.get("iss"), base);
    const code = location.searchParams.get("code");

    const tokenResponse = await realFetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: registered.client_id,
        redirect_uri: notionRedirect,
        code_verifier: verifier,
      }),
    });
    assert.equal(tokenResponse.status, 200);
    const tokenBody = await tokenResponse.json();
    assert.equal(tokenBody.token_type, "bearer");
    assert.equal(tokenBody.scope, "mcp");
    assert.ok(tokenBody.access_token);
    assert.ok(tokenBody.refresh_token);

    const plain = await realFetch(`${base}/oauth/authorize?response_type=code&client_id=${registered.client_id}&redirect_uri=${encodeURIComponent(notionRedirect)}&code_challenge=${challenge}&code_challenge_method=plain`, {
      method: "POST",
      body: new URLSearchParams({ account: "dev", url: "https://dev.example.com", database: "dev-db", api_key: "dev-key" }),
      redirect: "manual",
    });
    assert.equal(plain.status, 400);
    assert.match(await plain.text(), /PKCE S256 is required/);

    const initialized = await realFetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${tokenBody.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Notion", version: "1.0" } },
      }),
    });
    assert.equal(initialized.status, 200);
    const initBody = await initialized.json();
    assert.equal(initBody.result.serverInfo.name, "odoo-json2");

    const refreshed = await (
      await realFetch(`${base}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokenBody.refresh_token,
          client_id: registered.client_id,
        }),
      })
    ).json();
    assert.ok(refreshed.access_token);
    assert.equal(refreshed.refresh_token, tokenBody.refresh_token);
    assert.equal(refreshed.scope, "mcp");
  } finally {
    await http.close();
  }
});

check("parseMcpPath and resource lock match Notion-style suffixes", () => {
  assert.deepEqual(parseMcpPath("/mcp"), { suffix: "", locked: "" });
  assert.deepEqual(parseMcpPath("/mcp/dev"), { suffix: "dev", locked: "dev" });
  assert.deepEqual(parseMcpPath("/mcp/prod"), { suffix: "prod", locked: "prod" });
  assert.equal(parseMcpPath("/oauth/authorize"), null);
  assert.equal(lockedAccountFromAuthorizeQuery({ resource: "https://odoo-json2.tylerjharden.dev/mcp/test" }), "test");
  assert.equal(protectedResourceMetadata("https://odoo-json2.tylerjharden.dev", "dev").resource, "https://odoo-json2.tylerjharden.dev/mcp/dev");
});

await checkAsync("HTTP /mcp/dev 401 and Dev token is rejected on /mcp/prod", async () => {
  const store = createMemoryStore();
  const http = await startHttp({ store, port: 0 });
  const base = `http://127.0.0.1:${http.port}`;
  try {
    const prm = await (await realFetch(`${base}/.well-known/oauth-protected-resource/mcp/dev`)).json();
    assert.equal(prm.resource, `${base}/mcp/dev`);
    assert.equal(prm.resource_name, "odoo-json2 dev");
    const unauth = await realFetch(`${base}/mcp/dev`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(unauth.status, 401);
    assert.match(unauth.headers.get("www-authenticate") || "", /oauth-protected-resource\/mcp\/dev/);

    const registered = await (
      await realFetch(`${base}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["http://localhost:8787/callback"] }),
      })
    ).json();
    const { verifier, challenge } = pkce();
    const authorizeUrl = `${base}/oauth/authorize?response_type=code&client_id=${registered.client_id}&redirect_uri=${encodeURIComponent("http://localhost:8787/callback")}&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(`${base}/mcp/dev`)}`;
    const posted = await realFetch(authorizeUrl, {
      method: "POST",
      body: new URLSearchParams({ url: "https://dev.example.com", database: "dev-db", api_key: "dev-key" }),
      redirect: "manual",
    });
    assert.equal(posted.status, 302);
    const code = new URL(posted.headers.get("location")).searchParams.get("code");
    const tokenBody = await (
      await realFetch(`${base}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: registered.client_id,
          redirect_uri: "http://localhost:8787/callback",
          code_verifier: verifier,
        }),
      })
    ).json();
    const headers = { "content-type": "application/json", authorization: `Bearer ${tokenBody.access_token}` };
    const okDev = await realFetch(`${base}/mcp/dev`, { method: "GET", headers });
    assert.equal(okDev.status, 200);
    assert.equal((await okDev.json()).account, "dev");
    const prod = await realFetch(`${base}/mcp/prod`, { method: "GET", headers });
    assert.equal(prod.status, 401);
  } finally {
    await http.close();
  }
});

await checkAsync("authorize form does not default the account to Prod", async () => {
  const http = await startHttp({ store: createMemoryStore(), port: 0 });
  const base = `http://127.0.0.1:${http.port}`;
  try {
    const page = await (await realFetch(`${base}/oauth/authorize?client_id=x`)).text();
    assert.match(page, /Choose Dev, Test, or Prod/);
    assert.match(page, /selected disabled/);
    assert.doesNotMatch(page, /option value="prod" selected/);
    await pickEnvironment({}, { env: {} }).then(
      () => {
        throw new Error("expected no account");
      },
      (err) => {
        assert.match(err.message, /Environment Local → Connect/);
      }
    );
  } finally {
    await http.close();
  }
});

function mockBlobFetch() {
  const files = new Map();
  const storeId = "teststoreid";
  const token = `vercel_blob_rw_${storeId}_secret`;
  const fetchImpl = async (url, init = {}) => {
    const method = (init.method || "GET").toUpperCase();
    const u = new URL(url, "https://example.test");
    if (method === "PUT") {
      const pathname = u.searchParams.get("pathname");
      files.set(pathname, String(init.body || ""));
      return {
        ok: true,
        status: 200,
        json: async () => ({ url: `https://${storeId}.private.blob.vercel-storage.com/${pathname}` }),
        text: async () => "{}",
      };
    }
    const pathname = u.pathname.replace(/^\//, "");
    if (!files.has(pathname)) {
      return { ok: false, status: 404, text: async () => "not found" };
    }
    const body = files.get(pathname);
    return { ok: true, status: 200, text: async () => body };
  };
  return { token, storeId, fetchImpl, files };
}

function mockKvFetch() {
  const values = new Map();
  const fetchImpl = async (_url, init) => {
    const [command, key, value] = JSON.parse(init.body);
    if (command === "SET") values.set(key, value);
    return mockResponse(200, { result: command === "GET" ? values.get(key) ?? null : "OK" });
  };
  return { values, fetchImpl };
}

await checkAsync("durable Blob store survives a second isolate with the same bearer", async () => {
  const blob = mockBlobFetch();
  assert.equal(parseBlobStoreId(blob.token), blob.storeId);
  assert.equal(parseBlobStoreId("vercel_blob_rw_store_c1JGan3ogrtP1NwR_secret"), "c1JGan3ogrtP1NwR");
  const isolateA = createBlobJsonStore({ token: blob.token, fetchImpl: blob.fetchImpl, storeId: blob.storeId });
  const httpA = await startHttp({ store: isolateA, port: 0 });
  const base = `http://127.0.0.1:${httpA.port}`;
  let accessToken;
  try {
    const registered = await (
      await realFetch(`${base}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["http://localhost:8787/callback"] }),
      })
    ).json();
    const { verifier, challenge } = pkce();
    const authorizeUrl = `${base}/oauth/authorize?response_type=code&client_id=${registered.client_id}&redirect_uri=${encodeURIComponent("http://localhost:8787/callback")}&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(`${base}/mcp/dev`)}`;
    const posted = await realFetch(authorizeUrl, {
      method: "POST",
      body: new URLSearchParams({ url: "https://dev.example.com", database: "dev-db", api_key: "dev-key" }),
      redirect: "manual",
    });
    const code = new URL(posted.headers.get("location")).searchParams.get("code");
    const tokenBody = await (
      await realFetch(`${base}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: registered.client_id,
          redirect_uri: "http://localhost:8787/callback",
          code_verifier: verifier,
        }),
      })
    ).json();
    accessToken = tokenBody.access_token;
    assert.ok(accessToken);
    const first = await realFetch(`${base}/mcp/dev`, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(first.status, 200);
  } finally {
    await httpA.close();
  }

  const isolateB = createBlobJsonStore({ token: blob.token, fetchImpl: blob.fetchImpl, storeId: blob.storeId });
  const httpB = await startHttp({ store: isolateB, port: 0 });
  const baseB = `http://127.0.0.1:${httpB.port}`;
  try {
    const later = await realFetch(`${baseB}/mcp/dev`, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(later.status, 200);
    assert.equal((await later.json()).account, "dev");
    const prod = await realFetch(`${baseB}/mcp/prod`, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(prod.status, 401);
  } finally {
    await httpB.close();
  }
});

check("createRuntimeStore prefers Blob over a local file path", () => {
  const blob = mockBlobFetch();
  const store = createRuntimeStore({
    BLOB_READ_WRITE_TOKEN: blob.token,
    ODOO_JSON2_STORE: "/tmp/should-not-use.json",
  });
  assert.equal(typeof store.read().then, "function");
  const file = createRuntimeStore({ ODOO_JSON2_STORE: "/tmp/odoo-json2-runtime-file.json" });
  assert.equal(typeof createFileStore, "function");
  file.write({ clients: { x: 1 }, codes: {}, tokens: {}, accounts: {} });
  assert.equal(file.read().clients.x, 1);
});

check("selectStoreBackend precedence is blob, kv, postgres, then file", () => {
  const databaseUrl = "postgres://db.example/odoo";
  const kv = { KV_REST_API_URL: "https://kv.example", KV_REST_API_TOKEN: "token" };
  assert.equal(
    selectStoreBackend({
      BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_store_secret",
      ...kv,
      DATABASE_URL: databaseUrl,
      ODOO_JSON2_STORE: "/tmp/store.json",
    }),
    "blob"
  );
  assert.equal(selectStoreBackend({ BLOB_READ_WRITE_TOKEN: " " }), "blob");
  assert.equal(selectStoreBackend({ ...kv, DATABASE_URL: databaseUrl }), "kv");
  assert.equal(selectStoreBackend({ KV_REST_API_URL: kv.KV_REST_API_URL, DATABASE_URL: databaseUrl }), "postgres");
  assert.equal(selectStoreBackend({ KV_REST_API_TOKEN: kv.KV_REST_API_TOKEN, DATABASE_URL: databaseUrl }), "postgres");
  assert.equal(selectStoreBackend({ DATABASE_URL: databaseUrl }), "postgres");
  assert.equal(selectStoreBackend({ DATABASE_URL: " " }), "postgres");
  assert.equal(selectStoreBackend({ DATABASE_URL: "" }), "file");
  assert.equal(
    selectStoreBackend({
      BLOB_READ_WRITE_TOKEN: "",
      KV_REST_API_URL: "",
      KV_REST_API_TOKEN: "",
      DATABASE_URL: "",
    }),
    "file"
  );
  assert.equal(selectStoreBackend({}), "file");
});

check("createRuntimeStore follows selectStoreBackend for blob, postgres, and file", () => {
  const blob = mockBlobFetch();
  const blobStore = createRuntimeStore({
    BLOB_READ_WRITE_TOKEN: blob.token,
    KV_REST_API_URL: "https://kv.example",
    KV_REST_API_TOKEN: "token",
    DATABASE_URL: "postgres://odoo:pw@127.0.0.1:1/db",
  });
  assert.equal(blobStore.close, undefined);
  const postgresStore = createRuntimeStore({
    KV_REST_API_URL: "https://kv.example",
    DATABASE_URL: "postgres://odoo:pw@127.0.0.1:1/db",
  });
  assert.equal(typeof postgresStore.close, "function");
  const file = createRuntimeStore({
    DATABASE_URL: "",
    KV_REST_API_TOKEN: "only-half",
    ODOO_JSON2_STORE: "/tmp/odoo-json2-empty-database-url.json",
  });
  assert.equal(file.close, undefined);
  file.write({ clients: { y: 1 }, codes: {}, tokens: {}, accounts: {} });
  assert.equal(file.read().clients.y, 1);
});

check("each store kind's default secret variables select that kind", () => {
  for (const [name, kind] of Object.entries(STORE_KINDS)) {
    const env = Object.fromEntries(
      Object.values(kind.slots)
        .filter((slot) => slot.secret)
        .map((slot) => [slot.env, "set"])
    );
    assert.equal(selectStoreBackend(env), name);
  }
});

await checkAsync("store load tells a missing document from a stored one", async () => {
  const doc = sampleOAuthDocument();
  const dir = join(tmpdir(), `odoo-json2-load-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  const path = join(dir, "store.json");
  const file = createFileStore(path);
  assert.deepEqual(file.load(), { found: false });
  assert.deepEqual(file.read(), emptyStore());
  file.write(doc);
  assert.deepEqual(file.load(), { found: true, text: JSON.stringify(doc) });
  writeFileSync(path, "{not json");
  assert.deepEqual(file.load(), { found: true, text: "{not json" });
  assert.deepEqual(file.read(), emptyStore());

  const blob = mockBlobFetch();
  const blobStore = createBlobJsonStore({ token: blob.token, fetchImpl: blob.fetchImpl });
  assert.deepEqual(await blobStore.load(), { found: false });
  assert.deepEqual(await blobStore.read(), emptyStore());
  await blobStore.write(doc);
  assert.deepEqual(await blobStore.load(), { found: true, text: JSON.stringify(doc) });
  assert.deepEqual(await blobStore.read(), doc);

  const kv = mockKvFetch();
  const kvStore = createKvJsonStore({ url: "https://kv.example", token: "kv-token", fetchImpl: kv.fetchImpl });
  assert.deepEqual(await kvStore.load(), { found: false });
  assert.deepEqual(await kvStore.read(), emptyStore());
  await kvStore.write(doc);
  assert.deepEqual(await kvStore.load(), { found: true, text: JSON.stringify(doc) });
  assert.deepEqual(await kvStore.read(), doc);

  assert.deepEqual(createMemoryStore(null).load(), { found: false });
  assert.deepEqual(createMemoryStore(doc).load(), { found: true, text: JSON.stringify(doc) });
});

check("file store creates its directory on write and replaces the file with mode 0600", () => {
  const dir = join(tmpdir(), `odoo-json2-write-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  const path = join(dir, "nested", "store.json");
  const store = createFileStore(path);
  assert.equal(existsSync(dir), false);
  store.write(emptyStore());
  assert.equal(statSync(path).mode & 0o777, 0o600);
  chmodSync(path, 0o644);
  store.write(sampleOAuthDocument());
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(join(dir, "nested")), ["store.json"]);
  assert.deepEqual(store.read(), sampleOAuthDocument());
});

await checkAsync("blob and kv stores never fall back to ambient credentials", async () => {
  const names = ["BLOB_READ_WRITE_TOKEN", "KV_REST_API_URL", "KV_REST_API_TOKEN"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const blob = mockBlobFetch();
  process.env.BLOB_READ_WRITE_TOKEN = blob.token;
  process.env.KV_REST_API_URL = "https://ambient-kv.example";
  process.env.KV_REST_API_TOKEN = "ambient-kv-token";
  try {
    await assert.rejects(createBlobJsonStore({ fetchImpl: blob.fetchImpl }).load(), /store id missing/);
    const sent = [];
    const kvStore = createKvJsonStore({
      fetchImpl: async (url, init) => {
        sent.push([url, init.headers.authorization]);
        return mockResponse(200, { result: null });
      },
    });
    await kvStore.load();
    assert.deepEqual(sent, [["", "Bearer "]]);
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

function sampleOAuthDocument() {
  return {
    clients: {
      "client-1": {
        client_id: "client-1",
        redirect_uris: ["http://localhost:8787/callback"],
        token_endpoint_auth_method: "none",
        client_name: "cursor",
      },
    },
    codes: {},
    tokens: {
      "raw-token-key": { kind: "access", accountId: "dev", exp: 1 },
    },
    accounts: {
      dev: {
        id: "dev",
        name: "dev",
        label: "Dev",
        url: "https://dev.example.com",
        apiKey: "secret-key",
        database: "dev-db",
        urlVar: "connected account",
        keyVar: "connected account API key",
        dbVar: "connected account database",
        production: false,
      },
    },
  };
}

const STORE_NOW = Date.parse("2026-10-22T00:00:00Z");
const STORE_DATABASE_URL = "postgres://odoo:pw-9f3a@db.test/odoo";
const BLOB_TO_POSTGRES = ["--from", "blob:token=LEGACY_BLOB_TOKEN", "--to", "postgres"];
const BLOB_PATH = "odoo-json2-oauth-store.json";

function storeFixture() {
  const doc = sampleOAuthDocument();
  doc.codes["raw-code-key"] = {
    clientId: "client-1",
    redirectUri: "http://localhost:8787/callback",
    challenge: "challenge",
    accountId: "dev",
    exp: STORE_NOW + 60_000,
  };
  doc.tokens["raw-token-key"] = { kind: "refresh", accountId: "dev", exp: STORE_NOW + 3_600_000 };
  doc.tokens["expired-token-key"] = { kind: "access", accountId: "dev", exp: STORE_NOW - 1 };
  return doc;
}

async function seedBlob(blob, doc) {
  await createBlobJsonStore({ token: blob.token, storeId: blob.storeId, fetchImpl: blob.fetchImpl }).write(doc);
}

function sortedKeys(_key, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)));
}

// jsonb reorders object keys, so the stand-in hands back sorted keys.
function postgresStandIn(initial = null) {
  let text = initial === null || typeof initial === "string" ? initial : JSON.stringify(initial, sortedKeys);
  const pg = {
    writes: 0,
    load: async () => (text === null ? { found: false } : { found: true, text }),
    write: async (doc) => {
      pg.writes += 1;
      text = JSON.stringify(doc, sortedKeys);
    },
    doc: () => JSON.parse(text),
  };
  return pg;
}

function storeIo({ blob, pg, prompt = null }) {
  const lines = [];
  const opened = [];
  let blobPuts = 0;
  const fetchImpl = (url, init = {}) => {
    if (init.method === "PUT") blobPuts += 1;
    return blob.fetchImpl(url, init);
  };
  const io = {
    env: { LEGACY_BLOB_TOKEN: blob.token, DATABASE_URL: STORE_DATABASE_URL },
    kinds: {
      ...STORE_KINDS,
      blob: {
        ...STORE_KINDS.blob,
        open: (config) => {
          opened.push(["blob", config.token]);
          return createBlobJsonStore({ token: config.token, pathname: config.path, storeId: blob.storeId, fetchImpl });
        },
      },
      postgres: {
        ...STORE_KINDS.postgres,
        open: (config) => {
          opened.push(["postgres", config.url]);
          return pg;
        },
      },
    },
    now: () => STORE_NOW,
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
    prompt,
  };
  return { io, lines, opened, blobPuts: () => blobPuts };
}

function scriptedPrompt(answers) {
  const asked = [];
  return {
    asked,
    ask: async (question) => {
      asked.push(question);
      if (!answers.length) throw new Error("unexpected prompt");
      return answers.shift();
    },
    close() {},
  };
}

function assertNoStoreSecrets(lines, blob) {
  const text = lines.join("\n");
  for (const secret of [blob.token, STORE_DATABASE_URL, "pw-9f3a", "secret-key", "raw-token-key", "raw-code-key", "expired-token-key"]) {
    assert.equal(text.includes(secret), false, "store output holds a fixture secret");
  }
}

function assertCopied(written) {
  const fixture = storeFixture();
  assert.deepEqual(written.clients, fixture.clients);
  assert.deepEqual(written.accounts, fixture.accounts);
  assert.deepEqual(written.tokens, { "raw-token-key": fixture.tokens["raw-token-key"] });
  assert.deepEqual(written.codes, {});
}

await checkAsync("store sync copies Blob into Postgres and a second run changes nothing", async () => {
  const blob = mockBlobFetch();
  await seedBlob(blob, storeFixture());
  const pg = postgresStandIn();
  const { io, lines, opened } = storeIo({ blob, pg });
  const argv = ["sync", ...BLOB_TO_POSTGRES, "--apply"];
  assert.equal(await runStoreCli(argv, io), 0);
  assert.deepEqual(opened, [
    ["blob", blob.token],
    ["postgres", STORE_DATABASE_URL],
  ]);
  assertCopied(pg.doc());
  assert.equal(pg.writes, 1);
  const tokenLabel = `#${createHash("sha256").update("raw-token-key").digest("hex").slice(0, 8)}`;
  assert.ok(lines.some((line) => line.startsWith(`+ tokens/${tokenLabel}`)));
  assert.equal(await runStoreCli(argv, io), 0);
  assert.equal(pg.writes, 1);
  assert.equal(lines.at(-1), "Nothing to change.");
  assertNoStoreSecrets(lines, blob);
});

await checkAsync("store sync copies Postgres into Blob and a second run changes nothing", async () => {
  const blob = mockBlobFetch();
  const pg = postgresStandIn(storeFixture());
  const { io, lines, blobPuts } = storeIo({ blob, pg });
  const argv = ["sync", "--from", "postgres", "--to", "blob:token=LEGACY_BLOB_TOKEN", "--apply"];
  assert.equal(await runStoreCli(argv, io), 0);
  assertCopied(JSON.parse(blob.files.get(BLOB_PATH)));
  assert.equal(blobPuts(), 1);
  assert.equal(await runStoreCli(argv, io), 0);
  assert.equal(blobPuts(), 1);
  assert.equal(pg.writes, 0);
  assert.equal(lines.at(-1), "Nothing to change.");
  assertNoStoreSecrets(lines, blob);
});

await checkAsync("store sync writes a differing client only with --prefer", async () => {
  const blob = mockBlobFetch();
  await seedBlob(blob, storeFixture());
  const renamed = { ...storeFixture().clients["client-1"], client_name: "renamed" };
  const pg = postgresStandIn({ ...emptyStore(), clients: { "client-1": renamed } });
  const { io, lines } = storeIo({ blob, pg });
  assert.equal(await runStoreCli(["sync", ...BLOB_TO_POSTGRES, "--apply"], io), 2);
  assert.equal(pg.writes, 0);
  assert.ok(lines.some((line) => line.startsWith("! clients/client-1") && line.includes("client_name")));
  assert.equal(await runStoreCli(["sync", ...BLOB_TO_POSTGRES, "--apply", "--prefer", "target"], io), 0);
  assert.deepEqual(pg.doc().clients["client-1"], renamed);
  assert.deepEqual(pg.doc().accounts, storeFixture().accounts);
  assert.equal(await runStoreCli(["sync", ...BLOB_TO_POSTGRES, "--apply", "--prefer", "source"], io), 0);
  assert.deepEqual(pg.doc().clients["client-1"], storeFixture().clients["client-1"]);
});

await checkAsync("store migrate refuses a target that holds a record and fills an empty one", async () => {
  const blob = mockBlobFetch();
  await seedBlob(blob, storeFixture());
  const held = postgresStandIn({ ...emptyStore(), tokens: { "old-token": { kind: "access", accountId: "x", exp: 1 } } });
  assert.equal(await runStoreCli(["migrate", ...BLOB_TO_POSTGRES, "--apply"], storeIo({ blob, pg: held }).io), 2);
  assert.equal(held.writes, 0);
  const empty = postgresStandIn();
  assert.equal(await runStoreCli(["migrate", ...BLOB_TO_POSTGRES, "--apply"], storeIo({ blob, pg: empty }).io), 0);
  assertCopied(empty.doc());
});

await checkAsync("store refuses an absent or corrupt source and a corrupt target without writing", async () => {
  const blob = mockBlobFetch();
  const pg = postgresStandIn();
  const { io, lines } = storeIo({ blob, pg });
  const argv = ["sync", ...BLOB_TO_POSTGRES, "--apply"];
  assert.equal(await runStoreCli(argv, io), 2);
  blob.files.set(BLOB_PATH, '{"raw-code-key": x}');
  assert.equal(await runStoreCli(argv, io), 2);
  blob.files.set(BLOB_PATH, JSON.stringify({ ...emptyStore(), clients: ["client-1"] }));
  assert.equal(await runStoreCli(argv, io), 2);
  assert.equal(pg.writes, 0);
  await seedBlob(blob, storeFixture());
  const corruptTarget = postgresStandIn("{not json");
  assert.equal(await runStoreCli(argv, storeIo({ blob, pg: corruptTarget }).io), 2);
  assert.equal(corruptTarget.writes, 0);
  assert.equal(lines.join("\n").includes("raw-code-key"), false);
});

await checkAsync("store refuses --since, missing flags off a terminal, and one store on both sides", async () => {
  const blob = mockBlobFetch();
  await seedBlob(blob, storeFixture());
  const pg = postgresStandIn();
  const { io, lines, opened } = storeIo({ blob, pg });
  assert.equal(await runStoreCli(["sync", ...BLOB_TO_POSTGRES, "--apply", "--since", "2026-10-01T00:00:00Z"], io), 2);
  assert.equal(await runStoreCli(["sync", "--from", "blob:token=LEGACY_BLOB_TOKEN", "--apply"], io), 2);
  assert.match(lines.at(-1), /--to/);
  assert.equal(await runStoreCli(["sync", "--from", "postgres", "--to", "postgres", "--apply"], io), 2);
  assert.deepEqual(opened, []);
  assert.equal(pg.writes, 0);
  const bin = spawnSync(process.execPath, [join(root, "bin", "odoo-json2.mjs"), "store", "sync", "--from", "file"], {
    cwd: tmpdir(),
    encoding: "utf8",
    input: "",
  });
  assert.equal(bin.status, 2);
  assert.match(bin.stderr, /--to/);
});

await checkAsync("store blocks a record Postgres cannot hold and copies the rest", async () => {
  const blob = mockBlobFetch();
  const doc = storeFixture();
  doc.clients["client-nul"] = { ...doc.clients["client-1"], client_id: "client-nul", client_name: "bad\u0000name" };
  doc.accounts["field-nul"] = { ...doc.accounts.dev, id: "field-nul", "note\u0000": "x" };
  await seedBlob(blob, doc);
  const pg = postgresStandIn();
  const { io, lines } = storeIo({ blob, pg });
  assert.equal(await runStoreCli(["sync", ...BLOB_TO_POSTGRES, "--apply"], io), 0);
  assertCopied(pg.doc());
  assert.ok(lines.some((line) => line.startsWith("x clients/client-nul")));
  assert.ok(lines.some((line) => line.startsWith("x accounts/field-nul")));
  assert.equal(lines.join("\n").includes("\u0000"), false);
});

await checkAsync("store writes nothing when the target changes after the preview", async () => {
  const blob = mockBlobFetch();
  await seedBlob(blob, storeFixture());
  const serverClient = { ...storeFixture().clients["client-1"], client_name: "written by the server" };
  const loads = [{ found: false }, { found: true, text: JSON.stringify({ ...emptyStore(), clients: { "client-1": serverClient } }) }];
  const pg = {
    writes: 0,
    load: async () => loads.shift(),
    write: async () => {
      pg.writes += 1;
    },
  };
  assert.equal(await runStoreCli(["sync", ...BLOB_TO_POSTGRES, "--apply"], storeIo({ blob, pg }).io), 1);
  assert.equal(pg.writes, 0);
});

await checkAsync("store names each record the target did not keep", async () => {
  const blob = mockBlobFetch();
  await seedBlob(blob, storeFixture());
  const pg = postgresStandIn();
  const write = pg.write;
  pg.write = (doc) => write({ ...doc, accounts: {} });
  const { io, lines } = storeIo({ blob, pg });
  assert.equal(await runStoreCli(["sync", ...BLOB_TO_POSTGRES, "--apply"], io), 1);
  assert.ok(lines.includes("Not verified: accounts/dev"));
  assert.match(lines.at(-1), /Verified 2 of 3\.$/);
});

await checkAsync("store hides document secrets when a write error echoes the document", async () => {
  const blob = mockBlobFetch();
  await seedBlob(blob, storeFixture());
  const pg = postgresStandIn();
  pg.write = async (doc) => {
    throw new Error(`invalid input syntax for type json. JSON data: ${JSON.stringify(doc)}`);
  };
  const { io, lines } = storeIo({ blob, pg });
  assert.equal(await runStoreCli(["sync", ...BLOB_TO_POSTGRES, "--apply"], io), 1);
  assert.match(lines.at(-1), /invalid input syntax/);
  assertNoStoreSecrets(lines, blob);
});

await checkAsync("store asks for missing flags on a terminal and writes only after yes", async () => {
  const blob = mockBlobFetch();
  await seedBlob(blob, storeFixture());
  const pg = postgresStandIn();
  const argv = ["sync", "--from", "blob:token=LEGACY_BLOB_TOKEN"];
  const declined = scriptedPrompt(["postgres", "", "n"]);
  assert.equal(await runStoreCli(argv, storeIo({ blob, pg, prompt: declined }).io), 0);
  assert.equal(pg.writes, 0);
  assert.ok(declined.asked.some((question) => question.includes("[DATABASE_URL, set]")));
  assert.equal(declined.asked.join("\n").includes("pw-9f3a"), false);
  const accepted = scriptedPrompt(["postgres", "", "y"]);
  assert.equal(await runStoreCli(argv, storeIo({ blob, pg, prompt: accepted }).io), 0);
  assertCopied(pg.doc());
  const untouched = postgresStandIn();
  const complete = scriptedPrompt([]);
  assert.equal(await runStoreCli(["sync", ...BLOB_TO_POSTGRES], storeIo({ blob, pg: untouched, prompt: complete }).io), 0);
  assert.deepEqual(complete.asked, []);
  assert.equal(untouched.writes, 0);
});

await checkAsync("store asks which side wins a differing record on a terminal", async () => {
  const blob = mockBlobFetch();
  await seedBlob(blob, storeFixture());
  const renamed = { ...storeFixture().clients["client-1"], client_name: "renamed" };
  const argv = ["sync", "--from", "blob:token=LEGACY_BLOB_TOKEN"];
  const aborted = postgresStandIn({ ...emptyStore(), clients: { "client-1": renamed } });
  assert.equal(await runStoreCli(argv, storeIo({ blob, pg: aborted, prompt: scriptedPrompt(["postgres", "", ""]) }).io), 2);
  assert.equal(aborted.writes, 0);
  const keptTarget = postgresStandIn({ ...emptyStore(), clients: { "client-1": renamed } });
  assert.equal(await runStoreCli(argv, storeIo({ blob, pg: keptTarget, prompt: scriptedPrompt(["postgres", "", "t", "y"]) }).io), 0);
  assert.deepEqual(keptTarget.doc().clients["client-1"], renamed);
  const keptSource = postgresStandIn({ ...emptyStore(), clients: { "client-1": renamed } });
  assert.equal(await runStoreCli(argv, storeIo({ blob, pg: keptSource, prompt: scriptedPrompt(["postgres", "", "s", "y"]) }).io), 0);
  assert.deepEqual(keptSource.doc().clients["client-1"], storeFixture().clients["client-1"]);
});

await checkAsync("store refuses a pasted secret in a spec without printing it", async () => {
  const blob = mockBlobFetch();
  const { io, lines, opened } = storeIo({ blob, pg: postgresStandIn() });
  assert.equal(await runStoreCli(["sync", "--from", "blob:token=vercel_blob_rw_pasted_9f3a7c", "--to", "postgres"], io), 2);
  assert.equal(lines.at(-1), "blob token= names a variable that is not set.");
  const pastedUrl = "postgres:url=postgres://odoo:pasted-pw@db.test/odoo";
  assert.equal(await runStoreCli(["sync", "--from", "blob:token=LEGACY_BLOB_TOKEN", "--to", pastedUrl], io), 2);
  assert.equal(lines.at(-1), "postgres url= takes the name of an environment variable, not its value.");
  assert.deepEqual(opened, []);
  const text = lines.join("\n");
  assert.equal(text.includes("pasted_9f3a7c"), false);
  assert.equal(text.includes("pasted-pw"), false);
});

await checkAsync("refused postgres connection hides the password", async () => {
  await import("pg");
  const password = "pw-do-not-leak-9f3a";
  const connectionString = `postgres://odoo:${password}@127.0.0.1:1/odoo_json2`;
  const store = createPostgresJsonStore({ connectionString });
  let thrown = null;
  try {
    await store.read();
  } catch (err) {
    thrown = err;
  } finally {
    await store.close();
  }
  assert.ok(thrown, "expected the refused connection to throw");
  const text = `${thrown.message}\n${thrown.stack}`;
  assert.equal(text.includes(password), false);
  assert.equal(text.includes(connectionString), false);
});

const postgresTestUrl = process.env.ODOO_JSON2_TEST_DATABASE_URL || "";
if (!postgresTestUrl) {
  if (process.env.ODOO_JSON2_REQUIRE_POSTGRES) {
    fail("postgres integration", new Error("ODOO_JSON2_TEST_DATABASE_URL is required when ODOO_JSON2_REQUIRE_POSTGRES is set"));
  }
} else {
  await checkAsync("postgres store round-trips account fields and a raw token key", async () => {
    const doc = sampleOAuthDocument();
    const writer = createPostgresJsonStore({ connectionString: postgresTestUrl });
    const reader = createPostgresJsonStore({ connectionString: postgresTestUrl });
    try {
      await writer.write(doc);
      const got = await reader.read();
      assert.equal(got.accounts.dev.apiKey, "secret-key");
      assert.deepEqual(got.accounts.dev, doc.accounts.dev);
      assert.deepEqual(got.tokens["raw-token-key"], doc.tokens["raw-token-key"]);
      assert.deepEqual(got, doc);
    } finally {
      await writer.close();
      await reader.close();
    }
  });

  await checkAsync("postgres setup does not wipe a stored document", async () => {
    const { Client } = await import("pg");
    const admin = new Client({ connectionString: postgresTestUrl });
    const stores = [];
    try {
      await admin.connect();
      await admin.query("DROP TABLE IF EXISTS public.odoo_json2_oauth_store");
      for (let i = 0; i < 5; i += 1) stores.push(createPostgresJsonStore({ connectionString: postgresTestUrl }));
      const docs = await Promise.all(stores.map((store) => store.read()));
      for (const doc of docs) assert.deepEqual(doc, emptyStore());
      const next = sampleOAuthDocument();
      await stores[0].write(next);
      const later = createPostgresJsonStore({ connectionString: postgresTestUrl });
      stores.push(later);
      assert.deepEqual(await later.read(), next);
    } finally {
      await admin.end().catch(() => undefined);
      await Promise.all(stores.map((store) => store.close()));
    }
  });

  await checkAsync("postgres load reports a missing row, then the stored document", async () => {
    const { Client } = await import("pg");
    const admin = new Client({ connectionString: postgresTestUrl });
    const store = createPostgresJsonStore({ connectionString: postgresTestUrl });
    try {
      await admin.connect();
      await admin.query("DROP TABLE IF EXISTS public.odoo_json2_oauth_store");
      assert.deepEqual(await store.load(), { found: false });
      assert.deepEqual(await store.read(), emptyStore());
      await store.write(sampleOAuthDocument());
      const loaded = await store.load();
      assert.equal(loaded.found, true);
      assert.deepEqual(JSON.parse(loaded.text), sampleOAuthDocument());
    } finally {
      await store.close();
      await admin.end().catch(() => undefined);
    }
  });

  await checkAsync("postgres read throws when the table is missing", async () => {
    const { Client } = await import("pg");
    const admin = new Client({ connectionString: postgresTestUrl });
    const store = createPostgresJsonStore({ connectionString: postgresTestUrl });
    let sqlError = null;
    try {
      await admin.connect();
      await store.write(sampleOAuthDocument());
      await admin.query("DROP TABLE public.odoo_json2_oauth_store");
      try {
        await store.read();
      } catch (err) {
        sqlError = err;
      }
      assert.ok(sqlError, "expected a SQL error after the table was dropped");
      assert.match(sqlError.message, /odoo_json2_oauth_store/);
      assert.equal(String(sqlError.message).includes("secret-key"), false);
    } finally {
      await store.close();
      await admin.end().catch(() => undefined);
    }
  });
}

process.stderr.write(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
