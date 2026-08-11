#!/usr/bin/env node

if (process.argv.includes("--version")) {
  console.log("fake-codex 1.0.0");
  process.exit(0);
}

const prompt = process.argv.at(-1);
console.log(JSON.stringify({ type: "thread.started", thread_id: "fake-session" }));

setTimeout(() => {
  console.log(
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "done" },
    }),
  );
}, prompt === "hold" ? 10_000 : 0);
