import { stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { resolvePrompt, validateConfig } from "../settings/store.mjs";

export const RESUMABLE_STAGES = new Set(["awaiting-ready", "blocked-no-prompt", "timed-out-no-prompt", "cancelled-no-prompt"]);

export class LaunchError extends Error {
  constructor(message, stage) { super(message); this.stage = stage; }
}

function checkCancelled(signal) {
  if (signal?.aborted) throw new LaunchError("等待已取消；终端保留，提示语未发送 / cancelled, terminal kept", "cancelled-no-prompt");
}

export async function prepareLaunch(preset, config) {
  const validated = validateConfig({ ...config, presets: [preset] });
  const readyPreset = validated.presets[0];
  if (!(await stat(readyPreset.cwd)).isDirectory()) throw new Error("项目路径不是目录 / project path is not a directory");
  return {
    preset: readyPreset,
    command: readyPreset.command || validated.defaults.command,
    // Snapshot the Markdown once, before confirmation and before any mutation.
    prompt: await resolvePrompt(readyPreset),
    readyTimeoutMs: validated.defaults.readyTimeoutMs,
  };
}

export function resolveTarget(snapshot, target) {
  if (target.mode === "new-workspace") return { ...target };
  const workspace = snapshot.workspaces.find(item => item.workspace_id === target.workspaceId);
  if (!workspace) throw new Error("Space 已关闭，请重新选择 / Space no longer exists");
  if (target.mode === "new-tab") return { ...target };
  if (target.mode !== "existing-tab") throw new Error("invalid launch target");
  const tab = snapshot.tabs.find(item => item.tab_id === target.tabId && item.workspace_id === target.workspaceId);
  if (!tab) throw new Error("Tab 已关闭或移动，请重新选择 / Tab no longer exists here");
  const panes = snapshot.panes.filter(item => item.tab_id === tab.tab_id && item.workspace_id === workspace.workspace_id);
  const anchor = panes.find(item => item.pane_id === target.anchorPaneId) || panes.find(item => item.focused) || panes[0];
  if (!anchor) throw new Error("Tab 没有可用的终端 / Tab has no terminal");
  return { ...target, anchorPaneId: anchor.pane_id };
}

function liveTerminal(snapshot, terminalId) {
  const panes = snapshot.panes.filter(item => item.terminal_id === terminalId);
  if (panes.length !== 1) throw new LaunchError("启动终端已关闭或无法定位；未发送 / launch terminal unavailable", "terminal-lost-no-prompt");
  return panes[0];
}

async function waitForShell(client, terminalId, options) {
  const deadline = options.now() + options.timeoutMs;
  while (options.now() < deadline) {
    checkCancelled(options.signal);
    const pane = liveTerminal(await client.snapshot(), terminalId);
    if (await client.shellReady(pane.pane_id) && options.now() < deadline) return pane;
    options.onUpdate?.("等待项目终端的交互式 Shell 就绪… / Waiting for shell…");
    await options.sleep(options.pollMs, options.signal);
  }
  throw new LaunchError("Shell 未就绪，命令未发送 / shell timeout; command not sent", "shell-timeout-no-command");
}

async function waitForAgent(client, terminalId, options) {
  const deadline = options.now() + options.timeoutMs;
  while (options.now() < deadline) {
    checkCancelled(options.signal);
    const snapshot = await client.snapshot();
    if (options.now() >= deadline) break;
    const pane = liveTerminal(snapshot, terminalId);
    const agent = snapshot.agents.find(item => item.terminal_id === terminalId && item.pane_id === pane.pane_id);
    if (agent?.agent === "codex") {
      await options.onAgent?.(pane, agent);
      if (agent.agent_status === "blocked") throw new LaunchError("Codex 正在等待确认；请跳转处理后，手动继续发送 / Codex blocked; resolve in terminal first", "blocked-no-prompt");
      if (agent.agent_status === "working") throw new LaunchError("启动命令已让 Codex 工作，不能保证首轮；未注入 / already working; first-turn injection refused", "already-working-no-prompt");
      // 0.9.3 may omit interactive_ready. Its documented idle/done states are
      // ready for input; an explicit false from newer servers still vetoes it.
      if (["idle", "done"].includes(agent.agent_status) && agent.interactive_ready !== false && !agent.launch_pending) {
        return { pane, agent };
      }
    } else if (agent?.agent) {
      throw new LaunchError("启动的不是 Codex；未发送 Loop 提示语 / unexpected agent", "wrong-agent-no-prompt");
    }
    options.onUpdate?.("等待 Codex 就绪；不会接受授权弹窗… / Waiting for Codex…");
    await options.sleep(options.pollMs, options.signal);
  }
  throw new LaunchError("Codex 就绪超时，提示语未发送 / readiness timeout; prompt not sent", "timed-out-no-prompt");
}

function waitOptions(prepared, options) {
  return {
    timeoutMs: prepared.readyTimeoutMs,
    pollMs: 350,
    now: Date.now,
    sleep: async (ms, signal) => {
      try { await delay(ms, undefined, { signal }); }
      catch (error) { if (signal?.aborted) checkCancelled(signal); throw error; }
    },
    ...options,
  };
}

async function submit(receipt, client, store, options) {
  const { pane, agent } = await waitForAgent(client, receipt.terminalId, {
    ...options,
    onAgent: async (currentPane, currentAgent) => {
      const identity = currentAgent.agent_session;
      if (receipt.agentSession?.kind === "id" &&
          (identity?.kind !== "id" || identity.value !== receipt.agentSession.value || identity.agent !== "codex")) {
        throw new LaunchError("原 Codex 会话已被替换，未发送 / original Codex session replaced", "session-replaced-no-prompt");
      }
      if (!receipt.agentSession && identity?.agent === "codex" && identity.kind === "id") {
        receipt.agentSession = identity;
        receipt.paneId = currentPane.pane_id;
        // Persist at the guarded submission or failure boundary. Writing here
        // could let a competing resume overwrite another popup's submission.
      }
    },
  });
  checkCancelled(options.signal);
  await store.claimSend(receipt.id);
  receipt.stage = "sending";
  receipt.paneId = pane.pane_id;
  receipt.agentSession = agent.agent_session ?? null;
  receipt.sendAttemptedAt = Date.now();
  await store.save(receipt);
  options.onUpdate?.("发送首轮提示语一次… / Submitting first prompt once…");
  // Do not abort or retry an in-flight mutation: acknowledgement could be lost.
  try {
    await client.prompt(pane.pane_id, receipt.prompt);
  } catch (error) {
    if (error.code === "agent_blocked" && error.uncertain === false) {
      receipt.stage = "blocked-no-prompt";
      receipt.sendAttemptedAt = null;
      await store.save(receipt);
      await store.releaseBlocked(receipt.id);
    } else {
      receipt.stage = "delivery-unknown";
      receipt.prompt = null;
      await store.save(receipt);
    }
    throw error;
  }
  receipt.stage = "sent";
  receipt.error = null;
  receipt.sentAt = Date.now();
  receipt.prompt = null;
  await store.save(receipt);
  return receipt;
}

async function saveFailure(receipt, error, store) {
  if (!["sending", "delivery-unknown", "sent"].includes(receipt.stage)) {
    if (receipt.stage === "command-attempted") receipt.stage = "command-outcome-unknown";
    else if (receipt.stage === "creating-terminal") receipt.stage = "creation-outcome-unknown";
    else if (error.code === "agent_blocked" && error.uncertain === false) receipt.stage = "blocked-no-prompt";
    else receipt.stage = error.stage || "failed-no-prompt";
    if (receipt.stage === "cancelled-no-prompt" && !receipt.commandAcknowledged) receipt.stage = "cancelled-no-command";
  }
  receipt.error = error.message;
  await store.save(receipt);
  // A single structured result retains the exact new terminal for safe recovery.
  return receipt;
}

export async function launchOnce(prepared, target, client, store, options = {}) {
  const wait = waitOptions(prepared, options);
  checkCancelled(wait.signal);
  const resolved = resolveTarget(await client.snapshot(), target);
  const receipt = {
    id: randomUUID(), presetId: prepared.preset.id, name: prepared.preset.name,
    createdAt: Date.now(), stage: "prepared", target: resolved,
    prompt: prepared.prompt, promptHash: createHash("sha256").update(prepared.prompt).digest("hex"),
    readyTimeoutMs: prepared.readyTimeoutMs, terminalId: null, paneId: null, sendAttemptedAt: null,
  };
  await store.save(receipt); // Fail before creating anything if private state is unavailable.
  try {
    checkCancelled(wait.signal);
    receipt.stage = "creating-terminal";
    await store.save(receipt);
    const pane = resolved.mode === "new-workspace"
      ? await client.createWorkspace(prepared.preset.cwd, prepared.preset.name)
      : resolved.mode === "new-tab"
        ? await client.createTab(resolved.workspaceId, prepared.preset.cwd, prepared.preset.name)
        : await client.split(resolved.anchorPaneId, resolved.direction || "right", prepared.preset.cwd);
    if (!pane?.terminal_id || !pane.pane_id) throw new Error("创建终端响应不完整；请检查 Herdr / incomplete terminal response");
    receipt.terminalId = pane.terminal_id;
    receipt.paneId = pane.pane_id;
    receipt.stage = "awaiting-shell";
    await store.save(receipt);
    const shell = await waitForShell(client, receipt.terminalId, wait);
    checkCancelled(wait.signal);
    receipt.stage = "command-attempted";
    await store.save(receipt);
    await client.runCommand(shell.pane_id, prepared.command);
    receipt.commandAcknowledged = true;
    receipt.stage = "awaiting-ready";
    await store.save(receipt);
    return await submit(receipt, client, store, wait);
  } catch (error) {
    return saveFailure(receipt, error, store);
  }
}

export async function resumeLaunch(id, client, store, options = {}) {
  const receipt = await store.load(id);
  if (!RESUMABLE_STAGES.has(receipt.stage) || !receipt.commandAcknowledged || receipt.sendAttemptedAt || !receipt.prompt || !receipt.terminalId) {
    throw new Error("此启动不能安全重发，请检查原会话 / this launch cannot be safely retried");
  }
  try {
    return await submit(receipt, client, store, waitOptions(receipt, options));
  } catch (error) {
    if (error.code === "send_claimed") {
      const latest = await store.load(id);
      // Do not overwrite the successful/ongoing submission from another popup.
      return RESUMABLE_STAGES.has(latest.stage) ? { ...latest, stage: "submission-locked", error: error.message } : latest;
    }
    return saveFailure(receipt, error, store);
  }
}

export async function focusReceipt(receipt, client) {
  const pane = liveTerminal(await client.snapshot(), receipt.terminalId);
  if (receipt.agentSession?.kind === "id" &&
      (pane.agent_session?.kind !== "id" || pane.agent_session.agent !== "codex" ||
       pane.agent_session.value !== receipt.agentSession.value || pane.agent !== "codex")) {
    throw new Error("终端的原会话已被替换，未跳转 / original session replaced");
  }
  if (pane.agent) await client.focus(pane.pane_id);
  else await client.focusPane(pane.pane_id);
}
