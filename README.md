# odoo-json2

Cursor plugin that exposes [Odoo 19 External JSON-2](https://www.odoo.com/documentation/19.0/developer/reference/external_api.html) as two MCP tools. The domain type is a single `OdooCall` — not one tool per model, and not XML-RPC or JSON-RPC.

```
OdooCall = { model, method, ids?, context?, params }
POST {origin}/json/2/{model}/{method}
Authorization: bearer {api_key}
```

## Tools

| Tool           | What it does |
| -------------- | ------------ |
| `odoo_call`    | One JSON-2 call. Named kwargs only. Uses the account selected in Plugins → Configure. |
| `odoo_version` | `GET /web/version` — connectivity, no API key. Same connected account. |

The `odoo-json2` skill documents `search`, `search_read`, `read`, `create`, `write`, `unlink`, and `search_count`, plus the one-transaction-per-call rule.

## Requirements

- Cursor IDE (desktop). **Grok Bot cannot load `~/.cursor/plugins/local`.** Grok Bot plugins are account-wide marketplace connectors, not this local folder.
- Node.js 18 or newer (global `fetch`). The JSON file store needs no packages. Postgres needs `pg` from `npm install`.
- An Odoo 19 database on a **Custom** pricing plan (the external API is not available on One App Free or Standard).
- A user API key.

## Install (match the Notion Configure sheet)

[makenotion/cursor-notion-plugin](https://github.com/makenotion/cursor-notion-plugin) `mcp.json` is **unwrapped** (no `mcpServers` key):

```json
{ "notion": { "type": "http", "url": "https://mcp.notion.com/mcp" } }
```

`plugin.json` is only `name` / metadata (no `variables`). Cursor’s plugins reference does **not** document a Notion-only flag or an accounts API. Notion’s Environment rows on that sheet are **Cursor surfaces** (`Local`, `Cloud`, `Cloud — ipp`), each with Connect / Logout.

0.3.2 copies that `mcp.json` shape and ships **three** HTTP resources so Dev / Test / Prod are separate connections (smallest workaround if **+ Add Another Account** still does not appear after Cloud rows are connected). The Vercel pin stores OAuth clients, tokens, and instance credentials in private Blob so Connect survives isolate recycling:

```json
{
  "odoo-json2-dev": { "type": "http", "url": "https://odoo-json2.tylerjharden.dev/mcp/dev" },
  "odoo-json2-test": { "type": "http", "url": "https://odoo-json2.tylerjharden.dev/mcp/test" },
  "odoo-json2-prod": { "type": "http", "url": "https://odoo-json2.tylerjharden.dev/mcp/prod" }
}
```

`/mcp` still works (existing pin). `/mcp/dev` rejects a Test/Prod token.

**Stdio + dashboard env** is a different path. Use the HTTP pin for Desktop.

### 1. Host the MCP (required)

```bash
export ODOO_JSON2_PUBLIC_URL=https://odoo-json2.tylerjharden.dev
export ODOO_JSON2_STORE=/var/lib/odoo-json2/store.json
node http.mjs   # or: docker build && run, PORT=8788
```

On Vercel (`odoo-json2` → `https://odoo-json2.tylerjharden.dev`) the store is private Blob (`BLOB_READ_WRITE_TOKEN`), not `/tmp`. Do not put Odoo API keys in git or Vercel env — they stay in the authorize form and the Blob JSON. Plugin `mcp.json` uses `/mcp/dev`, `/mcp/test`, `/mcp/prod`.

### 2. Install the plugin (0.3.2)

Copy or clone **into** `~/.cursor/plugins/local/odoo-json2` from this branch (no outbound symlink), or republish / refresh the marketplace listing. Reload Window.

### 3. Get Local + Cloud + Cloud — ipp rows (Notion Environment list)

Those names are Cursor resources, not Odoo envs. They appear only after each surface is connected:

1. **Local** — already on Desktop after Connect on `odoo-json2-dev`.
2. **Cloud** — Dashboard → Integrations & MCP → custom HTTP `https://odoo-json2.tylerjharden.dev/mcp/dev` (no env) **or** add the plugin to the team marketplace. Configure → Resource **Cloud** → toggle on → Connect (Dev form).
3. **Cloud — ipp** — same URL on the IPP Cloud resource. Configure → Resource **Cloud — ipp** → toggle on → Connect.

If **+ Add Another Account** appears after those rows (same host chrome as Notion), use it. Cursor docs do not list a plugin.json key that forces that button. If it is still missing, connect **odoo-json2-test** and **odoo-json2-prod** the same way (separate MCP URLs). Do not put Prod keys in Vercel env.

IPP ladder: Dev until verified → Test after merge to `dev` → Prod after merge to `main`.

Do not add extra JSON-2 tools. `odoo_call` remains the API surface.

## Stdio fallback (no account list)

`npx` / `node server.mjs` still speaks MCP stdio with `ODOO_URL` / `ODOO_API_KEY` / `ODOO_DATABASE` for a **single** instance. Use it only for local debugging.

## Mint an API key

In Odoo: **Preferences → Account Security → New API Key**.

Give the key a description and a duration (maximum three months). The value is shown once — paste it on the hosted Connect form (or into stdio `ODOO_API_KEY` for local debugging). For integrations, Odoo recommends a dedicated bot user with the minimum access rights rather than a personal admin account.

The server sends `Authorization: bearer …` with a lowercase `bearer`, matching the Odoo 19 docs.

## Example: `search_read`

This request and result are the deco / company example from the [official Odoo 19.0 External JSON-2 documentation](https://www.odoo.com/documentation/19.0/developer/reference/external_api.html) (dummy host `mycompany.example.com`). They are not live data from this plugin.

HTTP (docs):

```http
POST /json/2/res.partner/search_read HTTP/1.1
Host: mycompany.example.com
X-Odoo-Database: mycompany
Authorization: bearer …
Content-Type: application/json; charset=utf-8

{
    "context": { "lang": "en_US" },
    "domain": [
        ["name", "ilike", "%deco%"],
        ["is_company", "=", true]
    ],
    "fields": ["name"]
}
```

Documented success body:

```json
[{ "id": 25, "name": "Deco Addict" }]
```

Same call through `odoo_call`:

```json
{
  "model": "res.partner",
  "method": "search_read",
  "context": { "lang": "en_US" },
  "params": {
    "domain": [
      ["name", "ilike", "%deco%"],
      ["is_company", "=", true]
    ],
    "fields": ["name"]
  }
}
```

Prefer `search_read` over `search` then `read`. Each JSON-2 request is its own SQL transaction.

## Run locally (dev)

```bash
# Hosted HTTP + OAuth (Configure → Connect)
export ODOO_JSON2_PUBLIC_URL=http://127.0.0.1:8788
node http.mjs

# Stdio single instance (no account list)
export ODOO_URL=mycompany.odoo.com
export ODOO_API_KEY=your-key
export ODOO_DATABASE=mycompany
node server.mjs
```

The process speaks MCP over stdin/stdout (newline-delimited JSON-RPC). Logs go to stderr.

```bash
npm run check   # node --check server.mjs
npm test        # stdio initialize + tools/list; mocked odoo_call (no live Odoo)
```

Tests never use a real API key or a public Odoo instance. Postgres cases run only when `ODOO_JSON2_TEST_DATABASE_URL` is set.

## Self-hosting

No database is required. The default store is a JSON file at `ODOO_JSON2_STORE`, or `data/store.json` when that variable is unset. Vercel Blob and Postgres are optional. KV remains in the precedence list.

The server picks a store in this order.

1. `BLOB_READ_WRITE_TOKEN` uses Vercel Blob.
2. `KV_REST_API_URL` and `KV_REST_API_TOKEN` together use KV.
3. `DATABASE_URL` uses Postgres.
4. Otherwise the server uses the JSON file.

An empty string is unset. Values are not trimmed. When `BLOB_READ_WRITE_TOKEN` is set, the server uses Blob even if `DATABASE_URL` is set. When both KV variables are set, the server uses KV even if `DATABASE_URL` is set. One KV variable plus `DATABASE_URL` selects Postgres.

The hosted Vercel function install runs `npm install`, which installs `pg`. A host that sets `BLOB_READ_WRITE_TOKEN` keeps Blob until that token is unset.

### Postgres (Neon recommended)

Use Neon as the Postgres host. The Neon free plan can hold this store. Give the Dev, Test, and Prod Odoo environments their own Neon branches.

Set `DATABASE_URL` to a Postgres connection string. This server opens that string with the `pg` package. The connection string guide is [Connect from any application](https://neon.com/docs/connect/connect-from-any-app.md). The branching guide is [Branching](https://neon.com/docs/introduction/branching.md). [Neon serverless driver](https://neon.com/docs/serverless/serverless-driver.md) describes `@neondatabase/serverless`. The driver in this server is `pg`.

The image runs `npm ci --omit=dev` and installs `pg`. An unset `DATABASE_URL` still selects the JSON file.

### Preview deployments

A preview deployment opens its own Neon branch. When `VERCEL_ENV` is `preview`, the process exits before it opens a database unless every check below passes.

- The selected store is Postgres. Blob, KV, and the JSON file are refused. Unset `BLOB_READ_WRITE_TOKEN` and the KV REST variables for Preview.
- `NEON_BRANCH_ID` is a Neon branch id other than production `br-orange-surf-b79ym7h7` and other than the shared dev branch `br-rough-moon-b79ppj13`.
- The host in `DATABASE_URL` matches `NEON_ENDPOINT_HOST`. A pooled host and a direct host for the same endpoint match.
- `NEON_PREVIEW_DENY_HOSTS` is set and does not list that host.
- `VERCEL_GIT_PULL_REQUEST_ID` is set. Vercel sets it on preview deployments.

Clients, accounts, authorization codes, and tokens created on a preview get `previewPr` set to that pull request id.

`.github/workflows/preview-branch.yml` creates the Neon branch `preview-pr-N` from the shared dev branch when a pull request opens, updates, or reopens. The workflow sets `DATABASE_URL`, `NEON_BRANCH_ID`, and `NEON_ENDPOINT_HOST` for that git branch's preview environment. It does not run SQL on the new branch. When the pull request closes, or the head branch is deleted, the workflow deletes that Neon branch, deletes those three preview variables, and removes records on the shared dev branch whose `previewPr` is that pull request.

A preview exits at startup until the branch variables and the deny list exist. Production and local development keep the store precedence above. To point production back at Blob, set `BLOB_READ_WRITE_TOKEN` and redeploy. A preview still refuses to boot while that token is set.

GitHub Actions secrets the workflow reads, and does not print:

- `NEON_API_KEY`
- `NEON_PROJECT_ID`
- `NEON_DEV_DATABASE_URL`, used only to sweep the shared dev branch
- `VERCEL_TOKEN`
- `NEON_PARENT_BRANCH_ID`, optional. When it is unset, the parent branch is `br-rough-moon-b79ppj13`.

Set `NEON_PREVIEW_DENY_HOSTS` on the Vercel project for Preview. Use the production endpoint host and the shared dev endpoint host, separated by a comma. No scheme and no password. Copy the hosts from the Neon console.

The sweep replaces the one shared-dev document. A login that the server writes in that moment can be lost. Run the workflow again to remove a `previewPr` that remains. The new preview branch is the database a preview is allowed to open. The sweep only cleans records that landed on the shared dev branch.

## Layout

```
.cursor-plugin/plugin.json
mcp.json
server.mjs
skills/odoo-json2/SKILL.md
package.json
LICENSE
```

## License

MIT
