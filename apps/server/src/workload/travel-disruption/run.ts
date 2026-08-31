import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ExecutionEngine, type EngineResult } from "../../middleware/adaptive/execution-engine.js";
import { GovernanceLedger } from "../../middleware/evidence/ledger.js";
import { HumanRevocationService } from "../../middleware/governance/revocation.js";
import { JsonStore } from "../../store.js";
import { TravelDelegationPort, TravelFixtureExecutor } from "./adapter.js";
import { seedTravelFixtures, startTravelRun, TRAVEL_OWNER } from "./fixtures.js";
import { buildTravelGraph, TRAVEL_ROUTING_INPUTS } from "./graph.js";
import { evaluateTravelOracle, type TravelOracle } from "./oracle.js";
import { buildGovernedRunView, type GovernedRunView } from "../../middleware/evidence/governed-run-view.js";
import { travelRunDescriptor } from "./evidence.js";

export interface TravelLifecycleResult {
  engine: EngineResult;
  executor: TravelFixtureExecutor;
  delegation: TravelDelegationPort;
  store: JsonStore;
  runId: string;
  rootPrincipalId: string;
  rootGrantId: string;
  revokedGrantIds: string[];
  checks: Record<string, boolean>;
  oracle: TravelOracle;
  view: GovernedRunView;
  cleanup(): Promise<void>;
}

export async function runTravelLifecycle(runId = "travel-run-1"): Promise<TravelLifecycleResult> {
  const directory = await mkdtemp(path.join(tmpdir(), "travel-lifecycle-"));
  const store = new JsonStore(path.join(directory, "db.json"));
  await store.initialize();
  await seedTravelFixtures(store);
  const ledger = new GovernanceLedger(store, () => "2026-09-01T00:00:00.000Z");
  const governed = await startTravelRun(store, ledger, runId);
  const delegation = new TravelDelegationPort(store, ledger);
  const executor = new TravelFixtureExecutor(store, ledger);
  const engine = new ExecutionEngine({
    store, ledger, executor, delegation,
    policy: { parallelCapacity: TRAVEL_ROUTING_INPUTS.parallelCapacity },
    now: () => "2026-09-01T00:00:00.000Z",
  });
  const result = await engine.run(buildTravelGraph(), {
    principal: governed.principal, grantId: governed.envelope.id, runId,
  });

  const revocation = new HumanRevocationService(store, ledger);
  const human = { kind: "human" as const, principalId: TRAVEL_OWNER,
    principal: { id: TRAVEL_OWNER, kind: "human" as const } };
  const revokedGrantIds: string[] = [];
  for (const record of delegation.records) {
    const revoked = await revocation.revoke(human, record.grantId);
    if (revoked.ok && revoked.revoked) revokedGrantIds.push(record.grantId);
  }

  const snapshot = store.snapshot();
  const lifecycle = {
    engine: result, executor, delegation, store, runId,
    rootPrincipalId: governed.principal.id, rootGrantId: governed.envelope.id,
    revokedGrantIds, checks: {}, oracle: undefined as unknown as TravelOracle,
    view: undefined as unknown as GovernedRunView,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  } satisfies TravelLifecycleResult;
  lifecycle.oracle = evaluateTravelOracle(lifecycle);
  lifecycle.checks = Object.fromEntries(Object.entries(lifecycle.oracle)
    .filter(([key]) => key !== "passed")
    .flatMap(([, group]) => Object.entries(group as Record<string, boolean>)));
  const view = buildGovernedRunView(store, runId, travelRunDescriptor(lifecycle.oracle));
  if (!view) throw new Error("governed Travel run view unavailable");
  lifecycle.view = view;
  return lifecycle;
}

export const travelLifecyclePassed = (result: TravelLifecycleResult) =>
  result.oracle.passed;
