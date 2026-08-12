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
    runs: 3,
    nextRunAt: 20_000,
  }, dataDir);

  assert.equal(await handleSessionEnd({
    hook_event_name: "SessionEnd",
    session_id: "session-end-1",
  }, { dataDir, clock: () => 30_000 }), true);

  const state = await readLoopState("session-end-1", dataDir);
  assert.equal(state.status, "terminated");
  assert.equal(state.endReason, "session-ended");
  assert.equal(state.endedAt, 30_000);
  assert.equal(state.nextRunAt, null);
});
