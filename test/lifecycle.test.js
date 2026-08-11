import assert from "node:assert/strict";
import test from "node:test";
import {
  completeJob,
  failJob,
  naturalCompletionReason,
  requestTermination,
  terminateJob,
} from "../src/lifecycle.js";

const job = {
  status: "waiting",
  runs: 1,
  maxRuns: 2,
  expiresAt: 10_000,
  nextRunAt: 5_000,
};

test("distinguishes requested termination from natural completion", () => {
  const stopping = requestTermination(job, 2_000);
  assert.equal(stopping.status, "stopping");
  assert.equal(stopping.terminationRequestedAt, 2_000);
  assert.equal(terminateJob(stopping, 3_000).status, "terminated");

  const completed = completeJob({ ...job, runs: 2 }, "max-runs", 4_000);
  assert.equal(completed.status, "completed");
  assert.equal(completed.endReason, "max-runs");
});

test("detects natural completion and failures", () => {
  assert.equal(naturalCompletionReason({ ...job, runs: 2 }, 5_000), "max-runs");
  assert.equal(naturalCompletionReason(job, 10_000), "expired");
  assert.equal(failJob(job, new Error("boom"), 6_000).status, "failed");
});
