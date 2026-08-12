#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { formatDuration } from "./lib/duration.mjs";
import { createControlMarker, parseControlMarker, parseStartMarker } from "./lib/markers.mjs";
import { defaultPendingDir, takePendingConfig } from "./lib/pending.mjs";
import { defaultDataDir, readLoopState, writeLoopState } from "./lib/state.mjs";

const ACTIVE_STATUSES = new Set(["waiting", "running"]);
const MAX_SAVED_MESSAGE = 2_000;

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Interrupted"));
    const timer = setTimeout(done, Math.max(0, milliseconds));
    function done() {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Interrupted"));
    }
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

function activate(config, input, now) {
  return {
    version: 1,
    id: config.id,
    sessionId: input.session_id,
    cwd: input.cwd,
    task: config.task,
    until: config.until,
    intervalMs: config.intervalMs,
    maxRuns: config.maxRuns,
    status: "waiting",
    runs: 0,
    createdAt: now,
    expiresAt: config.ttlMs === null ? null : now + config.ttlMs,
    nextRunAt: config.immediate ? now : now + config.intervalMs,
    lastStartedAt: null,
    lastCompletedAt: null,
    endedAt: null,
    endReason: null,
    lastAssistantMessage: null,
  };
}

function endLoop(state, status, reason, now) {
  return {
    ...state,
    status,
    endReason: reason,
    endedAt: now,
    nextRunAt: null,
  };
}

function completionReason(state, now) {
  if (state.maxRuns !== null && state.runs >= state.maxRuns) return "max-runs";
  if (state.expiresAt !== null && now >= state.expiresAt) return "expired";
  return null;
}

function continuationPrompt(state) {
  if (state.expiresAt === null) {
    return `[Codex Loop ${state.id}] Run ${state.runs + 1}.\n\nTask: ${state.task}\n\nPerform exactly one pass in the current working directory, then finish normally. This loop ends only when the user asks to stop it or interrupts the TUI. Do not mark it complete and do not start another loop.`;
  }
  const condition = state.until ? `\nCompletion condition: ${state.until}` : "";
  const completionMarker = createControlMarker("complete", state.id);
  return `[Codex Loop ${state.id}] Run ${state.runs + 1}.\n\nTask: ${state.task}${condition}\n\nPerform exactly one pass in the current working directory. If the task or completion condition is definitely satisfied, include this exact marker in the final response: ${completionMarker}\nOtherwise finish normally; the hook will wait ${formatDuration(state.intervalMs)} before the next run. Do not start another loop.`;
}

async function waitAndContinue(state, context) {
  const { clock, dataDir, signal, sleep } = context;
  state = { ...state, status: "waiting" };
  await writeLoopState(state, dataDir);
  try {
    await sleep(Math.max(0, state.nextRunAt - clock()), signal);
  } catch (error) {
    if (!signal?.aborted) throw error;
    state = endLoop(state, "terminated", "interrupted", clock());
    await writeLoopState(state, dataDir);
    return {};
  }

  if (signal?.aborted) {
    state = endLoop(state, "terminated", "interrupted", clock());
    await writeLoopState(state, dataDir);
    return {};
  }

  const now = clock();
  const reason = completionReason(state, now);
  if (reason) {
    state = endLoop(state, "completed", reason, now);
    await writeLoopState(state, dataDir);
    return { systemMessage: `Codex Loop ${state.id} completed (${reason}).` };
  }

  state = { ...state, status: "running", lastStartedAt: now };
  await writeLoopState(state, dataDir);
  return { decision: "block", reason: continuationPrompt(state) };
}

export async function handleStop(input, options = {}) {
  if (!input || input.hook_event_name !== "Stop" || typeof input.session_id !== "string") return {};

  const context = {
    clock: options.clock ?? (() => Date.now()),
    dataDir: options.dataDir ?? defaultDataDir(),
    pendingDir: options.pendingDir ?? defaultPendingDir(),
    signal: options.signal,
    sleep: options.sleep ?? delay,
  };
  const message = input.last_assistant_message ?? "";
  const control = parseControlMarker(message);
  const startId = parseStartMarker(message);
  const startConfig = startId ? await takePendingConfig(startId, context.pendingDir) : null;
  let state = await readLoopState(input.session_id, context.dataDir);
  const now = context.clock();

  if (control?.action === "stop") {
    if (state && ACTIVE_STATUSES.has(state.status) && (!control.id || control.id === state.id)) {
      state = endLoop(state, "terminated", "requested", now);
      await writeLoopState(state, context.dataDir);
      return { systemMessage: `Codex Loop ${state.id} terminated.` };
    }
    return {};
  }

  if (startId && !startConfig) {
    return { systemMessage: `Codex Loop ${startId} could not start because its pending configuration was not found.` };
  }

  if (startConfig && (!state || !ACTIVE_STATUSES.has(state.status) || state.id !== startConfig.id)) {
    state = activate(startConfig, input, now);
    await writeLoopState(state, context.dataDir);
    return waitAndContinue(state, context);
  }

  if (!state || !ACTIVE_STATUSES.has(state.status)) return {};

  if (input.stop_hook_active !== true) {
    state = endLoop(state, "terminated", "interrupted-turn", now);
    await writeLoopState(state, context.dataDir);
    return { systemMessage: `Codex Loop ${state.id} terminated (turn interrupted).` };
  }

  if (state.status === "running") {
    state = {
      ...state,
      runs: state.runs + 1,
      lastCompletedAt: now,
      lastAssistantMessage: message.slice(-MAX_SAVED_MESSAGE),
    };

    if (state.expiresAt !== null && control?.action === "complete" && (!control.id || control.id === state.id)) {
      state = endLoop(state, "completed", "condition-met", now);
      await writeLoopState(state, context.dataDir);
      return { systemMessage: `Codex Loop ${state.id} completed (condition met).` };
    }

    const reason = completionReason(state, now);
    if (reason) {
      state = endLoop(state, "completed", reason, now);
      await writeLoopState(state, context.dataDir);
      return { systemMessage: `Codex Loop ${state.id} completed (${reason}).` };
    }
    state = { ...state, status: "waiting", nextRunAt: now + state.intervalMs };
  }

  return waitAndContinue(state, context);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const controller = new AbortController();
  const interrupt = (signal) => controller.abort(new Error(signal));
  const onSigint = () => interrupt("SIGINT");
  const onSigterm = () => interrupt("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    const input = JSON.parse(await readStdin());
    const output = await handleStop(input, { signal: controller.signal });
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ systemMessage: `Codex Loop hook failed and will not continue: ${error.message}` })}\n`);
    process.exitCode = 0;
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
