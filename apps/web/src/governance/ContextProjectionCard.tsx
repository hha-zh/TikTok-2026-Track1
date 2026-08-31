import { EvidenceBadge } from "./EvidenceBadge";
import type { GovernedRunView } from "./types";

export function ContextProjectionCard({ projections }: { projections: GovernedRunView["contextProjections"] }) {
  return (
    <section className="governance-card">
      <div className="governance-card-heading"><span>Context projection</span><EvidenceBadge quality={projections.length ? "OBSERVED" : "UNAVAILABLE"} /></div>
      {projections.length === 0 ? <p className="governance-unavailable">Context projection evidence is unavailable for this task.</p> : projections.map((projection) => (
        <div className="context-projection" key={`${projection.invocationId}:${projection.sequence}`}>
          <strong>Context shared</strong>
          {projection.includedArtifactIds.length ? projection.includedArtifactIds.map((id) => <span className="context-included" key={id}>✓ {id}</span>) : <small>None recorded</small>}
          <strong>Withheld</strong>
          {projection.withheld.length ? projection.withheld.map((item) => <span className="context-withheld" key={`${item.id}:${item.reason}`}>× {item.id}<code>{item.reason}</code></span>) : <small>None recorded</small>}
        </div>
      ))}
    </section>
  );
}
