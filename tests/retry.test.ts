import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ModelContext,
  ModelMessageItem,
  UserMessageItem,
  type InferenceInput,
  type InferenceOutput,
  type InferenceRunner,
  type SemanticEvent,
} from "@mozaik-ai/core";

import {
  FAILED_INFERENCE_MARKER,
  ResilientInferenceRunner,
  type InferenceFailure,
  type RetryNotice,
} from "../src/core/inference.js";

class SequenceRunner implements InferenceRunner {
  calls = 0;

  constructor(private readonly statuses: Array<number | "success">) {}

  async run(_input: InferenceInput): Promise<InferenceOutput> {
    const outcome = this.statuses[this.calls] ?? "success";
    this.calls += 1;
    if (outcome !== "success") {
      throw Object.assign(new Error("RAW_SECRET_PAYLOAD_MUST_NOT_PERSIST"), {
        name: "ApiError",
        status: outcome,
        headers: { authorization: "RAW_SECRET_HEADER" },
        body: "RAW_PROVIDER_BODY",
      });
    }
    return {
      items: [ModelMessageItem.rehydrate({ text: "success" })],
      tokenUsage: undefined,
      rowResponse: undefined,
    };
  }

  async *stream(_input: InferenceInput): AsyncGenerator<SemanticEvent> {
    throw new Error("not used");
  }
}

function input(): InferenceInput {
  return {
    model: "test",
    context: ModelContext.create().addContextItem(UserMessageItem.create("TASK:test")),
    streaming: false,
  };
}

function createRunner(statuses: Array<number | "success">) {
  const delegate = new SequenceRunner(statuses);
  const delays: number[] = [];
  const retryNotices: RetryNotice[] = [];
  const failures: InferenceFailure[] = [];
  const runner = new ResilientInferenceRunner(delegate, {
    resolveTask: () => ({
      id: "task-001",
      participant: "hypothesis-analyst",
      stage: "hypothesis:revision",
    }),
    onRetry: (notice) => retryNotices.push(notice),
    onFailure: (failure) => failures.push(failure),
    sleep: async (delayMs) => {
      delays.push(delayMs);
    },
  });
  return { delegate, delays, retryNotices, failures, runner };
}

describe("bounded provider retry policy", () => {
  for (const [status, expectedDelay] of [
    [429, 60_000],
    [503, 750],
  ] as const) {
    it(`${status} performs one retry and succeeds`, async () => {
      const fixture = createRunner([status, "success"]);
      const output = await fixture.runner.run(input());

      assert.equal(fixture.delegate.calls, 2);
      assert.equal(fixture.runner.providerAttempts, 2);
      assert.equal(fixture.runner.retries, 1);
      assert.deepEqual(fixture.delays, [expectedDelay]);
      assert.equal(fixture.retryNotices[0].failure.httpStatus, status);
      assert.equal(fixture.retryNotices[0].failure.retryable, true);
      assert.equal(fixture.retryNotices[0].failure.attempt, 1);
      assert.equal(fixture.failures.length, 0);
      assert.equal((output.items[0] as ModelMessageItem).content.text, "success");
    });
  }

  it("400 is sanitized and never retried", async () => {
    const fixture = createRunner([400]);
    const output = await fixture.runner.run(input());

    assert.equal(fixture.delegate.calls, 1);
    assert.equal(fixture.runner.providerAttempts, 1);
    assert.equal(fixture.runner.retries, 0);
    assert.equal(fixture.delays.length, 0);
    assert.deepEqual(fixture.failures[0].failure, {
      name: "ApiError",
      httpStatus: 400,
      retryable: false,
      attempt: 1,
    });
    assert.equal((output.items[0] as ModelMessageItem).content.text, FAILED_INFERENCE_MARKER);
    const persisted = JSON.stringify({ attempts: fixture.runner.attempts, failures: fixture.failures.map((item) => item.failure) });
    assert.equal(persisted.includes("RAW_SECRET"), false);
    assert.equal(persisted.includes("RAW_PROVIDER_BODY"), false);
    assert.equal(persisted.includes("authorization"), false);
  });

  it("a second transient failure stops after the single retry", async () => {
    const fixture = createRunner([503, 503, "success"]);
    await fixture.runner.run(input());

    assert.equal(fixture.delegate.calls, 2);
    assert.equal(fixture.runner.providerAttempts, 2);
    assert.equal(fixture.runner.retries, 1);
    assert.equal(fixture.failures.length, 1);
    assert.deepEqual(fixture.failures[0].failure, {
      name: "ApiError",
      httpStatus: 503,
      retryable: true,
      attempt: 2,
    });
  });
});
