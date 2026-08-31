import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TravelLifecycleResult } from "./run.js";
import { runTravelLifecycle, travelLifecyclePassed } from "./run.js";
import { TRAVEL_ACTUAL_TOKENS } from "./adapter.js";
import {
  A_ACCOMMODATION, A_CONSTRAINTS, A_FINAL, A_IDENTITY, A_ROUTE, A_TRANSPORT,
  A_VALIDATED, buildTravelGraph, T1_TRANSPORT, T2_ACCOMMODATION, T4_IDENTITY,
  T5_VALIDATE, T6_FINAL,
} from "./graph.js";
import { PASSPORT_LEAK_CANARY, RESOURCE_PASSPORT } from "./resources.js";

let lifecycle: TravelLifecycleResult;
beforeAll(async () => { lifecycle = await runTravelLifecycle(); });
afterAll(async () => { await lifecycle.cleanup(); });

const assignments = () => lifecycle.engine.rounds.flatMap((round) => round.plan.assignments);
const assignment = (taskId: string) => assignments().find((item) => item.nodeId === taskId)!;

describe("Stage 7B deterministic governed Travel lifecycle", () => {
  it("encodes artifact dependencies instead of workload scheduling", () => {
    const graph = buildTravelGraph();
    const required = (id: string) => graph.nodes.find((node) => node.id === id)!.requiredArtifacts;
    expect(required(T1_TRANSPORT)).toEqual([A_CONSTRAINTS]);
    expect(required(T2_ACCOMMODATION)).toEqual([A_CONSTRAINTS]);
    expect(required(T4_IDENTITY)).toEqual([A_CONSTRAINTS, A_ROUTE]);
    expect(required(T5_VALIDATE)).toEqual([A_CONSTRAINTS, A_TRANSPORT, A_ACCOMMODATION, A_ROUTE, A_IDENTITY]);
    expect(required(T6_FINAL)).toEqual([A_CONSTRAINTS, A_VALIDATED]);
  });

  it("completes all seven tasks and produces the final bounded plan", () => {
    expect(lifecycle.engine.outcome).toBe("COMPLETED");
    expect([...lifecycle.engine.progress.completed]).toHaveLength(7);
    expect(lifecycle.engine.artifacts.find((item) => item.id === A_FINAL)?.value).toEqual({
      transport_option_id: "TR-ALT-02", accommodation_option_id: "HT-03",
      route_option_id: "RT-HND-01", final_arrival: "2026-09-02T11:00:00+09:00",
      total_additional_spend_sgd: 620, approval_required: "yes", status: "ready_for_approval",
    });
  });

  it("denies the root passport attempt at the backend with the canonical reason", () => {
    expect(lifecycle.executor.denials).toContainEqual({
      taskId: "understand_disruption", resourceId: RESOURCE_PASSPORT,
      statusCode: 403, reason: "NOT_EXERCISABLE_DELEGATE_ONLY",
    });
  });

  it("allows the governed normal-resource reads needed by the scenario", () => {
    expect(lifecycle.engine.failures).toEqual([]);
    expect(lifecycle.executor.executions).toHaveLength(7);
    expect(lifecycle.executor.denials).toHaveLength(1);
  });

  it("delegates the independent searches in one parallel wave", () => {
    expect(assignment(T1_TRANSPORT).placement).toBe("DELEGATE_SPECIALIST");
    expect(assignment(T2_ACCOMMODATION).placement).toBe("DELEGATE_SPECIALIST");
    expect(lifecycle.engine.rounds.some((round) => round.plan.waves.some((wave) =>
      wave.nodeIds.includes(T1_TRANSPORT) && wave.nodeIds.includes(T2_ACCOMMODATION)))).toBe(true);
  });

  it("uses narrow child authority for every delegated task", () => {
    const snapshot = lifecycle.store.snapshot();
    for (const record of lifecycle.delegation.records) {
      const child = snapshot.envelopes.find((item) => item.id === record.grantId)!;
      expect(child.parentGrantId).toBe(lifecycle.rootGrantId);
      expect(child.depth).toBe(0);
      expect(child.maxChildren).toBe(0);
      if (record.taskId !== T4_IDENTITY) expect(child.exercisable.resources).not.toContain(RESOURCE_PASSPORT);
    }
  });

  it("gives passport scope only to the isolated identity child", () => {
    expect(assignment(T4_IDENTITY).placement).toBe("DELEGATE_SPECIALIST");
    const record = lifecycle.delegation.records.find((item) => item.taskId === T4_IDENTITY)!;
    const envelope = lifecycle.store.snapshot().envelopes.find((item) => item.id === record.grantId)!;
    expect(envelope.exercisable.resources).toContain(RESOURCE_PASSPORT);
    expect(envelope.exercisable.resources).not.toContain("travel/transport_options");
    expect(envelope.exercisable.resources).not.toContain("travel/accommodation_options");
  });

  it("projects only the identity task's required briefing", () => {
    const execution = lifecycle.executor.executions.find((item) => item.taskId === T4_IDENTITY)!;
    expect(execution.included.sort()).toEqual(["route_plan", "travel_constraints"]);
    expect(execution.included).not.toContain(A_TRANSPORT);
  });

  it("passes identity output through the real artifact Return Gate", () => {
    const artifact = lifecycle.engine.artifacts.find((item) => item.id === A_IDENTITY)!;
    expect(artifact.origin).toBe("published_finding");
    expect(artifact.value).toEqual({
      identity_verified: "yes", booking_name_matched: "yes",
      travel_document_valid: "yes", destination_eligible: "yes",
    });
    expect(lifecycle.store.snapshot().governanceEvents.some((event) =>
      event.kind === "artifact_published" && event.principalId === artifact.producedByPrincipalId)).toBe(true);
  });

  it("never persists the protected fixture value in evidence or artifacts", () => {
    const snapshot = lifecycle.store.snapshot();
    expect(JSON.stringify({ events: snapshot.governanceEvents, artifacts: snapshot.artifacts,
      runtime: lifecycle.engine.artifacts, contexts: lifecycle.executor.executions }))
      .not.toContain(PASSPORT_LEAK_CANARY);
  });

  it("changes the later WHO topology after actual execution pressure", () => {
    const early = assignment(T1_TRANSPORT);
    const later = assignment(T5_VALIDATE);
    expect(early.delegationValue).toBe(later.delegationValue);
    expect(early.delegationThreshold).toBeLessThan(later.delegationThreshold);
    expect(early.placement).toBe("DELEGATE_SPECIALIST");
    expect(later.placement).toBe("REUSE_CURRENT");
  });

  it("accounts for the executor's actual token usage", () => {
    const events = lifecycle.store.snapshot().governanceEvents.filter((event) => event.kind === "tokens_consumed");
    const total = events.reduce((sum, event) => sum + (event.payload as { totalTokens: number }).totalTokens, 0);
    expect(total).toBe(Object.values(TRAVEL_ACTUAL_TOKENS).reduce((sum, value) => sum + value, 0));
    expect(total).toBe(9_400);
  });

  it("records decisions, invocations, contexts, completions, and outcome in the real ledger", () => {
    const kinds = new Set(lifecycle.store.snapshot().governanceEvents.map((event) => event.kind));
    for (const kind of ["routing_decision", "invocation_started", "context_projected", "task_completed", "run_outcome"]) {
      expect(kinds.has(kind as never)).toBe(true);
    }
  });

  it("revokes every child grant after the run", () => {
    const snapshot = lifecycle.store.snapshot();
    expect(lifecycle.revokedGrantIds).toHaveLength(3);
    for (const grantId of lifecycle.revokedGrantIds) {
      expect(snapshot.grantStates.find((state) => state.grantId === grantId)?.revoked).toBe(true);
    }
  });

  it("passes the complete lifecycle oracle", () => {
    expect(lifecycle.engine.artifacts.some((item) => item.id === A_ROUTE)).toBe(true);
    expect(travelLifecyclePassed(lifecycle)).toBe(true);
  });

  it("is reproducible apart from generated governance identifiers", async () => {
    const again = await runTravelLifecycle("travel-run-repro");
    try {
      const topology = (value: TravelLifecycleResult) => value.engine.rounds.flatMap((round) =>
        round.plan.assignments.map((item) => [item.nodeId, item.placement, item.disposition, round.plan.shape]));
      expect(topology(again)).toEqual(topology(lifecycle));
      expect(again.engine.artifacts.map((item) => [item.id, item.value]))
        .toEqual(lifecycle.engine.artifacts.map((item) => [item.id, item.value]));
      expect(again.oracle).toEqual(lifecycle.oracle);
    } finally {
      await again.cleanup();
    }
  });
});
