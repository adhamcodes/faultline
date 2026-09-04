import {
  Agent,
  ModelMessageItem,
  SemanticEvent,
  createAgent,
  createHuman,
  defineRuntime,
  type InferenceRunner,
  type SituationContext,
  type SituationHandler,
  type StructuredOutputFormat,
} from "@mozaik-ai/core";

import { withParticipantBoundary } from "./boundary.js";
import { MatchingEvent } from "./events.js";
import { evaluateRecommendationGate } from "./gate.js";
import {
  FAILED_INFERENCE_MARKER,
  ResilientInferenceRunner,
  createMozaikDefaultInferenceRunner,
} from "./inference.js";
import {
  CHALLENGE_SCHEMA,
  EVIDENCE_SCHEMA,
  HYPOTHESIS_SCHEMA,
  RECOMMENDATION_SCHEMA,
  parseChallenge,
  parseEvidence,
  parseHypothesis,
  parseRecommendationDraft,
} from "./schema.js";
import { FaultlineRuntimeState, type ActiveTask } from "./state.js";
import type {
  FaultlineRunArtifact,
  ParticipantKey,
  RunMode,
} from "./types.js";

export const DEMO_INCIDENT =
  "Immediately after deployment v2.4.1, API p95 latency increased from 180ms to 2.8s and checkout errors rose from 0.4% to 17%. Database CPU rose sharply while cache hit rate dropped.";

const PARTICIPANTS: Record<
  ParticipantKey,
  { name: string; focus: string; instruction: string }
> = {
  "telemetry-investigator": {
    name: "Telemetry Investigator",
    focus: "metrics, telemetry, and anomalous signals",
    instruction: "You extract concise, structured incident evidence from telemetry only.",
  },
  "log-investigator": {
    name: "Log Investigator",
    focus: "errors, traces, and log evidence",
    instruction: "You extract concise, structured incident evidence from logs and traces only.",
  },
  "change-investigator": {
    name: "Change Investigator",
    focus: "deployments, configuration changes, and temporal correlation",
    instruction: "You extract concise, structured incident evidence about changes and timing only.",
  },
  "hypothesis-analyst": {
    name: "Hypothesis Analyst",
    focus: "causal hypotheses revised as evidence changes",
    instruction: "You form cautious causal hypotheses from only the supplied evidence and revise them when the evidence basis changes.",
  },
  skeptic: {
    name: "Skeptic",
    focus: "weak causal claims, conflicts, missing proof, and overconfidence",
    instruction: "You challenge unsupported incident claims and state the most important missing proof.",
  },
  "recovery-planner": {
    name: "Recovery Planner",
    focus: "advisory remediation options under deterministic safety gates",
    instruction: "You propose advisory recovery actions from the current evidence, hypothesis, and challenge state; never execute actions.",
  },
};

const INVESTIGATOR_KEYS: ParticipantKey[] = [
  "telemetry-investigator",
  "log-investigator",
  "change-investigator",
];

export interface FaultlineOptions {
  incidentText?: string;
  mode?: RunMode;
  model?: string;
  inferenceRunner?: InferenceRunner;
  timeoutMs?: number;
  injectHandlerFailure?: ParticipantKey;
}

export interface FaultlineRun {
  artifact: FaultlineRunArtifact;
  inferenceCalls: number;
}

interface FailurePayload {
  participant: ParticipantKey;
  phase: string;
  kind: string;
}

function answerText(context: SituationContext): string {
  const payload = context.event.payload as { answer?: ModelMessageItem };
  return payload.answer?.content.text ?? "";
}

function compactState(value: unknown): string {
  return JSON.stringify(value);
}

function basisKey(state: FaultlineRuntimeState): string {
  const failures = state.artifact.participants
    .filter((item) => item.status === "failed")
    .map((item) => item.key)
    .sort();
  return compactState({
    evidence: state.artifact.evidence.map((item) => item.id),
    failures,
    challenges: state.artifact.challenges.map((item) => item.id),
  });
}

function investigatorPrompt(key: ParticipantKey, incidentText: string): string {
  const taskByParticipant: Partial<Record<ParticipantKey, string>> = {
    "telemetry-investigator": "telemetry",
    "log-investigator": "logs",
    "change-investigator": "change",
  };
  const task = taskByParticipant[key];
  if (!task) throw new Error(`${key} is not an investigator`);
  return [
    `TASK:investigator:${task}`,
    `Incident: ${incidentText}`,
    "Return JSON only: category, observation (one sentence), confidence (0..1), supports (ids), contradicts (ids).",
    "Report evidence, not a remediation recommendation.",
  ].join("\n");
}

function hypothesisPrompt(
  stage: "initial" | "revision",
  state: FaultlineRuntimeState,
): string {
  return [
    `TASK:hypothesis:${stage}`,
    `Incident: ${state.artifact.incident.text}`,
    `Evidence: ${compactState(state.artifact.evidence)}`,
    `Prior hypotheses: ${compactState(state.artifact.hypotheses)}`,
    `Challenges: ${compactState(state.artifact.challenges)}`,
    "Return JSON only: statement, confidence, supportingEvidenceIds, contradictingEvidenceIds, addressesChallengeIds.",
    "Change the hypothesis only when the expanded evidence warrants it; do not invent evidence ids.",
  ].join("\n");
}

function skepticPrompt(state: FaultlineRuntimeState): string {
  return [
    "TASK:skeptic:challenge",
    `Evidence: ${compactState(state.artifact.evidence)}`,
    `Hypothesis: ${compactState(state.artifact.hypotheses.at(-1))}`,
    "Return JSON only: claim, severity (low|medium|high), missingEvidence, targetHypothesisIds.",
  ].join("\n");
}

function recoveryPrompt(
  stage: "initial" | "revision",
  state: FaultlineRuntimeState,
): string {
  return [
    `TASK:recovery:${stage}`,
    `Evidence: ${compactState(state.artifact.evidence)}`,
    `Hypotheses: ${compactState(state.artifact.hypotheses)}`,
    `Challenges: ${compactState(state.artifact.challenges)}`,
    `Prior recommendations: ${compactState(state.artifact.remediations)}`,
    "Return JSON only: action, rationale, impact (low|medium|high), supportingEvidenceIds, basedOnHypothesisIds.",
    "Advisory only. Do not claim an action is approved or executed; deterministic code assigns readiness.",
  ].join("\n");
}

export async function runFaultline(options: FaultlineOptions = {}): Promise<FaultlineRun> {
  const mode = options.mode ?? "deterministic";
  const model = options.model ?? (mode === "live" ? "gemini-3.5-flash" : "deterministic-faultline-model");
  const incidentText = options.incidentText?.trim() || DEMO_INCIDENT;
  const state = new FaultlineRuntimeState(crypto.randomUUID(), mode, model, incidentText);
  const runtime = defineRuntime<FaultlineRuntimeState>();
  const agents = Object.fromEntries(
    (Object.entries(PARTICIPANTS) as Array<[ParticipantKey, (typeof PARTICIPANTS)[ParticipantKey]]>).map(
      ([key, definition]) => [
        key,
        createAgent({
          name: definition.name,
          capabilities: [definition.focus],
          instruction: definition.instruction,
          tools: [],
          handlers: [],
        }),
      ],
    ),
  ) as Record<ParticipantKey, Agent>;

  for (const [key, agent] of Object.entries(agents) as Array<[ParticipantKey, Agent]>) {
    const definition = PARTICIPANTS[key];
    state.registerParticipant(
      key,
      agent.getId(),
      definition.name,
      definition.focus,
      agent.getMemory().getContext().id,
    );
  }

  let maybeFinalize = (): void => {};
  let considerHypothesis = (): void => {};
  let considerRecovery = (): void => {};

  const emit = <TPayload>(type: string, key: ParticipantKey, payload: TPayload): void => {
    const participantId = state.idsByKey.get(key)!;
    runtime.sendEvent(
      SemanticEvent.create(type, participantId, payload),
      participantId,
    );
  };

  const containFailure = (key: ParticipantKey, phase: string, error: unknown): void => {
    if (state.participant(key).status === "failed") return;
    const kind = error instanceof Error ? error.name : "Error";
    state.markFailed(key, phase, kind);
    emit<FailurePayload>("faultline.participant.failed", key, {
      participant: key,
      phase,
      kind,
    });
  };

  const baseRunner = options.inferenceRunner ?? createMozaikDefaultInferenceRunner();
  const runner = new ResilientInferenceRunner(baseRunner, ({ input, error }) => {
    const key = state.contextOwners.get(input.context.id);
    if (key) containFailure(key, "inference", error);
  });

  runtime.initializeRuntime({
    state,
    inferenceRunnerConfig: { runner },
  });

  const bounded = (
    key: ParticipantKey,
    phase: string,
    specification: SituationHandler["specification"],
    businessHandler: (context: SituationContext) => void | Promise<void>,
  ): SituationHandler =>
    withParticipantBoundary(
      specification,
      (context) => {
        if (
          options.injectHandlerFailure === key &&
          phase === "publish-output"
        ) {
          throw new Error("deterministic handler failure escaped business logic");
        }
        return businessHandler(context);
      },
      (_context, error) => containFailure(key, phase, error),
    );

  const runTask = (
    key: ParticipantKey,
    task: ActiveTask,
    prompt: string,
    schema: Record<string, unknown>,
  ): boolean => {
    if (state.participant(key).status === "failed" || state.activeTasks.has(key)) return false;
    state.activeTasks.set(key, task);
    const agent = agents[key];
    const structuredOutput: StructuredOutputFormat = {
      name: task.stage.replace(/[^a-z0-9_-]/gi, "_"),
      schema,
    };
    runtime.runLoop(agent.getId(), prompt, {
      model,
      context: agent.getMemory().getContext(),
      tools: [],
      streaming: false,
      maxOutputTokens: 320,
      structuredOutput,
    });
    return true;
  };

  const taskSnapshot = (
    kind: ActiveTask["kind"],
    stage: string,
  ): ActiveTask => ({
    kind,
    stage,
    basisKey: basisKey(state),
    basisEvidenceIds: state.artifact.evidence.map((item) => item.id),
    basisHypothesisIds: state.artifact.hypotheses.map((item) => item.id),
    basisChallengeIds: state.artifact.challenges.map((item) => item.id),
  });

  const isSelfAnswer = (key: ParticipantKey) =>
    new MatchingEvent(
      ({ event, participant }) =>
        event.type === "model.answer" &&
        event.producerId === participant.getId() &&
        participant.getId() === state.idsByKey.get(key),
    );

  for (const key of INVESTIGATOR_KEYS) {
    agents[key].setHandlers([
      bounded(
        key,
        "incident-dispatch",
        new MatchingEvent(({ event }) => event.type === "message.sent"),
        () => {
          runTask(
            key,
            taskSnapshot("investigator", `investigate:${key}`),
            investigatorPrompt(key, incidentText),
            EVIDENCE_SCHEMA,
          );
        },
      ),
      bounded(key, "publish-output", isSelfAnswer(key), (context) => {
        const task = state.activeTasks.get(key);
        const text = answerText(context);
        if (!task || text === FAILED_INFERENCE_MARKER || state.participant(key).status === "failed") return;
        const id = `ev-${String(state.artifact.evidence.length + 1).padStart(3, "0")}`;
        const knownIds = state.artifact.evidence.map((item) => item.id);
        const evidence = parseEvidence(
          text,
          id,
          state.idsByKey.get(key)!,
          key,
          context.event.occurredAt.toISOString(),
          knownIds,
        );
        state.artifact.evidence.push(evidence);
        state.activeTasks.delete(key);
        emit("faultline.evidence.published", key, evidence);
      }),
    ]);
  }

  considerHypothesis = () => {
    const key: ParticipantKey = "hypothesis-analyst";
    if (state.participant(key).status === "failed" || state.activeTasks.has(key)) return;
    if (state.artifact.evidence.length === 0) return;
    if (state.artifact.hypotheses.length === 0) {
      runTask(
        key,
        taskSnapshot("hypothesis", "hypothesis:initial"),
        hypothesisPrompt("initial", state),
        HYPOTHESIS_SCHEMA,
      );
      return;
    }
    if (
      state.artifact.hypotheses.length === 1 &&
      state.investigatorTerminalCount() === INVESTIGATOR_KEYS.length &&
      state.artifact.remediations.length >= 1
    ) {
      const previous = state.artifact.hypotheses[0];
      const currentBasis = basisKey(state);
      if (currentBasis !== compactState({
        evidence: previous.basisEvidenceIds,
        failures: [],
        challenges: [],
      })) {
        runTask(
          key,
          taskSnapshot("hypothesis", "hypothesis:revision"),
          hypothesisPrompt("revision", state),
          HYPOTHESIS_SCHEMA,
        );
      }
    }
  };

  agents["hypothesis-analyst"].setHandlers([
    bounded(
      "hypothesis-analyst",
      "react-to-state",
      new MatchingEvent(({ event }) =>
        [
          "faultline.evidence.published",
          "faultline.participant.failed",
          "faultline.recommendation.published",
        ].includes(event.type),
      ),
      () => considerHypothesis(),
    ),
    bounded(
      "hypothesis-analyst",
      "publish-output",
      isSelfAnswer("hypothesis-analyst"),
      (context) => {
        const key: ParticipantKey = "hypothesis-analyst";
        const task = state.activeTasks.get(key);
        const text = answerText(context);
        if (!task || text === FAILED_INFERENCE_MARKER || state.participant(key).status === "failed") return;
        const version = state.artifact.hypotheses.length + 1;
        const id = `hypothesis-${String(version).padStart(3, "0")}`;
        const previous = state.artifact.hypotheses.at(-1);
        const hypothesis = parseHypothesis(
          text,
          id,
          version,
          context.event.occurredAt.toISOString(),
          task.basisEvidenceIds,
          task.basisChallengeIds,
          previous?.id,
        );
        state.artifact.hypotheses.push(hypothesis);
        state.activeTasks.delete(key);
        emit(
          version === 1 ? "faultline.hypothesis.published" : "faultline.hypothesis.revised",
          key,
          hypothesis,
        );
      },
    ),
  ]);

  agents.skeptic.setHandlers([
    bounded(
      "skeptic",
      "react-to-hypothesis",
      new MatchingEvent(({ event }) => event.type === "faultline.hypothesis.published"),
      () => {
        if (state.artifact.challenges.length > 0) return;
        runTask(
          "skeptic",
          taskSnapshot("skeptic", "skeptic:challenge"),
          skepticPrompt(state),
          CHALLENGE_SCHEMA,
        );
      },
    ),
    bounded("skeptic", "publish-output", isSelfAnswer("skeptic"), (context) => {
      const key: ParticipantKey = "skeptic";
      const task = state.activeTasks.get(key);
      const text = answerText(context);
      if (!task || text === FAILED_INFERENCE_MARKER || state.participant(key).status === "failed") return;
      const id = `challenge-${String(state.artifact.challenges.length + 1).padStart(3, "0")}`;
      const challenge = parseChallenge(
        text,
        id,
        context.event.occurredAt.toISOString(),
        task.basisHypothesisIds,
      );
      state.artifact.challenges.push(challenge);
      state.activeTasks.delete(key);
      emit("faultline.challenge.published", key, challenge);
    }),
  ]);

  considerRecovery = () => {
    const key: ParticipantKey = "recovery-planner";
    if (state.participant(key).status === "failed" || state.activeTasks.has(key)) return;
    const skepticFailed = state.participant("skeptic").status === "failed";
    if (
      state.artifact.remediations.length === 0 &&
      state.artifact.hypotheses.length >= 1 &&
      (state.artifact.challenges.length >= 1 || skepticFailed)
    ) {
      runTask(
        key,
        taskSnapshot("recovery", "recovery:initial"),
        recoveryPrompt("initial", state),
        RECOMMENDATION_SCHEMA,
      );
      return;
    }
    if (
      state.artifact.remediations.length === 1 &&
      state.artifact.hypotheses.length >= 2
    ) {
      runTask(
        key,
        taskSnapshot("recovery", "recovery:revision"),
        recoveryPrompt("revision", state),
        RECOMMENDATION_SCHEMA,
      );
    }
  };

  agents["recovery-planner"].setHandlers([
    bounded(
      "recovery-planner",
      "react-to-state",
      new MatchingEvent(({ event }) =>
        [
          "faultline.challenge.published",
          "faultline.hypothesis.revised",
          "faultline.recommendation.published",
          "faultline.participant.failed",
        ].includes(event.type),
      ),
      () => considerRecovery(),
    ),
    bounded(
      "recovery-planner",
      "publish-output",
      isSelfAnswer("recovery-planner"),
      (context) => {
        const key: ParticipantKey = "recovery-planner";
        const task = state.activeTasks.get(key);
        const text = answerText(context);
        if (!task || text === FAILED_INFERENCE_MARKER || state.participant(key).status === "failed") return;
        const draft = parseRecommendationDraft(text);
        const validEvidenceIds = draft.supportingEvidenceIds.filter((id) =>
          state.artifact.evidence.some((item) => item.id === id),
        );
        const validHypothesisIds = draft.basedOnHypothesisIds.filter((id) =>
          state.artifact.hypotheses.some((item) => item.id === id),
        );
        const version = state.artifact.remediations.length + 1;
        const recommendation = {
          id: `recommendation-${String(version).padStart(3, "0")}`,
          version,
          timestamp: context.event.occurredAt.toISOString(),
          action: draft.action,
          rationale: draft.rationale,
          impact: draft.impact,
          supportingEvidenceIds: validEvidenceIds,
          basedOnHypothesisIds: validHypothesisIds,
          ...(version > 1
            ? { revisionOf: state.artifact.remediations.at(-1)!.id }
            : {}),
          gate: evaluateRecommendationGate({
            impact: draft.impact,
            supportingEvidenceIds: validEvidenceIds,
            basedOnHypothesisIds: validHypothesisIds,
            evidence: state.artifact.evidence,
            hypotheses: state.artifact.hypotheses,
            challenges: state.artifact.challenges,
          }),
        };
        state.artifact.remediations.push(recommendation);
        state.activeTasks.delete(key);
        emit(
          version === 1
            ? "faultline.recommendation.published"
            : "faultline.recommendation.updated",
          key,
          recommendation,
        );
        maybeFinalize();
      },
    ),
  ]);

  const commander = createHuman({
    name: "Incident Commander",
    capabilities: ["incident dispatch"],
    handlers: [],
  });

  const coordinatorHandler: SituationHandler = {
    specification: new MatchingEvent(({ event }) =>
      [
        "inference.started",
        "model.answer",
        "faultline.evidence.published",
        "faultline.hypothesis.published",
        "faultline.hypothesis.revised",
        "faultline.challenge.published",
        "faultline.recommendation.published",
        "faultline.recommendation.updated",
        "faultline.participant.failed",
      ].includes(event.type),
    ),
    processor: {
      apply({ event }) {
        if (event.type === "inference.started") {
          state.recordInferenceStarted(event);
          return;
        }
        if (event.type === "model.answer") {
          state.recordModelAnswer(event);
          return;
        }
        if (event.type === "faultline.evidence.published") {
          const payload = event.payload as { id: string; source: string };
          state.appendJournal(event, `${payload.source} published structured evidence.`, [payload.id]);
          return;
        }
        if (event.type === "faultline.hypothesis.published" || event.type === "faultline.hypothesis.revised") {
          const payload = event.payload as { id: string; version: number };
          state.appendJournal(event, `Hypothesis version ${payload.version} was ${payload.version === 1 ? "published" : "revised"}.`, [payload.id]);
          return;
        }
        if (event.type === "faultline.challenge.published") {
          const payload = event.payload as { id: string };
          state.appendJournal(event, "The skeptic published a challenge.", [payload.id]);
          return;
        }
        if (event.type === "faultline.recommendation.published" || event.type === "faultline.recommendation.updated") {
          const payload = event.payload as { id: string; gate: { status: string } };
          state.appendJournal(event, `Recovery recommendation was ${event.type.endsWith("updated") ? "updated" : "published"} with gate ${payload.gate.status}.`, [payload.id]);
          return;
        }
        if (event.type === "faultline.participant.failed") {
          const payload = event.payload as FailurePayload;
          state.appendJournal(event, `${payload.participant} failed at the FAULTLINE boundary during ${payload.phase}.`);
          considerHypothesis();
          considerRecovery();
          maybeFinalize();
        }
      },
    },
  };

  const coordinator = createHuman({
    name: "Runtime Coordinator",
    capabilities: ["journal and lifecycle projection"],
    handlers: [coordinatorHandler],
  });

  runtime.join(commander);
  runtime.join(coordinator);
  for (const key of Object.keys(agents) as ParticipantKey[]) runtime.join(agents[key]);

  let finishRun: (artifact: FaultlineRunArtifact) => void = () => {};
  let finalized = false;
  const completion = new Promise<FaultlineRunArtifact>((resolve) => {
    finishRun = resolve;
  });

  const finalize = (note: string): void => {
    if (finalized) return;
    finalized = true;
    const completedAt = new Date();
    const failures = state.artifact.participants
      .filter((item) => item.status === "failed")
      .map((item) => item.key);
    const hasUsefulResult =
      state.artifact.evidence.length > 0 ||
      state.artifact.hypotheses.length > 0 ||
      state.artifact.remediations.length > 0;
    state.artifact.incident.status =
      failures.length === 0 && state.artifact.remediations.length >= 2
        ? "complete"
        : hasUsefulResult
          ? "partial"
          : "failed";
    state.artifact.incident.completedAt = completedAt.toISOString();
    state.artifact.geminiCalls = mode === "live" ? runner.calls : 0;
    state.finishTiming(completedAt);
    const latestHypothesis = state.artifact.hypotheses.at(-1);
    const latestRecommendation = state.artifact.remediations.at(-1);
    state.artifact.finalSummary = {
      status: state.artifact.incident.status,
      evidenceCount: state.artifact.evidence.length,
      hypothesisRevisions: Math.max(0, state.artifact.hypotheses.length - 1),
      challengeCount: state.artifact.challenges.length,
      recommendationRevisions: Math.max(0, state.artifact.remediations.length - 1),
      ...(latestHypothesis ? { leadingHypothesis: latestHypothesis.statement } : {}),
      ...(latestRecommendation
        ? {
            recommendation: {
              action: latestRecommendation.action,
              gateStatus: latestRecommendation.gate.status,
            },
          }
        : {}),
      failures,
      note,
    };
    state.appendJournal(
      SemanticEvent.create("faultline.incident.completed", commander.getId(), {
        status: state.artifact.incident.status,
      }),
      `Incident analysis completed with status ${state.artifact.incident.status}.`,
      [state.artifact.incident.id],
    );
    finishRun(state.artifact);
  };

  maybeFinalize = () => {
    if (finalized || state.investigatorTerminalCount() < INVESTIGATOR_KEYS.length) return;
    if (state.artifact.remediations.length >= 2 && !state.hasActiveTasks()) {
      finalize("Investigation and both adaptive downstream passes completed.");
      return;
    }
    const fatalDownstreamFailure = state.artifact.participants.some(
      (item) =>
        ["hypothesis-analyst", "recovery-planner"].includes(item.key) &&
        item.status === "failed",
    );
    if ((fatalDownstreamFailure || state.artifact.evidence.length === 0) && !state.hasActiveTasks()) {
      finalize("A contained participant failure prevented the full downstream workflow; useful partial state was preserved.");
    }
  };

  const timeout = setTimeout(() => {
    finalize("The run reached its timeout; all state produced before timeout was preserved.");
  }, options.timeoutMs ?? (mode === "live" ? 120_000 : 5_000));

  state.appendJournal(
    SemanticEvent.create("faultline.incident.dispatched", commander.getId(), {
      incidentId: state.artifact.incident.id,
    }),
    "Incident was dispatched to three independent investigators.",
    [state.artifact.incident.id],
  );
  runtime.sendMessage(incidentText, commander.getId());

  const artifact = await completion;
  clearTimeout(timeout);
  return { artifact, inferenceCalls: runner.calls };
}
