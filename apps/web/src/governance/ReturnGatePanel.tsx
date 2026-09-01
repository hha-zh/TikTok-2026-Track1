import { EvidenceBadge } from "./EvidenceBadge";
import type { GovernedRunView } from "./types";

function displayName(value: string): string {
  const words = value.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function displayValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  return "Bounded structured value";
}

export function ReturnGatePanel({ artifacts }: { artifacts: GovernedRunView["artifacts"] }) {
  return (
    <section className="governance-card">
      <div className="governance-card-heading"><span>Return Gate</span><EvidenceBadge quality={artifacts.length ? "OBSERVED" : "UNAVAILABLE"} /></div>
      {artifacts.length === 0 ? <p className="governance-unavailable">No task-correlated bounded return is available.</p> : artifacts.map((artifact) => (
        <div className="return-artifact" key={artifact.artifactId}>
          <div><strong>{artifact.type}</strong><small>{artifact.lifecycle.published ? "Published" : "Created"}</small></div>
          <dl>{Object.entries(artifact.boundedFields).map(([key, value]) => <div key={key}><dt>{displayName(key)}</dt><dd>{displayValue(value)}</dd></div>)}</dl>
        </div>
      ))}
    </section>
  );
}
