#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { defaultDataDir, readLoopState, writeLoopState } from "./lib/state.mjs";

const ACTIVE_STATUSES = new Set(["waiting", "launching", "running"]);

export async function handleSessionEnd(input, options = {}) {
  if (!input || input.hook_event_name !== "SessionEnd" || typeof input.session_id !== "string") return false;

  const dataDir = options.dataDir ?? defaultDataDir();
  const state = await readLoopState(input.session_id, dataDir);
  if (!state || !ACTIVE_STATUSES.has(state.status)) return false;

  const now = options.clock?.() ?? Date.now();
  await writeLoopState({
    ...state,
    status: "terminated",
    endReason: "session-ended",
    endedAt: now,
    nextRunAt: null,
    wakeToken: null,
    activeTurnId: null,
  }, dataDir);
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
