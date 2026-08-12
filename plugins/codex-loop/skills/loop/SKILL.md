---
name: loop
description: Start, continue, complete, or stop repeated work inside the current Codex conversation. Use when the user asks Codex to loop, repeat a task at an interval, keep checking or testing until a condition is met, or stop an active Codex loop.
---

# Codex Loop

Keep the loop in the current conversation. Do not start `codex exec`, a daemon, cron, an App Server, a second session, or a background worker.

## Start

1. Extract the interval, task, optional completion condition, and optional bounds from the request. Normalize natural-language durations to `s`, `m`, `h`, or `d`; for example, “持续 3 天” becomes `--for 3d`.
2. Resolve `../../scripts/loopctl.mjs` relative to this `SKILL.md` file.
3. Run:

```bash
node <resolved-loopctl-path> start --every <duration> [--max-runs <count>] [--for <duration> | --until-stopped] [--until <condition>] [--now] -- <task>
```

- Map an explicit lifetime such as “持续 2 小时” or “for 3 days” to `--for 2h` or `--for 3d`.
- Map “直到我说停止”, “一直运行”, “不要自动结束”, “until I stop”, or equivalent explicit manual-stop wording to `--until-stopped`. Do not add `--for`, `--max-runs`, or `--until`; only an explicit stop, `Ctrl-C`, or ending the Codex process may end this mode.
- If the user supplies no lifetime, run-count, completion condition, or manual-stop wording, omit the bound and accept the helper's 24-hour default.
- Do not use `--now` unless the user asks for an immediate first run.

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

Reproduce its marker exactly once in the final response. Stopping is idempotent. While the hook is waiting and the TUI has no input prompt, `Ctrl-C` immediately terminates the loop. If `Ctrl-C` interrupts an active model pass, the loop cannot resume on a later turn and is finalized when that turn or session closes.

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
