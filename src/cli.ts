import { readFile } from "node:fs/promises";
import { loadEnvFile } from "node:process";

import { writeRunArtifact } from "./core/artifact.js";
import { runFaultline, type FaultlineOptions } from "./core/engine.js";
import { DeterministicInferenceRunner } from "./core/inference.js";
import type { RunMode } from "./core/types.js";

interface CliOptions {
  mode: RunMode;
  text?: string;
  file?: string;
  model?: string;
}

function parseArguments(args: string[]): CliOptions {
  const result: CliOptions = { mode: "deterministic" };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (["--mode", "--text", "--file", "--model"].includes(flag) && !value) {
      throw new Error(`${flag} requires a value`);
    }
    if (flag === "--mode") {
      if (value !== "deterministic" && value !== "live") {
        throw new Error("--mode must be deterministic or live");
      }
      result.mode = value;
      index += 1;
    } else if (flag === "--text") {
      result.text = value;
      index += 1;
    } else if (flag === "--file") {
      result.file = value;
      index += 1;
    } else if (flag === "--model") {
      result.model = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  if (result.text && result.file) throw new Error("Use either --text or --file, not both");
  return result;
}

function printResult(path: string, result: Awaited<ReturnType<typeof runFaultline>>): void {
  const { artifact } = result;
  const initialHypothesis = artifact.hypotheses[0];
  const finalHypothesis = artifact.hypotheses.at(-1);
  const recommendation = artifact.remediations.at(-1);
  console.log(`FAULTLINE ${artifact.mode.toUpperCase()}: ${artifact.incident.status.toUpperCase()}`);
  console.log(
    `Evidence ${artifact.evidence.length} | Hypotheses ${artifact.hypotheses.length} | Challenges ${artifact.challenges.length} | Recommendations ${artifact.remediations.length}`,
  );
  console.log(
    `Concurrency: investigators=${artifact.timing.investigatorMaximumConcurrency}, overall=${artifact.timing.maximumConcurrency}, wall=${artifact.timing.totalRunWallTimeMs}ms`,
  );
  if (artifact.hypotheses.length >= 2 && initialHypothesis && finalHypothesis) {
    console.log(`Adaptation: ${initialHypothesis.statement} -> ${finalHypothesis.statement}`);
  }
  if (recommendation) {
    console.log(`Recommendation [${recommendation.gate.status}]: ${recommendation.action}`);
  }
  console.log(
    `Inference: logical tasks=${result.logicalInferenceTasks}, provider attempts=${result.providerAttempts}, retries=${result.retries}`,
  );
  console.log(`Run artifact: ${path}`);
}

async function main(): Promise<void> {
  const cli = parseArguments(process.argv.slice(2));
  const incidentText = cli.file ? (await readFile(cli.file, "utf8")).trim() : cli.text;

  if (cli.mode === "live") {
    try {
      loadEnvFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!process.env.GEMINI_API_KEY?.trim()) {
      throw new Error("GEMINI_API_KEY is missing; configure it only in the ignored .env file");
    }
  }

  const options: FaultlineOptions = {
    mode: cli.mode,
    ...(incidentText ? { incidentText } : {}),
    ...(cli.model
      ? { model: cli.model }
      : cli.mode === "live" && process.env.FAULTLINE_GEMINI_MODEL
        ? { model: process.env.FAULTLINE_GEMINI_MODEL }
        : {}),
    ...(cli.mode === "deterministic"
      ? { inferenceRunner: new DeterministicInferenceRunner() }
      : {}),
  };

  const result = await runFaultline(options);
  const outputPath = await writeRunArtifact(result.artifact);
  printResult(outputPath, result);
  if (result.artifact.incident.status === "failed") process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown FAULTLINE error";
  console.error(`FAULTLINE failed safely: ${message}`);
  process.exitCode = 1;
}
