import { mkdir, readFile, rename, writeFile, unlink, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

export const MAX_PROMPT_BYTES = 64 * 1024;
export const PLUGIN_ID = "fnine.codex-loop";

export function pluginConfigDir(env = process.env, home = os.homedir()) {
  return env.HERDR_PLUGIN_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "herdr", "plugins", "config", PLUGIN_ID);
}

export function expandPath(value, base = process.cwd(), home = os.homedir()) {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.resolve(home, value.slice(2));
  return path.resolve(base, value);
}

export function defaultConfig() {
  return {
    version: 1,
    discoverDataDirs: true,
    dataDirs: [],
    defaults: { command: "apiloopcodex", readyTimeoutMs: 30_000, placement: "new-tab" },
    presets: [],
  };
}

function text(value, label, { optional = false, max = 8192 } = {}) {
  if (typeof value !== "string" || (!optional && !value.trim()) || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    throw new Error(`${label} 无效 / invalid`);
  }
  return value;
}

function command(value, optional = false) {
  text(value, "启动命令", { optional });
  if (/[\r\n\t]/.test(value)) throw new Error("启动命令必须是单行 / command must be a single line");
  return value.trim();
}

export function validateConfig(input) {
  if (!input || input.version !== 1) throw new Error("不支持的配置版本 / unsupported config version");
  const defaults = { ...defaultConfig().defaults, ...input.defaults };
  defaults.command = command(defaults.command);
  if (!Number.isInteger(defaults.readyTimeoutMs) || defaults.readyTimeoutMs < 1000 || defaults.readyTimeoutMs > 300_000) {
    throw new Error("就绪超时需为 1000–300000 ms / invalid readiness timeout");
  }
  if (!["new-tab", "existing-tab", "new-workspace"].includes(defaults.placement)) throw new Error("无效的默认位置 / invalid placement");
  if (input.discoverDataDirs !== undefined && typeof input.discoverDataDirs !== "boolean") throw new Error("discoverDataDirs must be boolean");
  if (!Array.isArray(input.dataDirs) || !Array.isArray(input.presets)) throw new Error("dataDirs and presets must be arrays");
  const dataDirs = [...new Set(input.dataDirs.map(dir => expandPath(text(dir, "数据目录"))))];
  const ids = new Set();
  const presets = input.presets.map(preset => {
    const id = text(preset.id, "预设 ID", { max: 128 });
    if (ids.has(id)) throw new Error("重复预设 ID / duplicate preset ID");
    ids.add(id);
    const name = text(preset.name, "预设名称", { max: 200 });
    const cwd = expandPath(text(preset.cwd, "项目目录"));
    const override = command(preset.command ?? "", true);
    const prompt = preset.prompt?.kind === "text"
      ? { kind: "text", text: validatePrompt(preset.prompt.text) }
      : preset.prompt?.kind === "file"
        ? { kind: "file", path: text(preset.prompt.path, "Markdown 路径") }
        : null;
    if (!prompt) throw new Error("提示语类型必须为 text 或 file / invalid prompt source");
    if (prompt.kind === "file" && !/\.md$/i.test(prompt.path)) throw new Error("请选择 .md 文件 / use a .md file");
    const placement = { mode: defaults.placement, direction: "right", ...preset.placement };
    if (!["new-tab", "existing-tab", "new-workspace"].includes(placement.mode) || !["right", "down"].includes(placement.direction)) {
      throw new Error("无效的启动位置 / invalid placement");
    }
    for (const key of ["workspaceId", "tabId"]) {
      if (placement[key] != null) text(placement[key], key, { max: 128 });
    }
    return { id, name, cwd, command: override, prompt, placement };
  });
  return { version: 1, discoverDataDirs: input.discoverDataDirs ?? true, dataDirs, defaults, presets };
}

export function validatePrompt(value) {
  text(value, "首轮提示语", { max: MAX_PROMPT_BYTES });
  if (Buffer.byteLength(value) > MAX_PROMPT_BYTES) throw new Error("提示语超过 64 KiB / prompt exceeds 64 KiB");
  return value;
}

export async function resolvePrompt(preset) {
  if (preset.prompt.kind === "text") return validatePrompt(preset.prompt.text);
  const filename = expandPath(preset.prompt.path, preset.cwd);
  const info = await stat(filename);
  if (!info.isFile() || info.size > MAX_PROMPT_BYTES) throw new Error("Markdown 文件无效或超过 64 KiB / invalid Markdown file");
  return validatePrompt(await readFile(filename, "utf8"));
}

export async function atomicJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, filename);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}

export class ConfigStore {
  constructor(dir = pluginConfigDir()) {
    this.filename = dir ? path.join(dir, "config.json") : null;
  }
  async load() {
    if (!this.filename) return defaultConfig();
    try {
      return validateConfig(JSON.parse(await readFile(this.filename, "utf8")));
    } catch (error) {
      if (error.code === "ENOENT") return defaultConfig();
      throw new Error(`配置未加载，未覆盖原文件 / config not loaded: ${error.message}`);
    }
  }
  async save(config) {
    if (!this.filename) throw new Error("请从 Herdr 插件入口编辑配置 / open settings through Herdr");
    const validated = validateConfig(config);
    await atomicJson(this.filename, validated);
    return validated;
  }
}
