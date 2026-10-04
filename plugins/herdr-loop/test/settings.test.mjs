import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, stat, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ConfigStore, defaultConfig, validateConfig, resolvePrompt, expandPath, pluginConfigDir } from "../src/settings/store.mjs";
import { prepareLaunch } from "../src/launcher/launch.mjs";

const preset = overrides => ({ id: "sample", name: "Project", cwd: "/tmp", command: "", prompt: { kind: "text", text: "请启动 Loop\n持续处理这个项目" }, ...overrides });

test("standalone status uses the same official config directory as plugin entrypoints", () => {
  assert.equal(pluginConfigDir({}, "/home/user"), "/home/user/.config/herdr/plugins/config/fnine.codex-loop");
  assert.equal(pluginConfigDir({ XDG_CONFIG_HOME: "/custom" }, "/home/user"), "/custom/herdr/plugins/config/fnine.codex-loop");
  assert.equal(pluginConfigDir({ HERDR_PLUGIN_CONFIG_DIR: "/injected", XDG_CONFIG_HOME: "/custom" }), "/injected");
});

test("settings save privately outside checkout and retain text verbatim", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "herdr-loop-settings-"));
  const store = new ConfigStore(dir);
  assert.deepEqual(await store.load(), defaultConfig());
  const config = { ...defaultConfig(), presets: [preset({})] };
  await store.save(config);
  assert.equal((await store.load()).presets[0].prompt.text, config.presets[0].prompt.text);
  assert.equal((await stat(store.filename)).mode & 0o777, 0o600);
  await assert.rejects(new ConfigStore(null).save(config), /Herdr/);
});

test("invalid or future settings are never overwritten", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "herdr-loop-invalid-"));
  const store = new ConfigStore(dir);
  const original = '{"version":9}';
  await writeFile(store.filename, original);
  await assert.rejects(store.load(), /未覆盖/);
  await assert.rejects(store.save({ ...defaultConfig(), defaults: { command: "a\nb" } }), /单行/);
  assert.equal(await readFile(store.filename, "utf8"), original);
});

test("Markdown is resolved against project and snapshotted once", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "herdr-loop-project-"));
  await mkdir(path.join(cwd, "docs"));
  const filename = path.join(cwd, "docs", "loop.md");
  await writeFile(filename, "# 工作\n执行 $x `literal`\n");
  const ready = await prepareLaunch(preset({ cwd, prompt: { kind: "file", path: "docs/loop.md" } }), defaultConfig());
  await writeFile(filename, "changed");
  assert.equal(ready.prompt, "# 工作\n执行 $x `literal`\n");
  assert.equal(ready.command, "apiloopcodex");
  assert.equal(await resolvePrompt(ready.preset), "changed");
});

test("validates command aliases/arguments, prompt limits, IDs and placements", async () => {
  const config = validateConfig({ ...defaultConfig(), presets: [preset({ command: "apiloopcodex --model local", placement: { mode: "existing-tab", workspaceId: "w2", tabId: "w2:t3", direction: "down" } })] });
  assert.equal(config.presets[0].command, "apiloopcodex --model local");
  assert.throws(() => validateConfig({ ...defaultConfig(), presets: [preset({ prompt: { kind: "text", text: " " } })] }), /提示语/);
  assert.throws(() => validateConfig({ ...defaultConfig(), presets: [preset({}), preset({})] }), /重复/);
  assert.throws(() => validateConfig({ ...defaultConfig(), presets: [preset({ prompt: { kind: "text", text: "中".repeat(30000) } })] }), /64 KiB/);
  assert.throws(() => validateConfig({ ...defaultConfig(), presets: [preset({ prompt: { kind: "file", path: "script.sh" } })] }), /\.md/);
  assert.throws(() => validateConfig({ ...defaultConfig(), presets: [preset({ command: "bad\u0000" })] }), /无效/);
  assert.equal(expandPath("~/project", "/tmp", "/home/user"), "/home/user/project");
});

test("missing/oversized Markdown and non-directory cwd fail before launch", async () => {
  await assert.rejects(resolvePrompt(preset({ prompt: { kind: "file", path: "missing-herdr-loop.md" } })), /ENOENT/);
  const dir = await mkdtemp(path.join(os.tmpdir(), "herdr-loop-large-"));
  const filename = path.join(dir, "large.md");
  await writeFile(filename, "a".repeat(65537));
  await assert.rejects(resolvePrompt(preset({ cwd: dir, prompt: { kind: "file", path: "large.md" } })), /64 KiB/);
  await assert.rejects(prepareLaunch(preset({ cwd: filename }), defaultConfig()), /不是目录/);
});
