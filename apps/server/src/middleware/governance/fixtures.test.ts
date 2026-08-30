import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "../../store.js";
import { GovernanceLedger } from "../evidence/ledger.js";
import { applyGovernanceEvent } from "../evidence/projections.js";
import { authorize } from "./authorize.js";
import { resolveGrant } from "./grant-resolver.js";
import {
  ARTIFACT_SECURITY_FINDING,
  HUMAN_RMENON,
  HUMAN_WTAN,
  PARENT_DELEGATABLE_RESOURCES,
  PARENT_EXERCISABLE_ACTIONS,
  PARENT_EXERCISABLE_RESOURCES,
  PARENT_MAX_CHILDREN,
  RESOURCE_AUDIT,
  RESOURCE_CHECKOUT_LOG,
  RESOURCE_PAYMENTS,
  RUN_CAP_TOKENS,
  seedGovernanceFixtures,
  startGovernedRun,
} from "./fixtures.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function freshStore(): Promise<JsonStore> {
  const root = await mkdtemp(path.join(tmpdir(), "governance-fixtures-"));
  roots.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  return store;
}

describe("governance fixtures", () => {
  it("seeds both humans, five resources and the finding schema, idempotently", async () => {
    const store = await freshStore();
    const first = await seedGovernanceFixtures(store);
    const second = await seedGovernanceFixtures(store);

    expect(first.principalsAdded).toBe(2);
    expect(second.principalsAdded).toBe(0);
    expect(second.schemasAdded).toBe(0);

    const database = store.snapshot();
    expect(database.principals.map((item) => item.id).sort()).toEqual([
      HUMAN_RMENON,
      HUMAN_WTAN,
    ]);
    expect(database.mockResources).toHaveLength(5);
    expect(database.artifactSchemas).toHaveLength(1);
  });

  it("keeps the audit slice delegate-only and rmenon's file out of both sets", () => {
    // If sec/INC-42 were exercisable the whole exercisable/delegatable
    // distinction would collapse.
    expect(PARENT_EXERCISABLE_RESOURCES).not.toContain(RESOURCE_AUDIT);
    expect(PARENT_DELEGATABLE_RESOURCES).toContain(RESOURCE_AUDIT);
    expect(PARENT_EXERCISABLE_RESOURCES).not.toContain(RESOURCE_PAYMENTS);
    expect(PARENT_DELEGATABLE_RESOURCES).not.toContain(RESOURCE_PAYMENTS);
  });

  it("withholds the production patch tool so the tool gate has a denial", () => {
    expect(PARENT_EXERCISABLE_ACTIONS).toContain("tool:inspect_metrics");
    expect(PARENT_EXERCISABLE_ACTIONS).not.toContain("tool:apply_production_patch");
  });

  it("plants a pointer to rmenon's file inside wtan's own readable log", async () => {
    const store = await freshStore();
    await seedGovernanceFixtures(store);
    const log = store
      .snapshot()
      .mockResources.find((item) => item.id === RESOURCE_CHECKOUT_LOG);
    const rows = (log?.body as { rows: string[] }).rows;
    // The lure has to be reachable or demo moment 1 never triggers.
    expect(rows.some((row) => row.includes(RESOURCE_PAYMENTS))).toBe(true);
  });

  it("sets a run cap below the sum of plausible child caps", () => {
    expect(PARENT_MAX_CHILDREN * 8000).toBeGreaterThan(RUN_CAP_TOKENS);
  });

  it("creates the root principal, envelope and RunState a run needs", async () => {
    const store = await freshStore();
    await seedGovernanceFixtures(store);
    const ledger = new GovernanceLedger(store);
    const run = await startGovernedRun(store, ledger, { runId: "run-1" });

    const database = store.snapshot();
    expect(database.runStates).toEqual([
      { runId: "run-1", maxTokens: RUN_CAP_TOKENS, tokensUsed: 0 },
    ]);
    expect(run.principal.kind).toBe("agent");
    expect(run.envelope.parentGrantId).toBeUndefined();

    // Without a RunState the tokens_consumed projection throws, which is why
    // this is the bootstrap and not merely demo data.
    expect(() =>
      applyGovernanceEvent(database, {
        seq: 99,
        ts: new Date().toISOString(),
        runId: "run-1",
        grantId: run.envelope.id,
        principalId: run.principal.id,
        kind: "tokens_consumed",
        payload: {
          inputTokens: 10,
          cachedInputTokens: 0,
          outputTokens: 5,
          totalTokens: 15,
        },
      }),
    ).not.toThrow();
  });

  it("produces a root grant that resolves and authorizes end to end", async () => {
    const store = await freshStore();
    await seedGovernanceFixtures(store);
    const ledger = new GovernanceLedger(store);
    const run = await startGovernedRun(store, ledger, { runId: "run-1" });

    const resolution = resolveGrant(
      {
        principalId: run.principal.id,
        grantId: run.envelope.id,
        runId: "run-1",
      },
      store,
    );
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;

    // The three gate lines the fixture exists to demonstrate.
    expect(
      authorize(run.principal, "read", "app/metrics", resolution.state).verdict,
    ).toBe("ALLOW");
    expect(
      authorize(run.principal, "read", RESOURCE_PAYMENTS, resolution.state).reason,
    ).toBe("RESOURCE_NOT_GRANTED");
    expect(
      authorize(run.principal, "read", RESOURCE_AUDIT, resolution.state).reason,
    ).toBe("NOT_EXERCISABLE_DELEGATE_ONLY");
    expect(
      authorize(
        run.principal,
        "tool:apply_production_patch",
        null,
        resolution.state,
      ).reason,
    ).toBe("ACTION_NOT_GRANTED");
  });

  it("lets a delegated child reach the audit slice and the finding type", async () => {
    const store = await freshStore();
    await seedGovernanceFixtures(store);
    const ledger = new GovernanceLedger(store);
    const run = await startGovernedRun(store, ledger, { runId: "run-1" });

    // The parent may delegate exactly what it cannot exercise.
    expect(run.envelope.delegatable.resources).toContain(RESOURCE_AUDIT);
    expect(run.envelope.delegatable.resources).toContain(ARTIFACT_SECURITY_FINDING);
    expect(run.envelope.delegatable.actions).toContain("artifact:publish");
  });

  it("gives each run a fresh principal so authority cannot outlive its run", async () => {
    const store = await freshStore();
    await seedGovernanceFixtures(store);
    const ledger = new GovernanceLedger(store);
    const first = await startGovernedRun(store, ledger, { runId: "run-1" });
    const second = await startGovernedRun(store, ledger, { runId: "run-2" });
    expect(first.principal.id).not.toBe(second.principal.id);
    expect(first.envelope.id).not.toBe(second.envelope.id);
  });
});
