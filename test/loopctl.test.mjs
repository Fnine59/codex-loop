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
    "1m",
    "--for",
    "5m",
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
  assert.equal(config.cronExpression, "* * * * *");
});

test("loopctl creates an idempotent stop marker", async () => {
  const { stdout } = await execFileAsync(process.execPath, [LOOPCTL, "stop"]);
  assert.deepEqual(parseControlMarker(stdout), { action: "stop", id: null });
});

test("loopctl uses adaptive scheduling when no interval is supplied", async (context) => {
  const pendingDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-ctl-adaptive-"));
  context.after(() => fs.rm(pendingDir, { recursive: true, force: true }));
  const { stdout } = await execFileAsync(process.execPath, [
    LOOPCTL,
    "start",
    "--max-runs",
    "2",
    "--",
    "check CI",
  ], { env: { ...process.env, CODEX_LOOP_PENDING_DIR: pendingDir } });
  const config = await takePendingConfig(parseStartMarker(stdout), pendingDir);
  assert.equal(config.intervalMs, null);
  assert.equal(config.immediate, true);
  assert.equal(config.ttlMs, 86_400_000);
  assert.match(stdout, /adaptive 1m-1h \(30m fallback\)/);
});

test("loopctl creates an until-stopped loop without an expiry", async (context) => {
  const pendingDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-ctl-forever-"));
  context.after(() => fs.rm(pendingDir, { recursive: true, force: true }));
  const { stdout } = await execFileAsync(process.execPath, [
    LOOPCTL,
    "start",
    "--every",
    "1s",
    "--until-stopped",
    "--",
    "check status",
  ], { env: { ...process.env, CODEX_LOOP_PENDING_DIR: pendingDir } });
  const id = parseStartMarker(stdout);
  const config = await takePendingConfig(id, pendingDir);
  assert.equal(config.ttlMs, null);
  assert.match(stdout, /lifetime until stopped/);
});

test("loopctl rejects conflicting lifetime bounds", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [
      LOOPCTL,
      "start",
      "--every",
      "1s",
      "--for",
      "1d",
      "--until-stopped",
      "--",
      "check status",
    ]),
    /cannot be combined/,
  );
});

test("loopctl accepts a finite lifetime longer than seven days", async (context) => {
  const pendingDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-ctl-long-"));
  context.after(() => fs.rm(pendingDir, { recursive: true, force: true }));
  const { stdout } = await execFileAsync(process.execPath, [
    LOOPCTL,
    "start",
    "--every",
    "30s",
    "--for",
    "30d",
    "--",
    "check status",
  ], { env: { ...process.env, CODEX_LOOP_PENDING_DIR: pendingDir } });
  const config = await takePendingConfig(parseStartMarker(stdout), pendingDir);
  assert.equal(config.intervalMs, 60_000);
  assert.equal(config.cronExpression, "* * * * *");
  assert.equal(config.ttlMs, 30 * 86_400_000);
  assert.match(stdout, /normalized 30s to 1m/);
});

test("loopctl accepts a five-field Cron expression", async (context) => {
  const pendingDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-ctl-cron-"));
  context.after(() => fs.rm(pendingDir, { recursive: true, force: true }));
  const { stdout } = await execFileAsync(process.execPath, [
    LOOPCTL,
    "start",
    "--cron",
    "0 9 * * 1-5",
    "--for",
    "7d",
    "--",
    "check the weekday report",
  ], { env: { ...process.env, CODEX_LOOP_PENDING_DIR: pendingDir } });
  const config = await takePendingConfig(parseStartMarker(stdout), pendingDir);
  assert.equal(config.intervalMs, null);
  assert.equal(config.cronExpression, "0 9 * * 1-5");
  assert.equal(config.cadenceLabel, "cron 0 9 * * 1-5");
  assert.equal(config.immediate, false);
});

test("loopctl rejects competing fixed schedules", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [
      LOOPCTL,
      "start",
      "--every",
      "5m",
      "--cron",
      "*/5 * * * *",
      "--",
      "check status",
    ]),
    /cannot be combined/,
  );
});
