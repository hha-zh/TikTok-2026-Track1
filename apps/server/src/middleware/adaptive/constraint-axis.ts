/**
 * Explanatory classification of a hard verdict.
 *
 * EXPLANATORY ONLY. This changes no verdict, creates no permission, replaces
 * nothing, and is not a second policy system. `authorize()` remains the single
 * hard primitive and its `ReasonCode` is always preserved alongside the axis.
 *
 * Why it exists: enforcement ownership and explanatory dimension are different
 * questions. Bouncer correctly enforces `maxChildren` through `authorize()`,
 * but "you may not touch that resource" and "you may touch it, and you have run
 * out of room to expand" are not the same story to tell. Flattening both into
 * "authority denied" loses the distinction the runtime actually acted on.
 */

import type { ReasonCode } from "../governance/types.js";

export type ConstraintAxis =
  /** Nothing was refused. */
  | "NONE"
  /** The principal may not reach this resource, action or scope. */
  | "AUTHORITY_SCOPE"
  /** Permitted, but the run has no room left to expand into. */
  | "EXECUTION_HORIZON"
  /** The grant is no longer live. */
  | "LIFECYCLE"
  /** Accumulated usage against a stored cap. */
  | "BUDGET_ACCOUNTING"
  /** What may cross the Return Gate, and to whom. */
  | "DECLASSIFICATION"
  /** The request could not be trusted or understood. */
  | "REQUEST_INTEGRITY";

/**
 * Follows the actual ReasonCode union, not an idealised one.
 *
 * Total by construction: every code maps, so a new code added later fails the
 * exhaustiveness check rather than silently defaulting to a wrong axis.
 */
export function constraintAxisFor(reason: ReasonCode): ConstraintAxis {
  switch (reason) {
    case "AUTHORIZED":
      return "NONE";

    case "RESOURCE_NOT_GRANTED":
    case "NOT_EXERCISABLE_DELEGATE_ONLY":
    case "ACTION_NOT_GRANTED":
    case "CHILD_EXCEEDS_PARENT":
      return "AUTHORITY_SCOPE";

    // Enforced by authorize(); explained as horizon. The verdict is untouched.
    case "MAX_CHILDREN_EXCEEDED":
    case "DELEGATION_CEILING_REACHED":
      return "EXECUTION_HORIZON";

    case "PARENT_GRANT_REVOKED":
    case "PARENT_GRANT_EXPIRED":
      return "LIFECYCLE";

    case "BUDGET_EXCEEDED":
      return "BUDGET_ACCOUNTING";

    case "ARTIFACT_TYPE_NOT_GRANTED":
    case "ARTIFACT_SCHEMA_VIOLATION":
    case "ARTIFACT_NOT_PUBLISHED":
    case "ARTIFACT_NOT_RECIPIENT":
      return "DECLASSIFICATION";

    case "INVALID_TOKEN":
    case "PRINCIPAL_NOT_FOUND":
    case "GRANT_NOT_FOUND":
    case "MALFORMED_INPUT":
      return "REQUEST_INTEGRITY";

    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}
