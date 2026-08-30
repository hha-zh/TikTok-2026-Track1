# BUILD STATE

Resumption pointer. BACKLOG holds findings, git holds history, this holds state.
Update at the end of every item, in the same commit.

## Where we are

- Branch `feature/runtime-governor`, 12 commits ahead of the starter baseline.
- `npm run check` green — **164 tests, 18 files**, typecheck and both builds pass.
- **Not started:** Tier 3 (negative-test sweep, VECTORS.md, measurement, hash
  chain) and Tier 4 (run console, reproducibility, README).

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

- **Flaky test** — `delegated-agent-launcher.test.ts` fails roughly 1 run in 3
  with `ENOTEMPTY` during cleanup: a store write is still in flight when the
  temp directory is removed. An un-awaited mutation, not a cleanup bug.
- **No UI** — every governance view is backend-only; the console (item 19) is
  what a judge actually looks at.
- **Docs describe the middleware-free starter kit** and contradict what the
  branch now does.

## Next action

**Item 19 — run console**, or **item 15 — the negative-test sweep**. The console
is the higher demo risk: all three moments now work end to end at the API level
but there is nothing on screen. Everything it needs is already a ledger query —
`budgetView`, `provenanceView`, `eventView` in `middleware/evidence/views.ts`.
