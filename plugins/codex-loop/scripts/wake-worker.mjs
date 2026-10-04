#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { AppServerClient } from "./lib/app-server-client.mjs";
import { nextCronTime } from "./lib/cron.mjs";
import {
  completionReason,
  continuationPrompt,
  endLoop,
  failLoop,
  beginRun,
  clearRuntimeUnavailable,
  isUsageLimitError,
  isTransientServiceError,
  markRuntimeUnavailable,
  scheduleTransientServiceRetry,
  scheduleUsageLimitRetry,
} from "./lib/loop-state.mjs";
import { defaultDataDir, readLoopState, writeLoopState } from "./lib/state.mjs";

const MAX_SLEEP_CHUNK_MS = 60_000;
const THREAD_START_RETRY_MS = 60_000;
const TURN_MONITOR_STATE_CHECK_MS = 60_000;
const DEFAULT_TURN_RECONCILIATION_MS = 24 * 60 * 60 * 1_000;
const MIN_TURN_RECONCILIATION_MS = 60_000;
const RUNTIME_RECOVERY_MIN_MS = 1_000;
const RUNTIME_RECOVERY_MAX_MS = 60_000;
const TERMINAL_TURN_STATUSES = new Set(["completed", "failed", "interrupted"]);

export function threadAcceptsTurnStart(thread) {
  if (thread?.canAcceptDirectInput === true) return true;
  return thread?.canAcceptDirectInput == null && thread?.status?.type === "idle";
}

export function nextTurnReconciliationAt(state, afterMs) {
  if (!Number.isFinite(afterMs)) throw new Error("Turn reconciliation baseline must be finite.");
  if (state?.scheduleMode === "cron" && state.cronExpression) {
    return nextCronTime(state.cronExpression, afterMs);
  }
  if (state?.scheduleMode === "fixed" && Number.isFinite(state.intervalMs)) {
    return afterMs + Math.max(MIN_TURN_RECONCILIATION_MS, state.intervalMs);
  }
  return afterMs + DEFAULT_TURN_RECONCILIATION_MS;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
}

function matchesWake(state, loopId, wakeToken, statuses = ["waiting"]) {
  return state?.id === loopId &&
    state.backend === "app-server" &&
    statuses.includes(state.status) &&
    state.wakeToken === wakeToken;
}

async function readMatchingState(sessionId, loopId, wakeToken, dataDir, statuses) {
  const state = await readLoopState(sessionId, dataDir);
  return matchesWake(state, loopId, wakeToken, statuses) ? state : null;
}

async function waitUntilDue(sessionId, loopId, wakeToken, context) {
  while (true) {
    const state = await readMatchingState(sessionId, loopId, wakeToken, context.dataDir, ["waiting"]);
    if (!state) return null;
    const remaining = state.nextRunAt - context.clock();
    if (remaining <= 0) return state;
    await context.sleep(Math.min(remaining, MAX_SLEEP_CHUNK_MS));
  }
}

async function failCurrentWake(sessionId, loopId, wakeToken, context, error) {
  const state = await readMatchingState(
    sessionId,
    loopId,
    wakeToken,
    context.dataDir,
    ["waiting", "launching"],
  );
  if (!state) return;
  await writeLoopState(failLoop(state, "app-server-error", error, context.clock()), context.dataDir);
}

function runtimeRecoveryDelay(attempts) {
  return Math.min(RUNTIME_RECOVERY_MAX_MS, RUNTIME_RECOVERY_MIN_MS * (2 ** Math.min(attempts - 1, 10)));
}

async function setRuntimeUnavailable(sessionId, matchesOwner, context, error, attempts) {
  const state = await readLoopState(sessionId, context.dataDir);
  if (!matchesOwner(state)) return false;
  const now = context.clock();
  const retryAt = now + runtimeRecoveryDelay(attempts);
  await writeLoopState(markRuntimeUnavailable(state, error, now, retryAt, attempts), context.dataDir);
  return true;
}

async function setRuntimeAvailable(sessionId, matchesOwner, context) {
  const state = await readLoopState(sessionId, context.dataDir);
  if (!matchesOwner(state)) return false;
  const available = clearRuntimeUnavailable(state);
  if (available !== state) await writeLoopState(available, context.dataDir);
  return true;
}

function matchesActiveTurn(state, loopId, turnId) {
  return state?.id === loopId &&
    state.backend === "app-server" &&
    state.status === "running" &&
    state.activeTurnId === turnId;
}

async function handleTurnCompletion(sessionId, loopId, turn, context) {
  const state = await readLoopState(sessionId, context.dataDir);
  if (!matchesActiveTurn(state, loopId, turn?.id)) return false;
  const now = context.clock();

  if (turn.status === "completed") return true;
  if (turn.status === "interrupted") {
    await writeLoopState(endLoop(state, "terminated", "interrupted-turn", now), context.dataDir);
    return false;
  }
  if (turn.status !== "failed") {
    await writeLoopState(failLoop(state, "turn-status-invalid", `Unexpected App Server turn status: ${turn.status}.`, now), context.dataDir);
    return false;
  }
  if (!isUsageLimitError(turn.error)) {
    if (!isTransientServiceError(turn.error)) {
      await writeLoopState(failLoop(state, "turn-failed", turn.error ?? "App Server turn failed.", now), context.dataDir);
      return false;
    }

    const wakeToken = randomUUID();
    const retryState = { ...scheduleTransientServiceRetry(state, turn.error, now), wakeToken };
    await writeLoopState(retryState, context.dataDir);
    try {
      await context.scheduleWake({
        sessionId,
        loopId,
        wakeToken,
        dataDir: context.dataDir,
      });
      return true;
    } catch (error) {
      const latest = await readMatchingState(sessionId, loopId, wakeToken, context.dataDir, ["waiting"]);
      if (latest) {
        await writeLoopState(failLoop(latest, "wake-worker-error", error, context.clock()), context.dataDir);
      }
      return false;
    }
  }

  const wakeToken = randomUUID();
  const retryState = { ...scheduleUsageLimitRetry(state, turn.error, now), wakeToken };
  await writeLoopState(retryState, context.dataDir);
  try {
    await context.scheduleWake({
      sessionId,
      loopId,
      wakeToken,
      dataDir: context.dataDir,
    });
    return true;
  } catch (error) {
    const latest = await readMatchingState(sessionId, loopId, wakeToken, context.dataDir, ["waiting"]);
    if (latest) {
      await writeLoopState(failLoop(latest, "wake-worker-error", error, context.clock()), context.dataDir);
    }
    return false;
  }
}

async function failOwnedWork(sessionId, loopId, wakeToken, activeTurnId, context, error) {
  if (!activeTurnId) return failCurrentWake(sessionId, loopId, wakeToken, context, error);
  const state = await readLoopState(sessionId, context.dataDir);
  if (!matchesActiveTurn(state, loopId, activeTurnId)) return;
  await writeLoopState(failLoop(state, "app-server-error", error, context.clock()), context.dataDir);
}

async function waitForStartedTurn(sessionId, loopId, threadId, turnId, initialClient, context) {
  let client = initialClient;
  let recoveryError = null;
  let recoveryAttempts = 0;
  let notification = null;
  let reconciliationAt = null;
  const watchCompletion = () => {
    const result = { error: null, turn: null };
    client.waitForTurnCompletion(threadId, turnId).then(
      (turn) => { result.turn = turn; },
      (error) => { result.error = error; },
    );
    return result;
  };
  notification = watchCompletion();
  const matchesOwner = (state) => matchesActiveTurn(state, loopId, turnId);

  while (true) {
    const state = await readLoopState(sessionId, context.dataDir);
    if (!matchesOwner(state)) return { client, turn: null };
    if (reconciliationAt === null) {
      reconciliationAt = nextTurnReconciliationAt(
        state,
        state.lastStartedAt ?? context.clock(),
      );
    }
    if (notification?.turn) {
      await setRuntimeAvailable(sessionId, matchesOwner, context);
      return { client, turn: notification.turn };
    }
    if (notification?.error) recoveryError = notification.error;

    if (recoveryError) {
      if (!context.reconnectClient) throw recoveryError;

      recoveryAttempts += 1;
      if (!await setRuntimeUnavailable(
        sessionId,
        matchesOwner,
        context,
        recoveryError,
        recoveryAttempts,
      )) return { client, turn: null };
      await context.sleep(runtimeRecoveryDelay(recoveryAttempts));
      if (!matchesOwner(await readLoopState(sessionId, context.dataDir))) return { client, turn: null };

      try {
        client = await context.reconnectClient(client);
        const turn = await client.readTurn(threadId, turnId);
        if (turn && TERMINAL_TURN_STATUSES.has(turn.status)) {
          await setRuntimeAvailable(sessionId, matchesOwner, context);
          return { client, turn };
        }
        if (!turn || turn.status !== "inProgress") {
          throw new Error(`App Server turn could not be reconciled: ${turnId}.`);
        }
        await setRuntimeAvailable(sessionId, matchesOwner, context);
        notification = watchCompletion();
        reconciliationAt = nextTurnReconciliationAt(state, context.clock());
        recoveryError = null;
        recoveryAttempts = 0;
      } catch (error) {
        recoveryError = error;
        notification = null;
      }
      continue;
    }

    const now = context.clock();
    if (now >= reconciliationAt) {
      try {
        const turn = await client.readTurn(threadId, turnId);
        if (turn && TERMINAL_TURN_STATUSES.has(turn.status)) {
          await setRuntimeAvailable(sessionId, matchesOwner, context);
          return { client, turn };
        }
        if (!turn || turn.status !== "inProgress") {
          throw new Error(`App Server turn could not be reconciled: ${turnId}.`);
        }
        await setRuntimeAvailable(sessionId, matchesOwner, context);
        reconciliationAt = nextTurnReconciliationAt(state, now);
      } catch (error) {
        recoveryError = error;
        notification = null;
      }
      continue;
    }

    await context.sleep(Math.min(TURN_MONITOR_STATE_CHECK_MS, reconciliationAt - now));
  }
}

async function waitForStartableThread(sessionId, loopId, wakeToken, initialClient, context) {
  let client = initialClient;
  let recoveryError = null;
  let recoveryAttempts = 0;
  const matchesOwner = (state) => matchesWake(state, loopId, wakeToken, ["waiting"]);

  while (true) {
    const state = await readLoopState(sessionId, context.dataDir);
    if (!matchesOwner(state)) return { client, state: null };
    const ended = completionReason(state, context.clock());
    if (ended) {
      await writeLoopState(endLoop(state, "completed", ended, context.clock()), context.dataDir);
      return { client, state: null };
    }

    if (recoveryError) {
      if (!context.reconnectClient) throw recoveryError;
      recoveryAttempts += 1;
      if (!await setRuntimeUnavailable(
        sessionId,
        matchesOwner,
        context,
        recoveryError,
        recoveryAttempts,
      )) return { client, state: null };
      await context.sleep(runtimeRecoveryDelay(recoveryAttempts));
      if (!matchesOwner(await readLoopState(sessionId, context.dataDir))) return { client, state: null };
      try {
        client = await context.reconnectClient(client);
        recoveryError = null;
      } catch (error) {
        recoveryError = error;
        continue;
      }
    }

    try {
      const thread = await client.readThread(state.threadId, false);
      if (!thread) throw new Error(`App Server thread is unavailable: ${state.threadId}.`);
      if (["notLoaded", "systemError"].includes(thread.status?.type)) {
        throw new Error(`App Server thread is ${thread.status.type}: ${state.threadId}.`);
      }
      await setRuntimeAvailable(sessionId, matchesOwner, context);
      recoveryAttempts = 0;
      if (threadAcceptsTurnStart(thread)) {
        return { client, state: await readMatchingState(
          sessionId,
          loopId,
          wakeToken,
          context.dataDir,
          ["waiting"],
        ) };
      }
      await context.sleep(THREAD_START_RETRY_MS);
    } catch (error) {
      recoveryError = error;
    }
  }
}

async function connectWakeClient(sessionId, loopId, wakeToken, context) {
  let attempts = 0;
  const matchesOwner = (state) => matchesWake(state, loopId, wakeToken, ["waiting"]);

  while (true) {
    const state = await readLoopState(sessionId, context.dataDir);
    if (!matchesOwner(state)) return null;
    const ended = completionReason(state, context.clock());
    if (ended) {
      await writeLoopState(endLoop(state, "completed", ended, context.clock()), context.dataDir);
      return null;
    }
    try {
      const client = await context.reconnectClient(null);
      await setRuntimeAvailable(sessionId, matchesOwner, context);
      return client;
    } catch (error) {
      attempts += 1;
      if (!await setRuntimeUnavailable(
        sessionId,
        matchesOwner,
        context,
        error,
        attempts,
      )) return null;
      await context.sleep(runtimeRecoveryDelay(attempts));
    }
  }
}

export async function runWake(sessionId, loopId, wakeToken, options = {}) {
  const context = {
    clock: options.clock ?? (() => Date.now()),
    dataDir: options.dataDir ?? defaultDataDir(),
    scheduleWake: options.scheduleWake ?? spawnWakeWorker,
    sleep: options.sleep ?? delay,
    reconnectClient: options.reconnectClient ?? null,
  };
  let client = options.client ?? null;
  let activeTurnId = null;
  const ownsClient = !client;
  const ownedClients = new Set();

  if (!context.reconnectClient && ownsClient) {
    context.reconnectClient = async (previous) => {
      previous?.close();
      const next = new AppServerClient();
      ownedClients.add(next);
      try {
        await next.connect();
      } catch (error) {
        next.close();
        throw error;
      }
      return next;
    };
  }

  try {
    let state = await waitUntilDue(sessionId, loopId, wakeToken, context);
    if (!state) return false;
    const reason = completionReason(state, context.clock());
    if (reason) {
      await writeLoopState(endLoop(state, "completed", reason, context.clock()), context.dataDir);
      return false;
    }

    if (!client) {
      client = await connectWakeClient(sessionId, loopId, wakeToken, context);
      if (!client) return false;
    }
    const startable = await waitForStartableThread(
      sessionId,
      loopId,
      wakeToken,
      client,
      context,
    );
    client = startable.client;
    if (!startable.state) return false;

    state = await readMatchingState(sessionId, loopId, wakeToken, context.dataDir, ["waiting"]);
    if (!state) return false;
    const prompt = continuationPrompt(state);
    await writeLoopState({ ...state, status: "launching" }, context.dataDir);
    state = await readMatchingState(sessionId, loopId, wakeToken, context.dataDir, ["launching"]);
    if (!state) return false;

    const turn = await client.startTurn(state.threadId, prompt, state.cwd);
    if (!turn?.id) throw new Error("App Server did not return a turn ID.");
    const latest = await readLoopState(sessionId, context.dataDir);
    if (!matchesWake(latest, loopId, wakeToken, ["launching"])) {
      try {
        await client.interruptTurn(state.threadId, turn.id);
      } catch {
        // The loop was stopped during launch; interruption is best-effort.
      }
      return false;
    }
    await writeLoopState(beginRun(latest, context.clock(), { activeTurnId: turn.id }), context.dataDir);
    activeTurnId = turn.id;
    const completion = await waitForStartedTurn(
      sessionId,
      loopId,
      state.threadId,
      turn.id,
      client,
      context,
    );
    client = completion.client;
    if (!completion.turn) return false;
    return await handleTurnCompletion(sessionId, loopId, completion.turn, context);
  } catch (error) {
    await failOwnedWork(sessionId, loopId, wakeToken, activeTurnId, context, error);
    return false;
  } finally {
    if (ownsClient) {
      for (const ownedClient of ownedClients) ownedClient.close();
    }
  }
}

export function spawnWakeWorker({ sessionId, loopId, wakeToken, dataDir }) {
  const child = spawn(process.execPath, [
    fileURLToPath(import.meta.url),
    "--session",
    sessionId,
    "--loop",
    loopId,
    "--token",
    wakeToken,
  ], {
    detached: true,
    env: { ...process.env, PLUGIN_DATA: dataDir },
    stdio: "ignore",
  });
  child.once("error", () => {});
  child.unref();
  return child.pid;
}

async function main() {
  const { values } = parseArgs({
    strict: true,
    options: {
      session: { type: "string" },
      loop: { type: "string" },
      token: { type: "string" },
    },
  });
  if (!values.session || !values.loop || !values.token) throw new Error("Missing wake-worker identity.");
  await runWake(values.session, values.loop, values.token);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch {
    process.exitCode = 0;
  }
}
