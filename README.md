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

## Install (HTTP OAuth — one connection per surface)

[makenotion/cursor-notion-plugin](https://github.com/makenotion/cursor-notion-plugin) is only `name: notion-workspace` (no `variables`) plus HTTP `mcp.json`. We ship the same plugin shape. Cursor still **does not** give third-party plugins Notion’s named Connected list or **+ Add Another Account**. That chrome is host-only (Notion / Gmail). There is no plugin.json or OAuth metadata field that unlocks it.

What Desktop Configure shows after a successful OAuth:

| Sheet row | What it is |
| --- | --- |
| Resource / Environment | **Local** (or Cloud later). Cursor surface, not an Odoo env name. |
| Plugin toggle | Enable `odoo-json2`. |
| Connected + Logout | **One** OAuth slot for this plugin on that surface. |
| Tools | `odoo_call`, `odoo_version`. |
| Dev / Test / Prod labels | **Not shown.** URL / database / key stay on the MCP host. |

Our authorize HTML still asks which instance (Dev / Test / Prod) when you **Connect**. That name is not drawn in Configure. Prod is never preselected. Replacing the slot: Logout, then Connect again.

**Stdio + dashboard env** is a different path (`ODOO_*` variables). Use HTTP + the pin URL for Desktop.

### 1. Host the MCP (required)

```bash
export ODOO_JSON2_PUBLIC_URL=https://odoo-json2.tylerjharden.dev
export ODOO_JSON2_STORE=/var/lib/odoo-json2/store.json
node http.mjs   # or: docker build && run, PORT=8788
```

Point DNS at that process. Edit `mcp.json` if the URL is not `https://odoo-json2.tylerjharden.dev/mcp`.

### 2. Install the plugin

- **Desktop:** symlink this repo to `~/.cursor/plugins/local/odoo-json2`, reload, enable the plugin.
- **Same sheet as Notion for the team:** publish at [cursor.com/marketplace/publish](https://cursor.com/marketplace/publish) or add the repo to the IPP team marketplace (Dashboard → Plugins).
- **Cloud Agents:** add a **Team HTTP MCP** (not stdio) with URL `https://odoo-json2.tylerjharden.dev/mcp`. Configure → Resource **Cloud** / **Cloud — ipp** → Connect (same single slot per surface).

### 3. Connect one instance (Dev first)

On each Resource you care about (Local, then Cloud):

1. Toggle the plugin on.
2. **Connect** / complete OAuth → choose **Dev** on our hosted form → paste Dev URL / database / API key.
3. Configure stays **Local / Connected / Logout**. It will not list “Dev” or offer Add Another Account.
4. Logout clears that slot. A later Test or Prod login **replaces** it unless Cursor later adds multi-account for third-party plugins.

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
