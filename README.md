[中文](#中文) | [English](#english)

# 中文

`codex-loop` 是一个 Codex Plugin，让 Codex 在同一个对话里按计划重复工作，直到条件满足、达到边界或被人工终止。

同一次插件安装提供两种运行模式：

| 启动方式 | 运行后端 | 等待期间的 TUI |
| --- | --- | --- |
| `codex` | 同步 Stop Hook | 被当前 Loop 占用，兼容模式 |
| `loopcodex` | 官方 Codex App Server | 仍可正常对话，推荐模式 |

插件只在启动 Loop 时检测一次当前会话属于哪种后端。App Server 模式会把下一轮准确送回同一个 thread；普通模式自动回落到同步 Stop Hook。它不会创建系统 crontab、运行 `codex exec`、开启第二个会话或安装自定义常驻服务。

## 要求

- Node.js 20+
- 支持 Plugins 与 Hooks 的 Codex CLI
- 推荐模式还要求 CLI 支持 `codex app-server --listen` 和 `codex --remote unix://`

## 安装 Plugin

在终端执行：

```bash
codex plugin marketplace add Fnine59/codex-loop --ref main
codex plugin add codex-loop@fnine59
```

启动一个新的 Codex 会话，输入 `/hooks`，检查并信任 `codex-loop` 的 Stop Hook。若刚完成信任，请重新打开一次会话。

## 配置 `loopcodex`

本项目不安装 wrapper bin，也不覆盖原生 `codex`。把下面的函数放到 `~/.zshrc` 中已有的 `codex` 配置之后：

```zsh
loop-codex() {
    emulate -L zsh

    local runtime_dir socket_path server_log launcher_pid server_pid child_pid
    local exit_status=1
    local attempt

    runtime_dir="$(mktemp -d "${TMPDIR:-/tmp}/loop-codex.XXXXXX")" || return 1
    socket_path="${runtime_dir}/app-server.sock"
    server_log="${runtime_dir}/app-server.log"

    # Stop Hook 是 App Server 的子进程，因此必须先导出 Socket 地址。
    typeset -x CODEX_LOOP_APP_SERVER_SOCKET="${socket_path}"

    {
        codex app-server --listen "unix://${socket_path}" \
            >"${server_log}" 2>&1 &
        launcher_pid=$!

        for attempt in {1..100}; do
            [[ -S "${socket_path}" ]] && break
            kill -0 "${launcher_pid}" 2>/dev/null || break
            sleep 0.05
        done

        if [[ ! -S "${socket_path}" ]]; then
            print -u2 "loopcodex: App Server failed to start."
            [[ -s "${server_log}" ]] && command tail -n 20 "${server_log}" >&2
        else
            server_pid="${launcher_pid}"
            child_pid="$(pgrep -P "${launcher_pid}" 2>/dev/null | command head -n 1)"
            [[ -n "${child_pid}" ]] && server_pid="${child_pid}"

            codex --remote "unix://${socket_path}" "$@"
            exit_status=$?
        fi
    } always {
        if [[ -n "${server_pid}" ]] && kill -0 "${server_pid}" 2>/dev/null; then
            kill -TERM "${server_pid}" 2>/dev/null
        fi
        [[ -n "${launcher_pid}" ]] && wait "${launcher_pid}" 2>/dev/null

        command rm -f -- "${socket_path}" "${server_log}"
        command rmdir -- "${runtime_dir}" 2>/dev/null
    }

    return "${exit_status}"
}
alias loopcodex='loop-codex'
```

重新打开终端，或执行 `source ~/.zshrc`，然后像普通 Codex 一样使用：

```bash
loopcodex
loopcodex --model gpt-5.6
```

函数会为当前 TUI 创建独立 App Server，并将 `loopcodex` 后面的参数原样交给 Codex。正常结束 Codex 会话时，插件的 `SessionEnd` Hook 会先终止活动 Loop、中断正在运行的 App Server turn，并清理该 thread 的后台终端；函数随后清理 App Server 进程、Socket 和临时目录。两处 `codex` 会复用定义在它前面的同名 alias 或 function，因此现有代理与启动配置仍可保留；也可以像本机一样显式换成对应的启动前缀。只用于 TUI 的模型、权限等参数放在第二处、`--remote` 之前。

某些终端工具的“关闭 tab”只会断开界面，但仍保留底层 PTY 和进程；这种情况下 Codex 会话实际上尚未结束，因此不会触发 `SessionEnd`。需要真正结束对应的终端进程，或先在 Codex 中执行 `/exit`。

### App Server 感知检查

`CODEX_LOOP_APP_SERVER_SOCKET` 必须在启动 App Server **之前**导出。Stop Hook 由 App Server 创建；只把变量传给远程 TUI 会导致插件找不到 Socket，并回退到同步 Stop Hook。

启动 App Server 进程本身不代表异步模式已经生效。Loop 启动后应看到 `active through App Server`，其状态应满足 `backend: "app-server"`、`threadId` 非空且 `lastError: null`。

App Server 接口目前仍属于 Codex 的实验性能力。如果当前 CLI 不支持它，继续使用普通 `codex` 即可，Loop 功能仍能工作，只是等待期间 TUI 会被占用。单次等待接近或超过 7 天的 Cron 计划必须使用 `loopcodex`，避免超过同步 Hook 的超时上限。

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
- Codex Loop 与 Codex durable goal 都会接管续轮，因此不能在同一项工作上叠加使用。插件会阻止已准备或已激活的 Loop 再创建 goal；启动 Loop 时也不应先创建 goal。

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
- App Server 返回使用额度耗尽或 HTTP 429 限流：本轮不计数，保持 `waiting`，优先等到错误中给出的额度重置时间后重试；没有可解析时间时使用最长 6 小时的退避。

兼容模式由同步 Stop Hook 等待；`Ctrl-C` 可终止等待。推荐模式下，`loopcodex` 函数为每个 TUI 创建独立 App Server，并在会话退出时清理。Loop 会保留一个休眠中的一次性 Node 唤醒进程；唤醒后它只监听自己启动的这一轮，正常完成交回 Stop Hook 或处理终态后退出。没有操作系统 Cron 或本项目自己的常驻 daemon。电脑、App Server 与当前会话必须保持运行。

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
| `loopcodex` | Official Codex App Server | Remains interactive; recommended mode |

The plugin detects the current conversation's runtime once, when a loop starts. App Server mode sends every wake-up back to the exact same thread; ordinary sessions automatically fall back to the synchronous Stop hook. It creates no system crontab entry, runs no `codex exec`, opens no second session, and installs no custom persistent service.

## Requirements

- Node.js 20+
- A Codex CLI release with Plugins and Hooks support
- Recommended mode also requires `codex app-server --listen` and `codex --remote unix://`

## Install the plugin

Run in a terminal:

```bash
codex plugin marketplace add Fnine59/codex-loop --ref main
codex plugin add codex-loop@fnine59
```

Start a new Codex session, enter `/hooks`, and review and trust the `codex-loop` Stop hook. If you just trusted it, open one more fresh session.

## Configure `loopcodex`

This project installs no wrapper binary and does not replace the native `codex` command. Add the following function to `~/.zshrc` after your existing Codex configuration:

```zsh
loop-codex() {
    emulate -L zsh

    local runtime_dir socket_path server_log launcher_pid server_pid child_pid
    local exit_status=1
    local attempt

    runtime_dir="$(mktemp -d "${TMPDIR:-/tmp}/loop-codex.XXXXXX")" || return 1
    socket_path="${runtime_dir}/app-server.sock"
    server_log="${runtime_dir}/app-server.log"

    # Stop hooks are App Server children, so export the socket first.
    typeset -x CODEX_LOOP_APP_SERVER_SOCKET="${socket_path}"

    {
        codex app-server --listen "unix://${socket_path}" \
            >"${server_log}" 2>&1 &
        launcher_pid=$!

        for attempt in {1..100}; do
            [[ -S "${socket_path}" ]] && break
            kill -0 "${launcher_pid}" 2>/dev/null || break
            sleep 0.05
        done

        if [[ ! -S "${socket_path}" ]]; then
            print -u2 "loopcodex: App Server failed to start."
            [[ -s "${server_log}" ]] && command tail -n 20 "${server_log}" >&2
        else
            server_pid="${launcher_pid}"
            child_pid="$(pgrep -P "${launcher_pid}" 2>/dev/null | command head -n 1)"
            [[ -n "${child_pid}" ]] && server_pid="${child_pid}"

            codex --remote "unix://${socket_path}" "$@"
            exit_status=$?
        fi
    } always {
        if [[ -n "${server_pid}" ]] && kill -0 "${server_pid}" 2>/dev/null; then
            kill -TERM "${server_pid}" 2>/dev/null
        fi
        [[ -n "${launcher_pid}" ]] && wait "${launcher_pid}" 2>/dev/null

        command rm -f -- "${socket_path}" "${server_log}"
        command rmdir -- "${runtime_dir}" 2>/dev/null
    }

    return "${exit_status}"
}
alias loopcodex='loop-codex'
```

Open a new terminal, or run `source ~/.zshrc`, then use it like ordinary Codex:

```bash
loopcodex
loopcodex --model gpt-5.6
```

The function creates an isolated App Server for the current TUI and forwards all arguments after `loopcodex` unchanged. When Codex exits normally, the plugin's `SessionEnd` hook first terminates the active loop, interrupts its running App Server turn, and cleans that thread's background terminals; the function then removes the App Server process, socket, and temporary directory. Both `codex` calls reuse an alias or function defined earlier in the file, preserving an existing proxy or launch setup; you can also replace them explicitly with the same launcher prefix used on this machine. Put TUI-only model or permission flags on the second invocation before `--remote`.

Some terminal tools can “close” a tab by detaching its UI while retaining the underlying PTY and processes. In that case the Codex session has not actually ended, so `SessionEnd` cannot fire. End the corresponding terminal process, or run `/exit` in Codex first.

### Verify App Server detection

Export `CODEX_LOOP_APP_SERVER_SOCKET` **before** starting App Server. App Server spawns the Stop hook; passing the variable only to the remote TUI prevents the plugin from locating the socket and makes it fall back to the synchronous Stop hook.

An App Server process alone does not prove that asynchronous mode is active. After starting a loop, expect the `active through App Server` message and state with `backend: "app-server"`, a non-null `threadId`, and `lastError: null`.

App Server remains an experimental Codex capability. If the current CLI does not support it, use ordinary `codex`; loops still work, but the TUI is occupied while the Stop hook waits. Cron schedules whose next wait approaches or exceeds seven days require `loopcodex` so they do not exceed the synchronous hook timeout.

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
- Codex Loop and Codex durable goals both own turn continuation, so do not combine them for the same work. The plugin blocks goal creation once a Loop is prepared or active, and Loop startup must not create a goal first.

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
- App Server usage limit or HTTP 429 throttling: the attempt is not counted, the loop remains `waiting`, and retries after the reported reset time when available; otherwise it uses backoff capped at six hours.

Compatibility mode waits inside the synchronous Stop hook; `Ctrl-C` terminates that wait. In recommended mode, the `loopcodex` function creates one isolated App Server per TUI and cleans it up when the session exits. The loop keeps one sleeping, one-shot Node wake process; after waking, it observes only the turn it started and exits when normal completion returns control to the Stop hook or the terminal status is handled. There is no operating-system Cron job or persistent daemon owned by this project. The computer, App Server, and current session must remain running.

Loop state is isolated by Codex session and stored in the plugin's writable data directory. If Desktop or another App Server is also running, the plugin matches the current `session_id`/`turn_id` only and will not attach to an unrelated conversation.

## Development checks

```bash
npm run check
uv run --with pyyaml python ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/codex-loop
```
