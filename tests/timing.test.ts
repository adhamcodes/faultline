import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  intervalOverlapMs,
  maximumConcurrency,
  summarizeTiming,
  type CompletedInterval,
} from "../src/timing.js";

const intervals: CompletedInterval[] = [
  { name: "telemetry", startedAtMs: 0, finishedAtMs: 100 },
  { name: "logs", startedAtMs: 10, finishedAtMs: 90 },
  { name: "deployment", startedAtMs: 20, finishedAtMs: 120 },
];

describe("timing evidence", () => {
  it("calculates overlap and maximum concurrency", () => {
    assert.equal(intervalOverlapMs(intervals[0], intervals[1]), 80);
    assert.equal(maximumConcurrency(intervals), 3);

    const summary = summarizeTiming(intervals, 120);
    assert.equal(summary.allIntervalsOverlap, true);
    assert.equal(summary.naiveSumDurationMs, 280);
    assert.equal(summary.concurrentSavingsMs, 160);
    assert.equal(summary.pairwise.every((pair) => pair.overlaps), true);
  });

  it("does not count touching endpoints as overlap", () => {
    const touching = [
      { name: "a", startedAtMs: 0, finishedAtMs: 10 },
      { name: "b", startedAtMs: 10, finishedAtMs: 20 },
    ];
    assert.equal(intervalOverlapMs(touching[0], touching[1]), 0);
    assert.equal(maximumConcurrency(touching), 1);
  });
});
