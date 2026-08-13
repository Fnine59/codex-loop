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
- 推荐模式还要求 CLI 支持 `codex app-server --listen` 和 `codex --remote unix://`；只安装 Plugin 的共享 daemon 方案还需要 `codex app-server daemon`

## 在另一台设备快速开始

如果你会拉取本仓库，推荐直接使用仓库内经过测试的启动器：

```bash
git clone https://github.com/Fnine59/codex-loop.git
cd codex-loop
npm run check

codex plugin marketplace add "$PWD"
codex plugin add codex-loop@fnine59

./bin/loop-codex
```

仓库已存在时，先执行 `git switch main && git pull --ff-only`，然后重新运行 `codex plugin add codex-loop@fnine59`。进入 Codex 后输入 `/hooks`，检查并信任 `codex-loop` 的 Stop Hook；若刚完成信任，重新打开一次 `./bin/loop-codex` 会话。

`bin/loop-codex` 会为当前 TUI 创建独立 App Server，退出时清理，并把所有参数原样传给 Codex：

```bash
./bin/loop-codex --model gpt-5.6
./bin/loop-codex --dangerously-bypass-approvals-and-sandbox
```

如需在任意目录调用，可把它链接到已有的 `PATH` 目录；链接指向仓库后，以后 `git pull` 即可同步启动器更新：

```bash
mkdir -p "$HOME/.local/bin"
ln -s "$PWD/bin/loop-codex" "$HOME/.local/bin/loop-codex"
```

## 只安装 Plugin

不拉取仓库时，可以直接安装远端 `main`：

```bash
codex plugin marketplace add Fnine59/codex-loop --ref main
codex plugin add codex-loop@fnine59
```

然后在 `~/.zshrc` 或 `~/.bashrc` 中添加下面的函数，重新打开终端：

```bash
loop-codex() {
    command codex app-server daemon start >/dev/null || return
    command codex --remote unix:// "$@"
}
```

### 给人类和 Agent 的启动提醒

优先复用 `bin/loop-codex` 或上面的官方 daemon 启动方式，不要临时重写一份自定义启动器。若确实需要使用 `codex app-server --listen unix://...`，必须在启动 App Server **之前**导出 `CODEX_LOOP_APP_SERVER_SOCKET`。Stop Hook 由 App Server 创建；只把变量传给远程 TUI 会导致插件找不到 Socket，并静默回退到同步 Stop Hook。

启动 App Server 进程本身不代表异步模式已经生效。Loop 启动后应看到 `active through App Server`，其状态应满足 `backend: "app-server"`、`threadId` 非空且 `lastError: null`。

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

兼容模式由同步 Stop Hook 等待；`Ctrl-C` 可终止等待。推荐模式使用官方 Codex App Server：仓库启动器为每个 TUI 创建独立实例，daemon 方案复用受管实例。Loop 会保留一个休眠中的一次性 Node 唤醒进程，每次唤醒后该进程退出。没有操作系统 Cron 或本项目自己的常驻 daemon。电脑、App Server 与当前会话必须保持运行。

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
- Recommended mode also requires `codex app-server --listen` and `codex --remote unix://`; the shared-daemon, plugin-only setup additionally requires `codex app-server daemon`

## Quick start on another device

If you clone this repository, use the tested launcher included with it:

```bash
git clone https://github.com/Fnine59/codex-loop.git
cd codex-loop
npm run check

codex plugin marketplace add "$PWD"
codex plugin add codex-loop@fnine59

./bin/loop-codex
```

For an existing clone, run `git switch main && git pull --ff-only`, then run `codex plugin add codex-loop@fnine59` again. In Codex, enter `/hooks` and review and trust the `codex-loop` Stop hook. If you just trusted it, open a fresh `./bin/loop-codex` session.

`bin/loop-codex` creates an isolated App Server for the current TUI, cleans it up on exit, and forwards every argument to Codex unchanged:

```bash
./bin/loop-codex --model gpt-5.6
./bin/loop-codex --dangerously-bypass-approvals-and-sandbox
```

To invoke it from any directory, link it into an existing `PATH` directory. Because the link points to the clone, later `git pull` operations also update the launcher:

```bash
mkdir -p "$HOME/.local/bin"
ln -s "$PWD/bin/loop-codex" "$HOME/.local/bin/loop-codex"
```

## Install only the plugin

Without cloning the repository, install the remote `main` branch directly:

```bash
codex plugin marketplace add Fnine59/codex-loop --ref main
codex plugin add codex-loop@fnine59
```

Then add this function to `~/.zshrc` or `~/.bashrc` and open a new terminal:

```bash
loop-codex() {
    command codex app-server daemon start >/dev/null || return
    command codex --remote unix:// "$@"
}
```

### Launcher reminder for humans and agents

Prefer the versioned `bin/loop-codex` launcher or the official daemon approach above instead of improvising another launcher. If a custom `codex app-server --listen unix://...` endpoint is required, export `CODEX_LOOP_APP_SERVER_SOCKET` **before** starting App Server. App Server spawns the Stop hook; passing the variable only to the remote TUI prevents the plugin from locating the socket and silently falls back to the synchronous Stop hook.

An App Server process alone does not prove that asynchronous mode is active. After starting a loop, expect the `active through App Server` message and state with `backend: "app-server"`, a non-null `threadId`, and `lastError: null`.

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

Compatibility mode waits inside the synchronous Stop hook; `Ctrl-C` terminates that wait. Recommended mode uses the official Codex App Server: the repository launcher creates an isolated instance per TUI, while the daemon setup reuses a managed instance. The loop keeps one sleeping, one-shot Node wake process, which exits after each wake-up. There is no operating-system Cron job or persistent daemon owned by this project. The computer, App Server, and current session must remain running.

Loop state is isolated by Codex session and stored in the plugin's writable data directory. If Desktop or another App Server is also running, the plugin matches the current `session_id`/`turn_id` only and will not attach to an unrelated conversation.

## Development checks

```bash
npm run check
uv run --with pyyaml python ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/codex-loop
```
