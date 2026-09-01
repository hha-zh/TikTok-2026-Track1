# Stage 7E API Contract Audit

**Audit mode:** read-only source audit, followed by creation of this report only
**Repository:** `/home/zhyjh/code/CodeJam`
**Branch:** `feature/travel-lifecycle`
**Audited HEAD:** `3a38e852a4bb9c2671b222d244ed3fd672fd4d66`
**Scope:** Stage 7E UI/API readiness; no provider execution, no container execution, no source changes

## 1. Executive conclusion

The backend already exposes a strong, bounded, read-only governed-run projection at:

```text
GET /api/governance/runs/:id
```

The projection is suitable for much of a governance inspector: run lifecycle, task status, routing decisions, authority, budget horizon, delegation attenuation, context projection, artifact return gates, safe governance events, usage feedback, and outcome summaries.

After Stage 7D.6 contract closure, it is suitable for the Stage 7E read-only TaskGraph when a run carries a recognized descriptor key. It is **not yet sufficient for every possible Stage 7E flow** for three independent reasons:

1. Production now resolves declared Travel workload and TaskGraph metadata from durable `workloadId`/`descriptorVersion` metadata. Runtime oracle summaries remain unavailable unless authoritative oracle evidence is supplied; they are not reconstructed.
2. The browser client does not send `x-principal-id`, while the governed-run read route requires a human principal. If `APP_AUTH_TOKEN` is enabled, the browser needs both the shared bearer token and the human-principal header.
3. There is no governed-run discovery endpoint. This does not block a create-then-inspect flow that preserves the returned `runId`, but it does block a standalone recent/history inspector.

The most important pre-UI decision is therefore not visual: choose the run-entry flow and the human identity trust model, then make workload metadata durable and resolvable without importing Travel-specific code into generic middleware.

## 2. Required-input availability

The task named four documents as mandatory reading:

- `PROGRESS_HANDOFF_ziqiang.md`
- `docs/STAGE_7D5_BACKEND_SIGNOFF.md`
- `docs/PRE_STAGE7E_HARDENING.md`
- `HARDENING_FINDINGS_FOR_YIJIE.md`

At the time of the source-only API audit, these handoff materials were not present in that local checkout. After integration of the Stage 7D.5 documentation lineage, `docs/STAGE_7D5_BACKEND_SIGNOFF.md`, `docs/PRE_STAGE7E_HARDENING.md`, and `HARDENING_FINDINGS_FOR_YIJIE.md` are available, together with the equivalent `PROGRESS_HANDOFF.md`. The original `PROGRESS_HANDOFF_ziqiang.md` filename is not present. Source-derived API conclusions have been reconciled against this verified handoff state.

## 3. Endpoint inventory

### 3.1 Governance and runtime endpoints

| Method and path | Identity | Mutability | Response/use | Stage 7E assessment |
|---|---|---:|---|---|
| `GET /api/health` | App bearer only if globally configured; route itself is exempt | Read | `{ ok, service }` | Useful only for connectivity |
| `GET /api/auth` | Exempt from app bearer | Read | `{ required }` | Lets UI discover whether the shared bearer is required |
| `GET /api/system` | App bearer if configured | Read | System/provider information | Ancillary; do not expose provider secrets |
| `GET /api/runtime/identity` | Runtime run token | Read | Runtime agent identity | Not a human UI identity endpoint |
| `GET /api/governance/runs/:id` | Human principal; app bearer also required when configured | Read | `{ run: GovernedRunView }` | Primary Stage 7E inspector contract |
| `POST /api/governance/runs` | Human principal; app bearer also required when configured | Write/execute | Creates a generic governed run and returns `runId`, root authority IDs, and `agentRunId` | Can support create-then-inspect, but is not a Travel TaskGraph lifecycle endpoint |
| `POST /api/envelopes/:id/revoke` | Human principal | Write | Revokes authority | Must not be used by a read-only inspector |
| `POST /api/delegations` | Runtime agent | Write | Creates attenuated child authority | Internal runtime surface |
| `GET /api/resources/*` | Runtime agent | Read | Managed resource contents | Protected runtime surface, not UI data access |
| `POST /api/tools/:name` | Runtime agent | Tool-dependent write | Tool execution result | Not a read-only UI surface |
| `POST /api/artifacts` | Runtime agent | Write | Artifact creation | Internal runtime surface |
| `POST /api/artifacts/:id/publish` | Runtime agent | Write | Artifact publication | Internal runtime surface |
| `GET /api/artifacts/:id` | Runtime agent | Read | Artifact | Not directly callable by a human inspector |

### 3.2 Agent endpoints

The server also provides CRUD, lifecycle, messages, and run endpoints under `/api/agents` and `/api/runs/:id`. These refer to ordinary agent/runtime records, not the governed-run projection.

The distinction matters:

```text
governed runId != agentRunId
```

`POST /api/governance/runs` returns both identifiers. The existing web application starts ordinary agent runs through the agent-message endpoint and currently retains only the ordinary run model. The UI must not pass an `agentRunId` to `GET /api/governance/runs/:id` or infer a governed ID from it.

## 4. GovernedRunView contract

The projection has contract version `"1"` and exposes the following safe top-level sections.

| Section | Main fields | Intended UI use |
|---|---|---|
| `run` | ID, workload identity/scenario, status, timestamps, duration, root principal/grant | Run header and lifecycle |
| `tasks` | ID, label, status, required flag, dependencies, produced artifacts, execution provenance | TaskGraph/lifecycle view |
| `routingDecisions` | sequence/time/task, selected actor and method, disposition/wave, candidates, horizon, explanation | Runtime decision cards and topology changes |
| `authority` | root exercisable/delegatable resources and actions | Authority overview |
| `runtimeState.budgetHorizon` | run/root token usage, child capacity, depth, tool-call configuration | Budget and constraint status |
| `delegations` | parent/child authority, lifecycle, retained and removed authority | Delegation tree and attenuation inspector |
| `contextProjections` | included artifact IDs and withheld artifacts with reasons | Context-boundary inspector |
| `artifacts` | bounded fields, ownership, creation/publication/recipient lifecycle | Return-gate and artifact inspector |
| `governanceEvents` | normalized safe event sequence | Timeline/audit trail |
| `usageFeedback` | usage provenance, deltas, projected run usage, later-decision flag | Usage/topology history |
| `outcome` | runtime completion state and optional domain/governance/adaptive/lifecycle oracle summaries | Outcome and oracle evidence |

The route returns a bounded projection rather than raw ledger records or arbitrary stored objects. That is the correct security boundary for the UI.

## 5. Field provenance and evidence quality

The UI must not visually present all fields as equally observed. The following labels describe how the current builder actually obtains the values.

| Contract area | Source quality | Required presentation constraint |
|---|---|---|
| Run ID, root authority, creation information | **OBSERVED** from persisted authority/state | May be shown as recorded runtime state |
| Run status and timestamps | **OBSERVED** events; duration is **DERIVED** | Duration should be labeled calculated |
| Workload ID and scenario | **DECLARED** when a descriptor is supplied; otherwise **UNAVAILABLE** | Never infer Travel/scenario from task names |
| Task labels, requiredness, dependencies, expected artifact types | Per-field `QualifiedEvidence`: **DECLARED / WORKLOAD_DESCRIPTOR** with a descriptor, **UNAVAILABLE / NONE** without one | Never treat descriptor-less fallback IDs as TaskGraph truth |
| Task status | **DERIVED** from observed events | Show as reconstructed lifecycle state |
| Execution provenance | Explicitly **DECLARED** or **UNAVAILABLE** | Preserve the quality field verbatim |
| Routing decisions | **OBSERVED** persisted routing events | Safe to render as decisions that were recorded |
| Candidate eligibility/fit and horizon snapshot | Values were computed at decision time and then persisted; the API marks the persisted snapshot **OBSERVED** | Do not reinterpret them using current state |
| Decision explanation | Currently **UNAVAILABLE** | UI must say unavailable, not generate a rationale |
| Root authority and grant limits | **OBSERVED** persisted envelope | Safe to render directly |
| Remaining budget/capacity and removed authority | **DERIVED** from observed limits and usage | Label calculated/derived |
| Maximum tool calls | Configuration is visible, but `enforced: false` is a declared limitation | Do not imply enforcement |
| Delegation lifecycle/task correlation | Mixed **OBSERVED/DERIVED** | Preserve null task correlation where present |
| Context projection | **OBSERVED** projection events | Withholding reasons may be rendered verbatim |
| Artifact data and events | Bounded **OBSERVED** data; lifecycle flags are **DERIVED** | Never fetch/display unbounded backing data |
| Governance timeline | Safe normalization **DERIVED** from observed ledger events | It is a projection, not raw ledger evidence |
| Usage deltas | **OBSERVED** events; projected totals are **DERIVED** | Distinguish deltas from calculated totals |
| `laterDecisionsReferenceProjectedState` | **DERIVED** from ledger ordering and equality between every post-usage decision budget snapshot and cumulative prior usage | It proves consistent reference to projected budget state, not sole causation of placement |
| Outcome runtime summary | **DERIVED** from outcome/events | Label as summary |
| Oracle summaries | Descriptor-provided; otherwise `null` | Production currently returns no Travel oracle evidence |

## 6. Production descriptor resolution

Stage 7D.6 added a durable, domain-neutral `workloadDescriptor` key to `RunState`, containing `workloadId` and `descriptorVersion`. The Travel bootstrap persists `travel-disruption-v1` / `1`. The application composition layer owns a registry that maps this key to the bounded Travel descriptor, and production injects that resolver into the HTTP application.

For a recognized Travel run, the production HTTP response now includes:

- declared workload identity and scenario;
- all seven declared task labels;
- requiredness, dependencies, and produced artifact types;
- declared execution provenance;
- derived runtime task status kept separate from declared metadata.

Unknown workload IDs, unknown descriptor versions, and missing metadata resolve to `undefined`; the view honestly returns `run.workload: null` and per-field `QualifiedEvidence` with `quality: "UNAVAILABLE"` and `source: "NONE"`. Runtime oracle summaries remain `null` in the production registry because no durable authoritative oracle result is currently stored. The deterministic proof path may still supply its evaluated oracle directly, explicitly marked `DECLARED / WORKLOAD_DESCRIPTOR`.

React must continue to consume this backend truth and must not infer workload identity, dependencies, or oracle results.

### Implemented architecture

Keep middleware and the generic projection builder workload-neutral:

1. `RunState.workloadDescriptor` persists the generic key.
2. The Travel bootstrap supplies its own key.
3. `workload/descriptor-registry.ts` is the application/workload composition boundary and imports the Travel descriptor factory.
4. Production injects the resolver into `createApp`.
5. Generic middleware receives only the resolved descriptor and contains no Travel branching.

## 7. Identity, authentication, and trust boundary

There are two distinct checks:

- `APP_AUTH_TOKEN`, when configured, is a shared bearer perimeter check for most `/api` routes.
- `x-principal-id` selects a stored human principal for human-governance routes.

The `x-principal-id` value is not cryptographically bound to the bearer credential or to a user session. A caller that can reach the server and pass the perimeter check can choose any known configured human principal ID. If `APP_AUTH_TOKEN` is absent, reachability plus knowledge/guessing of a configured human ID is sufficient.

The Vite proxy only forwards `/api` traffic to the local server. It does not authenticate the browser peer and does not bind or inject a human principal. The existing browser API helper sends only `Authorization`; it does not send `x-principal-id`. Therefore the governed-run GET route is not currently usable from the existing web client.

### Severity by deployment shape

| Deployment | Assessment |
|---|---|
| Single-owner loopback-only local demo | Conditional acceptance is possible if a fixed seeded human is explicit and documented |
| Ordinary Stage 7E development | Backend and Vite now default explicitly to `127.0.0.1`; single-owner local assumption is bounded to loopback |
| Explicit WSL/LAN `0.0.0.0` override | **High / blocker** until perimeter and principal selection are intentionally controlled |
| Real multi-user deployment | **Blocker**; principal identity must be authenticated and bound server-side |

Do not silently add a hard-coded principal header and call the security issue solved. A local-only demo may use an explicit development identity choice, but the UI and documentation must state that it is a development trust assumption.

## 8. Run entry and discovery

There is no endpoint for listing governed runs, finding the latest governed run, or querying recent governed runs.

This produces two different readiness outcomes:

### Flow A — create then inspect

If Stage 7E starts a governed run and retains the returned `runId`, no list endpoint is required. The UI can navigate directly to the inspector using that ID.

Current limitation: `POST /api/governance/runs` starts one generic governed agent turn. It is not an HTTP entry point for the deterministic Travel TaskGraph lifecycle used by the proof path.

### Flow B — standalone/history inspector

If Stage 7E opens independently and must find previous runs, a bounded human-authorized endpoint is required, for example:

```text
GET /api/governance/runs?limit=...&cursor=...
```

It should return only runs owned by the authenticated human, with safe header fields, stable pagination, and no raw ledger data.

**Decision:** run discovery is **UI-flow dependent**, not unconditionally required. It is required for history/standalone entry and unnecessary for a correctly retained create response.

## 9. UI component readiness matrix

| Proposed Stage 7E component | Status | Exact constraint or missing backend truth |
|---|---|---|
| Run Header | **READY WITH QUALITY LABEL** | Core fields exist; recognized workload identity/scenario are explicitly `DECLARED` |
| Lifecycle / TaskGraph | **READY WITH QUALITY LABEL** | Recognized descriptors provide declared graph truth; runtime status is explicitly `DERIVED` |
| Runtime Decision Card | **PARTIAL** | Actor, method, candidates, wave, disposition, and horizon exist; `explanation.value` is unavailable |
| Delegation Tree | **READY WITH QUALITY LABEL** | Parent/child/lifecycle/attenuation exist; task correlation may legitimately be `null` and some links are derived |
| Governance Timeline | **READY WITH QUALITY LABEL** | Safe ordered events exist; label the view as a normalized projection |
| Authority and Budget Horizon | **READY WITH QUALITY LABEL** | Limits are observed, remaining values are derived, and tool-call enforcement is explicitly false |
| Attenuation Inspector | **READY WITH QUALITY LABEL** | Retained and removed authority exist; removed sets are derived |
| Context Projection Inspector | **READY** | Included IDs and withheld IDs/reasons are directly represented |
| Artifact Return Gate | **READY WITH QUALITY LABEL** | Bounded artifact fields and lifecycle are present; lifecycle aggregation is derived |
| Usage Feedback / Topology History | **READY WITH QUALITY LABEL** | The reference boolean is evidence-derived from ordering and matching budget snapshots, but does not prove that usage was the sole placement cause |
| Outcome Summary | **PARTIAL** | Runtime summary and declared domain constraints exist; production oracle verdicts remain unavailable without durable authoritative oracle evidence |

## 10. Environment and WSL integration

The server configuration reads directly from `process.env`. The package startup path does not automatically load a `.env` file. Backend and Vite development defaults now bind to `127.0.0.1`. Container/deployment scripts may explicitly use an env file, and a shell may explicitly source one; those are separate mechanisms.

Relevant server variables include:

- `HOST`, `PORT`, `NODE_ENV`, `LOG_LEVEL`
- `APP_AUTH_TOKEN`
- `APP_DATA_DIR`, `AGENT_WORKSPACE_ROOT`, `CODEX_HOME`
- provider/runtime/container variables used when execution is enabled

The web dev server listens on port `5173` and proxies relative `/api` requests to `127.0.0.1:3000`. The browser code does not need provider variables for read-only inspection. It needs connectivity, the shared bearer when required, and a resolved human-identity strategy.

Given the supplied context that the WSL flow works when the environment is explicitly sourced, there is no evidence of a current WSL runtime blocker. The absence of automatic dotenv loading remains an onboarding/reproducibility gap, not proof of failure.

No environment secrets were read or reproduced in this audit.

## 11. Natural frontend integration point

The existing web application is a single-page Vite/React surface with relative API fetches and no routing layer. The smallest frontend-only integration shape is:

- add typed governance API methods beside the existing API helper;
- model `GovernedRunView` as its own contract, distinct from `AgentRun`;
- retain the `runId` returned by governed-run creation or accept an explicit run ID;
- render the inspector as a separate top-level view/panel rather than folding its data into ordinary agent messages;
- send the chosen development human identity only after the trust decision is explicit.

That wiring does not solve the Travel execution-entry, discovery, authenticated-principal, or durable oracle-result gaps.

## 12. Backend changes definitely required before the full UI

For the complete Travel governance UI described by the component matrix, the following backend truth is required:

1. An intentional human identity binding for any deployment beyond a single-owner loopback demo.
2. A Travel lifecycle execution entry point only if the UI is expected to start the demonstrated Travel workflow rather than inspect a pre-created governed run.
3. A governed-run list/recent endpoint only if the chosen UI begins from history rather than a retained `runId`.
4. Explicit decision rationale only if the UI requirement includes natural-language explanation of candidate selection.
5. Durable authoritative oracle-result evidence only if production UI must show oracle verdicts.

All items depend on the final UI/deployment claims. None blocks a read-only loopback TaskGraph inspector for an already-known, recognized Travel run.

## 13. Claims the UI must not make

Until the gaps above are resolved, the UI must not:

- label an ordinary `agentRunId` as a governed `runId`;
- identify a run as Travel by inference from task IDs;
- reconstruct dependencies or oracle verdicts in frontend code;
- invent a routing explanation when the API says unavailable;
- claim maximum tool calls are enforced;
- treat calculated remaining budget as a directly observed measurement;
- present `laterDecisionsReferenceProjectedState: true` as proof that usage was the sole cause of a routing placement;
- imply that a shared bearer authenticates the selected human principal;
- expose raw ledger, resource, or unbounded artifact contents;
- claim historical completeness without a governed-run discovery contract.

## 14. Recommended Stage 7E gate

Proceed with UI shell/design work only under these explicit constraints:

- Design every evidence-bearing field with `OBSERVED`, `DECLARED`, `DERIVED`, and `UNAVAILABLE` states.
- Treat the existing GET projection as the canonical read model.
- Do not duplicate workload truth in the frontend.
- Select Flow A or Flow B before implementing navigation.
- For a loopback-only demo, document the development principal assumption; for LAN/multi-user use, resolve identity binding first.
- Treat production oracle verdicts as unavailable until separately persisted authoritative evidence exists.

## Final status

```text
AUDIT STATUS: COMPLETE FROM AVAILABLE SOURCE
REQUIRED HANDOFF STATE: RECONCILED AFTER STAGE 7D.5 DOC INTEGRATION
PRIMARY READ ENDPOINT: READY
FULL TRAVEL UI CONTRACT: PARTIAL (FLOW/ORACLE DEPENDENT)
PRODUCTION WORKLOAD DESCRIPTOR: READY FOR RECOGNIZED RUNS
BROWSER HUMAN IDENTITY WIRING: MISSING
HUMAN PRINCIPAL BINDING: LOCAL-ONLY CONDITIONAL / LAN+ BLOCKER
GOVERNED RUN DISCOVERY: FLOW-DEPENDENT
SOURCE FILES MODIFIED: NONE
REPORT FILE ADDED: docs/STAGE_7E_API_CONTRACT_AUDIT.md
PROVIDER/CONTAINER EXECUTION: NOT RUN
STAGE 7E IMPLEMENTATION: NOT STARTED
```
