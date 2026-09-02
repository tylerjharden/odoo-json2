---
name: odoo-json2
description: Query or mutate Odoo 19 data through the External JSON-2 API (POST /json/2/{model}/{method}). Use when the user needs to search, read, create, write, unlink, or otherwise call a named Odoo model method, or to check connectivity with /web/version.
---

# Odoo 19 External JSON-2

Official reference (read this; do not invent models, fields, or sample records):

https://www.odoo.com/documentation/19.0/developer/reference/external_api.html

Each database also documents its own models and methods at `{ODOO_URL}/doc`. Use that page or a live `odoo_call` — never fabricate partners, orders, field names, or example IDs.

## Tools

- `odoo_call` — one JSON-2 request. This is the entire API surface.
- `odoo_version` — `GET /web/version` connectivity check (no API key).

Do not add per-model tools. Do not use XML-RPC (`/xmlrpc`) or JSON-RPC (`/jsonrpc`).

## OdooCall

```
OdooCall = { model, method, ids?, context?, params }
```

The server `POST`s `{ODOO_URL}/json/2/{model}/{method}` with:

- `Authorization: bearer {ODOO_API_KEY}` (lowercase `bearer`, as in the Odoo docs)
- `Content-Type: application/json; charset=utf-8`
- `User-Agent: odoo-json2`
- `X-Odoo-Database: {ODOO_DATABASE}` on every JSON-2 call (required plugin variable)

Body is a single JSON object of **named** kwargs — no positional args:

```
{ ids?, context?, ...params }
```

- Record methods (`read`, `write`, `unlink`, …): put record ids in `ids`.
- Search-style methods: put `domain`, `fields`, `limit`, `offset`, and other method kwargs in `params`.
- Use the method’s real parameter names from Odoo `/doc` or the official page above. Do not guess aliases.

Success (HTTP 200) is the method’s JSON return value as-is (`Record[]`, `id[]`, `id`, `bool`, …). Errors are HTTP 4xx/5xx with `{ name, message, arguments, context, debug }`. The tool reports status, `name`, and `message` unless `debug: true`.

## One transaction per call

Every JSON-2 request runs in its own SQL transaction (commit on success, rollback on error). You cannot chain calls in one transaction.

Prefer a single method that does the whole job. Use `search_read` instead of `search` then `read`. Concurrent updates can make a follow-up `read` miss ids that `search` just returned. Business actions are often named `action_*` (for example `sale.order` `action_confirm`).

## Common ORM methods

Put these on `odoo_call` as `method`. Confirm kwargs on `/doc` for that database.

| method        | `ids`                         | typical `params`                 |
| ------------- | ----------------------------- | -------------------------------- |
| `search`      | omit                          | `domain`, `limit`, `offset`, `order` |
| `search_read` | omit                          | `domain`, `fields`, `limit`, `offset`, `order` |
| `search_count`| omit                          | `domain`                         |
| `read`        | required                      | `fields`                         |
| `create`      | omit                          | the method’s vals / vals_list kwarg |
| `write`       | required                      | the method’s vals kwarg          |
| `unlink`      | required                      | —                                |

`context` is optional (e.g. `lang`). Empty `ids` or omitted `ids` is for `@api.model` methods.

## Access and limits

- Rights follow the **API-key user** (access rights, record rules, field access).
- For automation, use a **dedicated bot user** with the minimum permissions (Odoo’s recommendation).
- External API access is on **Custom** Odoo pricing plans only — not One App Free or Standard.
- UI-created keys last **at most three months** and must be rotated. The value is shown once at creation.

If `ODOO_URL`, `ODOO_API_KEY`, or `ODOO_DATABASE` is missing, stop and ask the user to set the Cursor plugin variables. Do not invent a host, key, or database name.
