import { RuntimeState, type SemanticEvent } from "@mozaik-ai/core";

import { maximumConcurrency } from "../timing.js";
import type {
  ExecutionTiming,
  FaultlineRunArtifact,
  JournalEntry,
  ParticipantKey,
  ParticipantStatus,
  RunMode,
  SafeProviderFailure,
} from "./types.js";

export interface ActiveTask {
  id: string;
  kind: "investigator" | "hypothesis" | "skeptic" | "recovery";
  stage: string;
  basisKey: string;
  basisEvidenceIds: string[];
  basisHypothesisIds: string[];
  basisChallengeIds: string[];
}

const INVESTIGATOR_KEYS = new Set<ParticipantKey>([
  "telemetry-investigator",
  "log-investigator",
  "change-investigator",
]);

function iso(timestamp: Date | number): string {
  return new Date(timestamp).toISOString();
}

export class FaultlineRuntimeState extends RuntimeState {
  readonly artifact: FaultlineRunArtifact;
  readonly keysById = new Map<string, ParticipantKey>();
  readonly idsByKey = new Map<ParticipantKey, string>();
  readonly contextOwners = new Map<string, ParticipantKey>();
  readonly activeTasks = new Map<ParticipantKey, ActiveTask>();

  constructor(runId: string, mode: RunMode, model: string, incidentText: string) {
    super();
    const startedAt = new Date().toISOString();
    this.artifact = {
      schemaVersion: "1.0",
      runId,
      mode,
      model,
      geminiCalls: 0,
      inference: {
        logicalTasks: 0,
        providerAttempts: 0,
        retries: 0,
        retryBudget: 1,
        attempts: [],
      },
      incident: {
        id: `incident-${runId}`,
        text: incidentText,
        startedAt,
        status: "running",
      },
      participants: [],
      evidence: [],
      hypotheses: [],
      challenges: [],
      remediations: [],
      timeline: [],
      timing: {
        totalRunWallTimeMs: 0,
        maximumConcurrency: 0,
        investigatorMaximumConcurrency: 0,
        investigatorIntervalsOverlap: false,
        executions: [],
      },
      resilience: {
        boundary: "faultline-participant-boundary",
        nativeMozaikHandlerIsolation: "not-provided",
        failuresContained: 0,
      },
    };
  }

  registerParticipant(
    key: ParticipantKey,
    id: string,
    name: string,
    focus: string,
    contextId: string,
  ): void {
    this.keysById.set(id, key);
    this.idsByKey.set(key, id);
    this.contextOwners.set(contextId, key);
    this.artifact.participants.push({
      id,
      key,
      name,
      focus,
      status: "idle",
      inferenceCount: 0,
    });
  }

  participant(key: ParticipantKey): ParticipantStatus {
    const participant = this.artifact.participants.find((item) => item.key === key);
    if (!participant) throw new Error(`Participant ${key} is not registered`);
    return participant;
  }

  appendJournal(
    event: Pick<SemanticEvent, "occurredAt" | "producerId" | "type">,
    summary: string,
    objectIds: string[] = [],
  ): JournalEntry {
    const participant = this.keysById.get(event.producerId);
    const entry: JournalEntry = {
      sequence: this.artifact.timeline.length + 1,
      timestamp: event.occurredAt.toISOString(),
      participantId: event.producerId,
      participant: participant ?? "incident-commander",
      eventType: event.type,
      summary,
      objectIds,
    };
    this.artifact.timeline.push(entry);
    return entry;
  }

  recordInferenceStarted(event: SemanticEvent): void {
    const key = this.keysById.get(event.producerId);
    if (!key) return;
    const participant = this.participant(key);
    const task = this.activeTasks.get(key);
    const payload = event.payload as { loopId?: string };
    participant.status = "running";
    participant.startedAt ??= event.occurredAt.toISOString();
    participant.inferenceCount += 1;
    this.artifact.timing.executions.push({
      id: payload.loopId ?? `execution-${this.artifact.timing.executions.length + 1}`,
      participantId: event.producerId,
      participant: key,
      stage: task?.stage ?? "unknown",
      startedAt: event.occurredAt.toISOString(),
    });
    this.appendJournal(
      event,
      `${participant.name} started ${task?.stage ?? "inference"}.`,
    );
  }

  recordModelAnswer(event: SemanticEvent, successful: boolean): void {
    const key = this.keysById.get(event.producerId);
    if (!key) return;
    const participant = this.participant(key);
    const execution = [...this.artifact.timing.executions]
      .reverse()
      .find((item) => item.participant === key && item.finishedAt === undefined);
    if (execution) {
      execution.finishedAt = event.occurredAt.toISOString();
      execution.durationMs =
        event.occurredAt.getTime() - new Date(execution.startedAt).getTime();
    }
    participant.finishedAt = event.occurredAt.toISOString();
    participant.durationMs =
      new Date(participant.finishedAt).getTime() -
      new Date(participant.startedAt ?? participant.finishedAt).getTime();
    if (successful) {
      if (participant.status !== "failed") participant.status = "completed";
      this.appendJournal(event, `${participant.name} completed inference.`);
    }
  }

  markFailed(
    key: ParticipantKey,
    phase: string,
    kind: string,
    provider?: SafeProviderFailure,
    at = new Date(),
  ): void {
    const participant = this.participant(key);
    if (participant.status === "failed") return;
    participant.status = "failed";
    participant.finishedAt = iso(at);
    participant.durationMs = participant.startedAt
      ? at.getTime() - new Date(participant.startedAt).getTime()
      : 0;
    participant.failure = {
      phase,
      kind,
      timestamp: iso(at),
      ...(provider ? { provider } : {}),
    };
    if (phase !== "inference") this.activeTasks.delete(key);
    this.artifact.resilience.failuresContained += 1;
  }

  investigatorTerminalCount(): number {
    return this.artifact.participants.filter(
      (item) => INVESTIGATOR_KEYS.has(item.key) && ["completed", "failed"].includes(item.status),
    ).length;
  }

  hasActiveTasks(): boolean {
    return this.activeTasks.size > 0;
  }

  finishTiming(completedAt: Date): void {
    const completed = this.artifact.timing.executions
      .filter((item): item is ExecutionTiming & { finishedAt: string; durationMs: number } =>
        item.finishedAt !== undefined && item.durationMs !== undefined,
      )
      .map((item) => ({
        name: item.participant,
        startedAtMs: new Date(item.startedAt).getTime(),
        finishedAtMs: new Date(item.finishedAt).getTime(),
      }));
    const investigators = completed.filter((item) =>
      INVESTIGATOR_KEYS.has(item.name as ParticipantKey),
    );
    const latestInvestigatorStart = Math.max(
      ...investigators.map((item) => item.startedAtMs),
    );
    const earliestInvestigatorFinish = Math.min(
      ...investigators.map((item) => item.finishedAtMs),
    );
    this.artifact.timing.totalRunWallTimeMs =
      completedAt.getTime() - new Date(this.artifact.incident.startedAt).getTime();
    this.artifact.timing.maximumConcurrency = maximumConcurrency(completed);
    this.artifact.timing.investigatorMaximumConcurrency = maximumConcurrency(investigators);
    this.artifact.timing.investigatorIntervalsOverlap =
      investigators.length === 3 && latestInvestigatorStart < earliestInvestigatorFinish;
  }
}
