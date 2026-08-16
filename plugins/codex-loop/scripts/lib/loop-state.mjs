import {
  DEFAULT_DYNAMIC_INTERVAL_MS,
  formatDuration,
  MAX_DYNAMIC_INTERVAL_MS,
  MIN_DYNAMIC_INTERVAL_MS,
} from "./duration.mjs";
import { nextCronTime } from "./cron.mjs";
import { createControlMarker, parseNextMarker } from "./markers.mjs";

export const ACTIVE_STATUSES = new Set(["waiting", "launching", "running"]);
const MAX_SAVED_MESSAGE = 2_000;
const MAX_USAGE_LIMIT_RETRY_MS = 60 * 60 * 1_000;
const MIN_USAGE_LIMIT_RETRY_MS = 5 * 60 * 1_000;
const USAGE_LIMIT_RESET_GRACE_MS = 60_000;

function capAtExpiry(timestamp, expiresAt) {
  return expiresAt === null ? timestamp : Math.min(timestamp, expiresAt);
}

function errorMessage(error) {
  return String(error?.message ?? error ?? "App Server turn failed.").slice(0, MAX_SAVED_MESSAGE);
}

function normalizedErrorCode(error) {
  const code = error?.codexErrorInfo ?? error?.codex_error_info;
  return typeof code === "string" ? code.replace(/[^a-z]/gi, "").toLowerCase() : "";
}

export function isUsageLimitError(error) {
  return normalizedErrorCode(error) === "usagelimitexceeded" || /\busage limit\b/i.test(errorMessage(error));
}

function reportedUsageLimitRetryAt(error, now) {
  const match = errorMessage(error).match(/\btry again at\s+(.+?)(?:\.\s*$|$)/i);
  if (match) {
    const normalized = match[1].replace(/(\d{1,2})(?:st|nd|rd|th)\b/gi, "$1");
    const resetAt = Date.parse(normalized);
    if (Number.isFinite(resetAt) && resetAt > now) return resetAt + USAGE_LIMIT_RESET_GRACE_MS;
  }
  return null;
}

export function usageLimitRetryAt(error, now, retryCount = 1) {
  const reportedRetryAt = reportedUsageLimitRetryAt(error, now);
  if (reportedRetryAt !== null) return reportedRetryAt;
  const exponent = Math.max(0, Math.min(retryCount - 1, 10));
  return now + Math.min(MAX_USAGE_LIMIT_RETRY_MS, MIN_USAGE_LIMIT_RETRY_MS * (2 ** exponent));
}

export function activateLoop(config, input, now, runtime = { backend: "stop-hook" }) {
  const scheduleMode = config.cronExpression
    ? "cron"
    : config.intervalMs === null ? "dynamic" : "fixed";
  const expiresAt = config.ttlMs === null ? null : now + config.ttlMs;
  let scheduledAt;
  if (scheduleMode === "dynamic" || config.immediate) scheduledAt = now;
  else if (scheduleMode === "cron") scheduledAt = nextCronTime(config.cronExpression, now);
  else scheduledAt = now + config.intervalMs;

  return {
    version: 1,
    id: config.id,
    sessionId: input.session_id,
    threadId: runtime.threadId ?? null,
    backend: runtime.backend,
    cwd: input.cwd,
    task: config.task,
    until: config.until,
    intervalMs: config.intervalMs,
    cronExpression: config.cronExpression ?? null,
    cadenceLabel: config.cadenceLabel ?? null,
    scheduleMode,
    maxRuns: config.maxRuns,
    status: "waiting",
    runs: 0,
    createdAt: now,
    expiresAt,
    nextRunAt: capAtExpiry(scheduledAt, expiresAt),
    cronCursorAt: scheduleMode === "cron" ? scheduledAt : null,
    scheduledFor: null,
    wakeToken: null,
    activeTurnId: null,
    lastDelayMs: null,
    lastDelaySource: null,
    lastStartedAt: null,
    lastCompletedAt: null,
    endedAt: null,
    endReason: null,
    lastAssistantMessage: null,
    lastError: null,
    lastErrorCode: null,
    usageLimitRetries: 0,
    lastLimitedAt: null,
  };
}

export function endLoop(state, status, reason, now, extra = {}) {
  return {
    ...state,
    ...extra,
    status,
    endReason: reason,
    endedAt: now,
    nextRunAt: null,
    wakeToken: null,
    activeTurnId: null,
  };
}

export function failLoop(state, reason, error, now) {
  return endLoop(state, "failed", reason, now, {
    lastError: String(error?.message ?? error).slice(0, 2_000),
  });
}

export function completionReason(state, now) {
  if (state.maxRuns !== null && state.runs >= state.maxRuns) return "max-runs";
  if (state.expiresAt !== null && now >= state.expiresAt) return "expired";
  return null;
}

export function beginRun(state, now, { activeTurnId = null } = {}) {
  const cronCursorAt = state.scheduleMode === "cron" && state.cronCursorAt < now
    ? now
    : state.cronCursorAt;
  return {
    ...state,
    status: "running",
    scheduledFor: state.nextRunAt,
    nextRunAt: null,
    cronCursorAt,
    wakeToken: null,
    activeTurnId,
    lastStartedAt: now,
    lastError: null,
    lastErrorCode: null,
  };
}

export function recordRunCompletion(state, message, now) {
  return {
    ...state,
    runs: state.runs + 1,
    lastCompletedAt: now,
    lastAssistantMessage: String(message ?? "").slice(-MAX_SAVED_MESSAGE),
    lastError: null,
    lastErrorCode: null,
    usageLimitRetries: 0,
  };
}

export function scheduleUsageLimitRetry(state, error, now) {
  const usageLimitRetries = (state.usageLimitRetries ?? 0) + 1;
  const reportedRetryAt = reportedUsageLimitRetryAt(error, now);
  const retryAt = reportedRetryAt ?? usageLimitRetryAt(error, now, usageLimitRetries);
  const nextRunAt = capAtExpiry(retryAt, state.expiresAt);
  return {
    ...state,
    status: "waiting",
    activeTurnId: null,
    nextRunAt,
    wakeToken: null,
    lastDelayMs: Math.max(0, nextRunAt - now),
    lastDelaySource: reportedRetryAt === null ? "usage-limit-backoff" : "usage-limit-reset",
    lastError: errorMessage(error),
    lastErrorCode: "usageLimitExceeded",
    usageLimitRetries,
    lastLimitedAt: now,
  };
}

export function scheduleNextRun(state, message, now) {
  let nextRunAt;
  let cronCursorAt = state.cronCursorAt;
  let lastDelaySource;

  if (state.scheduleMode === "dynamic") {
    const requestedDelay = parseNextMarker(message);
    const useRequestedDelay = requestedDelay?.id === state.id && requestedDelay.delayMs !== null;
    const delayMs = useRequestedDelay ? requestedDelay.delayMs : DEFAULT_DYNAMIC_INTERVAL_MS;
    nextRunAt = now + delayMs;
    lastDelaySource = useRequestedDelay ? "model" : "fallback";
  } else if (state.scheduleMode === "cron") {
    const candidate = nextCronTime(state.cronExpression, state.cronCursorAt ?? now);
    const missed = candidate <= now;
    nextRunAt = missed ? now : candidate;
    cronCursorAt = missed ? now : candidate;
    lastDelaySource = missed ? "cron-queued" : "cron";
  } else {
    nextRunAt = now + state.intervalMs;
    lastDelaySource = "fixed";
  }

  nextRunAt = capAtExpiry(nextRunAt, state.expiresAt);
  return {
    ...state,
    status: "waiting",
    activeTurnId: null,
    nextRunAt,
    cronCursorAt,
    lastDelayMs: Math.max(0, nextRunAt - now),
    lastDelaySource,
  };
}

export function continuationPrompt(state) {
  const stopOnly = state.expiresAt === null;
  const task = `[Codex Loop ${state.id}] Run ${state.runs + 1}.\n\nTask: ${state.task}`;
  const condition = state.until ? `\nCompletion condition: ${state.until}` : "";
  const ownership = "Codex Loop is the sole scheduler for this work. Do not call create_goal or use durable-goal auto-continuation. End this turn after exactly one pass so the Stop hook can schedule the next pass.";

  if (state.scheduleMode === "dynamic") {
    const nextMarker = `<!-- codex-loop:v1:next:${state.id}:<delay> -->`;
    const schedule = `After the pass, choose the next delay from ${formatDuration(MIN_DYNAMIC_INTERVAL_MS)} to ${formatDuration(MAX_DYNAMIC_INTERVAL_MS)} based on what you observed. To continue, include exactly one marker in the final response by replacing <delay> with a whole duration such as 1m, 30m, or 1h: ${nextMarker} If the marker is missing or invalid, the hook uses ${formatDuration(DEFAULT_DYNAMIC_INTERVAL_MS)}.`;
    if (stopOnly) {
      return `${task}\n\n${ownership} Perform exactly one pass in the current working directory. This loop ends only when the user asks to stop it or ends the session. Do not mark it complete. ${schedule} Do not start another loop.`;
    }
    const completionMarker = createControlMarker("complete", state.id);
    return `${task}${condition}\n\n${ownership} Perform exactly one pass in the current working directory. If the task or completion condition is definitely satisfied, include this exact marker and do not include a next-delay marker: ${completionMarker} Otherwise, ${schedule} Do not start another loop.`;
  }

  const scheduling = state.scheduleMode === "cron"
    ? `The loop follows ${state.cadenceLabel ?? `cron ${state.cronExpression}`} in local time. If scheduled times pass while a run is active, queue one catch-up pass only; do not backfill every missed tick.`
    : `The hook waits ${formatDuration(state.intervalMs)} after this pass before the next run.`;
  if (stopOnly) {
    return `${task}\n\n${ownership} Perform exactly one pass in the current working directory, then finish normally. This loop ends only when the user asks to stop it or ends the session. ${scheduling} Do not mark it complete and do not start another loop.`;
  }
  const completionMarker = createControlMarker("complete", state.id);
  return `${task}${condition}\n\n${ownership} Perform exactly one pass in the current working directory. If the task or completion condition is definitely satisfied, include this exact marker in the final response: ${completionMarker}\nOtherwise finish normally. ${scheduling} Do not start another loop.`;
}
