import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  deriveEarlyRouterTopology,
  deriveLiveProofStatus,
  deriveNoRawChildHandoff,
  deriveOraclePassed,
  type LiveTopologyEvidence,
} from "./live-proof-evidence.js";
import { T1_TRANSPORT, T2_ACCOMMODATION } from "./graph.js";

const boundedReturn = {
  published: true,
  parentReadStatus: 200,
  parentReceivedBoundedArtifact: true,
};

const earlyTopology: LiveTopologyEvidence[] = [
  { taskId: T1_TRANSPORT, who: "DELEGATE_SPECIALIST", how: "PARALLEL" },
  { taskId: T2_ACCOMMODATION, who: "DELEGATE_SPECIALIST", how: "PARALLEL" },
];

describe("Stage 7D live proof evidence derivation", () => {
  it("derives noRawChildHandoff only from absence plus a bounded parent return", () => {
    expect(deriveNoRawChildHandoff(true, boundedReturn)).toBe(true);
  });

  it("fails noRawChildHandoff when raw child output is parent-visible", () => {
    expect(deriveNoRawChildHandoff(false, boundedReturn)).toBe(false);
  });

  it("derives earlyRouterTopology from both recorded early expansion decisions", () => {
    expect(deriveEarlyRouterTopology(earlyTopology)).toBe(true);
  });

  it("fails earlyRouterTopology when a required routing event is missing", () => {
    expect(deriveEarlyRouterTopology(earlyTopology.slice(0, 1))).toBe(false);
  });

  it("fails earlyRouterTopology for the wrong WHO", () => {
    expect(deriveEarlyRouterTopology(earlyTopology.map((item, index) =>
      index === 0 ? { ...item, who: "REUSE_CURRENT" } : item))).toBe(false);
  });

  it("fails earlyRouterTopology for the wrong HOW", () => {
    expect(deriveEarlyRouterTopology(earlyTopology.map((item, index) =>
      index === 1 ? { ...item, how: "DIRECT" } : item))).toBe(false);
  });

  it("does not accept valid-looking artifacts without return or routing evidence", () => {
    const validLookingArtifact = { identity_verified: "yes" };
    expect(validLookingArtifact.identity_verified).toBe("yes");
    expect(deriveNoRawChildHandoff(true, null)).toBe(false);
    expect(deriveEarlyRouterTopology([])).toBe(false);
  });

  it("fails the oracle when either derived evidence claim fails", () => {
    const otherwiseValid = { requiredTasksComplete: true };
    expect(deriveOraclePassed([
      otherwiseValid,
      { noRawChildHandoff: false, earlyRouterTopology: true },
    ])).toBe(false);
    expect(deriveOraclePassed([
      otherwiseValid,
      { noRawChildHandoff: true, earlyRouterTopology: false },
    ])).toBe(false);
  });

  it("cannot produce PROVEN when oracle.passed is false", () => {
    expect(deriveLiveProofStatus(null, false, { allFinalClaims: true })).toBe("FAILED");
  });

  it("keeps all historical Stage 7D reports byte-for-byte unchanged", async () => {
    const expected = {
      "stage7d-travel-runtime-proof.json": "eaf3e53c490e8c26eccccfe6873ee6236f46bcda2949733f62cb2813e780c437",
      "stage7d-travel-runtime-proof-attempt-2.json": "d7cfa51e90402daac3bec6aef72ae52e6d28f07af083465410bd32e83ba9b580",
      "stage7d-travel-runtime-proof-attempt-3.json": "571a8949ff722138edf3097ea329012e0d1539d3448ce6839e1408a379ccc2fd",
      "stage7d-travel-runtime-proof-attempt-4.json": "3fd18cc02d3ea32da522d9459385a6ed8e68aef174fc67534da75392349d1e61",
    };
    for (const [name, digest] of Object.entries(expected)) {
      const bytes = await readFile(path.resolve(process.cwd(), "../../reports", name));
      expect(createHash("sha256").update(bytes).digest("hex"), name).toBe(digest);
    }
  });
});
