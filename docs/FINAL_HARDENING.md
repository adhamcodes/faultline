# FAULTLINE — Final Hardening Checklist

Use this checklist immediately before recording and submission. The goal is to protect the working build, not add features.

## Code freeze rule

After the final clean validation, do not make feature changes unless they fix a demonstrated blocker. Prefer documentation or demo adjustments over architecture changes.

## Clean validation

From a fresh working tree:

```bash
npm install
npm run typecheck
npm test
npm run demo
npm run dashboard
```

Expected:

- typecheck passes
- all deterministic tests pass
- deterministic incident completes
- dashboard starts locally
- dashboard shows concurrency, evidence, hypothesis evolution, skeptic, gate, retry panel, and replay

## Security

Verify:

```bash
git status --short
git ls-files .env
git check-ignore -v .env
git check-ignore -v runs/
```

Expected:

- clean working tree
- `.env` is not tracked
- `.env` is ignored
- `runs/` is ignored

Do not commit live run artifacts, credentials, raw provider payloads, or local environment files.

## Judge-path smoke test

A judge should be able to understand the project in this order:

1. README opening paragraph
2. concurrency explanation
3. `npm install`
4. `npm run demo`
5. `npm run dashboard`
6. open `http://127.0.0.1:4173`

The first dashboard viewport should communicate:

- COMPLETE/PARTIAL status
- max concurrency
- current hypothesis
- skeptic challenge
- advisory recommendation
- safety gate

## Demo recording checks

- browser at a readable zoom level
- no bookmarks/accounts/private tabs visible if avoidable
- no API keys or `.env` visible
- deterministic run selected for the clearest story
- live COMPLETE run used only as proof of real provider-backed execution/retry
- Replay works before recording
- cursor movements are deliberate
- narration stays under roughly 2.5 minutes

## Submission checks

- repo accessible to judges
- project name: FAULTLINE
- short description pasted from `docs/SUBMISSION.md`
- concurrency explanation pasted from `docs/SUBMISSION.md`
- demo video URL added if available
- final repository URL correct
- no last-minute feature work after submission unless platform permits edits and a real blocker exists
