#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { ACTIVE_STATUSES } from "./lib/loop-state.mjs";
import { defaultPendingDir, findPendingConfigForSession } from "./lib/pending.mjs";
import { defaultDataDir, readLoopState } from "./lib/state.mjs";

function denyGoal(loopId) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `Codex Loop ${loopId} already owns repetition for this conversation. Do not combine it with a durable goal; finish the current turn so the Loop Stop hook can schedule the next pass.`,
    },
  };
}

export async function handleGoalGuard(input, options = {}) {
  if (
    !input ||
    input.hook_event_name !== "PreToolUse" ||
    input.tool_name !== "create_goal" ||
    typeof input.session_id !== "string"
  ) {
    return {};
  }

  const dataDir = options.dataDir ?? defaultDataDir();
  const pendingDir = options.pendingDir ?? defaultPendingDir();
  const state = await readLoopState(input.session_id, dataDir);
  if (state && ACTIVE_STATUSES.has(state.status)) return denyGoal(state.id);

  const pending = await findPendingConfigForSession(input.session_id, pendingDir);
  return pending ? denyGoal(pending.id) : {};
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  try {
    const input = JSON.parse(await readStdin());
    process.stdout.write(`${JSON.stringify(await handleGoalGuard(input))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ systemMessage: `Codex Loop goal guard failed open: ${error.message}` })}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
