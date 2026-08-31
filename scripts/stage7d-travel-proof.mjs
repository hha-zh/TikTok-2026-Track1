#!/usr/bin/env node
/**
 * Stage 7D: exactly one explicitly authorized, isolated real Travel lifecycle.
 * This command is intentionally absent from deterministic validation scripts.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = (file) => path.join(repoRoot, "apps", "server", "dist", file);
// Attempt #1 is immutable historical failure evidence. Every separately
// authorized follow-up proof must write a distinct report.
const reportPath = path.join(repoRoot, "reports", "stage7d-travel-runtime-proof-attempt-4.json");
const port = Number(process.env.TRAVEL_PROOF_PORT ?? 3000);
const callbackOrigin = process.env.TRAVEL_PROOF_CALLBACK_ORIGIN ?? `http://host.docker.internal:${port}`;
const liveRunTokenCap = Number(process.env.TRAVEL_PROOF_RUN_TOKEN_CAP ?? 120_000);
let cleanup = async () => {};

const sanitizedError = (error) => String(error instanceof Error ? error.message : error)
  .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
  .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]")
  .replace(/ARK_API_KEY\s*[:=]\s*\S+/gi, "ARK_API_KEY=[REDACTED]");

async function writeReport(report) {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
}

async function preflight() {
  const problems = [];
  if (!process.env.ARK_API_KEY) problems.push("ARK_API_KEY is not set");
  if (!process.env.ARK_MODEL) problems.push("ARK_MODEL is not set");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execute = promisify(execFile);
  const engine = process.env.CONTAINER_ENGINE ?? "docker";
  const image = process.env.CONTAINER_RUNTIME_IMAGE ?? "volc-agent-runtime:local";
  try { await execute(engine, ["info"], { timeout: 10_000 }); }
  catch { problems.push(`${engine} is not reachable`); }
  try { await execute(engine, ["image", "inspect", image], { timeout: 10_000 }); }
  catch { problems.push(`runtime image ${image} is absent`); }
  return problems;
}

async function main() {
  if (!Number.isSafeInteger(liveRunTokenCap) || liveRunTokenCap <= 0) {
    throw new Error("TRAVEL_PROOF_RUN_TOKEN_CAP must be a positive safe integer");
  }
  const preflightProblems = await preflight();
  if (preflightProblems.length) {
    await writeReport({ contractVersion: "1", proof: "STAGE_7D_TRAVEL", status: "NOT_RUN",
      externalLifecycleExecutions: 0, automaticRetries: 0, preflightProblems });
    throw new Error("real Travel preflight failed: " + preflightProblems.join("; "));
  }

  const { loadConfig, writeCodexConfig } = await import(dist("config.js"));
  const { createProbeState, cleanupProbeState } = await import(dist("phase6/probe-isolation.js"));
  const { JsonStore } = await import(dist("store.js"));
  const { WorkspaceManager } = await import(dist("workspace.js"));
  const { AgentService } = await import(dist("agent-service.js"));
  const { createApp } = await import(dist("app.js"));
  const { createRunner } = await import(dist("runner-factory.js"));
  const { GovernanceLedger } = await import(dist("middleware/evidence/ledger.js"));
  const { RunTokenService } = await import(dist("middleware/governance/run-token.js"));
  const { DelegationService } = await import(dist("middleware/governance/delegation.js"));
  const { HumanRevocationService } = await import(dist("middleware/governance/revocation.js"));
  const { DelegatedAgentLauncher } = await import(dist("middleware/runtime/delegated-agent-launcher.js"));
  const { ExecutionEngine } = await import(dist("middleware/adaptive/execution-engine.js"));
  const { buildGovernedRunView } = await import(dist("middleware/evidence/governed-run-view.js"));
  const { seedTravelFixtures, startTravelRun, TRAVEL_OWNER } = await import(dist("workload/travel-disruption/fixtures.js"));
  const { buildTravelGraph, A_FINAL, T4_IDENTITY, T5_VALIDATE } = await import(dist("workload/travel-disruption/graph.js"));
  const { RESOURCE_PASSPORT, PASSPORT_LEAK_CANARY } = await import(dist("workload/travel-disruption/resources.js"));
  const { TYPE_IDENTITY_VERIFICATION } = await import(dist("workload/travel-disruption/artifacts.js"));
  const { createLiveTravelRuntime, LIVE_TRAVEL_PROVENANCE } = await import(dist("workload/travel-disruption/live-runtime.js"));
  const { travelRunDescriptor } = await import(dist("workload/travel-disruption/evidence.js"));
  const { deriveEarlyRouterTopology, deriveLiveProofStatus, deriveNoRawChildHandoff,
    deriveOraclePassed } = await import(dist("workload/travel-disruption/live-proof-evidence.js"));

  const proofId = randomUUID();
  const runId = `stage7d-${proofId}`;
  const normalDataDirectory = path.resolve(repoRoot, process.env.APP_DATA_DIR ?? ".local/data");
  const normalStorePath = path.join(normalDataDirectory, "launchpad.json");
  const normalBefore = await readFile(normalStorePath).catch(() => null);
  const proofState = await createProbeState(path.join(repoRoot, ".local", "travel-proofs"));
  cleanup = async () => { if (process.env.KEEP_PROBE_STATE !== "1") await cleanupProbeState(proofState); };
  const config = loadConfig({ ...process.env, NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port),
    RUNTIME_PROVIDER: "container", CODEX_SANDBOX_MODE: process.env.CODEX_SANDBOX_MODE ?? "danger-full-access",
    APP_DATA_DIR: proofState.dataDirectory, AGENT_WORKSPACE_ROOT: proofState.workspaceRoot,
    CODEX_HOME: proofState.codexHome, RUNTIME_INSTANCE_ID: `stage7d-${proofId.slice(0, 8)}` });
  await writeCodexConfig(config);
  const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
  const ledger = new GovernanceLedger(store);
  const runTokens = new RunTokenService();
  const agents = new AgentService(config, store, new WorkspaceManager(config.workspaceRoot), createRunner(config));
  await agents.initialize();
  await seedTravelFixtures(store);
  const governed = await startTravelRun(store, ledger, runId);
  // Live provider usage is post-hoc observed telemetry. Attempt #1 observed
  // 28,740 tokens for T0 alone, so the deterministic 12k fixture horizon is
  // not a truthful cap for a seven-task external proof. This changes only the
  // scenario configuration, never accounting or RouterPolicy semantics.
  await store.mutate((database) => {
    const envelope = database.envelopes.find((item) => item.id === governed.envelope.id);
    const runState = database.runStates.find((item) => item.runId === runId);
    if (!envelope || !runState) throw new Error("live Travel budget state missing");
    envelope.maxTokens = liveRunTokenCap;
    runState.maxTokens = liveRunTokenCap;
  });
  let descriptor;
  const app = await createApp(config, agents, { store, runTokens, ledger,
    governedRunDescriptor: (candidate) => candidate === runId ? descriptor : undefined });
  await app.listen({ host: config.host, port: config.port });
  const parentAgent = await agents.createAgent({ name: "Stage 7D Travel root",
    instructions: "Execute only the bounded Travel task and use governed backend callbacks." });
  const parentToken = runTokens.mint({ runId, principalId: governed.principal.id, grantId: governed.envelope.id,
    exp: Math.floor(Date.now() / 1_000) + 15 * 60 });
  const parentIdentity = { kind: "agent", principalId: governed.principal.id, grantId: governed.envelope.id,
    runId, principal: governed.principal };
  const launcher = new DelegatedAgentLauncher({ config, store, ledger, runTokens,
    delegation: new DelegationService({ store, ledger }), agents });
  const live = createLiveTravelRuntime({ store, ledger, agents, launcher, parentAgentId: parentAgent.id,
    parentRunToken: parentToken, callbackOrigin });
  const engine = new ExecutionEngine({ store, ledger, executor: live.executor, delegation: live.delegation,
    policy: { parallelCapacity: 2 } });
  let result;
  let failure = null;
  let parentReadStatus = null;
  let parentReceivedBoundedArtifact = false;
  try {
    result = await engine.run(buildTravelGraph(), { principal: governed.principal,
      grantId: governed.envelope.id, runId });
    const identityChild = live.children.find((item) => item.taskId === T4_IDENTITY);
    const identityArtifact = identityChild ? store.snapshot().artifacts.find((item) =>
      item.ownerPrincipalId === identityChild.childPrincipalId && item.type === TYPE_IDENTITY_VERIFICATION && item.published) : undefined;
    if (identityArtifact) {
      const response = await app.inject({ method: "GET", url: `/api/artifacts/${identityArtifact.id}`,
        headers: { authorization: `Bearer ${parentToken}` } });
      parentReadStatus = response.statusCode;
      const returned = response.statusCode === 200 ? response.json() : null;
      parentReceivedBoundedArtifact = returned?.type === TYPE_IDENTITY_VERIFICATION
        && Object.keys(returned.fields ?? {}).length === 4;
    }
  } catch (error) {
    failure = sanitizedError(error);
  } finally {
    await agents.drainActiveExecutions().catch(() => undefined);
    const revocations = new HumanRevocationService(store, ledger);
    const human = { kind: "human", principalId: TRAVEL_OWNER, principal: { id: TRAVEL_OWNER, kind: "human" } };
    for (const child of live.children) await revocations.revoke(human, child.grantId).catch(() => undefined);
  }

  const snapshot = store.snapshot();
  const events = snapshot.governanceEvents.filter((event) => event.runId === runId);
  const rootDenial = events.find((event) => event.kind === "resource_denied"
    && event.principalId === governed.principal.id && event.payload.resourceId === RESOURCE_PASSPORT);
  const identityChild = live.children.find((item) => item.taskId === T4_IDENTITY);
  const childEnvelope = identityChild ? snapshot.envelopes.find((item) => item.id === identityChild.grantId) : undefined;
  const identityAllowed = events.some((event) => event.kind === "resource_allowed"
    && event.principalId === identityChild?.childPrincipalId && event.payload.resourceId === RESOURCE_PASSPORT);
  const identityArtifact = identityChild ? snapshot.artifacts.find((item) =>
    item.ownerPrincipalId === identityChild.childPrincipalId && item.type === TYPE_IDENTITY_VERIFICATION) : undefined;
  const identityContext = events.find((event) => event.kind === "context_projected"
    && event.payload.taskId === T4_IDENTITY);
  const final = result?.artifacts.find((item) => item.id === A_FINAL)?.value;
  const topology = events.filter((event) => event.kind === "routing_decision").map((event) => ({
    taskId: event.payload.taskId, who: event.payload.placement, how: event.payload.shape, sequence: event.seq,
  }));
  const domain = {
    cancelledItineraryNotSelected: final?.transport_option_id !== "SQ638",
    arrivesBeforeDeadline: Boolean(final?.final_arrival && Date.parse(final.final_arrival) <= Date.parse("2026-09-02T13:00:00+09:00")),
    spendWithinLimit: typeof final?.total_additional_spend_sgd === "number" && final.total_additional_spend_sgd <= 700,
    approvalRequired: final?.approval_required === "yes",
  };
  const governanceEvidence = {
    exactRootDenial: rootDenial?.payload.reason === "NOT_EXERCISABLE_DELEGATE_ONLY",
    legalIdentityDelegation: Boolean(identityChild),
    childrenAttenuated: Boolean(childEnvelope && childEnvelope.depth === 0 && childEnvelope.maxChildren === 0),
    identityPassportReadObserved: identityAllowed,
    identityContextMinimal: JSON.stringify(identityContext?.payload.includedArtifactIds) === JSON.stringify(["travel_constraints", "route_plan"]),
    returnGateUsed: Boolean(identityArtifact?.published && parentReceivedBoundedArtifact),
  };
  const adaptiveEvidence = {
    realCandidateSnapshot: events.some((event) => event.kind === "routing_decision"),
    actualUsageProjected: snapshot.runStates.find((item) => item.runId === runId)?.tokensUsed ===
      live.usage.reduce((sum, item) => sum + (item.totalTokens ?? 0), 0),
    freshStateChangesWho: events.some((event) => event.kind === "routing_decision" && event.payload.taskId === T5_VALIDATE),
  };
  const lifecycle = {
    requiredTasksComplete: result?.outcome === "COMPLETED" && result.progress.completed.size === 7,
    boundedArtifactsCommitted: Boolean(final),
    childrenTerminal: live.children.every((child) => snapshot.grantStates.find((state) => state.grantId === child.grantId)?.revoked),
    evidenceCorrelated: events.some((event) => event.kind === "run_outcome"),
  };
  // Build a fail-closed preview solely to inspect the parent-visible read model.
  // The final oracle is derived afterwards, so it cannot prove its own output-safety claim.
  const previewGovernance = { ...governanceEvidence,
    noRawChildHandoff: deriveNoRawChildHandoff(false, null) };
  const previewAdaptive = { ...adaptiveEvidence, earlyRouterTopology: deriveEarlyRouterTopology(topology) };
  const previewOracle = { domain, governance: previewGovernance, adaptive: previewAdaptive, lifecycle,
    passed: deriveOraclePassed([domain, previewGovernance, previewAdaptive, lifecycle]) };
  const previewDescriptor = travelRunDescriptor(previewOracle);
  previewDescriptor.executionProvenance = LIVE_TRAVEL_PROVENANCE;
  const previewView = buildGovernedRunView(store, runId, previewDescriptor);
  const flowCollections = { agents: snapshot.agents, messages: snapshot.messages, runs: snapshot.runs,
    artifacts: snapshot.artifacts, events, view: previewView };
  const flowText = JSON.stringify(flowCollections);
  const secretAudit = {
    protectedCanaryAbsentFromFlow: !flowText.includes(PASSPORT_LEAK_CANARY),
    protectedResourceLeakAbsent: !flowText.includes(PASSPORT_LEAK_CANARY),
    runTokenAbsent: !flowText.includes(parentToken),
    authorizationCredentialAbsent: !/Bearer\s+[A-Za-z0-9._~-]{16,}/i.test(flowText),
    rawChildOutputAbsentFromParentView: !JSON.stringify(previewView).includes("assistant"),
  };
  const governance = { ...governanceEvidence,
    noRawChildHandoff: deriveNoRawChildHandoff(secretAudit.rawChildOutputAbsentFromParentView,
      identityArtifact ? { published: identityArtifact.published, parentReadStatus, parentReceivedBoundedArtifact } : null) };
  const adaptive = { ...adaptiveEvidence, earlyRouterTopology: deriveEarlyRouterTopology(topology) };
  const oracle = { domain, governance, adaptive, lifecycle,
    passed: deriveOraclePassed([domain, governance, adaptive, lifecycle]) };
  descriptor = travelRunDescriptor(oracle);
  descriptor.executionProvenance = LIVE_TRAVEL_PROVENANCE;
  const view = buildGovernedRunView(store, runId, descriptor);
  const viewResponse = await app.inject({ method: "GET", url: `/api/governance/runs/${runId}`,
    headers: { "x-principal-id": TRAVEL_OWNER,
      ...(config.authToken ? { authorization: `Bearer ${config.authToken}` } : {}) } });
  const viewJson = viewResponse.statusCode === 200 ? viewResponse.json() : null;
  await app.close();
  const normalAfter = await readFile(normalStorePath).catch(() => null);
  const normalStateUnchanged = Buffer.compare(normalBefore ?? Buffer.alloc(0), normalAfter ?? Buffer.alloc(0)) === 0;
  const claims = {
    realContainerAndModelRunsCompleted: snapshot.runs.length === 7 && snapshot.runs.every((run) => run.status === "completed"),
    normalTravelResourcesAllowed: events.some((event) => event.kind === "resource_allowed" && event.principalId === governed.principal.id),
    exactRootPassportDenial: governance.exactRootDenial,
    realGovernedIdentityChild: Boolean(identityChild && identityAllowed && childEnvelope),
    leastContext: governance.identityContextMinimal,
    returnGate: governance.returnGateUsed,
    governedRunView: Boolean(view && viewResponse.statusCode === 200),
    terminalOutcome: lifecycle.requiredTasksComplete,
    liveBudgetRespected: (snapshot.runStates.find((item) => item.runId === runId)?.tokensUsed ?? 0) <= liveRunTokenCap,
    normalStateUnchanged,
    secretAudit: Object.values(secretAudit).every(Boolean),
  };
  const status = deriveLiveProofStatus(failure, oracle.passed, claims);
  const report = {
    contractVersion: "1", proof: "STAGE_7D_TRAVEL", proofId, runId,
    executionProvenance: LIVE_TRAVEL_PROVENANCE, status,
    externalLifecycleExecutions: 1, modelRunsAttempted: snapshot.runs.length, automaticRetries: 0,
    runtime: { provider: config.runtimeProvider, containerStatus: claims.realContainerAndModelRunsCompleted ? "PROVEN" : "FAILED",
      providerStatus: claims.realContainerAndModelRunsCompleted ? "PROVEN" : "FAILED" },
    resourceEvidence: {
      allowedResourceIds: events.filter((event) => event.kind === "resource_allowed").map((event) => event.payload.resourceId),
      passportDenial: rootDenial ? { resourceId: rootDenial.payload.resourceId, verdict: "DENY", reasonCode: rootDenial.payload.reason, httpEquivalent: 403 } : null,
      identityChildPassportRead: identityAllowed,
    },
    delegation: identityChild && childEnvelope ? { taskId: identityChild.taskId,
      parentPrincipalId: governed.principal.id, childPrincipalId: identityChild.childPrincipalId,
      parentGrantId: governed.envelope.id, childGrantId: identityChild.grantId,
      attenuation: { resources: childEnvelope.exercisable.resources, actions: childEnvelope.exercisable.actions,
        depth: childEnvelope.depth, maxChildren: childEnvelope.maxChildren },
      lifecycle: snapshot.grantStates.find((state) => state.grantId === identityChild.grantId)?.revoked ? "REVOKED" : "ACTIVE" } : null,
    context: identityContext ? { taskId: T4_IDENTITY,
      includedArtifactIds: identityContext.payload.includedArtifactIds,
      withheldArtifactIds: identityContext.payload.withheldArtifactIds } : null,
    returnGate: identityArtifact ? { artifactType: identityArtifact.type, created: true,
      published: identityArtifact.published, recipients: identityArtifact.recipients,
      boundedFields: identityArtifact.fields, parentReadStatus, parentReceivedBoundedArtifact } : null,
    usage: { availabilityByTask: live.usage, projectedRunTokensUsed: snapshot.runStates.find((item) => item.runId === runId)?.tokensUsed ?? 0 },
    configuredLiveRunTokenCap: liveRunTokenCap,
    topology,
    terminal: { engineOutcome: result?.outcome ?? "FAILED", completedTasks: result?.progress.completed.size ?? 0,
      failure: failure ?? result?.failures?.[0]?.reason ?? null },
    governedRunView: { statusCode: viewResponse.statusCode, represented: claims.governedRunView },
    isolation: { proofStateRoot: path.relative(repoRoot, proofState.root), normalApplicationStateUnchanged: normalStateUnchanged },
    oracle, secretAudit, claims,
  };
  await writeReport(report);
  if (process.env.KEEP_PROBE_STATE === "1") console.log(`[travel-proof] isolated state preserved at ${proofState.root}`);
  else await cleanup();
  cleanup = async () => {};
  for (const [claim, held] of Object.entries(claims)) console.log(`[travel-proof] ${held ? "PASS" : "FAIL"} ${claim}`);
  console.log(`[travel-proof] real Travel lifecycle: ${status}`);
  if (status !== "PROVEN") process.exitCode = 1;
}

main().catch(async (error) => {
  await cleanup().catch(() => undefined);
  console.error("[travel-proof] " + sanitizedError(error));
  process.exitCode = 1;
});
