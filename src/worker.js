import { createWriteStream } from "node:fs";
import path from "node:path";
import { runCodex } from "./codex.js";
import { createControlServer } from "./control.js";
import {
  completeJob,
  failJob,
  isTerminalStatus,
  naturalCompletionReason,
  terminateJob,
} from "./lifecycle.js";
import { getJob, storePaths, updateJob } from "./store.js";

export function nextScheduledTime(previous, interval, now) {
  let next = previous + interval;
  while (next <= now) next += interval;
  return next;
}

function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error("Stopped"));
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Stopped"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runWorker(id, home) {
  const controller = new AbortController();
  const stop = () => {
    if (!controller.signal.aborted) controller.abort(new Error("Worker stopped"));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const logFile = path.join(storePaths(home).logs, `${id}.log`);
  const stream = createWriteStream(logFile, { flags: "a", mode: 0o600 });
  const log = (message) => stream.write(`${new Date().toISOString()} ${message}\n`);
  let closeControl = null;
  let workerError = null;

  try {
    closeControl = await createControlServer(id, home, stop);
    await updateJob(
      id,
      (job) => {
        if (isTerminalStatus(job.status)) return job;
        return {
          ...job,
          status: job.status === "stopping" ? "stopping" : "waiting",
          pid: process.pid,
          workerStartedAt: job.workerStartedAt ?? Date.now(),
        };
      },
      home,
    );

    for (;;) {
      const job = await getJob(id, home);
      if (!job || isTerminalStatus(job.status) || job.status === "stopping" || controller.signal.aborted) break;

      const now = Date.now();
      const completionReason = naturalCompletionReason(job, now);
      if (completionReason) {
        await updateJob(
          id,
          (current) =>
            current.status === "stopping" ? current : completeJob(current, completionReason, now),
          home,
        );
        break;
      }
      if (job.nextRunAt > now) {
        await updateJob(
          id,
          (current) => (current.status === "stopping" ? current : { ...current, status: "waiting" }),
          home,
        );
        await wait(Math.min(job.nextRunAt, job.expiresAt) - now, controller.signal);
        continue;
      }

      const scheduledAt = job.nextRunAt;
      const runningJob = await updateJob(
        id,
        (current) =>
          current.status === "stopping" || isTerminalStatus(current.status)
            ? current
            : { ...current, status: "running", lastStartedAt: Date.now(), lastError: null },
        home,
      );
      if (runningJob.status !== "running") break;

      log(`run ${runningJob.runs + 1} started`);
      try {
        const result = await runCodex(runningJob, { log, signal: controller.signal });
        const completedAt = Date.now();
        await updateJob(
          id,
          (current) => {
            if (isTerminalStatus(current.status)) return current;
            const next = {
              ...current,
              sessionId: result.sessionId,
              lastMessage: result.lastMessage,
              lastCompletedAt: completedAt,
              runs: current.runs + 1,
              status: current.status === "stopping" ? "stopping" : "waiting",
            };
            if (next.status === "stopping") return next;
            const reason = naturalCompletionReason(next, completedAt);
            return reason
              ? completeJob(next, reason, completedAt)
              : {
                  ...next,
                  nextRunAt: nextScheduledTime(scheduledAt, current.intervalMs, completedAt),
                };
          },
          home,
        );
        log("run completed");
      } catch (error) {
        if (controller.signal.aborted) break;
        log(`run failed: ${error.message}`);
        await updateJob(
          id,
          (current) =>
            current.status === "stopping" || isTerminalStatus(current.status)
              ? current
              : failJob(current, error),
          home,
        );
        break;
      }
    }
  } catch (error) {
    workerError = error;
    if (!controller.signal.aborted) log(`worker failed: ${error.message}`);
  } finally {
    try {
      await updateJob(
        id,
        (job) => {
          let finalJob = job;
          if (job.status === "stopping" || (controller.signal.aborted && !isTerminalStatus(job.status))) {
            finalJob = terminateJob(job);
          } else if (workerError && !isTerminalStatus(job.status)) {
            finalJob = failJob(job, workerError);
          }
          return { ...finalJob, pid: null };
        },
        home,
      );
    } catch {
      // The job may have been removed externally.
    }
    if (closeControl) await closeControl();
    stream.end();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
