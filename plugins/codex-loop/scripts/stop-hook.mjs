#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { detectAppServerRuntime, readAppServerTurnStatus } from "./lib/app-server-client.mjs";
import {
  ACTIVE_STATUSES,
  activateLoop,
  beginRun,
  completionReason,
  continuationPrompt,
  endLoop,
  failLoop,
  recordRunCompletion,
  scheduleNextRun,
} from "./lib/loop-state.mjs";
import { parseControlMarker, parseStartMarker } from "./lib/markers.mjs";
import { defaultPendingDir, takePendingConfig } from "./lib/pending.mjs";
import { defaultDataDir, readLoopState, writeLoopState } from "./lib/state.mjs";
import { spawnWakeWorker } from "./wake-worker.mjs";

const MAX_STOP_HOOK_WAIT_MS = 7 * 24 * 60 * 60 * 1_000 - 60_000;

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

async function waitAndContinue(state, context) {
  const { clock, dataDir, signal, sleep } = context;
  state = { ...state, status: "waiting" };
  const remaining = Math.max(0, state.nextRunAt - clock());
  if (remaining > MAX_STOP_HOOK_WAIT_MS) {
    state = failLoop(
      state,
      "stop-hook-wait-too-long",
      "The next wake-up is beyond the synchronous Stop-hook limit; launch with loop-codex.",
      clock(),
    );
    await writeLoopState(state, dataDir);
    return {
      systemMessage: `Codex Loop ${state.id} requires loop-codex because its next wait exceeds the synchronous Stop-hook limit.`,
    };
  }
  await writeLoopState(state, dataDir);
  try {
    await sleep(remaining, signal);
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

  state = beginRun(state, now);
  await writeLoopState(state, dataDir);
  return { decision: "block", reason: continuationPrompt(state) };
}

async function armAppServerWake(state, context) {
  const wakeToken = randomUUID();
  state = { ...state, status: "waiting", wakeToken };
  await writeLoopState(state, context.dataDir);
  try {
    await context.scheduleWake({
      sessionId: state.sessionId,
      loopId: state.id,
      wakeToken,
      dataDir: context.dataDir,
    });
    return { state, error: null };
  } catch (error) {
    state = failLoop(state, "wake-worker-error", error, context.clock());
    await writeLoopState(state, context.dataDir);
    return { state, error };
  }
}

async function continueAppServerLoop(state, context) {
  const armed = await armAppServerWake(state, context);
  if (armed.error) {
    return { systemMessage: `Codex Loop ${state.id} failed to schedule: ${armed.error.message}` };
  }
  return {};
}

function appServerStartedMessage(state) {
  return {
    systemMessage: `Codex Loop ${state.id} is active through App Server; this TUI remains available while the loop waits.`,
  };
}

export async function handleStop(input, options = {}) {
  if (!input || input.hook_event_name !== "Stop" || typeof input.session_id !== "string") return {};

  const context = {
    clock: options.clock ?? (() => Date.now()),
    dataDir: options.dataDir ?? defaultDataDir(),
    detectRuntime: options.detectRuntime ?? detectAppServerRuntime,
    pendingDir: options.pendingDir ?? defaultPendingDir(),
    readTurnStatus: options.readTurnStatus ?? readAppServerTurnStatus,
    scheduleWake: options.scheduleWake ?? spawnWakeWorker,
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
    const runtime = await context.detectRuntime(input);
    state = activateLoop(startConfig, input, now, runtime);
    if (state.backend === "app-server") {
      const armed = await armAppServerWake(state, context);
      if (armed.error) {
        return { systemMessage: `Codex Loop ${state.id} failed to start: ${armed.error.message}` };
      }
      return appServerStartedMessage(state);
    }
    return waitAndContinue(state, context);
  }

  if (state?.status === "failed" && !state.failureReportedAt) {
    state = { ...state, failureReportedAt: now };
    await writeLoopState(state, context.dataDir);
    return { systemMessage: `Codex Loop ${state.id} failed (${state.endReason}): ${state.lastError ?? "unknown error"}` };
  }
  if (!state || !ACTIVE_STATUSES.has(state.status)) return {};

  if (state.backend === "app-server") {
    if (state.status !== "running" || (state.activeTurnId && state.activeTurnId !== input.turn_id)) return {};
    const turnStatus = state.activeTurnId
      ? await context.readTurnStatus(state.threadId, state.activeTurnId)
      : null;
    if (turnStatus === "interrupted") {
      state = endLoop(state, "terminated", "interrupted-turn", now);
      await writeLoopState(state, context.dataDir);
      return { systemMessage: `Codex Loop ${state.id} terminated (turn interrupted).` };
    }
    if (turnStatus === "failed") {
      state = failLoop(state, "turn-failed", "App Server turn failed.", now);
      await writeLoopState(state, context.dataDir);
      return { systemMessage: `Codex Loop ${state.id} failed (turn failed).` };
    }
  } else if (input.stop_hook_active !== true) {
    state = endLoop(state, "terminated", "interrupted-turn", now);
    await writeLoopState(state, context.dataDir);
    return { systemMessage: `Codex Loop ${state.id} terminated (turn interrupted).` };
  }

  if (state.status === "running") {
    state = recordRunCompletion(state, message, now);

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
    state = scheduleNextRun(state, message, now);
  }

  if (state.backend === "app-server") return continueAppServerLoop(state, context);
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
