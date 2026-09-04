import {
  ModelMessageItem,
  RuntimeState,
  defineRuntime,
  type InferenceInput,
  type InferenceOutput,
  type InferenceRunner,
  type SemanticEvent,
} from "@mozaik-ai/core";

export const FAILED_INFERENCE_MARKER = "__FAULTLINE_INFERENCE_FAILED__";

export interface InferenceFailure {
  input: InferenceInput;
  error: unknown;
}

export class ResilientInferenceRunner implements InferenceRunner {
  calls = 0;

  constructor(
    private readonly delegate: InferenceRunner,
    private readonly onFailure: (failure: InferenceFailure) => void,
  ) {}

  async run(input: InferenceInput): Promise<InferenceOutput> {
    this.calls += 1;
    try {
      return await this.delegate.run(input);
    } catch (error) {
      this.onFailure({ input, error });
      return {
        items: [ModelMessageItem.rehydrate({ text: FAILED_INFERENCE_MARKER })],
        tokenUsage: undefined,
        rowResponse: undefined,
      };
    }
  }

  stream(input: InferenceInput): AsyncGenerator<SemanticEvent> {
    this.calls += 1;
    return this.delegate.stream(input);
  }
}

class ProviderState extends RuntimeState {}

export function createMozaikDefaultInferenceRunner(): InferenceRunner {
  const providerRuntime = defineRuntime<ProviderState>();
  return providerRuntime.initializeRuntime({ state: new ProviderState() }).getInferenceRunner();
}

export interface DeterministicRunnerOptions {
  failTask?: string;
}

function lastUserText(input: InferenceInput): string {
  const items = input.context.getItems() as Array<{
    role?: string;
    content?: { text?: string };
  }>;
  return [...items].reverse().find((item) => item.role === "user")?.content?.text ?? "";
}

function taskFromPrompt(prompt: string): string {
  return /^TASK:([^\n]+)/.exec(prompt)?.[1] ?? "unknown";
}

function deterministicResponse(task: string): Record<string, unknown> {
  switch (task) {
    case "investigator:telemetry":
      return {
        category: "telemetry",
        observation: "The latency and error jump begins at the v2.4.1 deployment boundary while database CPU rises.",
        confidence: 0.92,
        supports: [],
        contradicts: [],
      };
    case "investigator:change":
      return {
        category: "changes",
        observation: "Version v2.4.1 is the only recorded change aligned with the incident onset.",
        confidence: 0.86,
        supports: ["ev-001"],
        contradicts: [],
      };
    case "investigator:logs":
      return {
        category: "logs",
        observation: "Checkout traces show database wait timeouts following cache misses, linking cache degradation to database saturation.",
        confidence: 0.9,
        supports: ["ev-001", "ev-002"],
        contradicts: [],
      };
    case "hypothesis:initial":
      return {
        statement: "The v2.4.1 deployment likely introduced a checkout-path regression that increased database work.",
        confidence: 0.58,
        supportingEvidenceIds: ["ev-001"],
        contradictingEvidenceIds: [],
        addressesChallengeIds: [],
      };
    case "hypothesis:revision":
      return {
        statement: "The deployment likely degraded cache effectiveness, amplifying checkout database load until saturation caused latency and errors.",
        confidence: 0.88,
        supportingEvidenceIds: ["ev-001", "ev-002", "ev-003"],
        contradictingEvidenceIds: [],
        addressesChallengeIds: ["challenge-001"],
      };
    case "skeptic:challenge":
      return {
        claim: "Temporal alignment alone does not prove which v2.4.1 change caused the database load.",
        severity: "high",
        missingEvidence: "Correlate cache misses and database waits with the changed checkout code path.",
        targetHypothesisIds: ["hypothesis-001"],
      };
    case "recovery:initial":
      return {
        action: "Prepare a guarded rollback of v2.4.1 while collecting cache and database evidence.",
        rationale: "The deployment correlation is actionable but not yet independently confirmed.",
        impact: "high",
        supportingEvidenceIds: ["ev-001"],
        basedOnHypothesisIds: ["hypothesis-001"],
      };
    case "recovery:revision":
      return {
        action: "Roll back v2.4.1 under change control and verify cache hit rate, database CPU, latency, and checkout errors recover.",
        rationale: "Independent telemetry, change, and log evidence now supports the cache-to-database saturation chain.",
        impact: "high",
        supportingEvidenceIds: ["ev-001", "ev-002", "ev-003"],
        basedOnHypothesisIds: ["hypothesis-002"],
      };
    default:
      throw new Error(`No deterministic response for ${task}`);
  }
}

const DELAYS: Record<string, number> = {
  "investigator:telemetry": 35,
  "investigator:change": 65,
  "investigator:logs": 105,
  "hypothesis:initial": 30,
  "skeptic:challenge": 20,
  "recovery:initial": 25,
  "hypothesis:revision": 30,
  "recovery:revision": 25,
};

export class DeterministicInferenceRunner implements InferenceRunner {
  calls = 0;
  active = 0;
  maximumActive = 0;

  constructor(private readonly options: DeterministicRunnerOptions = {}) {}

  async run(input: InferenceInput): Promise<InferenceOutput> {
    const task = taskFromPrompt(lastUserText(input));
    this.calls += 1;
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    try {
      await new Promise((resolve) => setTimeout(resolve, DELAYS[task] ?? 5));
      if (this.options.failTask === task) throw new Error("deterministic injected inference failure");
      return {
        items: [
          ModelMessageItem.rehydrate({
            text: JSON.stringify(deterministicResponse(task)),
          }),
        ],
        tokenUsage: undefined,
        rowResponse: { deterministic: true, task },
      };
    } finally {
      this.active -= 1;
    }
  }

  async *stream(_input: InferenceInput): AsyncGenerator<SemanticEvent> {
    throw new Error("FAULTLINE uses non-streaming structured inference");
  }
}
