import assert from "node:assert/strict";
import test from "node:test";
import {
  cronMatches,
  intervalToCron,
  nextCronTime,
  parseCron,
} from "../plugins/codex-loop/scripts/lib/cron.mjs";
import {
  activateLoop,
  beginRun,
  recordRunCompletion,
  scheduleNextRun,
} from "../plugins/codex-loop/scripts/lib/loop-state.mjs";

test("normalizes short durations to clean minute Cron cadences", () => {
  assert.deepEqual(intervalToCron(30_000), {
    expression: "* * * * *",
    intervalMs: 60_000,
    description: "every 1m",
    adjusted: true,
  });
  assert.equal(intervalToCron(5 * 60_000).expression, "*/5 * * * *");
  assert.equal(intervalToCron(90 * 60_000).intervalMs, 120 * 60_000);
});

test("computes the next five-field Cron time in local time", () => {
  const baseline = new Date(2026, 0, 5, 8, 58, 45, 123).getTime();
  const next = nextCronTime("0 9 * * 1-5", baseline);
  assert.equal(next, new Date(2026, 0, 5, 9, 0, 0, 0).getTime());
});

test("uses standard day-of-month or day-of-week matching", () => {
  const parsed = parseCron("0 9 13 * 1");
  assert.equal(cronMatches(parsed, new Date(2026, 0, 12, 9, 0)), true);
  assert.equal(cronMatches(parsed, new Date(2026, 0, 13, 9, 0)), true);
  assert.equal(cronMatches(parsed, new Date(2026, 0, 14, 9, 0)), false);
});

test("rejects malformed Cron expressions", () => {
  assert.throws(() => parseCron("*/5 * * *"), /exactly five fields/);
  assert.throws(() => parseCron("61 * * * *"), /minute range/);
  assert.throws(() => parseCron("* * * * */0"), /step/);
});

test("queues one missed Cron tick without backfilling all of them", () => {
  const startedAt = new Date(2026, 0, 5, 12, 0, 0, 0).getTime();
  const config = {
    id: "a1b2c3d4e5f6",
    task: "check status",
    until: null,
    intervalMs: 5 * 60_000,
    cronExpression: "*/5 * * * *",
    cadenceLabel: "every 5m",
    ttlMs: null,
    maxRuns: null,
    immediate: true,
  };
  let state = activateLoop(config, {
    session_id: "session-1",
    cwd: "/tmp/project",
  }, startedAt, { backend: "stop-hook" });
  state = beginRun(state, startedAt);
  const completedAt = startedAt + 16 * 60_000;
  state = scheduleNextRun(recordRunCompletion(state, "done", completedAt), "done", completedAt);
  assert.equal(state.nextRunAt, completedAt);
  assert.equal(state.lastDelaySource, "cron-queued");

  state = beginRun(state, completedAt);
  const catchUpCompletedAt = completedAt + 60_000;
  state = scheduleNextRun(
    recordRunCompletion(state, "done", catchUpCompletedAt),
    "done",
    catchUpCompletedAt,
  );
  assert.equal(state.nextRunAt, new Date(2026, 0, 5, 12, 20, 0, 0).getTime());
  assert.equal(state.lastDelaySource, "cron");
});
