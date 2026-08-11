import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { sendStop } from "../src/control.js";
import { requestTermination } from "../src/lifecycle.js";
import { createJob, getJob, updateJob } from "../src/store.js";
import { nextScheduledTime, runWorker } from "../src/worker.js";

const FAKE_CODEX = fileURLToPath(new URL("./fixtures/fake-codex.js", import.meta.url));

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function job(id, prompt, now = Date.now()) {
  return {
    id,
    status: "created",
    prompt,
    cwd: process.cwd(),
    sandbox: "read-only",
    codexBin: FAKE_CODEX,
    intervalMs: 60_000,
    createdAt: now,
    expiresAt: now + 60_000,
    nextRunAt: now,
    maxRuns: 1,
    runs: 0,
    pid: null,
    sessionId: null,
  };
}

async function waitForStatus(id, status, home) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const current = await getJob(id, home);
    if (current.status === status) return current;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${status}`);
}

test("coalesces missed intervals without catch-up runs", () => {
  assert.equal(nextScheduledTime(1_000, 1_000, 1_500), 2_000);
  assert.equal(nextScheduledTime(1_000, 1_000, 4_500), 5_000);
});

test("naturally completes after the configured run count", async (context) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-worker-"));
  context.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.chmod(FAKE_CODEX, 0o755);
  await createJob(job("complete", "finish"), home);

  await runWorker("complete", home);

  const completed = await getJob("complete", home);
  assert.equal(completed.status, "completed");
  assert.equal(completed.endReason, "max-runs");
  assert.equal(completed.runs, 1);
});

test("terminates an active Codex child process", async (context) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-worker-"));
  context.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.chmod(FAKE_CODEX, 0o755);
  await createJob(job("terminate", "hold"), home);

  const worker = runWorker("terminate", home);
  await waitForStatus("terminate", "running", home);
  await updateJob("terminate", (current) => requestTermination(current), home);
  await sendStop("terminate", home);
  await worker;

  const terminated = await getJob("terminate", home);
  assert.equal(terminated.status, "terminated");
  assert.equal(terminated.pid, null);
  assert.equal(terminated.runs, 0);
});
