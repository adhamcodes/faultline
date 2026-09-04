import type {
  EvidenceItem,
  Hypothesis,
  Impact,
  RecommendationGate,
  SkepticChallenge,
} from "./types.js";

export interface GateInput {
  impact: Impact;
  supportingEvidenceIds: string[];
  basedOnHypothesisIds: string[];
  evidence: EvidenceItem[];
  hypotheses: Hypothesis[];
  challenges: SkepticChallenge[];
}

export function evaluateRecommendationGate(input: GateInput): RecommendationGate {
  const requestedIds = new Set(input.supportingEvidenceIds);
  const supportingEvidence = input.evidence.filter((item) => requestedIds.has(item.id));
  const independentSupportCount = new Set(
    supportingEvidence.map((item) => item.source),
  ).size;
  const highConfidenceSupportCount = new Set(
    supportingEvidence
      .filter((item) => item.confidence >= 0.75)
      .map((item) => item.source),
  ).size;

  const relevantHypotheses = input.hypotheses.filter((hypothesis) =>
    input.basedOnHypothesisIds.includes(hypothesis.id),
  );
  const addressedChallenges = new Set(
    relevantHypotheses.flatMap((hypothesis) => hypothesis.addressesChallengeIds),
  );
  const unresolvedHighChallenges = input.challenges
    .filter(
      (challenge) =>
        challenge.severity === "high" && !addressedChallenges.has(challenge.id),
    )
    .map((challenge) => challenge.id);

  let status: RecommendationGate["status"] = "proposed";
  if (independentSupportCount >= 2) status = "supported";

  const requiredHighConfidenceSources = input.impact === "high" ? 3 : 2;
  if (
    independentSupportCount >= requiredHighConfidenceSources &&
    highConfidenceSupportCount >= requiredHighConfidenceSources &&
    unresolvedHighChallenges.length === 0
  ) {
    status = "ready";
  }

  const rationale =
    status === "ready"
      ? `${highConfidenceSupportCount} independent high-confidence sources support the action and no high-severity challenge remains unresolved.`
      : status === "supported"
        ? `${independentSupportCount} independent sources support the action, but the readiness threshold for a ${input.impact}-impact action is not met.`
        : `Only ${independentSupportCount} independent source(s) currently support the action.`;

  return {
    status,
    independentSupportCount,
    highConfidenceSupportCount,
    unresolvedHighChallenges,
    rationale,
  };
}
