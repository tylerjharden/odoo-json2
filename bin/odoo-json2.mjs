#!/usr/bin/env node
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
