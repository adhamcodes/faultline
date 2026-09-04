# FAULTLINE Technical Spike Report

## What was tested

- Installed and typechecked `@mozaik-ai/core` version 4.0.5 with TypeScript.
- Ran one live incident dispatch through the Mozaik runtime to three independent Mozaik agent participants using `gemini-3.5-flash` and `GEMINI_API_KEY`.
- Measured each participant from Mozaik's `inference.started` event through its `model.answer` event.
- Exercised cross-participant reaction through Mozaik semantic events.
- Exercised an intentionally failing participant handler with a caught failure published as `investigator.failed`.
- Ran deterministic tests using an injected local `InferenceRunner`; no live Gemini call is required by the test suite.

## Verified results

- `npm run typecheck`: PASS.
- `npm test`: PASS — 3 tests passed, 0 failed.
- `npm run spike`: PASS — 3 live Gemini-backed investigators completed.
- Installed-package audit: PASS — the implementation uses the runtime, participant, handler, event, and inference types exported by the installed package.

## Live concurrency timings

All timestamps below are UTC from the live run.

| Participant | Started | Finished | Duration |
| --- | --- | --- | ---: |
| telemetry investigator | 2026-09-04T19:25:47.143Z | 2026-09-04T19:25:51.074Z | 3,931 ms |
| log investigator | 2026-09-04T19:25:47.145Z | 2026-09-04T19:25:52.234Z | 5,089 ms |
| deployment/change investigator | 2026-09-04T19:25:47.145Z | 2026-09-04T19:25:51.273Z | 4,128 ms |

- Maximum measured concurrency: 3.
- All three intervals shared a common overlap window.
- Pairwise overlap: telemetry/logs 3,929 ms; telemetry/deployment 3,929 ms; logs/deployment 4,128 ms.
- Total live wall-clock time: 5,093 ms.
- Naive sum of investigator durations: 13,148 ms.
- Difference between summed durations and concurrent wall time: 8,055 ms.

## Event propagation evidence

At `2026-09-04T19:25:51.074Z`, the deployment/change investigator reacted to the telemetry investigator's Mozaik `model.answer` event and emitted `investigator.observed_peer`. The evidence observer received that custom event with the deployment participant as producer and the telemetry participant as the observed producer.

## Failure-isolation evidence

At `2026-09-04T19:25:47.180Z`, the deliberately failing investigator caught its intentional handler failure and emitted `investigator.failed`. The failure was observed while all three Gemini-backed participants remained active; they subsequently completed at the timestamps listed above. The process exited successfully.

## Security and uncertainty

- `.env` was confirmed ignored with `git check-ignore` before dependency installation and again after implementation.
- `.env` was not modified.
- `.env.example` contains only a placeholder.
- An exact-value scan found no configured Gemini API key in repository files, and a Google API-key-pattern scan found no match outside `.env`.
- Mozaik cloud telemetry reported itself disabled because no `MOZAIK_API_KEY` was configured; this did not affect the local Mozaik runtime/event tests.
- Blockers: none.
