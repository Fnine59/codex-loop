import { randomBytes } from "node:crypto";
import {
  MAX_DYNAMIC_INTERVAL_MS,
  MAX_INTERVAL_MS,
  MAX_LIFETIME_MS,
  MIN_DYNAMIC_INTERVAL_MS,
  MIN_INTERVAL_MS,
  parseDuration,
} from "./duration.mjs";

const START_PATTERN = /<!--\s*codex-loop:v1:start:([a-f0-9]{12})\s*-->/g;
const CONTROL_PATTERN = /<!--\s*codex-loop:v1:(stop|complete)(?::([a-f0-9]{12}))?\s*-->/g;
const NEXT_PATTERN = /<!--\s*codex-loop:v1:next:([a-f0-9]{12}):(\d+(?:s|m|h|d))\s*-->/g;
const ID_PATTERN = /^[a-f0-9]{12}$/;
const MAX_TASK_LENGTH = 12_000;
const MAX_UNTIL_LENGTH = 4_000;
const MAX_RUNS = 10_000;

export function newLoopId() {
  return randomBytes(6).toString("hex");
}

function assertText(value, name, maxLength) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  if (value.length > maxLength) throw new Error(`${name} is too long.`);
}

export function validateStartConfig(config) {
  if (!config || config.v !== 1) throw new Error("Unsupported Codex Loop marker version.");
  if (!ID_PATTERN.test(config.id ?? "")) throw new Error("Invalid loop ID.");
  assertText(config.task, "Task", MAX_TASK_LENGTH);
  if (config.intervalMs !== null && (
    !Number.isSafeInteger(config.intervalMs) ||
    config.intervalMs < MIN_INTERVAL_MS ||
    config.intervalMs > MAX_INTERVAL_MS
  )) {
    throw new Error("Invalid loop interval.");
  }
  const minimumLifetime = config.intervalMs ?? MIN_DYNAMIC_INTERVAL_MS;
  if (
    config.ttlMs !== null &&
    (!Number.isSafeInteger(config.ttlMs) || config.ttlMs < minimumLifetime || config.ttlMs > MAX_LIFETIME_MS)
  ) {
    throw new Error("The loop lifetime must be null or between one interval and 3650d.");
  }
  if (config.maxRuns !== null && (!Number.isSafeInteger(config.maxRuns) || config.maxRuns < 1 || config.maxRuns > MAX_RUNS)) {
    throw new Error(`maxRuns must be between 1 and ${MAX_RUNS}.`);
  }
  if (config.until !== null) assertText(config.until, "Completion condition", MAX_UNTIL_LENGTH);
  if (config.ttlMs === null && (config.maxRuns !== null || config.until !== null)) {
    throw new Error("An until-stopped loop cannot have another automatic completion bound.");
  }
  if (typeof config.immediate !== "boolean") throw new Error("Invalid immediate flag.");
  return config;
}

export function createStartMarker(id) {
  if (!ID_PATTERN.test(id ?? "")) throw new Error("Invalid loop ID.");
  return `<!-- codex-loop:v1:start:${id} -->`;
}

export function createControlMarker(action, id = null) {
  if (!["stop", "complete"].includes(action)) throw new Error(`Unknown control action: ${action}`);
  if (id !== null && !ID_PATTERN.test(id)) throw new Error("Invalid loop ID.");
  return `<!-- codex-loop:v1:${action}${id ? `:${id}` : ""} -->`;
}

export function createNextMarker(id, duration) {
  if (!ID_PATTERN.test(id ?? "")) throw new Error("Invalid loop ID.");
  parseDuration(duration, { min: MIN_DYNAMIC_INTERVAL_MS, max: MAX_DYNAMIC_INTERVAL_MS });
  return `<!-- codex-loop:v1:next:${id}:${duration} -->`;
}

function lastMatch(pattern, text) {
  pattern.lastIndex = 0;
  let result = null;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) result = match;
  return result;
}

export function parseStartMarker(message) {
  const match = lastMatch(START_PATTERN, message ?? "");
  return match?.[1] ?? null;
}

export function parseControlMarker(message) {
  const match = lastMatch(CONTROL_PATTERN, message ?? "");
  if (!match) return null;
  return { action: match[1], id: match[2] ?? null };
}

export function parseNextMarker(message) {
  const match = lastMatch(NEXT_PATTERN, message ?? "");
  if (!match) return null;
  try {
    return {
      id: match[1],
      duration: match[2],
      delayMs: parseDuration(match[2], { min: MIN_DYNAMIC_INTERVAL_MS, max: MAX_DYNAMIC_INTERVAL_MS }),
    };
  } catch {
    return { id: match[1], duration: match[2], delayMs: null };
  }
}
