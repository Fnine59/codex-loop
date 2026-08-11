import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createControlServer, sendStop } from "../src/control.js";

test("worker acknowledges a cooperative stop request", async (context) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-control-"));
  context.after(() => fs.rm(home, { recursive: true, force: true }));
  let stopped = false;
  const close = await createControlServer("abc12345", home, () => {
    stopped = true;
  });

  await sendStop("abc12345", home);
  assert.equal(stopped, true);
  await close();
});
