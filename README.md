# odoo-json2

Cursor plugin that exposes [Odoo 19 External JSON-2](https://www.odoo.com/documentation/19.0/developer/reference/external_api.html) as two MCP tools. The domain type is a single `OdooCall` — not one tool per model, and not XML-RPC or JSON-RPC.

```
OdooCall = { model, method, ids?, context?, params }
POST {ODOO_URL}/json/2/{model}/{method}
Authorization: bearer {ODOO_API_KEY}
X-Odoo-Database: {ODOO_DATABASE}
```

## Tools

| Tool           | What it does |
| -------------- | ------------ |
| `odoo_call`    | One JSON-2 call. Named kwargs only. |
| `odoo_version` | `GET /web/version` — connectivity, no API key. |

The `odoo-json2` skill documents `search`, `search_read`, `read`, `create`, `write`, `unlink`, and `search_count`, plus the one-transaction-per-call rule.

## Requirements

- Cursor IDE (desktop). **Grok Bot cannot load `~/.cursor/plugins/local`.** Grok Bot plugins are account-wide marketplace connectors, not this local folder.
- Node.js 18 or newer (global `fetch`, no npm dependencies).
- An Odoo 19 database on a **Custom** pricing plan (the external API is not available on One App Free or Standard).
- A user API key and the database name.

## Install in Cursor IDE

1. Copy this directory to `~/.cursor/plugins/local/odoo-json2`.
2. Reload the window (**Developer: Reload Window**).
3. Open **Plugins → Configure** and set the variables below.
4. Confirm the `odoo-json2` MCP server and the `odoo-json2` skill appear under Customize.
5. After changing plugin variables, toggle the `odoo-json2` MCP server off and on. Reload Window alone does not pick up new env values.

Do not put API keys in this repo. The plugin only declares variable names.

## Cloud Agents (required for IPP / remote agents)

A local Cursor plugin is **not** loaded by Cloud Agents. Repo `mcp.json` and `~/.cursor/plugins/local` do not apply on the VM. Official path: **dashboard Team MCP or the MCP dropdown on [cursor.com/agents](https://cursor.com/agents)**.

Marketplace publish is an IDE distribution path. It does **not** enable Cloud Agents.

**What you must click** (a Cloud Agent cannot register Team MCP):

1. Open [cursor.com/dashboard/integrations](https://cursor.com/dashboard/integrations) → **Team MCP Servers** → add a custom **stdio** server named `odoo-json2`  
   **or** open [cursor.com/agents](https://cursor.com/agents) → **MCP** dropdown → add the same server as personal MCP.
2. Command / args / env:

```json
{
  "command": "npx",
  "args": ["-y", "github:tylerjharden/odoo-json2"],
  "env": {
    "ODOO_URL": "mycompany.odoo.com",
    "ODOO_API_KEY": "<key from Preferences → Account Security → New API Key>",
    "ODOO_DATABASE": "<database name>"
  }
}
```

3. Enable the server in the **MCP** dropdown for the run.
4. Start a **new** Cloud Agent (MCP is applied at start). Confirm `odoo_call` and `odoo_version` appear in tools.

If the team has an MCP allowlist: add a command pattern for `npx`. If egress is restricted: allow `github.com`, `codeload.github.com`, and `registry.npmjs.org`, plus the Odoo host.

Do not add extra tools. `odoo_call` remains the JSON-2 surface. After changing those env values, toggle the MCP server off then on.

## Plugin variables

Declared in `.cursor-plugin/plugin.json` and substituted into `mcp.json`:

| Variable         | Required | Meaning |
| ---------------- | -------- | ------- |
| `ODOO_URL`       | yes      | Host or origin. `https://` is added if omitted. No path. |
| `ODOO_API_KEY`   | yes      | User API key (see below). |
| `ODOO_DATABASE`  | yes      | Database name. Sent as `X-Odoo-Database` on every JSON-2 call. |

`mcp.json` launches `./server.mjs` as a plugin-relative executable. Cursor's local plugin loader does not expand `${PLUGIN_ROOT}` in args.

## Mint an API key

In Odoo: **Preferences → Account Security → New API Key**.

Give the key a description and a duration (maximum three months). The value is shown once — copy it into the Cursor plugin variable. For integrations, Odoo recommends a dedicated bot user with the minimum access rights rather than a personal admin account.

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
export ODOO_URL=https://mycompany.odoo.com
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
