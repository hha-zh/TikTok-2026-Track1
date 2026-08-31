import { EvidenceBadge } from "./EvidenceBadge";
import type { GovernedRunView } from "./types";

export function RunPressureBar({ budget }: { budget: GovernedRunView["runtimeState"]["budgetHorizon"] }) {
  const { used, cap, remaining } = budget.runTokens;
  const percent = cap > 0 ? Math.min(100, Math.max(0, used / cap * 100)) : 0;
  return (
    <section className="governance-card pressure-card">
      <div className="governance-card-heading"><span>Run pressure</span></div>
      <div className="pressure-provenance"><span>Usage ratio</span><EvidenceBadge quality="DERIVED" /></div>
      <div className="pressure-track" role="meter" aria-label="Run token usage" aria-valuemin={0} aria-valuemax={cap} aria-valuenow={used}>
        <span style={{ width: `${percent}%` }} />
      </div>
      <div className="pressure-values"><strong>{used.toLocaleString()} used</strong><span>{cap.toLocaleString()} cap</span><EvidenceBadge quality="OBSERVED" /></div>
      <small>{remaining.toLocaleString()} tokens remaining <EvidenceBadge quality="DERIVED" /></small>
    </section>
  );
}
