#!/usr/bin/env node
/**
 * npm/npx bin. --http starts the remote OAuth MCP. Default is stdio
 * (single-instance local / Cloud Agent fallback).
 */
import { startStdio } from "../server.mjs";
import { startHttp, createFileStore } from "../http.mjs";
import { resolve } from "node:path";

if (process.argv.includes("--http")) {
  const storePath = process.env.ODOO_JSON2_STORE || resolve("data/store.json");
  await startHttp({ store: createFileStore(storePath) });
} else {
  startStdio();
}
