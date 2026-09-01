import { randomUUID } from "node:crypto";
import {
  ExecutionEngine,
  type TaskExecutionRequest,
  type TaskExecutor,
} from "../../middleware/adaptive/execution-engine.js";
import type { GovernanceLedger } from "../../middleware/evidence/ledger.js";
import type { AgentService } from "../../agent-service.js";
import type { AppConfig } from "../../config.js";
import { RunTokenService } from "../../middleware/governance/run-token.js";
import { DelegationService } from "../../middleware/governance/delegation.js";
import { DelegatedAgentLauncher } from "../../middleware/runtime/delegated-agent-launcher.js";
import { HumanRevocationService } from "../../middleware/governance/revocation.js";
import type { JsonStore } from "../../store.js";
import { TravelDelegationPort, TravelFixtureExecutor } from "./adapter.js";
import { seedTravelFixtures, startTravelRun, TRAVEL_OWNER } from "./fixtures.js";
import { buildTravelGraph, TRAVEL_ROUTING_INPUTS } from "./graph.js";
import { A_FINAL } from "./graph.js";
import { createLiveTravelRuntime } from "./live-runtime.js";
import { TYPE_FINAL_RECOVERY, type FinalTravelRecoveryPlan } from "./artifacts.js";

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export interface TravelDemoRun {
  runId: string;
  principalId: typeof TRAVEL_OWNER;
  completion: Promise<FinalTravelRecoveryPlan>;
}

function finalResultFromExecution(result: Awaited<ReturnType<ExecutionEngine["run"]>>): FinalTravelRecoveryPlan {
  if (result.outcome !== "COMPLETED") throw new Error(`Governed Travel run ended ${result.outcome}`);
  const artifact = result.artifacts.find((item) => item.id === A_FINAL);
  if (!artifact || artifact.origin !== "own_task_output") throw new Error("Validated governed final result unavailable");
  return structuredClone(artifact.value) as FinalTravelRecoveryPlan;
}

async function persistFinalResult(store: JsonStore, runId: string, fields: FinalTravelRecoveryPlan) {
  await store.mutate((database) => {
    const runState = database.runStates.find((item) => item.runId === runId);
    if (!runState) throw new Error("Governed Travel RunState unavailable");
    runState.finalResult = { type: TYPE_FINAL_RECOVERY, quality: "OBSERVED",
      boundedFields: structuredClone({ ...fields }) };
  });
}

export function formatFinalTravelRecoveryPlan(fields: FinalTravelRecoveryPlan): string {
  const arrival = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(fields.final_arrival));
  const approval = fields.approval_required === "yes" ? "Yes" : "No";
  const closing = fields.approval_required === "yes"
    ? "The governed plan is ready for your approval. No booking has been made."
    : "The governed plan is ready. No booking has been made.";
  return `### Recovery plan ready${fields.approval_required === "yes" ? " for approval" : ""}\n\n`
    + `- **Transport option:** ${fields.transport_option_id}\n`
    + `- **Accommodation option:** ${fields.accommodation_option_id}\n`
    + `- **Arrival route:** ${fields.route_option_id}\n`
    + `- **Expected arrival:** ${arrival} JST\n`
    + `- **Additional spend:** SGD ${fields.total_additional_spend_sgd.toLocaleString("en-US")}\n`
    + `- **Approval required:** ${approval}\n\n${closing}`;
}

export interface RealTravelDemoDependencies {
  config: AppConfig;
  store: JsonStore;
  ledger: GovernanceLedger;
  runTokens: RunTokenService;
  agents: AgentService;
  runId?: string;
}

/** Reuses the Stage 7D container/Codex/Ark executor without changing policy. */
export async function startRealTravelDemoRun(
  dependencies: RealTravelDemoDependencies,
): Promise<TravelDemoRun> {
  const { config, store, ledger, runTokens, agents } = dependencies;
  await seedTravelFixtures(store);
  const runId = dependencies.runId ?? `travel-real-${randomUUID()}`;
  const governed = await startTravelRun(store, ledger, runId);
  const liveTokenCap = 120_000;
  await store.mutate((database) => {
    const envelope = database.envelopes.find((item) => item.id === governed.envelope.id);
    const runState = database.runStates.find((item) => item.runId === runId);
    if (!envelope || !runState) throw new Error("real Travel budget state missing");
    envelope.maxTokens = liveTokenCap;
    runState.maxTokens = liveTokenCap;
  });
  const parentAgent = await agents.createAgent({
    name: "Live Travel root",
    instructions: "Execute only bounded governed Travel tasks and use backend callbacks.",
    origin: "governed-runtime",
  });
  const parentToken = runTokens.mint({
    runId,
    principalId: governed.principal.id,
    grantId: governed.envelope.id,
    exp: Math.floor(Date.now() / 1_000) + 15 * 60,
  });
  const launcher = new DelegatedAgentLauncher({
    config,
    store,
    ledger,
    runTokens,
    delegation: new DelegationService({ store, ledger }),
    agents,
  });
  const live = createLiveTravelRuntime({
    store,
    ledger,
    agents,
    launcher,
    parentAgentId: parentAgent.id,
    parentRunToken: parentToken,
    callbackOrigin: `http://host.docker.internal:${config.port}`,
  });
  const engine = new ExecutionEngine({
    store,
    ledger,
    executor: live.executor,
    delegation: live.delegation,
    policy: { parallelCapacity: TRAVEL_ROUTING_INPUTS.parallelCapacity },
  });
  const completion = (async () => {
    try {
      const result = await engine.run(buildTravelGraph(), {
        principal: governed.principal,
        grantId: governed.envelope.id,
        runId,
      });
      const finalResult = finalResultFromExecution(result);
      await persistFinalResult(store, runId, finalResult);
      return finalResult;
    } finally {
      await agents.drainActiveExecutions().catch(() => undefined);
      const revocations = new HumanRevocationService(store, ledger);
      const human = { kind: "human" as const, principalId: TRAVEL_OWNER,
        principal: { id: TRAVEL_OWNER, kind: "human" as const } };
      for (const child of live.children) {
        await revocations.revoke(human, child.grantId).catch(() => undefined);
      }
    }
  })();
  return { runId, principalId: TRAVEL_OWNER, completion };
}

/**
 * Starts the deterministic reference workload against the caller's store.
 * Pacing wraps dispatch only; all decisions, accounting and evidence continue
 * to come from the existing ExecutionEngine and Travel fixture adapters.
 */
export async function startTravelDemoRun(
  store: JsonStore,
  ledger: GovernanceLedger,
  pacingMs = 900,
  requestedRunId?: string,
): Promise<TravelDemoRun> {
  await seedTravelFixtures(store);
  const runId = requestedRunId ?? `travel-demo-${randomUUID()}`;
  const governed = await startTravelRun(store, ledger, runId);
  const delegation = new TravelDelegationPort(store, ledger);
  const fixtureExecutor = new TravelFixtureExecutor(store, ledger);
  const executor: TaskExecutor = {
    async execute(request: TaskExecutionRequest) {
      if (pacingMs > 0) await wait(pacingMs);
      return fixtureExecutor.execute(request);
    },
  };
  const engine = new ExecutionEngine({
    store,
    ledger,
    executor,
    delegation,
    policy: { parallelCapacity: TRAVEL_ROUTING_INPUTS.parallelCapacity },
  });

  const completion = (async () => {
    try {
      const result = await engine.run(buildTravelGraph(), {
        principal: governed.principal,
        grantId: governed.envelope.id,
        runId,
      });
      const finalResult = finalResultFromExecution(result);
      await persistFinalResult(store, runId, finalResult);
      return finalResult;
    } finally {
      const revocations = new HumanRevocationService(store, ledger);
      const human = {
        kind: "human" as const,
        principalId: TRAVEL_OWNER,
        principal: { id: TRAVEL_OWNER, kind: "human" as const },
      };
      for (const record of delegation.records) {
        await revocations.revoke(human, record.grantId);
      }
    }
  })();

  return { runId, principalId: TRAVEL_OWNER, completion };
}
