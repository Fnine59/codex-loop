#!/usr/bin/env node

import { parseArgs } from "node:util";
import { formatDuration, MAX_LIFETIME_MS, parseDuration } from "./lib/duration.mjs";
import { createControlMarker, createStartMarker, newLoopId } from "./lib/markers.mjs";
import { writePendingConfig } from "./lib/pending.mjs";

const HELP = `loopctl

Usage:
  loopctl start --every <duration> [--max-runs <count>] [--for <duration> | --until-stopped] [--until <condition>] [--now] -- <task>
  loopctl stop
  loopctl complete [--id <loop-id>]

This is an internal Codex Loop helper. It emits a marker for the current assistant response;
it does not start a daemon, cron job, App Server, or second Codex session.
`;

function positiveInteger(value, name) {
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

async function start(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      every: { type: "string" },
      "max-runs": { type: "string" },
      for: { type: "string" },
      "until-stopped": { type: "boolean", default: false },
      until: { type: "string" },
      now: { type: "boolean", default: false },
    },
  });
  if (!values.every) throw new Error("--every is required.");
  if (values["until-stopped"] && (values.for || values["max-runs"] || values.until)) {
    throw new Error("--until-stopped cannot be combined with --for, --max-runs, or --until.");
  }
  const task = positionals.join(" ").trim();
  if (!task) throw new Error("A task is required after --.");

  const intervalMs = parseDuration(values.every);
  const ttlMs = values["until-stopped"]
    ? null
    : parseDuration(values.for ?? "24h", { min: intervalMs, max: MAX_LIFETIME_MS });
  const config = {
    v: 1,
    id: newLoopId(),
    task,
    until: values.until?.trim() || null,
    intervalMs,
    ttlMs,
    maxRuns: positiveInteger(values["max-runs"], "--max-runs"),
    immediate: values.now,
  };
  await writePendingConfig(config);
  const lifetime = ttlMs === null ? "until stopped" : formatDuration(ttlMs);
  console.log(`Codex Loop prepared: every ${formatDuration(intervalMs)}, lifetime ${lifetime}.`);
  console.log("Include this exact marker once in the final assistant response:");
  console.log(createStartMarker(config.id));
}

function control(command, args) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: { id: { type: "string" } },
  });
  console.log("Include this exact marker once in the final assistant response:");
  console.log(createControlMarker(command, values.id ?? null));
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ["help", "--help", "-h"].includes(command)) return console.log(HELP);
  if (command === "start") return start(args);
  if (command === "stop" || command === "complete") return control(command, args);
  throw new Error(`Unknown command: ${command}`);
}

try {
  await main();
} catch (error) {
  console.error(`loopctl: ${error.message}`);
  process.exitCode = 1;
}
