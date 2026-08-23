import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function readHooks() {
  return JSON.parse(await fs.readFile(
    new URL("../plugins/codex-loop/hooks/hooks.json", import.meta.url),
    "utf8",
  ));
}

test("hook commands recover from a replacement plugin cache directory", async (context) => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-cache-"));
  const missingRoot = path.join(cacheRoot, "old-version");
  const replacementScripts = path.join(cacheRoot, "new-version", "scripts");
  await fs.mkdir(replacementScripts, { recursive: true });
  context.after(() => fs.rm(cacheRoot, { recursive: true, force: true }));

  await Promise.all([
    fs.writeFile(path.join(replacementScripts, "stop-hook.mjs"), "console.log(JSON.stringify({ recovered: 'stop' }));\n"),
    fs.writeFile(path.join(replacementScripts, "session-end.mjs"), "console.log('recovered-session-end');\n"),
    fs.writeFile(path.join(replacementScripts, "goal-guard.mjs"), "console.log(JSON.stringify({ recovered: 'goal-guard' }));\n"),
  ]);

  const hooks = await readHooks();
  const env = { ...process.env, PLUGIN_ROOT: missingRoot };
  const stop = await execFileAsync("/bin/sh", ["-c", hooks.hooks.Stop[0].hooks[0].command], { env });
  const sessionEnd = await execFileAsync("/bin/sh", ["-c", hooks.hooks.SessionEnd[0].hooks[0].command], { env });
  const preTool = await execFileAsync("/bin/sh", ["-c", hooks.hooks.PreToolUse[0].hooks[0].command], { env });

  assert.deepEqual(JSON.parse(stop.stdout), { recovered: "stop" });
  assert.equal(sessionEnd.stdout.trim(), "recovered-session-end");
  assert.deepEqual(JSON.parse(preTool.stdout), { recovered: "goal-guard" });
});

test("a missing plugin runtime reports that the session must restart", async (context) => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-missing-root-"));
  const missingRoot = path.join(cacheRoot, "missing-version");
  context.after(() => fs.rm(cacheRoot, { recursive: true, force: true }));

  const hooks = await readHooks();
  const env = { ...process.env, PLUGIN_ROOT: missingRoot };
  const stop = await execFileAsync("/bin/sh", ["-c", hooks.hooks.Stop[0].hooks[0].command], { env });
  const sessionEnd = await execFileAsync("/bin/sh", ["-c", hooks.hooks.SessionEnd[0].hooks[0].command], { env });
  const preTool = await execFileAsync("/bin/sh", ["-c", hooks.hooks.PreToolUse[0].hooks[0].command], { env });

  assert.match(JSON.parse(stop.stdout).systemMessage, /restart this Codex session/);
  assert.equal(sessionEnd.stdout, "");
  assert.match(JSON.parse(preTool.stdout).systemMessage, /restart this Codex session/);
});
