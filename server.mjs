#!/usr/bin/env node
/**
 * Zero-dependency MCP stdio server for Odoo 19 External JSON-2.
 * Protocol: newline-delimited JSON-RPC on stdin/stdout (MCP stdio).
 * Also accepts Content-Length framing on input. Logs go to stderr only.
 *
 * Docs: https://www.odoo.com/documentation/19.0/developer/reference/external_api.html
 */

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const SERVER_NAME = "odoo-json2";
const SERVER_VERSION = "0.1.1";
const USER_AGENT = "odoo-json2";
const PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];
const DEFAULT_PROTOCOL = "2025-03-26";
const FETCH_TIMEOUT_MS = 30_000;

function log(...args) {
  process.stderr.write(
    args
      .map((a) => (typeof a === "string" ? a : a instanceof Error ? a.stack || a.message : JSON.stringify(a)))
      .join(" ") + "\n"
  );
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

function textResult(text, isError = false) {
  const result = { content: [{ type: "text", text }] };
  if (isError) result.isError = true;
  return result;
}

function pretty(value) {
  return JSON.stringify(value, null, 2);
}

function envTrim(name) {
  const raw = process.env[name];
  return raw == null ? "" : String(raw).trim();
}

/**
 * ODOO_URL must be an origin only (scheme + host[:port]), no path/query/hash.
 */
export function parseOdooOrigin(raw) {
  if (!raw) {
    throw new Error("ODOO_URL is not set. Configure the Cursor plugin variable (origin only, e.g. https://mycompany.odoo.com).");
  }
  let input = String(raw).trim();
  if (input && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input)) {
    input = "https://" + input;
  }
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("ODOO_URL is not a valid URL. Use an origin only, e.g. https://mycompany.odoo.com");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("ODOO_URL must use http or https.");
  }
  if (url.username || url.password) {
    throw new Error("ODOO_URL must not include credentials.");
  }
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    throw new Error("ODOO_URL must be an origin only (no path), e.g. https://mycompany.odoo.com");
  }
  return url.origin;
}

/**
 * model/method become URL path segments. Reject empty, `/`, and `..`.
 */
export function assertPathSegment(name, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string.`);
  }
  const trimmed = value.trim();
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.split(".").includes("..") || trimmed.includes("..")) {
    throw new Error(`${name} contains an invalid path segment ("/" or "..").`);
  }
  return trimmed;
}

export function requireApiKey() {
  const key = envTrim("ODOO_API_KEY");
  if (!key) {
    throw new Error(
      "ODOO_API_KEY is not set. Create a key in Odoo: Preferences → Account Security → New API Key, then set the Cursor plugin variable."
    );
  }
  return key;
}

export function requireDatabase() {
  const database = envTrim("ODOO_DATABASE");
  if (!database) {
    throw new Error(
      "ODOO_DATABASE is not set. Set the Cursor plugin variable to the Odoo database name (sent as X-Odoo-Database on every JSON-2 call)."
    );
  }
  return database;
}

export function buildOdooCall({ origin, apiKey, database, model, method, ids, context, params }) {
  const url = `${origin}/json/2/${model}/${method}`;
  const headers = {
    Authorization: `bearer ${apiKey}`,
    "Content-Type": "application/json; charset=utf-8",
    "User-Agent": USER_AGENT,
  };
  headers["X-Odoo-Database"] = database;

  const body = {
    ...(ids !== undefined ? { ids } : {}),
    ...(context !== undefined ? { context } : {}),
    ...(params && isPlainObject(params) ? params : {}),
  };

  return { url, headers, body };
}

function validateIds(ids) {
  if (ids === undefined) return undefined;
  if (!Array.isArray(ids) || !ids.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw new Error("ids must be an array of numbers.");
  }
  return ids;
}

function validateContext(context) {
  if (context === undefined) return undefined;
  if (!isPlainObject(context)) {
    throw new Error("context must be a JSON object.");
  }
  return context;
}

function validateParams(params) {
  if (params === undefined) return undefined;
  if (!isPlainObject(params)) {
    throw new Error("params must be a JSON object of named kwargs.");
  }
  return params;
}

async function readHttpJson(response) {
  const raw = await response.text();
  if (!raw) return { ok: true, value: null, raw: "" };
  try {
    return { ok: true, value: JSON.parse(raw), raw };
  } catch {
    return { ok: false, value: null, raw };
  }
}

function formatOdooHttpError(status, parsed, raw, includeDebug) {
  if (parsed && isPlainObject(parsed)) {
    const name = typeof parsed.name === "string" ? parsed.name : "Error";
    const message = typeof parsed.message === "string" ? parsed.message : String(parsed.message ?? "");
    let text = `HTTP ${status} ${name}: ${message}`;
    if (includeDebug && typeof parsed.debug === "string" && parsed.debug) {
      text += `\n\n${parsed.debug}`;
    }
    return text;
  }
  const snippet = (raw || "").slice(0, 500);
  return snippet ? `HTTP ${status}: ${snippet}` : `HTTP ${status}`;
}

const TOOLS = [
  {
    name: "odoo_call",
    description:
      "Call one Odoo 19 External JSON-2 method: POST /json/2/{model}/{method}. Body is named kwargs only (ids, context, plus params). One SQL transaction per call.",
    inputSchema: {
      type: "object",
      properties: {
        model: {
          type: "string",
          description: "Technical model name, e.g. res.partner",
        },
        method: {
          type: "string",
          description: "Model method, e.g. search_read",
        },
        ids: {
          type: "array",
          items: { type: "number" },
          description: "Record ids for record methods (read, write, unlink, …). Omit for @api.model methods.",
        },
        context: {
          type: "object",
          description: 'Odoo context object, e.g. {"lang": "en_US"}',
        },
        params: {
          type: "object",
          description:
            "Extra named kwargs for the method: domain, fields, limit, offset, values, … Do not use positional args.",
        },
        debug: {
          type: "boolean",
          description: "If true, include Odoo error.debug traceback on HTTP errors. Default false.",
        },
      },
      required: ["model", "method"],
    },
  },
  {
    name: "odoo_version",
    description:
      "GET {ODOO_URL}/web/version — connectivity check. No API key. Returns { version, version_info }.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

export async function odooCall(args = {}) {
  const origin = parseOdooOrigin(envTrim("ODOO_URL"));
  const apiKey = requireApiKey();
  const database = requireDatabase();
  const model = assertPathSegment("model", args.model);
  const method = assertPathSegment("method", args.method);
  const ids = validateIds(args.ids);
  const context = validateContext(args.context);
  const params = validateParams(args.params);
  const includeDebug = args.debug === true;

  const { url, headers, body } = buildOdooCall({
    origin,
    apiKey,
    database,
    model,
    method,
    ids,
    context,
    params,
  });

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return textResult(`Request failed: ${err.message || err}`, true);
  }

  const parsed = await readHttpJson(response);
  if (response.status === 200) {
    if (!parsed.ok) {
      return textResult(parsed.raw || "(empty body)");
    }
    return textResult(pretty(parsed.value));
  }

  return textResult(formatOdooHttpError(response.status, parsed.ok ? parsed.value : null, parsed.raw, includeDebug), true);
}

export async function odooVersion() {
  const origin = parseOdooOrigin(envTrim("ODOO_URL"));
  const url = `${origin}/web/version`;
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return textResult(`Request failed: ${err.message || err}`, true);
  }

  const parsed = await readHttpJson(response);
  if (response.status === 200 && parsed.ok && isPlainObject(parsed.value)) {
    return textResult(
      pretty({
        version: parsed.value.version,
        version_info: parsed.value.version_info,
      })
    );
  }
  if (response.status === 200 && parsed.ok) {
    return textResult(pretty(parsed.value));
  }
  return textResult(formatOdooHttpError(response.status, parsed.ok ? parsed.value : null, parsed.raw, false), true);
}

async function callTool(name, args) {
  if (name === "odoo_call") return odooCall(args || {});
  if (name === "odoo_version") return odooVersion();
  return textResult(`Unknown tool: ${name}`, true);
}

export async function handleJsonRpc(message) {
  if (!isPlainObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    const id = isPlainObject(message) ? message.id : null;
    return jsonRpcError(id ?? null, -32600, "Invalid Request");
  }

  const { id, method, params } = message;
  const isNotification = id === undefined;

  if (method === "notifications/initialized" || method === "initialized") {
    return null;
  }

  if (isNotification) {
    return null;
  }

  try {
    if (method === "initialize") {
      const requested = params && typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : requested || DEFAULT_PROTOCOL;
      return jsonRpcResult(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(protocolVersion) ? protocolVersion : DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }

    if (method === "ping") {
      return jsonRpcResult(id, {});
    }

    if (method === "tools/list") {
      return jsonRpcResult(id, { tools: TOOLS });
    }

    if (method === "tools/call") {
      const toolName = params && typeof params.name === "string" ? params.name : "";
      if (!toolName) {
        return jsonRpcResult(id, textResult("tools/call requires params.name", true));
      }
      const result = await callTool(toolName, params.arguments || {});
      return jsonRpcResult(id, result);
    }

    return jsonRpcError(id, -32601, `Method not found: ${method}`);
  } catch (err) {
    if (method === "tools/call") {
      return jsonRpcResult(id, textResult(err.message || String(err), true));
    }
    return jsonRpcError(id, -32603, err.message || String(err));
  }
}

function writeMessage(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function parseJsonMessage(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed);
}

/**
 * Consume stdin: Content-Length frames if present, otherwise newline-delimited JSON.
 */
export function createStdioParser(onMessage) {
  let buf = Buffer.alloc(0);

  function headerBlockLength(buffer) {
    const crlf = buffer.indexOf("\r\n\r\n");
    if (crlf !== -1) return { end: crlf + 4, sep: 4 };
    const lf = buffer.indexOf("\n\n");
    if (lf !== -1) return { end: lf + 2, sep: 2 };
    return null;
  }

  function consume() {
    while (buf.length > 0) {
      const peek = buf.toString("utf8", 0, Math.min(buf.length, 64)).toLowerCase();
      if (peek.startsWith("content-length:")) {
        const headers = headerBlockLength(buf);
        if (!headers) return;
        const headerText = buf.toString("utf8", 0, headers.end);
        const match = headerText.match(/content-length:\s*(\d+)/i);
        if (!match) {
          buf = buf.subarray(headers.end);
          continue;
        }
        const len = Number(match[1]);
        if (buf.length < headers.end + len) return;
        const body = buf.subarray(headers.end, headers.end + len).toString("utf8");
        buf = buf.subarray(headers.end + len);
        onMessage(parseJsonMessage(body));
        continue;
      }

      const nl = buf.indexOf(0x0a);
      if (nl === -1) return;
      let line = buf.subarray(0, nl).toString("utf8");
      buf = buf.subarray(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      onMessage(parseJsonMessage(line));
    }
  }

  return {
    push(chunk) {
      buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      consume();
    },
  };
}

export function startStdio() {
  const parser = createStdioParser((msg) => {
    Promise.resolve()
      .then(async () => {
        if (msg == null) return;
        const response = await handleJsonRpc(msg);
        if (response) writeMessage(response);
      })
      .catch((err) => {
        log(err);
        if (msg && msg.id !== undefined) {
          writeMessage(jsonRpcError(msg.id, -32603, err.message || String(err)));
        }
      });
  });

  process.stdin.on("data", (chunk) => parser.push(chunk));
  process.stdin.on("error", (err) => log(err));
  process.stdin.on("end", () => {
    process.exit(0);
  });
}

function isMain() {
  if (!process.argv[1]) return false;
  return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isMain()) {
  startStdio();
}
