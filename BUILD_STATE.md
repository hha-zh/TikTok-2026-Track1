# BUILD STATE

Resumption pointer. BACKLOG holds findings, git holds history, this holds state.
Update at the end of every item, in the same commit.

## Where we are

- Branch `feature/runtime-governor`, pushed and in sync with origin.
- `npm run check` green — **182 tests, 19 files**, typecheck and both builds pass.
  The launcher flake is fixed (verified 8/8 plus three full runs).
- Hard Governance is complete and reachable from the real production path. Per
  the project boundary, do not expand it further without a concrete
  verification bug.
- **Adaptive Runtime started.** Pure core landed: TaskGraph, CandidateBuilder,
  Router. Not yet built: ContextBroker, ExecutionEngine, Todo demo graph.
- **Not started:** negative-test sweep, VECTORS.md, measurement, Run Inspector,
  README, reproducibility.

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
| TaskGraph (validate, readiness, cycles) | done |
| CandidateBuilder (REUSE_CURRENT / DELEGATE_SPECIALIST) | done |
| Router (DIRECT / SERIAL / PARALLEL, RUN / DEGRADE / DEFER / SKIP / BLOCKED) | done |
| ContextBroker | not started |
| ExecutionEngine | not started |
| Todo TaskGraph + integrated demo | not started |

## Next action

**ExecutionEngine** — drive a TaskGraph round by round: build candidates for the
ready set, route them, execute the assignments (reuse inline, delegate via the
existing `DelegatedAgentLauncher`), record real usage, then re-route with the
updated budget. It is the piece that turns the pure core into something
demonstrable, and it needs no new governance surface.

The other open front is evidence: the Run Inspector has nothing on screen yet,
and everything it needs is already a ledger query — `budgetView`,
`provenanceView`, `eventView` in `middleware/evidence/views.ts`.
