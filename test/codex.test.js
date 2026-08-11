import assert from "node:assert/strict";
import test from "node:test";
import { buildCodexArgs } from "../src/codex.js";

const job = {
  cwd: "/tmp/project",
  sandbox: "read-only",
  prompt: "check CI",
  sessionId: null,
};

test("builds a new Codex session command", () => {
  assert.deepEqual(buildCodexArgs(job), [
    "exec",
    "--json",
    "--sandbox",
    "read-only",
    "-C",
    "/tmp/project",
    "check CI",
  ]);
});

test("resumes the captured session", () => {
  assert.deepEqual(buildCodexArgs({ ...job, sessionId: "session-123" }).slice(-3), [
    "resume",
    "session-123",
    "check CI",
  ]);
});
