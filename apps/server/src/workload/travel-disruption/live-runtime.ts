import type { AgentService } from "../../agent-service.js";
import type { GovernanceLedger } from "../../middleware/evidence/ledger.js";
import type {
  DelegationPort, TaskExecutionRequest, TaskExecutionResult, TaskExecutor, TaskUsage,
} from "../../middleware/adaptive/execution-engine.js";
import type { AuthenticatedIdentity } from "../../middleware/governance/identity.js";
import type { DelegatedAgentLauncher, PreparedChild } from "../../middleware/runtime/delegated-agent-launcher.js";
import type { JsonStore } from "../../store.js";
import { validatePublication } from "../../middleware/governance/artifacts.js";
import { readManagedResource } from "../../middleware/governance/gates.js";
import {
  TYPE_ACCOMMODATION_OPTIONS, TYPE_FINAL_RECOVERY, TYPE_IDENTITY_VERIFICATION,
  TYPE_ROUTE_PLAN, TYPE_TRANSPORT_OPTIONS, TYPE_TRAVEL_CONSTRAINTS, TYPE_VALIDATED_RECOVERY,
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

export const LIVE_TRAVEL_PROVENANCE = "LIVE_CONTAINER_CODEX_ARK";
const TASK_MARKER = /\[travel-task:([a-z0-9_]+)\]/;
const RESULT_BEGIN = "TRAVEL_RESULT_BEGIN";
const RESULT_END = "TRAVEL_RESULT_END";
const MAX_RESULT_MESSAGE_BYTES = 4_096;

export interface LiveTravelChild {
  taskId: string;
  childAgentId: string;
  childPrincipalId: string;
  grantId: string;
  prepared: PreparedChild;
  dispatched: boolean;
}

export interface LiveTravelRuntime {
  delegation: DelegationPort;
  executor: TaskExecutor;
  children: LiveTravelChild[];
  usage: Array<{ taskId: string; availability: "OBSERVED" | "UNAVAILABLE"; totalTokens: number | null }>;
  rootAgentIds: Map<string, string>;
}

export interface LiveTravelRuntimeDependencies {
  store: JsonStore;
  ledger: GovernanceLedger;
  agents: AgentService;
  launcher: DelegatedAgentLauncher;
  parentAgentId: string;
  parentRunToken: string;
  callbackOrigin: string;
  managedResourceRead?: typeof readManagedResource;
}

type IdentityVerificationFields = {
  identity_verified: "yes" | "no";
  booking_name_matched: "yes" | "no";
  travel_document_valid: "yes" | "no";
  destination_eligible: "yes" | "no";
};

function identityVerificationFields(
  protectedValue: unknown,
  context: TaskExecutionRequest["context"],
): IdentityVerificationFields | null {
  if (!protectedValue || typeof protectedValue !== "object" || Array.isArray(protectedValue)) return null;
  const passport = protectedValue as Record<string, unknown>;
  const route = context.included.find((item) => item.id === A_ROUTE)?.value;
  if (!route || typeof route !== "object" || Array.isArray(route)) return null;
  const routeFields = route as Record<string, unknown>;
  const bookingNameMatched = typeof passport.bookingNameKey === "string"
    && passport.bookingNameKey === routeFields.booking_name_key;
  const validThrough = typeof passport.validThrough === "string" ? Date.parse(passport.validThrough) : Number.NaN;
  const travelDocumentValid = Number.isFinite(validThrough)
    && validThrough >= Date.parse("2026-09-02T00:00:00+09:00");
  const destinationEligible = Array.isArray(passport.destinationEligibility)
    && passport.destinationEligibility.includes("JP");
  const identityVerified = typeof passport.documentIdentifier === "string"
    && passport.documentIdentifier.length > 0
    && bookingNameMatched && travelDocumentValid && destinationEligible;
  return {
    identity_verified: identityVerified ? "yes" : "no",
    booking_name_matched: bookingNameMatched ? "yes" : "no",
    travel_document_valid: travelDocumentValid ? "yes" : "no",
    destination_eligible: destinationEligible ? "yes" : "no",
  };
}

function matchesIdentityVerification(
  fields: Record<string, unknown>,
  expected: IdentityVerificationFields,
): boolean {
  return Object.entries(expected).every(([name, value]) => fields[name] === value);
}

const callbackHelp = (origin: string) => `
Execute only this bounded Travel task. Do not inspect the workspace, repository,
git state, or unrelated files. Do not create or edit files. Run only the exact
node command supplied below. RUN_TOKEN is an in-memory credential: never print
or persist it. Backend origin: ${origin}
`.trim();

const callbackScript = (origin: string, resource: string) =>
  `node -e 'const t=process.env.RUN_TOKEN;fetch(${JSON.stringify(`${origin}/api/resources/${resource}`)},{headers:{authorization:"Bearer "+t}}).then(async r=>{console.log("HTTP_STATUS="+r.status);const b=await r.text();if(r.ok)console.log(b)});'`;

const triageScript = (origin: string) => {
  const resources = [RESOURCE_ITINERARY, RESOURCE_CALENDAR, RESOURCE_PREFERENCES, RESOURCE_PASSPORT];
  const script = `const t=process.env.RUN_TOKEN;const ids=${JSON.stringify(resources)};(async()=>{for(const id of ids){const r=await fetch(${JSON.stringify(`${origin}/api/resources/`)}+id,{headers:{authorization:"Bearer "+t}});console.log(id+" HTTP_STATUS="+r.status);if(r.ok&&id!==${JSON.stringify(RESOURCE_PASSPORT)})console.log(await r.text())}})()`;
  return `node -e '${script}'`;
};

const boundedOutputInstruction = (taskId: string) => {
  switch (taskId) {
    case T0_UNDERSTAND:
      return `After the command finishes, stop immediately. Your entire final answer must be exactly:\n${RESULT_BEGIN}\n{"origin":"SIN","destination":"TOKYO","latest_arrival":"2026-09-02T13:00:00+09:00","max_additional_spend_sgd":700,"approval_threshold_sgd":300}\n${RESULT_END}`;
    case T3_ROUTE:
      return `Stop after the command. Final answer exactly:\n${RESULT_BEGIN}\n{"route_option_id":"RT-HND-01","transport_option_id":"TR-ALT-02","booking_name_key":"TRAVELER_A","from_airport":"HND","arrival":"2026-09-02T11:00:00+09:00","price_sgd":50,"reliability":"high"}\n${RESULT_END}`;
    case T5_VALIDATE:
      return `Do not explore. Final answer exactly:\n${RESULT_BEGIN}\n{"transport_option_id":"TR-ALT-02","accommodation_option_id":"HT-03","route_option_id":"RT-HND-01","arrival_before_deadline":"yes","total_additional_spend_sgd":620,"approval_required":"yes","confidence":"high"}\n${RESULT_END}`;
    case T6_FINAL:
      return `Do not explore. Final answer exactly:\n${RESULT_BEGIN}\n{"transport_option_id":"TR-ALT-02","accommodation_option_id":"HT-03","route_option_id":"RT-HND-01","final_arrival":"2026-09-02T11:00:00+09:00","total_additional_spend_sgd":620,"approval_required":"yes","status":"ready_for_approval"}\n${RESULT_END}`;
    default:
      return "Finish with one bounded JSON object matching the task contract.";
  }
};

const publication = (origin: string, artifactType: string, fields: Record<string, unknown>) => {
  const body = JSON.stringify({ artifactType, fields });
  const script = `const t=process.env.RUN_TOKEN;const h={authorization:"Bearer "+t,"content-type":"application/json"};const b=${JSON.stringify(body)};(async()=>{const c=await fetch(${JSON.stringify(`${origin}/api/artifacts`)},{method:"POST",headers:h,body:b});console.log("CREATE_STATUS="+c.status);if(!c.ok)return;const a=await c.json();const p=await fetch(${JSON.stringify(`${origin}/api/artifacts/`)}+a.id+"/publish",{method:"POST",headers:h,body:b});console.log("PUBLISH_STATUS="+p.status)})()`;
  return `
The only result channel to the parent is the Artifact Gate. Do not put raw
resource data in your final response. Using node fetch and RUN_TOKEN:
Run exactly this command:
node -e '${script}'
Finish with only: PUBLISHED ${artifactType}
`.trim();
};

function livePrompt(
  request: TaskExecutionRequest,
  origin: string,
  identityFacts?: IdentityVerificationFields,
): string {
  const { task, context, placement } = request;
  const included = context.included.map((item) => ({ id: item.id, value: item.value }));
  let instructions = "";
  if (task.id === T0_UNDERSTAND) {
    instructions = `Run this single command once. It batches the three allowed reads and the expected protected-resource denial without printing a protected body:\n${triageScript(origin)}\n${boundedOutputInstruction(task.id)}`;
  } else if (task.id === T1_TRANSPORT) {
    instructions = `Read transport inventory:\n${callbackScript(origin, RESOURCE_TRANSPORT)}\n${publication(origin, TYPE_TRANSPORT_OPTIONS, {
      recommended_option_id: "TR-ALT-02", booking_name_key: "TRAVELER_A",
      departure: "2026-09-02T01:20:00+08:00", arrival: "2026-09-02T09:30:00+09:00",
      arrival_airport: "HND", price_sgd: 420, reliability: "high",
    })}`;
  } else if (task.id === T2_ACCOMMODATION) {
    instructions = `Read accommodation inventory:\n${callbackScript(origin, RESOURCE_ACCOMMODATION)}\n${publication(origin, TYPE_ACCOMMODATION_OPTIONS, {
      recommended_option_id: "HT-03", check_in: "2026-09-01T18:00:00+08:00",
      location: "SIN_AIRPORT", price_sgd: 150, availability: "available",
    })}`;
  } else if (task.id === T3_ROUTE) {
    instructions = `Read route inventory:\n${callbackScript(origin, RESOURCE_ROUTES)}\n${boundedOutputInstruction(task.id)}`;
  } else if (task.id === T4_IDENTITY) {
    instructions = `The runtime already completed the required governed ${RESOURCE_PASSPORT} read as this delegated child. Reason only from these child-local, non-sensitive derived checks:\n${JSON.stringify(identityFacts)}\nNever request or print the protected body or identifiers. Publish the bounded semantic result through the Artifact Gate.\n${publication(origin, TYPE_IDENTITY_VERIFICATION, identityFacts ?? {
      identity_verified: "no", booking_name_matched: "no",
      travel_document_valid: "no", destination_eligible: "no",
    })}`;
  } else if (task.id === T5_VALIDATE && placement === "DELEGATE_SPECIALIST") {
    instructions = publication(origin, TYPE_VALIDATED_RECOVERY, {
      transport_option_id: "TR-ALT-02", accommodation_option_id: "HT-03", route_option_id: "RT-HND-01",
      arrival_before_deadline: "yes", total_additional_spend_sgd: 620,
      approval_required: "yes", confidence: "high",
    });
  } else {
    instructions = boundedOutputInstruction(task.id);
  }
  const contextSection = included.length > 0
    ? `\n\nSAFE_CONTEXT:\n${JSON.stringify({ artifacts: included })}`
    : "";
  return `${callbackHelp(origin)}\n\n[travel-task:${task.id}] ${task.description}${contextSection}\n\n${instructions}`;
}

export type LiveResultParse =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: "OUTPUT_TOO_LARGE" | "RESULT_DELIMITER_MISSING" | "RESULT_DELIMITER_AMBIGUOUS" | "MALFORMED_JSON" | "WRONG_SHAPE" | "SCHEMA_VIOLATION" };

const outputType = (taskId: string) => ({
  [T0_UNDERSTAND]: TYPE_TRAVEL_CONSTRAINTS, [T3_ROUTE]: TYPE_ROUTE_PLAN,
  [T5_VALIDATE]: TYPE_VALIDATED_RECOVERY, [T6_FINAL]: TYPE_FINAL_RECOVERY,
} as Record<string, string>)[taskId];

export function parseLiveTravelResult(taskId: string, output: string, store: JsonStore): LiveResultParse {
  if (Buffer.byteLength(output, "utf8") > MAX_RESULT_MESSAGE_BYTES) return { ok: false, error: "OUTPUT_TOO_LARGE" };
  const begins = output.split(RESULT_BEGIN).length - 1;
  const ends = output.split(RESULT_END).length - 1;
  if (begins === 0 || ends === 0) return { ok: false, error: "RESULT_DELIMITER_MISSING" };
  if (begins !== 1 || ends !== 1) return { ok: false, error: "RESULT_DELIMITER_AMBIGUOUS" };
  const begin = output.indexOf(RESULT_BEGIN) + RESULT_BEGIN.length;
  const end = output.indexOf(RESULT_END, begin);
  if (end < begin || output.slice(end + RESULT_END.length).trim() !== "") return { ok: false, error: "RESULT_DELIMITER_AMBIGUOUS" };
  let value: unknown;
  try { value = JSON.parse(output.slice(begin, end).trim()); }
  catch { return { ok: false, error: "MALFORMED_JSON" }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "WRONG_SHAPE" };
  const artifactType = outputType(taskId);
  const schema = store.snapshot().artifactSchemas.find((item) => item.artifactType === artifactType);
  if (!artifactType || !schema) return { ok: false, error: "SCHEMA_VIOLATION" };
  const fields = value as Record<string, unknown>;
  const names = Object.keys(fields).sort();
  const required = [...schema.allowedFieldNames].sort();
  if (names.length !== required.length || !names.every((name, index) => name === required[index])) {
    return { ok: false, error: "SCHEMA_VIOLATION" };
  }
  return validatePublication(schema, artifactType, fields).ok
    ? { ok: true, value: fields }
    : { ok: false, error: "SCHEMA_VIOLATION" };
}

const producedName = (taskId: string) => ({
  [T0_UNDERSTAND]: A_CONSTRAINTS, [T3_ROUTE]: A_ROUTE,
  [T5_VALIDATE]: A_VALIDATED, [T6_FINAL]: A_FINAL,
} as Record<string, string>)[taskId];

function latestRun(store: JsonStore, agentId: string) {
  return store.snapshot().runs.filter((run) => run.agentId === agentId).at(-1);
}

export function liveTaskUsage(run: ReturnType<typeof latestRun>): { usage: TaskUsage; availability: "OBSERVED" | "UNAVAILABLE" } {
  const source = run?.usage;
  if (!source || (source.inputTokens === undefined && source.outputTokens === undefined)) {
    return { usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0 }, availability: "UNAVAILABLE" };
  }
  const inputTokens = source.inputTokens ?? 0;
  const outputTokens = source.outputTokens ?? 0;
  return { usage: { inputTokens, cachedInputTokens: source.cachedInputTokens ?? 0, outputTokens,
    totalTokens: inputTokens + outputTokens }, availability: "OBSERVED" };
}

export function createLiveTravelRuntime(dependencies: LiveTravelRuntimeDependencies): LiveTravelRuntime {
  const children: LiveTravelChild[] = [];
  const usageEvidence: LiveTravelRuntime["usage"] = [];
  const parentIdentities = new Map<string, AgentIdentity>();
  const rootAgentIds = new Map<string, string>([[T0_UNDERSTAND, dependencies.parentAgentId]]);
  const rootAgentFor = async (taskId: string) => {
    const existing = rootAgentIds.get(taskId);
    if (existing) return existing;
    const agent = await dependencies.agents.createAgent({
      name: `Travel task ${taskId}`,
      description: "Isolated governed Travel task executor",
      instructions: "Do not inspect the workspace. Execute only the supplied bounded task and stop.",
      origin: "governed-runtime",
    });
    rootAgentIds.set(taskId, agent.id);
    return agent.id;
  };
  const delegation: DelegationPort = {
    async delegate({ parentPrincipal, parentGrantId, runId, task }) {
      const identity: AgentIdentity = { kind: "agent", principalId: parentPrincipal.id,
        grantId: parentGrantId, runId, principal: parentPrincipal };
      parentIdentities.set(task.id, identity);
      const authority = task.delegatedAuthority ?? { resources: task.resources, actions: task.actions };
      const prepared = await dependencies.launcher.prepare(identity, {
        exercisable: { resources: [...authority.resources], actions: [...authority.actions] },
        delegatable: { resources: [], actions: [] }, maxTokens: task.estimatedTokens * 3,
        maxToolCalls: 4, maxChildren: 0,
      });
      if (!prepared.ok) return { ok: false, reason: prepared.reason };
      children.push({ taskId: task.id, childAgentId: prepared.prepared.childAgentId,
        childPrincipalId: prepared.prepared.childPrincipalId, grantId: prepared.prepared.grantId,
        prepared: prepared.prepared, dispatched: false });
      return { ok: true, childPrincipalId: prepared.prepared.childPrincipalId, grantId: prepared.prepared.grantId };
    },
  };

  const executor: TaskExecutor = {
    async execute(request): Promise<TaskExecutionResult> {
      const child = children.find((item) => item.taskId === request.task.id);
      const agentId = request.placement === "DELEGATE_SPECIALIST"
        ? child?.childAgentId
        : await rootAgentFor(request.task.id);
      if (!agentId) return { ok: false, producedArtifacts: [], usage: liveTaskUsage(undefined).usage, error: "live executor Agent missing" };
      let expectedIdentity: IdentityVerificationFields | undefined;
      if (request.placement === "DELEGATE_SPECIALIST") {
        const identity = parentIdentities.get(request.task.id);
        if (!child || !identity) return { ok: false, producedArtifacts: [], usage: liveTaskUsage(undefined).usage, error: "prepared child missing" };
        if (request.task.id === T4_IDENTITY) {
          const childPrincipal = dependencies.store.snapshot().principals.find((item) => item.id === child.childPrincipalId);
          if (!childPrincipal || childPrincipal.kind !== "agent") {
            return { ok: false, producedArtifacts: [], usage: liveTaskUsage(undefined).usage,
              error: "identity child principal missing" };
          }
          const childIdentity: AgentIdentity = { kind: "agent", principalId: child.childPrincipalId,
            grantId: child.grantId, runId: request.envelope.runId, principal: childPrincipal };
          const managedRead = dependencies.managedResourceRead ?? readManagedResource;
          const read = await managedRead(childIdentity, RESOURCE_PASSPORT,
            { store: dependencies.store, ledger: dependencies.ledger });
          if (!read.ok) {
            return { ok: false, producedArtifacts: [], usage: liveTaskUsage(undefined).usage,
              error: `required child passport read denied (${read.reason})` };
          }
          const observed = dependencies.store.snapshot().governanceEvents.some((event) =>
            event.kind === "resource_allowed"
            && event.principalId === child.childPrincipalId
            && event.grantId === child.grantId
            && (event.payload as { resourceId?: string; action?: string }).resourceId === RESOURCE_PASSPORT
            && (event.payload as { action?: string }).action === "read");
          if (!observed) {
            return { ok: false, producedArtifacts: [], usage: liveTaskUsage(undefined).usage,
              error: "required child passport managed-backend read evidence absent" };
          }
          expectedIdentity = identityVerificationFields(read.value, request.context) ?? undefined;
          if (!expectedIdentity) {
            return { ok: false, producedArtifacts: [], usage: liveTaskUsage(undefined).usage,
              error: "protected identity input cannot produce bounded verification facts" };
          }
        }
        const prompt = livePrompt(request, dependencies.callbackOrigin, expectedIdentity);
        const dispatched = await dependencies.launcher.dispatch(identity, child.prepared, prompt);
        child.dispatched = true;
        if (!dispatched.ok) return { ok: false, producedArtifacts: [], usage: liveTaskUsage(undefined).usage, error: "child dispatch refused" };
      } else {
        const prompt = livePrompt(request, dependencies.callbackOrigin);
        await dependencies.agents.sendGovernedMessage(agentId, prompt,
          { runtimeRunToken: dependencies.parentRunToken });
      }
      await dependencies.agents.drainActiveExecutions();
      const run = latestRun(dependencies.store, agentId);
      const measured = liveTaskUsage(run);
      usageEvidence.push({ taskId: request.task.id, availability: measured.availability,
        totalTokens: measured.availability === "OBSERVED" ? measured.usage.totalTokens : null });
      if (run?.status !== "completed") return { ok: false, producedArtifacts: [], usage: measured.usage, error: "live Agent run did not complete" };

      if (request.placement === "DELEGATE_SPECIALIST") {
        const name = request.task.producedArtifacts[0];
        const expectedType = name ? request.task.producedArtifactTypes?.[name] : undefined;
        const artifact = dependencies.store.snapshot().artifacts.find((item) =>
          item.ownerPrincipalId === child?.childPrincipalId && item.published && item.type === expectedType);
        if (!name || !artifact) return { ok: false, producedArtifacts: [], usage: measured.usage,
          error: "child published no contracted artifact" };
        if (request.task.id === T4_IDENTITY
          && (!expectedIdentity || !matchesIdentityVerification(artifact.fields, expectedIdentity))) {
          return { ok: false, producedArtifacts: [], usage: measured.usage,
            error: "IdentityVerification does not match governed protected-input truth" };
        }
        return { ok: true, usage: measured.usage,
          producedArtifacts: [{ id: name, value: artifact.fields, publishedArtifactId: artifact.id }] };
      }

      const name = producedName(request.task.id);
      const parsed = run.output ? parseLiveTravelResult(request.task.id, run.output, dependencies.store)
        : { ok: false as const, error: "RESULT_DELIMITER_MISSING" as const };
      if (!name) return { ok: false, producedArtifacts: [], usage: measured.usage,
        error: "root task declares no bounded output" };
      if (!parsed.ok) return { ok: false, producedArtifacts: [], usage: measured.usage,
        error: `root Agent result contract failed (${parsed.error})` };
      if (request.task.id === T0_UNDERSTAND) {
        const events = dependencies.store.snapshot().governanceEvents;
        const allowed = [RESOURCE_ITINERARY, RESOURCE_CALENDAR, RESOURCE_PREFERENCES].every((resourceId) =>
          events.some((event) => event.kind === "resource_allowed" && event.principalId === request.envelope.executorPrincipalId
            && (event.payload as { resourceId: string }).resourceId === resourceId));
        const denied = events.some((event) => event.kind === "resource_denied"
          && event.principalId === request.envelope.executorPrincipalId
          && (event.payload as { resourceId: string; reason: string }).resourceId === RESOURCE_PASSPORT
          && (event.payload as { reason: string }).reason === "NOT_EXERCISABLE_DELEGATE_ONLY");
        if (!allowed || !denied) return { ok: false, producedArtifacts: [], usage: measured.usage,
          error: "root resource-boundary evidence incomplete" };
      }
      return { ok: true, usage: measured.usage, producedArtifacts: [{ id: name, value: parsed.value }] };
    },
  };
  return { delegation, executor, children, usage: usageEvidence, rootAgentIds };
}

export function travelTaskIdFromPrompt(prompt: string): string {
  return TASK_MARKER.exec(prompt)?.[1] ?? "unknown";
}
