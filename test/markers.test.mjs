import assert from "node:assert/strict";
import test from "node:test";
import {
  createControlMarker,
  createStartMarker,
  parseControlMarker,
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

test("rejects invalid marker payloads", () => {
  assert.throws(() => createStartMarker("not-an-id"), /Invalid loop ID/);
  assert.equal(parseStartMarker("<!-- codex-loop:v1:start:not-an-id -->"), null);
});
