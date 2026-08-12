---
name: loop
description: Start, continue, complete, or stop repeated work inside the current Codex conversation. Use when the user asks Codex to loop, repeat a task at an interval, keep checking or testing until a condition is met, or stop an active Codex loop.
---

# Codex Loop

Keep the loop in the current conversation. Do not start `codex exec`, a daemon, cron, an App Server, a second session, or a background worker.

## Start

1. Extract the interval, task, optional completion condition, and optional bounds from the request.
2. Resolve `../../scripts/loopctl.mjs` relative to this `SKILL.md` file.
3. Run:

```bash
node <resolved-loopctl-path> start --every <duration> [--max-runs <count>] [--for <duration>] [--until <condition>] [--now] -- <task>
```

Use `--for 24h` when the user gives no `--for` or `--max-runs` bound. Do not use `--now` unless the user asks for an immediate first run.

The command prints one HTML-comment marker. Reproduce that marker exactly once in the final assistant response. Keep the visible response concise. The Stop hook binds the marker to this exact Codex conversation and schedules the first run.

## Continue

A continuation prompt beginning with `[Codex Loop` is an active loop run. Perform exactly one pass of its task in the current working directory.

- If the completion condition is definitely satisfied, include the exact completion marker supplied by the continuation prompt in the final response.
- Otherwise, finish normally. The Stop hook schedules the next pass.
- Do not invoke `start` again during a continuation.

## Stop

When the user asks to stop or cancel the current loop, resolve the helper as above and run:

```bash
node <resolved-loopctl-path> stop
```

Reproduce its marker exactly once in the final response. Stopping is idempotent. While the hook is waiting and the TUI has no input prompt, `Ctrl-C` immediately terminates the loop.

## Lifecycle

The hook owns these transitions:

```text
created -> waiting -> running -> waiting
                      |          |
                      +-> completed
                      +-> terminated
                      +-> failed
```

Never claim a loop is active unless the start-marker command succeeded.
