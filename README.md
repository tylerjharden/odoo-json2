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

0.3.2 copies that `mcp.json` shape and ships **three** HTTP resources so Dev / Test / Prod are separate connections (smallest workaround if **+ Add Another Account** still does not appear after Cloud rows are connected). The Vercel pin stores OAuth clients, tokens, and instance credentials in Neon so Connect survives isolate recycling. Blob remains the store when `BLOB_READ_WRITE_TOKEN` is set.

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

On Vercel (`odoo-json2` → `https://odoo-json2.tylerjharden.dev`) the store is Neon through `DATABASE_URL`, not `/tmp`. Set `BLOB_READ_WRITE_TOKEN` to use Blob instead. Do not put Odoo API keys in git or Vercel env. They stay in the authorize form and the store document. Plugin `mcp.json` uses `/mcp/dev`, `/mcp/test`, `/mcp/prod`.

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

## Move the OAuth store

`odoo-json2 store` copies OAuth clients, unexpired tokens, and connected accounts from one store to another. It works between any two of Blob, KV, Postgres, and the JSON file. From a checkout, run it as `node bin/odoo-json2.mjs store`.

```
node bin/odoo-json2.mjs store migrate --from SPEC --to SPEC [--apply]
node bin/odoo-json2.mjs store sync    --from SPEC --to SPEC [--apply] [--prefer source|target]
```

A SPEC names a store kind. It can also say where each setting comes from. A setting you leave out comes from the variable the server reads.

| SPEC | Defaults |
| --- | --- |
| `blob[:token=VAR,path=VALUE,api=VALUE]` | `token` reads `BLOB_READ_WRITE_TOKEN`. `path` reads `ODOO_JSON2_BLOB_PATH`, else `odoo-json2-oauth-store.json`. `api` reads `VERCEL_BLOB_API_URL`, else `https://vercel.com/api/blob`. |
| `kv[:url=VAR,token=VAR,key=VALUE]` | `url` reads `KV_REST_API_URL`. `token` reads `KV_REST_API_TOKEN`. `key` reads `ODOO_JSON2_KV_KEY`, else `odoo-json2-oauth-store`. |
| `postgres[:url=VAR]` | `url` reads `DATABASE_URL`. |
| `file[:path=VALUE]` | `path` reads `ODOO_JSON2_STORE`, else `data/store.json`. |

`token=` and `url=` take the name of an environment variable, not its value. The CLI refuses anything that is not a variable name, so a pasted secret stops the run and never prints. `path=`, `api=`, and `key=` take the value itself.

### What a run copies

- `migrate` fills an empty store. It refuses a target that holds any record.
- `sync` adds what the target lacks. A second run prints `Nothing to change.` and writes nothing.
- Neither command removes a target record, copies an authorization code, or copies an expired token. The server deletes a code when a client exchanges it, so a stored code may already be spent.
- If both stores hold different values for one record, `sync` writes nothing until you pass `--prefer source` or `--prefer target`.
- Postgres cannot store a NUL character. A record that holds one stays out, and the other records still copy.
- `--since` exits 2. No store kind records when each record changed, so `sync` compares every record.

The preview marks each record that changes. `+` adds, `~` updates, `=` keeps the target's value, `!` differs and needs `--prefer`, and `x` is blocked. Code and token keys are secrets, so they print as `#` and the first 8 hex digits of their SHA-256. The output never holds a connection string, a password, a store token, or an account API key.

The CLI writes nothing until you pass `--apply` or answer `y` at the prompt. Before it writes, it reads the target again. If the target changed since the preview, it writes nothing and exits 1. After the write, it reads the target back and checks every record it wrote.

On a terminal, the CLI asks for the command, `--from`, or `--to` when one is missing. It then shows the preview, asks which side wins a record that differs, and asks before it writes. A command line that names all three never prompts. Off a terminal, a missing value exits 2.

```
$ node bin/odoo-json2.mjs store
Command (migrate, sync): sync
Source kind (blob, kv, postgres, file): blob
  blob token variable [BLOB_READ_WRITE_TOKEN, unset]: LEGACY_BLOB_TOKEN
  blob path [odoo-json2-oauth-store.json]:
  blob api [https://vercel.com/api/blob]:
Target kind (blob, kv, postgres, file): postgres
  postgres url variable [DATABASE_URL, set]:
```

The exit status is 0 when the write verified, when the run was a dry run, when you declined the write, or when nothing changed. It is 1 when a read or a write fails, when a record does not verify, or when the target changed after the preview. It is 2 when the CLI refuses before it writes.

### Import a Blob document into Postgres

1. Read the Blob token into the shell. `read -rs` keeps the value off the screen and out of shell history.

   ```bash
   read -rs LEGACY_BLOB_TOKEN && export LEGACY_BLOB_TOKEN
   ```

2. Read the Postgres connection string into `DATABASE_URL` the same way.

   ```bash
   read -rs DATABASE_URL && export DATABASE_URL
   ```

3. Preview the copy.

   ```bash
   node bin/odoo-json2.mjs store sync --from blob:token=LEGACY_BLOB_TOKEN --to postgres
   ```

   ```
   sync blob (token=LEGACY_BLOB_TOKEN, path=odoo-json2-oauth-store.json, api=https://vercel.com/api/blob) to postgres (url=DATABASE_URL)
   source 9 records, target 1 record
   x clients/COdNSbxl2-3y  cursor  postgres cannot store a NUL character
   + clients/D_fpsyY_77bZ  cursor
   + clients/WwW6ZnvfyCi4  cursor
   + tokens/#3fdd37d3  access 2c7tSIGcV4Qh
   + tokens/#d3866233  refresh 2c7tSIGcV4Qh
   + accounts/2c7tSIGcV4Qh  dev
   + accounts/5bbrWMD7b2h4  test
   add 6  update 0  keep 0  conflict 0  blocked 1  same 0  skip 2 (codes 1, expired tokens 1)  target only 1
   Dry run. Nothing written. Pass --apply to write 6 records.
   ```

4. Run the same command with `--apply`. The run ends with `Wrote 6 records to postgres (url=DATABASE_URL). Verified 6 of 6.`
5. Run the `--apply` command again. It ends with `Nothing to change.`

### Keep a rollback copy in Blob

```bash
node bin/odoo-json2.mjs store sync --from postgres --to blob:token=LEGACY_BLOB_TOKEN --apply
```

If a record differs between the two stores, add `--prefer source` to keep the Postgres value.

### Move a self-hosted file store into Postgres

```bash
node bin/odoo-json2.mjs store migrate --from file:path=/var/lib/odoo-json2/store.json --to postgres --apply
```

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
