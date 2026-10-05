import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { PassThrough } from "node:stream";
import { Terminal, span, lineText, textWidth, clip, padText, wrapText } from "../src/ui/terminal.mjs";
import { loopDetails, overviewHeader, overviewTable } from "../src/ui/presentation.mjs";

const loop = overrides => ({ id: "loop-123456789", sessionId: "session-1", status: "running", runs: 12,
  task: "完整项目任务", cwd: "/project", source: "/fixture/sessions/state.json", association: { linked: false, reason: "unlinked" }, ...overrides });

function screen(columns = 80, rows = 24, color = true) {
  const writes = [];
  const output = { columns, rows, write: text => writes.push(text) };
  const terminal = new Terminal({}, output, { color });
  return { terminal, output, writes };
}

test("details retain the entire long multiline task and completion condition, before runtime metadata", () => {
  const task = `${"完整的长提示语中文🙂abc".repeat(150)}\n\n第二段\t缩进\nPROMPT_END`;
  const until = "完成条件第一行\n第二行";
  const details = loopDetails(loop({ task, until }));
  const start = details.findIndex(line => lineText(line) === "Loop 提示语（完整任务文本）：");
  const end = details.findIndex(line => lineText(line) === "完成条件：");
  assert.ok(start >= 0 && start < 8);
  assert.equal(details.slice(start + 1, end - 1).join("\n"), task);
  assert.equal(details.slice(end + 1, end + 3).join("\n"), until);
  assert.ok(details.findIndex(line => lineText(line).startsWith("会话 ID：")) > end);
});

test("detail paging exposes every wrapped line of a long prompt, without an ellipsis", async () => {
  const { terminal } = screen(30, 12);
  const prompt = `${"这一段提示语没有手动换行abc🙂".repeat(50)}\n\n最后一行 PROMPT_END`;
  const expected = wrapText(prompt, terminal.width);
  const frames = [];
  terminal.render = (title, lines) => frames.push(lines.map(lineText));
  let page = 0;
  terminal.key = async () => ({ name: page++ < Math.ceil(expected.length / terminal.capacity) ? "pagedown" : "escape" });
  await terminal.view("完整提示语", [prompt]);
  const seen = frames.flat();
  for (const line of expected) assert.ok(seen.includes(line), `missing wrapped line: ${line}`);
  assert.ok(seen.some(line => line.includes("PROMPT_END")));
  assert.equal(seen.some(line => line.includes("…")), false);
  assert.ok(seen.every(line => textWidth(line) <= terminal.width));
});

test("detail Home/End navigation and resizing keep the full text accessible", async () => {
  const { terminal, output } = screen(30, 12);
  const prompt = `PROMPT_START ${"完整文本abc".repeat(80)} PROMPT_END`;
  const frames = [];
  terminal.render = (title, lines) => frames.push(lines.map(lineText));
  const keys = ["end", "up", "home", "end", "escape"];
  let index = 0;
  terminal.key = async () => {
    if (index === 1) { output.columns = 100; output.rows = 50; }
    return { name: keys[index++] };
  };
  await terminal.view("完整提示语", [prompt]);
  assert.ok(frames[0].join("").includes("PROMPT_START"));
  assert.ok(frames[1].join("").includes("PROMPT_END"));
  assert.deepEqual(frames[2], wrapText(prompt, terminal.width));
  assert.ok(frames[3].join("").includes("PROMPT_START"));
  assert.ok(frames[4].join("").includes("PROMPT_END"));
});

test("terminal resize wakes an open view and its listener is removed on close", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = output.isTTY = true;
  input.setRawMode = value => { input.isRaw = value; };
  const terminal = new Terminal(input, output);
  try {
    terminal.start();
    output.emit("resize");
    assert.deepEqual(await terminal.key(100), { str: "", name: "resize" });
    assert.equal(output.listenerCount("resize"), 1);
    terminal.close();
    assert.equal(output.listenerCount("resize"), 0);
  } finally {
    input.destroy(); output.destroy();
  }
});

test("wrapping preserves blank lines, expands tabs safely and keeps styled headings", async () => {
  assert.deepEqual(wrapText("a\r\n\r\n\tb", 20), ["a", "", "    b"]);
  const { terminal } = screen(24, 12);
  const frames = [];
  terminal.render = (title, lines) => frames.push(lines);
  terminal.key = async () => ({ name: "escape" });
  await terminal.view("详情", [span("完整提示语标题".repeat(3), { bold: true, tone: "accent" })]);
  assert.ok(frames[0].length > 1);
  for (const row of frames[0]) assert.ok(row.every(part => part.bold && part.tone === "accent"));
});

test("clipping and padding count terminal cells and never split a supplementary character", () => {
  assert.equal(clip("中文中文", 5), "中文…");
  assert.equal(clip("ab🙂tail", 4), "ab…");
  assert.equal(clip("🙂x", 2), "…");
  assert.equal(clip("🙂", 2), "🙂");
  assert.equal(clip("abc", 0), "");
  assert.equal(textWidth(padText("中文", 8)), 8);
  assert.equal(padText("12", 6, "right"), "    12");
});

test("wide overview rows have aligned column labels, legible status and an explicit unlinked location", () => {
  const table = overviewTable([loop({}), loop({ id: "short", runs: 999, task: "第二个任务" })], 100, 0);
  const header = lineText(table.header);
  for (const label of ["Loop", "状态", "轮次", "Space / Tab", "任务"]) assert.ok(header.includes(label));
  assert.equal(textWidth(table.header), 100);
  for (const row of table.rows) assert.equal(textWidth(row), 100);
  assert.ok(lineText(table.rows[0]).startsWith("› "));
  assert.ok(lineText(table.rows[0]).includes("未关联"));
  const taskStart = textWidth(header.slice(0, header.indexOf("任务")));
  assert.equal(textWidth(lineText(table.rows[0]).split("完整项目任务")[0]), taskStart);
  assert.equal(textWidth(lineText(table.rows[1]).split("第二个任务")[0]), taskStart);
});

test("narrow overview layouts preserve room for the task instead of clipping it behind metadata", () => {
  for (const width of [20, 30, 40, 60, 80, 120]) {
    const table = overviewTable([loop({ task: "任务尾部".repeat(30) })], width);
    assert.ok(lineText(table.header).includes("任务"));
    assert.ok(lineText(table.rows[0]).includes("任务"));
    assert.equal(textWidth(table.header), width);
    assert.equal(textWidth(table.rows[0]), width);
    if (width < 72) assert.equal(lineText(table.header).includes("Space / Tab"), false);
  }
});

test("overview gives status and counts semantic emphasis without changing record data", () => {
  const statuses = { waiting: "warning", launching: "accent", running: "success", completed: "success", stopped: "muted", failed: "danger", expired: "muted" };
  for (const [status, tone] of Object.entries(statuses)) {
    const record = loop({ status });
    const before = JSON.stringify(record);
    const row = overviewTable([record], 100).rows[0];
    assert.ok(row.some(part => part?.tone === tone && part.bold));
    assert.equal(JSON.stringify(record), before);
  }
  const header = overviewHeader({ counts: { active: 2, total: 3, linked: 1, unlinked: 2, ended: 1 }, warnings: [], snapshotError: null }, { scope: "active", query: "" });
  assert.ok(lineText(header[0]).includes("记录中活跃 2"));
  assert.ok(header[0].some(part => part?.text === "2" && part.bold && part.tone === "warning"));
  assert.ok(lineText(header[1]).includes("视图：活跃"));
});

test("terminal renders trusted colors/bold only after safe clipping of record text", () => {
  const { terminal, writes } = screen(80, 12);
  terminal.render("总览", [[span("执行中", { tone: "success", bold: true }), " 原始\x1b[2J提示语", span(" x", { tone: "31m\x1b[2J" })]]);
  const raw = writes.join("");
  assert.ok(raw.includes("\x1b[1;32m执行中\x1b[0m"));
  assert.equal((raw.match(/\x1b\[2J/g) || []).length, 1);
  assert.ok(stripVTControlCharacters(raw).includes("原始[2J提示语"));
});

test("selected rows keep a consistent highlight and color-disabled terminals remain readable", () => {
  const selected = screen(80, 12);
  selected.terminal.render("总览", [[span("执行中", { tone: "success", bold: true }), " 任务"]], "帮助", 0);
  assert.ok(selected.writes.join("").includes("\x1b[7;1m执行中"));
  assert.equal(selected.writes.join("").includes("\x1b[7;1;32m"), false);
  const plain = screen(80, 12, false);
  plain.terminal.render("总览", [[span("执行中", { tone: "success", bold: true })]]);
  assert.equal(plain.writes.join("").includes("32m"), false);
  assert.ok(stripVTControlCharacters(plain.writes.join("")).includes("执行中"));
});
