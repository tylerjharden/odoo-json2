export const NEON_BRANCH_PROD = "br-orange-surf-b79ym7h7";
export const NEON_BRANCH_SHARED_DEV = "br-rough-moon-b79ppj13";

const BRANCH_ID = /^br-[a-z0-9-]+$/;
const PULL_REQUEST_NUMBER = /^[1-9][0-9]*$/;

export function normalizeNeonHost(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw || /[\s/@]/.test(raw) || raw.includes("://")) return "";
  const host = raw.replace(/:\d+$/, "");
  const labels = host.split(".");
  if (!labels[0] || labels.some((label) => !label)) return "";
  if (labels[0].endsWith("-pooler")) labels[0] = labels[0].slice(0, -"-pooler".length);
  return labels.join(".");
}

export function hostnameFromDatabaseUrl(value) {
  try {
    return new URL(String(value)).hostname;
  } catch {
    return "";
  }
}

export function parseDenyHosts(value) {
  return String(value ?? "")
    .split(",")
    .map((host) => normalizeNeonHost(host))
    .filter(Boolean);
}

export function requirePullRequestNumber(value, label = "Pull request number") {
  const text = String(value ?? "").trim();
  if (!PULL_REQUEST_NUMBER.test(text)) throw new Error(`${label} is missing.`);
  return Number(text);
}

export function previewPullRequest(env) {
  if (env.VERCEL_ENV !== "preview") return null;
  return requirePullRequestNumber(env.VERCEL_GIT_PULL_REQUEST_ID, "VERCEL_GIT_PULL_REQUEST_ID");
}

export function withPreviewStamp(record, env) {
  const pr = previewPullRequest(env);
  if (pr == null) return record;
  return { ...record, previewPr: pr };
}

export function assertPreviewStore(env, kind) {
  if (env.VERCEL_ENV !== "preview") return;
  previewPullRequest(env);
  if (kind !== "postgres") {
    throw new Error(
      `Preview refuses the ${kind} store. Set DATABASE_URL to this pull request's Neon branch and unset BLOB_READ_WRITE_TOKEN and the KV REST variables.`,
    );
  }
  const branchId = String(env.NEON_BRANCH_ID || "").trim();
  if (!BRANCH_ID.test(branchId) || branchId === NEON_BRANCH_PROD || branchId === NEON_BRANCH_SHARED_DEV) {
    throw new Error("Preview requires NEON_BRANCH_ID for a branch other than production or the shared dev branch.");
  }
  const actual = normalizeNeonHost(hostnameFromDatabaseUrl(env.DATABASE_URL));
  const expected = normalizeNeonHost(env.NEON_ENDPOINT_HOST);
  if (!actual || !expected || actual !== expected) {
    throw new Error("Preview DATABASE_URL host does not match NEON_ENDPOINT_HOST.");
  }
  const denied = parseDenyHosts(env.NEON_PREVIEW_DENY_HOSTS);
  if (!denied.length || denied.includes(actual)) {
    throw new Error(
      "Preview DATABASE_URL host is not allowed. Set NEON_PREVIEW_DENY_HOSTS to the production and shared dev endpoint hosts.",
    );
  }
}

export function parentBranchId(env) {
  const id = String(env.NEON_PARENT_BRANCH_ID || NEON_BRANCH_SHARED_DEV).trim();
  if (id === NEON_BRANCH_PROD || !BRANCH_ID.test(id)) {
    throw new Error("NEON_PARENT_BRANCH_ID must be a non-production Neon branch.");
  }
  return id;
}

export function previewBranchName(pr) {
  return `preview-pr-${requirePullRequestNumber(pr)}`;
}

export function previewAction({ eventName, action, refType }) {
  if (eventName === "pull_request" && (action === "opened" || action === "synchronize" || action === "reopened")) return "ensure";
  if (eventName === "pull_request" && action === "closed") return "remove";
  if (eventName === "delete" && refType === "branch") return "remove";
  return "skip";
}

export function removePreviewPr(doc, pr) {
  const prNumber = requirePullRequestNumber(pr);
  const next = { clients: {}, codes: {}, tokens: {}, accounts: {} };
  const counts = { clients: 0, codes: 0, tokens: 0, accounts: 0 };
  for (const name of Object.keys(next)) {
    const map = doc?.[name];
    if (!map || typeof map !== "object" || Array.isArray(map)) continue;
    for (const [key, value] of Object.entries(map)) {
      if (value && typeof value === "object" && Number(value.previewPr) === prNumber) {
        counts[name] += 1;
        continue;
      }
      next[name][key] = value;
    }
  }
  return { doc: next, counts };
}

export function redactSecrets(text, secrets) {
  let out = String(text);
  const values = [...secrets].filter((secret) => typeof secret === "string" && secret.length >= 4);
  values.sort((a, b) => b.length - a.length);
  for (const secret of values) out = out.split(secret).join("[redacted]");
  return out.replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, "postgres://[redacted]");
}
