import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createStartMarker } from "../plugins/codex-loop/scripts/lib/markers.mjs";
import { writePendingConfig } from "../plugins/codex-loop/scripts/lib/pending.mjs";
import { readLoopState } from "../plugins/codex-loop/scripts/lib/state.mjs";

const HOOK = fileURLToPath(new URL("../plugins/codex-loop/scripts/stop-hook.mjs", import.meta.url));
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForWaiting(dataDir) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const state = await readLoopState("signal-session", dataDir);
    if (state?.status === "waiting") return state;
    await delay(20);
  }
  throw new Error("Hook did not enter waiting state.");
}

test("SIGINT terminates a hook that is waiting", async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-signal-"));
  const pendingDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-signal-pending-"));
  context.after(() => Promise.all([
    fs.rm(dataDir, { recursive: true, force: true }),
    fs.rm(pendingDir, { recursive: true, force: true }),
  ]));
  const config = {
    v: 1,
    id: "123456abcdef",
    task: "wait for work",
    until: null,
    intervalMs: 5_000,
    ttlMs: 10_000,
    maxRuns: 2,
    immediate: false,
  };
  await writePendingConfig(config, pendingDir);
  const marker = createStartMarker(config.id);
  const input = {
    session_id: "signal-session",
    turn_id: "turn-1",
    cwd: process.cwd(),
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: marker,
  };

  const child = spawn(process.execPath, [HOOK], {
    env: { ...process.env, PLUGIN_DATA: dataDir, CODEX_LOOP_PENDING_DIR: pendingDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stdin.end(JSON.stringify(input));

  await waitForWaiting(dataDir);
  child.kill("SIGINT");
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(stdout), {});
  const state = await readLoopState("signal-session", dataDir);
  assert.equal(state.status, "terminated");
  assert.equal(state.endReason, "interrupted");
});
