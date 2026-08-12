import assert from "node:assert/strict";
import test from "node:test";
import {
  createControlMarker,
  createNextMarker,
  createStartMarker,
  parseControlMarker,
  parseNextMarker,
  parseStartMarker,
} from "../plugins/codex-loop/scripts/lib/markers.mjs";

const config = {
  v: 1,
  id: "a1b2c3d4e5f6",
  task: "run tests",
  until: "all tests pass",
  intervalMs: 1_000,
  ttlMs: 10_000,
  maxRuns: 3,
  immediate: true,
};

test("round-trips a validated start marker", () => {
  const marker = createStartMarker(config.id);
  assert.equal(parseStartMarker(`started\n${marker}`), config.id);
});

test("parses stop and completion markers", () => {
  assert.deepEqual(parseControlMarker(createControlMarker("stop")), { action: "stop", id: null });
  assert.deepEqual(parseControlMarker(createControlMarker("complete", config.id)), {
    action: "complete",
    id: config.id,
  });
});

test("round-trips bounded dynamic next-delay markers", () => {
  const marker = createNextMarker(config.id, "1h");
  assert.deepEqual(parseNextMarker(marker), {
    id: config.id,
    duration: "1h",
    delayMs: 3_600_000,
  });
  assert.throws(() => createNextMarker(config.id, "30s"), /between 1m and 1h/);
  assert.throws(() => createNextMarker(config.id, "2h"), /between 1m and 1h/);
});

test("keeps invalid dynamic delays parseable for fallback", () => {
  assert.deepEqual(parseNextMarker(`<!-- codex-loop:v1:next:${config.id}:30s -->`), {
    id: config.id,
    duration: "30s",
    delayMs: null,
  });
  assert.equal(parseNextMarker("No scheduling marker."), null);
});

test("rejects invalid marker payloads", () => {
  assert.throws(() => createStartMarker("not-an-id"), /Invalid loop ID/);
  assert.equal(parseStartMarker("<!-- codex-loop:v1:start:not-an-id -->"), null);
});
