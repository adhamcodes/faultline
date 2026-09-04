import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  RuntimeState,
  SemanticEvent,
  createHuman,
  defineRuntime,
  type SituationHandler,
} from "@mozaik-ai/core";

import { runFaultline } from "../src/core/engine.js";
import { MatchingEvent } from "../src/core/events.js";
import { DeterministicInferenceRunner } from "../src/core/inference.js";

class TestState extends RuntimeState {}

describe("failure behavior and FAULTLINE containment", () => {
  it("records that native Mozaik does not isolate an escaping synchronous handler failure", () => {
    const runtime = defineRuntime<TestState>();
    runtime.initializeRuntime({ state: new TestState() });
    const specification = new MatchingEvent(({ event }) => event.type === "native.failure.probe");
    const failingHandler: SituationHandler = {
      specification,
      processor: { apply: () => { throw new Error("escaped native handler failure"); } },
    };
    let healthyDeliveries = 0;
    const healthyHandler: SituationHandler = {
      specification,
      processor: { apply: () => { healthyDeliveries += 1; } },
    };
    const sender = createHuman({ name: "sender", capabilities: [], handlers: [] });
    const failing = createHuman({ name: "failing", capabilities: [], handlers: [failingHandler] });
    const healthy = createHuman({ name: "healthy", capabilities: [], handlers: [healthyHandler] });
    runtime.join(sender);
    runtime.join(failing);
    runtime.join(healthy);

    assert.throws(
      () =>
        runtime.sendEvent(
          SemanticEvent.create("native.failure.probe", sender.getId(), {}),
          sender.getId(),
        ),
      /escaped native handler failure/,
    );
    assert.equal(healthyDeliveries, 0);
  });

  it("contains an escaped investigator handler failure and preserves a useful partial result", async () => {
    const { artifact } = await runFaultline({
      mode: "deterministic",
      inferenceRunner: new DeterministicInferenceRunner(),
      injectHandlerFailure: "log-investigator",
      timeoutMs: 2_000,
    });

    assert.equal(artifact.incident.status, "partial");
    assert.equal(artifact.participants.find((item) => item.key === "log-investigator")?.status, "failed");
    assert.equal(artifact.evidence.length, 2);
    assert.equal(artifact.hypotheses.length, 2);
    assert.equal(artifact.remediations.length, 2);
    assert.equal(artifact.remediations.at(-1)?.gate.status, "supported");
    assert.equal(artifact.resilience.failuresContained, 1);
    assert.equal(
      artifact.timeline.some((item) => item.eventType === "faultline.participant.failed"),
      true,
    );
    assert.equal(artifact.finalSummary?.failures.includes("log-investigator"), true);
    assert.equal(artifact.timeline.at(-1)?.eventType, "faultline.incident.completed");
  });

  it("stops after a second transient failure, closes timing, and finalizes last", async () => {
    const runner = new DeterministicInferenceRunner({
      failureStatuses: { "hypothesis:revision": [503, 503] },
    });
    const { artifact, logicalInferenceTasks, providerAttempts, retries } = await runFaultline({
      mode: "deterministic",
      inferenceRunner: runner,
      retry: { sleep: async () => {} },
      timeoutMs: 2_000,
    });

    assert.equal(artifact.incident.status, "partial");
    assert.equal(logicalInferenceTasks, 7);
    assert.equal(providerAttempts, 8);
    assert.equal(retries, 1);
    assert.equal(artifact.inference.logicalTasks, 7);
    assert.equal(artifact.inference.providerAttempts, 8);
    assert.equal(artifact.inference.retries, 1);
    assert.equal(artifact.hypotheses.length, 1);
    assert.equal(artifact.remediations.length, 1);
    const failed = artifact.participants.find((item) => item.key === "hypothesis-analyst");
    assert.deepEqual(failed?.failure?.provider, {
      name: "ApiError",
      httpStatus: 503,
      retryable: true,
      attempt: 2,
    });
    const failedExecution = artifact.timing.executions.find(
      (item) => item.stage === "hypothesis:revision",
    );
    assert.equal(failedExecution?.finishedAt !== undefined, true);
    assert.equal(failedExecution?.durationMs !== undefined, true);
    assert.equal(artifact.timeline.at(-1)?.eventType, "faultline.incident.completed");
    const completionIndex = artifact.timeline.findIndex(
      (item) => item.eventType === "faultline.incident.completed",
    );
    assert.equal(completionIndex, artifact.timeline.length - 1);
    const serialized = JSON.stringify(artifact);
    assert.equal(serialized.includes("SENSITIVE_PROVIDER_PAYLOAD"), false);
    assert.equal(serialized.includes("SENSITIVE_HEADER"), false);
    assert.equal(serialized.includes("SENSITIVE_RESPONSE_BODY"), false);
  });
});
