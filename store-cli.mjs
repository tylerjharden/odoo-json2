import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { isDeepStrictEqual, parseArgs } from "node:util";

import { OAUTH_MAPS, STORE_KINDS, connectionSecrets, emptyStore, redactText } from "./http.mjs";

const ACTIONS = Object.freeze({
  add: "+",
  update: "~",
  keep: "=",
  conflict: "!",
  blocked: "x",
  same: null,
  skip: null,
});

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const SINCE_REFUSAL =
  "--since needs a per-record change time, and no store kind records one. sync compares every record, so a second run changes nothing.";

export async function runStoreCli(argv, io = defaultIo()) {
  const secrets = new Set();
  const redacting = (write) => (line) =>
    write(redactText(line, [...secrets].filter((secret) => secret.trim()).sort((a, b) => b.length - a.length)));
  const out = redacting(io.out);
  const err = redacting(io.err);
  const opened = [];
  try {
    const parsed = parseCommand(argv, io.kinds);
    if (parsed.help) {
      usage(io.kinds).forEach(out);
      return 0;
    }
    if (parsed.since) refuse(SINCE_REFUSAL);
    const { request, prompt } = await completeRequest(parsed, io);
    if (request.mode === "migrate" && request.prefer) refuse("migrate fills an empty store, so it takes no --prefer.");

    const source = resolveEndpoint(request.from, io.env, io.kinds);
    const target = resolveEndpoint(request.to, io.env, io.kinds);
    for (const secret of [...source.secrets, ...target.secrets]) secrets.add(secret);
    if (source.kind === target.kind && isDeepStrictEqual(source.config, target.config)) {
      refuse("The source and the target are the same store.");
    }

    const src = io.kinds[source.kind].open(source.config);
    opened.push(src);
    const dst = io.kinds[target.kind].open(target.config);
    opened.push(dst);
    const sourceDoc = parseDocument(await src.load(), "Source", source);
    const targetDoc = parseDocument(await dst.load(), "Target", target);
    for (const secret of [...docSecrets(sourceDoc), ...docSecrets(targetDoc)]) secrets.add(secret);

    const policy = { mode: request.mode, prefer: request.prefer, now: io.now(), refuses: io.kinds[target.kind].refuses };
    let plan = planTransfer(sourceDoc, targetDoc, policy);
    renderPlan(plan, source, target, sourceDoc, targetDoc).forEach(out);
    if (prompt && request.mode === "sync" && !request.prefer && plan.changes.some((c) => c.action === "conflict")) {
      const answer = (await prompt.ask("Keep the source, keep the target, or abort? [s/t/A] ")).trim().toLowerCase();
      const prefer = { s: "source", t: "target" }[answer];
      if (prefer) {
        plan = planTransfer(sourceDoc, targetDoc, { ...policy, prefer });
        renderPlan(plan, source, target, sourceDoc, targetDoc).forEach(out);
      }
    }
    if (plan.blockers.length) {
      plan.blockers.forEach(err);
      return 2;
    }

    const writes = writesOf(plan).length;
    if (!writes) {
      out("Nothing to change.");
      return 0;
    }
    if (!request.apply) {
      if (!prompt) {
        out(`Dry run. Nothing written. Pass --apply to write ${count(writes, "record")}.`);
        return 0;
      }
      const answer = await prompt.ask(`Write ${count(writes, "record")} to ${target.label}? [y/N] `);
      if (answer.trim().toLowerCase() !== "y") {
        out("Nothing written.");
        return 0;
      }
    }

    const fresh = parseDocument(await dst.load(), "Target", target);
    for (const secret of docSecrets(fresh)) secrets.add(secret);
    const recheck = planTransfer(sourceDoc, fresh, plan.policy);
    if (recheck.blockers.length || !sameWrites(plan, recheck)) {
      err("The target changed since the preview. Nothing written. Run the command again.");
      return 1;
    }
    await dst.write(withWrites(fresh, recheck));
    const missing = unwritten(recheck, parseDocument(await dst.load(), "Target", target));
    for (const change of missing) err(`Not verified: ${change.map}/${change.label}`);
    out(`Wrote ${count(writes, "record")} to ${target.label}. Verified ${writes - missing.length} of ${writes}.`);
    return missing.length ? 1 : 0;
  } catch (error) {
    err(error.message);
    return error.exitCode === 2 ? 2 : 1;
  } finally {
    io.prompt?.close();
    await Promise.all(opened.map((store) => store.close?.()));
  }
}

function defaultIo() {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  let lines = null;
  return {
    env: process.env,
    kinds: STORE_KINDS,
    now: Date.now,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    prompt: interactive
      ? {
          ask: (question) => (lines ??= createInterface({ input: process.stdin, output: process.stdout })).question(question),
          close: () => lines?.close(),
        }
      : null,
  };
}

function usage(kinds) {
  return [
    "Usage:",
    "  odoo-json2 store migrate --from SPEC --to SPEC [--apply]",
    "  odoo-json2 store sync    --from SPEC --to SPEC [--apply] [--prefer source|target]",
    "SPEC is one of:",
    ...Object.keys(kinds).map((kind) => `  ${specFor(kind, kinds)}`),
    "VAR is the name of an environment variable. VALUE is the value itself.",
  ];
}

function specFor(kind, kinds) {
  const slots = Object.entries(kinds[kind].slots).map(([slot, def]) => `${slot}=${def.secret ? "VAR" : "VALUE"}`);
  return `${kind}[:${slots.join(",")}]`;
}

function refuse(message) {
  throw Object.assign(new Error(message), { exitCode: 2 });
}

function parseCommand(argv, kinds) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        from: { type: "string" },
        to: { type: "string" },
        apply: { type: "boolean", default: false },
        prefer: { type: "string" },
        since: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    refuse(error.message);
  }
  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  const [mode, ...extra] = positionals;
  if (extra.length) refuse("Unexpected argument after the command.");
  if (mode !== undefined && mode !== "migrate" && mode !== "sync") refuse("Unknown command. Use migrate or sync.");
  if (values.prefer !== undefined && values.prefer !== "source" && values.prefer !== "target") {
    refuse("--prefer takes source or target.");
  }
  return {
    mode,
    from: values.from === undefined ? undefined : parseEndpoint(values.from, kinds),
    to: values.to === undefined ? undefined : parseEndpoint(values.to, kinds),
    apply: values.apply,
    prefer: values.prefer ?? null,
    since: values.since !== undefined,
  };
}

async function completeRequest(partial, io) {
  const missing = [];
  if (!partial.mode) missing.push("the command (migrate or sync)");
  if (!partial.from) missing.push("--from");
  if (!partial.to) missing.push("--to");
  if (!missing.length) return { request: partial, prompt: null };
  if (!io.prompt) refuse(`Missing ${missing.join(", ")}. Pass every one, or run on a terminal to be asked.`);
  const mode = partial.mode ?? (await askChoice(io.prompt, "Command", ["migrate", "sync"]));
  const from = partial.from ?? (await askEndpoint(io, "Source"));
  const to = partial.to ?? (await askEndpoint(io, "Target"));
  return { request: { ...partial, mode, from, to }, prompt: io.prompt };
}

async function askChoice(prompt, question, choices) {
  const answer = (await prompt.ask(`${question} (${choices.join(", ")}): `)).trim();
  if (!choices.includes(answer)) refuse(`Choose one of ${choices.join(", ")}.`);
  return answer;
}

async function askEndpoint(io, role) {
  const kind = await askChoice(io.prompt, `${role} kind`, Object.keys(io.kinds));
  const overrides = {};
  for (const [slot, def] of Object.entries(io.kinds[kind].slots)) {
    const hint = def.secret ? `${def.env}, ${io.env[def.env] ? "set" : "unset"}` : io.env[def.env] || def.fallback;
    const answer = (await io.prompt.ask(`  ${kind} ${slot}${def.secret ? " variable" : ""} [${hint}]: `)).trim();
    if (answer) overrides[slot] = checkSlot(kind, slot, answer, io.kinds);
  }
  return { kind, overrides };
}

function parseEndpoint(text, kinds) {
  const colon = text.indexOf(":");
  const kind = colon === -1 ? text : text.slice(0, colon);
  if (!Object.hasOwn(kinds, kind)) refuse(`Unknown store kind. Use ${Object.keys(kinds).join(", ")}.`);
  const overrides = {};
  if (colon !== -1) {
    for (const pair of text.slice(colon + 1).split(",")) {
      const eq = pair.indexOf("=");
      const slot = pair.slice(0, eq);
      if (eq === -1 || !Object.hasOwn(kinds[kind].slots, slot)) refuse(`Use ${specFor(kind, kinds)}.`);
      if (Object.hasOwn(overrides, slot)) refuse(`${kind} ${slot}= is given twice.`);
      overrides[slot] = checkSlot(kind, slot, pair.slice(eq + 1), kinds);
    }
  }
  return { kind, overrides };
}

function checkSlot(kind, slot, value, kinds) {
  if (!value) refuse(`${kind} ${slot}= is empty.`);
  if (kinds[kind].slots[slot].secret && !ENV_NAME.test(value)) {
    refuse(`${kind} ${slot}= takes the name of an environment variable, not its value.`);
  }
  return value;
}

function resolveEndpoint({ kind, overrides }, env, kinds) {
  const config = {};
  const shown = [];
  const secrets = [];
  for (const [slot, def] of Object.entries(kinds[kind].slots)) {
    if (def.secret) {
      const typedName = overrides[slot];
      const envName = typedName ?? def.env;
      if (!env[envName]) {
        refuse(typedName ? `${kind} ${slot}= names a variable that is not set.` : `${envName} is not set. Set it, or pass ${kind}:${slot}=VAR.`);
      }
      config[slot] = env[envName];
      shown.push(`${slot}=${envName}`);
      secrets.push(...connectionSecrets(env[envName]));
    } else {
      config[slot] = overrides[slot] ?? (env[def.env] || def.fallback);
      shown.push(`${slot}=${config[slot]}`);
    }
  }
  return { kind, config, label: `${kind} (${shown.join(", ")})`, secrets };
}

function isRecordMap(value) {
  return isPlainObject(value) && Object.values(value).every(isPlainObject);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseDocument(loaded, side, where) {
  if (!loaded.found) {
    if (side === "Target") return emptyStore();
    refuse(`Source ${where.label} holds no OAuth document.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(loaded.text);
  } catch {
    refuse(`${side} ${where.label} is not valid JSON.`);
  }
  if (!isPlainObject(parsed)) refuse(`${side} ${where.label} is not an OAuth document.`);
  const doc = emptyStore();
  for (const { name } of OAUTH_MAPS) {
    const records = parsed[name] ?? {};
    if (!isRecordMap(records)) refuse(`${side} ${where.label} is corrupt. ${name} is not a map of records.`);
    doc[name] = records;
  }
  return doc;
}

function planTransfer(source, target, policy) {
  const changes = [];
  let held = 0;
  let targetOnly = 0;
  for (const map of OAUTH_MAPS) {
    const theirs = target[map.name];
    const keys = Object.keys(theirs);
    held += keys.length;
    targetOnly += keys.filter((key) => !Object.hasOwn(source[map.name], key)).length;
    const records = Object.entries(source[map.name])
      .map(([key, value]) => ({ key, value, label: labelFor(map, key) }))
      .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
    for (const { key, value, label } of records) {
      const existing = Object.hasOwn(theirs, key) ? theirs[key] : undefined;
      changes.push({ map: map.name, key, label, ...decide(map, key, value, existing, policy) });
    }
  }
  const conflicts = changes.filter((change) => change.action === "conflict").length;
  const blockers = [];
  if (conflicts) {
    blockers.push(`${count(conflicts, "record")} differ between source and target. Pass --prefer source or --prefer target.`);
  }
  if (policy.mode === "migrate" && held) {
    blockers.push(`The target holds ${count(held, "record")}. migrate fills an empty store. Use sync.`);
  }
  return { policy, changes, targetOnly, blockers };
}

function decide(map, key, value, existing, { prefer, now, refuses }) {
  if (map.copies === "never") return { action: "skip", why: map.name };
  if (map.copies === "unexpired" && value.exp < now) return { action: "skip", why: `expired ${map.name}` };
  const fields = existing ? differingFields(existing, value) : [];
  if (existing && !fields.length) return { action: "same" };
  if (existing && prefer !== "source") return { action: prefer === "target" ? "keep" : "conflict", fields };
  const why = refuses?.(key, value);
  if (why) return { action: "blocked", why };
  return existing ? { action: "update", value, fields } : { action: "add", value };
}

function differingFields(a, b) {
  const names = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...names].filter((name) => !isDeepStrictEqual(a[name], b[name])).sort();
}

function writesOf(plan) {
  return plan.changes.filter((change) => "value" in change);
}

function withWrites(doc, plan) {
  const next = structuredClone(doc);
  for (const change of writesOf(plan)) next[change.map][change.key] = change.value;
  return next;
}

function sameWrites(a, b) {
  const left = writesOf(a);
  const right = writesOf(b);
  return (
    left.length === right.length &&
    left.every(
      (change, i) => change.map === right[i].map && change.key === right[i].key && isDeepStrictEqual(change.value, right[i].value)
    )
  );
}

function unwritten(plan, after) {
  return writesOf(plan).filter((change) => !isDeepStrictEqual(after[change.map][change.key], change.value));
}

function renderPlan(plan, source, target, sourceDoc, targetDoc) {
  const lines = [
    `${plan.policy.mode} ${source.label} to ${target.label}`,
    `source ${count(recordCount(sourceDoc), "record")}, target ${count(recordCount(targetDoc), "record")}`,
  ];
  const tally = Object.fromEntries(Object.keys(ACTIONS).map((action) => [action, 0]));
  const skipped = new Map();
  for (const change of plan.changes) {
    tally[change.action] += 1;
    if (change.action === "skip") skipped.set(change.why, (skipped.get(change.why) ?? 0) + 1);
    const mark = ACTIONS[change.action];
    if (!mark) continue;
    const record = sourceDoc[change.map][change.key];
    const printed = OAUTH_MAPS.find((map) => map.name === change.map).printed;
    const shown = printed.map((field) => stripTerminalControls(record[field])).filter(Boolean).join(" ");
    const detail = change.fields ? `differs in ${change.fields.map(stripTerminalControls).join(", ")}` : change.why;
    lines.push([`${mark} ${change.map}/${change.label}`, shown, detail].filter(Boolean).join("  "));
  }
  const parts = Object.entries(tally).map(([action, n]) =>
    action === "skip" && n ? `skip ${n} (${[...skipped].map(([why, k]) => `${why} ${k}`).join(", ")})` : `${action} ${n}`
  );
  lines.push([...parts, `target only ${plan.targetOnly}`].join("  "));
  return lines;
}

function recordCount(doc) {
  return OAUTH_MAPS.reduce((n, map) => n + Object.keys(doc[map.name]).length, 0);
}

function count(n, noun) {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function docSecrets(doc) {
  return OAUTH_MAPS.flatMap((map) => {
    const records = doc[map.name];
    const fields = Object.values(records).flatMap((record) => map.secretFields.map((field) => record[field]));
    return [...(map.secretKey ? Object.keys(records) : []), ...fields.filter((value) => typeof value === "string" && value)];
  });
}

function labelFor(map, key) {
  return map.secretKey ? `#${createHash("sha256").update(key).digest("hex").slice(0, 8)}` : stripTerminalControls(key);
}

function stripTerminalControls(text) {
  return String(text ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .slice(0, 60);
}
