# Roadmap

## Sponsor badge

This spot is reserved for a future sponsor badge. No sponsor is listed.

Each item is planned and not shipped.

## One Neon branch per Odoo connection

Planned, not shipped. Use one Neon branch for the Dev connection, one for Test, and one for Prod.

## Odoo records in Neon

Planned, not shipped. Mirror or cache Odoo records in Neon for analytics, and expose pgvector search over MCP.

## Neon Auth

Planned, not shipped. Use Neon Auth for the hosted OAuth flow.

## Neon AI Gateway

Planned, not shipped. Add an agent layer via Neon AI Gateway.

## Self-hosted Odoo on Neon

Planned, not shipped. Write a self-hosted Odoo on Neon guide only after that setup has been tested. It has not been tested.

## A PIM platform

Planned, not shipped. Later work can grow this server into a PIM platform.

## Per-record change times in the OAuth store

Planned, not shipped. Record when each OAuth record last changed, so `odoo-json2 store sync --since TIME` can copy only the records that changed after that time. No store kind records a change time today, so `--since` exits 2 and `sync` compares every record.
