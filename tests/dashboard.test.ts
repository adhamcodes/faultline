import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { serializeRunArtifact } from "../src/core/artifact.js";
import { runFaultline } from "../src/core/engine.js";
import { DeterministicInferenceRunner } from "../src/core/inference.js";
import type { FaultlineRunArtifact } from "../src/core/types.js";
import { buildDashboardView, loadRunCatalog } from "../src/dashboard/data.js";
import { createDashboardServer } from "../src/dashboard/server.js";

let baseline: FaultlineRunArtifact;

before(async () => {
  baseline = (await runFaultline({
    mode: "deterministic",
    inferenceRunner: new DeterministicInferenceRunner(),
  })).artifact;
});

function copyArtifact(): FaultlineRunArtifact {
  return structuredClone(baseline);
}

test("dashboard timeline geometry is timestamp-derived and compresses a long retry gap", () => {
  const artifact = copyArtifact();
  const start = Date.parse("2026-01-01T00:00:00.000Z");
  artifact.incident.startedAt = new Date(start).toISOString();
  artifact.incident.completedAt = new Date(start + 64_000).toISOString();
  artifact.timing.executions = [
    ...["telemetry-investigator", "log-investigator", "change-investigator"].map((participant, index) => ({
      id: `execution-${index}`,
      participantId: artifact.participants.find((item) => item.key === participant)!.id,
      participant: participant as "telemetry-investigator" | "log-investigator" | "change-investigator",
      stage: `investigate:${participant}`,
      startedAt: new Date(start + 500).toISOString(),
      finishedAt: new Date(start + 1_500 + index * 100).toISOString(),
      durationMs: 1_000 + index * 100,
    })),
    {
      id: "execution-hypothesis",
      participantId: artifact.participants.find((item) => item.key === "hypothesis-analyst")!.id,
      participant: "hypothesis-analyst",
      stage: "hypothesis:revision",
      startedAt: new Date(start + 62_000).toISOString(),
      finishedAt: new Date(start + 63_000).toISOString(),
      durationMs: 1_000,
    },
  ];
  artifact.inference = {
    logicalTasks: 1,
    providerAttempts: 2,
    retries: 1,
    retryBudget: 1,
    attempts: [
      {
        logicalTaskId: "task-008",
        participant: "hypothesis-analyst",
        stage: "hypothesis:revision",
        attempt: 1,
        startedAt: new Date(start + 1_700).toISOString(),
        finishedAt: new Date(start + 1_800).toISOString(),
        durationMs: 100,
        outcome: "failed",
        failure: { name: "ApiError", httpStatus: 429, retryable: true, attempt: 1 },
      },
      {
        logicalTaskId: "task-008",
        participant: "hypothesis-analyst",
        stage: "hypothesis:revision",
        attempt: 2,
        startedAt: new Date(start + 61_800).toISOString(),
        finishedAt: new Date(start + 62_000).toISOString(),
        durationMs: 200,
        outcome: "succeeded",
      },
    ],
  };

  const view = buildDashboardView(artifact);
  const wave = view.timeline.executions.slice(0, 3);
  assert.deepEqual(wave.map((item) => item.leftPercent), [wave[0].leftPercent, wave[0].leftPercent, wave[0].leftPercent]);
  assert.ok(wave.every((item) => item.widthPercent > 0), "all concurrent investigator bars remain visible");
  assert.equal(view.timeline.breaks.length, 1);
  assert.equal(view.timeline.breaks[0].status, 429);
  assert.ok(view.timeline.durationMs < view.timeline.actualDurationMs - 50_000);
});

test("dashboard retry chain distinguishes one logical task from two provider attempts", () => {
  const artifact = copyArtifact();
  const attempt = artifact.inference.attempts.find((item) => item.stage === "hypothesis:revision")!;
  artifact.inference.logicalTasks = 8;
  artifact.inference.providerAttempts = 2;
  artifact.inference.retries = 1;
  artifact.inference.attempts = [
    {
      ...attempt,
      attempt: 1,
      outcome: "failed",
      failure: { name: "ApiError", httpStatus: 429, retryable: true, attempt: 1 },
    },
    { ...attempt, attempt: 2, outcome: "succeeded", failure: undefined },
  ];
  const view = buildDashboardView(artifact);
  assert.equal(view.metrics.logicalTasks, 8);
  assert.equal(view.metrics.providerAttempts, 2);
  assert.equal(view.retryChains[0].attempts.length, 2);
  assert.deepEqual(view.retryChains[0].attempts.map((item) => item.status), [429, undefined]);
});

test("hypothesis diff reports statement, confidence, evidence, and challenge changes", () => {
  const artifact = copyArtifact();
  assert.ok(artifact.hypotheses.length >= 2);
  const before = artifact.hypotheses[0];
  const after = artifact.hypotheses[1];
  after.statement = before.statement;
  after.confidence = before.confidence + 0.08;
  after.supportingEvidenceIds = [...before.supportingEvidenceIds, "ev-new"];
  after.addressesChallengeIds = ["challenge-001"];
  const change = buildDashboardView(artifact).hypothesisEvolution!;
  assert.equal(change.statementChanged, false);
  assert.ok(Math.abs(change.confidenceDelta - 0.08) < 0.000_001);
  assert.deepEqual(change.addedEvidenceIds, ["ev-new"]);
  assert.deepEqual(change.newlyAddressedChallengeIds, ["challenge-001"]);
});

test("run catalog selects newest valid artifact while skipping malformed JSON", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "faultline-dashboard-"));
  try {
    const oldArtifact = copyArtifact();
    oldArtifact.runId = "old-run";
    const newArtifact = copyArtifact();
    newArtifact.runId = "new-run";
    const oldPath = path.join(directory, "old.json");
    const newPath = path.join(directory, "new.json");
    const malformedPath = path.join(directory, "newest-malformed.json");
    await writeFile(oldPath, serializeRunArtifact(oldArtifact), "utf8");
    await writeFile(newPath, serializeRunArtifact(newArtifact), "utf8");
    await writeFile(malformedPath, "{not-json", "utf8");
    const nowSeconds = Date.now() / 1_000;
    await utimes(oldPath, nowSeconds - 30, nowSeconds - 30);
    await utimes(newPath, nowSeconds - 20, nowSeconds - 20);
    await utimes(malformedPath, nowSeconds - 10, nowSeconds - 10);
    const loaded = await loadRunCatalog(directory, async () => {
      throw new Error("fallback should not run");
    });
    assert.equal(loaded.runs[0].artifact.runId, "new-run");
    assert.deepEqual(loaded.skippedMalformed, ["newest-malformed.json"]);
    assert.equal(loaded.usedFallback, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("run catalog falls back deterministically when no valid artifact exists", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "faultline-dashboard-"));
  try {
    await writeFile(path.join(directory, "broken.json"), "[]", "utf8");
    let calls = 0;
    const loaded = await loadRunCatalog(directory, async () => {
      calls += 1;
      return copyArtifact();
    });
    assert.equal(calls, 1);
    assert.equal(loaded.usedFallback, true);
    assert.equal(loaded.runs[0].source, "fallback");
    assert.deepEqual(loaded.skippedMalformed, ["broken.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("dashboard server exposes only whitelisted assets and sanitized artifact data", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "faultline-dashboard-"));
  const server = createDashboardServer({ runsDirectory: directory, fallbackFactory: async () => copyArtifact() });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const blocked = await fetch(`${origin}/.env`);
    assert.equal(blocked.status, 404);
    const traversal = await fetch(`${origin}/assets/..%2F..%2F.env`);
    assert.equal(traversal.status, 404);
    const response = await fetch(`${origin}/api/run`);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.equal(body.includes("GEMINI_API_KEY"), false);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.ok(response.headers.get("content-security-policy")?.includes("default-src 'self'"));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

after(() => {
  baseline = undefined as unknown as FaultlineRunArtifact;
});
