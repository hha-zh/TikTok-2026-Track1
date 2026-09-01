import type { JsonStore } from "../../store.js";
import type { GovernanceLedger } from "../../middleware/evidence/ledger.js";
import type {
  DelegationPort, ProducedArtifact, TaskExecutionRequest, TaskExecutionResult,
  TaskExecutor, TaskUsage,
} from "../../middleware/adaptive/execution-engine.js";
import { createArtifact, publishArtifact } from "../../middleware/governance/artifacts.js";
import { DelegationService, type ChildEnvelopeRequest } from "../../middleware/governance/delegation.js";
import { readManagedResource } from "../../middleware/governance/gates.js";
import type { AuthenticatedIdentity } from "../../middleware/governance/identity.js";
import type { Principal, ReasonCode } from "../../middleware/governance/types.js";
import {
  TYPE_ACCOMMODATION_OPTIONS, TYPE_IDENTITY_VERIFICATION, TYPE_TRANSPORT_OPTIONS,
} from "./artifacts.js";
import {
  A_ACCOMMODATION, A_CONSTRAINTS, A_FINAL, A_IDENTITY, A_ROUTE, A_TRANSPORT,
  A_VALIDATED, T0_UNDERSTAND, T1_TRANSPORT, T2_ACCOMMODATION, T3_ROUTE,
  T4_IDENTITY, T5_VALIDATE, T6_FINAL,
} from "./graph.js";
import {
  RESOURCE_ACCOMMODATION, RESOURCE_CALENDAR, RESOURCE_ITINERARY, RESOURCE_PASSPORT,
  RESOURCE_PREFERENCES, RESOURCE_ROUTES, RESOURCE_TRANSPORT,
} from "./resources.js";

type AgentIdentity = Extract<AuthenticatedIdentity, { kind: "agent" }>;

export const TRAVEL_ACTUAL_TOKENS: Record<string, number> = {
  [T0_UNDERSTAND]: 600, [T1_TRANSPORT]: 1800, [T2_ACCOMMODATION]: 1800,
  [T3_ROUTE]: 1400, [T4_IDENTITY]: 2000, [T5_VALIDATE]: 1000, [T6_FINAL]: 800,
};

const usage = (total: number): TaskUsage => ({ inputTokens: total, cachedInputTokens: 0, outputTokens: 0, totalTokens: total });

export interface TravelDelegationRecord {
  taskId: string;
  childPrincipalId: string;
  grantId: string;
}

export class TravelDelegationPort implements DelegationPort {
  readonly records: TravelDelegationRecord[] = [];
  private readonly service: DelegationService;

  constructor(private readonly store: JsonStore, ledger: GovernanceLedger) {
    this.service = new DelegationService({ store, ledger });
  }

  async delegate(input: Parameters<DelegationPort["delegate"]>[0]) {
    const identity: AgentIdentity = {
      kind: "agent", principalId: input.parentPrincipal.id, grantId: input.parentGrantId,
      runId: input.runId, principal: input.parentPrincipal,
    };
    const authority = input.task.delegatedAuthority ?? { resources: input.task.resources, actions: input.task.actions };
    const request: ChildEnvelopeRequest = {
      exercisable: { resources: [...authority.resources], actions: [...authority.actions] },
      delegatable: { resources: [], actions: [] }, maxTokens: input.task.estimatedTokens * 3,
      maxToolCalls: 4, maxChildren: 0,
    };
    const result = await this.service.delegate(identity, request);
    if (!result.ok) return { ok: false as const, reason: result.reason };
    this.records.push({ taskId: input.task.id, childPrincipalId: result.grant.childPrincipalId, grantId: result.grant.grantId });
    return { ok: true as const, childPrincipalId: result.grant.childPrincipalId, grantId: result.grant.grantId };
  }
}

export interface TravelDenial { taskId: string; resourceId: string; statusCode: number; reason: ReasonCode }

export class TravelFixtureExecutor implements TaskExecutor {
  readonly provenance = "DETERMINISTIC_SYNTHETIC_FIXTURE" as const;
  readonly denials: TravelDenial[] = [];
  readonly executions: { taskId: string; placement: string; principalId: string; included: string[]; withheld: string[] }[] = [];

  constructor(private readonly store: JsonStore, private readonly ledger: GovernanceLedger) {}

  private identity(principalId: string, grantId: string, runId: string): AgentIdentity | null {
    const principal: Principal | undefined = this.store.snapshot().principals.find((item) => item.id === principalId);
    return principal?.kind === "agent" ? { kind: "agent", principalId, grantId, runId, principal } : null;
  }

  async execute(request: TaskExecutionRequest): Promise<TaskExecutionResult> {
    const identity = this.identity(request.envelope.executorPrincipalId, request.envelope.sourceGrantId, request.envelope.runId);
    const taskUsage = usage(TRAVEL_ACTUAL_TOKENS[request.task.id] ?? request.task.estimatedTokens);
    this.executions.push({
      taskId: request.task.id, placement: request.placement, principalId: request.envelope.executorPrincipalId,
      included: request.context.included.map((item) => item.id), withheld: request.context.withheld.map((item) => item.id),
    });
    if (!identity) return { ok: false, producedArtifacts: [], usage: taskUsage, error: "executor identity missing" };
    switch (request.task.id) {
      case T0_UNDERSTAND: return this.triage(identity, taskUsage);
      case T1_TRANSPORT: return this.transport(identity, request.placement, taskUsage);
      case T2_ACCOMMODATION: return this.accommodation(identity, request.placement, taskUsage);
      case T3_ROUTE: return this.route(identity, request, taskUsage);
      case T4_IDENTITY: return this.identityVerification(identity, request, taskUsage);
      case T5_VALIDATE: return this.validate(request, taskUsage);
      case T6_FINAL: return this.finalize(request, taskUsage);
      default: return { ok: false, producedArtifacts: [], usage: taskUsage, error: "unknown travel task" };
    }
  }

  private async read(identity: AgentIdentity, resourceId: string) {
    return readManagedResource(identity, resourceId, { store: this.store, ledger: this.ledger });
  }

  private async triage(identity: AgentIdentity, taskUsage: TaskUsage): Promise<TaskExecutionResult> {
    const itinerary = await this.read(identity, RESOURCE_ITINERARY);
    const calendar = await this.read(identity, RESOURCE_CALENDAR);
    const preferences = await this.read(identity, RESOURCE_PREFERENCES);
    if (!itinerary.ok || !calendar.ok || !preferences.ok) return { ok: false, producedArtifacts: [], usage: taskUsage, error: "ordinary travel resource denied" };
    const passport = await this.read(identity, RESOURCE_PASSPORT);
    if (passport.ok) return { ok: false, producedArtifacts: [], usage: taskUsage, error: "root unexpectedly read passport" };
    this.denials.push({ taskId: T0_UNDERSTAND, resourceId: RESOURCE_PASSPORT, statusCode: passport.statusCode, reason: passport.reason });
    return { ok: true, usage: taskUsage, producedArtifacts: [{ id: A_CONSTRAINTS, value: {
      origin: "SIN", destination: "TOKYO", latest_arrival: "2026-09-02T13:00:00+09:00",
      max_additional_spend_sgd: 700, approval_threshold_sgd: 300,
    } }] };
  }

  private async publish(identity: AgentIdentity, placement: string, artifactType: string, resultName: string, fields: Record<string, unknown>, taskUsage: TaskUsage): Promise<TaskExecutionResult> {
    if (placement !== "DELEGATE_SPECIALIST") return { ok: true, producedArtifacts: [{ id: resultName, value: fields }], usage: taskUsage };
    const deps = { store: this.store, ledger: this.ledger };
    const created = await createArtifact(identity, { artifactType, fields }, deps);
    if (!created.ok) return { ok: false, producedArtifacts: [], usage: taskUsage, error: `artifact:create denied (${created.reason})` };
    const published = await publishArtifact(identity, created.value.id, { artifactType, fields }, deps);
    if (!published.ok) return { ok: false, producedArtifacts: [], usage: taskUsage, error: `artifact:publish denied (${published.reason})` };
    const artifact: ProducedArtifact = { id: resultName, value: published.value.fields, publishedArtifactId: published.value.id };
    return { ok: true, producedArtifacts: [artifact], usage: taskUsage };
  }

  private async transport(identity: AgentIdentity, placement: string, taskUsage: TaskUsage) {
    const inventory = await this.read(identity, RESOURCE_TRANSPORT);
    if (!inventory.ok) return { ok: false, producedArtifacts: [], usage: taskUsage, error: "transport inventory denied" };
    return this.publish(identity, placement, TYPE_TRANSPORT_OPTIONS, A_TRANSPORT, {
      recommended_option_id: "TR-ALT-02", booking_name_key: "TRAVELER_A", departure: "2026-09-02T01:20:00+08:00",
      arrival: "2026-09-02T09:30:00+09:00", arrival_airport: "HND", price_sgd: 420, reliability: "high",
    }, taskUsage);
  }

  private async accommodation(identity: AgentIdentity, placement: string, taskUsage: TaskUsage) {
    const inventory = await this.read(identity, RESOURCE_ACCOMMODATION);
    if (!inventory.ok) return { ok: false, producedArtifacts: [], usage: taskUsage, error: "accommodation inventory denied" };
    return this.publish(identity, placement, TYPE_ACCOMMODATION_OPTIONS, A_ACCOMMODATION, {
      recommended_option_id: "HT-03", check_in: "2026-09-01T18:00:00+08:00", location: "SIN_AIRPORT", price_sgd: 150, availability: "available",
    }, taskUsage);
  }

  private async route(identity: AgentIdentity, request: TaskExecutionRequest, taskUsage: TaskUsage): Promise<TaskExecutionResult> {
    const inventory = await this.read(identity, RESOURCE_ROUTES);
    if (!inventory.ok || !request.context.included.some((item) => item.id === A_TRANSPORT)) return { ok: false, producedArtifacts: [], usage: taskUsage, error: "route inputs missing" };
    return { ok: true, usage: taskUsage, producedArtifacts: [{ id: A_ROUTE, value: {
      route_option_id: "RT-HND-01", transport_option_id: "TR-ALT-02", booking_name_key: "TRAVELER_A",
      from_airport: "HND", arrival: "2026-09-02T11:00:00+09:00", price_sgd: 50, reliability: "high",
    } }] };
  }

  private async identityVerification(identity: AgentIdentity, request: TaskExecutionRequest, taskUsage: TaskUsage) {
    const ids = request.context.included.map((item) => item.id);
    if (!ids.includes(A_CONSTRAINTS) || !ids.includes(A_ROUTE)) return { ok: false, producedArtifacts: [], usage: taskUsage, error: "identity briefing incomplete" };
    const passport = await this.read(identity, RESOURCE_PASSPORT);
    if (!passport.ok) return { ok: false, producedArtifacts: [], usage: taskUsage, error: `child passport read denied (${passport.reason})` };
    const body = passport.value as { bookingNameKey?: string; validThrough?: string; destinationEligibility?: string[] };
    const yes = body.bookingNameKey === "TRAVELER_A" && body.validThrough === "2028-05-01" && body.destinationEligibility?.includes("JP");
    return this.publish(identity, request.placement, TYPE_IDENTITY_VERIFICATION, A_IDENTITY, {
      identity_verified: yes ? "yes" : "no", booking_name_matched: yes ? "yes" : "no",
      travel_document_valid: yes ? "yes" : "no", destination_eligible: yes ? "yes" : "no",
    }, taskUsage);
  }

  private validate(request: TaskExecutionRequest, taskUsage: TaskUsage): TaskExecutionResult {
    if (request.context.missingRequired.length > 0) return { ok: false, producedArtifacts: [], usage: taskUsage, error: "validation inputs missing" };
    return { ok: true, usage: taskUsage, producedArtifacts: [{ id: A_VALIDATED, value: {
      transport_option_id: "TR-ALT-02", accommodation_option_id: "HT-03", route_option_id: "RT-HND-01",
      arrival_before_deadline: "yes", total_additional_spend_sgd: 620, approval_required: "yes", confidence: "high",
    } }] };
  }

  private finalize(request: TaskExecutionRequest, taskUsage: TaskUsage): TaskExecutionResult {
    if (!request.context.included.some((item) => item.id === A_VALIDATED)) return { ok: false, producedArtifacts: [], usage: taskUsage, error: "validated plan missing" };
    return { ok: true, usage: taskUsage, producedArtifacts: [{ id: A_FINAL, value: {
      transport_option_id: "TR-ALT-02", accommodation_option_id: "HT-03", route_option_id: "RT-HND-01",
      final_arrival: "2026-09-02T11:00:00+09:00", total_additional_spend_sgd: 620,
      approval_required: "yes", status: "ready_for_approval",
    } }] };
  }
}
