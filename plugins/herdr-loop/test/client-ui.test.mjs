import test from "node:test";
import assert from "node:assert/strict";
import { HerdrClient, invocationContext, HerdrError } from "../src/herdr-client/client.mjs";
import { safeText, clip, wrapText } from "../src/ui/terminal.mjs";
import { App } from "../src/ui/app.mjs";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

test("CLI invocation uses inherited socket/bin and argv, never shell interpolation", async () => {
  const calls = [];
  const env = { HERDR_BIN_PATH: "/custom/herdr", HERDR_SOCKET_PATH: "/socket" };
  const client = new HerdrClient({ env, run: async (...args) => { calls.push(args); return { stdout: JSON.stringify({ result: { type: "ok" } }) }; } });
  await client.runCommand("w1:p2", "apiloopcodex --model x");
  await client.prompt("w1:p2", "--literal\n$x `quoted`");
  assert.deepEqual(calls[0].slice(0, 2), ["/custom/herdr", ["pane", "run", "w1:p2", "apiloopcodex --model x"]]);
  assert.deepEqual(calls[1][1], ["agent", "prompt", "w1:p2", "--literal\n$x `quoted`"]);
  assert.equal(calls[0][2].env, env);
  assert.equal(calls[0][2].shell, undefined);
});

test("pane.run accepts empty successful acknowledgement, snapshot must still return JSON", async () => {
  const client = new HerdrClient({ run: async () => ({ stdout: "" }) });
  assert.deepEqual(await client.runCommand("w1:p2", "alias-command"), { type: "ok" });
  await assert.rejects(client.snapshot(), /JSON/);
});

test("shell readiness requires the original shell, not a process that exec-replaced its PID", async () => {
  let info = { shell_pid: 123, foreground_process_group_id: 123, foreground_processes: [{ pid: 123, name: "zsh" }] };
  const client = new HerdrClient({ run: async () => ({ stdout: JSON.stringify({ result: { process_info: info } }) }) });
  assert.equal(await client.shellReady("w1:p1"), true);
  info.foreground_processes[0].name = "codex";
  assert.equal(await client.shellReady("w1:p1"), false);
  info.foreground_processes = [{ pid: 456, name: "zsh" }];
  assert.equal(await client.shellReady("w1:p1"), false);
});

test("CLI server errors preserve definitive blocked versus uncertain transport", async () => {
  const client = new HerdrClient({ run: async () => { const error = new Error("command failed"); error.stderr = JSON.stringify({ error: { code: "agent_blocked", message: "blocked" } }); throw error; } });
  await assert.rejects(client.prompt("id", "prompt"), error => error instanceof HerdrError && error.code === "agent_blocked" && !error.uncertain);
  client.run = async () => { throw new Error("transport"); };
  await assert.rejects(client.prompt("id", "prompt"), error => error.uncertain);
  client.run = async () => ({ stdout: "not JSON" });
  await assert.rejects(client.snapshot(), /JSON/);
});

test("exact ordinary-pane focus uses the socket API with literal pane ID", async t => {
  const dir = await mkdtemp(path.join(process.platform === "darwin" ? "/tmp" : os.tmpdir(), "hl-focus-"));
  const socketPath = path.join(dir, "herdr.sock");
  const requests = [];
  const server = net.createServer(socket => {
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.trim());
      requests.push(request);
      socket.write(JSON.stringify({ id: request.id, result: { type: "ok" } }) + "\n");
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const client = new HerdrClient({ env: { HERDR_SOCKET_PATH: socketPath } });
  assert.deepEqual(await client.focusPane("w9:p4"), { type: "ok" });
  assert.deepEqual(requests[0].params, { pane_id: "w9:p4" });
  assert.equal(requests[0].method, "pane.focus");
});

test("non-TTY entrypoints fail promptly, not an input wait with no listener", async () => {
  const execute = promisify(execFile);
  await assert.rejects(execute(process.execPath, [new URL("../src/index.mjs", import.meta.url).pathname, "settings"], { timeout: 2000 }), error => error.code === 1 && /interactive terminal required/.test(error.stderr));
});

test("caller context uses invoking pane, not popup pane; terminal control sequences stripped", () => {
  assert.deepEqual(invocationContext({ HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_id: "w2", tab_id: "w2:t7", focused_pane_id: "w2:p1", focused_pane_cwd: "/project" }), HERDR_PANE_ID: "popup" }), { workspaceId: "w2", tabId: "w2:t7", paneId: "w2:p1", cwd: "/project" });
  assert.equal(safeText("hello\u001b[2J\nworld\u0000"), "hello[2J world");
  assert.ok(clip("中文中文", 5).length <= 3);
  assert.deepEqual(wrapText("中文ab\n12345", 4), ["中文", "ab", "1234", "5"]);
});

test("progress observes immediate launch errors without unhandled rejection", async () => {
  const terminal = { render() {}, key: async () => { await new Promise(resolve => setTimeout(resolve, 5)); return null; } };
  const app = new App(terminal);
  await assert.rejects(app.runWithProgress(async () => { throw new Error("early failure"); }), /early failure/);
});

test("manifest remains Herdr-only, with no Codex marketplace registration", async () => {
  const manifest = await readFile(new URL("../herdr-plugin.toml", import.meta.url), "utf8");
  assert.match(manifest, /min_herdr_version = "0.9.3"/);
  assert.equal((manifest.match(/\[\[panes\]\]/g) || []).length, 3);
  assert.equal((manifest.match(/placement = "popup"/g) || []).length, 3);
  const marketplace = JSON.parse(await readFile(new URL("../../../.agents/plugins/marketplace.json", import.meta.url), "utf8"));
  assert.equal(JSON.stringify(marketplace).includes("herdr-loop"), false);
});
