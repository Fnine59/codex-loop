export const TERMINAL_STATUSES = new Set(["completed", "terminated", "failed"]);

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

export function requestTermination(job, now = Date.now()) {
  if (isTerminalStatus(job.status) || job.status === "stopping") return job;
  return {
    ...job,
    status: "stopping",
    terminationRequestedAt: now,
    nextRunAt: null,
  };
}

export function terminateJob(job, now = Date.now()) {
  return {
    ...job,
    status: "terminated",
    endedAt: now,
    endReason: "requested",
    nextRunAt: null,
    pid: null,
  };
}

export function completeJob(job, reason, now = Date.now()) {
  return {
    ...job,
    status: "completed",
    endedAt: now,
    endReason: reason,
    nextRunAt: null,
  };
}

export function failJob(job, error, now = Date.now()) {
  return {
    ...job,
    status: "failed",
    endedAt: now,
    endReason: "error",
    nextRunAt: null,
    lastError: error instanceof Error ? error.message : String(error),
  };
}

export function naturalCompletionReason(job, now = Date.now()) {
  if (job.maxRuns && job.runs >= job.maxRuns) return "max-runs";
  if (now >= job.expiresAt) return "expired";
  return null;
}
