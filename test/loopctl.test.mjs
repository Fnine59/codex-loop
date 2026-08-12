import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseControlMarker, parseStartMarker } from "../plugins/codex-loop/scripts/lib/markers.mjs";
import { takePendingConfig } from "../plugins/codex-loop/scripts/lib/pending.mjs";

const execFileAsync = promisify(execFile);
const LOOPCTL = fileURLToPath(new URL("../plugins/codex-loop/scripts/loopctl.mjs", import.meta.url));

test("loopctl creates a short marker backed by pending configuration", async (context) => {
  const pendingDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-ctl-"));
  context.after(() => fs.rm(pendingDir, { recursive: true, force: true }));
  const { stdout } = await execFileAsync(process.execPath, [
    LOOPCTL,
    "start",
    "--every",
    "1s",
    "--for",
    "5s",
    "--max-runs",
    "2",
    "--until",
    "tests pass",
    "--now",
    "--",
    "run tests",
  ], { env: { ...process.env, CODEX_LOOP_PENDING_DIR: pendingDir } });
  const id = parseStartMarker(stdout);
  assert.match(id, /^[a-f0-9]{12}$/);
  const config = await takePendingConfig(id, pendingDir);
  assert.equal(config.task, "run tests");
  assert.equal(config.maxRuns, 2);
  assert.equal(config.immediate, true);
});

test("loopctl creates an idempotent stop marker", async () => {
  const { stdout } = await execFileAsync(process.execPath, [LOOPCTL, "stop"]);
  assert.deepEqual(parseControlMarker(stdout), { action: "stop", id: null });
});
