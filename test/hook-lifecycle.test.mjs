import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createControlMarker, createStartMarker } from "../plugins/codex-loop/scripts/lib/markers.mjs";
import { writePendingConfig } from "../plugins/codex-loop/scripts/lib/pending.mjs";
import { readLoopState } from "../plugins/codex-loop/scripts/lib/state.mjs";
import { handleStop } from "../plugins/codex-loop/scripts/stop-hook.mjs";

function hookInput(message, sessionId = "session-1") {
  return {
    session_id: sessionId,
    turn_id: "turn-1",
    cwd: "/tmp/project",
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: message,
  };
}

function startConfig(overrides = {}) {
  return {
    v: 1,
    id: "a1b2c3d4e5f6",
    task: "run tests",
    until: "tests pass",
    intervalMs: 1_000,
    ttlMs: 10_000,
    maxRuns: 5,
    immediate: false,
    ...overrides,
  };
}

async function fixture(context) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-hook-"));
  const pendingDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-pending-"));
  context.after(() => Promise.all([
    fs.rm(dataDir, { recursive: true, force: true }),
    fs.rm(pendingDir, { recursive: true, force: true }),
  ]));
  let currentTime = 10_000;
  const options = {
    dataDir,
    pendingDir,
    clock: () => currentTime,
    sleep: async (milliseconds) => {
      currentTime += milliseconds;
    },
  };
  return { dataDir, options, pendingDir };
}

async function startMarker(config, pendingDir) {
  await writePendingConfig(config, pendingDir);
  return createStartMarker(config.id);
}

test("creates, repeats, and completes a loop in one session", async (context) => {
  const { dataDir, options, pendingDir } = await fixture(context);
  const config = startConfig();

  const first = await handleStop(hookInput(await startMarker(config, pendingDir)), options);
  assert.equal(first.decision, "block");
  assert.match(first.reason, /Run 1/);
  assert.equal((await readLoopState("session-1", dataDir)).status, "running");

  const second = await handleStop(hookInput("Tests still fail."), options);
  assert.equal(second.decision, "block");
  assert.match(second.reason, /Run 2/);
  assert.equal((await readLoopState("session-1", dataDir)).runs, 1);

  const third = await handleStop(
    hookInput(`Tests pass. ${createControlMarker("complete", config.id)}`),
    options,
  );
  assert.match(third.systemMessage, /condition met/);
  const completed = await readLoopState("session-1", dataDir);
  assert.equal(completed.status, "completed");
  assert.equal(completed.runs, 2);
  assert.equal(completed.endReason, "condition-met");
});

test("ends naturally at max-runs", async (context) => {
  const { dataDir, options, pendingDir } = await fixture(context);
  const config = startConfig({ maxRuns: 1, immediate: true });

  assert.equal((await handleStop(hookInput(await startMarker(config, pendingDir)), options)).decision, "block");
  const output = await handleStop(hookInput("One pass finished."), options);
  assert.match(output.systemMessage, /max-runs/);
  assert.equal((await readLoopState("session-1", dataDir)).status, "completed");
});

test("terminates an active loop idempotently", async (context) => {
  const { dataDir, options, pendingDir } = await fixture(context);
  const config = startConfig({ immediate: true });
  await handleStop(hookInput(await startMarker(config, pendingDir)), options);

  const output = await handleStop(hookInput(createControlMarker("stop")), options);
  assert.match(output.systemMessage, /terminated/);
  assert.equal((await readLoopState("session-1", dataDir)).status, "terminated");
  assert.deepEqual(await handleStop(hookInput(createControlMarker("stop")), options), {});
});

test("does nothing in conversations without an active loop", async (context) => {
  const { options } = await fixture(context);
  assert.deepEqual(await handleStop(hookInput("A normal answer."), options), {});
});
