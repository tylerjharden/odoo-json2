#!/usr/bin/env node
/**
 * Zero-dependency MCP stdio server for Odoo 19 External JSON-2.
 * Protocol: newline-delimited JSON-RPC on stdin/stdout (MCP stdio).
 * Also accepts Content-Length framing on input. Logs go to stderr only.
 *
 * Docs: https://www.odoo.com/documentation/19.0/developer/reference/external_api.html
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_NAME = "odoo-json2";
export const SERVER_VERSION = "0.3.0";
const USER_AGENT = "odoo-json2";
const PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];
const DEFAULT_PROTOCOL = "2025-03-26";
const FETCH_TIMEOUT_MS = 30_000;
const ELICIT_TIMEOUT_MS = 120_000;
const PROD_ENVIRONMENT_NAMES = new Set(["prod", "production", "live"]);
const ENVIRONMENT_ORDER = ["dev", "test", "staging", "default", "prod", "production", "live"];
const ENVIRONMENT_LABELS = {
  dev: "Dev",
  test: "Test",
  staging: "Staging",
  default: "Default",
  prod: "Prod",
  production: "Production",
  live: "Live",
};

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

function envLookup(env, name) {
  const raw = env[name];
  return raw == null ? "" : String(raw).trim();
}

function envTrim(name) {
  return envLookup(process.env, name);
}

export function normalizeEnvironmentName(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function isProductionEnvironment(name) {
  return PROD_ENVIRONMENT_NAMES.has(normalizeEnvironmentName(name));
}

export function displayEnvironmentName(name) {
  const normalized = normalizeEnvironmentName(name);
  if (ENVIRONMENT_LABELS[normalized]) return ENVIRONMENT_LABELS[normalized];
  return normalized
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function namedEnvVar(environmentName, suffix) {
  return `ODOO_${normalizeEnvironmentName(environmentName).toUpperCase()}_${suffix}`;
}

function sortEnvironmentNames(names, explicit) {
  return [...names].sort((a, b) => {
    if (explicit.length) {
      const ea = explicit.indexOf(a);
      const eb = explicit.indexOf(b);
      if (ea !== -1 || eb !== -1) {
        if (ea === -1) return 1;
        if (eb === -1) return -1;
        return ea - eb;
      }
    }
    const ia = ENVIRONMENT_ORDER.indexOf(a);
    const ib = ENVIRONMENT_ORDER.indexOf(b);
    const ra = ia === -1 ? ENVIRONMENT_ORDER.length : ia;
    const rb = ib === -1 ? ENVIRONMENT_ORDER.length : ib;
    if (ra !== rb) return ra - rb;
    return a.localeCompare(b);
  });
}

function instanceFromVars(name, urlVar, keyVar, dbVar, env, source) {
  const url = envLookup(env, urlVar);
  const apiKey = envLookup(env, keyVar);
  const database = envLookup(env, dbVar);
  if (!url && !apiKey && !database) return null;
  return { name, url, apiKey, database, urlVar, keyVar, dbVar, source };
}

/**
 * Named Dev/Test/Prod instances from ODOO_{NAME}_URL / _API_KEY / _DATABASE.
 * A lone ODOO_URL trio is the single-instance fallback (name "default").
 * Legacy vars are ignored once any named instance is present so Prod cannot
 * hide behind an implicit default.
 */
export function loadEnvironments(env = process.env) {
  const byName = new Map();
  const explicit = envLookup(env, "ODOO_ENVIRONMENTS")
    .split(/[,;\s]+/)
    .map(normalizeEnvironmentName)
    .filter(Boolean);

  const discovered = new Set(explicit);
  // Well-known names only. Do not scan every ODOO_*_URL — host VMs often
  // carry pipeline leftovers such as ODOO_BASE_URL that are not MCP instances.
  for (const name of ["dev", "test", "staging", "prod", "production", "live"]) {
    if (envLookup(env, namedEnvVar(name, "URL"))) discovered.add(name);
  }

  for (const name of discovered) {
    const instance = instanceFromVars(
      name,
      namedEnvVar(name, "URL"),
      namedEnvVar(name, "API_KEY"),
      namedEnvVar(name, "DATABASE"),
      env,
      "named"
    );
    if (instance) byName.set(name, instance);
  }

  if (byName.size === 0) {
    const legacy = instanceFromVars("default", "ODOO_URL", "ODOO_API_KEY", "ODOO_DATABASE", env, "legacy");
    if (legacy) byName.set("default", legacy);
  }

  return sortEnvironmentNames([...byName.keys()], explicit).map((name) => byName.get(name));
}

export function formatEnvironmentChoices(instances) {
  return instances
    .map((instance) => {
      const label = displayEnvironmentName(instance.name);
      return isProductionEnvironment(instance.name)
        ? `${instance.name} (${label}, production — never implicit)`
        : `${instance.name} (${label})`;
    })
    .join(", ");
}

export function environmentChoiceError(instances) {
  return (
    "Multiple Odoo accounts are available. Connect one from the plugin Configure sheet " +
    `(Environment Local → Connect). Configured: ${formatEnvironmentChoices(instances)}. Prod is never the implicit default.`
  );
}

export function resolveEnvironment(requested, env = process.env) {
  const instances = loadEnvironments(env);
  if (instances.length === 0) {
    throw new Error(
      "No Odoo account is connected. Use the plugin Configure sheet (Environment Local → Connect), " +
        "or set single-instance ODOO_URL / ODOO_API_KEY / ODOO_DATABASE for stdio."
    );
  }

  const raw = requested == null ? "" : String(requested).trim();
  if (raw) {
    const name = normalizeEnvironmentName(raw);
    const hit = instances.find((instance) => instance.name === name);
    if (!hit) {
      throw new Error(`Unknown account "${raw}". Configured: ${formatEnvironmentChoices(instances)}.`);
    }
    return hit;
  }

  if (instances.length === 1) {
    return instances[0];
  }

  throw new Error(environmentChoiceError(instances));
}

/**
 * Instance comes from a connected OAuth account (HTTP) or a single stdio env.
 * Never pick Prod (or any instance) when more than one is configured.
 */
export async function pickEnvironment(args = {}, options = {}) {
  if (options.instance) return options.instance;
  const env = options.env || process.env;
  const instances = loadEnvironments(env);
  if (instances.length === 0) {
    throw new Error(
      "No Odoo account is connected. In Cursor: Plugins → Configure → Environment Local → Connect. " +
        "Or set single-instance ODOO_URL / ODOO_API_KEY / ODOO_DATABASE for stdio."
    );
  }
  if (instances.length === 1) return instances[0];
  throw new Error(environmentChoiceError(instances));
}

/**
 * ODOO_URL must be an origin only (scheme + host[:port]), no path/query/hash.
 * A host with no scheme:// is treated as https.
 */
export function parseOdooOrigin(raw, fieldName = "ODOO_URL") {
  const trimmed = raw == null ? "" : String(raw).trim();
  if (!trimmed) {
    throw new Error(
      `${fieldName} is not set. Configure the Cursor plugin variable (origin only, e.g. https://mycompany.odoo.com).`
    );
  }
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`${fieldName} is not a valid URL. Use an origin only, e.g. https://mycompany.odoo.com`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${fieldName} must use http or https.`);
  }
  if (url.username || url.password) {
    throw new Error(`${fieldName} must not include credentials.`);
  }
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    throw new Error(`${fieldName} must be an origin only (no path), e.g. https://mycompany.odoo.com`);
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

export function requireApiKey(value = envTrim("ODOO_API_KEY"), fieldName = "ODOO_API_KEY") {
  const key = value == null ? "" : String(value).trim();
  if (!key) {
    throw new Error(
      `${fieldName} is not set. Create a key in Odoo: Preferences → Account Security → New API Key, then set the Cursor plugin variable.`
    );
  }
  return key;
}

export function requireDatabase(value = envTrim("ODOO_DATABASE"), fieldName = "ODOO_DATABASE") {
  const database = value == null ? "" : String(value).trim();
  if (!database) {
    throw new Error(
      `${fieldName} is not set. Set the Cursor plugin variable to the database name sent as X-Odoo-Database on every JSON-2 call.`
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
    "X-Odoo-Database": database,
  };

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

export function listTools() {
  return [
    {
      name: "odoo_call",
      description:
        "Call one Odoo 19 External JSON-2 method: POST /json/2/{model}/{method}. Body is named kwargs only (ids, context, plus params). One SQL transaction per call. Uses the Odoo account selected in the plugin Configure sheet.",
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
        "GET {origin}/web/version — connectivity check. No API key. Returns { account, origin, version, version_info }. Uses the Odoo account selected in the plugin Configure sheet.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ];
}

export async function odooCall(args = {}, options = {}) {
  const instance = await pickEnvironment(args, options);
  const origin = parseOdooOrigin(instance.url, instance.urlVar);
  const apiKey = requireApiKey(instance.apiKey, instance.keyVar);
  const database = requireDatabase(instance.database, instance.dbVar);
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

export async function odooVersion(args = {}, options = {}) {
  const instance = await pickEnvironment(args, options);
  const origin = parseOdooOrigin(instance.url, instance.urlVar);
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
        account: instance.name,
        origin,
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

async function callTool(name, args, options = {}) {
  if (name === "odoo_call") return odooCall(args || {}, options);
  if (name === "odoo_version") return odooVersion(args || {}, options);
  return textResult(`Unknown tool: ${name}`, true);
}

export async function handleJsonRpc(message, options = {}) {
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
      return jsonRpcResult(id, { tools: listTools() });
    }

    if (method === "tools/call") {
      const toolName = params && typeof params.name === "string" ? params.name : "";
      if (!toolName) {
        return jsonRpcResult(id, textResult("tools/call requires params.name", true));
      }
      const result = await callTool(toolName, params.arguments || {}, options);
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

export function elicitationParams(instances) {
  const names = instances.map((instance) => instance.name);
  const titles = instances.map((instance) =>
    isProductionEnvironment(instance.name)
      ? `${displayEnvironmentName(instance.name)} (production — never implicit)`
      : displayEnvironmentName(instance.name)
  );
  return {
    message:
      "Which Odoo environment should this call use? Dev until verified, Test after merge to dev, Prod after merge to main. Prod is never selected automatically.",
    requestedSchema: {
      type: "object",
      properties: {
        environment: {
          type: "string",
          title: "Odoo environment",
          description: "Required when more than one instance is configured.",
          enum: names,
          enumNames: titles,
        },
      },
      required: ["environment"],
    },
  };
}

export function startStdio() {
  let elicit;
  let nextServerId = 1;
  const pending = new Map();

  function sendElicit(instances) {
    const id = `odoo-env-${nextServerId++}`;
    writeMessage({
      jsonrpc: "2.0",
      id,
      method: "elicitation/create",
      params: elicitationParams(instances),
    });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(String(id));
        resolve(null);
      }, ELICIT_TIMEOUT_MS);
      pending.set(String(id), {
        finish(value) {
          clearTimeout(timer);
          resolve(value);
        },
      });
    });
  }

  const parser = createStdioParser((msg) => {
    Promise.resolve()
      .then(async () => {
        if (msg == null) return;
        if (msg.method === "initialize" && isPlainObject(msg.params) && isPlainObject(msg.params.capabilities)) {
          elicit = msg.params.capabilities.elicitation ? sendElicit : undefined;
        }
        if (!msg.method && msg.id != null && pending.has(String(msg.id))) {
          const waiter = pending.get(String(msg.id));
          pending.delete(String(msg.id));
          const action = msg.result && msg.result.action;
          const content = msg.result && isPlainObject(msg.result.content) ? msg.result.content : null;
          waiter.finish(action === "accept" && content && content.environment ? content.environment : null);
          return;
        }
        const response = await handleJsonRpc(msg, { elicit });
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
  process.stdin.resume();
}

/**
 * True when this file is the process entry. npm/npx bins are often a symlink
 * (…/node_modules/.bin/odoo-json2 → …/server.mjs); compare realpaths so
 * Cloud Agent `npx` actually starts stdio instead of exiting 0 with no output.
 */
export function isEntrypoint(argv1 = process.argv[1], selfUrl = import.meta.url) {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(selfUrl)) === realpathSync(argv1);
  } catch {
    return fileURLToPath(selfUrl) === resolve(argv1);
  }
}

if (isEntrypoint()) {
  startStdio();
}
