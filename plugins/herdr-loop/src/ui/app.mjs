import { randomUUID } from "node:crypto";
import { discoverDataDirs, scanLoops } from "../overview/discovery.mjs";
import { makeOverview, filterLoops, focusLoop } from "../overview/model.mjs";
import { prepareLaunch, launchOnce, resumeLaunch, focusReceipt, RESUMABLE_STAGES } from "../launcher/launch.mjs";
import { isCancel } from "./terminal.mjs";

const when = value => Number.isFinite(value) ? new Date(value).toLocaleString() : "—";
const location = loop => loop.association.linked
  ? `${loop.association.workspace?.label || loop.association.pane.workspace_id} / ${loop.association.tab?.label || loop.association.pane.tab_id}`
  : loop.association.reason === "ambiguous" ? "未关联（匹配不唯一）" : "未关联";
const statusNames = { waiting: "等待", launching: "启动中", running: "执行中", completed: "已完成", stopped: "已停止", failed: "失败", expired: "已过期" };

export async function loadOverview(config, client) {
  const roots = await discoverDataDirs(config);
  const [scan, snapshot] = await Promise.allSettled([scanLoops(roots), client.snapshot()]);
  if (scan.status === "rejected") throw scan.reason;
  return makeOverview(scan.value, snapshot.status === "fulfilled" ? snapshot.value : null, snapshot.status === "rejected" ? snapshot.reason.message : null);
}

function loopDetails(loop) {
  return [
    `Loop ${loop.id} · 记录状态：${statusNames[loop.status] || loop.status} · ${loop.runs} 轮`,
    `位置：${location(loop)}`,
    `Herdr Agent：${loop.association.pane?.agent_status || "不可确认"}；不是 Loop 心跳`,
    `项目：${loop.cwd || "—"}`,
    `会话 ID：${loop.sessionId}`,
    `Thread ID：${loop.threadId || "—"}`,
    `下次：${when(loop.nextRunAt)} · 到期：${when(loop.expiresAt)}`,
    `创建：${when(loop.createdAt)} · 最近文件更新：${when(loop.updatedAt)}`,
    `执行方式：${loop.backend || "—"} · 节奏：${loop.cadenceLabel || loop.cronExpression || loop.scheduleMode || "—"}`,
    `运行时记录：${loop.runtimeStatus || "—"} · 重试：${when(loop.runtimeRetryAt)}`,
    `最后错误：${loop.lastError || loop.runtimeLastError || "—"}`,
    `结束原因：${loop.endReason || "—"}`,
    "", "任务：", ...String(loop.task).split("\n"),
    "", "完成条件：", ...String(loop.until || "—").split("\n"),
    "", `只读来源：${loop.source}`,
    "状态文件不含心跳，不能据此保证 Loop 进程仍在运行。",
  ];
}

export class App {
  constructor(terminal, client, configStore, receiptStore, context) {
    Object.assign(this, { terminal, client, configStore, receiptStore, context });
    this.jumped = false;
  }
  async overview() {
    let scope = "active", query = "", selected = 0, overview;
    for (;;) {
      const previousId = overview && filterLoops(overview, { scope, query, workspaceId: this.context.workspaceId })[selected]?.sessionId;
      try { overview = await loadOverview(await this.configStore.load(), this.client); }
      catch (error) { await this.terminal.notice(error.message); return; }
      if (previousId) {
        const freshIndex = filterLoops(overview, { scope, query, workspaceId: this.context.workspaceId }).findIndex(loop => loop.sessionId === previousId);
        if (freshIndex >= 0) selected = freshIndex;
      }
      let refreshAt = Date.now() + 2000;
      for (;;) {
        const loops = filterLoops(overview, { scope, query, workspaceId: this.context.workspaceId });
        selected = Math.max(0, Math.min(selected, loops.length - 1));
        const start = Math.max(0, selected - this.terminal.capacity + 4);
        const counts = overview.counts;
        const header = [
          `记录中活跃 ${counts.active} · 总记录 ${counts.total} · 已关联 ${counts.linked} · 未关联 ${counts.unlinked}`,
          `视图：${scope} · 搜索：${query || "—"} · 状态来自记录，运行存活未确认`,
          overview.snapshotError ? `Herdr 不可用：${overview.snapshotError}` : `${overview.warnings.length} 条读取警告 · 已结束 ${counts.ended} 条（a 显示）`,
          "",
        ];
        const body = loops.slice(start, start + this.terminal.capacity - 4).map((loop, index) =>
          `${start + index === selected ? "›" : " "} ${loop.id.slice(0, 8)}  ${statusNames[loop.status] || loop.status}  ${loop.runs}轮  ${location(loop)}  ${loop.task}`);
        this.terminal.render("Loop 总览 / Overview", [...header, ...(body.length ? body : ["没有符合条件的记录。n 打开启动预设，s 配置数据目录。"]), "", loops[selected] ? `下次：${when(loops[selected].nextRunAt)} · 项目：${loops[selected].cwd || "—"}` : ""],
          "↑↓ Enter跳转 d详情 /搜索 a全部 u未关联 w空间 n预设 s设置 ?来源 Esc退出", body.length ? header.length + selected - start : -1);
        const key = await this.terminal.key(Math.max(1, refreshAt - Date.now()));
        if (!key) break;
        if (isCancel(key)) return;
        if (key.name === "up" || key.str === "k") selected = Math.max(0, selected - 1);
        else if (key.name === "down" || key.str === "j") selected = Math.min(loops.length - 1, selected + 1);
        else if (key.str === "a") { scope = scope === "all" ? "active" : "all"; selected = 0; }
        else if (key.str === "u") { scope = scope === "unlinked" ? "active" : "unlinked"; selected = 0; }
        else if (key.str === "w") { scope = scope === "workspace" ? "active" : "workspace"; selected = 0; }
        else if (key.str === "/") { const result = await this.terminal.inputText("搜索任务 / Search", query); if (result !== null) query = result; selected = 0; }
        else if (key.str === "r") break;
        else if (key.str === "?") await this.terminal.view("数据来源 / Sources", [
          ...overview.sources.map(source => `${source.available ? "可读" : "未找到"} ${source.root}`), "",
          ...overview.warnings.map(warning => `${warning.source}: ${warning.message}`),
          "", "没有会话 ID 匹配的记录标为未关联，不按目录或任务标题猜测。",
          "只关联当前 Herdr server；其他 Herdr session 的记录也标为未关联。",
        ]);
        else if (key.str === "n") { await this.launcher(); if (this.jumped) return; break; }
        else if (key.str === "s") { await this.settings(); break; }
        else if ((key.str === "d" || key.name === "return") && loops[selected]) {
          const loop = loops[selected];
          if (key.str === "d") {
            const action = await this.terminal.view("Loop 详情 / Details", loopDetails(loop), { actions: ["return"], footer: "↑↓ 滚动 · Enter 跳转 · Esc 返回" });
            if (!action) continue;
          }
          try { await focusLoop(loop, this.client); this.jumped = true; return; }
          catch (error) { await this.terminal.notice(error.message); break; }
        }
      }
    }
  }
  async settings() {
    const config = await this.configStore.load();
    const command = await this.terminal.inputText("全局默认启动命令 / Default command", config.defaults.command, { hint: "在项目交互式 Shell 中原样执行；支持 alias / function / 参数。" });
    if (command === null) return;
    const timeout = await this.terminal.inputText("等待就绪超时（秒） / Readiness timeout", String(config.defaults.readyTimeoutMs / 1000));
    if (timeout === null) return;
    const mode = await this.terminal.menu("默认启动位置 / Default placement", [
      { label: "当前 Space 的新 Tab（推荐）", value: "new-tab" },
      { label: "当前 Tab 中新建 Pane", value: "existing-tab" },
      { label: "新建 Space", value: "new-workspace" },
    ], { initial: ["new-tab", "existing-tab", "new-workspace"].indexOf(config.defaults.placement) });
    if (!mode) return;
    const discover = await this.terminal.menu("自动发现本机 Loop 数据 / Auto-discovery", [
      { label: "开启：Codex plugins/data/codex-loop-* + ~/.codex-loop/plugin-data", value: true },
      { label: "关闭：仅使用手动配置的数据目录", value: false },
    ], { initial: config.discoverDataDirs ? 0 : 1 });
    if (!discover) return;
    const dirs = await this.terminal.inputText("额外 Loop 数据目录，每行一个 / Additional data directories", config.dataDirs.join("\n"), { multiline: true, hint: "填写包含 sessions/ 的数据根目录。不会写入这些目录。" });
    if (dirs === null) return;
    try {
      await this.configStore.save({ ...config, discoverDataDirs: discover.value, dataDirs: dirs.split("\n").map(value => value.trim()).filter(Boolean),
        defaults: { command, readyTimeoutMs: Number(timeout) * 1000, placement: mode.value } });
      await this.terminal.notice(`已保存 / Saved\n${this.configStore.filename}`);
    } catch (error) { await this.terminal.notice(error.message); }
  }
  async editPreset(config, preset = null) {
    const fields = [
      ["name", "预设名称 / Preset name", preset?.name || ""],
      ["cwd", "项目目录 / Project directory", preset?.cwd || this.context.cwd],
      ["command", "启动命令（留空使用全局默认） / Command override", preset?.command || ""],
    ];
    const values = {};
    for (const [key, title, initial] of fields) {
      values[key] = await this.terminal.inputText(title, initial);
      if (values[key] === null) return;
    }
    const source = await this.terminal.menu("首轮提示语来源 / First-turn prompt", [
      { label: "保存文本（默认）", value: "text" }, { label: "读取项目内固定 Markdown 文件", value: "file" },
    ], { initial: preset?.prompt.kind === "file" ? 1 : 0 });
    if (!source) return;
    const value = await this.terminal.inputText(source.value === "text" ? "启动 Loop 的提示语 / Loop startup prompt" : "Markdown 路径 / Markdown path",
      preset?.prompt.kind === source.value ? preset.prompt.text ?? preset.prompt.path : "",
      { multiline: source.value === "text", hint: source.value === "text" ? "仅发到启动会话的首轮。可粘贴多行，Ctrl+D 保存。" : "相对路径按项目目录解析；启动前读取一次。" });
    if (value === null) return;
    const modes = ["new-tab", "existing-tab", "new-workspace"];
    const mode = await this.terminal.menu("默认位置 / Preferred placement", [
      { label: "新 Tab", value: "new-tab" }, { label: "已有 Tab 中新建 Pane", value: "existing-tab" }, { label: "新 Space", value: "new-workspace" },
    ], { initial: modes.indexOf(preset?.placement.mode || config.defaults.placement) });
    if (!mode) return;
    const placement = { mode: mode.value, direction: preset?.placement.direction || "right" };
    if (mode.value !== "new-workspace") {
      const snapshot = await this.client.snapshot();
      const spaces = [{ label: "跟随打开插件时的当前 Space（默认）", value: null }, ...snapshot.workspaces.map(item => ({ label: `${item.label} (${item.workspace_id})`, value: item.workspace_id }))];
      const space = await this.terminal.menu("预设的 Space / Preferred Space", spaces, { initial: Math.max(0, spaces.findIndex(item => item.value === preset?.placement.workspaceId)) });
      if (!space) return;
      placement.workspaceId = space.value;
      if (mode.value === "existing-tab") {
        const tabs = [{ label: "跟随该 Space 的当前 Tab", value: null }, ...snapshot.tabs.filter(item => item.workspace_id === (space.value || this.context.workspaceId)).map(item => ({ label: `${item.label} (${item.tab_id})`, value: item.tab_id }))];
        const tab = await this.terminal.menu("预设的 Tab / Preferred Tab", tabs, { initial: Math.max(0, tabs.findIndex(item => item.value === preset?.placement.tabId)) });
        if (!tab) return;
        placement.tabId = tab.value;
      }
    }
    const saved = { ...values, id: preset?.id || randomUUID(), placement, prompt: source.value === "text" ? { kind: "text", text: value } : { kind: "file", path: value } };
    const presets = preset ? config.presets.map(item => item.id === preset.id ? saved : item) : [...config.presets, saved];
    try { await this.configStore.save({ ...config, presets }); }
    catch (error) { await this.terminal.notice(error.message); }
  }
  async chooseTarget(preset) {
    const snapshot = await this.client.snapshot();
    const spaces = [...snapshot.workspaces.map(item => ({ label: `${item.label} (${item.workspace_id})`, value: item.workspace_id })), { label: "+ 新建 Space", value: null }];
    const preferred = preset.placement.workspaceId || this.context.workspaceId;
    const space = await this.terminal.menu("启动到哪个 Space？ / Choose Space", spaces, { initial: preset.placement.mode === "new-workspace" ? spaces.length - 1 : Math.max(0, spaces.findIndex(item => item.value === preferred)) });
    if (!space) return null;
    if (space.value === null) return { mode: "new-workspace" };
    const tabs = [{ label: "+ 新建 Tab（推荐）", value: null }, ...snapshot.tabs.filter(item => item.workspace_id === space.value).map(item => ({ label: `${item.label} (${item.tab_id}) → 新 Pane`, value: item.tab_id }))];
    const preferredTab = preset.placement.tabId || (space.value === this.context.workspaceId ? this.context.tabId : snapshot.workspaces.find(item => item.workspace_id === space.value)?.active_tab_id);
    const tab = await this.terminal.menu("启动到哪个 Tab？ / Choose Tab", tabs, { initial: preset.placement.mode === "existing-tab" ? Math.max(0, tabs.findIndex(item => item.value === preferredTab)) : 0 });
    if (!tab) return null;
    if (tab.value === null) return { mode: "new-tab", workspaceId: space.value };
    const direction = await this.terminal.menu("在 Tab 内新建 Pane / Split direction", [
      { label: "向右 / Right", value: "right" }, { label: "向下 / Down", value: "down" },
    ], { initial: preset.placement.direction === "down" ? 1 : 0 });
    return direction ? { mode: "existing-tab", workspaceId: space.value, tabId: tab.value, direction: direction.value } : null;
  }
  async runWithProgress(operation) {
    const controller = new AbortController();
    let message = "正在启动… / Starting…", settled = false, result, failure;
    // Attach the rejection handler immediately, including failures before the first poll.
    const promise = operation({ signal: controller.signal, onUpdate: value => { message = value; } })
      .then(value => { result = value; }, error => { failure = error; }).finally(() => { settled = true; });
    while (!settled) {
      this.terminal.render("启动 Loop / Launch", [message, "", "提示语只发送一次；成功提交不等于 Loop 已激活。", "取消等待会保留新建终端，不关闭或重试。"], "Esc 取消等待（已开始的发送不会中断）");
      if (isCancel(await this.terminal.key(150))) controller.abort();
    }
    await promise;
    if (failure) throw failure;
    return result;
  }
  async showReceipt(receipt) {
    const resumable = RESUMABLE_STAGES.has(receipt.stage) && receipt.commandAcknowledged && !receipt.sendAttemptedAt;
    const lines = [
      receipt.stage === "sent" ? "首轮提示语已提交；请在总览中确认 Loop 激活。" : "本次启动未确认完成。不会自动重试命令或提示语。",
      `预设：${receipt.name} · 状态：${receipt.stage}`,
      `目标终端：${receipt.paneId || "未知"} · ${receipt.terminalId || "未知"}`,
      `说明：${receipt.error || "—"}`,
      resumable ? "处理授权/登录后，可按 r 明确继续：只尝试发送尚未发送的提示语。" : "若发送结果不确定，请检查原会话；禁止重发。",
    ];
    const action = await this.terminal.view("启动结果 / Launch receipt", lines, { actions: ["return", ...(resumable ? ["r"] : [])], footer: "Enter 跳转目标终端 · r 继续未发送的提示语（如可用） · Esc 返回" });
    if (action === "r") {
      const confirm = await this.terminal.menu("确认继续首轮提示语 / Confirm submission", [{ label: "发送已保存的首轮提示语一次", value: true }, { label: "返回", value: false }], { initial: 1 });
      if (confirm?.value) await this.showReceipt(await this.runWithProgress(options => resumeLaunch(receipt.id, this.client, this.receiptStore, options)));
    } else if (action) {
      try { await focusReceipt(receipt, this.client); this.jumped = true; }
      catch (error) { await this.terminal.notice(error.message); }
    }
  }
  async history() {
    const receipts = await this.receiptStore.list();
    const selected = await this.terminal.menu("最近启动 / Recent launches", receipts.map(item => ({ label: `${when(item.createdAt)} · ${item.name} · ${item.stage}`, value: item })), { header: receipts.length ? [] : ["暂无启动记录"] });
    if (selected) await this.showReceipt(selected.value);
  }
  async launcher() {
    let index = 0;
    for (;;) {
      const config = await this.configStore.load();
      const selected = await this.terminal.menu("Loop 启动预设 / Launch presets", config.presets.map(item => ({ label: `${item.name} · ${item.cwd} · ${item.command || "全局命令"} · ${item.prompt.kind}`, value: item })), {
        initial: index, shortcuts: ["n", "e", "x", "g", "v"],
        header: [`全局命令：${config.defaults.command} · 仅向新的 Codex 会话发送首轮提示语`, ...(config.presets.length ? [] : ["尚无预设，按 n 新建。"] )],
        footer: "Enter启动 n新建 e编辑 x删除 g全局设置 v启动记录 Esc返回",
      });
      if (!selected) return;
      index = selected.index;
      try {
        if (selected.shortcut === "n") await this.editPreset(config);
        else if (selected.shortcut === "e" && selected.value) await this.editPreset(config, selected.value);
        else if (selected.shortcut === "g") await this.settings();
        else if (selected.shortcut === "v") await this.history();
        else if (selected.shortcut === "x" && selected.value) {
          const confirm = await this.terminal.menu("只删除启动预设，不影响 Loop / Delete preset only", [{ label: "返回", value: false }, { label: `删除 ${selected.value.name}`, value: true }]);
          if (confirm?.value) await this.configStore.save({ ...config, presets: config.presets.filter(item => item.id !== selected.value.id) });
        } else if (!selected.shortcut && selected.value) {
          const prepared = await prepareLaunch(selected.value, config);
          const target = await this.chooseTarget(prepared.preset);
          if (!target) continue;
          const confirm = await this.terminal.menu("确认启动 / Confirm launch", [{ label: "启动并发送一次首轮提示语", value: true }, { label: "返回，不启动", value: false }], {
            header: [`项目：${prepared.preset.cwd}`, `命令：${prepared.command}`, `位置：${target.workspaceId || "新 Space"} / ${target.tabId || "新 Tab"}`,
              `提示语（${Buffer.byteLength(prepared.prompt)} bytes）：${prepared.prompt.slice(0, 240)}`], initial: 1,
          });
          if (confirm?.value) await this.showReceipt(await this.runWithProgress(options => launchOnce(prepared, target, this.client, this.receiptStore, options)));
        }
        if (this.jumped) return;
      } catch (error) { await this.terminal.notice(error.message); }
    }
  }
}
