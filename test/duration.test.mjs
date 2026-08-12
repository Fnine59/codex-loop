import assert from "node:assert/strict";
import test from "node:test";
import { formatDuration, parseDuration } from "../plugins/codex-loop/scripts/lib/duration.mjs";

test("parses and formats loop durations", () => {
  assert.equal(parseDuration("1s"), 1_000);
  assert.equal(parseDuration("5m"), 300_000);
  assert.equal(parseDuration("2h"), 7_200_000);
  assert.equal(formatDuration(86_400_000), "1d");
});

test("rejects malformed or unsafe intervals", () => {
  assert.throws(() => parseDuration("500ms"), /Invalid duration/);
  assert.throws(() => parseDuration("0s"), /between 1s and 7d/);
  assert.throws(() => parseDuration("8d"), /between 1s and 7d/);
});
