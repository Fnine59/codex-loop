import { emitKeypressEvents } from "node:readline";

export function safeText(value) {
  return String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, char => char === "\n" ? " " : "");
}

function cellWidth(char) {
  if (/\p{Mark}/u.test(char) || char === "\u200d" || char === "\ufe0f") return 0;
  const code = char.codePointAt(0);
  return code >= 0x1100 && (code <= 0x115f || code >= 0x2e80 && code <= 0xa4cf ||
    code >= 0xac00 && code <= 0xd7a3 || code >= 0xf900 && code <= 0xfaff ||
    code >= 0xfe10 && code <= 0xfe6f || code >= 0xff01 && code <= 0xff60 || code >= 0x1f300) ? 2 : 1;
}

export function clip(value, width) {
  let result = "";
  let used = 0;
  const clean = safeText(value);
  for (const char of clean) {
    const cells = cellWidth(char);
    if (used + cells > width) return `${result.slice(0, -1)}…`;
    used += cells;
    result += char;
  }
  return result;
}

export function wrapText(value, width) {
  const result = [];
  for (const line of String(value).split("\n")) {
    let chunk = "", used = 0;
    for (const char of safeText(line)) {
      const cells = cellWidth(char);
      if (used + cells > width) { result.push(chunk); chunk = ""; used = 0; }
      chunk += char; used += cells;
    }
    result.push(chunk);
  }
  return result;
}

export class Terminal {
  constructor(input = process.stdin, output = process.stdout) {
    this.input = input;
    this.output = output;
    this.queue = [];
    this.waiter = null;
    this.onKey = (str, key = {}) => {
      const event = { str, ...key };
      if (this.waiter) { const resolve = this.waiter; this.waiter = null; resolve(event); }
      else if (this.queue.length < 512) this.queue.push(event);
    };
  }
  start() {
    if (!this.input.isTTY || !this.output.isTTY) throw new Error("请在 Herdr 弹窗中打开此入口 / interactive terminal required");
    this.wasRaw = this.input.isRaw;
    emitKeypressEvents(this.input);
    this.input.setRawMode(true);
    this.input.resume();
    this.input.on("keypress", this.onKey);
    this.output.write("\x1b[?1049h\x1b[?25l");
    this.started = true;
  }
  close() {
    if (!this.started) return;
    this.input.off("keypress", this.onKey);
    this.input.setRawMode(!!this.wasRaw);
    this.input.pause();
    this.output.write("\x1b[?25h\x1b[?1049l");
  }
  get capacity() { return Math.max(3, (this.output.rows || 24) - 8); }
  render(title, lines, footer = "↑↓ 选择 · Enter 确认 · Esc 返回", selected = -1) {
    const width = Math.max(20, (this.output.columns || 80) - 2);
    const rows = this.output.rows || 24;
    const body = lines.slice(0, Math.max(1, rows - 4)).map((line, index) => {
      const value = clip(line, width);
      return index === selected ? `\x1b[7m${value}\x1b[0m` : value;
    });
    this.output.write(`\x1b[H\x1b[2J\x1b[1;36m${clip(title, width)}\x1b[0m\r\n\r\n${body.join("\r\n")}\r\n\x1b[${rows};1H\x1b[2m${clip(footer, width)}\x1b[0m`);
  }
  async key(timeout = null) {
    if (this.queue.length) return this.queue.shift();
    return new Promise(resolve => {
      let timer;
      const finish = event => { if (timer) clearTimeout(timer); if (this.waiter === finish) this.waiter = null; resolve(event); };
      this.waiter = finish;
      if (timeout !== null) timer = setTimeout(() => finish(null), timeout);
    });
  }
  async menu(title, items, { header = [], footer, initial = 0, shortcuts = [] } = {}) {
    let selected = Math.max(0, Math.min(initial, items.length - 1));
    this.queue.length = 0;
    for (;;) {
      const limit = Math.max(2, this.capacity - header.length);
      const start = Math.max(0, selected - limit + 1);
      const visible = items.slice(start, start + limit);
      this.render(title, [...header, "", ...visible.map((item, index) => `${start + index === selected ? "›" : " "} ${item.label}`)], footer, header.length + 1 + selected - start);
      const key = await this.key();
      if (isCancel(key)) return null;
      if (key.name === "up" || key.str === "k") selected = Math.max(0, selected - 1);
      else if (key.name === "down" || key.str === "j") selected = Math.min(items.length - 1, selected + 1);
      else if (key.name === "home") selected = 0;
      else if (key.name === "end") selected = Math.max(0, items.length - 1);
      else if (key.name === "return" && items[selected]) return { value: items[selected].value, index: selected };
      else if (shortcuts.includes(key.str)) return { shortcut: key.str, index: selected, value: items[selected]?.value };
    }
  }
  async inputText(title, initial = "", { multiline = false, hint = "" } = {}) {
    let value = initial;
    this.queue.length = 0;
    for (;;) {
      const preview = wrapText(`${value}▏`, Math.max(16, (this.output.columns || 80) - 4));
      this.render(title, [hint, "", ...preview.slice(-Math.max(2, this.capacity - 2))], multiline ? "Enter 换行 · Ctrl+D 保存 · Ctrl+U 清空 · Ctrl+G 取消" : "Enter 保存 · Ctrl+U 清空 · Esc 取消");
      const key = await this.key();
      if (key.ctrl && key.name === "g" || isCancel(key)) return null;
      if (key.ctrl && key.name === "u") value = "";
      else if (multiline && key.ctrl && key.name === "d" || !multiline && key.name === "return") return value;
      else if (key.name === "backspace") value = Array.from(value).slice(0, -1).join("");
      else if (key.name === "return" && multiline) value += "\n";
      else if (!key.ctrl && !key.meta && key.str && !/[\x00-\x1f\x7f-\x9f]/.test(key.str) && value.length < 65536) value += key.str;
    }
  }
  async view(title, lines, { actions = [], footer = "↑↓ 滚动 · Esc 返回" } = {}) {
    let offset = 0;
    this.queue.length = 0;
    for (;;) {
      this.render(title, lines.slice(offset, offset + this.capacity), footer);
      const key = await this.key();
      if (isCancel(key)) return null;
      if (actions.includes(key.str) || actions.includes(key.name)) return key.str || key.name;
      if (key.name === "up" || key.str === "k") offset = Math.max(0, offset - 1);
      if (key.name === "down" || key.str === "j") offset = Math.min(Math.max(0, lines.length - this.capacity), offset + 1);
      if (key.name === "pagedown") offset = Math.min(Math.max(0, lines.length - this.capacity), offset + this.capacity);
      if (key.name === "pageup") offset = Math.max(0, offset - this.capacity);
    }
  }
  async notice(message) { await this.view("提示 / Notice", String(message).split("\n"), { actions: ["return"], footer: "Enter / Esc 返回" }); }
}

export function isCancel(key) { return key?.name === "escape" || key?.ctrl && key.name === "c"; }
