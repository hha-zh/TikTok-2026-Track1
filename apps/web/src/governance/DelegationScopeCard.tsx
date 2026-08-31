import { EvidenceBadge } from "./EvidenceBadge";
import type { GovernedRunView } from "./types";

export function DelegationScopeCard({ delegations }: { delegations: GovernedRunView["delegations"] }) {
  return (
    <section className="governance-card">
      <div className="governance-card-heading"><span>Delegation scope</span>{delegations.length === 0 && <EvidenceBadge quality="UNAVAILABLE" />}</div>
      {delegations.length === 0 ? <p className="governance-unavailable">No task-correlated delegation evidence is available.</p> : delegations.map((delegation) => (
        <div className="delegation-scope" key={delegation.child.grantId}>
          <div className="scope-principals"><span>{delegation.parent.principalId}</span><b>→</b><span>{delegation.child.principalId}</span><EvidenceBadge quality="OBSERVED" /></div>
          <div className="attenuation-derived"><span>Retained child grant</span><EvidenceBadge quality="OBSERVED" /></div>
          <dl>
            <div><dt>Child agents</dt><dd>{delegation.attenuation.retained.maxChildren}</dd></div>
            <div><dt>Depth</dt><dd>{delegation.attenuation.retained.depth}</dd></div>
            <div><dt>Resources retained</dt><dd>{delegation.attenuation.retained.resources.length}</dd></div>
            <div><dt>Actions retained</dt><dd>{delegation.attenuation.retained.actions.length}</dd></div>
          </dl>
          <div className="attenuation-derived"><span>Authority removed</span><EvidenceBadge quality="DERIVED" /></div>
          {delegation.attenuation.removed.childDelegation && <small>Further child delegation removed</small>}
          {delegation.attenuation.removed.resources.length > 0 && <p><b>Removed resources</b>{delegation.attenuation.removed.resources.join(", ")}</p>}
          {delegation.attenuation.removed.actions.length > 0 && <p><b>Removed actions</b>{delegation.attenuation.removed.actions.join(", ")}</p>}
        </div>
      ))}
    </section>
  );
}
