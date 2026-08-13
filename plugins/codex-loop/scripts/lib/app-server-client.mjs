import { createHash, randomBytes } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const MAX_FRAME_BYTES = 128 * 1024 * 1024;
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function defaultAppServerSocketPath() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(path.resolve(codexHome), "app-server-control", "app-server-control.sock");
}

function responseError(error) {
  if (!error) return new Error("App Server returned an unknown error.");
  const message = typeof error.message === "string" ? error.message : JSON.stringify(error);
  const result = new Error(`App Server: ${message}`);
  result.code = error.code;
  result.data = error.data;
  return result;
}

export function encodeWebSocketFrame(value, opcode = 0x1) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  if (payload.length > MAX_FRAME_BYTES) throw new Error("App Server WebSocket frame is too large.");
  const extendedBytes = payload.length < 126 ? 0 : payload.length <= 0xffff ? 2 : 8;
  const header = Buffer.alloc(2 + extendedBytes + 4);
  header[0] = 0x80 | opcode;
  if (extendedBytes === 0) header[1] = 0x80 | payload.length;
  else if (extendedBytes === 2) {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const maskOffset = 2 + extendedBytes;
  const mask = randomBytes(4);
  mask.copy(header, maskOffset);
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) masked[index] = payload[index] ^ mask[index % 4];
  return Buffer.concat([header, masked]);
}

class UnixWebSocketTransport {
  constructor(options = {}) {
    this.socketPath = options.socketPath ?? process.env.CODEX_LOOP_APP_SERVER_SOCKET ?? defaultAppServerSocketPath();
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.fragmentOpcode = null;
    this.fragments = [];
    this.handshakeComplete = false;
    this.closed = false;
    this.onMessage = () => {};
    this.onError = () => {};
  }

  connect() {
    return new Promise((resolve, reject) => {
      const key = randomBytes(16).toString("base64");
      const expectedAccept = createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => {
        finish(new Error(`Timed out connecting to App Server socket: ${this.socketPath}.`));
        this.close();
      }, this.connectTimeoutMs);

      this.socket = net.createConnection({ path: this.socketPath });
      this.socket.once("connect", () => {
        const request = [
          "GET / HTTP/1.1",
          "Host: localhost",
          "Connection: Upgrade",
          "Upgrade: websocket",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n");
        this.socket.write(request);
      });
      this.socket.on("data", (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        if (!this.handshakeComplete) {
          const boundary = this.buffer.indexOf("\r\n\r\n");
          if (boundary === -1) return;
          const response = this.buffer.subarray(0, boundary).toString("utf8");
          this.buffer = this.buffer.subarray(boundary + 4);
          const [status, ...headerLines] = response.split("\r\n");
          const headers = new Map(headerLines.map((line) => {
            const separator = line.indexOf(":");
            return [line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim()];
          }));
          if (!/^HTTP\/1\.[01] 101\b/.test(status) || headers.get("sec-websocket-accept") !== expectedAccept) {
            finish(new Error(`App Server rejected WebSocket upgrade: ${status}.`));
            this.close();
            return;
          }
          this.handshakeComplete = true;
          finish();
        }
        try {
          this.parseFrames();
        } catch (error) {
          this.onError(error);
          this.close();
        }
      });
      this.socket.once("error", (error) => {
        finish(error);
        if (this.handshakeComplete && !this.closed) this.onError(error);
      });
      this.socket.once("close", () => {
        if (!this.closed) {
          const error = new Error("App Server WebSocket closed unexpectedly.");
          finish(error);
          if (this.handshakeComplete) this.onError(error);
        }
      });
    });
  }

  parseFrames() {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const final = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const wideLength = this.buffer.readBigUInt64BE(2);
        if (wideLength > BigInt(MAX_FRAME_BYTES)) throw new Error("App Server WebSocket frame is too large.");
        length = Number(wideLength);
        offset = 10;
      }
      if (length > MAX_FRAME_BYTES) throw new Error("App Server WebSocket frame is too large.");
      const maskBytes = masked ? 4 : 0;
      if (this.buffer.length < offset + maskBytes + length) return;
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : null;
      offset += maskBytes;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      if (mask) {
        for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
      }

      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {
        this.socket.write(encodeWebSocketFrame(payload, 0xA));
        continue;
      }
      if (opcode === 0xA) continue;
      if (opcode === 0x1 || opcode === 0x2) {
        if (this.fragmentOpcode !== null) throw new Error("App Server sent overlapping WebSocket messages.");
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
      } else if (opcode === 0x0) {
        if (this.fragmentOpcode === null) throw new Error("App Server sent an unexpected continuation frame.");
        this.fragments.push(payload);
      } else {
        throw new Error(`Unsupported App Server WebSocket opcode: ${opcode}.`);
      }
      if (final) {
        const messageOpcode = this.fragmentOpcode;
        const message = Buffer.concat(this.fragments);
        this.fragmentOpcode = null;
        this.fragments = [];
        if (messageOpcode !== 0x1) throw new Error("App Server sent a non-text WebSocket message.");
        this.onMessage(message.toString("utf8"));
      }
    }
  }

  send(message) {
    if (!this.socket || !this.handshakeComplete || this.closed) {
      throw new Error("App Server WebSocket is not connected.");
    }
    this.socket.write(encodeWebSocketFrame(message));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.socket && this.handshakeComplete && !this.socket.destroyed) {
      try {
        this.socket.write(encodeWebSocketFrame(Buffer.alloc(0), 0x8));
      } catch {
        // Socket shutdown remains best-effort.
      }
    }
    this.socket?.end();
    this.socket?.destroy();
  }
}

export class AppServerClient {
  constructor(options = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.transport = options.transport ?? new UnixWebSocketTransport(options);
    this.nextId = 1;
    this.pending = new Map();
    this.onNotification = options.onNotification ?? (() => {});
    this.connected = false;
    this.closed = false;
  }

  async connect() {
    if (this.connected) return this;
    this.transport.onMessage = (message) => this.handleMessage(message);
    this.transport.onError = (error) => this.fail(error);
    await this.transport.connect();
    this.connected = true;
    await this.request("initialize", {
      clientInfo: { name: "codex-loop", title: "Codex Loop", version: "0.2.0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized");
    return this;
  }

  handleMessage(source) {
    let message;
    try {
      message = JSON.parse(source);
    } catch {
      return;
    }
    if (message.method && message.id === undefined) {
      this.onNotification(message);
      return;
    }
    if (message.method || message.id === undefined || !this.pending.has(message.id)) return;
    const pending = this.pending.get(message.id);
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error !== undefined) pending.reject(responseError(message.error));
    else pending.resolve(message.result);
  }

  request(method, params = {}) {
    if (!this.connected || this.closed) return Promise.reject(new Error("App Server client is not connected."));
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`App Server request timed out: ${method}.`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { reject, resolve, timer });
      try {
        this.transport.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params) {
    if (!this.connected || this.closed) return;
    const message = params === undefined ? { method } : { method, params };
    this.transport.send(JSON.stringify(message));
  }

  async listLoadedThreadIds() {
    const result = [];
    let cursor = null;
    do {
      const page = await this.request("thread/loaded/list", { cursor, limit: 100 });
      result.push(...(page?.data ?? []));
      cursor = page?.nextCursor ?? null;
    } while (cursor && result.length < 1_000);
    return result;
  }

  async readThread(threadId, includeTurns = false) {
    const result = await this.request("thread/read", { threadId, includeTurns });
    return result?.thread ?? null;
  }

  async startTurn(threadId, prompt, cwd = null) {
    const params = {
      threadId,
      input: [{ type: "text", text: prompt }],
    };
    if (cwd) params.cwd = cwd;
    const result = await this.request("turn/start", params);
    return result?.turn ?? null;
  }

  async interruptTurn(threadId, turnId) {
    return this.request("turn/interrupt", { threadId, turnId });
  }

  async cleanBackgroundTerminals(threadId) {
    return this.request("thread/backgroundTerminals/clean", { threadId });
  }

  fail(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.fail(new Error("App Server client closed."));
    this.transport.close();
  }
}

export async function withAppServerClient(callback, options = {}) {
  const client = options.client ?? new AppServerClient(options);
  const owned = !options.client;
  try {
    if (owned) await client.connect();
    return await callback(client);
  } finally {
    if (owned) client.close();
  }
}

export async function findCurrentAppServerThread(input, options = {}) {
  return withAppServerClient(async (client) => {
    const ids = await client.listLoadedThreadIds();
    if (ids.length === 0) return null;
    if (ids.includes(input.session_id)) return client.readThread(input.session_id, false);

    const threads = (await Promise.all(ids.map(async (id) => {
      try {
        return await client.readThread(id, false);
      } catch {
        return null;
      }
    }))).filter(Boolean);
    const sameSession = threads.filter((thread) => thread.sessionId === input.session_id);
    if (sameSession.length === 1) return sameSession[0];
    if (!input.turn_id) return null;
    const withTurns = await Promise.all(sameSession.map(async (thread) => {
      try {
        return await client.readThread(thread.id, true);
      } catch {
        return null;
      }
    }));
    return withTurns.find((thread) => thread?.turns?.some((turn) => turn.id === input.turn_id)) ?? null;
  }, options);
}

export async function detectAppServerRuntime(input, options = {}) {
  try {
    const thread = await findCurrentAppServerThread(input, options);
    return thread ? { backend: "app-server", threadId: thread.id } : { backend: "stop-hook" };
  } catch {
    return { backend: "stop-hook" };
  }
}

export async function readAppServerTurnStatus(threadId, turnId, options = {}) {
  try {
    return await withAppServerClient(async (client) => {
      const thread = await client.readThread(threadId, true);
      return thread?.turns?.find((turn) => turn.id === turnId)?.status ?? null;
    }, options);
  } catch {
    return null;
  }
}
