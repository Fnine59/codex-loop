#!/usr/bin/env node

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { assertCodexAvailable } from "./codex.js";
import { sendStop } from "./control.js";
import { formatDuration, parseDuration } from "./duration.js";
import {
  failJob,
  isTerminalStatus,
  requestTermination,
  terminateJob,
} from "./lifecycle.js";
import {
  createJob,
  defaultHome,
  getJob,
  listJobs,
  newJobId,
  storePaths,
  updateJob,
} from "./store.js";
import { runWorker } from "./worker.js";

const CLI_FILE = fileURLToPath(import.meta.url);
const MIN_INTERVAL = 60_000;

const HELP = `codex-loop

Usage:
  codex-loop start --every <duration> [options] -- <prompt>
  codex-loop list [--json]
  codex-loop stop <job-id>
  codex-loop open <job-id>

Options for start:
  --every <duration>       Interval such as 5m or 2h (minimum 1m)
  --cwd <directory>        Working directory (default: current directory)
  --sandbox <mode>         read-only or workspace-write (default: read-only)
  --for <duration>         Expire after this duration (default: 7d)
  --max-runs <count>       Stop after this many runs
  --codex <path>           Codex executable (default: codex)

The first run starts immediately. Use open after termination or completion to enter its TUI session.
`;

function fail(message) {
  console.error(`codex-loop: ${message}`);
  process.exitCode = 1;
}

function parsePositiveInteger(value, name) {
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

async function start(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      every: { type: "string" },
      cwd: { type: "string" },
      sandbox: { type: "string", default: "read-only" },
      for: { type: "string", default: "7d" },
      "max-runs": { type: "string" },
      codex: { type: "string", default: process.env.CODEX_LOOP_CODEX_BIN || "codex" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });

  if (values.help) return console.log(HELP);
  if (!values.every) throw new Error("--every is required.");
  if (!["read-only", "workspace-write"].includes(values.sandbox)) {
    throw new Error("--sandbox must be read-only or workspace-write.");
  }

  const prompt = positionals.join(" ").trim();
  if (!prompt) throw new Error("A prompt is required after --.");

  const cwd = await fs.realpath(path.resolve(values.cwd ?? process.cwd()));
  if (!(await fs.stat(cwd)).isDirectory()) throw new Error(`Not a directory: ${cwd}`);
  await assertCodexAvailable(values.codex);

  const now = Date.now();
  const home = defaultHome();
  const job = {
    id: newJobId(),
    status: "created",
    prompt,
    cwd,
    sandbox: values.sandbox,
    codexBin: values.codex,
    intervalMs: parseDuration(values.every, { min: MIN_INTERVAL }),
    createdAt: now,
    expiresAt: now + parseDuration(values.for, { min: MIN_INTERVAL }),
    nextRunAt: now,
    maxRuns: parsePositiveInteger(values["max-runs"], "--max-runs"),
    runs: 0,
    pid: null,
    sessionId: null,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastMessage: null,
    lastError: null,
    workerStartedAt: null,
    terminationRequestedAt: null,
    endedAt: null,
    endReason: null,
  };

  await createJob(job, home);

  let worker;
  try {
    worker = spawn(process.execPath, [CLI_FILE, "_worker", job.id], {
      cwd,
      detached: true,
      env: { ...process.env, CODEX_LOOP_HOME: home },
      stdio: "ignore",
    });
    await new Promise((resolve, reject) => {
      worker.once("spawn", resolve);
      worker.once("error", reject);
    });
    worker.unref();
  } catch (error) {
    await updateJob(
      job.id,
      (current) => failJob(current, error),
      home,
    );
    throw error;
  }

  console.log(`Created ${job.id} every ${formatDuration(job.intervalMs)}`);
  console.log(`Log: ${path.join(storePaths(home).logs, `${job.id}.log`)}`);
}

function displayTime(value) {
  return value ? new Date(value).toLocaleString() : "-";
}

async function list(args) {
  const { values } = parseArgs({
    args,
    options: { json: { type: "boolean" } },
    strict: true,
  });
  const jobs = (await listJobs()).sort((left, right) => right.createdAt - left.createdAt);
  if (values.json) return console.log(JSON.stringify(jobs, null, 2));
  if (jobs.length === 0) return console.log("No loop jobs.");

  console.log("ID       STATUS     EVERY  RUNS  NEXT                 PROMPT");
  for (const job of jobs) {
    const prompt = job.prompt.replaceAll(/\s+/g, " ").slice(0, 50);
    console.log(
      `${job.id.padEnd(8)} ${job.status.padEnd(10)} ${formatDuration(job.intervalMs).padEnd(6)} ${String(job.runs).padEnd(5)} ${displayTime(job.nextRunAt).padEnd(20)} ${prompt}`,
    );
  }
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function stop(args) {
  const id = args[0];
  if (!id) throw new Error("A job ID is required.");
  const job = await getJob(id);
  if (!job) throw new Error(`Unknown job: ${id}`);
  if (isTerminalStatus(job.status)) {
    console.log(`${id} is already ${job.status}`);
    return;
  }

  await updateJob(id, (current) => requestTermination(current));

  const signalDeadline = Date.now() + 2_000;
  while (Date.now() < signalDeadline) {
    try {
      await sendStop(id, defaultHome(), 250);
      break;
    } catch {
      await delay(50);
    }
  }

  const terminalDeadline = Date.now() + 5_000;
  let current = await getJob(id);
  while (!isTerminalStatus(current.status) && Date.now() < terminalDeadline) {
    await delay(50);
    current = await getJob(id);
  }

  if (!isTerminalStatus(current.status) && current.pid === null) {
    current = await updateJob(id, (latest) =>
      latest.status === "stopping" ? terminateJob(latest) : latest,
    );
  }
  if (current.status === "completed" || current.status === "failed") {
    console.log(`${id} ended as ${current.status} before termination completed`);
    return;
  }
  if (current.status !== "terminated") {
    throw new Error(`Termination was requested, but the loop is still ${current.status}.`);
  }
  console.log(`Terminated ${id}`);
}

async function open(args) {
  const id = args[0];
  if (!id) throw new Error("A job ID is required.");
  const job = await getJob(id);
  if (!job) throw new Error(`Unknown job: ${id}`);
  if (!isTerminalStatus(job.status)) {
    throw new Error(`Loop ${id} is ${job.status}; terminate it before opening the session in TUI.`);
  }
  if (!job.sessionId) throw new Error(`Loop ${id} has no Codex session to open.`);

  const child = spawn(
    job.codexBin,
    ["resume", "-C", job.cwd, "-s", job.sandbox, job.sessionId],
    { cwd: job.cwd, env: process.env, stdio: "inherit" },
  );
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (exitCode !== 0) throw new Error(`Codex TUI exited with code ${exitCode}.`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    return;
  }

  if (command === "start") await start(args);
  else if (command === "list") await list(args);
  else if (command === "stop") await stop(args);
  else if (command === "open") await open(args);
  else if (command === "_worker") await runWorker(args[0], defaultHome());
  else throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => fail(error.message));
