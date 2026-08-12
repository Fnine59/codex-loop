import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE_VERSION = 1;

export function defaultDataDir() {
  return process.env.PLUGIN_DATA || process.env.CODEX_LOOP_DATA_DIR || path.join(os.homedir(), ".codex-loop", "plugin-data");
}

function statePath(sessionId, dataDir) {
  const key = createHash("sha256").update(sessionId).digest("hex");
  return path.join(dataDir, "sessions", `${key}.json`);
}

export async function readLoopState(sessionId, dataDir = defaultDataDir()) {
  try {
    const parsed = JSON.parse(await fs.readFile(statePath(sessionId, dataDir), "utf8"));
    if (parsed.version !== STATE_VERSION || parsed.sessionId !== sessionId) {
      throw new Error("Unsupported or mismatched Codex Loop state.");
    }
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeLoopState(state, dataDir = defaultDataDir()) {
  const destination = statePath(state.sessionId, dataDir);
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify({ ...state, version: STATE_VERSION }, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
