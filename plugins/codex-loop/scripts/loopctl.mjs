#!/usr/bin/env node

import { parseArgs } from "node:util";
import {
  DEFAULT_DYNAMIC_INTERVAL_MS,
  formatDuration,
  MAX_DYNAMIC_INTERVAL_MS,
  MAX_LIFETIME_MS,
  MIN_DYNAMIC_INTERVAL_MS,
  parseDuration,
} from "./lib/duration.mjs";
import { intervalToCron, normalizeCronExpression } from "./lib/cron.mjs";
import { createControlMarker, createStartMarker, newLoopId } from "./lib/markers.mjs";
import { writePendingConfig } from "./lib/pending.mjs";

const HELP = `loopctl

Usage:
  loopctl start [--every <duration> | --cron <expression>] [--max-runs <count>] [--for <duration> | --until-stopped] [--until <condition>] [--now] -- <task>
  loopctl stop
  loopctl complete [--id <loop-id>]

This is an internal Codex Loop helper. It emits a marker for the current assistant response.
Five-field Cron expressions are evaluated by the plugin; no system crontab entry is created.
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
      cron: { type: "string" },
      "max-runs": { type: "string" },
      for: { type: "string" },
      "until-stopped": { type: "boolean", default: false },
      until: { type: "string" },
      now: { type: "boolean", default: false },
    },
  });
  if (values.every && values.cron) throw new Error("--every and --cron cannot be combined.");
  if (values["until-stopped"] && (values.for || values["max-runs"] || values.until)) {
    throw new Error("--until-stopped cannot be combined with --for, --max-runs, or --until.");
  }
  const task = positionals.join(" ").trim();
  if (!task) throw new Error("A task is required after --.");

  const requestedIntervalMs = values.every ? parseDuration(values.every) : null;
  const normalizedInterval = requestedIntervalMs === null ? null : intervalToCron(requestedIntervalMs);
  const cronExpression = values.cron
    ? normalizeCronExpression(values.cron)
    : normalizedInterval?.expression ?? null;
  const intervalMs = normalizedInterval?.intervalMs ?? null;
  const cadenceLabel = values.cron ? `cron ${cronExpression}` : normalizedInterval?.description ?? null;
  const minimumLifetime = intervalMs ?? MIN_DYNAMIC_INTERVAL_MS;
  const ttlMs = values["until-stopped"]
    ? null
    : parseDuration(values.for ?? "24h", { min: minimumLifetime, max: MAX_LIFETIME_MS });
  const config = {
    v: 1,
    id: newLoopId(),
    task,
    until: values.until?.trim() || null,
    intervalMs,
    cronExpression,
    cadenceLabel,
    ttlMs,
    maxRuns: positiveInteger(values["max-runs"], "--max-runs"),
    immediate: cronExpression === null || values.now,
  };
  await writePendingConfig(config);
  const lifetime = ttlMs === null ? "until stopped" : formatDuration(ttlMs);
  const cadence = cronExpression === null
    ? `adaptive ${formatDuration(MIN_DYNAMIC_INTERVAL_MS)}-${formatDuration(MAX_DYNAMIC_INTERVAL_MS)} (${formatDuration(DEFAULT_DYNAMIC_INTERVAL_MS)} fallback)`
    : `${cadenceLabel} (${cronExpression})`;
  if (normalizedInterval?.adjusted) {
    console.log(`Codex Loop normalized ${formatDuration(requestedIntervalMs)} to ${formatDuration(intervalMs)} because Cron resolution is one minute and uses clean wall-clock boundaries.`);
  }
  console.log(`Codex Loop prepared: ${cadence}, lifetime ${lifetime}.`);
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
