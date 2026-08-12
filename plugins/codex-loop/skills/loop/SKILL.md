---
name: loop
description: Start, continue, complete, or stop repeated work inside the current Codex conversation. Use when the user asks Codex to loop, repeat a task at an interval or Cron schedule, keep checking or testing until a condition is met, or stop an active Codex loop.
---

# Codex Loop

Keep every run in the current conversation. The hook automatically selects the App Server backend when the current thread is attached to it and otherwise uses the synchronous Stop-hook backend. Do not start `codex exec`, a second session, a system Cron job, or a custom daemon.

## Start

1. Extract the schedule, task, optional completion condition, and optional bounds from the request.
2. Resolve `../../scripts/loopctl.mjs` relative to this `SKILL.md` file.
3. Run one of these forms:

```bash
node <resolved-loopctl-path> start [--max-runs <count>] [--for <duration> | --until-stopped] [--until <condition>] -- <task>
node <resolved-loopctl-path> start --every <duration> [--max-runs <count>] [--for <duration> | --until-stopped] [--until <condition>] [--now] -- <task>
node <resolved-loopctl-path> start --cron <five-field-expression> [--max-runs <count>] [--for <duration> | --until-stopped] [--until <condition>] [--now] -- <task>
```

- Normalize natural-language durations to `s`, `m`, `h`, or `d`; for example, “持续 3 天” becomes `--for 3d`.
- Map `every N seconds/minutes/hours/days` and equivalent wording to `--every`. The helper converts it to a clean wall-clock Cron cadence. Cron resolution is one minute, so sub-minute input is rounded and reported by the helper.
- Map an explicit five-field Cron expression or an unambiguous wall-clock schedule such as “工作日 9 点” to `--cron`. Use numeric fields only and quote the complete expression as one argument. Never call the operating system's `crontab` command.
- If the user gives no schedule, omit both `--every` and `--cron`. Adaptive mode starts immediately; after each pass Codex chooses a delay from 1 minute to 1 hour using the exact next-delay marker supplied by the hook. A missing, malformed, out-of-range, or wrong-loop marker falls back to 30 minutes.
- Map “直到我说停止”, “一直运行”, “不要自动结束”, “until I stop”, or equivalent explicit manual-stop wording to `--until-stopped`. Do not add `--for`, `--max-runs`, or `--until` in that mode.
- If the user supplies no lifetime, run count, completion condition, or manual-stop wording, accept the helper's 24-hour default.
- For a fixed or Cron schedule, use `--now` only when the user asks for an immediate first run. Adaptive loops always run their first pass immediately.

The command prints one HTML-comment start marker. Reproduce that marker exactly once in the final assistant response. Keep visible text concise. The Stop hook binds the marker to this Codex conversation, detects its runtime once, and schedules the first run.

## Continue

A prompt beginning with `[Codex Loop` is one active loop pass. Perform exactly one pass in the current working directory.

- If the supplied completion condition is definitely satisfied, include the exact completion marker from the prompt.
- Otherwise follow the prompt's scheduling instruction. Adaptive loops include exactly one valid next-delay marker. Fixed and Cron loops finish normally without a scheduling marker.
- Do not invoke `start` again during a continuation.
- Do not backfill multiple missed Cron ticks. The runtime queues at most one catch-up pass.

## Stop

When the user asks to stop or cancel the current loop, resolve the helper as above and run:

```bash
node <resolved-loopctl-path> stop
```

Reproduce its marker exactly once in the final response. Stopping is idempotent. In synchronous mode, `Ctrl-C` while the hook waits terminates the loop. In App Server mode, use the stop request for a reliable cancellation while the TUI remains interactive; interrupting an active loop turn also terminates it when App Server reports that turn as interrupted.

## Lifecycle

The runtime owns these transitions:

```text
created -> waiting -> launching -> running -> waiting
                                  |          |
                                  +-> completed
                                  +-> terminated
                                  +-> failed
```

Never claim a loop is active unless the start-marker command succeeded.
