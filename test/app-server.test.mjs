import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AppServerClient,
  detectAppServerRuntime,
  encodeWebSocketFrame,
  findCurrentAppServerThread,
} from "../plugins/codex-loop/scripts/lib/app-server-client.mjs";
import { createControlMarker, createNextMarker, createStartMarker } from "../plugins/codex-loop/scripts/lib/markers.mjs";
import { writePendingConfig } from "../plugins/codex-loop/scripts/lib/pending.mjs";
import { readLoopState } from "../plugins/codex-loop/scripts/lib/state.mjs";
import { handleStop } from "../plugins/codex-loop/scripts/stop-hook.mjs";
import { runWake } from "../plugins/codex-loop/scripts/wake-worker.mjs";

function hookInput(message, turnId = "turn-start") {
  return {
    session_id: "session-1",
    turn_id: turnId,
    cwd: "/tmp/project",
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: message,
  };
}

function decodeClientFrame(frame) {
  const lengthCode = frame[1] & 0x7f;
  let length = lengthCode;
  let offset = 2;
  if (lengthCode === 126) {
    length = frame.readUInt16BE(2);
    offset = 4;
  } else if (lengthCode === 127) {
    length = Number(frame.readBigUInt64BE(2));
    offset = 10;
  }
  const mask = frame.subarray(offset, offset + 4);
  offset += 4;
  const payload = Buffer.from(frame.subarray(offset, offset + length));
  for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
  return payload;
}

test("encodes masked WebSocket frames for Unix App Server transport", () => {
  for (const size of [5, 200, 70_000]) {
    const payload = "x".repeat(size);
    const frame = encodeWebSocketFrame(payload);
    assert.equal(frame[0], 0x81);
    assert.notEqual(frame[1] & 0x80, 0);
    assert.equal(decodeClientFrame(frame).toString("utf8"), payload);
  }
});

test("speaks App Server requests over an injected transport", async () => {
  const transport = {
    async connect() {},
    send(source) {
      const message = JSON.parse(source);
      if (message.id === undefined) return;
      let result;
      if (message.method === "initialize") result = { serverInfo: { name: "fake", version: "1" } };
      else if (message.method === "thread/loaded/list") result = { data: ["thread-1"], nextCursor: null };
      else if (message.method === "thread/read") result = {
        thread: {
          id: "thread-1",
          sessionId: "session-1",
          status: { type: "idle" },
          canAcceptDirectInput: true,
          turns: [{ id: "turn-1", status: "completed", items: [] }],
        },
      };
      else if (message.method === "turn/start") result = {
        turn: { id: "loop-turn-1", status: "inProgress", items: [] },
      };
      queueMicrotask(() => this.onMessage(JSON.stringify({ id: message.id, result })));
    },
    close() {},
  };
  const client = new AppServerClient({ transport, requestTimeoutMs: 1_000 });
  await client.connect();
  assert.deepEqual(await client.listLoadedThreadIds(), ["thread-1"]);
  assert.equal((await client.readThread("thread-1", true)).status.type, "idle");
  assert.equal((await client.startTurn("thread-1", "continue")).id, "loop-turn-1");
  client.close();
});

test("matches the current App Server thread by turn instead of another loaded session", async () => {
  const client = {
    async listLoadedThreadIds() {
      return ["desktop-thread", "loop-thread"];
    },
    async readThread(id) {
      if (id === "desktop-thread") {
        return { id, sessionId: "another-session", turns: [{ id: "desktop-turn" }] };
      }
      return { id, sessionId: "session-tree", turns: [{ id: "current-turn" }] };
    },
  };
  const thread = await findCurrentAppServerThread({
    session_id: "session-tree",
    turn_id: "current-turn",
  }, { client });
  assert.equal(thread.id, "loop-thread");

  const unrelated = await detectAppServerRuntime({
    session_id: "missing-session",
    turn_id: "missing-turn",
  }, { client });
  assert.deepEqual(unrelated, { backend: "stop-hook" });
});

test("runs an App Server loop without blocking the Stop hook", async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-app-data-"));
  const pendingDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-app-pending-"));
  context.after(() => Promise.all([
    fs.rm(dataDir, { recursive: true, force: true }),
    fs.rm(pendingDir, { recursive: true, force: true }),
  ]));
  let currentTime = new Date(2026, 0, 5, 12, 0, 0, 0).getTime();
  const scheduled = [];
  const options = {
    clock: () => currentTime,
    dataDir,
    pendingDir,
    detectRuntime: async () => ({ backend: "app-server", threadId: "thread-1" }),
    readTurnStatus: async () => "completed",
    scheduleWake: async (wake) => scheduled.push(wake),
  };
  const config = {
    v: 1,
    id: "a1b2c3d4e5f6",
    task: "check CI",
    until: "CI passes",
    intervalMs: null,
    cronExpression: null,
    cadenceLabel: null,
    ttlMs: 3_600_000,
    maxRuns: 3,
    immediate: true,
  };
  await writePendingConfig(config, pendingDir);

  const startOutput = await handleStop(hookInput(createStartMarker(config.id)), options);
  assert.match(startOutput.systemMessage, /App Server/);
  assert.equal(startOutput.decision, undefined);
  assert.equal(scheduled.length, 1);
  let state = await readLoopState("session-1", dataDir);
  assert.equal(state.backend, "app-server");
  assert.equal(state.status, "waiting");

  assert.deepEqual(await handleStop(hookInput("A human message finished.", "human-turn"), options), {});
  assert.equal(scheduled.length, 1);

  let startedPrompt = null;
  const client = {
    async readThread() {
      return { status: { type: "idle" }, canAcceptDirectInput: true };
    },
    async startTurn(_threadId, prompt) {
      startedPrompt = prompt;
      return { id: "loop-turn-1" };
    },
    async interruptTurn() {},
  };
  assert.equal(await runWake(
    "session-1",
    config.id,
    state.wakeToken,
    { client, clock: () => currentTime, dataDir, sleep: async () => {} },
  ), true);
  assert.match(startedPrompt, /Run 1/);
  state = await readLoopState("session-1", dataDir);
  assert.equal(state.status, "running");
  assert.equal(state.activeTurnId, "loop-turn-1");

  currentTime += 2 * 60_000;
  const completion = await handleStop(
    hookInput(`Still pending. ${createNextMarker(config.id, "1m")}`, "loop-turn-1"),
    options,
  );
  assert.deepEqual(completion, {});
  assert.equal(scheduled.length, 2);
  state = await readLoopState("session-1", dataDir);
  assert.equal(state.status, "waiting");
  assert.equal(state.runs, 1);
  assert.equal(state.nextRunAt, currentTime + 60_000);

  const stopped = await handleStop(hookInput(createControlMarker("stop"), "stop-turn"), options);
  assert.match(stopped.systemMessage, /terminated/);
  assert.equal((await readLoopState("session-1", dataDir)).status, "terminated");
});
