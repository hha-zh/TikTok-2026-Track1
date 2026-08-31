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
              <div><strong>{event.principalId}</strong><span className={`verdict verdict-${event.verdict?.toLowerCase()}`}>{event.verdict}</span></div>
              <span>{event.action ?? "action unavailable"}{event.resourceId ? ` · ${event.resourceId}` : ""}</span>
              {event.reasonCode && <code>{event.reasonCode}</code>}
            </div>
          ))}
          {delegations.map((delegation) => (
            <div className="authority-delegated" key={delegation.child.grantId}>
              <span aria-hidden="true">↓</span>
              <strong>{delegation.child.principalId}</strong>
              <small>Restricted delegated grant · {delegation.child.lifecycle}</small>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
