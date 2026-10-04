import { mkdir, open, readdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { atomicJson } from "../settings/store.mjs";

export class ReceiptStore {
  constructor(dir = process.env.HERDR_PLUGIN_STATE_DIR, socketPath = process.env.HERDR_SOCKET_PATH) {
    // Herdr shares plugin state across named servers, but terminal handles do not.
    const scope = socketPath ? createHash("sha256").update(socketPath).digest("hex").slice(0, 16) : "local";
    this.dir = dir ? path.join(dir, "launches", scope) : null;
  }
  filename(id) {
    if (!this.dir) throw new Error("缺少 Herdr 插件状态目录 / missing plugin state directory");
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("invalid launch ID");
    return path.join(this.dir, `${id}.json`);
  }
  async save(receipt) { await atomicJson(this.filename(receipt.id), { ...receipt, updatedAt: Date.now() }); }
  async load(id) { return JSON.parse(await readFile(this.filename(id), "utf8")); }
  async list() {
    if (!this.dir) return [];
    let entries;
    try { entries = await readdir(this.dir); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
    const receipts = [];
    for (const filename of entries) {
      if (!/^[a-f0-9-]{36}\.json$/.test(filename)) continue;
      try { receipts.push(await this.load(filename.slice(0, -5))); } catch { /* incomplete/corrupt receipt: never retry */ }
    }
    return receipts.sort((a, b) => b.createdAt - a.createdAt).slice(0, 30);
  }
  async claimSend(id) {
    const filename = `${this.filename(id)}.send-lock`;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      const handle = await open(filename, "wx", 0o600);
      await handle.close();
    } catch (error) {
      if (error.code === "EEXIST") {
        const claimed = new Error("已尝试发送；禁止重复注入 / prompt submission already attempted");
        claimed.code = "send_claimed";
        throw claimed;
      }
      throw error;
    }
  }
  async releaseBlocked(id) { await unlink(`${this.filename(id)}.send-lock`); }
}
