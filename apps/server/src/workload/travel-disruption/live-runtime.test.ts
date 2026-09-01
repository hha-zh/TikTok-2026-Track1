import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "../../agent-service.js";
import { loadConfig } from "../../config.js";
import { ExecutionEngine } from "../../middleware/adaptive/execution-engine.js";
import { GovernanceLedger } from "../../middleware/evidence/ledger.js";
import { createArtifact, publishArtifact } from "../../middleware/governance/artifacts.js";
import { DelegationService } from "../../middleware/governance/delegation.js";
import { readManagedResource } from "../../middleware/governance/gates.js";
import { RunTokenService } from "../../middleware/governance/run-token.js";
import { DelegatedAgentLauncher } from "../../middleware/runtime/delegated-agent-launcher.js";
import { JsonStore } from "../../store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../../types.js";
import { WorkspaceManager } from "../../workspace.js";
import { TYPE_ACCOMMODATION_OPTIONS, TYPE_IDENTITY_VERIFICATION, TYPE_TRANSPORT_OPTIONS, TYPE_VALIDATED_RECOVERY } from "./artifacts.js";
import { seedTravelFixtures, startTravelRun } from "./fixtures.js";
import { A_FINAL, buildTravelGraph, T0_UNDERSTAND, T1_TRANSPORT, T2_ACCOMMODATION, T3_ROUTE, T4_IDENTITY, T5_VALIDATE, T6_FINAL } from "./graph.js";
import { createLiveTravelRuntime, liveTaskUsage, parseLiveTravelResult, travelTaskIdFromPrompt } from "./live-runtime.js";
import { RESOURCE_CALENDAR, RESOURCE_ITINERARY, RESOURCE_PASSPORT, RESOURCE_PREFERENCES, RESOURCE_ROUTES } from "./resources.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const output: Record<string, Record<string, unknown>> = {
  [T0_UNDERSTAND]: { origin: "SIN", destination: "TOKYO", latest_arrival: "2026-09-02T13:00:00+09:00", max_additional_spend_sgd: 700, approval_threshold_sgd: 300 },
  [T3_ROUTE]: { route_option_id: "RT-HND-01", transport_option_id: "TR-ALT-02", booking_name_key: "TRAVELER_A", from_airport: "HND", arrival: "2026-09-02T11:00:00+09:00", price_sgd: 50, reliability: "high" },
  [T5_VALIDATE]: { transport_option_id: "TR-ALT-02", accommodation_option_id: "HT-03", route_option_id: "RT-HND-01", arrival_before_deadline: "yes", total_additional_spend_sgd: 620, approval_required: "yes", confidence: "high" },
  [T6_FINAL]: { transport_option_id: "TR-ALT-02", accommodation_option_id: "HT-03", route_option_id: "RT-HND-01", final_arrival: "2026-09-02T11:00:00+09:00", total_additional_spend_sgd: 620, approval_required: "yes", status: "ready_for_approval" },
};

const publications: Record<string, { type: string; fields: Record<string, unknown> }> = {
  [T1_TRANSPORT]: { type: TYPE_TRANSPORT_OPTIONS, fields: { recommended_option_id: "TR-ALT-02", booking_name_key: "TRAVELER_A", departure: "2026-09-02T01:20:00+08:00", arrival: "2026-09-02T09:30:00+09:00", arrival_airport: "HND", price_sgd: 420, reliability: "high" } },
  [T2_ACCOMMODATION]: { type: TYPE_ACCOMMODATION_OPTIONS, fields: { recommended_option_id: "HT-03", check_in: "2026-09-01T18:00:00+08:00", location: "SIN_AIRPORT", price_sgd: 150, availability: "available" } },
  [T4_IDENTITY]: { type: TYPE_IDENTITY_VERIFICATION, fields: { identity_verified: "yes", booking_name_matched: "yes", travel_document_valid: "yes", destination_eligible: "yes" } },
  [T5_VALIDATE]: { type: TYPE_VALIDATED_RECOVERY, fields: output[T5_VALIDATE]! },
};

class StubLiveRunner implements AgentRunner {
  readonly requests: RunnerRequest[] = [];
  constructor(private readonly store: JsonStore, private readonly ledger: GovernanceLedger,
    private readonly tokens: RunTokenService,
    private readonly options: { identityPublication?: "valid" | "invalid" | "absent" } = {}) {}
  async isAvailable() { return true; }
  async cancel() { return false; }
  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.requests.push(structuredClone(request));
    const taskId = travelTaskIdFromPrompt(request.prompt);
    const claims = this.tokens.verify(request.runtimeRunToken!);
    const principal = this.store.snapshot().principals.find((item) => item.id === claims.principalId)!;
    const identity = { kind: "agent" as const, principalId: claims.principalId, grantId: claims.grantId,
      runId: claims.runId, principal };
    const dependencies = { store: this.store, ledger: this.ledger };
    if (taskId === T0_UNDERSTAND) {
      for (const id of [RESOURCE_ITINERARY, RESOURCE_CALENDAR, RESOURCE_PREFERENCES]) await readManagedResource(identity, id, dependencies);
      await readManagedResource(identity, RESOURCE_PASSPORT, dependencies);
    }
    if (taskId === T3_ROUTE) await readManagedResource(identity, RESOURCE_ROUTES, dependencies);
    const publication = taskId === T4_IDENTITY && this.options.identityPublication === "absent"
      ? undefined
      : taskId === T4_IDENTITY && this.options.identityPublication === "invalid"
        ? { ...publications[T4_IDENTITY]!, fields: { ...publications[T4_IDENTITY]!.fields, identity_verified: "no" } }
        : publications[taskId];
    if (publication && principal.parentPrincipalId) {
      const created = await createArtifact(identity, { artifactType: publication.type, fields: publication.fields }, dependencies);
      if (created.ok) await publishArtifact(identity, created.value.id, { artifactType: publication.type, fields: publication.fields }, dependencies);
    }
    const value = JSON.stringify(output[taskId] ?? { completed: true });
    return { output: output[taskId] ? `TRAVEL_RESULT_BEGIN\n${value}\nTRAVEL_RESULT_END` : value, threadId: `thread-${request.agentId}`,
      usage: { inputTokens: 1_500, cachedInputTokens: 100, outputTokens: 20 } };
  }
}

async function harness(options: {
  identityPublication?: "valid" | "invalid" | "absent";
  managedResourceRead?: typeof readManagedResource;
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "travel-live-stub-"));
  roots.push(root);
  const config = loadConfig({ NODE_ENV: "test", RUNTIME_PROVIDER: "container", ARK_API_KEY: "stub-key",
    ARK_MODEL: "stub-model", APP_DATA_DIR: path.join(root, "data"), AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"), CODEX_HOME: path.join(root, "codex-home") });
  const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
  const ledger = new GovernanceLedger(store);
  const tokens = new RunTokenService(Buffer.alloc(32, 23));
  const runner = new StubLiveRunner(store, ledger, tokens, options);
  const agents = new AgentService(config, store, new WorkspaceManager(config.workspaceRoot), runner);
  await agents.initialize();
  await seedTravelFixtures(store);
  const governed = await startTravelRun(store, ledger, "travel-live-stub-run");
  const parent = await agents.createAgent({ name: "Travel root" });
  const parentToken = tokens.mint({ runId: governed.envelope.runId, principalId: governed.principal.id,
    grantId: governed.envelope.id, exp: 4_102_444_800 });
  const launcher = new DelegatedAgentLauncher({ config, store, ledger, runTokens: tokens,
    delegation: new DelegationService({ store, ledger }), agents });
  const live = createLiveTravelRuntime({ store, ledger, agents, launcher, parentAgentId: parent.id,
    parentRunToken: parentToken, callbackOrigin: "http://host.docker.internal:3000",
    ...(options.managedResourceRead ? { managedResourceRead: options.managedResourceRead } : {}) });
  const engine = new ExecutionEngine({ store, ledger, executor: live.executor, delegation: live.delegation,
    policy: { parallelCapacity: 2 } });
  const result = await engine.run(buildTravelGraph(), { principal: governed.principal,
    grantId: governed.envelope.id, runId: governed.envelope.runId });
  return { store, runner, live, result, governed };
}

describe("Travel live runtime adapter with an injected stub runner", () => {
  it("accepts one exact delimited object and validates the existing artifact schema", async () => {
    const { store } = await harness();
    const json = JSON.stringify(output[T0_UNDERSTAND]);
    expect(parseLiveTravelResult(T0_UNDERSTAND, `TRAVEL_RESULT_BEGIN\n${json}\nTRAVEL_RESULT_END`, store))
      .toEqual({ ok: true, value: output[T0_UNDERSTAND] });
  });

  it("allows bounded prose only before the clearly delimited final result", async () => {
    const { store } = await harness();
    const json = JSON.stringify(output[T0_UNDERSTAND]);
    expect(parseLiveTravelResult(T0_UNDERSTAND, `Expected denial observed.\nTRAVEL_RESULT_BEGIN\n${json}\nTRAVEL_RESULT_END`, store).ok).toBe(true);
  });

  it("fails closed on missing delimiters, malformed JSON, and ambiguous results", async () => {
    const { store } = await harness();
    const json = JSON.stringify(output[T0_UNDERSTAND]);
    expect(parseLiveTravelResult(T0_UNDERSTAND, json, store)).toEqual({ ok: false, error: "RESULT_DELIMITER_MISSING" });
    expect(parseLiveTravelResult(T0_UNDERSTAND, "TRAVEL_RESULT_BEGIN\n{bad}\nTRAVEL_RESULT_END", store)).toEqual({ ok: false, error: "MALFORMED_JSON" });
    expect(parseLiveTravelResult(T0_UNDERSTAND, `TRAVEL_RESULT_BEGIN\n${json}\nTRAVEL_RESULT_END trailing`, store)).toEqual({ ok: false, error: "RESULT_DELIMITER_AMBIGUOUS" });
  });

  it("rejects missing, extra, wrong-typed, and oversized fields", async () => {
    const { store } = await harness();
    const wrap = (value: unknown) => `TRAVEL_RESULT_BEGIN\n${JSON.stringify(value)}\nTRAVEL_RESULT_END`;
    expect(parseLiveTravelResult(T0_UNDERSTAND, wrap({ origin: "SIN" }), store)).toEqual({ ok: false, error: "SCHEMA_VIOLATION" });
    expect(parseLiveTravelResult(T0_UNDERSTAND, wrap({ ...output[T0_UNDERSTAND], extra: "no" }), store)).toEqual({ ok: false, error: "SCHEMA_VIOLATION" });
    expect(parseLiveTravelResult(T0_UNDERSTAND, wrap({ ...output[T0_UNDERSTAND], max_additional_spend_sgd: "700" }), store)).toEqual({ ok: false, error: "SCHEMA_VIOLATION" });
    expect(parseLiveTravelResult(T0_UNDERSTAND, `TRAVEL_RESULT_BEGIN\n${"x".repeat(5_000)}\nTRAVEL_RESULT_END`, store)).toEqual({ ok: false, error: "OUTPUT_TOO_LARGE" });
  });

  it("marks missing provider usage unavailable without fabricating tokens", () => {
    expect(liveTaskUsage(undefined)).toEqual({ availability: "UNAVAILABLE",
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0 } });
  });

  it("preserves the approved graph and completes through AgentService", async () => {
    const { result, runner } = await harness();
    expect(result.outcome).toBe("COMPLETED");
    expect(result.artifacts.find((item) => item.id === A_FINAL)).toBeDefined();
    expect(runner.requests).toHaveLength(7);
  });

  it("uses real backend resource decisions for normal reads and root denial", async () => {
    const { store, governed } = await harness();
    const events = store.snapshot().governanceEvents;
    expect(events.filter((event) => event.kind === "resource_allowed" && event.principalId === governed.principal.id).length).toBeGreaterThanOrEqual(4);
    expect(events).toContainEqual(expect.objectContaining({ kind: "resource_denied", principalId: governed.principal.id,
      payload: { resourceId: RESOURCE_PASSPORT, action: "read", reason: "NOT_EXERCISABLE_DELEGATE_ONLY" } }));
  });

  it("prepares governed children and admits only published contracted artifacts", async () => {
    const { live, result, store } = await harness();
    expect(live.children.map((item) => item.taskId)).toEqual([T1_TRANSPORT, T2_ACCOMMODATION, T4_IDENTITY]);
    expect(live.children.every((item) => item.dispatched)).toBe(true);
    expect(result.artifacts.filter((item) => item.origin === "published_finding")).toHaveLength(3);
    expect(store.snapshot().artifacts.every((item) => item.published)).toBe(true);
  });

  it("makes the Identity Specialist managed passport read structural", async () => {
    const { live, result, store } = await harness();
    expect(result.outcome).toBe("COMPLETED");
    const child = live.children.find((item) => item.taskId === T4_IDENTITY)!;
    expect(store.snapshot().governanceEvents).toContainEqual(expect.objectContaining({
      kind: "resource_allowed", principalId: child.childPrincipalId, grantId: child.grantId,
      payload: { resourceId: RESOURCE_PASSPORT, action: "read" },
    }));
  });

  it("rejects a direct protected-value read that produces no Resource Gate evidence", async () => {
    const directRead: typeof readManagedResource = async (identity, _resourceId, dependencies) => {
      const publication = publications[T4_IDENTITY]!;
      const created = await createArtifact(identity,
        { artifactType: publication.type, fields: publication.fields }, dependencies);
      if (created.ok) await publishArtifact(identity, created.value.id,
        { artifactType: publication.type, fields: publication.fields }, dependencies);
      return { ok: true as const, value: {
        documentIdentifier: "not-evidence", bookingNameKey: "TRAVELER_A",
        validThrough: "2028-05-01", destinationEligibility: ["JP"],
      } };
    };
    const { result, runner, store, live } = await harness({ managedResourceRead: directRead });
    expect(result.outcome).toBe("EXECUTION_FAILED");
    expect(result.failures[0]?.reason).toContain("managed-backend read evidence absent");
    expect(live.children.some((item) => item.taskId === T4_IDENTITY)).toBe(true);
    expect(store.snapshot().artifacts.some((artifact) => artifact.type === TYPE_IDENTITY_VERIFICATION
      && artifact.published)).toBe(true);
    expect(runner.requests.some((item) => travelTaskIdFromPrompt(item.prompt) === T4_IDENTITY)).toBe(false);
    expect(store.snapshot().governanceEvents.some((event) => event.kind === "resource_allowed"
      && (event.payload as { resourceId?: string }).resourceId === RESOURCE_PASSPORT)).toBe(false);
  });

  it("fails T4 before model dispatch when the required child read is denied", async () => {
    const denied = async () => ({ ok: false as const, statusCode: 403 as const, reason: "BUDGET_EXCEEDED" as const });
    const { result, runner } = await harness({ managedResourceRead: denied });
    expect(result.outcome).toBe("EXECUTION_FAILED");
    expect(result.failures[0]?.reason).toContain("required child passport read denied (BUDGET_EXCEEDED)");
    expect(runner.requests.some((item) => travelTaskIdFromPrompt(item.prompt) === T4_IDENTITY)).toBe(false);
  });

  it("rejects a schema-valid IdentityVerification that contradicts protected-input truth", async () => {
    const { result, store } = await harness({ identityPublication: "invalid" });
    expect(result.outcome).toBe("EXECUTION_FAILED");
    expect(result.failures[0]?.reason).toContain("does not match governed protected-input truth");
    expect(store.snapshot().governanceEvents.some((event) => event.kind === "resource_allowed"
      && (event.payload as { resourceId?: string }).resourceId === RESOURCE_PASSPORT)).toBe(true);
  });

  it("rejects T4 when the child read succeeds but Return Gate publication is absent", async () => {
    const { result } = await harness({ identityPublication: "absent" });
    expect(result.outcome).toBe("EXECUTION_FAILED");
    expect(result.failures[0]?.reason).toContain("child published no contracted artifact");
  });

  it("keeps the identity child at depth zero with least context", async () => {
    const { live, store } = await harness();
    const child = live.children.find((item) => item.taskId === T4_IDENTITY)!;
    const envelope = store.snapshot().envelopes.find((item) => item.id === child.grantId)!;
    expect(envelope).toMatchObject({ depth: 0, maxChildren: 0 });
    const context = store.snapshot().governanceEvents.find((event) => event.kind === "context_projected"
      && (event.payload as { taskId: string }).taskId === T4_IDENTITY)!;
    expect(context.payload).toMatchObject({ includedArtifactIds: ["travel_constraints", "route_plan"] });
  });

  it("records observed runner usage instead of deterministic fixture usage", async () => {
    const { live, store } = await harness();
    expect(live.usage).toHaveLength(7);
    expect(live.usage.every((item) => item.availability === "OBSERVED" && item.totalTokens === 1_520)).toBe(true);
    expect(store.snapshot().runStates[0]?.tokensUsed).toBe(10_640);
  });

  it("never places passport contents or runtime tokens in prompts", async () => {
    const { runner } = await harness();
    const serialized = JSON.stringify(runner.requests.map((item) => ({ prompt: item.prompt, workspacePath: item.workspacePath })));
    expect(serialized).not.toContain("P-SYNTHETIC-8841");
    expect(serialized).not.toContain("RUN-TOKEN-CANARY");
  });

  it("preserves all three historical proof reports byte-for-byte", async () => {
    const expected = {
      "stage7d-travel-runtime-proof.json": "eaf3e53c490e8c26eccccfe6873ee6236f46bcda2949733f62cb2813e780c437",
      "stage7d-travel-runtime-proof-attempt-2.json": "d7cfa51e90402daac3bec6aef72ae52e6d28f07af083465410bd32e83ba9b580",
      "stage7d-travel-runtime-proof-attempt-3.json": "571a8949ff722138edf3097ea329012e0d1539d3448ce6839e1408a379ccc2fd",
    };
    for (const [name, digest] of Object.entries(expected)) {
      const bytes = await readFile(path.resolve(process.cwd(), "../../reports", name));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(digest);
    }
  });

  it("minimizes T0 to one batched command and no synthetic context packet", async () => {
    const { runner } = await harness();
    const prompt = runner.requests.find((item) => travelTaskIdFromPrompt(item.prompt) === T0_UNDERSTAND)!.prompt;
    expect(prompt.match(/node -e/g)).toHaveLength(1);
    expect(prompt).not.toContain("SAFE_CONTEXT");
    expect(prompt).toContain("Do not inspect the workspace");
    expect(prompt).toContain("TRAVEL_RESULT_BEGIN");
  });

  it("uses fresh root Agent threads so ContextBroker remains the only prior-task context", async () => {
    const { runner, live } = await harness();
    expect(new Set(live.rootAgentIds.values()).size).toBe(4);
    const rootRequests = runner.requests.filter((request) =>
      [T0_UNDERSTAND, T3_ROUTE, T5_VALIDATE, T6_FINAL].includes(travelTaskIdFromPrompt(request.prompt)));
    expect(rootRequests.every((request) => request.threadId === null)).toBe(true);
    expect(new Set(rootRequests.map((request) => request.agentId)).size).toBe(4);
  });
});
