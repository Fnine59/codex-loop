#!/usr/bin/env node
import { HerdrClient, invocationContext } from "./herdr-client/client.mjs";
import { ConfigStore } from "./settings/store.mjs";
import { ReceiptStore } from "./launcher/receipts.mjs";
import { Terminal } from "./ui/terminal.mjs";
import { App, loadOverview } from "./ui/app.mjs";

const mode = process.argv[2] || "overview";
const client = new HerdrClient();
const configStore = new ConfigStore();
const receiptStore = new ReceiptStore();
let terminal;
try {
  if (mode.startsWith("open-")) {
    const entrypoint = mode.slice(5);
    if (!["overview", "launcher", "settings"].includes(entrypoint)) throw new Error("unknown entrypoint");
    await client.openPopup(entrypoint);
  } else if (mode === "status" || mode === "overview" && (!process.stdin.isTTY || process.argv.includes("--json"))) {
    const overview = await loadOverview(await configStore.load(), client);
    if (mode === "status") console.log(`Loop ${overview.counts.active} · 未关联 ${overview.loops.filter(loop => loop.recordedActive && !loop.association.linked).length}${overview.snapshotError ? " · Herdr离线" : ""}`);
    else console.log(JSON.stringify(overview, null, 2));
  } else {
    if (!["overview", "launcher", "settings"].includes(mode)) throw new Error("Usage: node src/index.mjs overview|launcher|settings|status|open-overview|open-launcher|open-settings");
    terminal = new Terminal();
    terminal.start();
    const app = new App(terminal, client, configStore, receiptStore, invocationContext());
    await app[mode]();
  }
} catch (error) {
  if (terminal?.started) await terminal.notice(error.message);
  else console.error(error.message);
  process.exitCode = 1;
} finally {
  terminal?.close();
}
