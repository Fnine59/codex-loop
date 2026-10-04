import { readdir, realpath, stat, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expandPath } from "../settings/store.mjs";

// This is deliberately an independent reader: never import or execute Loop code.
export const ACTIVE_STATUSES = new Set(["waiting", "launching", "running"]);
const MAX_STATE_BYTES = 2 * 1024 * 1024;

export async function discoverDataDirs(config, { env = process.env, home = os.homedir() } = {}) {
  const roots = [...config.dataDirs];
  if (config.discoverDataDirs) {
    if (env.CODEX_LOOP_DATA_DIR) roots.push(expandPath(env.CODEX_LOOP_DATA_DIR, process.cwd(), home));
    roots.push(path.join(home, ".codex-loop", "plugin-data"));
    const codexHome = env.CODEX_HOME ? expandPath(env.CODEX_HOME, process.cwd(), home) : path.join(home, ".codex");
    const data = path.join(codexHome, "plugins", "data");
    try {
      for (const entry of await readdir(data, { withFileTypes: true })) {
        if (entry.isDirectory() && /^codex-loop(?:-|$)/.test(entry.name)) roots.push(path.join(data, entry.name));
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`无法发现 Loop 数据目录 / cannot discover data: ${error.message}`);
    }
  }
  // PLUGIN_DATA belongs to the invoking plugin, not necessarily Codex Loop.
  return [...new Set(roots.map(root => expandPath(root, process.cwd(), home)))];
}

function validateState(value) {
  if (value?.version !== 1) throw new Error("不支持的状态版本 / unsupported state version");
  for (const key of ["id", "sessionId", "status", "task"]) {
    if (typeof value[key] !== "string" || !value[key]) throw new Error(`invalid ${key}`);
  }
  if (!Number.isFinite(value.createdAt) || !Number.isInteger(value.runs) || value.runs < 0) throw new Error("invalid timestamps or runs");
  return value;
}

export async function scanLoops(roots) {
  const warnings = [];
  const sources = [];
  const filesSeen = new Set();
  const sessions = new Map();
  for (const root of roots) {
    let dir;
    let entries;
    try {
      dir = await realpath(path.join(root, "sessions"));
      entries = await readdir(dir, { withFileTypes: true });
      sources.push({ root, available: true });
    } catch (error) {
      sources.push({ root, available: false });
      if (error.code !== "ENOENT") warnings.push({ source: root, message: error.message });
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      const filename = path.join(dir, entry.name);
      if (filesSeen.has(filename)) continue;
      filesSeen.add(filename);
      try {
        const info = await stat(filename);
        if (info.size > MAX_STATE_BYTES) throw new Error("状态文件过大 / oversized state file");
        const state = validateState(JSON.parse(await readFile(filename, "utf8")));
        const record = { ...state, source: filename, updatedAt: info.mtimeMs };
        const previous = sessions.get(state.sessionId);
        // A session has one current record. Creation time wins over copying mtime.
        if (!previous || record.createdAt > previous.createdAt ||
            (record.createdAt === previous.createdAt && record.updatedAt > previous.updatedAt)) {
          sessions.set(state.sessionId, record);
        }
      } catch (error) {
        if (error.code !== "ENOENT") warnings.push({ source: filename, message: error.message });
      }
    }
  }
  const loops = [...sessions.values()].sort((a, b) => Number(ACTIVE_STATUSES.has(b.status)) - Number(ACTIVE_STATUSES.has(a.status)) || b.createdAt - a.createdAt);
  return { loops, warnings, sources };
}
