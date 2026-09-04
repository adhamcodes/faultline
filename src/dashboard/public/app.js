const app = document.querySelector("#app");
const runSelect = document.querySelector("#run-select");
let currentPayload;
let replayTimers = [];

const esc = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

const percent = (value) => `${Math.round((Number(value) || 0) * 100)}%`;
const signedPercent = (value) => `${value >= 0 ? "+" : ""}${Math.round(value * 100)} pts`;
const milliseconds = (value) => value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}s` : `${value}ms`;
const stamp = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
};
const titleCase = (value) => String(value ?? "").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());

function chip(text, style = "") {
  return `<span class="chip ${style}">${esc(text)}</span>`;
}

function agentCards(participants, keys) {
  return keys.map((key) => {
    const participant = participants.find((item) => item.key === key);
    if (!participant) return "";
    return `<article class="agent-card">
      <div class="agent-card-top">
        <span class="agent-name">${esc(participant.name)}</span>
        <span class="agent-status ${participant.status === "failed" ? "failed" : ""}" title="${esc(participant.status)}"></span>
      </div>
      <div class="agent-focus">${esc(participant.focus)}</div>
      <div class="agent-foot"><span>${esc(participant.status)}</span><span>${participant.durationMs ?? 0}ms</span></div>
    </article>`;
  }).join("");
}

function timeline(view) {
  const rows = view.timeline.executions.map((execution) => `<div class="timeline-lane">
    <span class="lane-label" title="${esc(execution.stage)}">${esc(titleCase(execution.stage.replace("investigate:", "")))}</span>
    <div class="lane-track">
      <span class="execution ${execution.stage.startsWith("investigate:") ? "investigator" : ""} ${execution.failed ? "failed" : ""}"
        style="left:${execution.leftPercent}%;width:${execution.widthPercent}%"
        title="${esc(execution.stage)} · ${execution.durationMs ?? 0}ms${execution.retryAttempt ? ` · retry ${execution.retryAttempt}` : ""}"></span>
    </div>
  </div>`).join("");
  const breaks = view.timeline.breaks.map((item) => `<span class="timeline-break" style="left:calc(152px + (100% - 152px) * ${item.leftPercent / 100})"><span>${esc(item.label)}${item.status ? ` · HTTP ${item.status}` : ""}</span></span>`).join("");
  const ticks = view.timeline.ticks.map((tick) => `<span class="timeline-tick" style="left:${tick.leftPercent}%">${esc(tick.label)}</span>`).join("");
  return `<div class="timeline-wrap"><div class="timeline">${breaks}<div class="timeline-axis">${ticks}</div>${rows}</div></div>`;
}

function evidenceCards(artifact, view) {
  const hypothesisIds = new Set(view.current.hypothesis?.supportingEvidenceIds ?? []);
  const recommendationIds = new Set(view.current.recommendation?.supportingEvidenceIds ?? []);
  return artifact.evidence.map((item) => `<article class="evidence-card">
    <div class="evidence-top"><span class="evidence-source">${esc(titleCase(item.source.replace("-investigator", "")))}</span><span class="confidence">${percent(item.confidence)}</span></div>
    <p>${esc(item.observation)}</p>
    <div class="evidence-links">
      ${chip(item.id)}
      ${hypothesisIds.has(item.id) ? chip("supports hypothesis", "cyan") : ""}
      ${recommendationIds.has(item.id) ? chip("supports recovery", "green") : ""}
    </div>
  </article>`).join("");
}

function evolution(view) {
  const change = view.hypothesisEvolution;
  if (!change) return `<div class="evolution"><article class="evolution-card"><span class="micro-label">Hypothesis v1</span><h3>${esc(view.current.hypothesis?.statement ?? "No hypothesis was produced")}</h3></article></div>`;
  const fieldNote = change.statementChanged
    ? "The causal statement changed when the expanded evidence arrived."
    : "Statement held; confidence and evidence support changed after the expanded evidence arrived.";
  return `<div class="evolution">
    <article class="evolution-card">
      <span class="micro-label">Before · hypothesis v${change.before.version}</span>
      <h3>${esc(change.before.statement)}</h3>
      <div class="diff-row"><span>Confidence</span><strong>${percent(change.before.confidence)}</strong></div>
      <div class="diff-row"><span>Evidence basis</span><strong>${change.before.supportingEvidenceIds.length}</strong></div>
    </article>
    <div class="evolution-arrow" aria-hidden="true">→</div>
    <article class="evolution-card after">
      <span class="micro-label">After · hypothesis v${change.after.version}</span>
      <h3>${esc(change.after.statement)}</h3>
      <div class="diff-row"><span>Confidence</span><strong>${percent(change.after.confidence)} · ${signedPercent(change.confidenceDelta)}</strong></div>
      <div class="diff-row"><span>New evidence</span><strong>${esc(change.addedEvidenceIds.join(", ") || "none")}</strong></div>
      <div class="diff-row"><span>Challenges addressed</span><strong>${esc(change.newlyAddressedChallengeIds.join(", ") || "none")}</strong></div>
    </article>
  </div><p class="diff-note">${esc(fieldNote)}</p>`;
}

function attemptChains(view) {
  const retried = view.retryChains.filter((chain) => chain.attempts.length > 1);
  if (retried.length === 0) return `<p class="no-retry">No provider retry was used in this run. ${view.metrics.logicalTasks} logical tasks map to ${view.metrics.providerAttempts} provider attempts.</p>`;
  return retried.map((chain) => `<div>
    <div class="micro-label">${esc(chain.stage)} · one logical task</div>
    <div class="attempt-chain">
      ${chain.attempts.map((attempt, index) => `${index > 0 ? `<span class="attempt-link">${milliseconds(chain.retryDelayMs ?? 0)}<br>bounded retry →</span>` : ""}<span class="attempt-node ${attempt.outcome}"><strong>ATTEMPT ${attempt.attempt}</strong><span>${attempt.outcome === "failed" ? `HTTP ${esc(attempt.status ?? "unknown")} · retryable ${esc(attempt.retryable)}` : `SUCCESS · ${attempt.durationMs}ms`}</span></span>`).join("")}
    </div>
  </div>`).join("");
}

function journalRows(entries) {
  return entries.map((entry) => `<div class="journal-event" data-journal-sequence="${entry.sequence}">
    <span class="event-seq">#${String(entry.sequence).padStart(2, "0")}</span>
    <span class="event-type" title="${esc(entry.eventType)}">${esc(entry.eventType.replace("faultline.", ""))}</span>
    <span class="event-summary">${esc(entry.summary)}<small>${esc(stamp(entry.timestamp))} · ${esc(entry.participant)}${entry.objectIds.length ? ` · ${esc(entry.objectIds.join(", "))}` : ""}</small></span>
  </div>`).join("");
}

function render(payload) {
  currentPayload = payload;
  const { artifact, view } = payload;
  const hypothesis = view.current.hypothesis;
  const recommendation = view.current.recommendation;
  const gate = recommendation?.gate;
  const challenge = artifact.challenges.at(-1);
  const investigatorKeys = ["telemetry-investigator", "log-investigator", "change-investigator"];
  const downstreamKeys = ["hypothesis-analyst", "skeptic", "recovery-planner"];
  const statusStyle = view.run.status === "complete" ? "" : view.run.status;
  const retryLabel = view.metrics.retries ? `${view.metrics.retries} used` : "unused";
  const gateIndex = { proposed: 0, supported: 1, ready: 2 }[gate?.status] ?? -1;

  app.innerHTML = `
    <section class="hero">
      <div>
        <div class="eyebrow">FAULTLINE · Active incident analysis</div>
        <h1>Concurrent AI<br>Incident Command</h1>
        <p class="incident-summary"><span>Incident</span>${esc(artifact.incident.text)}</p>
        <p class="hero-subtitle">Six specialized agents · artifact-backed reasoning · advisory recovery</p>
        <div class="incident-id">INCIDENT ${esc(artifact.incident.id)} · ${esc(view.run.mode.toUpperCase())} · ${esc(stamp(view.run.startedAt))}</div>
      </div>
      <aside class="status-card">
        <div class="status-line"><span class="micro-label">Incident status</span><span class="status-value ${statusStyle}">${esc(view.run.status.toUpperCase())}</span></div>
        <div class="status-meta">${esc(artifact.finalSummary?.note ?? "Run state projected from the selected artifact.")}<br>${esc(milliseconds(view.run.wallTimeMs))} wall time · ${esc(view.run.model)}</div>
        ${recommendation ? `<div class="status-action"><span>Current advisory action · gate ${esc(recommendation.gate.status)}</span>${esc(recommendation.action)}</div>` : ""}
      </aside>
    </section>

    <section class="metric-strip" aria-label="Run summary">
      <div class="metric"><span class="metric-label">Max concurrency</span><span class="metric-value accent">${view.metrics.maximumConcurrency}</span></div>
      <div class="metric"><span class="metric-label">Investigator wave</span><span class="metric-value">${view.metrics.investigatorConcurrency}</span></div>
      <div class="metric"><span class="metric-label">Evidence</span><span class="metric-value">${view.metrics.evidenceCount}</span></div>
      <div class="metric"><span class="metric-label">Agents</span><span class="metric-value">${view.metrics.participantCount}</span></div>
      <div class="metric"><span class="metric-label">Logical / attempts</span><span class="metric-value">${view.metrics.logicalTasks}/${view.metrics.providerAttempts}</span></div>
      <div class="metric"><span class="metric-label">Retry budget</span><span class="metric-value ${view.metrics.retries ? "accent" : ""}">${esc(retryLabel)}</span></div>
    </section>

    <div class="command-grid">
      <div class="stack">
        <section class="panel">
          <header class="panel-head"><div><div class="section-kicker">Current assessment</div><h2>Leading hypothesis & recovery posture</h2></div>${chip(`gate ${gate?.status ?? "none"}`, gate?.status === "ready" ? "green" : "amber")}</header>
          <div class="hypothesis-now">
            <blockquote>${esc(hypothesis?.statement ?? "No hypothesis was produced.")}</blockquote>
            <div class="hypothesis-meta">${hypothesis ? chip(`v${hypothesis.version}`) : ""}${hypothesis ? chip(`${percent(hypothesis.confidence)} confidence`, "cyan") : ""}${hypothesis ? chip(`${hypothesis.supportingEvidenceIds.length} supporting evidence`) : ""}</div>
            ${recommendation ? `<div class="recovery-card"><span class="micro-label">Current advisory recommendation · v${recommendation.version}</span><p>${esc(recommendation.action)}</p></div>` : ""}
          </div>
        </section>

        <section class="panel">
          <header class="panel-head"><div><div class="section-kicker">Orchestration</div><h2>Six-agent operating model</h2></div>${chip("3-way fan-out", "cyan")}</header>
          <div class="agents">
            <div class="agent-group-title"><span>Parallel investigator wave</span><span>independent source lanes</span></div>
            <div class="agent-group">${agentCards(artifact.participants, investigatorKeys)}</div>
            <div class="agent-group-title"><span>Adaptive reasoning chain</span><span>hypothesize → challenge → recover</span></div>
            <div class="agent-group">${agentCards(artifact.participants, downstreamKeys)}</div>
          </div>
        </section>

        <section class="panel">
          <header class="panel-head"><div><div class="section-kicker">Timing proof</div><h2>Concurrent execution geometry</h2><p>Derived from recorded start and finish timestamps; retry waits are visually compressed.</p></div>${chip(`${milliseconds(view.timeline.actualDurationMs)} actual`)}</header>
          ${timeline(view)}
        </section>

        <section class="panel">
          <header class="panel-head"><div><div class="section-kicker">Evidence ledger</div><h2>Source-specific observations</h2></div>${chip(`${artifact.evidence.length} immutable records`)}</header>
          <div class="evidence-grid">${evidenceCards(artifact, view)}</div>
        </section>

        <section class="panel">
          <header class="panel-head"><div><div class="section-kicker">Adaptive reasoning</div><h2>Hypothesis evolution</h2><p>Initial inference → expanded evidence and skeptic pressure → revision</p></div>${chip(`${Math.max(0, artifact.hypotheses.length - 1)} revision`, "cyan")}</header>
          ${evolution(view)}
        </section>
      </div>

      <aside class="stack">
        <section class="panel">
          <header class="panel-head"><div><div class="section-kicker">Critical review</div><h2>Skeptic challenge</h2></div>${challenge ? chip(challenge.severity, challenge.severity === "high" ? "red" : "amber") : chip("none")}</header>
          <div class="challenge">
            <blockquote>${esc(challenge?.claim ?? "No skeptic challenge was produced.")}</blockquote>
            ${challenge ? `<p><span class="micro-label">Missing proof</span><br>${esc(challenge.missingEvidence)}</p>` : ""}
          </div>
        </section>

        <section class="panel">
          <header class="panel-head"><div><div class="section-kicker">Deterministic policy</div><h2>Recovery safety gate</h2></div>${chip(gate?.status ?? "none", gate?.status === "ready" ? "green" : "amber")}</header>
          <div class="gate">
            <div class="gate-status"><span>Current gate</span><strong>${esc(gate?.status ?? "N/A")}</strong></div>
            <div class="gate-ruler">${["proposed", "supported", "ready"].map((step, index) => `<span class="gate-step ${index <= gateIndex ? "active" : ""}">${step}</span>`).join("")}</div>
            <div class="gate-facts"><div class="gate-fact"><strong>${gate?.independentSupportCount ?? 0}</strong>independent sources</div><div class="gate-fact"><strong>${gate?.highConfidenceSupportCount ?? 0}</strong>high-confidence signals</div></div>
            <p class="gate-rationale">${esc(gate?.rationale ?? "No recovery recommendation reached the gate.")}</p>
            <div class="advisory">ADVISORY ONLY · NO ACTION EXECUTED</div>
          </div>
        </section>

        <section class="panel">
          <header class="panel-head"><div><div class="section-kicker">Resilience</div><h2>Provider attempts</h2></div>${chip(`${view.metrics.providerAttempts} attempts`, view.metrics.retries ? "amber" : "")}</header>
          <div class="attempts">${attemptChains(view)}</div>
        </section>

        <section class="panel">
          <header class="panel-head">
            <div><div class="section-kicker">Forensic journal</div><h2>Ordered event replay</h2><p>${view.replay.length} semantic events · 18 second playback</p></div>
            <div class="journal-controls"><button class="button primary" id="replay" type="button">Replay</button><button class="button" id="show-all" type="button">Show all</button></div>
          </header>
          <div class="journal-progress"><span id="journal-progress"></span></div>
          <div class="journal" id="journal">${journalRows(view.replay)}</div>
        </section>
      </aside>
    </div>`;

  document.querySelector("#replay")?.addEventListener("click", startReplay);
  document.querySelector("#show-all")?.addEventListener("click", showAllJournal);
}

function clearReplay() {
  replayTimers.forEach(clearTimeout);
  replayTimers = [];
}

function showAllJournal() {
  clearReplay();
  document.querySelectorAll("[data-journal-sequence]").forEach((node) => { node.hidden = false; });
  const progress = document.querySelector("#journal-progress");
  if (progress) progress.style.width = "100%";
}

function startReplay() {
  if (!currentPayload) return;
  clearReplay();
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const events = currentPayload.view.replay;
  const maximum = Math.max(1, ...events.map((entry) => entry.relativeMs));
  document.querySelectorAll("[data-journal-sequence]").forEach((node) => { node.hidden = true; });
  const progress = document.querySelector("#journal-progress");
  if (progress) progress.style.width = "0%";
  events.forEach((entry, index) => {
    const delay = reduceMotion ? index * 15 : entry.relativeMs;
    replayTimers.push(setTimeout(() => {
      const node = document.querySelector(`[data-journal-sequence="${entry.sequence}"]`);
      if (node) {
        node.hidden = false;
        node.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
      }
      if (progress) progress.style.width = `${((index + 1) / events.length) * 100}%`;
    }, delay));
  });
  const button = document.querySelector("#replay");
  if (button) {
    button.textContent = "Replaying";
    replayTimers.push(setTimeout(() => { button.textContent = "Replay"; }, reduceMotion ? events.length * 15 : maximum));
  }
}

async function loadRun(id) {
  clearReplay();
  app.innerHTML = `<section class="loading-state"><div class="loading-pulse"></div><p>Projecting incident artifact…</p></section>`;
  const response = await fetch(`/api/run?id=${encodeURIComponent(id)}`);
  if (!response.ok) throw new Error("The selected run could not be loaded.");
  render(await response.json());
}

async function initialize() {
  try {
    const response = await fetch("/api/runs");
    if (!response.ok) throw new Error("Run catalog is unavailable.");
    const catalog = await response.json();
    if (!catalog.runs?.length) throw new Error("No valid run artifact or fallback is available.");
    runSelect.innerHTML = catalog.runs.map((run, index) => `<option value="${esc(run.id)}">${index === 0 ? "LATEST · " : ""}${esc(run.mode.toUpperCase())} · ${esc(run.status.toUpperCase())} · ${esc(stamp(run.startedAt))}${run.retries ? ` · ${run.retries} RETRY` : ""}</option>`).join("");
    runSelect.addEventListener("change", () => loadRun(runSelect.value).catch(showError));
    await loadRun(catalog.newest ?? catalog.runs[0].id);
  } catch (error) {
    showError(error);
  }
}

function showError(error) {
  const message = error instanceof Error ? error.message : "The dashboard failed safely.";
  app.innerHTML = `<section class="error-state"><div><div class="eyebrow">Safe failure</div><h1>Artifact unavailable</h1><p>${esc(message)}</p></div></section>`;
}

initialize();
