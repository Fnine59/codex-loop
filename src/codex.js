import { execFile, spawn } from "node:child_process";
import readline from "node:readline";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function buildCodexArgs(job) {
  const args = [
    "exec",
    "--json",
    "--sandbox",
    job.sandbox,
    "-C",
    job.cwd,
  ];

  if (job.sessionId) args.push("resume", job.sessionId, job.prompt);
  else args.push(job.prompt);
  return args;
}

export async function assertCodexAvailable(binary) {
  try {
    await execFileAsync(binary, ["--version"], { timeout: 5_000 });
  } catch {
    throw new Error(`Cannot run Codex CLI: ${binary}`);
  }
}

export function runCodex(job, { log = () => {}, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(job.codexBin, buildCodexArgs(job), {
      cwd: job.cwd,
      env: process.env,
      signal,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let sessionId = job.sessionId ?? null;
    let lastMessage = null;
    let stderrTail = "";
    let settled = false;

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      callback();
    };

    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      log(`stdout ${line}`);
      try {
        const event = JSON.parse(line);
        if (event.type === "thread.started" && event.thread_id) sessionId = event.thread_id;
        if (event.type === "item.completed" && event.item?.type === "agent_message") {
          lastMessage = event.item.text ?? null;
        }
      } catch {
        // Preserve non-JSON output in the log; Codex normally emits JSONL here.
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrTail = `${stderrTail}${text}`.slice(-4_000);
      for (const line of text.trimEnd().split("\n")) log(`stderr ${line}`);
    });

    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code, closeSignal) => {
      finish(() => {
        if (code === 0 && sessionId) resolve({ sessionId, lastMessage });
        else {
          reject(
            new Error(
              `Codex exited with ${code ?? closeSignal ?? "unknown"}${stderrTail ? `: ${stderrTail.trim()}` : ""}`,
            ),
          );
        }
      });
    });
  });
}
