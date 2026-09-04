import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { evaluateRecommendationGate } from "../src/core/gate.js";
import type { EvidenceItem, Hypothesis, SkepticChallenge } from "../src/core/types.js";

const evidence: EvidenceItem[] = [
  { id: "e1", sourceParticipantId: "p1", source: "telemetry-investigator", timestamp: "2026-01-01T00:00:00.000Z", category: "telemetry", observation: "one", confidence: 0.9, supports: [], contradicts: [] },
  { id: "e2", sourceParticipantId: "p2", source: "log-investigator", timestamp: "2026-01-01T00:00:01.000Z", category: "logs", observation: "two", confidence: 0.85, supports: [], contradicts: [] },
  { id: "e3", sourceParticipantId: "p3", source: "change-investigator", timestamp: "2026-01-01T00:00:02.000Z", category: "changes", observation: "three", confidence: 0.8, supports: [], contradicts: [] },
];

const challenge: SkepticChallenge = {
  id: "c1",
  timestamp: "2026-01-01T00:00:03.000Z",
  claim: "Missing causal proof",
  severity: "high",
  missingEvidence: "Need independent support",
  targetHypothesisIds: ["h1"],
};

function hypothesis(addressesChallengeIds: string[]): Hypothesis {
  return {
    id: "h1",
    version: 1,
    timestamp: "2026-01-01T00:00:04.000Z",
    statement: "test",
    confidence: 0.8,
    supportingEvidenceIds: ["e1", "e2", "e3"],
    contradictingEvidenceIds: [],
    addressesChallengeIds,
    basisEvidenceIds: ["e1", "e2", "e3"],
  };
}

describe("deterministic recommendation gate", () => {
  it("keeps single-source actions proposed", () => {
    const gate = evaluateRecommendationGate({
      impact: "high",
      supportingEvidenceIds: ["e1"],
      basedOnHypothesisIds: ["h1"],
      evidence,
      hypotheses: [hypothesis([])],
      challenges: [],
    });
    assert.equal(gate.status, "proposed");
  });

  it("marks independently corroborated but insufficient high-impact actions supported", () => {
    const gate = evaluateRecommendationGate({
      impact: "high",
      supportingEvidenceIds: ["e1", "e2"],
      basedOnHypothesisIds: ["h1"],
      evidence,
      hypotheses: [hypothesis([])],
      challenges: [],
    });
    assert.equal(gate.status, "supported");
  });

  it("requires three strong sources and no unresolved high challenge for ready", () => {
    const blocked = evaluateRecommendationGate({
      impact: "high",
      supportingEvidenceIds: ["e1", "e2", "e3"],
      basedOnHypothesisIds: ["h1"],
      evidence,
      hypotheses: [hypothesis([])],
      challenges: [challenge],
    });
    assert.equal(blocked.status, "supported");

    const ready = evaluateRecommendationGate({
      impact: "high",
      supportingEvidenceIds: ["e1", "e2", "e3"],
      basedOnHypothesisIds: ["h1"],
      evidence,
      hypotheses: [hypothesis(["c1"])],
      challenges: [challenge],
    });
    assert.equal(ready.status, "ready");
  });
});
