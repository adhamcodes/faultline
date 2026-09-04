import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { FaultlineRunArtifact } from "./types.js";

export function assertRunArtifact(value: unknown): asserts value is FaultlineRunArtifact {
  if (!value || typeof value !== "object") throw new Error("Run artifact must be an object");
  const artifact = value as Partial<FaultlineRunArtifact>;
  if (artifact.schemaVersion !== "1.0") throw new Error("Unsupported artifact schema");
  if (!artifact.incident || !Array.isArray(artifact.participants)) {
    throw new Error("Artifact is missing incident or participants");
  }
  for (const field of [
    "evidence",
    "hypotheses",
    "challenges",
    "remediations",
    "timeline",
  ] as const) {
    if (!Array.isArray(artifact[field])) throw new Error(`Artifact field ${field} must be an array`);
  }
  if (!artifact.timing || !artifact.finalSummary || !artifact.resilience || !artifact.inference) {
    throw new Error("Artifact is missing completion summaries");
  }
  if (
    !Array.isArray(artifact.inference.attempts) ||
    artifact.inference.providerAttempts !== artifact.inference.attempts.length
  ) {
    throw new Error("Artifact inference accounting is inconsistent");
  }
}

export function serializeRunArtifact(artifact: FaultlineRunArtifact): string {
  const serialized = JSON.stringify(artifact, null, 2);
  assertRunArtifact(JSON.parse(serialized) as unknown);
  return `${serialized}\n`;
}

export async function writeRunArtifact(
  artifact: FaultlineRunArtifact,
  outputDirectory = "runs",
): Promise<string> {
  await mkdir(outputDirectory, { recursive: true });
  const timestamp = artifact.incident.startedAt.replace(/[:.]/g, "-");
  const outputPath = path.resolve(outputDirectory, `${timestamp}-${artifact.runId}.json`);
  await writeFile(outputPath, serializeRunArtifact(artifact), "utf8");
  return outputPath;
}
