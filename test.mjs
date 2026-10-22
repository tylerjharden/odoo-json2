#!/usr/bin/env node
/**
 * MCP stdio smoke test + mocked JSON-2 odoo_call.
 * Does not contact a real Odoo and does not use a live API key.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, symlinkSync } from "node:fs";
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
  createRuntimeStore,
  createFileStore,
  parseBlobStoreId,
  selectStoreBackend,
  createPostgresJsonStore,
  emptyStore,
  authorizationServerMetadata,
  protectedResourceMetadata,
  parseMcpPath,
  lockedAccountFromAuthorizeQuery,
} from "./http.mjs";
import {
  NEON_BRANCH_PROD,
  NEON_BRANCH_SHARED_DEV,
  assertPreviewStore,
  normalizeNeonHost,
  removePreviewPr,
} from "./preview-store.mjs";
import { runPreviewWorkflow } from "./scripts/preview-branch.mjs";

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
    assert.match(unauth.headers.get("www-authenticate") || "", /resource_metadata=/);

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

const previewPassword = "pw-preview-9f3a";
const previewDatabaseUrl = `postgres://odoo:${previewPassword}@ep-pr-pooler.c-3.us-east-1.aws.neon.tech/neondb`;

function previewGuardEnv(overrides = {}) {
  return {
    VERCEL_ENV: "preview",
    VERCEL_GIT_PULL_REQUEST_ID: "12",
    DATABASE_URL: previewDatabaseUrl,
    NEON_BRANCH_ID: "br-preview-branch",
    NEON_ENDPOINT_HOST: "ep-pr.c-3.us-east-1.aws.neon.tech",
    NEON_PREVIEW_DENY_HOSTS: "ep-prod.us-east-1.aws.neon.tech, ep-dev-pooler.us-east-1.aws.neon.tech",
    ...overrides,
  };
}

function refusesPreview(env, secret) {
  let error = null;
  try {
    assertPreviewStore(env, selectStoreBackend(env));
  } catch (err) {
    error = err;
  }
  assert.ok(error, "preview guard should refuse this env");
  assert.equal(error.message.includes(secret), false);
  assert.equal(error.message.includes(previewPassword), false);
  return error;
}

check("preview store refuses blob, production, shared dev, and a mismatched host", () => {
  const blob = refusesPreview(previewGuardEnv({ BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_store_secret_token" }), "vercel_blob_rw_store_secret_token");
  assert.match(blob.message, /refuses the blob store/);
  assert.match(refusesPreview(previewGuardEnv({ NEON_BRANCH_ID: NEON_BRANCH_PROD })).message, /production or the shared dev/);
  assert.match(refusesPreview(previewGuardEnv({ NEON_BRANCH_ID: NEON_BRANCH_SHARED_DEV })).message, /production or the shared dev/);
  assert.match(refusesPreview(previewGuardEnv({ NEON_BRANCH_ID: "" })).message, /NEON_BRANCH_ID/);
  assert.match(refusesPreview(previewGuardEnv({ NEON_ENDPOINT_HOST: "ep-other.us-east-1.aws.neon.tech" })).message, /does not match/);
  assert.match(refusesPreview(previewGuardEnv({ NEON_PREVIEW_DENY_HOSTS: "" })).message, /NEON_PREVIEW_DENY_HOSTS/);
  assert.match(
    refusesPreview(previewGuardEnv({
      DATABASE_URL: `postgres://odoo:${previewPassword}@ep-prod-pooler.us-east-1.aws.neon.tech/neondb`,
      NEON_ENDPOINT_HOST: "ep-prod.us-east-1.aws.neon.tech",
    })).message,
    /not allowed/,
  );
  assert.equal(normalizeNeonHost("ep-pr-pooler.c-3.us-east-1.aws.neon.tech"), "ep-pr.c-3.us-east-1.aws.neon.tech");
});

await checkAsync("preview store accepts its own Neon branch", async () => {
  assertPreviewStore(previewGuardEnv(), "postgres");
  const store = createRuntimeStore(previewGuardEnv());
  assert.equal(typeof store.read, "function");
  await store.close();
});

check("a non-preview process does not apply the preview guard", () => {
  assertPreviewStore({ BLOB_READ_WRITE_TOKEN: "blob-token", DATABASE_URL: previewDatabaseUrl }, "blob");
});

await checkAsync("preview oauth records carry previewPr and a second sweep removes nothing", async () => {
  const store = createMemoryStore();
  store.write({
    clients: { keeper: { client_id: "keeper", client_name: "kept", redirect_uris: ["http://localhost:8787/callback"] } },
    codes: {},
    tokens: {},
    accounts: { other: { id: "other", name: "dev", previewPr: 99, apiKey: "other-key" } },
  });
  const http = await startHttp({
    store,
    port: 0,
    env: { VERCEL_ENV: "preview", VERCEL_GIT_PULL_REQUEST_ID: "12" },
  });
  const base = `http://127.0.0.1:${http.port}`;
  try {
    const registered = await (
      await realFetch(`${base}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "preview-client",
          redirect_uris: ["http://localhost:8787/callback"],
        }),
      })
    ).json();
    const { verifier, challenge } = pkce();
    const authorizeUrl = `${base}/oauth/authorize?response_type=code&client_id=${registered.client_id}&redirect_uri=${encodeURIComponent("http://localhost:8787/callback")}&code_challenge=${challenge}&code_challenge_method=S256&state=s1`;
    const posted = await realFetch(authorizeUrl, {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams({ account: "dev", url: "https://dev.example.com", database: "dev-db", api_key: "dev-key" }),
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
    assert.ok(tokenBody.access_token);
    const doc = store.read();
    assert.equal(doc.clients.keeper.previewPr, undefined);
    assert.equal(doc.clients[registered.client_id].previewPr, 12);
    assert.equal(doc.accounts.other.previewPr, 99);
    assert.equal(Object.values(doc.accounts).find((account) => account.previewPr === 12).name, "dev");
    assert.equal(Object.values(doc.tokens).every((row) => row.previewPr === 12), true);
    assert.equal(Object.keys(doc.codes).length, 0);
    const first = removePreviewPr(doc, 12);
    assert.equal(first.counts.clients, 1);
    assert.equal(first.counts.accounts, 1);
    assert.equal(first.counts.tokens, 2);
    assert.equal(first.doc.clients.keeper.client_name, "kept");
    assert.equal(first.doc.accounts.other.apiKey, "other-key");
    const second = removePreviewPr(first.doc, 12);
    assert.deepEqual(second.counts, { clients: 0, codes: 0, tokens: 0, accounts: 0 });
    assert.deepEqual(second.doc, first.doc);
  } finally {
    await http.close();
  }
});

await checkAsync("preview branch workflow creates once, updates env in place, and sweeps twice", async () => {
  const password = "neon-uri-password";
  const uri = `postgres://neondb_owner:${password}@ep-pr-pooler.c-3.us-east-1.aws.neon.tech/neondb`;
  const devPassword = "dev-sweep-password";
  const logs = [];
  const calls = [];
  let branches = [];
  let endpoints = [];
  let doc = {
    clients: {
      keeper: { client_id: "keeper", client_name: "kept" },
      preview: { client_id: "preview", client_name: "preview", previewPr: 12 },
    },
    codes: {},
    tokens: { leaked: { kind: "access", accountId: "a", previewPr: 12, exp: 1 } },
    accounts: { kept: { id: "kept", name: "dev", apiKey: "keep-me" } },
  };
  const vercelEnv = [
    { id: "env_prod", key: "DATABASE_URL", target: ["production"], gitBranch: null, value: "postgres://prod:prod-secret@ep-prod.neon.tech/neondb" },
    { id: "env_shared", key: "DATABASE_URL", target: ["preview"], value: "postgres://dev:dev-secret@ep-dev.neon.tech/neondb" },
  ];
  const fetchImpl = async (url, options = {}) => {
    const href = String(url);
    calls.push({ href, method: options.method || "GET", body: options.body });
    if ((href.includes("/branches?") || href.endsWith("/branches")) && (options.method || "GET") === "GET") {
      return Response.json({ branches });
    }
    if (href.endsWith("/branches") && options.method === "POST") {
      const branch = { id: "br-new-preview", name: "preview-pr-12" };
      branches = [branch];
      endpoints = [{ host: "ep-pr.c-3.us-east-1.aws.neon.tech" }];
      return Response.json({ branch, endpoints });
    }
    if (href.includes("/endpoints") && (options.method || "GET") === "GET") return Response.json({ endpoints });
    if (href.includes("/connection_uri")) return Response.json({ uri });
    if (href.includes("/branches/br-new-preview") && options.method === "DELETE") {
      branches = [];
      return new Response(null, { status: 204 });
    }
    if (href.includes("api.vercel.com") && href.includes("/v13/deployments") && options.method === "POST") {
      return Response.json({ id: "dpl_preview", readyState: "QUEUED" });
    }
    if (href.includes("api.vercel.com") && href.includes("/v9/projects/") && !href.includes("/env") && (options.method || "GET") === "GET") {
      return Response.json({ id: "prj_vcK99a0k92xwEYbM4UGe5UalPRj9", name: "odoo-json2" });
    }
    if (href.includes("api.vercel.com") && href.includes("/env") && (options.method || "GET") === "GET") {
      return Response.json({ envs: vercelEnv });
    }
    if (href.includes("api.vercel.com") && options.method === "POST") {
      const body = JSON.parse(options.body);
      const id = `env_${body.key}_${vercelEnv.length}`;
      vercelEnv.push({ id, key: body.key, target: body.target, gitBranch: body.gitBranch, value: body.value });
      return Response.json({ created: { id, key: body.key }, failed: [] });
    }
    if (href.includes("api.vercel.com") && options.method === "PATCH") {
      const id = href.match(/env\/([^?]+)/)[1];
      const body = JSON.parse(options.body);
      const row = vercelEnv.find((item) => item.id === id);
      row.value = body.value;
      return Response.json({ id });
    }
    if (href.includes("api.vercel.com") && options.method === "DELETE") {
      const id = href.match(/env\/([^?]+)/)[1];
      const index = vercelEnv.findIndex((item) => item.id === id);
      if (index >= 0) vercelEnv.splice(index, 1);
      return new Response(null, { status: 204 });
    }
    if (href.includes("api.github.com")) return Response.json([{ number: 12 }]);
    return new Response("missing", { status: 404 });
  };
  class FakeClient {
    static constructed = 0;
    constructor() {
      FakeClient.constructed += 1;
    }
    async connect() {}
    async query(sql, params) {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.startsWith("SELECT")) return { rows: [{ doc }] };
      if (sql.startsWith("UPDATE")) {
        doc = JSON.parse(params[0]);
        return { rows: [] };
      }
      throw new Error(`unexpected sql ${sql}`);
    }
    async end() {}
  }
  const baseEnv = {
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_EVENT_ACTION: "opened",
    PR_NUMBER: "12",
    GIT_BRANCH: "feature",
    NEON_API_KEY: "neon-api-key-value",
    NEON_PROJECT_ID: "winter-band-75532409",
    VERCEL_TOKEN: "vercel-token-value",
    VERCEL_PROJECT_ID: "prj_vcK99a0k92xwEYbM4UGe5UalPRj9",
    VERCEL_TEAM_ID: "team_YTsILlqZoAGHvfyNyI7ddIX3",
    GITHUB_REPOSITORY: "tylerjharden/odoo-json2",
    NEON_DEV_DATABASE_URL: `postgres://neondb_owner:${devPassword}@ep-dev-pooler.neon.tech/neondb`,
  };
  const first = await runPreviewWorkflow(baseEnv, { fetch: fetchImpl, pg: { Client: FakeClient }, log: (line) => logs.push(line) });
  assert.equal(first.branchId, "br-new-preview");
  const createdBranch = JSON.parse(calls.find((call) => call.method === "POST" && call.href.endsWith("/branches")).body);
  assert.equal(createdBranch.branch.parent_id, NEON_BRANCH_SHARED_DEV);
  assert.equal(createdBranch.branch.name, "preview-pr-12");
  assert.equal(FakeClient.constructed, 0);
  assert.equal(calls.some((call) => call.href.includes("/connection_uri") && call.href.includes("pooled=true")), true);
  assert.equal(vercelEnv.find((item) => item.id === "env_prod").value.includes("prod-secret"), true);
  assert.equal(vercelEnv.find((item) => item.id === "env_shared").value.includes("dev-secret"), true);
  const branchDatabase = vercelEnv.find((item) => item.key === "DATABASE_URL" && item.gitBranch === "feature");
  assert.equal(branchDatabase.value, uri);
  assert.equal(branchDatabase.target.length, 1);
  const createdIds = vercelEnv.filter((item) => item.gitBranch === "feature").map((item) => item.id);
  const deploy = calls.find((call) => call.method === "POST" && call.href.includes("/v13/deployments"));
  assert.ok(deploy);
  assert.equal(deploy.href.includes("forceNew=1"), true);
  const deployBody = JSON.parse(deploy.body);
  assert.equal(deployBody.name, "odoo-json2");
  assert.equal(deployBody.project, baseEnv.VERCEL_PROJECT_ID);
  assert.deepEqual(deployBody.gitSource, { type: "github", org: "tylerjharden", repo: "odoo-json2", ref: "feature" });
  assert.equal(deployBody.target, undefined);
  const envPost = calls.findIndex((call) => call.method === "POST" && call.href.includes("/env"));
  assert.equal(calls.indexOf(deploy) > envPost, true);
  calls.length = 0;
  await runPreviewWorkflow({ ...baseEnv, GITHUB_EVENT_ACTION: "synchronize" }, { fetch: fetchImpl, pg: { Client: FakeClient }, log: (line) => logs.push(line) });
  assert.equal(calls.filter((call) => call.method === "POST" && call.href.endsWith("/branches")).length, 0);
  assert.equal(calls.some((call) => call.href.includes("/v13/deployments")), false);
  assert.equal(FakeClient.constructed, 0);
  const patched = calls.filter((call) => call.method === "PATCH").map((call) => call.href);
  assert.equal(patched.length, 3);
  assert.equal(patched.some((href) => href.includes("env_prod") || href.includes("env_shared")), false);
  for (const id of createdIds) assert.equal(patched.some((href) => href.includes(id)), true);
  calls.length = 0;
  const removed = await runPreviewWorkflow(
    { ...baseEnv, GITHUB_EVENT_NAME: "delete", GITHUB_EVENT_ACTION: "", GITHUB_REF_TYPE: "branch", PR_NUMBER: "", GIT_BRANCH: "refs/heads/feature", GITHUB_TOKEN: "github-token-value", GITHUB_REPOSITORY: "tylerjharden/odoo-json2" },
    { fetch: fetchImpl, pg: { Client: FakeClient }, log: (line) => logs.push(line) },
  );
  assert.equal(removed.counts.clients, 1);
  assert.equal(removed.counts.tokens, 1);
  assert.equal(doc.clients.keeper.client_name, "kept");
  assert.equal(doc.accounts.kept.apiKey, "keep-me");
  assert.equal(vercelEnv.some((item) => item.gitBranch === "feature"), false);
  assert.equal(vercelEnv.some((item) => item.id === "env_prod"), true);
  const again = await runPreviewWorkflow(
    { ...baseEnv, GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_ACTION: "closed" },
    { fetch: fetchImpl, pg: { Client: FakeClient }, log: (line) => logs.push(line) },
  );
  assert.equal(again.counts.clients, 0);
  assert.equal(logs.join("\n").includes(password), false);
  assert.equal(logs.join("\n").includes(devPassword), false);
  assert.equal(logs.join("\n").includes("neon-api-key-value"), false);
  assert.equal(logs.join("\n").includes(uri), false);
  let hidden = null;
  try {
    await runPreviewWorkflow(baseEnv, {
      fetch: async () => new Response(`leaked ${password} ${uri}`, { status: 500 }),
      pg: { Client: FakeClient },
      log: (line) => logs.push(line),
    });
  } catch (err) {
    hidden = err;
  }
  assert.ok(hidden);
  assert.equal(hidden.message.includes(password), false);
  assert.equal(hidden.message.includes(uri), false);
});

process.stderr.write(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
