import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, utimes, symlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { discoverDataDirs, scanLoops } from "../src/overview/discovery.mjs";
import { associateLoop, makeOverview, filterLoops, focusLoop } from "../src/overview/model.mjs";

const state = overrides => ({ version: 1, id: "loop1", sessionId: "session1", task: "项目任务", status: "waiting", runs: 0, createdAt: 1000, cwd: "/project", ...overrides });
async function fixture(root, value, name = null) {
  await mkdir(path.join(root, "sessions"), { recursive: true });
  const filename = path.join(root, "sessions", name || `${createHash("sha256").update(value.sessionId || "invalid").digest("hex")}.json`);
  await writeFile(filename, JSON.stringify(value));
  return filename;
}
const pane = overrides => ({ pane_id: "w1:p1", terminal_id: "term1", workspace_id: "w1", tab_id: "w1:t1", agent: "codex", agent_status: "idle", agent_session: { agent: "codex", kind: "id", value: "session1", source: "integration:codex" }, ...overrides });
const snapshot = panes => ({ panes, workspaces: [{ workspace_id: "w1", label: "Project Space" }], tabs: [{ tab_id: "w1:t1", label: "Coding" }] });

test("read-only discovery covers installed plugin, fallback, overrides, without broad scanning", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "herdr-loop-discover-"));
  const codex = path.join(home, "custom-codex");
  await mkdir(path.join(codex, "plugins", "data", "codex-loop-fnine59"), { recursive: true });
  await mkdir(path.join(codex, "plugins", "data", "unrelated"), { recursive: true });
  const config = { discoverDataDirs: true, dataDirs: ["/extra"] };
  const roots = await discoverDataDirs(config, { home, env: { CODEX_HOME: codex, CODEX_LOOP_DATA_DIR: "/override", PLUGIN_DATA: "/not-loop" } });
  assert.deepEqual(roots, ["/extra", "/override", path.join(home, ".codex-loop", "plugin-data"), path.join(codex, "plugins", "data", "codex-loop-fnine59")]);
  assert.deepEqual(await discoverDataDirs({ ...config, discoverDataDirs: false }, { home, env: {} }), ["/extra"]);
});

test("scanner tolerates missing/bad files, ignores atomic temps and symlinks, does not write", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "herdr-loop-scan-"));
  const filename = await fixture(root, state({}));
  await fixture(root, { ...state({ sessionId: "future" }), version: 2 });
  await writeFile(path.join(root, "sessions", `${"a".repeat(64)}.json`), "{");
  await writeFile(path.join(root, "sessions", "random.json"), "{}");
  await writeFile(`${filename}.tmp`, "{}");
  await symlink(filename, path.join(root, "sessions", `${"b".repeat(64)}.json`));
  const files = await readdir(path.join(root, "sessions"));
  const original = await readFile(filename, "utf8");
  const scan = await scanLoops([root, root, path.join(root, "missing")]);
  assert.equal(scan.loops.length, 1);
  assert.equal(scan.warnings.length, 2);
  assert.equal(scan.sources.at(-1).available, false);
  assert.deepEqual(await readdir(path.join(root, "sessions")), files);
  assert.equal(await readFile(filename, "utf8"), original);
});

test("latest loop per session wins across multiple sources, not a full history", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "herdr-loop-merge-"));
  const a = path.join(root, "a"), b = path.join(root, "b");
  const old = await fixture(a, state({ createdAt: 1000, id: "old" }));
  await fixture(b, state({ createdAt: 2000, id: "new", status: "completed" }));
  await utimes(old, new Date(), new Date());
  await fixture(a, state({ sessionId: "another", id: "active" }));
  const scan = await scanLoops([a, b]);
  assert.deepEqual(scan.loops.map(item => item.id), ["active", "new"]);
});

test("exact native identity only: cwd/title/path must not associate, duplicates are ambiguous", () => {
  const loop = state({});
  assert.equal(associateLoop(loop, snapshot([pane({})])).linked, true);
  assert.equal(associateLoop(loop, snapshot([pane({ agent_session: { agent: "codex", kind: "id", value: "other" }, cwd: loop.cwd, title: loop.task })])).linked, false);
  assert.equal(associateLoop(loop, snapshot([pane({ agent_session: { agent: "claude", kind: "id", value: loop.sessionId } })])).linked, false);
  assert.equal(associateLoop(loop, snapshot([pane({ agent_session: { agent: "codex", kind: "path", value: loop.sessionId } })])).linked, false);
  assert.equal(associateLoop(loop, snapshot([pane({}), pane({ pane_id: "w1:p2", terminal_id: "term2" })])).reason, "ambiguous");
  assert.equal(associateLoop(state({ threadId: "thread" }), snapshot([pane({ agent_session: { agent: "codex", kind: "id", value: "thread" } })])).linked, true);
  assert.equal(associateLoop(loop, snapshot([pane({ agent: null })])).linked, false);
  assert.equal(associateLoop(loop, snapshot([pane({ agent: "claude", display_agent: "codex" })])).linked, false);
});

test("counts distinguish recorded active, associated, unlinked and ended; filters include outside Herdr", () => {
  const overview = makeOverview({ loops: [state({}), state({ id: "outside", sessionId: "outside" }), state({ id: "ended", sessionId: "ended", status: "stopped" })], warnings: [], sources: [] }, snapshot([pane({})]));
  assert.deepEqual(overview.counts, { total: 3, active: 2, linked: 1, unlinked: 2, ended: 1 });
  assert.equal(filterLoops(overview).length, 2);
  assert.equal(filterLoops(overview, { scope: "unlinked" }).length, 2);
  assert.equal(filterLoops(overview, { scope: "workspace", workspaceId: "w1" }).length, 1);
  assert.equal(filterLoops(overview, { scope: "all", query: "coding" }).length, 1);
  assert.equal(makeOverview({ loops: [state({})], warnings: [], sources: [] }, null, "offline").counts.unlinked, 1);
});

test("navigation re-resolves moving pane and refuses stale/ambiguous sessions", async () => {
  const calls = [];
  const client = { snapshot: async () => snapshot([pane({ pane_id: "w9:p5", workspace_id: "w9", tab_id: "w9:t1" })]), focus: async id => calls.push(id) };
  await focusLoop(state({}), client);
  assert.deepEqual(calls, ["w9:p5"]);
  client.snapshot = async () => snapshot([]);
  await assert.rejects(focusLoop(state({}), client), /未关联/);
  assert.equal(calls.length, 1);
});
