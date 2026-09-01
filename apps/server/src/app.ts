import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import type { AgentService } from "./agent-service.js";
import type {
  AuthenticatedIdentity,
  IdentityDependencies,
} from "./middleware/governance/identity.js";
import { verifyIdentity } from "./middleware/governance/identity.js";
import { RunTokenService } from "./middleware/governance/run-token.js";
import type { GovernanceLedger } from "./middleware/evidence/ledger.js";
import {
  buildGovernedRunView,
  type GovernedRunDescriptor,
} from "./middleware/evidence/governed-run-view.js";
import {
  invokeTrustedTool,
  readManagedResource,
} from "./middleware/governance/gates.js";
import { HumanRevocationService } from "./middleware/governance/revocation.js";
import {
  DelegationService,
  type ChildEnvelopeRequest,
} from "./middleware/governance/delegation.js";
import { DelegatedAgentLauncher } from "./middleware/runtime/delegated-agent-launcher.js";
import { startGovernedRun } from "./middleware/governance/fixtures.js";
import {
  createArtifact,
  publishArtifact,
  readArtifact,
} from "./middleware/governance/artifacts.js";
import { formatFinalTravelRecoveryPlan, startRealTravelDemoRun, startTravelDemoRun } from "./workload/travel-disruption/demo-run.js";

interface GovernanceDependencies extends IdentityDependencies {
  ledger: GovernanceLedger;
  governedRunDescriptor?: (runId: string) => GovernedRunDescriptor | undefined;
}

declare module "fastify" {
  interface FastifyRequest {
    governanceIdentity: AuthenticatedIdentity | null;
  }
}

const agentIdParams = z.object({ id: z.string().uuid() });
const runIdParams = z.object({ id: z.string().uuid() });
const createAgentBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  instructions: z.string().max(10_000).optional(),
});
const updateAgentBody = createAgentBody.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required",
);
const messageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
});
const governedRunBody = z
  .object({
    agentId: z.string().uuid(),
    task: z.string().trim().min(1).max(20_000),
  })
  .strict();
const travelDemoRunBody = z
  .object({
    request: z.string().trim().min(1).max(20_000).optional(),
    executionMode: z.enum(["deterministic", "real"]).default("deterministic"),
    agentId: z.string().uuid().optional(),
  })
  .strict();

/** Matches the child token lifetime in the delegated launcher. */
const PARENT_TOKEN_TTL_SECONDS = 15 * 60;

const artifactFields = z.record(z.string().min(1).max(64), z.unknown());
const createArtifactBody = z
  .object({
    artifactType: z.string().trim().min(1).max(100),
    fields: artifactFields,
  })
  .strict();
const publishArtifactBody = z
  .object({
    artifactType: z.string().trim().min(1).max(100),
    fields: artifactFields,
    recipients: z.array(z.string().trim().min(1).max(200)).max(16).optional(),
  })
  .strict();
const authoritySet = z
  .object({
    resources: z.array(z.string().trim().min(1).max(200)).max(100),
    actions: z.array(z.string().trim().min(1).max(100)).max(100),
  })
  .strict();
const childEnvelopeBody = z
  .object({
    exercisable: authoritySet,
    delegatable: authoritySet.optional(),
    maxTokens: z.number().int().nonnegative(),
    maxToolCalls: z.number().int().nonnegative(),
    maxChildren: z.number().int().nonnegative(),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
    task: z.string().trim().min(1).max(20_000),
  })
  .strict();

export async function createApp(
  config: AppConfig,
  service: AgentService,
  identityDependencies?: IdentityDependencies & Partial<Pick<GovernanceDependencies, "ledger" | "governedRunDescriptor">>,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    bodyLimit: 1_048_576,
  });

  await app.register(cors, {
    origin:
      config.nodeEnv === "development"
        ? ["http://localhost:5173", "http://127.0.0.1:5173"]
        : false,
  });

  app.decorateRequest("governanceIdentity", null);
  const revocations = identityDependencies?.ledger
    ? new HumanRevocationService(identityDependencies.store, identityDependencies.ledger)
    : null;
  const delegations = identityDependencies?.ledger
    ? new DelegationService({
        store: identityDependencies.store,
        ledger: identityDependencies.ledger,
      })
    : null;
  const delegatedAgents = identityDependencies?.ledger && delegations
    ? new DelegatedAgentLauncher({
        config,
        store: identityDependencies.store,
        ledger: identityDependencies.ledger,
        runTokens: identityDependencies.runTokens,
        delegation: delegations,
        agents: service,
      })
    : null;

  app.addHook("onRequest", async (request, reply) => {
    const authorizationHeader = request.headers.authorization;
    const bearer = authorizationHeader?.startsWith("Bearer ")
      ? authorizationHeader.slice(7)
      : undefined;
    const principalHeader = request.headers["x-principal-id"];
    const principalId =
      typeof principalHeader === "string" ? principalHeader : undefined;
    const runtimeCredential = bearer && RunTokenService.hasTokenMarker(bearer);

    if (runtimeCredential) {
      if (!identityDependencies) {
        return reply.code(401).send({ error: "Runtime authentication failed" });
      }
      const result = verifyIdentity(
        {
          authorizationHeader: authorizationHeader ?? "",
          ...(principalId ? { principalHeader: principalId } : {}),
        },
        identityDependencies,
      );
      if (!result.ok || result.identity.kind !== "agent") {
        return reply.code(401).send({ error: "Runtime authentication failed" });
      }
      request.governanceIdentity = result.identity;
      const pathname = request.url.split("?", 1)[0] ?? "";
      if (
        pathname === "/api/runtime/identity" ||
        pathname === "/api/delegations" ||
        pathname === "/api/artifacts" ||
        pathname.startsWith("/api/artifacts/") ||
        pathname.startsWith("/api/resources/") ||
        pathname.startsWith("/api/tools/")
      ) return;
    } else if (principalId && identityDependencies) {
      const result = verifyIdentity(
        { principalHeader: principalId },
        identityDependencies,
      );
      if (!result.ok || result.identity.kind !== "human") {
        return reply.code(401).send({ error: "Principal authentication failed" });
      }
      request.governanceIdentity = result.identity;
    }

    if (
      !config.authToken ||
      !request.url.startsWith("/api/") ||
      request.url === "/api/health" ||
      request.url === "/api/auth"
    ) {
      return;
    }
    const header = request.headers.authorization ?? "";
    const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
    const expectedBuffer = Buffer.from(config.authToken);
    const candidateBuffer = Buffer.from(candidate);
    const valid =
      candidateBuffer.length === expectedBuffer.length &&
      timingSafeEqual(candidateBuffer, expectedBuffer);
    if (!valid) {
      return reply.code(401).send({ error: "Authentication required" });
    }
  });

  app.get("/api/health", async () => ({
    ok: true,
    service: "volc-agent-launchpad",
  }));

  app.get("/api/auth", async () => ({ required: config.authToken.length > 0 }));

  app.get("/api/system", async () => service.systemInfo());

  app.get("/api/runtime/identity", async (request, reply) => {
    const identity = request.governanceIdentity;
    if (!identity || identity.kind !== "agent") {
      return reply.code(401).send({ error: "Runtime authentication required" });
    }
    return {
      principalId: identity.principalId,
      grantId: identity.grantId,
      runId: identity.runId,
      kind: identity.kind,
    };
  });

  app.get("/api/governance/runs/:id", async (request, reply) => {
    const identity = request.governanceIdentity;
    if (!identity || identity.kind !== "human") {
      return reply.code(401).send({ error: "Human authentication required" });
    }
    if (!identityDependencies?.ledger) {
      return reply.code(503).send({ error: "Governance unavailable" });
    }
    const parsed = z.object({ id: z.string().trim().min(1).max(200) }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "Malformed request" });
    const database = identityDependencies.store.snapshot();
    const root = database.envelopes.find((item) =>
      item.runId === parsed.data.id && item.parentGrantId === undefined);
    const principal = root
      ? database.principals.find((item) => item.id === root.principalId)
      : undefined;
    if (!root || principal?.ownerId !== identity.principalId) {
      return reply.code(404).send({ error: "Not found" });
    }
    const view = buildGovernedRunView(
      identityDependencies.store,
      parsed.data.id,
      identityDependencies.governedRunDescriptor?.(parsed.data.id),
    );
    return view ? reply.send({ run: view }) : reply.code(404).send({ error: "Not found" });
  });

  app.post("/api/governance/travel-demo-runs", async (request, reply) => {
    if (!identityDependencies?.ledger) {
      return reply.code(503).send({ error: "Governance unavailable" });
    }
    const parsed = travelDemoRunBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "malformed_input", reason: "MALFORMED_INPUT" });
    }
    if (parsed.data.executionMode === "real"
      && (config.runtimeProvider !== "container" || ["127.0.0.1", "::1", "localhost"].includes(config.host))) {
      return reply.code(503).send({
        error: "Real Travel mode requires RUNTIME_PROVIDER=container and HOST=0.0.0.0",
      });
    }
    if (parsed.data.executionMode === "real" && !parsed.data.agentId) {
      return reply.code(400).send({ error: "Persistent user Agent is required" });
    }
    if (parsed.data.agentId) {
      const target = service.getAgent(parsed.data.agentId);
      if (target.origin !== "user") return reply.code(400).send({ error: "Persistent user Agent is required" });
    }
    const requestedRunId = `${parsed.data.executionMode === "real" ? "travel-real" : "travel-demo"}-${randomUUID()}`;
    if (parsed.data.agentId) {
      await service.beginGovernedConversation(parsed.data.agentId, requestedRunId,
        parsed.data.request ?? "Travel recovery request");
    }
    let demo;
    try {
      demo = parsed.data.executionMode === "real"
        ? await startRealTravelDemoRun({ config, store: identityDependencies.store,
            ledger: identityDependencies.ledger, runTokens: identityDependencies.runTokens,
            agents: service, runId: requestedRunId })
        : await startTravelDemoRun(identityDependencies.store, identityDependencies.ledger,
            config.nodeEnv === "test" ? 10 : 1_500, requestedRunId);
    } catch (error) {
      if (parsed.data.agentId) await service.failGovernedConversation(parsed.data.agentId, error);
      throw error;
    }
    void demo.completion.then(async (finalResult) => {
      if (parsed.data.agentId) {
        await service.completeGovernedConversation(parsed.data.agentId, demo.runId,
          formatFinalTravelRecoveryPlan(finalResult));
      }
    }).catch(async (error: unknown) => {
      if (parsed.data.agentId) await service.failGovernedConversation(parsed.data.agentId, error);
      app.log.error({ err: error, runId: demo.runId }, "Travel demo run failed");
    });
    return reply.code(202).send({ runId: demo.runId, principalId: demo.principalId,
      executionMode: parsed.data.executionMode });
  });

  app.get("/api/resources/*", async (request, reply) => {
    const identity = request.governanceIdentity;
    if (!identity || identity.kind !== "agent") {
      return reply.code(401).send({ error: "Runtime authentication required" });
    }
    if (!identityDependencies?.ledger) {
      return reply.code(503).send({ error: "Governance unavailable" });
    }
    const resourceId = (request.params as { "*"?: string })["*"];
    if (!resourceId) {
      return reply.code(400).send({ error: "malformed_input", reason: "MALFORMED_INPUT" });
    }
    const result = await readManagedResource(identity, resourceId, {
      store: identityDependencies.store,
      ledger: identityDependencies.ledger,
    });
    if (!result.ok) {
      const error = result.statusCode === 403 ? "forbidden" : "request_failed";
      return reply.code(result.statusCode).send({ error, reason: result.reason });
    }
    return reply.send(result.value);
  });

  app.post("/api/tools/:name", async (request, reply) => {
    const identity = request.governanceIdentity;
    if (!identity || identity.kind !== "agent") {
      return reply.code(401).send({ error: "Runtime authentication required" });
    }
    if (!identityDependencies?.ledger) {
      return reply.code(503).send({ error: "Governance unavailable" });
    }
    const parsed = z.object({ name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/) }).safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: "malformed_input", reason: "MALFORMED_INPUT" });
    }
    const result = await invokeTrustedTool(identity, parsed.data.name, {
      store: identityDependencies.store,
      ledger: identityDependencies.ledger,
    });
    if (!result.ok) {
      const error = result.statusCode === 403 ? "forbidden" : "request_failed";
      return reply.code(result.statusCode).send({ error, reason: result.reason });
    }
    return reply.send(result.value);
  });

  app.post("/api/envelopes/:id/revoke", async (request, reply) => {
    const identity = request.governanceIdentity;
    if (!identity || identity.kind !== "human") {
      return reply.code(401).send({ error: "Human authentication required" });
    }
    if (!revocations) {
      return reply.code(503).send({ error: "Governance unavailable" });
    }
    const parsed = z
      .object({ id: z.string().trim().min(1).max(200) })
      .safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Malformed request" });
    }
    const result = await revocations.revoke(identity, parsed.data.id);
    if (!result.ok) {
      return reply
        .code(result.statusCode)
        .send({ error: result.statusCode === 404 ? "Not found" : "Forbidden" });
    }
    return reply.send({ grantId: result.grantId, revoked: result.revoked });
  });

  // Starts a governed run for an existing Agent and hands it the parent
  // RUN_TOKEN. Without this there is no production path that mints a parent
  // token at all: sendGovernedMessage is only reached by the delegated
  // launcher, which mints tokens for CHILDREN. The Playground's own message
  // route stays ungoverned, so the pre-existing contract is unchanged.
  app.post("/api/governance/runs", async (request, reply) => {
    const identity = request.governanceIdentity;
    if (!identity || identity.kind !== "human") {
      return reply.code(401).send({ error: "Human authentication required" });
    }
    if (!identityDependencies?.ledger) {
      return reply.code(503).send({ error: "Governance unavailable" });
    }
    const parsed = governedRunBody.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "malformed_input", reason: "MALFORMED_INPUT" });
    }

    const governedRun = await startGovernedRun(
      identityDependencies.store,
      identityDependencies.ledger,
      { ownerId: identity.principalId },
    );
    const runtimeRunToken = identityDependencies.runTokens.mint({
      runId: governedRun.envelope.runId,
      principalId: governedRun.principal.id,
      grantId: governedRun.envelope.id,
      exp: Math.floor(Date.now() / 1_000) + PARENT_TOKEN_TTL_SECONDS,
    });

    try {
      const started = await service.sendGovernedMessage(
        parsed.data.agentId,
        parsed.data.task,
        { runtimeRunToken },
      );
      return reply.code(201).send({
        runId: governedRun.envelope.runId,
        principalId: governedRun.principal.id,
        grantId: governedRun.envelope.id,
        agentRunId: started.run.id,
      });
    } catch (error) {
      if (error instanceof HttpError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post("/api/delegations", async (request, reply) => {
    const identity = request.governanceIdentity;
    if (!identity || identity.kind !== "agent") {
      return reply.code(401).send({ error: "Runtime authentication required" });
    }
    if (!delegatedAgents) {
      return reply.code(503).send({ error: "Governance unavailable" });
    }
    const parsed = childEnvelopeBody.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_delegation", reason: "MALFORMED_INPUT" });
    }
    const { task, ...authority } = parsed.data;
    const result = await delegatedAgents.launch(
      identity,
      authority as ChildEnvelopeRequest,
      task,
    );
    if (!result.ok) {
      return reply.code(result.statusCode).send({
        error: result.reason === "CHILD_EXCEEDS_PARENT"
          ? "invalid_delegation"
          : "forbidden",
        reason: result.reason,
      });
    }
    return reply.code(201).send(result.handle);
  });

  // Return Gate. A child writes privately, then publishes through the full
  // pipeline; only a declared recipient can read the result.
  app.post("/api/artifacts", async (request, reply) => {
    const identity = request.governanceIdentity;
    if (!identity || identity.kind !== "agent") {
      return reply.code(401).send({ error: "Runtime authentication required" });
    }
    if (!identityDependencies?.ledger) {
      return reply.code(503).send({ error: "Governance unavailable" });
    }
    const parsed = createArtifactBody.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "malformed_input", reason: "MALFORMED_INPUT" });
    }
    const result = await createArtifact(identity, parsed.data, {
      store: identityDependencies.store,
      ledger: identityDependencies.ledger,
    });
    if (!result.ok) {
      const error = result.statusCode === 403 ? "forbidden" : "request_failed";
      return reply.code(result.statusCode).send({ error, reason: result.reason });
    }
    return reply.code(201).send(result.value);
  });

  app.post("/api/artifacts/:id/publish", async (request, reply) => {
    const identity = request.governanceIdentity;
    if (!identity || identity.kind !== "agent") {
      return reply.code(401).send({ error: "Runtime authentication required" });
    }
    if (!identityDependencies?.ledger) {
      return reply.code(503).send({ error: "Governance unavailable" });
    }
    const params = z
      .object({ id: z.string().trim().min(1).max(200) })
      .safeParse(request.params);
    const parsed = publishArtifactBody.safeParse(request.body);
    if (!params.success || !parsed.success) {
      return reply
        .code(400)
        .send({ error: "malformed_input", reason: "MALFORMED_INPUT" });
    }
    const result = await publishArtifact(identity, params.data.id, parsed.data, {
      store: identityDependencies.store,
      ledger: identityDependencies.ledger,
    });
    if (!result.ok) {
      const error = result.statusCode === 403 ? "forbidden" : "request_failed";
      return reply.code(result.statusCode).send({
        error,
        reason: result.reason,
        ...(result.detail ? { detail: result.detail } : {}),
      });
    }
    return reply.send(result.value);
  });

  app.get("/api/artifacts/:id", async (request, reply) => {
    const identity = request.governanceIdentity;
    if (!identity || identity.kind !== "agent") {
      return reply.code(401).send({ error: "Runtime authentication required" });
    }
    if (!identityDependencies?.ledger) {
      return reply.code(503).send({ error: "Governance unavailable" });
    }
    const params = z
      .object({ id: z.string().trim().min(1).max(200) })
      .safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send({ error: "malformed_input", reason: "MALFORMED_INPUT" });
    }
    const result = readArtifact(identity, params.data.id, {
      store: identityDependencies.store,
      ledger: identityDependencies.ledger,
    });
    if (!result.ok) {
      const error = result.statusCode === 403 ? "forbidden" : "request_failed";
      return reply.code(result.statusCode).send({ error, reason: result.reason });
    }
    return reply.send(result.value);
  });

  app.get("/api/agents", async () => ({ agents: service.listAgents() }));

  app.post("/api/agents", async (request, reply) => {
    const body = createAgentBody.parse(request.body);
    const agent = await service.createAgent(body);
    return reply.code(201).send({ agent });
  });

  app.get("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: service.getAgent(id) };
  });

  app.patch("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const body = updateAgentBody.parse(request.body);
    return { agent: await service.updateAgent(id, body) };
  });

  app.delete("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return service.deleteAgent(id);
  });

  app.post("/api/agents/:id/start", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.startAgent(id) };
  });

  app.post("/api/agents/:id/stop", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.stopAgent(id) };
  });

  app.get("/api/agents/:id/messages", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { messages: service.getMessages(id) };
  });

  app.get("/api/agents/:id/runs", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { runs: service.getRuns(id) };
  });

  app.post("/api/agents/:id/messages", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const body = messageBody.parse(request.body);
    const result = await service.sendMessage(id, body.content);
    return reply.code(202).send(result);
  });

  app.get("/api/runs/:id", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return { run: service.getRun(id) };
  });

  if (config.nodeEnv === "production") {
    const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "API route not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof Error ? error : new Error(String(error));
    const validationError = error instanceof z.ZodError;
    const frameworkStatus =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;
    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : validationError
          ? 400
          : frameworkStatus && frameworkStatus >= 400 && frameworkStatus <= 599
            ? frameworkStatus
            : 500;
    if (statusCode >= 500) {
      request.log.error(appError);
    }
    return reply.code(statusCode).send({
      error: appError.message,
      ...(validationError ? { details: error.issues } : {}),
    });
  });

  return app;
}
