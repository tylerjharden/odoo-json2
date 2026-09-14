# odoo-json2

Cursor plugin that exposes [Odoo 19 External JSON-2](https://www.odoo.com/documentation/19.0/developer/reference/external_api.html) as two MCP tools. The domain type is a single `OdooCall` — not one tool per model, and not XML-RPC or JSON-RPC.

```
OdooCall = { environment?, model, method, ids?, context?, params }
POST {origin}/json/2/{model}/{method}
Authorization: bearer {api_key}
```

## Tools

| Tool           | What it does |
| -------------- | ------------ |
| `odoo_call`    | One JSON-2 call. Named kwargs only. Pass `environment` when more than one instance is configured. |
| `odoo_version` | `GET /web/version` — connectivity, no API key. Same `environment` rule. |

The `odoo-json2` skill documents `search`, `search_read`, `read`, `create`, `write`, `unlink`, and `search_count`, plus the one-transaction-per-call rule.

## Requirements

- Cursor IDE (desktop). **Grok Bot cannot load `~/.cursor/plugins/local`.** Grok Bot plugins are account-wide marketplace connectors, not this local folder.
- Node.js 18 or newer (global `fetch`, no npm dependencies).
- An Odoo 19 database on a **Custom** pricing plan (the external API is not available on One App Free or Standard).
- A user API key.

## Install in Cursor IDE

1. Copy this directory to `~/.cursor/plugins/local/odoo-json2`.
2. Reload the window (**Developer: Reload Window**).
3. Open **Plugins → Configure** and set the variables below.
4. Confirm the `odoo-json2` MCP server and the `odoo-json2` skill appear under Customize.

After you change plugin variables, **toggle the odoo-json2 MCP server off then on**. Reload Window alone is not enough — Cursor caches the MCP process environment.

Do not put API keys in this repo. The plugin only declares variable names.

## Cloud Agents (required for IPP / remote agents)

A local Cursor plugin is **not** loaded by Cloud Agents. Repo `mcp.json` and `~/.cursor/plugins/local` do not apply on the VM. Official path: **dashboard Team MCP or the MCP dropdown on [cursor.com/agents](https://cursor.com/agents)**.

Marketplace publish is an IDE distribution path. It does **not** enable Cloud Agents.

**What Tyler must click** (this agent cannot register Team MCP):

1. Open [cursor.com/dashboard/integrations](https://cursor.com/dashboard/integrations) → **Team MCP Servers** → add a custom **stdio** server named `odoo-json2`  
   **or** open [cursor.com/agents](https://cursor.com/agents) → **MCP** dropdown → add the same server as personal MCP.
2. Command / args / env (**0.2.0+**; `--prefer-online` avoids a stale npx cache of the 0.1.1 empty-exit bug). Prefer one server with Dev + Test + Prod rather than three MCP entries:

```json
{
  "command": "npx",
  "args": ["-y", "--prefer-online", "github:tylerjharden/odoo-json2"],
  "env": {
    "ODOO_ENVIRONMENTS": "dev,test,prod",
    "ODOO_DEV_URL": "<dev origin>",
    "ODOO_DEV_API_KEY": "<dev API key>",
    "ODOO_DEV_DATABASE": "<dev database>",
    "ODOO_TEST_URL": "<test origin>",
    "ODOO_TEST_API_KEY": "<test API key>",
    "ODOO_TEST_DATABASE": "<test database>",
    "ODOO_PROD_URL": "<prod origin>",
    "ODOO_PROD_API_KEY": "<prod API key>",
    "ODOO_PROD_DATABASE": "<prod database>"
  }
}
```

Do **not** also set `ODOO_URL` / `ODOO_API_KEY` / `ODOO_DATABASE` on that server. Those are the single-instance fallback and are ignored once any `ODOO_{NAME}_URL` is present.

Until 0.2.0 is on `main`, pin the branch: `github:tylerjharden/odoo-json2#cursor/multi-instance-auth-e851`.

3. Enable the server in the **MCP** dropdown for the run.
4. Toggle `odoo-json2-dev` (or `odoo-json2`) **off then on** so Cloud Agents pull 0.2.0, then start a **new** Cloud Agent. Confirm `odoo_call` and `odoo_version` list an `environment` enum (`dev`, `test`, `prod`). If discovery still shows only `mcp_auth`, the spawn never stayed up.

If the team has an MCP allowlist: add a command pattern for `npx`. If egress is restricted: allow `github.com`, `codeload.github.com`, and `registry.npmjs.org`, plus every Odoo host.

Do not add extra tools. `odoo_call` remains the JSON-2 surface. After changing those env values, toggle the MCP server off then on.

### Environment picker (stdio vs Notion)

Notion’s Cloud picker is a **host OAuth account switcher**. This server is **stdio + dashboard env**, so Cursor cannot show that same account chip. Closest match:

- `tools/list` marks `environment` **required** and enums the configured names when more than one instance is set.
- A missing `environment` is a tool error that lists the choices. Prod is **never** used unless the caller passes it.
- If the client advertises MCP elicitation (desktop Cursor), the server also sends `elicitation/create` with the same enum. Cloud Agents typically do not; they must pass `environment` on the tool call.

IPP ladder: Dev until verified → Test after merge to `dev` → Prod after merge to `main`.

## Plugin variables

Declared in `.cursor-plugin/plugin.json` and substituted into `mcp.json`. Configure **either** the single-instance trio **or** named Dev/Test/Prod vars.

| Variable | When | Meaning |
| --- | --- | --- |
| `ODOO_URL` / `ODOO_API_KEY` / `ODOO_DATABASE` | Single instance only | Origin, user API key, database (`X-Odoo-Database`). Ignored when any named `ODOO_{NAME}_URL` is set. |
| `ODOO_ENVIRONMENTS` | Optional | Comma list that sets picker order, e.g. `dev,test,prod`. Required to expose a custom name (not `dev`/`test`/`prod`/`staging`). |
| `ODOO_DEV_URL` / `ODOO_DEV_API_KEY` / `ODOO_DEV_DATABASE` | Multi-instance | Dev origin, key, database. |
| `ODOO_TEST_URL` / `ODOO_TEST_API_KEY` / `ODOO_TEST_DATABASE` | Multi-instance | Test origin, key, database. |
| `ODOO_PROD_URL` / `ODOO_PROD_API_KEY` / `ODOO_PROD_DATABASE` | Multi-instance | Prod origin, key, database. Never the implicit default. |

Cursor launches the MCP server as the plugin-relative executable `./server.mjs` (shebang `#!/usr/bin/env node`). Do not put `${PLUGIN_ROOT}` in `args` — the local plugin loader does not expand it.

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
# Single instance
export ODOO_URL=mycompany.odoo.com   # or https://mycompany.odoo.com
export ODOO_API_KEY=your-key
export ODOO_DATABASE=mycompany
node server.mjs

# Or Dev + Test + Prod (pass environment on every tool call)
export ODOO_ENVIRONMENTS=dev,test,prod
export ODOO_DEV_URL=ipp-dev.odoo.com
export ODOO_DEV_API_KEY=dev-key
export ODOO_DEV_DATABASE=ipp-dev
# …repeat for TEST and PROD
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
