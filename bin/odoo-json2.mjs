#!/usr/bin/env node
/**
 * npm/npx bin. `store` copies OAuth records between stores. --http starts the
 * remote OAuth MCP. Default is stdio (single-instance local / Cloud Agent fallback).
 */
import { startStdio } from "../server.mjs";
import { startHttp, createRuntimeStore } from "../http.mjs";
import { runStoreCli } from "../store-cli.mjs";

if (process.argv[2] === "store") {
  process.exitCode = await runStoreCli(process.argv.slice(3));
} else if (process.argv.includes("--http")) {
  await startHttp({ store: createRuntimeStore() });
} else {
  startStdio();
}
