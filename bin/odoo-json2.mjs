#!/usr/bin/env node
/**
 * npm/npx bin. --http starts the remote OAuth MCP. Default is stdio
 * (single-instance local / Cloud Agent fallback).
 */
import { startStdio } from "../server.mjs";
import { startHttp, createRuntimeStore } from "../http.mjs";

if (process.argv.includes("--http")) {
  await startHttp({ store: createRuntimeStore() });
} else {
  startStdio();
}
