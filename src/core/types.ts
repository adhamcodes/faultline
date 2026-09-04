export type RunMode = "deterministic" | "live";
export type IncidentStatus = "running" | "complete" | "partial" | "failed";
export type ParticipantState = "idle" | "running" | "completed" | "failed";
export type GateStatus = "proposed" | "supported" | "ready";
export type Impact = "low" | "medium" | "high";

export type ParticipantKey =
  | "telemetry-investigator"
  | "log-investigator"
  | "change-investigator"
  | "hypothesis-analyst"
  | "skeptic"
  | "recovery-planner";

export interface IncidentMetadata {
  id: string;
  text: string;
  startedAt: string;
  completedAt?: string;
  status: IncidentStatus;
}

export interface ParticipantStatus {
  id: string;
  key: ParticipantKey;
  name: string;
  focus: string;
  status: ParticipantState;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  inferenceCount: number;
  failure?: {
    phase: string;
    kind: string;
    timestamp: string;
    provider?: SafeProviderFailure;
  };
}

export interface SafeProviderFailure {
  name: string;
  httpStatus?: number;
  retryable: boolean;
  attempt: number;
}

export interface ProviderAttempt {
  logicalTaskId: string;
  participant: ParticipantKey | "unknown";
  stage: string;
  attempt: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  outcome: "succeeded" | "failed";
  failure?: SafeProviderFailure;
}

export interface InferenceAccounting {
  logicalTasks: number;
  providerAttempts: number;
  retries: number;
  retryBudget: 1;
  attempts: ProviderAttempt[];
}

export interface EvidenceItem {
  id: string;
  sourceParticipantId: string;
  source: ParticipantKey;
  timestamp: string;
  category: "telemetry" | "logs" | "changes" | "database" | "cache" | "other";
  observation: string;
  confidence: number;
  supports: string[];
  contradicts: string[];
}

export interface Hypothesis {
  id: string;
  version: number;
  timestamp: string;
  statement: string;
  confidence: number;
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  addressesChallengeIds: string[];
  basisEvidenceIds: string[];
  revisionOf?: string;
}

export interface SkepticChallenge {
  id: string;
  timestamp: string;
  claim: string;
  severity: "low" | "medium" | "high";
  missingEvidence: string;
  targetHypothesisIds: string[];
}

export interface RecommendationGate {
  status: GateStatus;
  independentSupportCount: number;
  highConfidenceSupportCount: number;
  unresolvedHighChallenges: string[];
  rationale: string;
}

export interface RemediationRecommendation {
  id: string;
  version: number;
  timestamp: string;
  action: string;
  rationale: string;
  impact: Impact;
  supportingEvidenceIds: string[];
  basedOnHypothesisIds: string[];
  revisionOf?: string;
  gate: RecommendationGate;
}

export interface JournalEntry {
  sequence: number;
  timestamp: string;
  participantId: string;
  participant: string;
  eventType: string;
  summary: string;
  objectIds: string[];
}

export interface ExecutionTiming {
  id: string;
  participantId: string;
  participant: ParticipantKey;
  stage: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
}

export interface TimingStatistics {
  totalRunWallTimeMs: number;
  maximumConcurrency: number;
  investigatorMaximumConcurrency: number;
  investigatorIntervalsOverlap: boolean;
  executions: ExecutionTiming[];
}

export interface FinalSummary {
  status: IncidentStatus;
  evidenceCount: number;
  hypothesisRevisions: number;
  challengeCount: number;
  recommendationRevisions: number;
  leadingHypothesis?: string;
  recommendation?: {
    action: string;
    gateStatus: GateStatus;
  };
  failures: ParticipantKey[];
  note: string;
}

export interface ResilienceSummary {
  boundary: "faultline-participant-boundary";
  nativeMozaikHandlerIsolation: "not-provided";
  failuresContained: number;
}

export interface FaultlineRunArtifact {
  schemaVersion: "1.0";
  runId: string;
  mode: RunMode;
  model: string;
  /** @deprecated Use inference.providerAttempts for provider-call accounting. */
  geminiCalls: number;
  inference: InferenceAccounting;
  incident: IncidentMetadata;
  participants: ParticipantStatus[];
  evidence: EvidenceItem[];
  hypotheses: Hypothesis[];
  challenges: SkepticChallenge[];
  remediations: RemediationRecommendation[];
  timeline: JournalEntry[];
  timing: TimingStatistics;
  finalSummary?: FinalSummary;
  resilience: ResilienceSummary;
}
