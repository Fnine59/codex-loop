[中文](#中文) | [English](#english)

# 中文

`codex-loop` 按固定间隔重复执行 Prompt，并在后续运行中恢复同一个 Codex session。

## 要求

- Node.js 20+
- 已安装并登录 Codex CLI
- 目标目录是 Git 仓库

## 安装

```bash
npm link
```

## 使用

```bash
# 只读检查；第一轮立即执行
codex-loop start --every 5m -- "检查当前 PR 的 CI 状态"

# 允许修改工作区
codex-loop start --every 10m --sandbox workspace-write --max-runs 12 -- \
  "检查 CI；如果失败，定位原因并做最小修复"

codex-loop list
codex-loop stop <job-id>
codex-loop open <job-id>
```

任务默认 7 天后过期。状态保存在 `~/.codex-loop/jobs.json`，日志位于 `~/.codex-loop/logs/`。

## 生命周期与 TUI

`created → running ↔ waiting → completed`；主动终止走 `stopping → terminated`；异常进入 `failed`。

后台 worker 持有生命周期，因此它不是一个持续运行的 Skill。`stop` 会中断当前 Codex 子进程并等待 `terminated` 确认。Loop 活跃时不允许 TUI 同时占用该 session；终止或自然结束后，使用 `codex-loop open <job-id>` 进入对应 Codex TUI。

实现基于官方支持的 `codex exec --json` 和 `codex exec resume <SESSION_ID>`。

# English

`codex-loop` runs a prompt at a fixed interval and resumes the same Codex session on later runs.

## Requirements

- Node.js 20+
- Codex CLI installed and authenticated
- A Git repository as the working directory

## Install

```bash
npm link
```

## Usage

```bash
# Read-only checks; the first run starts immediately
codex-loop start --every 5m -- "Check the current PR CI status"

# Allow workspace changes
codex-loop start --every 10m --sandbox workspace-write --max-runs 12 -- \
  "Check CI; if it fails, diagnose it and apply the smallest fix"

codex-loop list
codex-loop stop <job-id>
codex-loop open <job-id>
```

Jobs expire after seven days by default. State is stored in `~/.codex-loop/jobs.json`; logs are stored in `~/.codex-loop/logs/`.

## Lifecycle and TUI

`created → running ↔ waiting → completed`; requested termination uses `stopping → terminated`; errors enter `failed`.

A background worker owns the lifecycle, so this is not a long-running Skill. `stop` interrupts the active Codex child process and waits for confirmed `terminated` state. The TUI cannot concurrently own an active loop session; after termination or natural completion, run `codex-loop open <job-id>` to enter that Codex TUI session.

The implementation uses the officially supported `codex exec --json` and `codex exec resume <SESSION_ID>` interfaces.
