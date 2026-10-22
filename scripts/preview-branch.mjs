import pg from "pg";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  parentBranchId,
  previewAction,
  previewBranchName,
  redactSecrets,
  removePreviewPr,
  requirePullRequestNumber,
} from "../preview-store.mjs";

const PREVIEW_ENV_KEYS = ["DATABASE_URL", "NEON_BRANCH_ID", "NEON_ENDPOINT_HOST"];

export async function runPreviewWorkflow(env, deps = {}) {
  const secrets = secretValues(env);
  const log = (message) => (deps.log ?? console.log)(redactSecrets(message, secrets));
  const action = previewAction({
    eventName: env.GITHUB_EVENT_NAME,
    action: env.GITHUB_EVENT_ACTION,
    refType: env.GITHUB_REF_TYPE,
  });
  if (action === "skip") {
    log("preview branch workflow skipped");
    return { action };
  }
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const gitBranch = gitBranchName(env.GIT_BRANCH);
  if (!gitBranch) throw new Error("Git branch name is missing.");
  if (action === "ensure") {
    const pr = requirePullRequestNumber(env.PR_NUMBER);
    const ensured = await ensurePreviewBranch({ env, fetchImpl, pr, gitBranch, secrets });
    log(`ensured ${ensured.branchName} ${ensured.branchId}`);
    return { action, ...ensured };
  }
  const pr = await resolvePullRequestNumber(env, fetchImpl, gitBranch, secrets);
  if (pr == null) {
    log(`no pull request for git branch ${gitBranch}`);
    return { action, pr: null };
  }
  const counts = await sweepSharedDev(env, deps.pg ?? pg, pr, secrets);
  log(`swept preview-pr-${pr} clients=${counts.clients} accounts=${counts.accounts} codes=${counts.codes} tokens=${counts.tokens}`);
  const removed = await deleteNeonBranch({ env, fetchImpl, pr, secrets });
  log(removed ? `deleted neon branch ${previewBranchName(pr)}` : `neon branch ${previewBranchName(pr)} was already gone`);
  const deletedEnv = await deleteBranchEnv({ env, fetchImpl, gitBranch, secrets });
  log(`deleted ${deletedEnv} vercel preview env vars for git branch ${gitBranch}`);
  return { action, pr, counts };
}

export async function ensurePreviewBranch({ env, fetchImpl, pr, gitBranch, secrets }) {
  requireSecret(env, "NEON_API_KEY");
  requireSecret(env, "NEON_PROJECT_ID");
  requireSecret(env, "VERCEL_TOKEN");
  requireSecret(env, "VERCEL_PROJECT_ID");
  requireSecret(env, "VERCEL_TEAM_ID");
  const name = previewBranchName(pr);
  const parent = parentBranchId(env);
  let branch = await findBranch(env, fetchImpl, name, secrets);
  let endpointHost = "";
  if (!branch) {
    const created = await neon(env, fetchImpl, "/branches", {
      method: "POST",
      body: {
        branch: { name, parent_id: parent },
        endpoints: [{ type: "read_write", autoscaling_limit_min_cu: 0.25, autoscaling_limit_max_cu: 0.25, suspend_timeout_seconds: 300 }],
      },
    }, secrets);
    branch = created.branch;
    endpointHost = created.endpoints?.[0]?.host || "";
  }
  if (!endpointHost) {
    const listed = await neon(env, fetchImpl, `/branches/${branch.id}/endpoints`, {}, secrets);
    endpointHost = listed.endpoints?.[0]?.host || "";
    if (!endpointHost) {
      const created = await neon(env, fetchImpl, "/endpoints", {
        method: "POST",
        body: {
          endpoint: {
            branch_id: branch.id,
            type: "read_write",
            autoscaling_limit_min_cu: 0.25,
            autoscaling_limit_max_cu: 0.25,
            suspend_timeout_seconds: 300,
          },
        },
      }, secrets);
      endpointHost = created.endpoint?.host || "";
    }
  }
  if (!endpointHost) throw new Error("Neon branch has no endpoint host.");
  const databaseName = env.NEON_DATABASE_NAME || "neondb";
  const roleName = env.NEON_ROLE_NAME || "neondb_owner";
  const connection = await neon(
    env,
    fetchImpl,
    `/connection_uri?branch_id=${encodeURIComponent(branch.id)}&database_name=${encodeURIComponent(databaseName)}&role_name=${encodeURIComponent(roleName)}&pooled=true`,
    {},
    secrets,
  );
  const uri = connection.uri || connection.connection_uri;
  if (!uri || !uri.includes("://")) throw new Error("Neon connection URI response had no uri.");
  secrets.push(uri, passwordFromUrl(uri));
  await setBranchEnv(env, fetchImpl, gitBranch, [
    { key: "DATABASE_URL", value: uri, type: "sensitive" },
    { key: "NEON_BRANCH_ID", value: branch.id, type: "plain" },
    { key: "NEON_ENDPOINT_HOST", value: endpointHost, type: "plain" },
  ], secrets);
  return { branchId: branch.id, branchName: name, endpointHost };
}

async function resolvePullRequestNumber(env, fetchImpl, gitBranch, secrets) {
  if (String(env.PR_NUMBER ?? "").trim()) return requirePullRequestNumber(env.PR_NUMBER);
  requireSecret(env, "GITHUB_TOKEN");
  requireSecret(env, "GITHUB_REPOSITORY");
  const [owner, repo] = env.GITHUB_REPOSITORY.split("/");
  if (!owner || !repo) throw new Error("GITHUB_REPOSITORY is missing.");
  const listed = await github(
    env,
    fetchImpl,
    `/repos/${owner}/${repo}/pulls?state=all&per_page=20&head=${encodeURIComponent(`${owner}:${gitBranch}`)}`,
    secrets,
  );
  const fromList = newestPullRequest(listed);
  if (fromList) return fromList;
  const query = `repo:${owner}/${repo} is:pr head:${gitBranch}`;
  const searched = await github(env, fetchImpl, `/search/issues?q=${encodeURIComponent(query)}&sort=created&order=desc`, secrets);
  return newestPullRequest(searched.items || []);
}

function newestPullRequest(items) {
  if (!Array.isArray(items) || !items.length) return null;
  const numbers = items.map((item) => Number(item.number)).filter((number) => Number.isInteger(number) && number > 0);
  if (!numbers.length) return null;
  return Math.max(...numbers);
}

async function sweepSharedDev(env, pgModule, pr, secrets) {
  requireSecret(env, "NEON_DEV_DATABASE_URL");
  const client = new pgModule.Client({ connectionString: env.NEON_DEV_DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    try {
      const counts = await sweepPreview(client, pr);
      await client.query("COMMIT");
      return counts;
    } catch (err) {
      await client.query("ROLLBACK");
      throw redactError(err, secrets);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function sweepPreview(client, pr) {
  let result;
  try {
    result = await client.query("SELECT doc FROM public.odoo_json2_oauth_store WHERE id = 1 FOR UPDATE");
  } catch (err) {
    if (err.code === "42P01") return { clients: 0, accounts: 0, codes: 0, tokens: 0 };
    throw err;
  }
  const row = result.rows?.[0];
  if (!row) return { clients: 0, accounts: 0, codes: 0, tokens: 0 };
  const { doc, counts } = removePreviewPr(row.doc, pr);
  if (Object.values(counts).some((count) => count > 0)) {
    await client.query("UPDATE public.odoo_json2_oauth_store SET doc = $1::jsonb WHERE id = 1", [JSON.stringify(doc)]);
  }
  return counts;
}

async function deleteNeonBranch({ env, fetchImpl, pr, secrets }) {
  requireSecret(env, "NEON_API_KEY");
  requireSecret(env, "NEON_PROJECT_ID");
  const name = previewBranchName(pr);
  const branch = await findBranch(env, fetchImpl, name, secrets);
  if (!branch) return false;
  await neon(env, fetchImpl, `/branches/${branch.id}`, { method: "DELETE" }, secrets);
  return true;
}

async function findBranch(env, fetchImpl, name, secrets) {
  let cursor = "";
  for (;;) {
    const path = cursor ? `/branches?cursor=${encodeURIComponent(cursor)}` : "/branches";
    const page = await neon(env, fetchImpl, path, {}, secrets);
    const found = (page.branches || []).find((branch) => branch.name === name);
    if (found) return found;
    cursor = page.pagination?.next || "";
    if (!cursor) return null;
  }
}

async function setBranchEnv(env, fetchImpl, gitBranch, rows, secrets) {
  const existing = await listProjectEnv(env, fetchImpl, secrets);
  for (const row of rows) {
    const matches = existing.filter((item) => isPreviewBranchEnv(item, row.key, gitBranch));
    if (matches.length > 1) throw new Error(`More than one preview ${row.key} exists for this git branch.`);
    if (matches.length === 1) {
      await vercel(env, fetchImpl, `/v9/projects/${env.VERCEL_PROJECT_ID}/env/${matches[0].id}`, {
        method: "PATCH",
        body: { value: row.value, type: row.type, target: ["preview"], gitBranch },
      }, secrets);
    } else {
      await vercel(env, fetchImpl, `/v10/projects/${env.VERCEL_PROJECT_ID}/env`, {
        method: "POST",
        body: { key: row.key, value: row.value, type: row.type, target: ["preview"], gitBranch },
      }, secrets);
    }
  }
}

async function deleteBranchEnv({ env, fetchImpl, gitBranch, secrets }) {
  requireSecret(env, "VERCEL_TOKEN");
  requireSecret(env, "VERCEL_PROJECT_ID");
  requireSecret(env, "VERCEL_TEAM_ID");
  const existing = await listProjectEnv(env, fetchImpl, secrets);
  const matches = existing.filter((item) => PREVIEW_ENV_KEYS.some((key) => isPreviewBranchEnv(item, key, gitBranch)));
  for (const item of matches) {
    await vercel(env, fetchImpl, `/v9/projects/${env.VERCEL_PROJECT_ID}/env/${item.id}`, { method: "DELETE" }, secrets);
  }
  return matches.length;
}

function isPreviewBranchEnv(item, key, gitBranch) {
  return item.key === key && item.gitBranch === gitBranch && Array.isArray(item.target) && item.target.length === 1 && item.target[0] === "preview";
}

async function listProjectEnv(env, fetchImpl, secrets) {
  const rows = [];
  let until = "";
  for (;;) {
    const path = until
      ? `/v9/projects/${env.VERCEL_PROJECT_ID}/env?until=${encodeURIComponent(until)}`
      : `/v9/projects/${env.VERCEL_PROJECT_ID}/env`;
    const page = await vercel(env, fetchImpl, path, {}, secrets);
    rows.push(...(page.envs || []));
    until = page.pagination?.next ? String(page.pagination.next) : "";
    if (!until) return rows;
  }
}

async function neon(env, fetchImpl, path, { method = "GET", body } = {}, secrets) {
  const response = await fetchImpl(`https://console.neon.tech/api/v2/projects/${encodeURIComponent(env.NEON_PROJECT_ID)}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.NEON_API_KEY}`,
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return readJson(response, secrets, `Neon ${method} failed`);
}

async function vercel(env, fetchImpl, path, { method = "GET", body } = {}, secrets) {
  const url = new URL(`https://api.vercel.com${path}`);
  url.searchParams.set("teamId", env.VERCEL_TEAM_ID);
  const response = await fetchImpl(url, {
    method,
    headers: {
      authorization: `Bearer ${env.VERCEL_TOKEN}`,
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await readJson(response, secrets, `Vercel ${method} failed`);
  if (Array.isArray(payload?.failed) && payload.failed.length) throw new Error(`Vercel rejected a preview env var.`);
  return payload;
}

async function github(env, fetchImpl, path, secrets) {
  const response = await fetchImpl(`https://api.github.com${path}`, {
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
    },
  });
  return readJson(response, secrets, "GitHub lookup failed");
}

async function readJson(response, secrets, label) {
  const text = await response.text();
  if (!response.ok) throw new Error(redactSecrets(`${label} (${response.status})`, secrets));
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned unreadable JSON`);
  }
}

function gitBranchName(value) {
  return String(value ?? "").trim().replace(/^refs\/heads\//, "");
}

function requireSecret(env, name) {
  if (!env[name]) throw new Error(`${name} is not set.`);
}

function secretValues(env) {
  const values = ["NEON_API_KEY", "NEON_DEV_DATABASE_URL", "VERCEL_TOKEN", "GITHUB_TOKEN", "DATABASE_URL"]
    .map((name) => env[name])
    .filter(Boolean);
  for (const value of [...values]) values.push(passwordFromUrl(value));
  return values.filter(Boolean);
}

function passwordFromUrl(value) {
  try {
    return decodeURIComponent(new URL(String(value)).password);
  } catch {
    return "";
  }
}

function redactError(err, secrets) {
  const next = new Error(redactSecrets(err.message, secrets));
  next.code = err.code;
  return next;
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === self) {
  runPreviewWorkflow(process.env).catch((err) => {
    const secrets = secretValues(process.env);
    console.error(redactSecrets(err.message, secrets));
    process.exitCode = 1;
  });
}
