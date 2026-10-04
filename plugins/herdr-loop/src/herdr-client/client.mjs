import { execFile } from "node:child_process";
import { promisify } from "node:util";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { PLUGIN_ID } from "../settings/store.mjs";

const execute = promisify(execFile);
export class HerdrError extends Error {
  constructor(message, code = "transport_error", { uncertain = true } = {}) {
    super(message);
    this.code = code;
    this.uncertain = uncertain;
  }
}

export class HerdrClient {
  constructor({ env = process.env, run = execute } = {}) {
    this.env = env;
    this.binary = env.HERDR_BIN_PATH || "herdr";
    this.run = run;
  }
  async call(args, { signal, timeout = 10_000, allowEmptyAck = false } = {}) {
    let stdout;
    try {
      ({ stdout } = await this.run(this.binary, args, { env: this.env, signal, timeout, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }));
    } catch (error) {
      let body;
      try { body = JSON.parse(error.stderr)?.error; } catch { /* CLI syntax/transport error */ }
      throw new HerdrError(body?.message || error.message, body?.code || error.code, {
        // Herdr promises no input for agent_blocked; all other delivery errors are ambiguous.
        uncertain: body?.code !== "agent_blocked",
      });
    }
    // pane.run uses Herdr's send_ok_request: exit 0, deliberately no stdout.
    if (allowEmptyAck && !stdout.trim()) return { type: "ok" };
    let response;
    try { response = JSON.parse(stdout); } catch { throw new HerdrError("Herdr 返回了非 JSON 响应 / invalid Herdr response"); }
    if (response.error) throw new HerdrError(response.error.message, response.error.code, { uncertain: response.error.code !== "agent_blocked" });
    if (!response.result) throw new HerdrError("Herdr 响应缺少 result / missing result");
    return response.result;
  }
  async snapshot(options) {
    const snapshot = (await this.call(["api", "snapshot"], options)).snapshot;
    if (!snapshot || !["panes", "agents", "workspaces", "tabs"].every(key => Array.isArray(snapshot[key]))) {
      throw new HerdrError("Herdr 布局响应不完整 / invalid session snapshot");
    }
    return snapshot;
  }
  async focus(id) { return this.call(["agent", "focus", id]); }
  async focusPane(id) {
    // Herdr's CLI pane focus accepts directions, not an exact pane ID. The
    // socket API is needed only to navigate a failed launch's ordinary shell.
    if (!this.env.HERDR_SOCKET_PATH) throw new Error("缺少 Herdr socket，请从插件入口打开 / open through Herdr");
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.env.HERDR_SOCKET_PATH);
      let buffer = "", finished = false;
      const finish = (error, result) => {
        if (finished) return;
        finished = true;
        socket.destroy();
        if (error) reject(error); else resolve(result);
      };
      socket.setEncoding("utf8");
      socket.setTimeout(10_000, () => finish(new HerdrError("Herdr focus timeout")));
      socket.on("connect", () => socket.write(`${JSON.stringify({ id: randomUUID(), method: "pane.focus", params: { pane_id: id } })}\n`));
      socket.on("error", error => finish(error));
      socket.on("end", () => finish(new HerdrError("Herdr focus connection closed")));
      socket.on("data", chunk => {
        buffer += chunk;
        if (buffer.length > 1024 * 1024) return finish(new HerdrError("oversized focus response"));
        if (!buffer.includes("\n")) return;
        try {
          const response = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
          if (response.error) finish(new HerdrError(response.error.message, response.error.code));
          else if (!response.result) finish(new HerdrError("invalid focus response"));
          else finish(null, response.result);
        } catch (error) { finish(error); }
      });
    });
  }
  async openPopup(entrypoint) {
    return this.call(["plugin", "pane", "open", "--plugin", PLUGIN_ID, "--entrypoint", entrypoint]);
  }
  async createWorkspace(cwd, label, options) {
    return (await this.call(["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus"], options)).root_pane;
  }
  async createTab(workspaceId, cwd, label, options) {
    return (await this.call(["tab", "create", "--workspace", workspaceId, "--cwd", cwd, "--label", label, "--no-focus"], options)).root_pane;
  }
  async split(paneId, direction, cwd, options) {
    return (await this.call(["pane", "split", paneId, "--direction", direction, "--cwd", cwd, "--no-focus"], options)).pane;
  }
  // These CLI commands take literal positional text, NOT a '--' separator.
  async runCommand(paneId, command, options) { return this.call(["pane", "run", paneId, command], { ...options, allowEmptyAck: true }); }
  async prompt(paneId, prompt) { return this.call(["agent", "prompt", paneId, prompt]); }
  async shellReady(paneId, options) {
    const info = (await this.call(["pane", "process-info", "--pane", paneId], options)).process_info;
    return !!info.shell_pid && info.foreground_process_group_id === info.shell_pid &&
      info.foreground_processes?.length > 0 && info.foreground_processes.every(item =>
        item.pid === info.shell_pid && /^(?:zsh|bash|sh|dash|ksh|fish|tcsh|csh|nu|xonsh|elvish|pwsh)$/.test(item.name?.replace(/^-/, "")));
  }
}

export function invocationContext(env = process.env) {
  let context = {};
  try { context = JSON.parse(env.HERDR_PLUGIN_CONTEXT_JSON || "{}"); } catch { /* optional context */ }
  return {
    workspaceId: context.workspace_id || env.HERDR_WORKSPACE_ID || null,
    tabId: context.tab_id || env.HERDR_TAB_ID || null,
    paneId: context.focused_pane_id || env.HERDR_PANE_ID || null,
    cwd: context.focused_pane_cwd || context.workspace_cwd || process.cwd(),
  };
}
