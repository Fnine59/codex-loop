import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJob, getJob, listJobs, updateJob } from "../src/store.js";

test("creates and updates jobs atomically", async (context) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-test-"));
  context.after(() => fs.rm(home, { recursive: true, force: true }));

  await createJob({ id: "abc12345", status: "created", runs: 0 }, home);
  await updateJob("abc12345", (job) => ({ ...job, runs: 1 }), home);

  assert.equal((await getJob("abc12345", home)).runs, 1);
  assert.equal((await listJobs(home)).length, 1);
});
