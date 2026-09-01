import { EvidenceBadge } from "./EvidenceBadge";
import type { GovernedRunView } from "./types";

export function DelegationScopeCard({ delegations }: { delegations: GovernedRunView["delegations"] }) {
  return (
    <section className="governance-card">
      <div className="governance-card-heading"><span>Delegation scope</span>{delegations.length === 0 && <EvidenceBadge quality="UNAVAILABLE" />}</div>
      {delegations.length === 0 ? <p className="governance-unavailable">No task-correlated delegation evidence is available.</p> : delegations.map((delegation) => (
        <div className="delegation-scope" key={delegation.child.grantId}>
          <div className="scope-summary"><div><strong>Restricted child grant</strong><span>{delegation.child.lifecycle}</span></div><EvidenceBadge quality="OBSERVED" /></div>
          <dl>
            <div><dt>Child agents remaining</dt><dd>{delegation.attenuation.retained.maxChildren}</dd></div>
            <div><dt>Depth remaining</dt><dd>{delegation.attenuation.retained.depth}</dd></div>
            <div><dt>Resources retained</dt><dd>{delegation.attenuation.retained.resources.length}</dd></div>
            <div><dt>Actions retained</dt><dd>{delegation.attenuation.retained.actions.length}</dd></div>
          </dl>
          <div className="attenuation-derived"><span>Authority removed</span><EvidenceBadge quality="DERIVED" /></div>
          {delegation.attenuation.removed.childDelegation && <small>Further child delegation removed</small>}
          {delegation.attenuation.removed.resources.length > 0 && <p><b>Removed resources</b>{delegation.attenuation.removed.resources.join(", ")}</p>}
          {delegation.attenuation.removed.actions.length > 0 && <p><b>Removed actions</b>{delegation.attenuation.removed.actions.join(", ")}</p>}
          <details className="technical-details">
            <summary>Technical IDs</summary>
            <dl>
              <div><dt>Parent principal</dt><dd>{delegation.parent.principalId}</dd></div>
              <div><dt>Parent grant</dt><dd>{delegation.parent.grantId}</dd></div>
              <div><dt>Child principal</dt><dd>{delegation.child.principalId}</dd></div>
              <div><dt>Child grant</dt><dd>{delegation.child.grantId}</dd></div>
            </dl>
          </details>
        </div>
      ))}
    </section>
  );
}
