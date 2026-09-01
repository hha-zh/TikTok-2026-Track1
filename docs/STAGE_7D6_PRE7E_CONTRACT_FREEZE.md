# Stage 7D.6 — Pre-7E Contract Freeze

## 1. Executive Summary

Stage 7D.6 closes the UI-independent backend contract work required before Stage 7E.

- `laterDecisionsReferenceProjectedState` is now evidence-derived rather than self-asserted.
- Governed runs can persist a domain-neutral `(workloadId, descriptorVersion)` key.
- Production application composition resolves recognized Travel metadata through a workload registry and supplies only the bounded descriptor to `GovernedRunView`.
- Unknown/missing workload keys and versions remain honestly unavailable.
- Backend and Vite development defaults bind to loopback.
- Human identity remains unauthenticated; `x-principal-id` remains only a selector under a single trusted local-owner assumption.

No Stage 7E React/UI implementation, provider execution, container execution, run-discovery endpoint, Travel HTTP start endpoint, or decision-explanation feature was added.

## 2. Current Git State

The stage began from:

```text
repository: /home/zhyjh/code/CodeJam
branch: feature/travel-lifecycle
HEAD: 3a38e852a4bb9c2671b222d244ed3fd672fd4d66
pre-existing untracked file: docs/STAGE_7E_API_CONTRACT_AUDIT.md
```

The pre-existing audit document is retained and reconciled with current source. Stage 7D historical reports were not edited. Test-generated Phase 6 timing churn was restored after validation.

The final integration base includes the remote Stage 7D.4 evidence hardening, Stage 7D.5 unpublished artifact-contract enforcement, and Stage 7D.5 audit/sign-off/handoff documentation. Stage 7D.6 preserves those repairs and reconciles its API documentation against the now-available handoff state.

## 3. laterDecisionsReferenceProjectedState Reconciliation

### Verdict

The pre-change source was category **B: still literal/self-asserted**.

Both the TypeScript contract and serializer fixed the field to literal `true`. Existing integration tests proved the underlying runtime feedback loop, but the `GovernedRunView` builder did not derive this particular API field from that evidence.

### Repair

The builder now:

1. orders persisted run events by ledger sequence;
2. selects routing decisions having at least one prior `tokens_consumed` event;
3. folds cumulative recorded token usage strictly before each such decision;
4. derives expected remaining run tokens from the persisted run cap;
5. returns `true` only when at least one post-usage decision exists and every such decision's recorded budget snapshot agrees with that projection.

This establishes reference consistency between prior usage projection and later recorded decision state. It does **not** claim that usage was the sole cause of a placement choice.

A regression test alters a later decision's recorded remaining budget by one token and proves the field becomes `false`. This test would fail under the former literal implementation and under an overly weak existential derivation.

## 4. Workload Descriptor Registry Architecture

The implemented dependency direction is:

```text
Travel workload descriptor factory
              ↓
application/workload descriptor registry
              ↓
createApp injected resolver
              ↓
generic GovernedRunView builder
```

`apps/server/src/workload/descriptor-registry.ts` is the application/workload composition boundary. It owns the mapping from a stable generic key to a bounded descriptor factory. Generic middleware neither imports the registry nor knows which workloads are registered.

The Travel workload owns:

```text
workloadId: travel-disruption-v1
descriptorVersion: 1
```

and continues to own its graph, scenario, domain summary, and descriptor construction.

## 5. Production GovernedRunView Path

The production path is now:

```text
startTravelRun
  → startGovernedRun(workloadDescriptor)
  → RunState.workloadDescriptor persisted by JsonStore
  → createWorkloadDescriptorResolver(store)
  → createApp(... governedRunDescriptor: resolver)
  → GET /api/governance/runs/:id
  → buildGovernedRunView(store, runId, resolvedDescriptor)
```

`RunState.workloadDescriptor` contains only the domain-neutral lookup fields `workloadId` and `descriptorVersion`. A store regression test proves they survive persistence and reload.

For missing metadata, an unknown workload, or an unknown descriptor version, the resolver returns `undefined`. The API then exposes `run.workload: null`, marks task declaration data `UNAVAILABLE`, and does not infer identity from task names or reconstruct dependencies from event order.

The generic `POST /api/governance/runs` remains a generic governed-agent entry and intentionally creates no Travel descriptor metadata.

## 6. Evidence Quality Preservation

The view now makes the declaration/runtime distinction explicit:

- recognized workload identity/scenario: `DECLARED`;
- graph labels, requiredness, dependencies, and produced artifact types: per-field `QualifiedEvidence` with `quality: DECLARED` and `source: WORKLOAD_DESCRIPTOR`;
- unknown/missing descriptor metadata: per-field `QualifiedEvidence` with `quality: UNAVAILABLE` and `source: NONE`;
- runtime task status reconstructed from persisted lifecycle events: `statusQuality: DERIVED`;
- execution provenance: `DECLARED` when supplied, otherwise `UNAVAILABLE`;
- usage-to-later-decision projection reference: `DERIVED` from event ordering and snapshot agreement.

Production resolution supplies safe declared Travel graph metadata and declared deterministic-fixture provenance. It does not invent oracle verdicts. The deterministic proof path may provide its already-evaluated oracle, which Stage 7D.4 explicitly labels `DECLARED / WORKLOAD_DESCRIPTOR`; the production registry leaves oracle results unavailable until authoritative durable oracle evidence exists.

## 7. Generic Middleware Independence

The generic governance types and bootstrap accept only a generic descriptor key. The evidence builder receives only a resolved `GovernedRunDescriptor`.

A case-insensitive scan was run for:

```text
travel
passport
itinerary
flight
accommodation
disruption
```

under `apps/server/src/middleware/**`. No workload/domain identifiers were introduced. The only textual matches were pre-existing uses of the ordinary phrase `in-flight` in Return Gate comments/tests; the Stage 7D.6 middleware diff contains no matching term.

No changes were made to `authorize()`, `deriveChildEnvelope()`, RouterPolicy, CandidateBuilder, budget semantics, ExecutionEngine scheduling, ContextBroker, Return Gate semantics, or Travel TaskGraph semantics.

## 8. Local Single-Owner Trust Model

The frozen honest model is:

```text
APP_AUTH_TOKEN → optional shared application perimeter credential
x-principal-id → stored HumanPrincipal selector
```

Human identity is unauthenticated. `x-principal-id` is not a credential and is not cryptographically bound to a user, bearer, session, JWT, OAuth identity, or per-principal secret.

Stage 7E assumes one trusted local owner. Browser-side selection/header wiring is deferred to Stage 7E and must not be described as authentication.

## 9. Network Bind / Perimeter Assessment

Before Stage 7D.6, ordinary development exposed both surfaces on all interfaces:

- backend `HOST` default: `0.0.0.0`;
- Vite dev script: `vite --host 0.0.0.0`.

Both defaults are now explicitly loopback-only:

- backend default: `127.0.0.1`;
- Vite dev host: `127.0.0.1`;
- Vite API proxy target remains `127.0.0.1:3000`.

An explicit `HOST` override remains possible and is tested. The real Stage 7D container proof explicitly binds its backend process to `0.0.0.0`, because the isolated bridge container calls it through `host.docker.internal` and the host gateway rather than through host loopback. This override is scoped to the container proof/runtime process; it is not the ordinary development or Stage 7E browser default.

Operators who deliberately bind to `0.0.0.0` leave the single-owner loopback posture and must provide an appropriate perimeter. Loopback binding narrows reachability; it does not authenticate `HumanPrincipal`.

## 10. Stage 7E API Readiness Matrix

| UI area | Status | Contract note |
|---|---|---|
| Run Header | `READY_WITH_QUALITY_LABEL` | Core observed/derived run data plus declared workload identity for recognized descriptors |
| Lifecycle / Task Graph | `READY_WITH_QUALITY_LABEL` | Declared graph metadata and derived runtime status are explicitly separated |
| Runtime Decision Card | `PARTIAL` | Recorded actor/method/candidates/horizon are ready; natural-language explanation remains unavailable |
| Delegation Tree | `READY_WITH_QUALITY_LABEL` | Persisted grant relationships with derived task/lifecycle correlations |
| Governance Timeline | `READY_WITH_QUALITY_LABEL` | Safe normalized projection of ordered ledger events |
| Authority × Budget/Horizon | `READY_WITH_QUALITY_LABEL` | Persisted caps/usage and derived remaining values; max tool calls remain configured but unenforced |
| Parent → Child attenuation | `READY_WITH_QUALITY_LABEL` | Retained authority observed; removed sets derived |
| Context included/withheld | `READY` | Bounded IDs and recorded reasons are available |
| Return Gate visualization | `READY_WITH_QUALITY_LABEL` | Bounded artifact lifecycle available; HG-14 reread limitation remains |
| Usage feedback / topology history | `READY_WITH_QUALITY_LABEL` | Ordered deltas and evidence-derived projection reference; no sole-causation claim |
| Outcome summary | `PARTIAL` | Runtime outcome and domain summary available; production oracle verdicts remain unavailable |

For a run with a recognized descriptor key, the TaskGraph backend truth is ready. Unknown keys remain intentionally unavailable rather than partially guessed.

## 11. UI-Dependent Deferred Items

The following remain deliberately deferred:

1. Governed-run discovery/list/history API — required only if the UI navigation begins from history instead of retaining a returned `runId`.
2. Natural-language runtime decision explanation — the UI may display recorded evidence but must not invent rationale.
3. Travel lifecycle HTTP start endpoint — generic `POST /api/governance/runs` is not the full Travel lifecycle.
4. Stage 7E React components, pages, routes, styles, charts, and diagrams.

The reusable deterministic lifecycle function is `runTravelLifecycle`, which composes Travel fixtures, `startTravelRun`, the Travel graph, executor/delegation ports, ExecutionEngine, revocation, oracle evaluation, and view construction. It uses an isolated temporary store and is proof/test composition, not a production HTTP service. `startTravelRun` is the reusable persistent-store bootstrap portion. A production service boundary must be chosen with the final UI flow before exposure.

## 12. Known Limitations

- Human principal identity is not authenticated.
- Browser principal-header wiring is not implemented.
- No governed-run discovery endpoint exists.
- No complete Travel lifecycle HTTP entry exists.
- Routing explanation remains `UNAVAILABLE`.
- Production registry does not manufacture or persist Travel oracle verdicts.
- The known artifact reread limitation remains; Return Gate semantics and HG-14 `PARTIAL` status are unchanged.
- `.env` is not loaded automatically; explicit shell sourcing remains the operational WSL workflow and automatic loading remains submission/reproducibility cleanup.
- Attempt #4 is untouched; no Attempt #5 was created. The 150,000 live allowance and 12,000 deterministic pressure cap remain different evidence settings.

## 13. Tests

Focused integration validation:

```text
6 test files passed
71 tests passed
server TypeScript check passed
```

Coverage includes:

- correct and deliberately incorrect usage/decision projection references;
- real Travel descriptor resolution through the production HTTP composition path;
- declared workload, labels, required flags, dependencies, and produced artifact types;
- declared metadata versus derived task status quality;
- unknown workload and unknown descriptor version unavailability;
- descriptor metadata persistence/reload;
- backend loopback default and explicit override.

Full validation after integration with the remote Stage 7D.4/7D.5 base:

```text
apps/server: 37 test files passed, 425 tests passed
npm run check: PASS
  server/web typecheck: PASS
  server tests: PASS
  server/web build: PASS
```

Final `git diff --check` and status verification are recorded in the handoff response.

## 14. Backend Freeze Recommendation

Freeze the current backend contract for Stage 7E with these boundaries:

- Use `GET /api/governance/runs/:id` as the canonical bounded read model.
- Use the persisted descriptor key and composition registry as the only workload-metadata resolution path.
- Preserve evidence quality in UI labels.
- Assume loopback-only, single trusted local owner for the demo.
- Do not claim authenticated human identity or production oracle verdicts.
- Keep discovery, Travel HTTP start, and natural-language explanation deferred until the UI flow requires them.

Within those constraints, the backend contract is ready for Stage 7E human review and UI design/implementation.
