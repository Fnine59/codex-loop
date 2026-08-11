import assert from "node:assert/strict";
import test from "node:test";
import { formatDuration, parseDuration } from "../src/duration.js";

test("parses supported durations", () => {
  assert.equal(parseDuration("5m"), 300_000);
  assert.equal(parseDuration("2h"), 7_200_000);
  assert.equal(parseDuration("1d"), 86_400_000);
});

test("rejects invalid and undersized durations", () => {
  assert.throws(() => parseDuration("five minutes"), /Invalid duration/);
  assert.throws(() => parseDuration("30s", { min: 60_000 }), /at least 1m/);
});

test("formats durations", () => {
  assert.equal(formatDuration(300_000), "5m");
  assert.equal(formatDuration(7_200_000), "2h");
});
