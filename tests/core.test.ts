import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { assertRunArtifact, writeRunArtifact } from "../src/core/artifact.js";
import { runFaultline } from "../src/core/engine.js";
import { DeterministicInferenceRunner } from "../src/core/inference.js";

describe("FAULTLINE deterministic production core", () => {
  it("runs the concurrent, aware, adaptive incident workflow", async () => {
    const runner = new DeterministicInferenceRunner();
    const { artifact, inferenceCalls } = await runFaultline({
      mode: "deterministic",
      inferenceRunner: runner,
      timeoutMs: 2_000,
    });

    assert.equal(artifact.incident.status, "complete");
    assert.equal(inferenceCalls, 8);
    assert.equal(artifact.geminiCalls, 0);
    assert.equal(artifact.evidence.length, 3);
    assert.equal(artifact.evidence.every((item) => item.observation.length > 0), true);
    assert.equal(new Set(artifact.evidence.map((item) => item.source)).size, 3);
    assert.equal(artifact.hypotheses.length, 2);
    assert.notEqual(artifact.hypotheses[0].statement, artifact.hypotheses[1].statement);
    assert.equal(artifact.hypotheses[0].basisEvidenceIds.length, 1);
    assert.equal(artifact.hypotheses[1].basisEvidenceIds.length, 3);
    assert.equal(artifact.challenges.length, 1);
    assert.equal(artifact.remediations.length, 2);
    assert.equal(artifact.remediations[0].gate.status, "proposed");
    assert.equal(artifact.remediations[1].gate.status, "ready");
    assert.equal(artifact.timing.investigatorMaximumConcurrency, 3);
    assert.equal(artifact.timing.investigatorIntervalsOverlap, true);
    assert.equal(runner.maximumActive >= 3, true);

    const lastInvestigatorFinish = Math.max(
      ...artifact.timing.executions
        .filter((item) => item.participant.endsWith("-investigator"))
        .map((item) => new Date(item.finishedAt!).getTime()),
    );
    assert.equal(new Date(artifact.hypotheses[0].timestamp).getTime() < lastInvestigatorFinish, true);

    const eventTypes = artifact.timeline.map((item) => item.eventType);
    for (const expected of [
      "faultline.evidence.published",
      "faultline.hypothesis.published",
      "faultline.hypothesis.revised",
      "faultline.challenge.published",
      "faultline.recommendation.published",
      "faultline.recommendation.updated",
    ]) {
      assert.equal(eventTypes.includes(expected), true, expected);
    }
    assert.deepEqual(
      artifact.timeline.map((item) => item.sequence),
      artifact.timeline.map((_, index) => index + 1),
    );
    assert.equal(
      artifact.timeline.every(
        (item) =>
          Number.isFinite(Date.parse(item.timestamp)) &&
          item.participantId.length > 0 &&
          item.summary.length > 0 &&
          Array.isArray(item.objectIds),
      ),
      true,
    );
  });

  it("serializes and writes a frontend-ready JSON artifact", async () => {
    const customIncident = "Synthetic custom incident supplied through the core CLI boundary.";
    const { artifact } = await runFaultline({
      mode: "deterministic",
      incidentText: customIncident,
      inferenceRunner: new DeterministicInferenceRunner(),
      timeoutMs: 2_000,
    });
    const directory = await mkdtemp(path.join(tmpdir(), "faultline-artifact-"));
    try {
      const artifactPath = await writeRunArtifact(artifact, directory);
      const parsed = JSON.parse(await readFile(artifactPath, "utf8")) as unknown;
      assertRunArtifact(parsed);
      assert.equal(parsed.runId, artifact.runId);
      assert.equal(parsed.incident.text, customIncident);
      assert.equal(parsed.timeline.length > 0, true);
      assert.equal(JSON.stringify(parsed).includes("[object Map]"), false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
