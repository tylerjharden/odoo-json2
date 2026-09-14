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
- Node.js 18 or newer (global `fetch`, no npm dependencies).
- An Odoo 19 database on a **Custom** pricing plan (the external API is not available on One App Free or Standard).
- A user API key.

## Install (match the Notion Configure sheet)

[makenotion/cursor-notion-plugin](https://github.com/makenotion/cursor-notion-plugin) `mcp.json` is **unwrapped** (no `mcpServers` key):

```json
{ "notion": { "type": "http", "url": "https://mcp.notion.com/mcp" } }
```

`plugin.json` is only `name` / metadata (no `variables`). Cursor’s plugins reference does **not** document a Notion-only flag or an accounts API. Notion’s Environment rows on that sheet are **Cursor surfaces** (`Local`, `Cloud`, `Cloud — ipp`), each with Connect / Logout.

0.3.1 copies that `mcp.json` shape and ships **three** HTTP resources so Dev / Test / Prod are separate connections (smallest workaround if **+ Add Another Account** still does not appear after Cloud rows are connected):

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

Point DNS at that process. Plugin `mcp.json` uses `/mcp/dev`, `/mcp/test`, `/mcp/prod`.

### 2. Install the plugin (0.3.1)

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

Tests never use a real API key or a public Odoo instance.

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
