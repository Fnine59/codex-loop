import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleSessionEnd } from "../plugins/codex-loop/scripts/session-end.mjs";
import { readLoopState, writeLoopState } from "../plugins/codex-loop/scripts/lib/state.mjs";

test("session end terminates an active loop", async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-session-end-"));
  context.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await writeLoopState({
    sessionId: "session-end-1",
    id: "a1b2c3d4e5f6",
    status: "running",
    backend: "app-server",
    threadId: "thread-1",
    activeTurnId: "turn-1",
    runs: 3,
    nextRunAt: 20_000,
  }, dataDir);

  const stopped = [];

  assert.equal(await handleSessionEnd({
    hook_event_name: "SessionEnd",
    session_id: "session-end-1",
  }, {
    dataDir,
    clock: () => 30_000,
    cleanAppServerThread: async (threadId, turnId) => stopped.push({ threadId, turnId }),
  }), true);

  const state = await readLoopState("session-end-1", dataDir);
  assert.equal(state.status, "terminated");
  assert.equal(state.endReason, "session-ended");
  assert.equal(state.endedAt, 30_000);
  assert.equal(state.nextRunAt, null);
  assert.equal(state.activeTurnId, null);
  assert.deepEqual(stopped, [{ threadId: "thread-1", turnId: "turn-1" }]);
});

test("session end remains terminal when App Server interruption fails", async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-session-end-"));
  context.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await writeLoopState({
    sessionId: "session-end-2",
    id: "b1c2d3e4f5a6",
    status: "running",
    backend: "app-server",
    threadId: "thread-2",
    activeTurnId: "turn-2",
    runs: 0,
    nextRunAt: null,
  }, dataDir);

  assert.equal(await handleSessionEnd({
    hook_event_name: "SessionEnd",
    session_id: "session-end-2",
  }, {
    dataDir,
    clock: () => 40_000,
    cleanAppServerThread: async () => {
      throw new Error("App Server unavailable");
    },
  }), true);

  const state = await readLoopState("session-end-2", dataDir);
  assert.equal(state.status, "terminated");
  assert.equal(state.endReason, "session-ended");
  assert.equal(state.activeTurnId, null);
});

test("session end cleans an App Server thread while the loop is waiting", async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-session-end-"));
  context.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await writeLoopState({
    sessionId: "session-end-3",
    id: "c1d2e3f4a5b6",
    status: "waiting",
    backend: "app-server",
    threadId: "thread-3",
    activeTurnId: null,
    runs: 1,
    nextRunAt: 50_000,
  }, dataDir);

  const cleaned = [];
  assert.equal(await handleSessionEnd({
    hook_event_name: "SessionEnd",
    session_id: "session-end-3",
  }, {
    dataDir,
    clock: () => 45_000,
    cleanAppServerThread: async (threadId, turnId) => cleaned.push({ threadId, turnId }),
  }), true);

  assert.deepEqual(cleaned, [{ threadId: "thread-3", turnId: null }]);
  const state = await readLoopState("session-end-3", dataDir);
  assert.equal(state.status, "terminated");
  assert.equal(state.endReason, "session-ended");
});
