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

## Install (Notion-style Configure sheet)

The sheet Tyler wants (Resource, plugin toggle, connected accounts, **Add Another Account**, Logout, per-tool / Reads allow-all, Reload / Done) is **Cursor host UI**. Notion gets it because [makenotion/cursor-notion-plugin](https://github.com/makenotion/cursor-notion-plugin) is a **marketplace Cursor plugin** whose `mcp.json` is only:

```json
{ "notion": { "type": "http", "url": "https://mcp.notion.com/mcp" } }
```

That URL is a **remote HTTP MCP that speaks OAuth**. Cursor then draws:

| Sheet row | Who owns it | What it is |
| --- | --- | --- |
| Resource | Cursor | Which surface you are editing: **Local** (desktop), **Cloud**, **Cloud — ipp**. Not an Odoo env. |
| Plugin toggle | Cursor | Enable `odoo-json2` (same as `notion-workspace`). |
| Connected + Logout | Cursor | One OAuth token per connected identity. |
| Add Another Account | Cursor | Starts OAuth again. Our authorize page asks for Dev/Test/Prod + URL + API key + database. |
| Per-tool / Reads allow-all | Cursor | Tool permissions. Automatic for any plugin MCP. |
| Reload / Done | Cursor | Host chrome. |

**Stdio + dashboard env cannot show this sheet.** API keys in plugin `variables` become a form, not an account list. The host account list requires HTTP + `401` + `/.well-known/oauth-protected-resource`.

This repo now ships that HTTP+OAuth server (`node http.mjs`). Odoo JSON-2 has no OAuth; the Cursor token selects a stored API-key account. Prod is never implicit: no account is used unless its token is on the request, and the authorize form does not preselect Prod.

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
- **Cloud Agents:** add a **Team HTTP MCP** (not stdio) with URL `https://odoo-json2.tylerjharden.dev/mcp`. Then open **Plugins → Configure**, set Resource to **Cloud** / **Cloud — ipp**, and **Add Another Account**.

### 3. Connect Dev, then Test, then Prod

On each Resource you care about (Local, Cloud, Cloud — ipp):

1. Toggle the plugin on.
2. **Add Another Account** → choose **Dev** → paste Dev URL / database / API key → Connect.
3. Repeat for **Test**, then **Prod**.
4. Logout removes that account. Prod is never used unless that account is the one Cursor attached to the call.

IPP ladder: Dev until verified → Test after merge to `dev` → Prod after merge to `main`.

Do not add extra JSON-2 tools. `odoo_call` remains the API surface.

## Stdio fallback (no account list)

`npx` / `node server.mjs` still speaks MCP stdio with `ODOO_URL` / `ODOO_API_KEY` / `ODOO_DATABASE` for a **single** instance. That path will never show Add Another Account. Use it only for local debugging.

## Mint an API key

In Odoo: **Preferences → Account Security → New API Key**.

Give the key a description and a duration (maximum three months). The value is shown once — paste it on the **Add Another Account** form (or into stdio `ODOO_API_KEY` for local debugging). For integrations, Odoo recommends a dedicated bot user with the minimum access rights rather than a personal admin account.

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
# Hosted HTTP + OAuth (Configure / Add Another Account)
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
