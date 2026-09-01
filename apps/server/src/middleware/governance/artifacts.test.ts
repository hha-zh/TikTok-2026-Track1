import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "../../store.js";
import { GovernanceLedger } from "../evidence/ledger.js";
import {
  createArtifact,
  publishArtifact,
  readArtifact,
  validatePublication,
} from "./artifacts.js";
import { SECURITY_FINDING_SCHEMA, seedGovernanceFixtures } from "./fixtures.js";
import type { AuthenticatedIdentity } from "./identity.js";
import type { Envelope, Principal } from "./types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const TYPE = "SecurityFinding";
const VALID_FIELDS = {
  actor_class: "human",
  action_count: 47,
  time_window: { start: 1_705_665_600, end: 1_705_667_400 },
  verdict: "anomalous",
};

type AgentIdentity = Extract<AuthenticatedIdentity, { kind: "agent" }>;

function envelope(overrides: Partial<Envelope> & { id: string }): Envelope {
  return {
    principalId: "p-" + overrides.id,
    exercisable: {
      resources: [TYPE, "sec/INC-42"],
      actions: ["read", "artifact:create", "artifact:publish"],
    },
    delegatable: { resources: [], actions: [] },
    depth: 0,
    maxTokens: 1000,
    maxToolCalls: 10,
    maxChildren: 0,
    runId: "run-1",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function identity(principal: Principal, grantId: string): AgentIdentity {
  return {
    kind: "agent",
    principalId: principal.id,
    grantId,
    runId: "run-1",
    principal,
  };
}

/** Parent grant, child grant beneath it, both resolvable. */
async function scenario() {
  const root = await mkdtemp(path.join(tmpdir(), "artifacts-gate-"));
  roots.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  await seedGovernanceFixtures(store);
  const ledger = new GovernanceLedger(store);

  const parentPrincipal: Principal = { id: "p-parent", kind: "agent", ownerId: "wtan" };
  const childPrincipal: Principal = {
    id: "p-child",
    kind: "agent",
    ownerId: "wtan",
    parentPrincipalId: "p-parent",
  };
  const siblingPrincipal: Principal = { id: "p-sibling", kind: "agent", ownerId: "wtan" };

  await store.mutate((database) => {
    database.principals.push(parentPrincipal, childPrincipal, siblingPrincipal);
    database.envelopes.push(
      envelope({ id: "g-parent", principalId: "p-parent", depth: 1, maxChildren: 2 }),
      envelope({ id: "g-child", principalId: "p-child", parentGrantId: "g-parent" }),
      envelope({ id: "g-sibling", principalId: "p-sibling", parentGrantId: "g-parent" }),
    );
    database.runStates.push({ runId: "run-1", maxTokens: 12_000, tokensUsed: 0 });
    // resolveGrant refuses an envelope with no GrantState. In production the
    // grant_created projection creates these; here they are seeded directly.
    for (const grantId of ["g-parent", "g-child", "g-sibling"]) {
      database.grantStates.push({ grantId, revoked: false, tokensUsed: 0, childCount: 0 });
    }
  });

  return {
    store,
    ledger,
    deps: { store, ledger },
    child: identity(childPrincipal, "g-child"),
    parent: identity(parentPrincipal, "g-parent"),
    sibling: identity(siblingPrincipal, "g-sibling"),
  };
}

describe("validatePublication", () => {
  it("accepts a well-formed SecurityFinding", () => {
    expect(validatePublication(SECURITY_FINDING_SCHEMA, TYPE, VALID_FIELDS)).toEqual({
      ok: true,
    });
  });

  it("rejects an unregistered type as ARTIFACT_TYPE_NOT_GRANTED", () => {
    const result = validatePublication(undefined, "Unknown", {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("ARTIFACT_TYPE_NOT_GRANTED");
  });

  it("rejects free text smuggled into a permitted field", () => {
    // The whole point of the gate: raw prose must not cross.
    const result = validatePublication(SECURITY_FINDING_SCHEMA, TYPE, {
      ...VALID_FIELDS,
      verdict: "rmenon exported 47 payment records at 12:15",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("ARTIFACT_SCHEMA_VIOLATION");
  });

  it("rejects an unpermitted field name such as raw_records", () => {
    const result = validatePublication(SECURITY_FINDING_SCHEMA, TYPE, {
      actor_class: "human",
      raw_records: [1, 2, 3],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain("raw_records");
  });

  it("rejects an out-of-range count and a malformed window", () => {
    expect(
      validatePublication(SECURITY_FINDING_SCHEMA, TYPE, {
        ...VALID_FIELDS,
        action_count: 10_001,
      }).ok,
    ).toBe(false);
    expect(
      validatePublication(SECURITY_FINDING_SCHEMA, TYPE, {
        ...VALID_FIELDS,
        time_window: { start: 1, end: 2, note: "extra" },
      }).ok,
    ).toBe(false);
  });

  it("rejects more fields than the schema permits", () => {
    const result = validatePublication(SECURITY_FINDING_SCHEMA, TYPE, {
      ...VALID_FIELDS,
      extra: "x",
    });
    expect(result.ok).toBe(false);
  });
});

describe("Return Gate", () => {
  it("keeps an unpublished artifact private from the parent", async () => {
    const { child, parent, deps } = await scenario();
    const created = await createArtifact(
      child,
      { artifactType: TYPE, fields: VALID_FIELDS },
      deps,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // The child can always read its own.
    expect(readArtifact(child, created.value.id, deps).ok).toBe(true);

    const parentRead = readArtifact(parent, created.value.id, deps);
    expect(parentRead.ok).toBe(false);
    if (!parentRead.ok) expect(parentRead.reason).toBe("ARTIFACT_NOT_PUBLISHED");
  });

  it("releases to the parent only after a schema-valid publish", async () => {
    const { child, parent, deps } = await scenario();
    const created = await createArtifact(
      child,
      { artifactType: TYPE, fields: VALID_FIELDS },
      deps,
    );
    if (!created.ok) throw new Error("create failed");

    const published = await publishArtifact(
      child,
      created.value.id,
      { artifactType: TYPE, fields: VALID_FIELDS },
      deps,
    );
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    // Defaults to the parent principal alone, not to everyone in the run.
    expect(published.value.recipients).toEqual(["p-parent"]);
    expect(readArtifact(parent, created.value.id, deps).ok).toBe(true);
  });

  it("withholds a published artifact from a sibling child", async () => {
    const { child, sibling, deps } = await scenario();
    const created = await createArtifact(
      child,
      { artifactType: TYPE, fields: VALID_FIELDS },
      deps,
    );
    if (!created.ok) throw new Error("create failed");
    await publishArtifact(
      child,
      created.value.id,
      { artifactType: TYPE, fields: VALID_FIELDS },
      deps,
    );

    // published:true alone must not mean world-readable within the run.
    const siblingRead = readArtifact(sibling, created.value.id, deps);
    expect(siblingRead.ok).toBe(false);
    if (!siblingRead.ok) expect(siblingRead.reason).toBe("ARTIFACT_NOT_RECIPIENT");
  });

  it("refuses a recipient outside the publisher's ancestry", async () => {
    const { child, deps } = await scenario();
    const created = await createArtifact(
      child,
      { artifactType: TYPE, fields: VALID_FIELDS },
      deps,
    );
    if (!created.ok) throw new Error("create failed");

    const result = await publishArtifact(
      child,
      created.value.id,
      { artifactType: TYPE, fields: VALID_FIELDS, recipients: ["p-sibling"] },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("ARTIFACT_NOT_RECIPIENT");
  });

  it("refuses a schema violation and leaves the artifact unpublished", async () => {
    const { child, parent, deps } = await scenario();
    const created = await createArtifact(
      child,
      { artifactType: TYPE, fields: VALID_FIELDS },
      deps,
    );
    if (!created.ok) throw new Error("create failed");

    const result = await publishArtifact(
      child,
      created.value.id,
      { artifactType: TYPE, fields: { ...VALID_FIELDS, raw_records: [1] } },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("ARTIFACT_SCHEMA_VIOLATION");
    // A rejected publish must not leak the artifact anyway.
    const parentRead = readArtifact(parent, created.value.id, deps);
    expect(parentRead.ok).toBe(false);
  });

  it("blocks publication after the parent grant is revoked mid-flight", async () => {
    const { child, parent, deps, store } = await scenario();
    const created = await createArtifact(
      child,
      { artifactType: TYPE, fields: VALID_FIELDS },
      deps,
    );
    if (!created.ok) throw new Error("create failed");

    // Revoked AFTER the child was dispatched. Publish re-walks ancestry, so
    // the in-flight window closes here rather than staying open.
    await store.mutate((database) => {
      const parentState = database.grantStates.find(
        (item) => item.grantId === "g-parent",
      );
      if (parentState) parentState.revoked = true;
    });

    const result = await publishArtifact(
      child,
      created.value.id,
      { artifactType: TYPE, fields: VALID_FIELDS },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("PARENT_GRANT_REVOKED");
    expect(readArtifact(parent, created.value.id, deps).ok).toBe(false);
  });

  it("refuses a publish by a principal that does not own the artifact", async () => {
    const { child, sibling, deps } = await scenario();
    const created = await createArtifact(
      child,
      { artifactType: TYPE, fields: VALID_FIELDS },
      deps,
    );
    if (!created.ok) throw new Error("create failed");

    const result = await publishArtifact(
      sibling,
      created.value.id,
      { artifactType: TYPE, fields: VALID_FIELDS },
      deps,
    );
    expect(result.ok).toBe(false);
  });

  it("records created, published and rejected on the ledger", async () => {
    const { child, deps, store } = await scenario();
    const created = await createArtifact(
      child,
      { artifactType: TYPE, fields: VALID_FIELDS },
      deps,
    );
    if (!created.ok) throw new Error("create failed");
    await publishArtifact(
      child,
      created.value.id,
      { artifactType: TYPE, fields: { ...VALID_FIELDS, raw_records: [1] } },
      deps,
    );
    await publishArtifact(
      child,
      created.value.id,
      { artifactType: TYPE, fields: VALID_FIELDS },
      deps,
    );

    const kinds = store
      .snapshot()
      .governanceEvents.map((event) => event.kind)
      .filter((kind) => kind.startsWith("artifact_"));
    // A gate that denies correctly but logs nothing produces an empty
    // timeline on stage, so assert the evidence, not just the verdict.
    expect(kinds).toEqual([
      "artifact_created",
      "artifact_rejected",
      "artifact_published",
    ]);
  });
});
