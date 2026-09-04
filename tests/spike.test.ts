import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ModelMessageItem,
  type InferenceInput,
  type InferenceOutput,
  type InferenceRunner,
  type SemanticEvent,
} from "@mozaik-ai/core";

import { runSpike } from "../src/spike.js";

class DelayedInferenceRunner implements InferenceRunner {
  active = 0;
  maximumActive = 0;
  calls = 0;

  async run(_input: InferenceInput): Promise<InferenceOutput> {
    this.calls += 1;
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    await new Promise((resolve) => setTimeout(resolve, 60));
    this.active -= 1;
    return {
      items: [ModelMessageItem.rehydrate({ text: `mock answer ${this.calls}` })],
      tokenUsage: undefined,
      rowResponse: { mock: true },
    };
  }

  async *stream(_input: InferenceInput): AsyncGenerator<SemanticEvent> {
    throw new Error("Streaming is not used by this spike");
  }
}

describe("Mozaik participant spike with deterministic inference", () => {
  it("overlaps three loops, propagates a peer event, and isolates a failure", async () => {
    const runner = new DelayedInferenceRunner();
    const result = await runSpike({
      model: "deterministic-test-model",
      inferenceRunner: runner,
      timeoutMs: 2_000,
      intentionalFailureDelayMs: 5,
    });

    assert.equal(result.passed, true);
    assert.equal(runner.calls, 3);
    assert.equal(runner.maximumActive, 3);
    assert.equal(result.assertions.threeInvestigatorsCompleted, true);
    assert.equal(result.assertions.allThreeIntervalsOverlap, true);
    assert.equal(result.timing.maximumConcurrency, 3);
    assert.equal(result.assertions.crossParticipantReactionObserved, true);
    assert.equal(
      result.crossParticipantEvent?.reactorName,
      "deployment/change investigator",
    );
    assert.equal(
      result.crossParticipantEvent?.observedProducerName,
      "telemetry investigator",
    );
    assert.equal(result.assertions.failingParticipantIsolated, true);
    assert.equal(result.intentionalFailure?.kind, "intentional");
  });
});
