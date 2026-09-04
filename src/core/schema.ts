import type {
  EvidenceItem,
  Hypothesis,
  Impact,
  ParticipantKey,
  RemediationRecommendation,
  SkepticChallenge,
} from "./types.js";

export const EVIDENCE_SCHEMA = {
  type: "object",
  properties: {
    category: { type: "string", enum: ["telemetry", "logs", "changes", "database", "cache", "other"] },
    observation: { type: "string" },
    confidence: { type: "number" },
    supports: { type: "array", items: { type: "string" } },
    contradicts: { type: "array", items: { type: "string" } },
  },
  required: ["category", "observation", "confidence", "supports", "contradicts"],
  additionalProperties: false,
};

export const HYPOTHESIS_SCHEMA = {
  type: "object",
  properties: {
    statement: { type: "string" },
    confidence: { type: "number" },
    supportingEvidenceIds: { type: "array", items: { type: "string" } },
    contradictingEvidenceIds: { type: "array", items: { type: "string" } },
    addressesChallengeIds: { type: "array", items: { type: "string" } },
  },
  required: ["statement", "confidence", "supportingEvidenceIds", "contradictingEvidenceIds", "addressesChallengeIds"],
  additionalProperties: false,
};

export const CHALLENGE_SCHEMA = {
  type: "object",
  properties: {
    claim: { type: "string" },
    severity: { type: "string", enum: ["low", "medium", "high"] },
    missingEvidence: { type: "string" },
    targetHypothesisIds: { type: "array", items: { type: "string" } },
  },
  required: ["claim", "severity", "missingEvidence", "targetHypothesisIds"],
  additionalProperties: false,
};

export const RECOMMENDATION_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string" },
    rationale: { type: "string" },
    impact: { type: "string", enum: ["low", "medium", "high"] },
    supportingEvidenceIds: { type: "array", items: { type: "string" } },
    basedOnHypothesisIds: { type: "array", items: { type: "string" } },
  },
  required: ["action", "rationale", "impact", "supportingEvidenceIds", "basedOnHypothesisIds"],
  additionalProperties: false,
};

function objectFromText(text: string): Record<string, unknown> {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Model response did not contain a JSON object");
  const value = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Model response JSON was not an object");
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, field: string): string {
  if (typeof value[field] !== "string" || value[field].trim() === "") {
    throw new Error(`Model response field ${field} must be a non-empty string`);
  }
  return value[field].trim();
}

function stringArray(value: Record<string, unknown>, field: string): string[] {
  if (!Array.isArray(value[field]) || !(value[field] as unknown[]).every((item) => typeof item === "string")) {
    throw new Error(`Model response field ${field} must be a string array`);
  }
  return [...new Set(value[field] as string[])];
}

function confidence(value: Record<string, unknown>): number {
  if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence)) {
    throw new Error("Model response confidence must be a number");
  }
  return Math.min(1, Math.max(0, value.confidence));
}

export function parseEvidence(
  text: string,
  id: string,
  sourceParticipantId: string,
  source: ParticipantKey,
  timestamp: string,
  knownIds: string[],
): EvidenceItem {
  const value = objectFromText(text);
  const categories: EvidenceItem["category"][] = ["telemetry", "logs", "changes", "database", "cache", "other"];
  const category = stringField(value, "category") as EvidenceItem["category"];
  if (!categories.includes(category)) throw new Error("Evidence category is invalid");
  return {
    id,
    sourceParticipantId,
    source,
    timestamp,
    category,
    observation: stringField(value, "observation"),
    confidence: confidence(value),
    supports: stringArray(value, "supports").filter((item) => knownIds.includes(item)),
    contradicts: stringArray(value, "contradicts").filter((item) => knownIds.includes(item)),
  };
}

export function parseHypothesis(
  text: string,
  id: string,
  version: number,
  timestamp: string,
  knownEvidenceIds: string[],
  knownChallengeIds: string[],
  revisionOf?: string,
): Hypothesis {
  const value = objectFromText(text);
  return {
    id,
    version,
    timestamp,
    statement: stringField(value, "statement"),
    confidence: confidence(value),
    supportingEvidenceIds: stringArray(value, "supportingEvidenceIds").filter((item) => knownEvidenceIds.includes(item)),
    contradictingEvidenceIds: stringArray(value, "contradictingEvidenceIds").filter((item) => knownEvidenceIds.includes(item)),
    addressesChallengeIds: stringArray(value, "addressesChallengeIds").filter((item) => knownChallengeIds.includes(item)),
    basisEvidenceIds: [...knownEvidenceIds],
    ...(revisionOf ? { revisionOf } : {}),
  };
}

export function parseChallenge(
  text: string,
  id: string,
  timestamp: string,
  knownHypothesisIds: string[],
): SkepticChallenge {
  const value = objectFromText(text);
  const severity = stringField(value, "severity") as SkepticChallenge["severity"];
  if (!["low", "medium", "high"].includes(severity)) throw new Error("Challenge severity is invalid");
  return {
    id,
    timestamp,
    claim: stringField(value, "claim"),
    severity,
    missingEvidence: stringField(value, "missingEvidence"),
    targetHypothesisIds: stringArray(value, "targetHypothesisIds").filter((item) => knownHypothesisIds.includes(item)),
  };
}

export function parseRecommendationDraft(text: string): Pick<
  RemediationRecommendation,
  "action" | "rationale" | "impact" | "supportingEvidenceIds" | "basedOnHypothesisIds"
> {
  const value = objectFromText(text);
  const impact = stringField(value, "impact") as Impact;
  if (!["low", "medium", "high"].includes(impact)) throw new Error("Recommendation impact is invalid");
  return {
    action: stringField(value, "action"),
    rationale: stringField(value, "rationale"),
    impact,
    supportingEvidenceIds: stringArray(value, "supportingEvidenceIds"),
    basedOnHypothesisIds: stringArray(value, "basedOnHypothesisIds"),
  };
}
