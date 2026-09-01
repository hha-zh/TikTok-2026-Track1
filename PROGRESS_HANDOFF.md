# Progress Handoff — backend frozen at Stage 7D.5

**For:** Yijie, Chinyip
**Branch:** `feature/travel-lifecycle`
**State:** backend complete and green. **One decision blocks Stage 7E.**

---

## Where we are

Stages 7A–7D were built, then independently audited, then hardened. The backend
and evidence contract are done. Stage 7E (the read-only Run Inspector UI) has
**not** been started and is the last planned major coding phase.

| | Status |
| --- | --- |
| Full suite | **416/416 across 35 files** (was 376/33 at the start of the audit) |
| `npm run check` | PASS — typecheck, tests, server + web builds |
| Frozen governance core | intact; `authorize()` still the only ALLOW/DENY primitive |
| Attempt #4 live proof | valid, now **qualified** — see below |
| External provider runs this cycle | **0** |
| `apps/web` | untouched |
| Blocking item | **finding H** — needs a human decision, not code |

---

## Read in this order

1. **`docs/STAGE_7D5_BACKEND_SIGNOFF.md`** — the current authoritative state.
   §6–§7 hold the decision you need to make.
2. **`HARDENING_FINDINGS_FOR_YIJIE.md`** — Yijie, start here instead; it is the
   same findings framed against the code you wrote, and it leads with the two
   items that were filed against your work and **cleared**.
3. **`docs/PRE_STAGE7E_HARDENING.md`** — the Stage 7D.4 pass in full.
4. **`AUDIT_7A-7D_FINDINGS.md`** — the original audit. **Historical.** Roughly
   two thirds of it was unverified first-pass leads; where it disagrees with the
   two documents above, they win.
5. `docs/TEAMMATE_HANDOFF_REVIEW.md` — Yijie's original review. Still useful, but
   it now carries a marked **Stage 7D.5 correction** block at §10.

---

## What these commits contain

**Stage 7D.4 — evidence integrity.** Three live-proof oracle keys reused the
frozen oracle's names while only checking that some event existed
(`evidenceCorrelated` was strictly vacuous — `run_outcome` is written for FAILED
runs too). Three canary checks could never fail, one was a byte-identical
duplicate. `GovernedRunView` served the workload's verdict on itself in the same
unlabelled shape as ledger facts, and fabricated a task graph on the production
path. All repaired; every field is now OBSERVED / DERIVED / DECLARED /
UNAVAILABLE.

**`scripts/stage7d-travel-proof.mjs` now refuses to overwrite an existing
report.** Previously the fixed path was written by the success path *and the
preflight-failure path*, so running it without Docker or ARK credentials
destroyed Attempt #4 in seconds. **Do not remove this guard.** A new authorized
attempt sets `TRAVEL_PROOF_REPORT` to a distinct filename.

**Stage 7D.5 — artifact contract (finding N).** `commitArtifacts` used
`publishedArtifactId` as a proxy for *"has been validated"*. It is a proxy for
*"crossed a principal boundary"*. The branch correctly handled confidentiality
and silently skipped integrity, so a task could satisfy a **typed** dependency
with arbitrary output simply by declining to publish. T5 → `A_VALIDATED` and
T6 → `A_FINAL` always take that branch and always declare a type, so this was
live in the demo. Now fails closed, without routing same-principal output through
the cross-principal Return Gate.

---

## The one blocking decision — finding H

**Human identity is asserted, never proved.** `verifyIdentity`'s human branch is
a bare array lookup of the raw `x-principal-id` header. There is no session,
cookie, signature, or per-principal secret anywhere; the only cryptographic
credential in the server is the agent RUN_TOKEN HMAC.

Severity **MEDIUM**, not HIGH, because it is config-dependent — but the default
`npm run dev` posture is `0.0.0.0` with no token, where
`curl -H 'x-principal-id: wtan' …` is the entire exploit and both ids are public
constants.

**Recommendation: Option A (perimeter fail-closed, peer-based).** ~15 lines in
`app.ts`. Rationale, alternatives, and the two conditions attached to it are in
`docs/STAGE_7D5_BACKEND_SIGNOFF.md` §6–§7. **Nothing was implemented** — this
stops for approval by design.

Two things to carry into whatever you choose:

- **`--host 0.0.0.0` in `apps/web/package.json:7` defeats Option A** by letting a
  LAN caller launder through the Vite dev server into a loopback peer. Drop it in
  the same commit.
- **Do not let the commit claim H is closed.** The honest sentence is: *human
  identity is unauthenticated; `x-principal-id` is a selector, not a credential;
  this is a single-owner demo.* Option B is the one that can most easily be
  misread as real per-user auth — its own analysis flagged
  `introducesUnnecessaryIam: true`.

---

## Gotchas that cost time here

- **`.env` is never loaded.** No dotenv dependency, no `--env-file`;
  `config.ts:52` reads `process.env` directly. `README.md:180-186` tells you to
  `cp .env.example .env` — **nothing reads it.** Setting `APP_AUTH_TOKEN` there
  does nothing; you must `export` it. This silently puts operators in the weakest
  posture while they believe they are in the strongest. Worth fixing regardless
  of H.
- **Run the suite from `apps/server`, not the repo root.** Two report-hash tests
  resolve `../../reports` off cwd and fail from the root. `npm run check` handles
  this correctly.
- **The suite rewrites `reports/PHASE6.md` and `reports/phase6-measurement.json`**
  with machine-local timings. Restore with `git checkout -- reports/` before
  committing, or you will commit timing noise.
- **Never run `npm run travel:proof`.** No Attempt #5. The guard now prevents the
  worst outcome, but the freeze still stands.

---

## Stage 7E preconditions

The evidence contract is truthful but not yet complete enough to draw everything:

| Needed | State |
| --- | --- |
| Run Header, Delegation Tree, Governance Timeline, Authority × Budget, attenuation, context | **READY** |
| Task / Lifecycle Graph | **NOT READY in production** — `index.ts` supplies no descriptor, so graph fields are honestly `UNAVAILABLE`. Needs a backend-owned workload descriptor registry. **Do not reconstruct the graph in React, and do not put workload identity into generic middleware.** |
| Runtime Decision Card | candidates and horizon are OBSERVED; `explanation` is still `UNAVAILABLE` |
| Run discovery | **missing** — only `GET /api/governance/runs/:id` by known id |

Full matrix: `docs/PRE_STAGE7E_HARDENING.md` §12.

---

## Invariants — do not break these

- `authorize()` is the ONLY hard ALLOW/DENY primitive.
- `middleware/**` must never import or branch on Travel semantics
  (`grep -rniE "travel|passport|itinerary" apps/server/src/middleware/` must stay
  empty).
- Protected resources stay behind the Resource Gate — never in a workspace, never
  to the parent.
- The Return Gate is mandatory for cross-principal output; raw child assistant
  output is never a parent handoff.
- Never manually mutate `runState.tokensUsed` / `grantState.tokensUsed`.
- The UI explains; it never computes authorization, routing, budget, or
  attenuation.
- HG-14 stays **PARTIAL**. The Return Gate read path does not re-authorize —
  see sign-off §9. Do not claim complete mediation for it.
- No force push. No merge to main. No provider/Ark/container runs without
  explicit approval.

---

## Verify the handoff

```bash
cd apps/server && npx vitest run          # 416/416 across 35 files
cd ../.. && npm run check                 # typecheck + tests + both builds
git checkout -- reports/                  # discard timing churn the suite writes
```
