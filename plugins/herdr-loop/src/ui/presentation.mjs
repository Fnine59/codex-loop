import { span, padText } from "./terminal.mjs";

export const when = value => Number.isFinite(value) ? new Date(value).toLocaleString() : "—";
const statusNames = { waiting: "等待", launching: "启动中", running: "执行中", completed: "已完成", stopped: "已停止", failed: "失败", expired: "已过期" };
const statusTones = { waiting: "warning", launching: "accent", running: "success", completed: "success", stopped: "muted", failed: "danger", expired: "muted" };
const scopeNames = { active: "活跃", all: "全部", unlinked: "未关联", workspace: "当前 Space" };

export const location = loop => loop.association.linked
  ? `${loop.association.workspace?.label || loop.association.pane.workspace_id} / ${loop.association.tab?.label || loop.association.pane.tab_id}`
  : loop.association.reason === "ambiguous" ? "未关联（匹配不唯一）" : "未关联";

export function overviewHeader(overview, { scope, query }) {
  const counts = overview.counts;
  return [
    ["记录中活跃 ", span(counts.active, { tone: "success", bold: true }), " · 总记录 ", span(counts.total, { bold: true }),
      " · 已关联 ", span(counts.linked, { tone: "accent", bold: true }), " · 未关联 ", span(counts.unlinked, { tone: counts.unlinked ? "warning" : "muted", bold: true })],
    ["视图：", span(scopeNames[scope] || scope, { bold: true }), " · 搜索：", span(query || "—", { bold: !!query }), span(" · 状态来自记录，运行存活未确认", { dim: true })],
    overview.snapshotError ? span(`Herdr 不可用：${overview.snapshotError}`, { tone: "danger" })
      : [span(`${overview.warnings.length} 条读取警告`, { tone: overview.warnings.length ? "warning" : "muted" }), span(` · 已结束 ${counts.ended} 条（a 显示）`, { dim: true })],
  ];
}

export function overviewTable(loops, width, selected = -1) {
  // Keep the task readable in narrow popups; hidden location remains in details.
  const columns = [
    ...(width >= 52 ? [{ key: "id", label: "Loop", width: 8 }] : []),
    { key: "status", label: "状态", width: 6 },
    ...(width >= 36 ? [{ key: "runs", label: "轮次", width: 6, align: "right" }] : []),
    ...(width >= 72 ? [{ key: "location", label: "Space / Tab", width: Math.min(30, Math.floor(width / 4)) }] : []),
    { key: "task", label: "任务" },
  ];
  columns.at(-1).width = Math.max(1, width - 2 - (columns.length - 1) * 2 - columns.slice(0, -1).reduce((sum, column) => sum + column.width, 0));
  const row = (values, styles = {}, marker = "  ") => [marker, ...columns.flatMap((column, index) => [
    ...(index ? ["  "] : []), span(padText(values[column.key], column.width, column.align), styles[column.key]),
  ])];
  return {
    header: row(Object.fromEntries(columns.map(column => [column.key, column.label])),
      Object.fromEntries(columns.map(column => [column.key, { bold: true, dim: true }]))),
    rows: loops.map((loop, index) => row({ id: loop.id.slice(0, 8), status: statusNames[loop.status] || loop.status,
      runs: loop.runs, location: location(loop), task: loop.task }, {
      id: { dim: true }, status: { tone: statusTones[loop.status], bold: true }, runs: { dim: true },
      location: { tone: loop.association.linked ? "accent" : "warning" },
    }, index === selected ? "› " : "  ")),
  };
}

export function loopDetails(loop) {
  return [
    `Loop ${loop.id} · 记录状态：${statusNames[loop.status] || loop.status} · ${loop.runs} 轮`,
    `位置：${location(loop)}`,
    `项目：${loop.cwd || "—"}`,
    `下次：${when(loop.nextRunAt)} · 到期：${when(loop.expiresAt)}`,
    "", span("Loop 提示语（完整任务文本）：", { bold: true, tone: "accent" }), ...String(loop.task).split("\n"),
    "", span("完成条件：", { bold: true }), ...String(loop.until || "—").split("\n"),
    "", span("会话与运行记录：", { bold: true }),
    `Herdr Agent：${loop.association.pane?.agent_status || "不可确认"}；不是 Loop 心跳`,
    `会话 ID：${loop.sessionId}`,
    `Thread ID：${loop.threadId || "—"}`,
    `创建：${when(loop.createdAt)} · 最近文件更新：${when(loop.updatedAt)}`,
    `执行方式：${loop.backend || "—"} · 节奏：${loop.cadenceLabel || loop.cronExpression || loop.scheduleMode || "—"}`,
    `运行时记录：${loop.runtimeStatus || "—"} · 重试：${when(loop.runtimeRetryAt)}`,
    `最后错误：${loop.lastError || loop.runtimeLastError || "—"}`,
    `结束原因：${loop.endReason || "—"}`,
    "", `只读来源：${loop.source}`,
    "状态文件不含心跳，不能据此保证 Loop 进程仍在运行。",
  ];
}
