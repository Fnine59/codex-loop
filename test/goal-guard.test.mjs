import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleGoalGuard } from "../plugins/codex-loop/scripts/goal-guard.mjs";
import { continuationPrompt } from "../plugins/codex-loop/scripts/lib/loop-state.mjs";
import { writePendingConfig } from "../plugins/codex-loop/scripts/lib/pending.mjs";
import { writeLoopState } from "../plugins/codex-loop/scripts/lib/state.mjs";

function goalInput(sessionId = "session-1") {
  return {
    hook_event_name: "PreToolUse",
    session_id: sessionId,
    tool_name: "create_goal",
    tool_input: { objective: "repeat some work" },
  };
}

async function fixture(context) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-goal-data-"));
  const pendingDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-goal-pending-"));
  context.after(() => Promise.all([
    fs.rm(dataDir, { recursive: true, force: true }),
    fs.rm(pendingDir, { recursive: true, force: true }),
  ]));
  return { dataDir, pendingDir };
}

test("blocks durable goal creation after a Loop is prepared", async (context) => {
  const { dataDir, pendingDir } = await fixture(context);
  await writePendingConfig({
    v: 1,
    id: "a1b2c3d4e5f6",
    sessionIdHint: "session-1",
    task: "run tests",
    until: null,
    intervalMs: null,
    cronExpression: null,
    cadenceLabel: null,
    ttlMs: 86_400_000,
    maxRuns: null,
    immediate: true,
  }, pendingDir);

  const output = await handleGoalGuard(goalInput(), { dataDir, pendingDir });
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /a1b2c3d4e5f6/);
});

test("blocks durable goal creation while a Loop is active", async (context) => {
  const { dataDir, pendingDir } = await fixture(context);
  await writeLoopState({
    version: 1,
    id: "b1c2d3e4f5a6",
    sessionId: "session-1",
    status: "waiting",
  }, dataDir);

  const output = await handleGoalGuard(goalInput(), { dataDir, pendingDir });
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /b1c2d3e4f5a6/);
});

test("allows durable goals in conversations without a Loop", async (context) => {
  const { dataDir, pendingDir } = await fixture(context);
  assert.deepEqual(await handleGoalGuard(goalInput(), { dataDir, pendingDir }), {});
  assert.deepEqual(await handleGoalGuard({ ...goalInput(), tool_name: "get_goal" }, { dataDir, pendingDir }), {});
});

test("continuation prompts make Loop the only continuation owner", () => {
  const prompt = continuationPrompt({
    id: "c1d2e3f4a5b6",
    runs: 0,
    task: "check CI",
    until: null,
    expiresAt: Date.now() + 60_000,
    scheduleMode: "dynamic",
  });
  assert.match(prompt, /sole scheduler/);
  assert.match(prompt, /Do not call create_goal/);
  assert.match(prompt, /End this turn after exactly one pass/);
});

test("the Loop skill forbids durable goal ownership", async () => {
  const skill = await fs.readFile(
    new URL("../plugins/codex-loop/skills/loop/SKILL.md", import.meta.url),
    "utf8",
  );
  assert.match(skill, /sole scheduler and lifetime owner/);
  assert.match(skill, /Never call `create_goal`/);
  assert.match(skill, /Before performing project setup, validation, or task work/);
});
