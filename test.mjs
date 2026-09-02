#!/usr/bin/env node
/**
 * MCP stdio smoke test + mocked JSON-2 odoo_call.
 * Does not contact a real Odoo and does not use a live API key.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

import { handleJsonRpc, parseOdooOrigin, assertPathSegment, buildOdooCall } from "./server.mjs";

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

function spawnServer(env = {}) {
  const child = spawn(process.execPath, [join(root, "server.mjs")], {
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
});

check("parseOdooOrigin rejects a path", () => {
  assert.throws(() => parseOdooOrigin("https://mycompany.odoo.com/json/2"), /origin only/);
});

check("assertPathSegment rejects slash and ..", () => {
  assert.equal(assertPathSegment("model", "res.partner"), "res.partner");
  assert.throws(() => assertPathSegment("model", "res/partner"), /invalid path segment/);
  assert.throws(() => assertPathSegment("method", ".."), /invalid path segment/);
  assert.throws(() => assertPathSegment("model", "res.partner/../evil"), /invalid path segment/);
  assert.throws(() => assertPathSegment("model", ""), /non-empty/);
});

check("buildOdooCall uses lowercase bearer and always sends db header", () => {
  const withDb = buildOdooCall({
    origin: "https://mycompany.example.com",
    apiKey: "test-key",
    database: "mycompany",
    model: "res.partner",
    method: "search_read",
    context: { lang: "en_US" },
    params: { domain: [["name", "ilike", "%deco%"]], fields: ["name"] },
  });
  assert.equal(withDb.url, "https://mycompany.example.com/json/2/res.partner/search_read");
  assert.equal(withDb.headers.Authorization, "bearer test-key");
  assert.equal(withDb.headers["Content-Type"], "application/json; charset=utf-8");
  assert.equal(withDb.headers["User-Agent"], "odoo-json2");
  assert.equal(withDb.headers["X-Odoo-Database"], "mycompany");
  assert.deepEqual(withDb.body, {
    context: { lang: "en_US" },
    domain: [["name", "ilike", "%deco%"]],
    fields: ["name"],
  });

  const readCall = buildOdooCall({
    origin: "https://mycompany.example.com",
    apiKey: "test-key",
    database: "mycompany",
    model: "res.partner",
    method: "read",
    ids: [25],
    params: { fields: ["name"] },
  });
  assert.equal(readCall.headers["X-Odoo-Database"], "mycompany");
  assert.deepEqual(readCall.body, { ids: [25], fields: ["name"] });
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
    assert.deepEqual(init.result.serverInfo, { name: "odoo-json2", version: "0.1.1" });

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

await checkAsync("odoo_version GET /web/version without Authorization", async () => {
  fetchCalls.length = 0;
  const rpc = await handleJsonRpc({
    jsonrpc: "2.0",
    id: 11,
    method: "tools/call",
    params: { name: "odoo_version", arguments: {} },
  });
  const text = toolText(rpc);
  assert.match(text, /"version": "19.0"/);
  assert.equal(fetchCalls[0].url, "https://mycompany.example.com/web/version");
  assert.equal(fetchCalls[0].method, "GET");
  assert.equal(fetchCalls[0].headers.Authorization, undefined);
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

await checkAsync("missing ODOO_DATABASE is a clear tool error", async () => {
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

process.stderr.write(`\n${passed} passed, ${failed} failed\n`);
 if (failed) process.exit(1);
