#!/usr/bin/env node
/**
 * npm/npx bin. Always start MCP stdio. Do not rely on server.mjs isEntrypoint()
 * when a package manager wraps this file.
 */
import { startStdio } from "../server.mjs";

startStdio();
