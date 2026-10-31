import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { approvalPage, messagePage, resultPage } from "./approval-page.js";
import { ApiError, sha256, STATUSES, type Agent, type Guard, type Status } from "./service.js";

// Two kinds of caller, told apart by their key:
// - owners (keys from OWNER_KEYS) create agents, set policies, revoke, and read everything;
// - agents (keys issued by POST /v1/agents) can only ask to pay and read their own requests.
// An agent key is never accepted on an owner route, so an agent can't raise its own limits.

type Caller = { kind: "owner"; owner: string } | { kind: "agent"; agent: Agent };
type Env = { Variables: { caller: Caller } };

export type AppOptions = { guard: Guard; ownerKeys: string[] };

export function createApp({ guard, ownerKeys }: AppOptions) {
  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof z.ZodError)
      return c.json({ error: { code: "invalid_request", message: "The request body isn't valid.", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) } }, 400);
    if (err instanceof ApiError) return c.json({ error: { code: err.code, message: err.message } }, err.status);
    if (err instanceof SyntaxError) return c.json({ error: { code: "invalid_json", message: "Body must be valid JSON." } }, 400);
    console.error(err);
    return c.json({ error: { code: "internal", message: "Something went wrong." } }, 500);
  });
  app.use("*", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: { code: "too_large", message: "Body is larger than 64 KB." } }, 413) }));

  app.get("/health", (c) => c.json({ ok: true }));

  // --- MoMo One-API webhook (signed; no API key) --------------------------------------------
  app.post("/webhooks/momo", async (c) => c.json(await guard.handleMomoWebhook(await c.req.text(), c.req.header("x-signature"))));

  // --- Approval links (no API key: the token in the link is the credential) ---------------
  // Opening the link only shows the request. Link previews in SMS and chat apps fetch links
  // automatically, so a GET must never approve anything; only the form's POST does.
  const linkError = (c: Context<Env>, e: unknown) => {
    if (!(e instanceof ApiError)) throw e;
    const titles: Record<string, string> = { approval_link_not_found: "Link not valid", approval_link_used: "Already answered", hold_expired: "Too late", not_held: "Already answered" };
    return c.html(messagePage(titles[e.code] ?? "Can't do that", e.message), e.status);
  };
  app.get("/approve/:token", async (c) => {
    c.header("cache-control", "no-store");
    try {
      const token = c.req.param("token");
      return c.html(approvalPage({ ...(await guard.approvalPage(token)), token }));
    } catch (e) {
      return linkError(c, e);
    }
  });
  app.post("/approve/:token", async (c) => {
    c.header("cache-control", "no-store");
    const form = await c.req.parseBody();
    const action = form.action;
    if (action !== "approve" && action !== "reject") return c.html(messagePage("Can't do that", "Choose Approve or Reject."), 400);
    try {
      return c.html(resultPage(await guard.resolveByToken(c.req.param("token"), action)));
    } catch (e) {
      return linkError(c, e);
    }
  });

  app.use("/v1/*", async (c, next) => {
    const key = c.req.header("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";
    if (key && ownerKeys.includes(key)) {
      c.set("caller", { kind: "owner", owner: sha256(key).slice(0, 16) });
      return next();
    }
    const agent = key ? await guard.agentByKey(key) : undefined;
    if (!agent) return c.json({ error: { code: "unauthorized", message: "Missing or invalid API key." } }, 401);
    c.set("caller", { kind: "agent", agent });
    return next();
  });

  const owner = (c: Context<Env>) => {
    const caller = c.get("caller");
    if (caller.kind !== "owner") throw new ApiError(403, "owner_only", "Only the owner key can do this. Agent keys can't change agents or policies.");
    return caller.owner;
  };
  /** The agent a route is about, if the caller may see it: the owner of it, or the agent itself. */
  const visibleAgent = async (c: Context<Env>, agentId: string): Promise<Agent> => {
    const caller = c.get("caller");
    if (caller.kind === "owner") return guard.agentForOwner(caller.owner, agentId);
    if (caller.agent.id !== agentId) throw new ApiError(404, "agent_not_found", "No agent with that id.");
    return caller.agent;
  };

  // --- Owner routes -----------------------------------------------------------------------
  app.post("/v1/agents", async (c) => {
    const { name } = z.object({ name: z.string().min(1).max(100) }).strict().parse(await c.req.json());
    const { agent, key } = await guard.createAgent(owner(c), name);
    return c.json({ ...agent, key, note: "Store this key now. It is only shown once." }, 201);
  });
  app.put("/v1/agents/:id/policy", async (c) => c.json(await guard.setPolicy(owner(c), c.req.param("id"), await c.req.json())));
  app.post("/v1/agents/:id/revoke", async (c) => c.json(await guard.revoke(owner(c), c.req.param("id"))));
  app.put("/v1/recipients/:id", async (c) => c.json(await guard.setRecipient(owner(c), c.req.param("id"), await c.req.json())));
  app.get("/v1/recipients", async (c) => c.json({ recipients: await guard.listRecipients(owner(c)) }));
  app.post("/v1/payment-requests/:id/approve", async (c) => c.json(await guard.resolveAsOwner(owner(c), c.req.param("id"), "approve")));
  app.post("/v1/payment-requests/:id/reject", async (c) => c.json(await guard.resolveAsOwner(owner(c), c.req.param("id"), "reject")));
  app.get("/v1/audit/verify", async (c) => {
    owner(c);
    return c.json(await guard.verifyAudit());
  });

  // --- Owner or the agent itself ----------------------------------------------------------
  app.get("/v1/agents/:id/policy", async (c) => {
    const agent = await visibleAgent(c, c.req.param("id"));
    const p = await guard.getPolicy(agent.id);
    if (!p) throw new ApiError(404, "no_policy", "This agent has no policy, so it can't spend anything.");
    return c.json(p);
  });
  app.get("/v1/agents/:id/usage", async (c) => {
    const agent = await visibleAgent(c, c.req.param("id"));
    return c.json(await guard.usage(agent.id));
  });
  app.get("/v1/payment-requests", async (c) => {
    const caller = c.get("caller");
    const status = c.req.query("status");
    if (status && !STATUSES.includes(status as Status)) throw new ApiError(400, "invalid_status", `status must be one of ${STATUSES.join(", ")}.`);
    const ids = caller.kind === "owner" ? await guard.ownerAgentIds(caller.owner) : [caller.agent.id];
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
    return c.json({ payment_requests: await guard.listRequests(ids, { status: status as Status | undefined, agentId: c.req.query("agent_id"), limit }) });
  });
  app.get("/v1/payment-requests/:id", async (c) => {
    const caller = c.get("caller");
    const ids = caller.kind === "owner" ? await guard.ownerAgentIds(caller.owner) : [caller.agent.id];
    return c.json(await guard.getRequest(ids, c.req.param("id")));
  });

  // --- Agent routes -----------------------------------------------------------------------
  app.post("/v1/payment-requests", async (c) => {
    const caller = c.get("caller");
    if (caller.kind !== "agent") throw new ApiError(403, "agent_only", "Payment requests are made with an agent key, so every request belongs to one agent and its policy.");
    const key = c.req.header("idempotency-key")?.trim();
    if (!key || key.length > 128) throw new ApiError(400, "idempotency_key_required", "Send an Idempotency-Key header (up to 128 characters) so a retry never pays twice.");
    const { request, replayed } = await guard.requestPayment(caller.agent, key, await c.req.json());
    c.header("Idempotent-Replayed", String(replayed));
    return c.json(request, replayed ? 200 : 201);
  });

  return app;
}
