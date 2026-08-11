import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { ensureStore, storePaths } from "./store.js";

export function controlEndpoint(id, home) {
  if (process.platform === "win32") {
    const scope = createHash("sha256").update(home).digest("hex").slice(0, 8);
    return `\\\\.\\pipe\\codex-loop-${scope}-${id}`;
  }
  return path.join(storePaths(home).control, `${id}.sock`);
}

export async function createControlServer(id, home, onStop) {
  await ensureStore(home);
  const endpoint = controlEndpoint(id, home);
  if (process.platform !== "win32") await fs.rm(endpoint, { force: true });

  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let request = "";
    socket.on("data", (chunk) => {
      request += chunk;
      if (!request.includes("\n")) return;
      if (request.trim() === "stop") {
        onStop();
        socket.end("ok\n");
      } else {
        socket.end("error\n");
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  return async () => {
    await new Promise((resolve) => server.close(resolve));
    if (process.platform !== "win32") await fs.rm(endpoint, { force: true });
  };
}

export function sendStop(id, home, timeout = 500) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(controlEndpoint(id, home));
    const timer = setTimeout(() => finish(new Error("Worker control request timed out.")), timeout);
    let response = "";
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };

    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write("stop\n"));
    socket.on("data", (chunk) => {
      response += chunk;
      if (response.includes("ok\n")) finish();
      else if (response.includes("error\n")) finish(new Error("Worker rejected the stop request."));
    });
    socket.once("error", finish);
    socket.once("close", () => {
      if (!settled) finish(new Error("Worker closed the control connection without acknowledging stop."));
    });
  });
}
