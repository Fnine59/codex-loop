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
import {
  activateLoop,
  endLoop,
  usageLimitRetryAt,
} from "../plugins/codex-loop/scripts/lib/loop-state.mjs";
import { readLoopState, writeLoopState } from "../plugins/codex-loop/scripts/lib/state.mjs";
import { handleStop } from "../plugins/codex-loop/scripts/stop-hook.mjs";
import { runWake, threadAcceptsTurnStart } from "../plugins/codex-loop/scripts/wake-worker.mjs";

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

test("uses the App Server socket exported by the loopcodex shell function", () => {
  const previous = process.env.CODEX_LOOP_APP_SERVER_SOCKET;
  process.env.CODEX_LOOP_APP_SERVER_SOCKET = "/tmp/codex-loop-custom.sock";
  try {
    const client = new AppServerClient();
    assert.equal(client.transport.socketPath, "/tmp/codex-loop-custom.sock");
    client.close();
  } finally {
    if (previous === undefined) delete process.env.CODEX_LOOP_APP_SERVER_SOCKET;
    else process.env.CODEX_LOOP_APP_SERVER_SOCKET = previous;
  }
});

test("uses direct-input capability instead of requiring an idle thread", () => {
  assert.equal(threadAcceptsTurnStart({
    status: { type: "active", activeFlags: [] },
    canAcceptDirectInput: true,
  }), true);
  assert.equal(threadAcceptsTurnStart({
    status: { type: "active", activeFlags: [] },
    canAcceptDirectInput: false,
  }), false);
  assert.equal(threadAcceptsTurnStart({ status: { type: "idle" } }), true);
  assert.equal(threadAcceptsTurnStart({ status: { type: "active", activeFlags: [] } }), false);
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
      else if (message.method === "thread/backgroundTerminals/clean") result = {};
      queueMicrotask(() => {
        this.onMessage(JSON.stringify({ id: message.id, result }));
        if (message.method === "turn/start") {
          this.onMessage(JSON.stringify({
            method: "turn/completed",
            params: { threadId: "thread-1", turn: { id: "loop-turn-1", status: "completed" } },
          }));
        }
      });
    },
    close() {},
  };
  const client = new AppServerClient({ transport, requestTimeoutMs: 1_000 });
  await client.connect();
  assert.deepEqual(await client.listLoadedThreadIds(), ["thread-1"]);
  assert.equal((await client.readThread("thread-1", true)).status.type, "idle");
  assert.equal((await client.startTurn("thread-1", "continue")).id, "loop-turn-1");
  assert.equal((await client.waitForTurnCompletion("thread-1", "loop-turn-1")).status, "completed");
  assert.deepEqual(await client.cleanBackgroundTerminals("thread-1"), {});
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
      return { status: { type: "active", activeFlags: [] }, canAcceptDirectInput: true };
    },
    async startTurn(_threadId, prompt) {
      startedPrompt = prompt;
      return { id: "loop-turn-1" };
    },
    async waitForTurnCompletion() {
      return { id: "loop-turn-1", status: "completed" };
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

async function writeWakeState(dataDir, sessionId, loopId, now) {
  const state = activateLoop({
    id: loopId,
    task: "reply hi",
    until: null,
    intervalMs: null,
    cronExpression: null,
    cadenceLabel: null,
    ttlMs: null,
    maxRuns: null,
    immediate: true,
  }, {
    session_id: sessionId,
    cwd: "/tmp/project",
  }, now, {
    backend: "app-server",
    threadId: `thread-${loopId}`,
  });
  const armed = { ...state, wakeToken: `wake-${loopId}` };
  await writeLoopState(armed, dataDir);
  return armed;
}

function terminalClient(loopId, completedTurn) {
  return {
    async readThread() {
      return { status: { type: "idle" }, canAcceptDirectInput: true };
    },
    async startTurn() {
      return { id: `turn-${loopId}` };
    },
    async waitForTurnCompletion() {
      return completedTurn;
    },
    async interruptTurn() {},
  };
}

test("caps fallback usage-limit retries at six hours", () => {
  const now = Date.parse("2026-08-17T08:00:00+08:00");
  assert.equal(usageLimitRetryAt(null, now, 7), now + 320 * 60_000);
  assert.equal(usageLimitRetryAt(null, now, 8), now + 360 * 60_000);
  assert.equal(usageLimitRetryAt(null, now, 9), now + 360 * 60_000);
});

test("retries an App Server loop after the reported usage-limit reset", async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-limit-data-"));
  context.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const now = Date.parse("2026-08-17T08:00:00+08:00");
  const loopId = "limit-loop";
  const sessionId = "limit-session";
  const initial = await writeWakeState(dataDir, sessionId, loopId, now);
  const scheduled = [];
  const error = {
    message: "You've hit your usage limit. Please try again at Aug 20th, 2026 11:42 AM.",
    codexErrorInfo: "usageLimitExceeded",
  };
  const client = terminalClient(loopId, null);
  client.waitForTurnCompletion = () => new Promise(() => {});
  client.readThread = async (_threadId, includeTurns) => includeTurns
    ? { turns: [{ id: `turn-${loopId}`, status: "failed", error }] }
    : { status: { type: "idle" }, canAcceptDirectInput: true };

  assert.equal(await runWake(sessionId, loopId, initial.wakeToken, {
    client,
    clock: () => now,
    dataDir,
    scheduleWake: async (wake) => scheduled.push(wake),
    sleep: async () => {},
  }), true);

  const state = await readLoopState(sessionId, dataDir);
  assert.equal(state.status, "waiting");
  assert.equal(state.runs, 0);
  assert.equal(state.activeTurnId, null);
  assert.equal(state.lastErrorCode, "usageLimitExceeded");
  assert.equal(state.lastDelaySource, "usage-limit-reset");
  assert.equal(state.nextRunAt, Date.parse("Aug 20, 2026 11:42 AM") + 60_000);
  assert.equal(state.usageLimitRetries, 1);
  assert.notEqual(state.wakeToken, initial.wakeToken);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].wakeToken, state.wakeToken);
});

test("retries an App Server loop after a structured HTTP 429 error", async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-429-data-"));
  context.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const now = Date.parse("2026-08-17T08:00:00+08:00");
  const loopId = "throttled-loop";
  const sessionId = "throttled-session";
  const initial = await writeWakeState(dataDir, sessionId, loopId, now);
  const scheduled = [];
  const error = {
    message: "exceeded retry limit, last status: 429 Too Many Requests, request id: request-1",
    codex_error_info: {
      response_too_many_failed_attempts: { http_status_code: 429 },
    },
  };

  assert.equal(await runWake(sessionId, loopId, initial.wakeToken, {
    client: terminalClient(loopId, { id: `turn-${loopId}`, status: "failed", error }),
    clock: () => now,
    dataDir,
    scheduleWake: async (wake) => scheduled.push(wake),
    sleep: async () => {},
  }), true);

  const state = await readLoopState(sessionId, dataDir);
  assert.equal(state.status, "waiting");
  assert.equal(state.runs, 0);
  assert.equal(state.activeTurnId, null);
  assert.equal(state.lastErrorCode, "usageLimitExceeded");
  assert.equal(state.lastDelaySource, "usage-limit-backoff");
  assert.equal(state.nextRunAt, now + 5 * 60_000);
  assert.equal(state.usageLimitRetries, 1);
  assert.notEqual(state.wakeToken, initial.wakeToken);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].wakeToken, state.wakeToken);
});

test("exits the monitor when the Stop hook has already completed the turn", async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-stop-owner-data-"));
  context.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const now = Date.parse("2026-08-17T08:00:00+08:00");
  const loopId = "stop-owner-loop";
  const sessionId = "stop-owner-session";
  const initial = await writeWakeState(dataDir, sessionId, loopId, now);
  const client = terminalClient(loopId, null);
  client.waitForTurnCompletion = () => new Promise(() => {});
  client.readThread = async (_threadId, includeTurns) => includeTurns
    ? { turns: [{ id: `turn-${loopId}`, status: "inProgress" }] }
    : { status: { type: "idle" }, canAcceptDirectInput: true };
  let ownershipTransferred = false;

  assert.equal(await runWake(sessionId, loopId, initial.wakeToken, {
    client,
    clock: () => now,
    dataDir,
    sleep: async () => {
      if (ownershipTransferred) return;
      ownershipTransferred = true;
      const running = await readLoopState(sessionId, dataDir);
      await writeLoopState(endLoop(running, "completed", "max-runs", now), dataDir);
    },
  }), false);

  const state = await readLoopState(sessionId, dataDir);
  assert.equal(state.status, "completed");
  assert.equal(state.endReason, "max-runs");
});

test("fails an App Server loop on a non-retryable turn error", async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-failure-data-"));
  context.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const now = Date.parse("2026-08-17T08:00:00+08:00");
  const loopId = "failed-loop";
  const sessionId = "failed-session";
  const initial = await writeWakeState(dataDir, sessionId, loopId, now);

  assert.equal(await runWake(sessionId, loopId, initial.wakeToken, {
    client: terminalClient(loopId, {
      id: `turn-${loopId}`,
      status: "failed",
      error: { message: "Model provider returned an invalid response.", codexErrorInfo: "other" },
    }),
    clock: () => now,
    dataDir,
    scheduleWake: async () => assert.fail("non-retryable errors must not schedule a wake"),
    sleep: async () => {},
  }), false);

  const state = await readLoopState(sessionId, dataDir);
  assert.equal(state.status, "failed");
  assert.equal(state.endReason, "turn-failed");
  assert.match(state.lastError, /invalid response/);
});

test("terminates an App Server loop when its monitored turn is interrupted", async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-interrupt-data-"));
  context.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const now = Date.parse("2026-08-17T08:00:00+08:00");
  const loopId = "interrupted-loop";
  const sessionId = "interrupted-session";
  const initial = await writeWakeState(dataDir, sessionId, loopId, now);

  assert.equal(await runWake(sessionId, loopId, initial.wakeToken, {
    client: terminalClient(loopId, { id: `turn-${loopId}`, status: "interrupted" }),
    clock: () => now,
    dataDir,
    scheduleWake: async () => assert.fail("interrupted turns must not schedule a wake"),
    sleep: async () => {},
  }), false);

  const state = await readLoopState(sessionId, dataDir);
  assert.equal(state.status, "terminated");
  assert.equal(state.endReason, "interrupted-turn");
});

test("does not revive a stopped loop when a late usage-limit completion arrives", async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-stale-data-"));
  context.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const now = Date.parse("2026-08-17T08:00:00+08:00");
  const loopId = "stale-loop";
  const sessionId = "stale-session";
  const initial = await writeWakeState(dataDir, sessionId, loopId, now);
  let resolveCompletion;
  let notifyMonitoring;
  const monitoring = new Promise((resolve) => { notifyMonitoring = resolve; });
  const completion = new Promise((resolve) => { resolveCompletion = resolve; });
  const client = terminalClient(loopId, null);
  client.waitForTurnCompletion = async () => {
    notifyMonitoring();
    return completion;
  };
  const scheduled = [];
  const wake = runWake(sessionId, loopId, initial.wakeToken, {
    client,
    clock: () => now,
    dataDir,
    scheduleWake: async (next) => scheduled.push(next),
    sleep: async () => {},
  });
  await monitoring;
  const running = await readLoopState(sessionId, dataDir);
  await writeLoopState(endLoop(running, "terminated", "requested", now), dataDir);
  resolveCompletion({
    id: `turn-${loopId}`,
    status: "failed",
    error: { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded" },
  });

  assert.equal(await wake, false);
  const state = await readLoopState(sessionId, dataDir);
  assert.equal(state.status, "terminated");
  assert.equal(state.endReason, "requested");
  assert.equal(scheduled.length, 0);
});
