// Optional real-Herdr smoke test. Only an isolated temporary registry/server is used.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify, stripVTControlCharacters } from "node:util";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { HerdrClient } from "../src/herdr-client/client.mjs";
import { ConfigStore, defaultConfig } from "../src/settings/store.mjs";
import { ReceiptStore } from "../src/launcher/receipts.mjs";
import { prepareLaunch, launchOnce } from "../src/launcher/launch.mjs";
import { loadOverview } from "../src/ui/app.mjs";
import { focusLoop } from "../src/overview/model.mjs";

const execute = promisify(execFile);
// macOS's /var/folders temp path is too long for Unix-domain socket names.
const base = await mkdtemp(path.join(process.platform === "darwin" ? "/tmp" : os.tmpdir(), "hl-smoke-"));
const root = fileURLToPath(new URL("../", import.meta.url));
const session = `loop-smoke-${process.pid}`;
const env = {
  ...process.env,
  XDG_CONFIG_HOME: path.join(base, "c"), XDG_STATE_HOME: path.join(base, "s"), XDG_RUNTIME_DIR: path.join(base, "r"),
  HERDR_CONFIG_PATH: path.join(base, "c", "herdr", "config.toml"),
  HERDR_SESSION: session,
};
for (const key of ["HERDR_SOCKET_PATH", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID", "HERDR_ENV", "HERDR_PLUGIN_CONTEXT_JSON"]) delete env[key];
env.HERDR_SOCKET_PATH = path.join(env.XDG_CONFIG_HOME, "herdr", "sessions", session, "herdr.sock");
let server, attached, serverLog = "", clientOutput = "";
const bin = process.env.HERDR_BIN_PATH || "herdr";
const client = new HerdrClient({ env: { ...env, HERDR_BIN_PATH: bin } });
async function eventually(operation, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  let error;
  while (Date.now() < deadline) {
    try { return await operation(); } catch (caught) { error = caught; await delay(100); }
  }
  throw error || new Error("smoke timeout");
}
try {
  await mkdir(path.dirname(env.HERDR_CONFIG_PATH), { recursive: true });
  await mkdir(env.XDG_RUNTIME_DIR, { mode: 0o700 });
  await writeFile(env.HERDR_CONFIG_PATH, 'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n[update]\nversion_check = false\nmanifest_check = false\n');
  const linked = JSON.parse((await execute(bin, ["--session", session, "plugin", "link", root], { env })).stdout);
  assert.equal(linked.result.plugin.plugin_id, "fnine.codex-loop");
  assert.deepEqual(linked.result.plugin.warnings || [], []);
  console.log("✓ Manifest accepted by installed Herdr; isolated registry linked.");
  server = spawn(bin, ["--session", session, "server"], { env, cwd: base, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", data => { serverLog = (serverLog + data).slice(-4000); });
  server.stderr.on("data", data => { serverLog = (serverLog + data).slice(-4000); });
  const snapshot = await eventually(() => client.snapshot());
  const actions = await client.call(["plugin", "action", "list", "--plugin", "fnine.codex-loop"]);
  assert.equal(actions.actions.length, 3);
  const configDir = path.join(base, "c", "herdr", "plugins", "config", "fnine.codex-loop");
  const store = new ConfigStore(configDir);
  const dataRoot = path.join(base, "loop-data");
  await mkdir(path.join(dataRoot, "sessions"), { recursive: true });
  const codexSession = "01234567-89ab-4cde-8fab-0123456789ab";
  const state = { version: 1, id: "smokeloop", sessionId: codexSession, task: "Smoke fixture only", status: "waiting", runs: 0, createdAt: Date.now(), cwd: base };
  await writeFile(path.join(dataRoot, "sessions", `${createHash("sha256").update(codexSession).digest("hex")}.json`), JSON.stringify(state));
  const stub = path.join(base, "agent-stub.mjs");
  const captured = path.join(base, "captured.json");
  const reportLog = path.join(base, "report.json");
  await writeFile(stub, `
import net from 'node:net';
import {writeFileSync} from 'node:fs';
process.title = 'codex';
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write('Codex smoke fixture ready\\r\\n> \\x1b[?2004h');
const report = state => {
  const socket = net.createConnection(process.env.HERDR_SOCKET_PATH);
  socket.on('connect', () => socket.write(JSON.stringify({id:'smoke-report',method:'pane.report_agent',params:{pane_id:process.env.HERDR_PANE_ID,source:'custom:loop-smoke',agent:'codex',state}})+'\\n'));
  socket.on('data', data => {
    writeFileSync(${JSON.stringify(reportLog)}, data.toString()); socket.end();
    if(state === 'idle') {
      const native = net.createConnection(process.env.HERDR_SOCKET_PATH);
      native.on('connect', () => native.write(JSON.stringify({id:'smoke-native-session',method:'pane.report_agent_session',params:{pane_id:process.env.HERDR_PANE_ID,source:'herdr:codex',agent:'codex',agent_session_id:${JSON.stringify(codexSession)},session_start_source:'startup'}})+'\\n'));
      native.on('data', () => native.end());
      native.on('error', error => process.stderr.write(error.message));
    }
  });
  socket.on('error', error => process.stderr.write(error.message));
};
report('idle');
let buffer = '', submissions = [];
process.stdin.on('data', data => {
  buffer += data.toString();
  if (buffer.endsWith('\\r')) {
    let text = buffer.slice(0,-1);
    if(text.startsWith('\\x1b[200~') && text.endsWith('\\x1b[201~')) text = text.slice(6,-6);
    submissions.push(text);
    writeFileSync(${JSON.stringify(captured)},JSON.stringify({submissions}));
    buffer = '';
    report('working');
  }
});
`);
  const preset = { id: "smoke", name: "Smoke Project", cwd: base,
    command: `apiloopcodex() { exec ${JSON.stringify(process.execPath)} ${JSON.stringify(stub)}; }; apiloopcodex`,
    prompt: { kind: "text", text: "首轮 fixture\n$x `quoted` --literal" }, placement: { mode: "new-tab", direction: "right" } };
  const config = { ...defaultConfig(), discoverDataDirs: false, dataDirs: [dataRoot], presets: [preset], defaults: { ...defaultConfig().defaults, readyTimeoutMs: 10_000 } };
  await store.save(config);
  assert.equal((await loadOverview(config, client)).counts.unlinked, 1);
  const targetWorkspace = snapshot.workspaces[0]?.workspace_id || (await client.call(["workspace", "create", "--cwd", base, "--label", "Smoke", "--no-focus"])).workspace.workspace_id;
  await client.focusPane((await client.snapshot()).panes.find(pane => pane.workspace_id === targetWorkspace).pane_id);
  console.log("✓ Ordinary shell focus works through the exact-pane socket API.");
  const receipt = await launchOnce(await prepareLaunch(preset, config), { mode: "new-tab", workspaceId: targetWorkspace }, client, new ReceiptStore(path.join(base, "launch-state")));
  if (receipt.stage !== "sent") {
    console.error(JSON.stringify((await client.snapshot()).agents));
    console.error(await readFile(reportLog, "utf8").catch(() => "No report response"));
    if (receipt.paneId) console.error((await execute(bin, ["pane", "read", receipt.paneId, "--source", "recent-unwrapped", "--lines", "20"], { env })).stdout);
  }
  assert.equal(receipt.stage, "sent", JSON.stringify(receipt));
  const capture = await eventually(async () => JSON.parse(await readFile(captured, "utf8")));
  assert.deepEqual(capture.submissions, [preset.prompt.text]);
  console.log("✓ Real shell function ran; Codex readiness checked; exact multiline prompt submitted once.");
  const linkedOverview = await loadOverview(config, client);
  assert.equal(linkedOverview.counts.linked, 1);
  const other = await client.call(["workspace", "create", "--cwd", base, "--label", "Other Space", "--no-focus"]);
  const moved = await client.call(["pane", "move", receipt.paneId, "--new-tab", "--workspace", other.workspace.workspace_id]);
  await focusLoop(linkedOverview.loops[0], client);
  assert.equal((await client.snapshot()).focused_pane_id, moved.move_result.pane.pane_id);
  console.log("✓ Native session linked; cross-Space movement re-resolved and focused correctly.");
  if (process.platform === "darwin") {
    // Python's stdlib PTY bridge handles piped stdin (BSD script does not).
    // It is only a smoke-test dependency, never a plugin runtime dependency.
    const bridge = `
import os, pty, sys, fcntl, termios, struct, select
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
try:
    while True:
        ready, _, _ = select.select([fd, sys.stdin.fileno()], [], [])
        for source in ready:
            data = os.read(source, 65536)
            if not data:
                raise EOFError()
            os.write(sys.stdout.fileno() if source == fd else fd, data)
except (EOFError, OSError):
    pass
finally:
    os.close(fd)
    os.waitpid(pid, 0)
`;
    attached = spawn("python3", ["-c", bridge, bin, "--session", session], { env, cwd: base, stdio: ["pipe", "pipe", "pipe"] });
    attached.stdout.setEncoding("utf8");
    attached.stdout.on("data", data => { clientOutput = (clientOutput + data).slice(-200000); });
    attached.stderr.on("data", data => { serverLog = (serverLog + data).slice(-4000); });
    await eventually(async () => { assert.ok(clientOutput.includes("Other Space")); });
    // Navigate from a different workspace through the actual overview popup.
    const originalPane = (await client.snapshot()).panes.find(pane => pane.workspace_id === targetWorkspace);
    await client.focusPane(originalPane.pane_id);
    clientOutput = "";
    await client.call(["plugin", "action", "invoke", "overview", "--plugin", "fnine.codex-loop"]);
    await eventually(async () => { assert.ok(stripVTControlCharacters(clientOutput).includes("记录中活跃")); });
    attached.stdin.write("\r");
    await eventually(async () => { assert.equal((await client.snapshot()).focused_pane_id, moved.move_result.pane.pane_id); });
    await delay(700);
    console.log("✓ Enter in the actual overview popup navigates across Spaces and retains target focus.");
    for (const [action, marker] of [["overview", "记录中活跃"], ["launch", "全局命令"], ["settings", "Default command"]]) {
      clientOutput = "";
      await client.call(["plugin", "action", "invoke", action, "--plugin", "fnine.codex-loop"]);
      await eventually(async () => { assert.ok(stripVTControlCharacters(clientOutput).includes(marker), `popup did not render ${marker}`); });
      attached.stdin.write("\x1b");
      await delay(700);
    }
    assert.equal((await client.snapshot()).focused_pane_id, moved.move_result.pane.pane_id);
    console.log("✓ Overview, launcher and settings actions rendered in real popup PTYs; Escape preserves focus.");
  }
  console.log("SMOKE PASSED (no real Codex turn, no user registry/hooks/settings changed).");
} catch (error) {
  console.error(error.message);
  if (server && clientOutput) console.error(JSON.stringify(await client.call(["plugin", "log", "list", "--plugin", "fnine.codex-loop", "--limit", "3"]).catch(() => ({}))));
  if (serverLog) console.error(serverLog);
  if (clientOutput) console.error(clientOutput.slice(-3000));
  process.exitCode = 1;
} finally {
  if (server) {
    await execute(bin, ["--session", session, "session", "stop", session], { env, timeout: 10_000 }).catch(() => { server.kill("SIGTERM"); });
  }
  if (attached && attached.exitCode === null) attached.kill("SIGTERM");
  // Delete only the exact temporary fixture directory this test created.
  await rm(base, { recursive: true, force: true });
}
