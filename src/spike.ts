import {
  Agent,
  ModelMessageItem,
  RuntimeState,
  SemanticEvent,
  SituationSpecification,
  createAgent,
  createHuman,
  defineRuntime,
  type InferenceRunner,
  type SituationContext,
  type SituationHandler,
} from "@mozaik-ai/core";

import { summarizeTiming, type CompletedInterval } from "./timing.js";

export const INCIDENT =
  "Immediately after deployment v2.4.1, API p95 latency increased from 180ms to 2.8s and checkout errors rose from 0.4% to 17%.";

const INVESTIGATORS = [
  {
    name: "telemetry investigator",
    instruction:
      "Analyze only telemetry. Reply with one sentence of at most 25 words naming the strongest signal and next check.",
  },
  {
    name: "log investigator",
    instruction:
      "Analyze only likely application logs. Reply with one sentence of at most 25 words naming the strongest hypothesis and log query.",
  },
  {
    name: "deployment/change investigator",
    instruction:
      "Analyze only deployment changes. Reply with one sentence of at most 25 words naming the likeliest change risk and verification.",
  },
] as const;

interface MutableInterval {
  name: string;
  startedAtMs?: number;
  finishedAtMs?: number;
}

interface FailureEvidence {
  participantId: string;
  participantName: string;
  kind: string;
  occurredAt: string;
  detail?: string;
}

interface PeerEventEvidence {
  reactorId: string;
  reactorName: string;
  observedProducerId: string;
  observedProducerName: string;
  observedEventType: string;
  occurredAt: string;
}

class SpikeState extends RuntimeState {
  readonly names = new Map<string, string>();
  readonly contextOwners = new Map<string, string>();
  readonly intervals = new Map<string, MutableInterval>();
  readonly answers = new Map<string, string>();
  readonly inferenceFailures = new Map<string, FailureEvidence>();
  readonly peerEvents: PeerEventEvidence[] = [];
  intentionalFailure?: FailureEvidence;
}

class MatchingEvent extends SituationSpecification {
  constructor(
    private readonly matches: (context: SituationContext) => boolean,
  ) {
    super();
  }

  isSatisfiedBy(context: SituationContext): boolean {
    return this.matches(context);
  }
}

export interface SpikeOptions {
  model?: string;
  inferenceRunner?: InferenceRunner;
  timeoutMs?: number;
  intentionalFailureDelayMs?: number;
}

export interface SpikeResult {
  schemaVersion: "1.0";
  mozaikCoreVersion: "4.0.5";
  passed: boolean;
  incident: string;
  model: string;
  investigators: Array<{
    id: string;
    name: string;
    status: "completed" | "failed" | "incomplete";
    startedAt?: string;
    finishedAt?: string;
    durationMs?: number;
    answerExcerpt?: string;
    failure?: FailureEvidence;
  }>;
  timing: ReturnType<typeof summarizeTiming>;
  crossParticipantEvent?: PeerEventEvidence;
  intentionalFailure?: FailureEvidence;
  assertions: {
    threeInvestigatorsCompleted: boolean;
    allThreeIntervalsOverlap: boolean;
    crossParticipantReactionObserved: boolean;
    failingParticipantIsolated: boolean;
  };
}

function answerText(event: SemanticEvent): string {
  const payload = event.payload as { answer?: ModelMessageItem };
  return payload.answer?.content.text ?? "";
}

function excerpt(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

function safeUnhandledFailure(error: unknown): Error {
  const candidate = error as { name?: unknown; status?: unknown; code?: unknown };
  const name = typeof candidate?.name === "string" ? candidate.name : "Error";
  const status =
    typeof candidate?.status === "number" || typeof candidate?.status === "string"
      ? ` status=${String(candidate.status)}`
      : "";
  const code =
    typeof candidate?.code === "number" || typeof candidate?.code === "string"
      ? ` code=${String(candidate.code)}`
      : "";
  return new Error(`Mozaik inference failed (${name}${status}${code})`);
}

export async function runSpike(options: SpikeOptions = {}): Promise<SpikeResult> {
  const model = options.model ?? "gemini-3.5-flash";
  const timeoutMs = options.timeoutMs ?? 90_000;
  const state = new SpikeState();
  const runtime = defineRuntime<SpikeState>();
  let scheduleCompletionCheck = (): void => {};

  runtime.initializeRuntime(
    options.inferenceRunner
      ? {
          state,
          inferenceRunnerConfig: { runner: options.inferenceRunner },
        }
      : { state },
  );

  const startsOnIncident: SituationHandler = {
    specification: new MatchingEvent(
      ({ event }) => event.type === "message.sent",
    ),
    processor: {
      apply({ event, participant }) {
        if (!(participant instanceof Agent)) return;
        const message = (event.payload as { message: string }).message;
        runtime.runLoop(participant.getId(), message, {
          model,
          context: participant.getMemory().getContext(),
          tools: participant.getTools(),
          streaming: false,
        });
      },
    },
  };

  const telemetry = createAgent({
    ...INVESTIGATORS[0],
    capabilities: ["incident telemetry analysis"],
    tools: [],
    handlers: [startsOnIncident],
  });
  const logs = createAgent({
    ...INVESTIGATORS[1],
    capabilities: ["incident log analysis"],
    tools: [],
    handlers: [startsOnIncident],
  });

  const reactsToTelemetry: SituationHandler = {
    specification: new MatchingEvent(
      ({ event, participant }) =>
        event.type === "model.answer" &&
        event.producerId === telemetry.getId() &&
        event.producerId !== participant.getId() &&
        !state.inferenceFailures.has(event.producerId),
    ),
    processor: {
      apply({ event, participant }) {
        const evidence: PeerEventEvidence = {
          reactorId: participant.getId(),
          reactorName: state.names.get(participant.getId()) ?? "unknown reactor",
          observedProducerId: event.producerId,
          observedProducerName:
            state.names.get(event.producerId) ?? "unknown producer",
          observedEventType: event.type,
          occurredAt: new Date().toISOString(),
        };
        runtime.sendEvent(
          SemanticEvent.create(
            "investigator.observed_peer",
            participant.getId(),
            evidence,
          ),
          participant.getId(),
        );
      },
    },
  };

  const deployment = createAgent({
    ...INVESTIGATORS[2],
    capabilities: ["deployment change analysis"],
    tools: [],
    handlers: [startsOnIncident, reactsToTelemetry],
  });
  const investigators = [telemetry, logs, deployment];

  for (const investigator of investigators) {
    const id = investigator.getId();
    state.names.set(id, investigator.getManifest().name);
    state.contextOwners.set(investigator.getMemory().getContext().id, id);
    state.intervals.set(id, { name: investigator.getManifest().name });
  }

  const observerHandler: SituationHandler = {
    specification: new MatchingEvent(({ event }) =>
      [
        "inference.started",
        "model.answer",
        "investigator.failed",
        "investigator.observed_peer",
      ].includes(event.type),
    ),
    processor: {
      apply({ event }) {
        if (event.type === "inference.started") {
          const interval = state.intervals.get(event.producerId);
          if (interval && interval.startedAtMs === undefined) {
            interval.startedAtMs = event.occurredAt.getTime();
          }
        } else if (event.type === "model.answer") {
          const interval = state.intervals.get(event.producerId);
          if (interval && interval.finishedAtMs === undefined) {
            interval.finishedAtMs = event.occurredAt.getTime();
            if (!state.inferenceFailures.has(event.producerId)) {
              state.answers.set(event.producerId, answerText(event));
            }
          }
        } else if (event.type === "investigator.failed") {
          const evidence = event.payload as FailureEvidence;
          if (evidence.kind === "intentional") {
            state.intentionalFailure = evidence;
          } else {
            state.inferenceFailures.set(evidence.participantId, evidence);
          }
        } else if (event.type === "investigator.observed_peer") {
          state.peerEvents.push(event.payload as PeerEventEvidence);
        }
        scheduleCompletionCheck();
      },
    },
  };

  const observer = createHuman({
    name: "spike evidence observer",
    capabilities: ["evidence capture"],
    handlers: [observerHandler],
  });

  const failingHandler: SituationHandler = {
    specification: new MatchingEvent(
      ({ event }) => event.type === "message.sent",
    ),
    processor: {
      apply({ participant }) {
        void (async () => {
          try {
            await new Promise((resolve) =>
              setTimeout(resolve, options.intentionalFailureDelayMs ?? 10),
            );
            throw new Error("intentional spike failure");
          } catch {
            const evidence: FailureEvidence = {
              participantId: participant.getId(),
              participantName: participant.getManifest().name,
              kind: "intentional",
              occurredAt: new Date().toISOString(),
            };
            runtime.sendEvent(
              SemanticEvent.create(
                "investigator.failed",
                participant.getId(),
                evidence,
              ),
              participant.getId(),
            );
          }
        })();
      },
    },
  };

  const failingParticipant = createHuman({
    name: "deliberately failing investigator",
    capabilities: ["failure-isolation probe"],
    handlers: [failingHandler],
  });

  const sender = createHuman({
    name: "incident commander",
    capabilities: ["incident dispatch"],
    handlers: [],
  });

  runtime.join(sender);
  runtime.join(observer);
  for (const investigator of investigators) runtime.join(investigator);
  runtime.join(failingParticipant);

  const dispatchedAtMs = Date.now();
  let settled = false;
  let settleScheduled = false;
  let rejectCompletion: (error: Error) => void = () => {};
  let timeout: NodeJS.Timeout | undefined;

  const onUnhandledRejection = (error: unknown): void => {
    if (settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
    rejectCompletion(safeUnhandledFailure(error));
  };

  const completion = new Promise<void>((resolve, reject) => {
    rejectCompletion = reject;
    timeout = setTimeout(
      () => reject(new Error(`Spike timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );

    scheduleCompletionCheck = () => {
      const terminalCount =
        state.answers.size + state.inferenceFailures.size;
      if (
        !settled &&
        !settleScheduled &&
        terminalCount === investigators.length &&
        state.intentionalFailure
      ) {
        settleScheduled = true;
        setImmediate(() => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve();
        });
      }
    };
  });

  process.once("unhandledRejection", onUnhandledRejection);
  try {
    runtime.sendMessage(INCIDENT, sender.getId());
    await completion;
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
    if (timeout) clearTimeout(timeout);
  }
  const completedAtMs = Date.now();

  const completedIntervals: CompletedInterval[] = [...state.intervals.entries()]
    .filter(
      ([id, interval]) =>
        state.answers.has(id) &&
        interval.startedAtMs !== undefined &&
        interval.finishedAtMs !== undefined,
    )
    .map(([, interval]) => ({
      name: interval.name,
      startedAtMs: interval.startedAtMs!,
      finishedAtMs: interval.finishedAtMs!,
    }));

  const timing = summarizeTiming(
    completedIntervals,
    completedAtMs - dispatchedAtMs,
  );
  const threeInvestigatorsCompleted =
    state.answers.size === investigators.length;
  const allThreeIntervalsOverlap =
    completedIntervals.length === investigators.length &&
    timing.allIntervalsOverlap &&
    timing.maximumConcurrency === investigators.length;
  const crossParticipantReactionObserved = state.peerEvents.length > 0;
  const failingParticipantIsolated =
    Boolean(state.intentionalFailure) && threeInvestigatorsCompleted;

  return {
    schemaVersion: "1.0",
    mozaikCoreVersion: "4.0.5",
    passed:
      threeInvestigatorsCompleted &&
      allThreeIntervalsOverlap &&
      crossParticipantReactionObserved &&
      failingParticipantIsolated,
    incident: INCIDENT,
    model,
    investigators: investigators.map((investigator) => {
      const id = investigator.getId();
      const interval = state.intervals.get(id)!;
      const failure = state.inferenceFailures.get(id);
      const answer = state.answers.get(id);
      return {
        id,
        name: investigator.getManifest().name,
        status: failure ? "failed" : answer ? "completed" : "incomplete",
        ...(interval.startedAtMs === undefined
          ? {}
          : { startedAt: new Date(interval.startedAtMs).toISOString() }),
        ...(interval.finishedAtMs === undefined
          ? {}
          : {
              finishedAt: new Date(interval.finishedAtMs).toISOString(),
              durationMs: interval.finishedAtMs - interval.startedAtMs!,
            }),
        ...(answer ? { answerExcerpt: excerpt(answer) } : {}),
        ...(failure ? { failure } : {}),
      };
    }),
    timing,
    crossParticipantEvent: state.peerEvents[0],
    intentionalFailure: state.intentionalFailure,
    assertions: {
      threeInvestigatorsCompleted,
      allThreeIntervalsOverlap,
      crossParticipantReactionObserved,
      failingParticipantIsolated,
    },
  };
}
