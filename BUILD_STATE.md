# BUILD STATE

Resumption pointer. BACKLOG holds findings, git holds history, this holds state.
Update at the end of every item, in the same commit.

## Where we are

- Branch `feature/runtime-governor`, pushed and in sync with origin.
- `npm run check` green — **311 tests, 28 files**, typecheck and both builds pass.
  The launcher flake is fixed (verified 8/8 plus three full runs).
- Hard Governance is complete and reachable from the real production path. Per
  the project boundary, do not expand it further without a concrete
  verification bug.
- **Adaptive Runtime complete through Phase 6C.** Pipeline runs end to end and
  the runtime feedback loop is proven by test, not asserted.
- **Not started:** Run Inspector / frontend, VECTORS.md, README, reproducibility.

## Item status

| item | state |
| --- | --- |
| 1 types · 2 ledger + projections · 3 identity · 4 grant resolver · 5 run token | done |
| 6 fixtures + root bootstrap | done |
| 7 authorize · 8 resource + tool gates · 9 revocation · 10 redaction | done |
| 11 deriveChildEnvelope (branded) · 12 delegate_task lifecycle | done |
| 13 Artifact + Return Gate | done |
| 14 two-level budget | done |
| 15–18 verification | **not started** |
| 19–21 console, reproducibility, README | **not started** |

## Verified configuration — container only

```
RUNTIME_PROVIDER=container
CODEX_SANDBOX_MODE=danger-full-access
CODEX_HOME=<root>/<agentId>          per agent, not shared
```

- `local-process` is unsupported: the agent runs as the same uid as the server
  and the store is mode 0600, so it reads every managed resource off disk and
  complete mediation is false. `DelegatedAgentLauncher` already refuses it (503).
- `container` + `workspace-write` is unreachable — Codex Landlock is absent from
  the runtime image, so the POC script falls back to `danger-full-access`.
- Callback target inside a container is `http://host.docker.internal:3000`;
  `127.0.0.1` fails there. The runner passes `--add-host`.
- `curl` is **not** in the runtime image (exit 127). Trusted-tool instructions
  must use `node -e "fetch(...)"`.

## How a governed run actually starts

Nothing bootstrapped root authority before item 6, so the middleware was
reachable only from tests. The production path is now:

```
seedGovernanceFixtures(store)          at boot — humans, resources, schema
POST /api/governance/runs  (human)     startGovernedRun -> parent RUN_TOKEN
  -> sendGovernedMessage               parent agent runs with the token
  -> POST /api/delegations             child envelope, child agent, child token
  -> POST /api/artifacts[/:id/publish] Return Gate
```

The Playground's own `POST /api/agents/:id/messages` stays ungoverned, so the
pre-existing contract is unchanged.

## Open blockers

See [BACKLOG.md](BACKLOG.md). Blocking ones:

- **No UI** — every governance view is backend-only; the console (item 19) is
  what a judge actually looks at.
- **Docs describe the middleware-free starter kit** and contradict what the
  branch now does.

## Adaptive Runtime — the boundary that must hold

    Hard Governance defines the legal execution space.
    Adaptive Runtime chooses only inside it.

`CandidateBuilder` marks each placement legal or not using the two existing
functions in their designed roles — `authorize()` for capacity, then
`deriveChildEnvelope()` for scope, in that order. The `Router` ranks only what
survived and reports denials verbatim.

**There is no second authorization system and there must not be one.** If
`router.ts` ever needs to reason about resources, actions or ancestry to decide
whether something is permitted, stop and report rather than adding it.

| piece | state |
| --- | --- |
| Invocation ExecutionEnvelope (Γ_i = Γ_principal ∩ Γ_task ∩ Γ_policy) | done |
| TaskSpec + TaskGraph (artifact-aware readiness, unreachability, cycles) | done |
| CandidateBuilder (REUSE_CURRENT / DELEGATE_SPECIALIST) | done |
| Router — WHO (soft marginal-benefit ranking, budget pressure) | done |
| Router — HOW (DIRECT / SERIAL / PARALLEL, decided independently of WHO) | done |
| ContextBroker (least context, Return-Gate boundary) | done |
| ExecutionEngine (round-based, waves, defer ceiling) | done |
| Todo TaskGraph + integrated run | done |
| UIPlan / TestPlan bounded Return-Gate types | done |
| Real delegation + Resource/Artifact Gate adapters | done |
| Backend denial + recovery in the same run | done |
| Real AgentService integration (live adapter) | done |
| Adaptive runtime evidence persisted to the ledger | done |
| Output type contract + conflict-safe schema registration | done |
| Phase 6 case manifest (HG-01..15, AR-01..10) | done |
| Phase 6 baseline comparison + measurement | done |
| Explanatory ConstraintAxis (never a verdict) | done |
| Hard capacity split from declared planning estimate | done |
| Intrinsic delegation value independent of remaining budget | done |
| ONE CandidateSnapshot per task/round (router == evidence) | done |
| decisionId correlation (decision -> invocation -> outcome) | done |
| TopologyPolicyMode for declared static baselines | done |
| Ledger feedback loop proven without manual usage writes | done |
| External container probe script | written, NOT RUN — environment unavailable |
| Run Inspector / README | **not started — stopped for review** |

### Two envelopes, deliberately separate

    Envelope (governance)      authority SOURCE  — what a principal holds
    ExecutionEnvelope          per-task VIEW     — what one task may use

One principal executes different tasks under different narrowed scopes without
spawning a child. The view is built by intersection so it cannot widen, and it
returns no verdict — `authorize()` is still asked against the grant.

### WHO and HOW are independent

WHO is a real choice when both placements are legal: declared marginal benefit
against a threshold that rises with budget pressure. No hints means no evidence
that extra agency is worthwhile, which resolves to REUSE_CURRENT.

HOW has its own inputs. PARALLEL requires separate executors AND declared
independence AND budget headroom — two independent delegations still serialise
when headroom is thin.

## Phase 6C — the feedback loop and what it cost to state honestly

    routing decision -> execution -> tokens_consumed -> projection -> next decision

Every budget number a decision sees is folded out of the ledger. No test in
`phase6/feedback-loop.test.ts` writes `runState.tokensUsed` or
`grantState.tokensUsed`; the only lever is what the executor actually costs.

### Three separations that were previously blurred

| was | now |
| --- | --- |
| `affordable` mixed stored capacity with a declared estimate | `hardEligible` (stored state) vs `planningFit` (declared) vs `routableNow` (both) |
| delegation value divided by remaining budget | value is intrinsic; scarcity lives only in the threshold |
| "authority denied" flattened scope and horizon | `ReasonCode` preserved, `ConstraintAxis` explains alongside it |

`ConstraintAxis` is EXPLANATORY ONLY. `authorize()` remains the single hard
primitive and its `ReasonCode` is always recorded beside the axis. If the axis
ever appears in a branch that decides an outcome, that is a bug.

### One snapshot, one decision

`buildCandidates` runs once per task per round. The router ranks those objects
and the ledger records those same objects, shared by reference. Building twice
over identical state usually agreed — and "usually" is precisely the property a
governance trail cannot rest on. A test counts real builds against recorded
decisions; two builds would double the count.

### Router policy constants (declared, not fitted)

| constant | value | note |
| --- | --- | --- |
| `mode` | `ADAPTIVE` | `ALWAYS_REUSE` / `ALWAYS_DELEGATE` are the static baselines |
| `baseThreshold` | 1 | bar at zero pressure |
| `pressureWeight` | 6 | additive: `base + weight * runPressure` |
| `costReferenceTokens` | 4000 | stable scale — deliberately NOT remaining budget |
| `parallelHeadroom` | 0.75 | fraction of effective budget a wave may plan |
| `isolationBonus` | 0.25 | only when declared AND structurally narrower AND legal |
| `epsilon` | 0.01 | guards divide-by-zero on a zero-cost task |

Not fitted to observed data, and no claim is made that they are. The scenario
matrix in `reports/PHASE6.md` shows the three policies separating.

## Backend freeze criteria

| criterion | state |
| --- | --- |
| `authorize()` is the only hard verdict primitive | held |
| No second authorization system in `router.ts` / `candidates.ts` | held |
| One `GovernanceLedger`, single append path, projections in the same mutation | held |
| No raw prompts, protected contents, child output, tokens or credentials persisted | held |
| Return Gate mandatory for every child->parent handoff | held |
| Dispatch-time revalidation survives planning-time approval | held |
| Declared estimates never reserved against, or folded into, real usage | held |
| HG-01..15, AR-01..10, AB-01..07 present, with limitations stated | held (HG-14 PARTIAL) |
| `npm run check` green three consecutive runs | held |
| Complete mediation under `local-process` | **NOT held — container mode only** |
| Per-model-call Model/Budget mediation | **NOT held — dispatch granularity (HG-14)** |
| External Container/Codex/Ark probe executed | **NOT RUN — environment unavailable** |

## Next action

Frontend / Run Inspector. Backend is frozen at the criteria above; reopen it
only for a concrete verification bug, not for polish.
