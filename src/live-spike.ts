import { loadEnvFile } from "node:process";

import { runSpike } from "./spike.js";

try {
  loadEnvFile();
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== "ENOENT") throw error;
}

if (!process.env.GEMINI_API_KEY?.trim()) {
  console.error(
    JSON.stringify({
      passed: false,
      error: "GEMINI_API_KEY is missing; add it to the ignored .env file.",
    }),
  );
  process.exitCode = 1;
} else {
  const model = process.env.FAULTLINE_GEMINI_MODEL ?? "gemini-3.5-flash";
  try {
    const result = await runSpike({ model });
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
  } catch (error) {
    console.error(
      JSON.stringify({
        passed: false,
        error:
          error instanceof Error ? error.message : "Unknown live spike error",
      }),
    );
    process.exitCode = 1;
  }
}
