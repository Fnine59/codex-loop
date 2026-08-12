[中文](#中文) | [English](#english)

# 中文

`codex-loop` 是一个 Codex Plugin，让 Codex 在当前 TUI 对话中按间隔重复工作，直到条件满足、达到边界或被人工终止。

它不启动 cron、daemon、App Server、`codex exec` 或第二个会话。同步 `Stop Hook` 在等待结束后，把下一轮提示精准送回启动 Loop 的同一个对话。

## 要求

- Node.js 20+
- 支持 Plugins 与 Hooks 的 Codex CLI

## 本地安装

在仓库根目录执行：

```bash
codex plugin marketplace add "$PWD"
codex plugin add codex-loop@personal
```

然后启动 Codex TUI：

1. 输入 `/hooks`，检查并信任 `codex-loop` 的 Stop Hook。
2. 新建一个 Codex 会话，让 Skill 和 Hook 生效。

## 使用

直接在正常对话里说：

```text
每 5 分钟运行一次测试，直到测试通过。

立即执行第一轮，然后每 10 分钟检查 CI，最多执行 12 次。

停止当前 Loop。
```

默认第一轮在一个间隔后执行；明确要求“立即执行”时，第一轮会立刻开始。用户没有提供次数或时长边界时，Skill 默认限制为 24 小时。

## 生命周期

```text
created -> waiting -> running -> waiting
                      |          |
                      +-> completed
                      +-> terminated
                      +-> failed
```

- 条件满足、达到最大次数或到期：`completed`
- 用户要求停止或等待时按 `Ctrl-C`：`terminated`
- Hook 异常：停止续轮并在当前界面报告错误

等待期间当前 TUI 不接受新输入；Codex 进程和电脑需要保持运行。Loop 状态按 Codex session 隔离并保存在 Plugin 的可写数据目录。

## 开发检查

```bash
npm run check
uv run --with pyyaml python ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/codex-loop
```

# English

`codex-loop` is a Codex plugin that repeats work at an interval inside the current TUI conversation until a condition is met, a bound is reached, or the user interrupts it.

It starts no cron job, daemon, App Server, `codex exec` process, or secondary session. A synchronous `Stop` hook waits and then sends the next prompt back to the exact conversation that started the loop.

## Requirements

- Node.js 20+
- A Codex CLI release with Plugins and Hooks support

## Local installation

Run from the repository root:

```bash
codex plugin marketplace add "$PWD"
codex plugin add codex-loop@personal
```

Then start the Codex TUI:

1. Enter `/hooks`, review the `codex-loop` Stop hook, and trust it.
2. Start a new Codex session so the Skill and Hook are loaded.

## Usage

Use natural language in a normal conversation:

```text
Run the tests every 5 minutes until they pass.

Run once now, then check CI every 10 minutes, at most 12 times.

Stop the current loop.
```

The first run normally starts after one interval. Ask for an immediate run to start it now. If the user supplies neither a run-count nor lifetime bound, the Skill defaults to 24 hours.

## Lifecycle

```text
created -> waiting -> running -> waiting
                      |          |
                      +-> completed
                      +-> terminated
                      +-> failed
```

- Condition met, maximum runs reached, or expiry: `completed`
- Explicit stop or `Ctrl-C` while waiting: `terminated`
- Hook error: continuation stops and the current UI reports the error

The current TUI does not accept input while waiting; the Codex process and computer must remain running. Loop state is isolated by Codex session and stored in the plugin's writable data directory.

## Development checks

```bash
npm run check
uv run --with pyyaml python ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/codex-loop
```
