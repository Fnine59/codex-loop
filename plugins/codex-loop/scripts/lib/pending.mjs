import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateStartConfig } from "./markers.mjs";

const MAX_PENDING_AGE_MS = 24 * 60 * 60 * 1_000;

export function defaultPendingDir() {
  const userScope = typeof process.getuid === "function" ? String(process.getuid()) : os.userInfo().username;
  return process.env.CODEX_LOOP_PENDING_DIR || path.join(os.tmpdir(), "codex-loop", userScope, "pending");
}

function pendingPath(id, pendingDir) {
  if (!/^[a-f0-9]{12}$/.test(id ?? "")) throw new Error("Invalid pending loop ID.");
  return path.join(pendingDir, `${id}.json`);
}

async function cleanStalePending(pendingDir, now = Date.now()) {
  let entries;
  try {
    entries = await fs.readdir(pendingDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const file = path.join(pendingDir, entry.name);
        const stat = await fs.stat(file);
        if (now - stat.mtimeMs > MAX_PENDING_AGE_MS) await fs.rm(file, { force: true });
      }),
  );
}

export async function writePendingConfig(config, pendingDir = defaultPendingDir()) {
  validateStartConfig(config);
  await fs.mkdir(pendingDir, { recursive: true, mode: 0o700 });
  await cleanStalePending(pendingDir);
  const destination = pendingPath(config.id, pendingDir);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(config)}\n`, { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function takePendingConfig(id, pendingDir = defaultPendingDir()) {
  const file = pendingPath(id, pendingDir);
  try {
    const config = validateStartConfig(JSON.parse(await fs.readFile(file, "utf8")));
    if (config.id !== id) throw new Error("Pending loop ID mismatch.");
    return config;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  } finally {
    await fs.rm(file, { force: true });
  }
}
