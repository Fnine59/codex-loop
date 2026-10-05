[中文](#中文) | [English](#english)

# Herdr Codex Loop

## 中文

这是一个独立的 **Herdr 插件**：看清本机已有的 Codex Loop，跳转到关联会话，用项目预设轻量启动新的 Loop。

它不是 Codex 插件，也不是新的 Loop 调度器。目录里没有 `.codex-plugin/plugin.json`，不加入当前仓库的 Codex marketplace，不导入、不修改、不执行 `plugins/codex-loop/` 的代码。

### 两个功能入口

- **Loop 总览**：默认显示记录中的活跃 Loop，展示数量、任务、状态、轮次、下次执行时间、Space / Tab。支持搜索、当前 Space 筛选、未关联筛选、详情和会话跳转。已结束记录可以展开查看。
- **启动预设**：保存项目目录、启动命令、首轮提示语和偏好的 Space / Tab。全局设置提供默认命令、默认位置、就绪超时和数据目录；项目可以覆盖启动命令。

两个入口属于一个插件，不需要同时维护两套安装和配置。Space 是 Herdr 的 Workspace；Loop 跟随会话的实际位置，不被固定在插件指定的工作区内。

### 安装与打开

需要 Herdr ≥ 0.9.3、Node.js ≥ 20，`node` 必须位于启动 Herdr 时的 `PATH`。没有 npm 依赖，没有常驻服务。

在当前仓库根目录运行：

```sh
herdr plugin link "$PWD/plugins/herdr-loop"
```

在 Herdr 内通过插件 actions 打开，也可以在 **Herdr 管理的终端**里运行：

```sh
herdr plugin action invoke overview --plugin fnine.codex-loop
herdr plugin action invoke launch --plugin fnine.codex-loop
herdr plugin action invoke settings --plugin fnine.codex-loop
```

第一次使用：打开启动预设，按 `n` 新建项目预设；按 `g` 设置全局默认命令。默认命令是 `apiloopcodex`，插件不会安装或定义这个命令。

如果需要快捷键，可自行在 Herdr 的配置里添加；插件不会替你修改配置：

```toml
[[keys.command]]
key = "prefix+shift+l"
type = "plugin_action"
command = "fnine.codex-loop.overview"
description = "Loop overview"

[[keys.command]]
key = "prefix+shift+o"
type = "plugin_action"
command = "fnine.codex-loop.launch"
description = "Loop launch presets"
```

### 总览操作与数量含义

| 操作 | 按键 |
| --- | --- |
| 选择 / 跳转会话 | ↑↓ / Enter |
| 查看完整提示语与详情 | `d` |
| 详情逐行滚动 | ↑↓ 或 k / j |
| 详情上一页 / 下一页 | b / f |
| 详情开头 / 末尾 | g / Shift+G |
| 活跃 / 全部记录 | `a` |
| 未关联 / 当前 Space | `u` / `w` |
| 搜索 / 刷新 / 数据来源 | `/` / `r` / `?` |
| 启动预设 / 全局设置 | `n` / `s` |
| 返回或关闭 | Esc |

以上按键在插件弹窗中直接使用。字母键单按，`Shift+G` 同时按，不需要 Herdr 前缀或连续按键。详情页也支持带独立导航键的键盘上的 PgUp / PgDn / Home / End。

列表使用对齐的列和轻量列头，数量、状态与详情小标题加粗；执行中为绿色、等待为黄色、失败为红色，未关联位置也会提示。窄窗口优先保留任务列，隐藏的会话位置仍可在底部或详情中查看。详情中的完整 Loop 任务提示语和完成条件按窗口宽度自动换行，保留原有换行，不截断长行。设置 `NO_COLOR` 或使用 `TERM=dumb` 时不输出颜色。

“活跃”指状态文件中的 `waiting`、`launching`、`running`，**不是经过心跳确认的进程存活数**。Herdr 的 Agent 状态另行展示，不能代替 Loop 的状态。离线、限额等待和恢复中的记录不会被擅自改成已结束。

本机能读到、但无法关联到当前 Herdr server 的 Loop 会显示“未关联”，包括在 Herdr 外启动的 Loop、其他 Herdr session 中的 Loop，以及缺少原生会话 ID 的终端。它们可查看，但不能跳转。关联有歧义时也不跳转，不按任务标题或相同项目目录猜测。

现有 Loop 每个会话只有一个当前状态文件，新 Loop 会替换旧记录。因此“总记录”不是完整历史。插件没有停止、删除、重调度 Loop 的功能；这些操作仍在原会话中完成。

### 会话关联的前提

跳转依赖 Herdr 上报的原生 Codex `agent_session` ID，精确匹配状态文件的 `sessionId` 或 `threadId`。跳转前重新查询当前布局，跨 Space 移动后不会使用过期 Pane ID。

通常需由用户启用 Herdr 官方 Codex integration，让新会话上报原生 ID。**本插件不会自动安装 integration**：该安装会调整 Codex 全局 hooks / 配置，不属于这个插件的无侵入安装。

若尚未启用，总览仍可以使用，只是对应记录显示“未关联”。请先阅读 [Herdr integrations](https://herdr.dev/docs/integrations/)，确认接受相应配置变更后，再自行执行 `herdr integration install codex`，并打开新的 Codex 会话。不会为已打开的会话伪造身份。

### 启动流程

```text
选择项目预设
  → 选择 Space / 新 Tab 或已有 Tab 中的新 Pane
  → 预览项目、命令、首轮提示语并确认
  → 创建项目交互式 Shell，等待 Shell 就绪
  → 原样执行预设命令，等待 Codex idle / done
  → 用 Herdr agent prompt 提交首轮提示语一次
  → 查看启动结果，跳转会话或返回总览确认 Loop 激活
```

始终创建新终端，不向已有工作会话注入提示语。已有 Tab 只新增一个 Pane，不复用其当前终端。启动前取消不会新建终端；开始后取消等待会保留已创建的终端，不关闭会话。

命令在 Herdr 原生交互式 Shell 中执行，因此可以使用已配置的 alias、function 和参数。命令应启动一个**新的交互式 Codex 会话**，不应自带首轮提示语、自动开始任务或恢复旧会话。插件不会重写命令，也不会自动接受项目授权、登录、审批或提问。

启动后遇到授权 / 就绪超时：在“最近启动”（`v`）里按 Enter 定位目标终端，处理后重新打开最近启动，按 `r` 明确继续尚未发送的提示语。继续只等待原终端并提交提示语，不再次执行命令。若原生会话身份已更换，则拒绝继续。

发送结果不确定、已经尝试提交或已经提交的记录**不能重发**。本地原子发送锁防止多个弹窗对同一启动重复提交。提交成功仅代表文本和 Enter 已写入终端，不保证模型已经启动 Loop；请在总览或原会话确认。

### 提示语、配置和隐私

默认直接保存文本，支持多行粘贴；编辑框内 Enter 换行、Ctrl+D 保存、Ctrl+U 清空、Ctrl+G 取消。

也支持 `.md` 文件：相对路径按项目目录解析，绝对路径和 `~/` 可用。在确认启动前读取一次，后续轮次不会重新读取或注入。文本和文件内容均限制为 64 KiB，空提示语、缺失文件、无效目录会在新建终端前报错。

配置保存在 `HERDR_PLUGIN_CONFIG_DIR/config.json`，启动回执和发送锁保存在 `HERDR_PLUGIN_STATE_DIR/launches/<server指纹>/`，均属于 Herdr 用户目录，不写入源码目录或原 Loop 数据目录。预设是全局的，回执按当前 Herdr server 隔离，避免用另一个 session 的终端句柄继续启动。保存文件权限为 `0600`。尚未提交的回执包含当时的提示语快照，提交成功或结果不确定后清除文本；它们是本机私有数据，请勿把状态目录提交到 Git。

查询配置位置：

```sh
herdr plugin config-dir fnine.codex-loop
```

配置示例（用自己的绝对项目路径替换示例）：

```json
{
  "version": 1,
  "discoverDataDirs": true,
  "dataDirs": [],
  "defaults": {
    "command": "apiloopcodex",
    "readyTimeoutMs": 30000,
    "placement": "new-tab"
  },
  "presets": [
    {
      "id": "my-project",
      "name": "My Project",
      "cwd": "/absolute/path/to/project",
      "command": "",
      "prompt": { "kind": "text", "text": "请使用 codex-loop:loop 为这个项目启动 Loop，持续检查和处理待办。" },
      "placement": { "mode": "new-tab", "workspaceId": null, "tabId": null, "direction": "right" }
    }
  ]
}
```

文件来源替换为 `"prompt": { "kind": "file", "path": "docs/loop-prompt.md" }`。空命令覆盖表示使用全局命令；空 Space / Tab 表示跟随打开插件时的位置。预设位置只是默认选择，每次启动都可以调整。

### 数据发现与兼容边界

只读扫描 `sessions/<64位哈希>.json` 的 v1 状态文件，不递归搜索会话聊天内容：

- `CODEX_LOOP_DATA_DIR`（若设置）。
- `~/.codex-loop/plugin-data`。
- `${CODEX_HOME:-~/.codex}/plugins/data/codex-loop-*` 中的实际安装数据目录。
- 全局设置中的额外数据根目录（目录中应有 `sessions/`）。

开启自动发现时，“额外 Loop 数据目录”通常留空即可。只有 Loop 状态保存在其他自定义位置时才需要补充；填写包含 `sessions/` 的上一级目录，每行一个。这些路径用于总览的只读扫描，不会改变新 Loop 的数据保存位置。

可关闭自动发现，仅读取手动配置目录。`PLUGIN_DATA` 不作自动来源，因为调用方可能是 Herdr 插件或其他插件。重复数据根和同一会话记录会合并；不同 Loop 以最新创建时间为准，同一 Loop 副本以文件更新时间为准。缺失目录不报致命错误；损坏文件、未知状态版本显示读取警告。

当前支持 macOS / Linux、本机当前 Herdr server，不跨 SSH 控制远程机器。新版本状态格式需要显式适配，不会修改不认识的文件。

可选状态栏：在 Herdr `[ui]` 配置中手动合并以下条目，并替换为插件的真实绝对路径。它读取相同设置，不需要后台守护进程。

```toml
[ui]
tab_bar_right = [
  { type = "command", command = "node /absolute/path/plugins/herdr-loop/src/index.mjs status", interval_seconds = 5, timeout_seconds = 2 }
]
```

### 开发与验证

```sh
cd plugins/herdr-loop
npm run check
npm run smoke
```

`check` 执行语法检查和单元测试。`smoke` 使用实际安装的 Herdr，在独立临时 XDG 配置、状态和命名 server 中验证 manifest、启动、一次性多行提交、原生会话关联和跨 Space 跳转；macOS 还借助 `python3` 的标准库 PTY 验证三个 action 的真实 popup 渲染与关闭（仅此开发测试需要 Python，插件运行不需要）。测试使用假 Codex 终端，不启动付费模型会话，不改用户正式 Herdr registry 或 Codex hooks，完成后清理自己的临时 server 和文件。

仓库原功能的回归测试仍在根目录运行 `npm run check`。

实现分为 `src/overview/`、`src/launcher/`、`src/settings/`、`src/herdr-client/`、`src/ui/`。没有共享原 Loop 的管理接口、写权限或调度逻辑。

依据： [Herdr 插件协议](https://herdr.dev/docs/plugins/)、[CLI](https://herdr.dev/docs/cli-reference/)、[Socket API](https://herdr.dev/docs/socket-api/)、[官方 0.9.3 源码](https://github.com/herdrdev/herdr/tree/v0.9.3)。实际 CLI 参数和输出以本机验证为准。

## English

An independent **Herdr plugin** for a read-only Codex Loop overview, precise session navigation, and lightweight project launch presets. One plugin, two separate product entry points, plus shared settings.

It is not a Codex plugin or scheduler. It has no `.codex-plugin/plugin.json`, is not registered in this repository's Codex marketplace, and does not import, execute, or modify the original `plugins/codex-loop/` implementation. Workspaces remain owned by Herdr, not constrained by this plugin.

### Install and open

Requires Herdr ≥ 0.9.3 and Node.js ≥ 20 on the Herdr server's `PATH`. No npm dependencies or background daemon.

From the repository root:

```sh
herdr plugin link "$PWD/plugins/herdr-loop"
```

Use Herdr plugin actions, or run these inside a **Herdr-managed terminal**:

```sh
herdr plugin action invoke overview --plugin fnine.codex-loop
herdr plugin action invoke launch --plugin fnine.codex-loop
herdr plugin action invoke settings --plugin fnine.codex-loop
```

In launch presets, press `n` to add a project, `e` to edit, `x` to delete only a preset, `g` for global settings, and `v` for recent launch receipts. The default command is `apiloopcodex`; this plugin does not define or install it. Optional keybindings and a status-bar configuration are shown in the Chinese section above; merge them manually into your Herdr configuration if wanted.

### Overview

The default view lists recorded active Loops (`waiting`, `launching`, `running`) with counts, task, status, runs, next wake time and Space / Tab. Arrow keys select, Enter navigates, `d` opens details, `a` toggles all records, `u` filters unlinked, `w` filters the invoking workspace, `/` searches, `r` refreshes, `?` shows sources, and Escape closes.

These keys are handled inside the plugin popup: press letter keys once, or press `Shift+G` together. No Herdr prefix or repeated key sequence is needed.

Aligned columns and compact labels make the list easier to scan. Counts, status and detail section titles use bold text; running is green, waiting is yellow, failed is red, and unlinked locations are highlighted. Narrow windows prioritize the task column; location remains available below the list and in details. The complete recorded Loop task prompt and completion condition soft-wrap to the window width, preserving explicit line breaks without clipping long lines. In details, use arrows or `k`/`j` to scroll, `b`/`f` to page up/down, and `g`/`Shift+G` to reach the beginning/end. Page Up/Down and Home/End also work on keyboards that have them. Colors are disabled when `NO_COLOR` is set or `TERM=dumb`.

**Recorded active is not a process-liveness guarantee.** State files have no heartbeat. Herdr's agent lifecycle is displayed separately. Ended records are available in the all-records view; the plugin never changes recorded status based on inferred liveness.

Discoverable Loops outside the current Herdr server remain visible as **unlinked**, including external terminals, other named Herdr sessions, and terminals without native session identity. They cannot be navigated to. Matching uses exact native Codex `agent_session` IDs against Loop `sessionId` or `threadId`, never cwd or task-title guesses. Multiple matching terminals are treated as ambiguous. Navigation refreshes the live snapshot to handle cross-workspace pane moves.

Usually users must enable the official [Herdr Codex integration](https://herdr.dev/docs/integrations/) for new sessions to publish native IDs. **The plugin does not install it automatically**, because installation changes global Codex hooks/settings. Read the official documentation, then run `herdr integration install codex` yourself only if you accept those changes. Existing sessions are not assigned fabricated identities. Overview works without integration, but those records stay unlinked.

Loop state holds one current record per session, not a complete history. Stopping, deleting or rescheduling a Loop remains the responsibility of the original conversation; no such controls are provided here.

### Launch presets

Each preset stores a project directory, optional command override, first-turn prompt source, and preferred workspace/tab placement. Global settings provide the default command, placement, readiness timeout and read-only data roots.

Choose a preset → choose Space and new Tab or a new Pane in an existing Tab → confirm command and prompt preview → create a project shell → wait for shell readiness → execute the command unchanged → wait for Codex idle/done → submit the prompt once via `agent prompt` → inspect receipt and navigate or confirm Loop activation in overview.

An existing conversation is never reused for injection. Commands run in Herdr's native interactive shell, supporting aliases, functions and arguments. The command must open a fresh interactive Codex session without its own initial prompt, auto-started work, or resume behavior. No approval, authentication or trust dialogs are automatically accepted.

The default prompt source is stored multiline text; Enter adds a line, Ctrl+D saves, Ctrl+U clears and Ctrl+G cancels. A `.md` file is also supported: relative paths resolve against the project directory; absolute paths and `~/` work. Its contents are snapshotted once before confirmation, never re-injected on subsequent turns. Empty prompts, invalid project directories and missing/oversized files fail before terminal creation. Maximum prompt size: 64 KiB.

Startup blocks/timeouts retain the new terminal. Resolve the issue there, then explicitly resume the unsent prompt through recent launches (`v`, then `r`). Resume never reruns the command and refuses a changed known native session identity. Cancellation retains created terminals. If command execution or prompt delivery is ambiguous, inspect the original terminal; the plugin never retries automatically. Persistent atomic submission locks prevent duplicate prompts from concurrent popups. Successful submission acknowledges input, not actual Loop activation.

### Configuration, privacy and data roots

Settings live at `HERDR_PLUGIN_CONFIG_DIR/config.json`; launch receipts and submission locks live at `HERDR_PLUGIN_STATE_DIR/launches/<server fingerprint>/`. Presets are global; receipts are scoped to the current Herdr server so another named session cannot resume against unrelated terminal handles. Neither source checkout nor original Loop data is written. Saved files use mode `0600`. Unsent receipts contain private prompt snapshots; successful or ambiguous submissions clear that text. Do not commit user state directories.

```sh
herdr plugin config-dir fnine.codex-loop
```

The full version-1 configuration example is in the Chinese section. Use `"prompt": { "kind": "file", "path": "docs/loop-prompt.md" }` for a file source. An empty command override uses the global default. Empty workspace/tab preferences follow the invocation location and may be changed at launch.

Automatic discovery checks `CODEX_LOOP_DATA_DIR`, `~/.codex-loop/plugin-data`, and `${CODEX_HOME:-~/.codex}/plugins/data/codex-loop-*`. Add custom roots containing `sessions/` in global settings, or disable auto-discovery. `PLUGIN_DATA` is deliberately not trusted as a Loop root. Only v1 `sessions/<64-character hash>.json` files are read; no recursive conversation-content scan is performed. Duplicates are merged by session: newer Loop creation wins, then file modification time for copies of the same Loop. Missing roots are tolerated; malformed files and unknown versions appear as warnings.

With auto-discovery enabled, additional Loop data directories can usually stay empty. Add them only for state stored elsewhere, one root per line: use the parent of `sessions/`. These are read-only overview sources and do not change where new Loops save their data.

macOS / Linux, local current Herdr server only. No cross-machine SSH control. Unknown future state schemas require explicit adaptation and are never modified.

### Development and verification

```sh
cd plugins/herdr-loop
npm run check
npm run smoke
```

`check` runs syntax checks and unit tests. `smoke` starts a real Herdr server in isolated temporary XDG configuration/state/registry directories. It validates manifest registration, shell execution, exact one-shot multiline submission, native identity association and navigation after a cross-workspace move. On macOS it also checks real popup PTY rendering and Escape behavior for all three actions using `python3`'s standard library (a smoke-test-only dependency, not needed by the plugin). A fake Codex terminal is used: no paid model turn, no user registry or Codex hooks changed. Owned test servers/files are cleaned up afterward. Run root `npm run check` separately for original Loop regression tests.

Modules: `overview`, `launcher`, `settings`, `herdr-client`, `ui`. There is no shared scheduler, management API or write access to the original Loop runtime.

References: [Herdr plugins](https://herdr.dev/docs/plugins/), [CLI](https://herdr.dev/docs/cli-reference/), [Socket API](https://herdr.dev/docs/socket-api/), [official 0.9.3 source](https://github.com/herdrdev/herdr/tree/v0.9.3). Actual CLI compatibility is verified against the installed binary.
