#!/usr/bin/env node

import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { AppServerClient } from "./lib/app-server-client.mjs";
import {
  completionReason,
  continuationPrompt,
  endLoop,
  failLoop,
  beginRun,
} from "./lib/loop-state.mjs";
import { defaultDataDir, readLoopState, writeLoopState } from "./lib/state.mjs";

const MAX_SLEEP_CHUNK_MS = 60_000;
const IDLE_POLL_MS = 1_000;

export function threadAcceptsTurnStart(thread) {
  if (thread?.canAcceptDirectInput === true) return true;
  return thread?.canAcceptDirectInput == null && thread?.status?.type === "idle";
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

export async function runWake(sessionId, loopId, wakeToken, options = {}) {
  const context = {
    clock: options.clock ?? (() => Date.now()),
    dataDir: options.dataDir ?? defaultDataDir(),
    sleep: options.sleep ?? delay,
  };
  let client = options.client ?? null;
  const ownsClient = !client;

  try {
    let state = await waitUntilDue(sessionId, loopId, wakeToken, context);
    if (!state) return false;
    const reason = completionReason(state, context.clock());
    if (reason) {
      await writeLoopState(endLoop(state, "completed", reason, context.clock()), context.dataDir);
      return false;
    }

    if (!client) {
      client = new AppServerClient();
      await client.connect();
    }
    while (true) {
      state = await readMatchingState(sessionId, loopId, wakeToken, context.dataDir, ["waiting"]);
      if (!state) return false;
      const now = context.clock();
      const ended = completionReason(state, now);
      if (ended) {
        await writeLoopState(endLoop(state, "completed", ended, now), context.dataDir);
        return false;
      }
      const thread = await client.readThread(state.threadId, false);
      if (!thread) throw new Error(`App Server thread is unavailable: ${state.threadId}.`);
      if (["notLoaded", "systemError"].includes(thread.status?.type)) {
        throw new Error(`App Server thread is ${thread.status.type}: ${state.threadId}.`);
      }
      if (threadAcceptsTurnStart(thread)) break;
      await context.sleep(IDLE_POLL_MS);
    }

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
    return true;
  } catch (error) {
    await failCurrentWake(sessionId, loopId, wakeToken, context, error);
    return false;
  } finally {
    if (ownsClient) client?.close();
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
