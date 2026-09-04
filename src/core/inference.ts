import {
  ModelMessageItem,
  RuntimeState,
  defineRuntime,
  type InferenceInput,
  type InferenceOutput,
  type InferenceRunner,
  type SemanticEvent,
} from "@mozaik-ai/core";

import type {
  ParticipantKey,
  ProviderAttempt,
  SafeProviderFailure,
} from "./types.js";

export const FAILED_INFERENCE_MARKER = "__FAULTLINE_INFERENCE_FAILED__";

export interface InferenceFailure {
  input: InferenceInput;
  failure: SafeProviderFailure;
}

export interface LogicalTaskContext {
  id: string;
  participant: ParticipantKey;
  stage: string;
}

export interface RetryNotice {
  task: LogicalTaskContext;
  failure: SafeProviderFailure;
  delayMs: number;
}

export interface RetryConfiguration {
  sleep?: (delayMs: number) => Promise<void>;
  rateLimitDelayMs?: number;
  transientDelayMs?: number;
}

export interface ResilientRunnerOptions extends RetryConfiguration {
  resolveTask: (input: InferenceInput) => LogicalTaskContext | undefined;
  onFailure: (failure: InferenceFailure) => void;
  onRetry?: (notice: RetryNotice) => void;
}

const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function numericStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    cause?: { status?: unknown };
  };
  for (const value of [
    candidate.status,
    candidate.statusCode,
    candidate.cause?.status,
    candidate.code,
  ]) {
    if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) {
      return value;
    }
  }
  return undefined;
}

export function safeProviderFailure(error: unknown, attempt: number): SafeProviderFailure {
  const rawName =
    error && typeof error === "object" && typeof (error as { name?: unknown }).name === "string"
      ? (error as { name: string }).name
      : "Error";
  const name = rawName.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 80) || "Error";
  const httpStatus = numericStatus(error);
  return {
    name,
    ...(httpStatus === undefined ? {} : { httpStatus }),
    retryable: httpStatus !== undefined && TRANSIENT_STATUSES.has(httpStatus),
    attempt,
  };
}

export class ResilientInferenceRunner implements InferenceRunner {
  providerAttempts = 0;
  retries = 0;
  readonly attempts: ProviderAttempt[] = [];
  private retryConsumed = false;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly rateLimitDelayMs: number;
  private readonly transientDelayMs: number;

  constructor(
    private readonly delegate: InferenceRunner,
    private readonly options: ResilientRunnerOptions,
  ) {
    this.sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.rateLimitDelayMs = options.rateLimitDelayMs ?? 60_000;
    this.transientDelayMs = options.transientDelayMs ?? 750;
  }

  async run(input: InferenceInput): Promise<InferenceOutput> {
    const task = this.options.resolveTask(input) ?? {
      id: "unknown",
      participant: "unknown" as const,
      stage: "unknown",
    };
    let attempt = 1;

    while (attempt <= 2) {
      this.providerAttempts += 1;
      const startedAt = new Date();
      try {
        const output = await this.delegate.run(input);
        const finishedAt = new Date();
        this.attempts.push({
          logicalTaskId: task.id,
          participant: task.participant,
          stage: task.stage,
          attempt,
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          outcome: "succeeded",
        });
        return output;
      } catch (error) {
        const finishedAt = new Date();
        const failure = safeProviderFailure(error, attempt);
        this.attempts.push({
          logicalTaskId: task.id,
          participant: task.participant,
          stage: task.stage,
          attempt,
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          outcome: "failed",
          failure,
        });

        if (failure.retryable && !this.retryConsumed && attempt === 1) {
          this.retryConsumed = true;
          this.retries += 1;
          const delayMs = failure.httpStatus === 429 ? this.rateLimitDelayMs : this.transientDelayMs;
          this.options.onRetry?.({ task: task as LogicalTaskContext, failure, delayMs });
          await this.sleep(delayMs);
          attempt += 1;
          continue;
        }

        this.options.onFailure({ input, failure });
        return {
          items: [ModelMessageItem.rehydrate({ text: FAILED_INFERENCE_MARKER })],
          tokenUsage: undefined,
          rowResponse: undefined,
        };
      }
    }

    throw new Error("Unreachable retry state");
  }

  stream(input: InferenceInput): AsyncGenerator<SemanticEvent> {
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
  failureStatuses?: Partial<Record<string, number[]>>;
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
        observation: "At 14:03, p95 rose from 180ms to 2.8s as cache hit rate fell from 93% to 41% and database CPU climbed from 48% to 96%.",
        confidence: 0.92,
        supports: [],
        contradicts: [],
      };
    case "investigator:change":
      return {
        category: "changes",
        observation: "Version v2.4.1 changed checkout cache-key normalization at 14:02, with no database, configuration, or infrastructure deployment in the incident window.",
        confidence: 0.86,
        supports: ["ev-001"],
        contradicts: [],
      };
    case "investigator:logs":
      return {
        category: "logs",
        observation: "Checkout traces show cache MISS followed by database pool waits and timeouts while read-query volume rises sharply.",
        confidence: 0.9,
        supports: ["ev-001", "ev-002"],
        contradicts: [],
      };
    case "hypothesis:initial":
      return {
        statement: "Deployment v2.4.1 appears correlated with increased checkout database work.",
        confidence: 0.58,
        supportingEvidenceIds: ["ev-001"],
        contradictingEvidenceIds: [],
        addressesChallengeIds: [],
      };
    case "hypothesis:revision":
      return {
        statement: "The v2.4.1 checkout cache-key normalization change likely collapsed cache effectiveness, driving database saturation, latency, and checkout failures.",
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
  readonly attemptsByTask = new Map<string, number>();

  constructor(private readonly options: DeterministicRunnerOptions = {}) {}

  async run(input: InferenceInput): Promise<InferenceOutput> {
    const task = taskFromPrompt(lastUserText(input));
    const taskAttempt = (this.attemptsByTask.get(task) ?? 0) + 1;
    this.attemptsByTask.set(task, taskAttempt);
    this.calls += 1;
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    try {
      await new Promise((resolve) => setTimeout(resolve, DELAYS[task] ?? 5));
      const status = this.options.failureStatuses?.[task]?.[taskAttempt - 1];
      if (status !== undefined) {
        const error = Object.assign(
          new Error("SENSITIVE_PROVIDER_PAYLOAD_MUST_NOT_PERSIST"),
          {
            name: "ApiError",
            status,
            headers: { authorization: "SENSITIVE_HEADER" },
            responseBody: "SENSITIVE_RESPONSE_BODY",
          },
        );
        throw error;
      }
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
