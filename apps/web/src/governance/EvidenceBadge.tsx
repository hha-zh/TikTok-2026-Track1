import type { EvidenceQuality } from "./types";

export function EvidenceBadge({ quality }: { quality: EvidenceQuality }) {
  return <span className={`evidence-badge evidence-${quality.toLowerCase()}`}>{quality}</span>;
}
