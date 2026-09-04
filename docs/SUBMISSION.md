# FAULTLINE — Submission Draft

This file is the working submission package for the JigJoy Mozaik Hackathon. Keep it private until final submission review.

## Short description

FAULTLINE is a concurrent AI incident command system built with Mozaik. Three specialist investigators analyze telemetry, logs, and recent changes in parallel, publish structured evidence into shared runtime state, and trigger downstream agents that form and revise hypotheses, challenge weak causal claims, and propose advisory recovery actions under a deterministic evidence gate.

The dashboard makes the concurrency and coordination inspectable through timestamp-derived overlap, ordered semantic events, hypothesis evolution, skeptic challenges, safety-gate status, and bounded provider retry behavior.

## Why it fits the brief

- Uses `@mozaik-ai/core`
- Runs multiple agents concurrently rather than as a fixed sequential chain
- Shares structured incident state through Mozaik events
- Lets downstream agents react to new evidence as it arrives
- Shows genuine investigator overlap from recorded timestamps
- Demonstrates runtime adaptation through hypothesis and recovery revision

## Concurrency explanation

The incident commander dispatches three independent investigators at nearly the same time:

1. Telemetry Investigator
2. Log Investigator
3. Change Investigator

Their inference windows overlap in wall-clock time. Each publishes structured evidence into shared incident state through semantic events. The Hypothesis Analyst can begin from the first available evidence and later revise its conclusion when the other investigators publish additional evidence. The Skeptic challenges unsupported causal claims, and the Recovery Planner updates its advisory recommendation from the evolving shared state.

This is intentionally not implemented as:

`investigator A -> investigator B -> investigator C -> hypothesis -> recovery`

The dashboard visualizes the actual execution geometry and event order from the run artifact so judges can verify the concurrency directly.

## Demo story

### Opening

"FAULTLINE is a concurrent AI incident command system. Instead of one AI inspecting an outage step by step, three investigators attack independent evidence sources at the same time and coordinate through Mozaik."

### 1. First screen — 10 seconds

Show the dashboard top section.

Point out:

- incident status: COMPLETE
- maximum concurrency: 3
- investigator wave: 3
- six total agents
- current hypothesis
- skeptic challenge
- recovery gate: READY
- advisory-only recommendation

Say:

"The important number here is three-way concurrency. Telemetry, logs, and changes are analyzed independently and simultaneously."

### 2. Concurrency proof — 20 seconds

Scroll to the execution geometry.

Say:

"These bars are derived from recorded start and finish timestamps, not decorative animation. The three investigator windows overlap in real wall-clock time."

Show the three overlapping investigator bars.

### 3. Source-specific evidence — 20 seconds

Show the evidence cards.

Explain that the agents are not repeating the same result:

- telemetry shows latency, cache-hit collapse, and database CPU saturation
- logs/traces show cache misses, pool waits, and timeouts
- change analysis isolates the checkout cache-key normalization deployment

### 4. Adaptation — 25 seconds

Show Hypothesis V1 -> V2.

Say:

"FAULTLINE can start reasoning before every investigator has finished. The early hypothesis is deliberately cautious. When the later evidence arrives, the causal statement changes and confidence increases."

Emphasize that this is runtime adaptation from shared evidence, not a hard-coded handoff.

### 5. Skeptic + safety gate — 20 seconds

Show the Skeptic and Recovery Safety Gate.

Say:

"FAULTLINE does not automatically trust its own agents. The Skeptic challenges causal claims, and high-impact recovery actions pass through deterministic evidence checks before they can become READY. READY still means advisory only — FAULTLINE never executes rollback itself."

### 6. Resilience — 15 seconds

Show provider attempts / retry panel.

Say:

"In the live Gemini-backed run, the hypothesis revision hit a real HTTP 429. FAULTLINE kept the logical task intact, waited within a bounded retry policy, retried once, and completed the incident."

### 7. Replay — 15 seconds

Press Replay.

Say:

"The replay is the recorded Mozaik event journal. It reconstructs how evidence, hypotheses, challenges, recommendations, retries, and completion happened in order."

### Closing

"FAULTLINE turns incident response into a concurrent, inspectable AI team: parallel investigation, shared awareness, adaptive reasoning, skepticism, and guarded recovery."

## Recommended demo length

Target: **2:00–2:30**.

Do not spend time narrating implementation details line by line. The demo should prove four things quickly:

1. concurrency is real
2. agents share and react to state
3. reasoning changes when evidence changes
4. the system remains safe and inspectable

## Submission checklist

Before submitting:

- [ ] repository is accessible to judges
- [ ] `README.md` renders correctly
- [ ] `npm install` works from a clean clone
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] `npm run demo` produces a COMPLETE deterministic artifact
- [ ] `npm run dashboard` starts successfully
- [ ] dashboard automatically loads a valid artifact/fallback
- [ ] no `.env` or API key is tracked
- [ ] `runs/` remains ignored
- [ ] no raw provider payload is committed
- [ ] concurrency explanation is present in submission text
- [ ] short description is pasted into the submission form
- [ ] demo video link added if recorded
- [ ] repository visibility changed only when ready for judges

## Final submission fields

### Project name

FAULTLINE

### One-line pitch

Concurrent AI incident command that investigates outages in parallel, challenges its own reasoning, and gates recovery recommendations on structured evidence.

### Short description

FAULTLINE is a Mozaik-powered incident command system where telemetry, log, and change investigators run concurrently and publish structured evidence into shared state. A Hypothesis Analyst reasons from evidence as it arrives, a Skeptic challenges weak causal claims, and a Recovery Planner updates advisory actions under a deterministic safety gate. The dashboard exposes real execution overlap, event-driven coordination, hypothesis revisions, and bounded provider retry behavior from recorded run artifacts.

### How the agents run concurrently

Three independent investigators are dispatched together and execute overlapping inference windows. Their structured evidence is published through Mozaik semantic events into shared incident state. Downstream agents subscribe to that evolving state, so reasoning can begin before the full investigation wave is complete and can be revised when later evidence arrives. The dashboard derives its concurrency view from recorded start/finish timestamps, making the overlap directly inspectable.

### Repository

`https://github.com/adhamcodes/faultline`

### Demo video

Add final video URL here before submission.

## Disclosure

Development used AI-assisted engineering tools, including ChatGPT and Codex. The hackathon rules permit and encourage AI-assisted development.
