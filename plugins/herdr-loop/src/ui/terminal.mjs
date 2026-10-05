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

const tones = { accent: 36, success: 32, warning: 33, danger: 31, muted: 90 };

// Styles are structured data, never escape sequences supplied by Loop records.
export function span(text, { tone = null, bold = false, dim = false } = {}) {
  return { text: String(text ?? ""), tone, bold, dim };
}

function segments(value) {
  return (Array.isArray(value) ? value : [value]).map(part =>
    part && typeof part === "object" ? span(part.text, part) : span(part));
}

export function lineText(value) {
  return segments(value).map(part => safeText(part.text)).join("");
}

export function textWidth(value) {
  return Array.from(lineText(value)).reduce((width, char) => width + cellWidth(char), 0);
}

function appendSegment(result, part, text) {
  const previous = result.at(-1);
  if (previous && previous.tone === part.tone && previous.bold === part.bold && previous.dim === part.dim) previous.text += text;
  else result.push({ ...part, text });
}

function clipSegments(value, width) {
  if (width < 1) return [];
  const result = [];
  let used = 0;
  for (const part of segments(value)) {
    for (const char of safeText(part.text)) {
      const cells = cellWidth(char);
      if (used + cells > width) {
        while (used + 1 > width && result.length) {
          const previous = result.at(-1);
          const chars = Array.from(previous.text);
          used -= cellWidth(chars.pop());
          previous.text = chars.join("");
          if (!previous.text) result.pop();
        }
        appendSegment(result, result.at(-1) || part, "…");
        return result;
      }
      appendSegment(result, part, char);
      used += cells;
    }
  }
  return result;
}

export function clip(value, width) { return lineText(clipSegments(value, width)); }

export function padText(value, width, align = "left") {
  const text = clip(value, width);
  const padding = " ".repeat(Math.max(0, width - textWidth(text)));
  return align === "right" ? padding + text : text + padding;
}

function wrapSegments(value, width) {
  const result = [[]];
  let used = 0;
  width = Math.max(1, width);
  for (const part of segments(value)) {
    // Preserve line breaks and blank lines; display tabs without moving the cursor.
    const text = part.text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
    for (const char of text) {
      if (char === "\n") { result.push([]); used = 0; continue; }
      if (!safeText(char)) continue;
      const cells = cellWidth(char);
      if (used && used + cells > width) { result.push([]); used = 0; }
      appendSegment(result.at(-1), part, char);
      used += cells;
    }
  }
  return result;
}

export function wrapText(value, width) { return wrapSegments(value, width).map(lineText); }

function paint(value, width, { selected = false, color = true } = {}) {
  return clipSegments(value, width).map(part => {
    const codes = [selected ? 7 : null, part.bold ? 1 : null, part.dim ? 2 : null,
      color && !selected ? tones[part.tone] : null].filter(Number.isInteger);
    return codes.length ? `\x1b[${codes.join(";")}m${part.text}\x1b[0m` : part.text;
  }).join("");
}

export class Terminal {
  constructor(input = process.stdin, output = process.stdout, { color = !("NO_COLOR" in process.env) && process.env.TERM !== "dumb" } = {}) {
    this.input = input;
    this.output = output;
    this.color = color;
    this.queue = [];
    this.waiter = null;
    this.onKey = (str, key = {}) => {
      const event = { str, ...key };
      if (this.waiter) { const resolve = this.waiter; this.waiter = null; resolve(event); }
      else if (this.queue.length < 512) this.queue.push(event);
    };
    this.onResize = () => this.onKey("", { name: "resize" });
  }
  start() {
    if (!this.input.isTTY || !this.output.isTTY) throw new Error("请在 Herdr 弹窗中打开此入口 / interactive terminal required");
    this.wasRaw = this.input.isRaw;
    emitKeypressEvents(this.input);
    this.input.setRawMode(true);
    this.input.resume();
    this.input.on("keypress", this.onKey);
    this.output.on("resize", this.onResize);
    this.output.write("\x1b[?1049h\x1b[?25l");
    this.started = true;
  }
  close() {
    if (!this.started) return;
    this.input.off("keypress", this.onKey);
    this.output.off("resize", this.onResize);
    this.input.setRawMode(!!this.wasRaw);
    this.input.pause();
    this.output.write("\x1b[?25h\x1b[?1049l");
  }
  get capacity() { return Math.max(3, (this.output.rows || 24) - 8); }
  get width() { return Math.max(20, (this.output.columns || 80) - 2); }
  render(title, lines, footer = "↑↓ 选择 · Enter 确认 · Esc 返回", selected = -1) {
    const width = this.width;
    const rows = this.output.rows || 24;
    const body = lines.slice(0, Math.max(1, rows - 4)).map((line, index) => paint(line, width, { selected: index === selected, color: this.color }));
    const heading = paint(span(title, { tone: "accent", bold: true }), width, { color: this.color });
    const help = paint(span(footer, { dim: true }), width, { color: this.color });
    this.output.write(`\x1b[H\x1b[2J${heading}\r\n\r\n${body.join("\r\n")}\r\n\x1b[${rows};1H${help}`);
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
  async view(title, lines, { actions = [], footer = "↑↓滚动 b/f翻页 g/G首尾 Esc返回" } = {}) {
    let offset = 0;
    let wrapped = [], wrapWidth = -1;
    this.queue.length = 0;
    for (;;) {
      if (wrapWidth !== this.width) {
        wrapWidth = this.width;
        wrapped = lines.flatMap(line => wrapSegments(line, wrapWidth));
      }
      const lastOffset = Math.max(0, wrapped.length - this.capacity);
      offset = Math.min(offset, lastOffset);
      this.render(title, wrapped.slice(offset, offset + this.capacity), footer);
      const key = await this.key();
      if (isCancel(key)) return null;
      if (actions.includes(key.str) || actions.includes(key.name)) return key.str || key.name;
      if (key.name === "up" || key.str === "k") offset = Math.max(0, offset - 1);
      if (key.name === "down" || key.str === "j") offset = Math.min(lastOffset, offset + 1);
      if (key.name === "pagedown" || key.str === "f") offset = Math.min(lastOffset, offset + this.capacity);
      if (key.name === "pageup" || key.str === "b") offset = Math.max(0, offset - this.capacity);
      if (key.name === "home" || key.str === "g") offset = 0;
      if (key.name === "end" || key.str === "G") offset = lastOffset;
    }
  }
  async notice(message) { await this.view("提示 / Notice", String(message).split("\n"), { actions: ["return"], footer: "Enter / Esc 返回" }); }
}

export function isCancel(key) { return key?.name === "escape" || key?.ctrl && key.name === "c"; }
