import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const LAUNCHER = fileURLToPath(new URL("../bin/loop-codex", import.meta.url));

test("launcher exposes its private App Server socket to the server and remote TUI", async (context) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-launcher-"));
  const fakeBinDir = path.join(tempDir, "bin");
  const eventLog = path.join(tempDir, "events.jsonl");
  await fs.mkdir(fakeBinDir);
  context.after(() => fs.rm(tempDir, { recursive: true, force: true }));

  const fakeCodex = path.join(fakeBinDir, "codex");
  await fs.writeFile(fakeCodex, `#!/usr/bin/env node
const fs = require("node:fs");
const net = require("node:net");
const args = process.argv.slice(2);
const socket = process.env.CODEX_LOOP_APP_SERVER_SOCKET || null;
const record = (value) => fs.appendFileSync(process.env.CODEX_LOOP_TEST_LOG, JSON.stringify(value) + "\\n");

if (args[0] === "app-server") {
  const endpoint = args[args.indexOf("--listen") + 1];
  const socketPath = endpoint.replace(/^unix:\\/\\//, "");
  record({ role: "server", socket, endpoint });
  const server = net.createServer();
  server.listen(socketPath);
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
} else {
  const endpoint = args[args.indexOf("--remote") + 1];
  record({ role: "remote", socket, endpoint, args, socketExists: fs.existsSync(socket) });
}
`);
  await fs.chmod(fakeCodex, 0o755);

  const child = spawn("bash", [LAUNCHER, "--model", "test-model"], {
    env: {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      CODEX_LOOP_TEST_LOG: eventLog,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  assert.equal(exitCode, 0, stderr);
  const events = (await fs.readFile(eventLog, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(events.length, 2);
  const server = events.find((event) => event.role === "server");
  const remote = events.find((event) => event.role === "remote");
  assert.ok(server.socket);
  assert.equal(server.socket, remote.socket);
  assert.equal(server.endpoint, `unix://${server.socket}`);
  assert.equal(remote.endpoint, `unix://${server.socket}`);
  assert.equal(remote.socketExists, true);
  assert.deepEqual(remote.args.slice(-2), ["--model", "test-model"]);
  await assert.rejects(fs.access(path.dirname(server.socket)));
});
