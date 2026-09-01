import { EvidenceBadge } from "./EvidenceBadge";
import type { GovernanceEvent, GovernedRunView } from "./types";

export function AuthorityCard({ events, delegations }: {
  events: GovernanceEvent[];
  delegations: GovernedRunView["delegations"];
}) {
  const authorityEvents = events.filter((event) => event.verdict);
  return (
    <section className="governance-card">
      <div className="governance-card-heading"><span>Authority</span><EvidenceBadge quality={authorityEvents.length ? "OBSERVED" : "UNAVAILABLE"} /></div>
      {authorityEvents.length === 0 ? <p className="governance-unavailable">No task-specific authorization evidence is available.</p> : (
        <div className="authority-events">
          {authorityEvents.map((event) => (
            <div className={`authority-event authority-${event.verdict?.toLowerCase()}`} key={event.eventId}>
              <div><strong>{event.resourceId ?? event.action ?? event.kind}</strong><span className={`verdict verdict-${event.verdict?.toLowerCase()}`}>{event.verdict}</span></div>
              {event.reasonCode && <code>{event.reasonCode}</code>}
              <details className="technical-details">
                <summary>Technical IDs</summary>
                <dl>
                  <div><dt>Principal</dt><dd>{event.principalId}</dd></div>
                  <div><dt>Grant</dt><dd>{event.grantId}</dd></div>
                  <div><dt>Event</dt><dd>{event.kind}</dd></div>
                  {event.action && <div><dt>Action</dt><dd>{event.action}</dd></div>}
                </dl>
              </details>
            </div>
          ))}
          {delegations.map((delegation) => (
            <div className="authority-delegated" key={delegation.child.grantId}>
              <span aria-hidden="true">↓</span>
              <strong>Restricted delegated grant</strong>
              <small>Specialist authority · {delegation.child.lifecycle}</small>
              <details className="technical-details">
                <summary>Technical IDs</summary>
                <dl>
                  <div><dt>Child principal</dt><dd>{delegation.child.principalId}</dd></div>
                  <div><dt>Child grant</dt><dd>{delegation.child.grantId}</dd></div>
                </dl>
              </details>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
