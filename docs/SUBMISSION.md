# FAULTLINE — Final Submission Package

## Project name

FAULTLINE

## One-line pitch

Concurrent AI incident command that investigates outages in parallel, challenges its own reasoning, and gates recovery recommendations on structured evidence.

## Short description

FAULTLINE is a Mozaik-powered incident command system where telemetry, log, and change investigators run concurrently and publish structured evidence into shared state. A Hypothesis Analyst reasons from evidence as it arrives, a Skeptic challenges weak causal claims, and a Recovery Planner updates advisory actions under a deterministic safety gate. The dashboard exposes real execution overlap, event-driven coordination, hypothesis revisions, and bounded provider retry behavior from recorded run artifacts.

## Why it fits the brief

- Uses `@mozaik-ai/core`
- Runs multiple agents concurrently rather than as a fixed sequential chain
- Shares structured incident state through Mozaik events
- Lets downstream agents react to new evidence as it arrives
- Shows genuine investigator overlap from recorded timestamps
- Demonstrates runtime adaptation through hypothesis and recovery revision

## How the agents run concurrently

Three independent investigators are dispatched together:

1. Telemetry Investigator
2. Log Investigator
3. Change Investigator

Their inference windows overlap in wall-clock time. Each publishes structured evidence through Mozaik semantic events into shared incident state. Downstream agents react to that evolving state, so reasoning can begin before the entire investigator wave is complete and can be revised when later evidence arrives.

The dashboard derives its concurrency geometry from recorded execution timestamps, making the overlap directly inspectable rather than presenting decorative animation.

## Judge-facing proof points

- maximum investigator concurrency: 3
- three source-specific evidence lanes
- hypothesis revision as evidence expands
- skeptic challenge against weak causal reasoning
- deterministic recovery gate: `proposed -> supported -> ready`
- advisory-only recovery; no remediation is executed
- logical inference tasks separated from provider attempts
- live Gemini-backed run recovered from a real HTTP 429 with one bounded retry
- ordered Mozaik event journal and replay

## Repository

https://github.com/adhamcodes/faultline

## Demo video

https://youtu.be/LlfdnT195eM

Final captioned demo length: approximately **1:19**.

The video starts with the deterministic judge-facing run for clear source separation and visible hypothesis adaptation, then switches to the completed Gemini-backed run to demonstrate real provider-backed execution and retry recovery.

## Final form copy

### Project name

FAULTLINE

### One-line pitch

Concurrent AI incident command that investigates outages in parallel, challenges its own reasoning, and gates recovery recommendations on structured evidence.

### Short description

FAULTLINE is a concurrent AI incident command system built with Mozaik. Three specialist investigators analyze telemetry, logs, and recent changes in parallel and publish structured evidence into shared state. A Hypothesis Analyst reasons from evidence as it arrives, a Skeptic challenges weak causal claims, and a Recovery Planner proposes advisory actions behind a deterministic evidence gate. The dashboard makes the concurrency, event flow, hypothesis changes, safety decisions, and bounded provider retries directly inspectable.

### How the agents run concurrently

Telemetry, Log, and Change Investigators are dispatched together and execute overlapping inference windows. Each publishes structured evidence through Mozaik semantic events into shared incident state. Downstream agents subscribe to that evolving state, allowing reasoning to begin before the full investigation wave finishes and to be revised when later evidence arrives. The dashboard derives its concurrency view from recorded start and finish timestamps so the overlap can be verified directly.

### Demo video

https://youtu.be/LlfdnT195eM

### Repository

https://github.com/adhamcodes/faultline

## Final checklist

- [x] README contains architecture, quick start, safety, and concurrency explanation
- [x] final demo video uploaded as unlisted
- [x] demo URL added to README and submission package
- [x] `npm run typecheck` passes
- [x] `npm test` passes — 21/21
- [x] `npm run demo` produces a COMPLETE deterministic artifact
- [x] dashboard loads the newest deterministic artifact
- [x] live Gemini-backed COMPLETE run is available in the dashboard run picker
- [x] `.env` is ignored
- [x] `runs/` is ignored
- [x] no API key is committed
- [x] raw provider payloads are not persisted
- [ ] repository made accessible to judges at submission time
- [ ] final submission form reviewed before pressing Submit

## Disclosure

Development used AI-assisted engineering tools, including ChatGPT and Codex. The hackathon rules permit and encourage AI-assisted development.
