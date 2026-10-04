import { readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
async function check(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await check(file);
    else if (entry.name.endsWith(".mjs")) execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
  }
}
await Promise.all(["src", "test", "scripts"].map(dir => check(path.join(root, dir))));
