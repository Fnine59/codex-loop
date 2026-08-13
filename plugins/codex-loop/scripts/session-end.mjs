#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { AppServerClient } from "./lib/app-server-client.mjs";
import { defaultDataDir, readLoopState, writeLoopState } from "./lib/state.mjs";

const ACTIVE_STATUSES = new Set(["waiting", "launching", "running"]);

async function cleanAppServerThread(threadId, turnId) {
  const client = new AppServerClient({ requestTimeoutMs: 1_000 });
  try {
    await client.connect();
    if (turnId) {
      try {
        await client.interruptTurn(threadId, turnId);
      } catch {
        // Cleaning the thread can still terminate a command after turn interruption fails.
      }
    }
    try {
      await client.cleanBackgroundTerminals(threadId);
    } catch {
      // Older App Server versions may not expose background-terminal cleanup.
    }
  } finally {
    client.close();
  }
}

export async function handleSessionEnd(input, options = {}) {
  if (!input || input.hook_event_name !== "SessionEnd" || typeof input.session_id !== "string") return false;

  const dataDir = options.dataDir ?? defaultDataDir();
  const state = await readLoopState(input.session_id, dataDir);
  if (!state || !ACTIVE_STATUSES.has(state.status)) return false;

  const now = options.clock?.() ?? Date.now();
  const appServerThread = state.backend === "app-server" && state.threadId
    ? { threadId: state.threadId, turnId: state.activeTurnId ?? null }
    : null;
  await writeLoopState({
    ...state,
    status: "terminated",
    endReason: "session-ended",
    endedAt: now,
    nextRunAt: null,
    wakeToken: null,
    activeTurnId: null,
  }, dataDir);

  if (appServerThread) {
    try {
      await (options.cleanAppServerThread ?? cleanAppServerThread)(
        appServerThread.threadId,
        appServerThread.turnId,
      );
    } catch {
      // State is already terminal. App Server cleanup remains best-effort during shutdown.
    }
  }
  return true;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  try {
    await handleSessionEnd(JSON.parse(await readStdin()));
  } catch {
    // Session cleanup is best-effort and must never make Codex shutdown fail.
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
