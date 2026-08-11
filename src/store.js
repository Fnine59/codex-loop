import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE_VERSION = 1;

export function defaultHome() {
  return process.env.CODEX_LOOP_HOME || path.join(os.homedir(), ".codex-loop");
}

export function storePaths(home = defaultHome()) {
  return {
    home,
    state: path.join(home, "jobs.json"),
    lock: path.join(home, "jobs.lock"),
    logs: path.join(home, "logs"),
    control: path.join(home, "control"),
  };
}

export async function ensureStore(home = defaultHome()) {
  const paths = storePaths(home);
  await Promise.all([
    fs.mkdir(paths.logs, { recursive: true, mode: 0o700 }),
    fs.mkdir(paths.control, { recursive: true, mode: 0o700 }),
  ]);
  return paths;
}

async function readStateUnlocked(home) {
  const { state } = storePaths(home);
  try {
    const parsed = JSON.parse(await fs.readFile(state, "utf8"));
    if (parsed.version !== STATE_VERSION || !Array.isArray(parsed.jobs)) {
      throw new Error(`Unsupported state file: ${state}`);
    }
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") return { version: STATE_VERSION, jobs: [] };
    throw error;
  }
}

async function writeStateUnlocked(home, state) {
  const paths = await ensureStore(home);
  const temporary = `${paths.state}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, paths.state);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function withLock(home, callback) {
  const paths = await ensureStore(home);
  let handle;

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      handle = await fs.open(paths.lock, "wx", 0o600);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const stat = await fs.stat(paths.lock);
        if (Date.now() - stat.mtimeMs > 30_000) await fs.rm(paths.lock, { force: true });
      } catch (statError) {
        if (statError.code !== "ENOENT") throw statError;
      }
      await delay(40);
    }
  }

  if (!handle) throw new Error("Timed out waiting for the job store lock.");

  try {
    return await callback();
  } finally {
    await handle.close();
    await fs.rm(paths.lock, { force: true });
  }
}

export async function listJobs(home = defaultHome()) {
  return (await readStateUnlocked(home)).jobs;
}

export async function getJob(id, home = defaultHome()) {
  return (await listJobs(home)).find((job) => job.id === id) ?? null;
}

export async function createJob(job, home = defaultHome()) {
  return withLock(home, async () => {
    const state = await readStateUnlocked(home);
    if (state.jobs.some((existing) => existing.id === job.id)) {
      throw new Error(`Job already exists: ${job.id}`);
    }
    state.jobs.push(job);
    await writeStateUnlocked(home, state);
    return job;
  });
}

export async function updateJob(id, updater, home = defaultHome()) {
  return withLock(home, async () => {
    const state = await readStateUnlocked(home);
    const index = state.jobs.findIndex((job) => job.id === id);
    if (index < 0) throw new Error(`Unknown job: ${id}`);
    state.jobs[index] = updater({ ...state.jobs[index] });
    await writeStateUnlocked(home, state);
    return state.jobs[index];
  });
}

export function newJobId() {
  return randomUUID().replaceAll("-", "").slice(0, 8);
}
