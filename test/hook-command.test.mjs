import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("a stale plugin cache path exits cleanly", async (context) => {
  const missingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-missing-root-"));
  await fs.rm(missingRoot, { recursive: true, force: true });
  context.after(() => fs.rm(missingRoot, { recursive: true, force: true }));

  const hooks = JSON.parse(await fs.readFile(
    new URL("../plugins/codex-loop/hooks/hooks.json", import.meta.url),
    "utf8",
  ));
  const command = hooks.hooks.Stop[0].hooks[0].command;
  const { stdout } = await execFileAsync("/bin/sh", ["-c", command], {
    env: { ...process.env, PLUGIN_ROOT: missingRoot },
  });

  assert.deepEqual(JSON.parse(stdout), {});

  const sessionEndCommand = hooks.hooks.SessionEnd[0].hooks[0].command;
  const sessionEnd = await execFileAsync("/bin/sh", ["-c", sessionEndCommand], {
    env: { ...process.env, PLUGIN_ROOT: missingRoot },
  });
  assert.equal(sessionEnd.stdout, "");

  const preToolCommand = hooks.hooks.PreToolUse[0].hooks[0].command;
  const preTool = await execFileAsync("/bin/sh", ["-c", preToolCommand], {
    env: { ...process.env, PLUGIN_ROOT: missingRoot },
  });
  assert.deepEqual(JSON.parse(preTool.stdout), {});
});
