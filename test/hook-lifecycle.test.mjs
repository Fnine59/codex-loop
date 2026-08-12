import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createControlMarker, createNextMarker, createStartMarker } from "../plugins/codex-loop/scripts/lib/markers.mjs";
import { writePendingConfig } from "../plugins/codex-loop/scripts/lib/pending.mjs";
import { readLoopState } from "../plugins/codex-loop/scripts/lib/state.mjs";
import { handleStop } from "../plugins/codex-loop/scripts/stop-hook.mjs";

function hookInput(message, sessionId = "session-1", stopHookActive = false) {
  return {
    session_id: sessionId,
    turn_id: "turn-1",
    cwd: "/tmp/project",
    hook_event_name: "Stop",
    stop_hook_active: stopHookActive,
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

  const second = await handleStop(hookInput("Tests still fail.", "session-1", true), options);
  assert.equal(second.decision, "block");
  assert.match(second.reason, /Run 2/);
  assert.equal((await readLoopState("session-1", dataDir)).runs, 1);

  const third = await handleStop(
    hookInput(`Tests pass. ${createControlMarker("complete", config.id)}`, "session-1", true),
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
  const output = await handleStop(hookInput("One pass finished.", "session-1", true), options);
  assert.match(output.systemMessage, /max-runs/);
  assert.equal((await readLoopState("session-1", dataDir)).status, "completed");
});

test("runs an adaptive loop immediately and uses the model-selected delay", async (context) => {
  const { dataDir, options, pendingDir } = await fixture(context);
  const config = startConfig({ intervalMs: null, ttlMs: 86_400_000, immediate: false });

  const first = await handleStop(hookInput(await startMarker(config, pendingDir)), options);
  assert.equal(first.decision, "block");
  assert.match(first.reason, /choose the next delay from 1m to 6h/);
  assert.match(first.reason, new RegExp(`codex-loop:v1:next:${config.id}:<delay>`));

  const second = await handleStop(
    hookInput(`Still pending. ${createNextMarker(config.id, "2m")}`, "session-1", true),
    options,
  );
  assert.equal(second.decision, "block");
  assert.match(second.reason, /Run 2/);
  const state = await readLoopState("session-1", dataDir);
  assert.equal(state.scheduleMode, "dynamic");
  assert.equal(state.runs, 1);
  assert.equal(state.lastDelayMs, 120_000);
  assert.equal(state.lastDelaySource, "model");
});

test("falls back to 30 minutes when an adaptive delay is missing or invalid", async (context) => {
  const { dataDir, options, pendingDir } = await fixture(context);
  const config = startConfig({ intervalMs: null, ttlMs: 86_400_000, immediate: false });
  await handleStop(hookInput(await startMarker(config, pendingDir)), options);

  const output = await handleStop(
    hookInput(`Still pending. <!-- codex-loop:v1:next:${config.id}:30s -->`, "session-1", true),
    options,
  );
  assert.equal(output.decision, "block");
  const state = await readLoopState("session-1", dataDir);
  assert.equal(state.lastDelayMs, 1_800_000);
  assert.equal(state.lastDelaySource, "fallback");

  const next = await handleStop(hookInput("Still pending without a marker.", "session-1", true), options);
  assert.equal(next.decision, "block");
  const nextState = await readLoopState("session-1", dataDir);
  assert.equal(nextState.runs, 2);
  assert.equal(nextState.lastDelayMs, 1_800_000);
  assert.equal(nextState.lastDelaySource, "fallback");
});

test("keeps an until-stopped loop active without an expiry", async (context) => {
  const { dataDir, options, pendingDir } = await fixture(context);
  const config = startConfig({ intervalMs: null, ttlMs: null, maxRuns: null, until: null, immediate: false });

  assert.equal((await handleStop(hookInput(await startMarker(config, pendingDir)), options)).decision, "block");
  const output = await handleStop(
    hookInput(`One pass finished. ${createNextMarker(config.id, "6h")}`, "session-1", true),
    options,
  );
  assert.equal(output.decision, "block");
  assert.match(output.reason, /ends only when the user asks to stop/);
  assert.doesNotMatch(output.reason, /codex-loop:v1:complete/);
  const state = await readLoopState("session-1", dataDir);
  assert.equal(state.status, "running");
  assert.equal(state.expiresAt, null);
  assert.equal(state.runs, 1);
  assert.equal(state.lastDelayMs, 21_600_000);
  assert.equal(state.lastDelaySource, "model");
});

test("caps the next adaptive wakeup at the finite lifetime", async (context) => {
  const { dataDir, options, pendingDir } = await fixture(context);
  const config = startConfig({ intervalMs: null, ttlMs: 120_000, immediate: false });
  await handleStop(hookInput(await startMarker(config, pendingDir)), options);

  const output = await handleStop(
    hookInput(`Still pending. ${createNextMarker(config.id, "6h")}`, "session-1", true),
    options,
  );
  assert.match(output.systemMessage, /expired/);
  const state = await readLoopState("session-1", dataDir);
  assert.equal(state.status, "completed");
  assert.equal(state.runs, 1);
  assert.equal(state.endReason, "expired");
});

test("ignores an automatic completion marker for an until-stopped loop", async (context) => {
  const { dataDir, options, pendingDir } = await fixture(context);
  const config = startConfig({ ttlMs: null, maxRuns: null, until: null, immediate: true });
  await handleStop(hookInput(await startMarker(config, pendingDir)), options);

  const output = await handleStop(
    hookInput(createControlMarker("complete", config.id), "session-1", true),
    options,
  );
  assert.equal(output.decision, "block");
  assert.equal((await readLoopState("session-1", dataDir)).status, "running");
});

test("does not revive a loop after its continued turn was interrupted", async (context) => {
  const { dataDir, options, pendingDir } = await fixture(context);
  const config = startConfig({ immediate: true });
  await handleStop(hookInput(await startMarker(config, pendingDir)), options);

  const output = await handleStop(hookInput("A later human turn finished."), options);
  assert.match(output.systemMessage, /turn interrupted/);
  const state = await readLoopState("session-1", dataDir);
  assert.equal(state.status, "terminated");
  assert.equal(state.endReason, "interrupted-turn");
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
