import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { launchOnce, resumeLaunch, focusReceipt, resolveTarget } from "../src/launcher/launch.mjs";
import { ReceiptStore } from "../src/launcher/receipts.mjs";
import { HerdrError } from "../src/herdr-client/client.mjs";

test("launch receipts are isolated by Herdr server; presets remain globally shared", () => {
  const first = new ReceiptStore("/plugin-state", "/sockets/first");
  const second = new ReceiptStore("/plugin-state", "/sockets/second");
  assert.notEqual(first.dir, second.dir);
  assert.equal(first.dir, new ReceiptStore("/plugin-state", "/sockets/first").dir);
});

function fake({ statuses = ["idle"], move = false, kind = "codex", promptError = null, commandError = null, shell = true } = {}) {
  const calls = [];
  let started = false, created = false, cursor = 0;
  let live = { pane_id: "w1:p2", terminal_id: "terminal-new", workspace_id: "w1", tab_id: "w1:t2" };
  const client = {
    calls,
    async snapshot() {
      if (started && move) live = { ...live, pane_id: "w2:p7", workspace_id: "w2", tab_id: "w2:t1" };
      const status = statuses[Math.min(cursor, statuses.length - 1)];
      if (started) cursor++;
      const agent = { ...live, agent: kind, agent_status: status, interactive_ready: status === "idle" || status === "done", launch_pending: false,
        agent_session: { agent: kind, kind: "id", value: "session-new" } };
      return {
        workspaces: [{ workspace_id: "w1", label: "one", active_tab_id: "w1:t1" }, { workspace_id: "w2", label: "two" }],
        tabs: [{ tab_id: "w1:t1", workspace_id: "w1" }, { tab_id: live.tab_id, workspace_id: live.workspace_id }],
        panes: [{ pane_id: "w1:p1", terminal_id: "existing", workspace_id: "w1", tab_id: "w1:t1" }, ...(created ? [started ? agent : live] : [])],
        agents: started ? [agent] : [],
      };
    },
    async createTab(...args) { calls.push(["tab", ...args]); created = true; return live; },
    async createWorkspace(...args) { calls.push(["space", ...args]); created = true; return live; },
    async split(...args) { calls.push(["split", ...args]); created = true; return live; },
    async shellReady(id) { calls.push(["shell", id]); return shell; },
    async runCommand(...args) { calls.push(["command", ...args]); if (commandError) throw commandError; started = true; },
    async prompt(...args) { calls.push(["prompt", ...args]); if (promptError) throw promptError; },
    async focus(id) { calls.push(["focus", id]); },
    async focusPane(id) { calls.push(["pane-focus", id]); },
  };
  return client;
}
const prepared = {
  preset: { id: "project", name: "My Project", cwd: "/some project" },
  command: "apiloopcodex --model custom", prompt: "启动 Loop\n$x `exact` \"quoted\"", readyTimeoutMs: 1000,
};
const target = { mode: "new-tab", workspaceId: "w1" };
async function store() { return new ReceiptStore(await mkdtemp(path.join(os.tmpdir(), "herdr-loop-launch-"))); }
function fast() { let clock = 0; return { now: () => clock, sleep: async () => { clock += 400; }, pollMs: 400 }; }

test("launch creates new project terminal, executes alias unchanged, submits exact prompt once", async () => {
  const client = fake({ statuses: ["unknown", "idle"] });
  const receipts = await store();
  const result = await launchOnce(prepared, target, client, receipts, fast());
  assert.equal(result.stage, "sent");
  assert.deepEqual(client.calls, [
    ["tab", "w1", "/some project", "My Project"], ["shell", "w1:p2"],
    ["command", "w1:p2", prepared.command], ["prompt", "w1:p2", prepared.prompt],
  ]);
  assert.equal((await receipts.load(result.id)).prompt, null);
  assert.equal(result.promptHash.length, 64);
  await assert.rejects(resumeLaunch(result.id, client, receipts, fast()), /不能安全重发/);
  assert.equal(client.calls.filter(call => call[0] === "prompt").length, 1);
});

test("new Space / existing Tab create only new terminals, with explicit cwd and split direction", async () => {
  for (const [placement, expected] of [
    [{ mode: "new-workspace" }, ["space", "/some project", "My Project"]],
    [{ mode: "existing-tab", workspaceId: "w1", tabId: "w1:t1", direction: "down" }, ["split", "w1:p1", "down", "/some project"]],
  ]) {
    const client = fake();
    assert.equal((await launchOnce(prepared, placement, client, await store(), fast())).stage, "sent");
    assert.deepEqual(client.calls[0], expected);
  }
});

test("validates stale destination before any mutation", async () => {
  const client = fake();
  await assert.rejects(launchOnce(prepared, { ...target, workspaceId: "gone" }, client, await store(), fast()), /Space/);
  await assert.rejects(launchOnce(prepared, { mode: "existing-tab", workspaceId: "w1", tabId: "gone" }, client, await store(), fast()), /Tab/);
  assert.deepEqual(client.calls, []);
  const resolved = resolveTarget(await client.snapshot(), { mode: "existing-tab", workspaceId: "w1", tabId: "w1:t1", anchorPaneId: "gone" });
  assert.equal(resolved.anchorPaneId, "w1:p1");
});

test("follows stable terminal identity after cross-Space move", async () => {
  const client = fake({ move: true });
  const result = await launchOnce(prepared, target, client, await store(), fast());
  assert.equal(result.stage, "sent");
  assert.deepEqual(client.calls.at(-1), ["prompt", "w2:p7", prepared.prompt]);
  await focusReceipt(result, client);
  assert.deepEqual(client.calls.at(-1), ["focus", "w2:p7"]);
});

test("blocked / unknown / wrong / already working agent never receives prompt", async () => {
  for (const [options, expected] of [
    [{ statuses: ["blocked"] }, "blocked-no-prompt"],
    [{ statuses: ["unknown"] }, "timed-out-no-prompt"],
    [{ kind: "claude" }, "wrong-agent-no-prompt"],
    [{ statuses: ["working", "idle"] }, "already-working-no-prompt"],
  ]) {
    const client = fake(options);
    const result = await launchOnce(prepared, target, client, await store(), fast());
    assert.equal(result.stage, expected);
    assert.equal(client.calls.some(call => call[0] === "prompt"), false);
    assert.equal(client.calls.filter(call => call[0] === "command").length, 1);
  }
});

test("manual resume after resolving a block does not restart command, sends once", async () => {
  const client = fake({ statuses: ["blocked", "idle"] });
  const receipts = await store();
  const blocked = await launchOnce(prepared, target, client, receipts, fast());
  assert.equal(blocked.stage, "blocked-no-prompt");
  const sent = await resumeLaunch(blocked.id, client, receipts, fast());
  assert.equal(sent.stage, "sent");
  assert.equal(client.calls.filter(call => call[0] === "command").length, 1);
  assert.equal(client.calls.filter(call => call[0] === "prompt").length, 1);
  assert.equal(sent.error, null);
});

test("native session identity is captured while blocked and replacement refuses resume", async () => {
  const client = fake({ statuses: ["blocked", "idle"] });
  const receipts = await store();
  const blocked = await launchOnce(prepared, target, client, receipts, fast());
  assert.equal(blocked.agentSession.value, "session-new");
  const original = client.snapshot;
  client.snapshot = async () => {
    const snapshot = await original();
    for (const item of [...snapshot.agents, ...snapshot.panes]) if (item.agent_session) item.agent_session = { ...item.agent_session, value: "replacement" };
    return snapshot;
  };
  const result = await resumeLaunch(blocked.id, client, receipts, fast());
  assert.equal(result.stage, "session-replaced-no-prompt");
  assert.equal(client.calls.some(call => call[0] === "prompt"), false);
});

test("unmanaged Codex idle may omit interactive_ready; an explicit false is never ready", async () => {
  for (const [flag, expected] of [[undefined, "sent"], [false, "timed-out-no-prompt"]]) {
    const client = fake();
    const original = client.snapshot;
    client.snapshot = async () => {
      const snapshot = await original();
      for (const agent of snapshot.agents) {
        if (flag === undefined) delete agent.interactive_ready;
        else agent.interactive_ready = flag;
      }
      return snapshot;
    };
    assert.equal((await launchOnce(prepared, target, client, await store(), fast())).stage, expected);
  }
});

test("cancelling after terminal creation but before command cannot resume prompt injection", async () => {
  const client = fake();
  const controller = new AbortController();
  client.shellReady = async () => { controller.abort(); return true; };
  const receipts = await store();
  const result = await launchOnce(prepared, target, client, receipts, { ...fast(), signal: controller.signal });
  assert.equal(result.stage, "cancelled-no-command");
  assert.equal(client.calls.some(call => call[0] === "command" || call[0] === "prompt"), false);
  await assert.rejects(resumeLaunch(result.id, client, receipts, fast()), /不能安全重发/);
});

test("cancelled agent wait is explicitly resumable without restarting command", async () => {
  const client = fake({ statuses: ["unknown", "idle"] });
  const controller = new AbortController();
  const receipts = await store();
  const clock = fast();
  const result = await launchOnce(prepared, target, client, receipts, {
    ...clock, signal: controller.signal, sleep: async () => { controller.abort(); },
  });
  assert.equal(result.stage, "cancelled-no-prompt");
  assert.equal(client.calls.some(call => call[0] === "prompt"), false);
  assert.equal((await resumeLaunch(result.id, client, receipts, fast())).stage, "sent");
  assert.equal(client.calls.filter(call => call[0] === "command").length, 1);
});

test("ambiguous delivery is persisted and never automatically or manually retried", async () => {
  const client = fake({ promptError: new HerdrError("connection lost") });
  const receipts = await store();
  const result = await launchOnce(prepared, target, client, receipts, fast());
  assert.equal(result.stage, "delivery-unknown");
  assert.equal(result.prompt, null);
  await assert.rejects(resumeLaunch(result.id, client, receipts, fast()), /不能安全重发/);
  assert.equal(client.calls.filter(call => call[0] === "prompt").length, 1);
});

test("agent_blocked is the only definitive no-input send error; explicit resume remains possible", async () => {
  const client = fake({ promptError: new HerdrError("blocked", "agent_blocked", { uncertain: false }) });
  const receipts = await store();
  const blocked = await launchOnce(prepared, target, client, receipts, fast());
  assert.equal(blocked.stage, "blocked-no-prompt");
  client.prompt = async (...args) => client.calls.push(["prompt", ...args]);
  assert.equal((await resumeLaunch(blocked.id, client, receipts, fast())).stage, "sent");
});

test("persistent atomic claim prevents concurrent popup submissions", async () => {
  const client = fake({ statuses: ["blocked", "idle"] });
  const receipts = await store();
  const blocked = await launchOnce(prepared, target, client, receipts, fast());
  const results = await Promise.all([resumeLaunch(blocked.id, client, receipts, fast()), resumeLaunch(blocked.id, client, receipts, fast())]);
  assert.ok(results.some(item => item.stage === "sent"));
  assert.equal(client.calls.filter(call => call[0] === "prompt").length, 1);
  assert.equal((await receipts.load(blocked.id)).stage, "sent");
});

test("cancel before launch is non-mutating; shell timeout doesn't run command or allow prompt resume", async () => {
  const client = fake();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(launchOnce(prepared, target, client, await store(), { signal: controller.signal }), /取消/);
  assert.deepEqual(client.calls, []);
  const slow = fake({ shell: false });
  const receipts = await store();
  const result = await launchOnce(prepared, target, slow, receipts, fast());
  assert.equal(result.stage, "shell-timeout-no-command");
  await focusReceipt(result, slow);
  assert.deepEqual(slow.calls.at(-1), ["pane-focus", "w1:p2"]);
  assert.equal(slow.calls.some(call => call[0] === "command" || call[0] === "prompt"), false);
  await assert.rejects(resumeLaunch(result.id, slow, receipts, fast()), /不能安全重发/);
});

test("command ambiguity is not retried and is distinct from prompt ambiguity", async () => {
  const client = fake({ commandError: new HerdrError("timeout") });
  const receipts = await store();
  const result = await launchOnce(prepared, target, client, receipts, fast());
  assert.equal(result.stage, "command-outcome-unknown");
  assert.equal(client.calls.some(call => call[0] === "prompt"), false);
  await assert.rejects(resumeLaunch(result.id, client, receipts, fast()), /不能安全重发/);
});

test("missing state directory fails before any external mutation", async () => {
  const client = fake();
  await assert.rejects(launchOnce(prepared, target, client, new ReceiptStore(null), fast()), /状态目录/);
  assert.deepEqual(client.calls, []);
});
