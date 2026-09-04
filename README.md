# FAULTLINE

**Concurrent AI incident command built with Mozaik.**

FAULTLINE turns a software incident into a shared investigation instead of a sequential chatbot workflow. Three specialist investigators begin at the same time, publish structured evidence into a shared runtime, and trigger downstream agents that form hypotheses, challenge weak causal claims, and propose advisory recovery actions.

The dashboard is designed to make that behavior inspectable: it shows real execution overlap, the event journal, hypothesis revisions, safety-gate decisions, and bounded provider retries from recorded run artifacts.

## Why concurrent agents?

A production incident rarely has one useful line of inquiry. Metrics, traces, and recent changes can be investigated independently, so FAULTLINE does that work in parallel.

The agent team is intentionally small:

- **Telemetry Investigator** — metrics and anomalous signals
- **Log Investigator** — errors, traces, and log evidence
- **Change Investigator** — deployments, configuration changes, and temporal correlation
- **Hypothesis Analyst** — forms and revises causal hypotheses as evidence changes
- **Skeptic** — challenges unsupported claims and missing proof
- **Recovery Planner** — proposes advisory recovery actions under a deterministic safety gate

The three investigators fan out concurrently. Their evidence is published through Mozaik events into shared incident state. The downstream reasoning agents react to that evolving state rather than waiting for a fixed hand-off pipeline.

## What the demo proves

FAULTLINE records a versioned run artifact for every incident. The judge-facing dashboard projects that artifact into a read-only command surface and makes the following visible:

- timestamp-derived investigator overlap and maximum concurrency
- ordered Mozaik event flow
- source-specific evidence from telemetry, logs, and changes
- hypothesis evolution as new evidence arrives
- skeptic challenges against the system's own reasoning
- recommendation readiness through a deterministic evidence gate
- logical inference tasks versus actual provider attempts
- sanitized transient-provider retry behavior
- complete and partial incident outcomes

No remediation is executed. FAULTLINE is advisory only.

## Architecture

```text
                         INCIDENT
                            |
              +-------------+-------------+
              |             |             |
              v             v             v
        Telemetry        Logs          Changes
        Investigator   Investigator   Investigator
              \             |             /
               \            |            /
                +---- structured evidence ----+
                              |
                              v
                     Hypothesis Analyst
                              |
                              v
                           Skeptic
                              |
                              v
                       Recovery Planner
                              |
                              v
                    Deterministic Safety Gate

      Mozaik semantic events + shared typed incident state
```

The implementation uses `@mozaik-ai/core@4.0.5` and TypeScript.

## Quick start

Install dependencies:

```bash
npm install
```

Run the deterministic end-to-end incident demo:

```bash
npm run demo
```

Start the local dashboard:

```bash
npm run dashboard
```

Then open:

```text
http://127.0.0.1:4173
```

The dashboard automatically loads the newest valid run artifact and falls back to deterministic demo data when needed.

## Live Gemini run

Live mode uses a local, ignored `.env` file. Copy the example and add your own key locally:

```bash
# .env
GEMINI_API_KEY=your_key_here
```

Then run:

```bash
npm run demo:live
```

You can also provide an arbitrary incident:

```bash
npm run incident -- --text "Checkout latency jumped after the latest deployment"
```

or in live mode:

```bash
npm run incident:live -- --text "Checkout latency jumped after the latest deployment"
```

Generated run artifacts are written under `runs/` and are intentionally gitignored.

## Useful commands

```bash
npm run typecheck    # TypeScript validation
npm test             # deterministic test suite
npm run demo         # deterministic complete run
npm run demo:live    # Gemini-backed run
npm run dashboard    # judge-facing local dashboard
```

## Reliability and safety

FAULTLINE separates logical agent work from provider attempts. Transient provider failures can use a single bounded retry budget while preserving safe metadata such as status and retryability. Raw provider payloads and API keys are not written into run artifacts.

Recovery recommendations pass through deterministic evidence checks before being marked `proposed`, `supported`, or `ready`. Even a `ready` recommendation remains advisory; the system does not execute rollback, failover, or other production actions.

## Repository layout

```text
src/
  core/        concurrent runtime, state, schemas, gates, retry boundary
  dashboard/   local artifact server and judge-facing command surface
  cli.ts       deterministic/live incident runner
  spike.ts     original concurrency spike

tests/         deterministic core, resilience, retry, timing, dashboard tests
scripts/       local runtime compatibility shim
```

## Hackathon

Built for the JigJoy Mozaik Hackathon as a demonstration of **genuine concurrent agents, shared awareness, and runtime adaptation**.

Development used AI-assisted engineering tools, including ChatGPT and Codex, as permitted by the hackathon rules.
