#!/usr/bin/env node
/** Offline Stage 7D.3 revalidation. This script never starts a runtime/provider. */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const historicalPath = path.join(repoRoot, "reports", "stage7d-travel-runtime-proof-attempt-4.json");
const outputPath = path.join(repoRoot, "reports", "stage7d-travel-runtime-proof-attempt-4-revalidation.json");
const expectedHistoricalSha256 = "3fd18cc02d3ea32da522d9459385a6ed8e68aef174fc67534da75392349d1e61";
const { deriveEarlyRouterTopology, deriveNoRawChildHandoff, deriveOraclePassed } = await import(
  path.join(repoRoot, "apps", "server", "dist", "workload", "travel-disruption", "live-proof-evidence.js")
);

const bytes = await readFile(historicalPath);
const historicalSha256 = createHash("sha256").update(bytes).digest("hex");
const historical = JSON.parse(bytes.toString("utf8"));
const noRawChildHandoff = deriveNoRawChildHandoff(
  historical.secretAudit?.rawChildOutputAbsentFromParentView === true,
  historical.returnGate,
);
const earlyRouterTopology = deriveEarlyRouterTopology(historical.topology ?? []);
const governance = { ...historical.oracle.governance, noRawChildHandoff };
const adaptive = { ...historical.oracle.adaptive, earlyRouterTopology };
const oraclePassed = deriveOraclePassed([
  historical.oracle.domain,
  governance,
  adaptive,
  historical.oracle.lifecycle,
]);
const historicalReportChanged = historicalSha256 !== expectedHistoricalSha256;
const pass = (value) => value === true ? "PASS" : "FAIL";
const revalidation = {
  contractVersion: "1",
  proof: "STAGE_7D_3_ATTEMPT_4_FORENSIC_REVALIDATION",
  sourceReport: "reports/stage7d-travel-runtime-proof-attempt-4.json",
  executionProvenance: {
    value: historical.executionProvenance,
    quality: "DECLARED",
    support: ["configured ContainerCodexRunner path", "completed live Agent runs", "provider-reported usage"],
    cryptographicProviderAttestation: false,
  },
  externalProviderRuns: 0,
  noRawChildHandoff: pass(noRawChildHandoff),
  earlyRouterTopology: pass(earlyRouterTopology),
  oracleRevalidated: pass(oraclePassed && !historicalReportChanged),
  historicalReportChanged,
  sourceReportSha256: historicalSha256,
};

await writeFile(outputPath, JSON.stringify(revalidation, null, 2) + "\n", "utf8");
if (revalidation.oracleRevalidated !== "PASS") process.exitCode = 1;
