[中文](#中文) | [English](#english)

# 中文

`codex-loop` 是一个 Codex Plugin，让 Codex 在同一个对话里按计划重复工作，直到条件满足、达到边界或被人工终止。

同一次插件安装提供两种运行模式：

| 启动方式 | 运行后端 | 等待期间的 TUI |
| --- | --- | --- |
| `codex` | 同步 Stop Hook | 被当前 Loop 占用，兼容模式 |
| `loop-codex` | 官方 Codex App Server | 仍可正常对话，推荐模式 |

插件只在启动 Loop 时检测一次当前会话属于哪种后端。App Server 模式会把下一轮准确送回同一个 thread；普通模式自动回落到同步 Stop Hook。它不会创建系统 crontab、运行 `codex exec`、开启第二个会话或安装自定义常驻服务。

## 要求

- Node.js 20+
- 支持 Plugins 与 Hooks 的 Codex CLI
- 推荐模式还要求 CLI 支持 `codex app-server daemon` 和 `codex --remote unix://`

## 安装插件

在终端执行：

```bash
codex plugin marketplace add Fnine59/codex-loop
codex plugin add codex-loop@fnine59
```

然后启动一个新的 Codex 会话，输入 `/hooks`，检查并信任 `codex-loop` 的 Stop Hook。

## 添加 `loop-codex` alias

把下面一行放到 `~/.zshrc` 或 `~/.bashrc`，位置放在你已有的 `codex` alias/function 之后：

```bash
alias loop-codex='codex app-server daemon start >/dev/null && codex --remote unix://'
```

重新打开终端，或执行 `source ~/.zshrc`，然后像平时一样启动：

```bash
loop-codex
loop-codex --model gpt-5.6
```

这不是 wrapper bin，也不会覆盖 `codex`。alias 内部仍调用你的 `codex`，调用 `loop-codex` 时附加的参数也会原样交给远程 TUI。官方 App Server daemon 已运行时，`daemon start` 是幂等的。

App Server 接口目前仍属于 Codex 的实验性能力。如果当前 CLI 不支持它，继续使用普通 `codex` 即可，Loop 功能仍能工作，只是等待期间 TUI 会被占用。单次等待接近或超过 7 天的 Cron 计划必须使用 `loop-codex`，避免超过同步 Hook 的超时上限。

## 使用

直接在正常对话里说：

```text
每 5 分钟运行一次测试，直到测试通过。

立即执行第一轮，然后每 10 分钟检查 CI，最多执行 12 次。

每 30 秒输出一次状态，持续 3 天。

每天上午 9 点检查一次报告。

工作日 9 点按 Cron 0 9 * * 1-5 执行，持续 7 天。

检查 CI 状态并处理问题，根据每轮结果自行决定多久后再检查。

每分钟检查一次服务，直到我说停止，不要自动结束。

停止当前 Loop。
```

### 调度语义

- 未指定间隔：动态模式立即执行第一轮；之后 Codex 每轮在 1 分钟到 1 小时之间选择下一次等待时间，无有效选择时回落到 30 分钟。
- `每 N 分钟/小时`：转换成五字段 Cron，按本机时区的墙上时钟边界运行，而不是从上一轮结束时重新计时。
- Cron 最小粒度为 1 分钟。`每 30 秒` 会明确归一成 `每 1 分钟`；不能被标准 Cron 精确表达的间隔会归一到最近的干净节奏，并显示实际节奏与表达式。
- 也支持标准五字段数字 Cron：`分钟 小时 日 月 星期`。不支持秒字段，也不会写入系统 crontab。
- 固定调度的第一轮默认等到下一个匹配时间；明确要求“立即执行”时先立即跑一轮。
- 一轮尚未结束时若跨过多个计划时间，只排队补一轮，不逐个回填错过的 tick。
- 没有结束边界时默认最多运行 24 小时；“直到我说停止”不会自动到期，也不会因为单轮任务完成而自动结束。

## 生命周期与资源

```text
created -> waiting -> running -> waiting
                      |          |
                      +-> completed
                      +-> terminated
                      +-> failed
```

- 条件满足、达到最大次数或到期：`completed`
- 用户要求停止、当前续轮被中断或会话结束：`terminated`
- App Server、Hook 或唤醒失败：`failed`

兼容模式由同步 Stop Hook 等待；`Ctrl-C` 可终止等待。推荐模式使用官方 Codex App Server daemon，并为当前 Loop 保留一个休眠中的一次性 Node 唤醒进程；每次唤醒后该进程退出。没有操作系统 Cron 或本项目自己的常驻 daemon。电脑、App Server 与当前会话必须保持运行。

Loop 状态按 Codex session 隔离，保存在 Plugin 的可写数据目录。若同时还运行着 Desktop 或其他 App Server，插件只匹配当前 `session_id`/`turn_id`，不会接管无关会话。

## 开发检查

```bash
npm run check
uv run --with pyyaml python ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/codex-loop
```

# English

`codex-loop` is a Codex plugin that repeats work on a schedule in the same conversation until a condition is met, a bound is reached, or the user stops it.

One plugin installation provides two runtime modes:

| Launch command | Runtime | TUI while waiting |
| --- | --- | --- |
| `codex` | Synchronous Stop hook | Occupied by the loop; compatibility mode |
| `loop-codex` | Official Codex App Server | Remains interactive; recommended mode |

The plugin detects the current conversation's runtime once, when a loop starts. App Server mode sends every wake-up back to the exact same thread; ordinary sessions automatically fall back to the synchronous Stop hook. It creates no system crontab entry, runs no `codex exec`, opens no second session, and installs no custom persistent service.

## Requirements

- Node.js 20+
- A Codex CLI release with Plugins and Hooks support
- Recommended mode also requires `codex app-server daemon` and `codex --remote unix://`

## Install the plugin

Run in a terminal:

```bash
codex plugin marketplace add Fnine59/codex-loop
codex plugin add codex-loop@fnine59
```

Start a new Codex session, enter `/hooks`, and review and trust the `codex-loop` Stop hook.

## Add the `loop-codex` alias

Put this line in `~/.zshrc` or `~/.bashrc`, after any existing `codex` alias or function:

```bash
alias loop-codex='codex app-server daemon start >/dev/null && codex --remote unix://'
```

Open a new terminal, or run `source ~/.zshrc`, then launch it like ordinary Codex:

```bash
loop-codex
loop-codex --model gpt-5.6
```

This is not a wrapper binary and it does not replace `codex`. The alias still invokes your existing `codex` command, and arguments passed to `loop-codex` are forwarded unchanged to the remote TUI. `daemon start` is idempotent when the official App Server daemon is already running.

App Server remains an experimental Codex capability. If the current CLI does not support it, use ordinary `codex`; loops still work, but the TUI is occupied while the Stop hook waits. Cron schedules whose next wait approaches or exceeds seven days require `loop-codex` so they do not exceed the synchronous hook timeout.

## Usage

Use natural language in a normal conversation:

```text
Run the tests every 5 minutes until they pass.

Run once now, then check CI every 10 minutes, at most 12 times.

Print a status update every 30 seconds for 3 days.

Check the report every day at 9 AM.

On weekdays at 9 AM, use Cron 0 9 * * 1-5 for 7 days.

Check CI and address problems, choosing when to check again after each pass.

Check the service every minute until I say stop; do not expire automatically.

Stop the current loop.
```

### Scheduling semantics

- No interval: adaptive mode runs the first pass immediately. Codex then chooses each delay from 1 minute to 1 hour; a missing or invalid choice falls back to 30 minutes.
- `Every N minutes/hours`: converted to five-field Cron and aligned to local wall-clock boundaries, rather than measured from the end of the previous pass.
- Cron resolution is one minute. `Every 30 seconds` is explicitly normalized to `every 1 minute`. Intervals that standard Cron cannot express exactly are normalized to the closest clean cadence, and the actual cadence and expression are shown.
- Standard numeric five-field Cron is also supported: `minute hour day month weekday`. There is no seconds field and no system crontab entry.
- A fixed schedule normally starts at the next matching time; ask for an immediate run to run once now.
- If several scheduled times pass while one run is active, exactly one catch-up pass is queued; missed ticks are not backfilled individually.
- With no ending bound, a loop defaults to 24 hours. An explicit “until I say stop” request has no expiry and does not auto-complete after one successful pass.

## Lifecycle and resources

```text
created -> waiting -> running -> waiting
                      |          |
                      +-> completed
                      +-> terminated
                      +-> failed
```

- Condition met, maximum runs reached, or expiry: `completed`
- Explicit stop, interrupted continuation, or session end: `terminated`
- App Server, hook, or wake-up failure: `failed`

Compatibility mode waits inside the synchronous Stop hook; `Ctrl-C` terminates that wait. Recommended mode uses the official Codex App Server daemon and keeps one sleeping, one-shot Node wake process for the current loop; that process exits after each wake-up. There is no operating-system Cron job and no persistent daemon owned by this project. The computer, App Server, and current session must remain running.

Loop state is isolated by Codex session and stored in the plugin's writable data directory. If Desktop or another App Server is also running, the plugin matches the current `session_id`/`turn_id` only and will not attach to an unrelated conversation.

## Development checks

```bash
npm run check
uv run --with pyyaml python ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/codex-loop
```
