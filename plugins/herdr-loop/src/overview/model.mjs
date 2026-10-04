import { ACTIVE_STATUSES } from "./discovery.mjs";

export function associateLoop(loop, snapshot) {
  const identities = new Set([loop.sessionId, loop.threadId].filter(value => typeof value === "string" && value));
  const matches = (snapshot?.panes ?? []).filter(pane => {
    const identity = pane.agent_session;
    return identity?.agent === "codex" && identity.kind === "id" && identities.has(identity.value) &&
      pane.agent === "codex";
  });
  if (matches.length !== 1) return { linked: false, reason: matches.length ? "ambiguous" : "unlinked" };
  const pane = matches[0];
  const workspace = snapshot.workspaces.find(item => item.workspace_id === pane.workspace_id);
  const tab = snapshot.tabs.find(item => item.tab_id === pane.tab_id);
  return { linked: true, pane, workspace, tab };
}

export function makeOverview(scan, snapshot = null, snapshotError = null) {
  const loops = scan.loops.map(loop => ({ ...loop, association: associateLoop(loop, snapshot), recordedActive: ACTIVE_STATUSES.has(loop.status) }));
  return {
    loops,
    counts: {
      total: loops.length,
      active: loops.filter(loop => loop.recordedActive).length,
      linked: loops.filter(loop => loop.association.linked).length,
      unlinked: loops.filter(loop => !loop.association.linked).length,
      ended: loops.filter(loop => !loop.recordedActive).length,
    },
    warnings: scan.warnings,
    sources: scan.sources,
    snapshotError,
  };
}

export function filterLoops(overview, { query = "", scope = "active", workspaceId = null } = {}) {
  const needle = query.toLocaleLowerCase();
  return overview.loops.filter(loop => {
    if (scope === "active" && !loop.recordedActive) return false;
    if (scope === "unlinked" && loop.association.linked) return false;
    if (scope === "workspace" && loop.association.pane?.workspace_id !== workspaceId) return false;
    return [loop.id, loop.task, loop.cwd, loop.status, loop.association.workspace?.label, loop.association.tab?.label]
      .some(value => typeof value === "string" && value.toLocaleLowerCase().includes(needle));
  });
}

export async function focusLoop(loop, client) {
  const association = associateLoop(loop, await client.snapshot());
  if (!association.linked) throw new Error(association.reason === "ambiguous" ? "多个会话匹配，未跳转 / ambiguous session" : "当前会话未关联，未跳转 / session is unlinked");
  await client.focus(association.pane.pane_id);
  return association;
}
