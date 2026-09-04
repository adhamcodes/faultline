import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { assertRunArtifact } from "../core/artifact.js";
import { DEMO_INCIDENT, runFaultline } from "../core/engine.js";
import { DeterministicInferenceRunner } from "../core/inference.js";
import type {
  FaultlineRunArtifact,
  Hypothesis,
  ProviderAttempt,
} from "../core/types.js";

const RETRY_GAP_DISPLAY_MS = 1_400;

export interface LoadedRun {
  id: string;
  fileName: string;
  source: "artifact" | "fallback";
  modifiedAt: string;
  artifact: FaultlineRunArtifact;
}

export interface RunLoadResult {
  runs: LoadedRun[];
  skippedMalformed: string[];
  usedFallback: boolean;
}

interface CompressionWindow {
  startMs: number;
  endMs: number;
  savedMs: number;
  displayMs: number;
  status?: number;
  logicalTaskId: string;
}

export interface DashboardView {
  run: {
    id: string;
    mode: FaultlineRunArtifact["mode"];
    model: string;
    status: FaultlineRunArtifact["incident"]["status"];
    startedAt: string;
    completedAt?: string;
    wallTimeMs: number;
  };
  current: {
    hypothesis?: Hypothesis;
    recommendation?: FaultlineRunArtifact["remediations"][number];
  };
  metrics: {
    maximumConcurrency: number;
    investigatorConcurrency: number;
    evidenceCount: number;
    participantCount: number;
    logicalTasks: number;
    providerAttempts: number;
    retries: number;
  };
  timeline: {
    durationMs: number;
    actualDurationMs: number;
    ticks: Array<{ leftPercent: number; label: string }>;
    breaks: Array<{
      leftPercent: number;
      label: string;
      logicalTaskId: string;
      status?: number;
    }>;
    executions: Array<
      FaultlineRunArtifact["timing"]["executions"][number] & {
        leftPercent: number;
        widthPercent: number;
        failed: boolean;
        retryAttempt?: number;
      }
    >;
  };
  retryChains: Array<{
    logicalTaskId: string;
    stage: string;
    participant: string;
    attempts: Array<{
      attempt: number;
      outcome: ProviderAttempt["outcome"];
      durationMs: number;
      status?: number;
      retryable?: boolean;
    }>;
    retryDelayMs?: number;
  }>;
  hypothesisEvolution?: {
    before: Hypothesis;
    after: Hypothesis;
    statementChanged: boolean;
    confidenceDelta: number;
    addedEvidenceIds: string[];
    newlyAddressedChallengeIds: string[];
  };
  replay: Array<{
    sequence: number;
    relativeMs: number;
    timestamp: string;
    participant: string;
    eventType: string;
    summary: string;
    objectIds: string[];
  }>;
}

export async function createDeterministicFallback(): Promise<FaultlineRunArtifact> {
  const result = await runFaultline({
    incidentText: DEMO_INCIDENT,
    mode: "deterministic",
    inferenceRunner: new DeterministicInferenceRunner({
      failureStatuses: { "hypothesis:revision": [429] },
    }),
    retry: { sleep: async () => {} },
  });
  return result.artifact;
}

export async function loadRunCatalog(
  runsDirectory: string,
  fallbackFactory: () => Promise<FaultlineRunArtifact> = createDeterministicFallback,
): Promise<RunLoadResult> {
  const candidates: Array<{ fileName: string; modifiedMs: number }> = [];
  try {
    for (const entry of await readdir(runsDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;
      const info = await stat(path.join(runsDirectory, entry.name));
      candidates.push({ fileName: entry.name, modifiedMs: info.mtimeMs });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  candidates.sort((left, right) => right.modifiedMs - left.modifiedMs);
  const runs: LoadedRun[] = [];
  const skippedMalformed: string[] = [];
  for (const candidate of candidates) {
    try {
      const content = await readFile(path.join(runsDirectory, candidate.fileName), "utf8");
      const parsed: unknown = JSON.parse(content);
      assertRunArtifact(parsed);
      runs.push({
        id: candidate.fileName,
        fileName: candidate.fileName,
        source: "artifact",
        modifiedAt: new Date(candidate.modifiedMs).toISOString(),
        artifact: parsed,
      });
    } catch {
      skippedMalformed.push(candidate.fileName);
    }
  }

  runs.sort((left, right) => {
    const leftStarted = timeMs(left.artifact.incident.startedAt, timeMs(left.modifiedAt, 0));
    const rightStarted = timeMs(right.artifact.incident.startedAt, timeMs(right.modifiedAt, 0));
    return rightStarted - leftStarted || timeMs(right.modifiedAt, 0) - timeMs(left.modifiedAt, 0);
  });

  if (runs.length > 0) return { runs, skippedMalformed, usedFallback: false };
  const artifact = await fallbackFactory();
  return {
    runs: [{
      id: "deterministic-fallback",
      fileName: "deterministic-fallback",
      source: "fallback",
      modifiedAt: artifact.incident.completedAt ?? artifact.incident.startedAt,
      artifact,
    }],
    skippedMalformed,
    usedFallback: true,
  };
}

function timeMs(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function retryWindows(artifact: FaultlineRunArtifact): CompressionWindow[] {
  const byTask = new Map<string, ProviderAttempt[]>();
  for (const attempt of artifact.inference.attempts) {
    const list = byTask.get(attempt.logicalTaskId) ?? [];
    list.push(attempt);
    byTask.set(attempt.logicalTaskId, list);
  }
  const windows: CompressionWindow[] = [];
  for (const [logicalTaskId, attempts] of byTask) {
    attempts.sort((left, right) => left.attempt - right.attempt);
    for (let index = 1; index < attempts.length; index += 1) {
      const previous = attempts[index - 1];
      const current = attempts[index];
      const startMs = timeMs(previous.finishedAt, 0);
      const endMs = timeMs(current.startedAt, startMs);
      const gapMs = Math.max(0, endMs - startMs);
      if (gapMs <= RETRY_GAP_DISPLAY_MS) continue;
      windows.push({
        startMs,
        endMs,
        savedMs: gapMs - RETRY_GAP_DISPLAY_MS,
        displayMs: RETRY_GAP_DISPLAY_MS,
        status: previous.failure?.httpStatus,
        logicalTaskId,
      });
    }
  }
  return windows.sort((left, right) => left.startMs - right.startMs);
}

function compressedTime(value: number, windows: CompressionWindow[]): number {
  let compressed = value;
  for (const window of windows) {
    if (value >= window.endMs) compressed -= window.savedMs;
    else if (value > window.startMs) {
      const elapsed = value - window.startMs;
      const ratio = elapsed / Math.max(1, window.endMs - window.startMs);
      compressed -= elapsed - ratio * window.displayMs;
    }
  }
  return compressed;
}

export function buildDashboardView(artifact: FaultlineRunArtifact): DashboardView {
  const startMs = timeMs(artifact.incident.startedAt, 0);
  const completedMs = timeMs(artifact.incident.completedAt, startMs + artifact.timing.totalRunWallTimeMs);
  const windows = retryWindows(artifact);
  const compressedStart = compressedTime(startMs, windows);
  const compressedEnd = compressedTime(completedMs, windows);
  const durationMs = Math.max(1, compressedEnd - compressedStart);
  const percentAt = (value: number): number =>
    Math.max(0, Math.min(100, ((compressedTime(value, windows) - compressedStart) / durationMs) * 100));

  const attemptByStageStart = new Map(
    artifact.inference.attempts.map((attempt) => [
      `${attempt.participant}|${attempt.stage}|${attempt.startedAt}`,
      attempt,
    ]),
  );
  const failedParticipants = new Set(
    artifact.participants.filter((participant) => participant.status === "failed").map((participant) => participant.id),
  );
  const executions = artifact.timing.executions.map((execution) => {
    const executionStart = timeMs(execution.startedAt, startMs);
    const executionEnd = timeMs(execution.finishedAt, executionStart + (execution.durationMs ?? 1));
    const leftPercent = percentAt(executionStart);
    const endPercent = percentAt(executionEnd);
    const attempt = attemptByStageStart.get(`${execution.participant}|${execution.stage}|${execution.startedAt}`);
    return {
      ...execution,
      leftPercent,
      widthPercent: Math.max(0.8, endPercent - leftPercent),
      failed: failedParticipants.has(execution.participantId),
      ...(attempt && attempt.attempt > 1 ? { retryAttempt: attempt.attempt } : {}),
    };
  });

  const tickCount = 5;
  const ticks = Array.from({ length: tickCount }, (_, index) => ({
    leftPercent: (index / (tickCount - 1)) * 100,
    label: `${Math.round((durationMs * index) / (tickCount - 1))}ms`,
  }));

  const retryChains = [...new Set(artifact.inference.attempts.map((attempt) => attempt.logicalTaskId))]
    .map((logicalTaskId) => {
      const attempts = artifact.inference.attempts
        .filter((attempt) => attempt.logicalTaskId === logicalTaskId)
        .sort((left, right) => left.attempt - right.attempt);
      const first = attempts[0];
      if (!first) return undefined;
      const firstFinished = timeMs(first.finishedAt, 0);
      const secondStarted = attempts[1] ? timeMs(attempts[1].startedAt, firstFinished) : firstFinished;
      const actualDelay = Math.max(0, secondStarted - firstFinished);
      const policyDelay = first.failure?.httpStatus === 429 ? 60_000 : 750;
      return {
        logicalTaskId,
        stage: first.stage,
        participant: first.participant,
        attempts: attempts.map((attempt) => ({
          attempt: attempt.attempt,
          outcome: attempt.outcome,
          durationMs: attempt.durationMs,
          ...(attempt.failure?.httpStatus !== undefined ? { status: attempt.failure.httpStatus } : {}),
          ...(attempt.failure ? { retryable: attempt.failure.retryable } : {}),
        })),
        ...(attempts.length > 1 ? { retryDelayMs: actualDelay > 100 ? actualDelay : policyDelay } : {}),
      };
    })
    .filter((chain): chain is NonNullable<typeof chain> => Boolean(chain));

  const before = artifact.hypotheses[0];
  const after = artifact.hypotheses.at(-1);
  const hypothesisEvolution = before && after && before.id !== after.id
    ? {
        before,
        after,
        statementChanged: before.statement.trim() !== after.statement.trim(),
        confidenceDelta: after.confidence - before.confidence,
        addedEvidenceIds: after.supportingEvidenceIds.filter((id) => !before.supportingEvidenceIds.includes(id)),
        newlyAddressedChallengeIds: after.addressesChallengeIds.filter((id) => !before.addressesChallengeIds.includes(id)),
      }
    : undefined;

  const orderedJournal = [...artifact.timeline].sort((left, right) => left.sequence - right.sequence);
  const replayEnd = 18_000;
  const replay = orderedJournal.map((entry) => ({
    ...entry,
    relativeMs: Math.round((percentAt(timeMs(entry.timestamp, startMs)) / 100) * replayEnd),
  }));

  return {
    run: {
      id: artifact.runId,
      mode: artifact.mode,
      model: artifact.model,
      status: artifact.incident.status,
      startedAt: artifact.incident.startedAt,
      ...(artifact.incident.completedAt ? { completedAt: artifact.incident.completedAt } : {}),
      wallTimeMs: artifact.timing.totalRunWallTimeMs,
    },
    current: {
      ...(after ? { hypothesis: after } : {}),
      ...(artifact.remediations.at(-1) ? { recommendation: artifact.remediations.at(-1)! } : {}),
    },
    metrics: {
      maximumConcurrency: artifact.timing.maximumConcurrency,
      investigatorConcurrency: artifact.timing.investigatorMaximumConcurrency,
      evidenceCount: artifact.evidence.length,
      participantCount: artifact.participants.length,
      logicalTasks: artifact.inference.logicalTasks,
      providerAttempts: artifact.inference.providerAttempts,
      retries: artifact.inference.retries,
    },
    timeline: {
      durationMs,
      actualDurationMs: Math.max(0, completedMs - startMs),
      ticks,
      breaks: windows.map((window) => ({
        leftPercent: percentAt(window.startMs + window.displayMs / 2),
        label: `${Math.round((window.endMs - window.startMs) / 1_000)}s retry wait compressed`,
        logicalTaskId: window.logicalTaskId,
        ...(window.status !== undefined ? { status: window.status } : {}),
      })),
      executions,
    },
    retryChains,
    ...(hypothesisEvolution ? { hypothesisEvolution } : {}),
    replay,
  };
}
