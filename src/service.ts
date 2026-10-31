import { createHash, randomBytes } from "node:crypto";
import { appendAudit, canonical, verifyAudit } from "./audit.js";
import type { Db, Query, Row } from "./db.js";
import { decide, type Decision, type Usage } from "./decide.js";
import { PolicySchema, type Policy } from "./policy.js";
import { PaymentRequestSchema } from "./request.js";

export class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type Agent = { id: string; owner: string; name: string; created_at: string; revoked_at: string | null };

export type Status = "allowed" | "held" | "denied";

export type PaymentRequestView = {
  id: string;
  agent_id: string;
  status: Status;
  amount: number;
  currency: string;
  recipient: string;
  reference: string;
  reason: string | null;
  decision: Decision;
  policy_version: number | null;
  approval?: { expires_at: string };
  created_at: string;
};

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const id = (prefix: string) => `${prefix}_${randomBytes(12).toString("base64url")}`;

/** "2026-11-03" and "2026-11" for an instant, in a given time zone. */
export function localDate(now: Date, timeZone: string): { day: string; month: string } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const month = `${get("year")}-${get("month")}`;
  return { day: `${month}-${get("day")}`, month };
}

export class Guard {
  constructor(
    private db: Db,
    private now: () => Date = () => new Date(),
  ) {}

  // --- Agents and policies (owner only) ------------------------------------------------

  async createAgent(owner: string, name: string): Promise<{ agent: Agent; key: string }> {
    const key = `sg_agent_${randomBytes(24).toString("base64url")}`;
    const agent: Agent = { id: id("agt"), owner, name, created_at: this.now().toISOString(), revoked_at: null };
    await this.db.tx(async (q) => {
      await q("INSERT INTO agents (id, owner, name, key_hash, created_at) VALUES ($1, $2, $3, $4, $5)", [agent.id, owner, name, sha256(key), agent.created_at]);
      await appendAudit(q, agent.created_at, { actor: `owner:${owner}`, event: "agent.created", subject: agent.id, data: { name } });
    });
    return { agent, key }; // the only time the key is ever shown
  }

  async agentByKey(key: string): Promise<Agent | undefined> {
    const [r] = await this.db.query("SELECT id, owner, name, created_at, revoked_at FROM agents WHERE key_hash = $1", [sha256(key)]);
    return r ? toAgent(r) : undefined;
  }

  async agentForOwner(owner: string, agentId: string): Promise<Agent> {
    const [r] = await this.db.query("SELECT id, owner, name, created_at, revoked_at FROM agents WHERE id = $1 AND owner = $2", [agentId, owner]);
    if (!r) throw new ApiError(404, "agent_not_found", "No agent with that id.");
    return toAgent(r);
  }

  async setPolicy(owner: string, agentId: string, body: unknown): Promise<{ version: number; policy: Policy }> {
    const policy = PolicySchema.parse(body);
    await this.agentForOwner(owner, agentId);
    return this.db.tx(async (q) => {
      const [last] = await q("SELECT MAX(version) AS version FROM policies WHERE agent_id = $1", [agentId]);
      const version = Number(last?.version ?? 0) + 1;
      const at = this.now().toISOString();
      await q("INSERT INTO policies (agent_id, version, document, created_at) VALUES ($1, $2, $3, $4)", [agentId, version, canonical(policy), at]);
      await appendAudit(q, at, { actor: `owner:${owner}`, event: "policy.set", subject: agentId, data: { version, policy } });
      return { version, policy };
    });
  }

  async getPolicy(agentId: string): Promise<{ version: number; policy: Policy } | undefined> {
    return latestPolicy(this.db.query, agentId);
  }

  async revoke(owner: string, agentId: string): Promise<Agent> {
    const agent = await this.agentForOwner(owner, agentId);
    if (agent.revoked_at) return agent;
    const at = this.now().toISOString();
    await this.db.tx(async (q) => {
      await q("UPDATE agents SET revoked_at = $1 WHERE id = $2", [at, agentId]);
      await appendAudit(q, at, { actor: `owner:${owner}`, event: "agent.revoked", subject: agentId, data: {} });
    });
    return { ...agent, revoked_at: at };
  }

  // --- Payment requests (agent) --------------------------------------------------------

  /**
   * Decides and records a payment request in one locked step. A retry with the same
   * Idempotency-Key gets the stored answer; the same key with a different body is refused.
   */
  async requestPayment(agent: Agent, idempotencyKey: string, rawBody: unknown): Promise<{ request: PaymentRequestView; replayed: boolean }> {
    const body = PaymentRequestSchema.parse(rawBody);
    const requestHash = sha256(canonical(body));
    return this.db.tx(async (q) => {
      // Checked inside the lock, so a revoke that lands mid-run stops the very next request.
      const [fresh] = await q("SELECT revoked_at FROM agents WHERE id = $1", [agent.id]);
      if (!fresh || fresh.revoked_at) throw new ApiError(403, "agent_revoked", "This agent's key has been revoked.");

      const [existing] = await q("SELECT * FROM payment_requests WHERE agent_id = $1 AND idempotency_key = $2", [agent.id, idempotencyKey]);
      if (existing) {
        if (existing.request_hash !== requestHash)
          throw new ApiError(409, "idempotency_key_reused", "This Idempotency-Key was already used for a different payment request.");
        return { request: toView(existing), replayed: true };
      }

      const now = this.now();
      const current = await latestPolicy(q, agent.id);
      const policy = current?.policy;
      const { day, month } = localDate(now, policy?.timezone ?? "UTC");
      const usage = await usageFor(q, agent.id, day, month, now.getTime());
      const decision = decide({ policy, request: body, usage, now });

      const status: Status = decision.result === "allow" ? "allowed" : decision.result === "hold" ? "held" : "denied";
      const holdExpiresMs = status === "held" ? now.getTime() + (policy!.approval?.expires_after_minutes ?? 30) * 60_000 : null;
      const row: Row = {
        id: id("pr"), agent_id: agent.id, idempotency_key: idempotencyKey, request_hash: requestHash,
        amount: body.amount, currency: body.currency, recipient: body.recipient, reference: body.reference, reason: body.reason ?? null,
        status, decision: JSON.stringify(decision), policy_version: current?.version ?? null,
        local_day: day, local_month: month, hold_expires_ms: holdExpiresMs, created_at: now.toISOString(), created_ms: now.getTime(),
      };
      const cols = Object.keys(row);
      await q(`INSERT INTO payment_requests (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(row));
      await appendAudit(q, row.created_at as string, {
        actor: `agent:${agent.id}`,
        event: "payment_request.decided",
        subject: row.id as string,
        data: { amount: body.amount, currency: body.currency, recipient: body.recipient, reference: body.reference, reason: body.reason ?? null, decision, policy_version: current?.version ?? null, usage },
      });
      return { request: toView(row), replayed: false };
    });
  }

  async getRequest(agentIds: string[], requestId: string): Promise<PaymentRequestView> {
    const [r] = await this.db.query("SELECT * FROM payment_requests WHERE id = $1", [requestId]);
    if (!r || !agentIds.includes(String(r.agent_id))) throw new ApiError(404, "payment_request_not_found", "No payment request with that id.");
    return toView(r);
  }

  async ownerAgentIds(owner: string): Promise<string[]> {
    return (await this.db.query("SELECT id FROM agents WHERE owner = $1", [owner])).map((r) => String(r.id));
  }

  async usage(agentId: string): Promise<{ usage: Usage; limits?: Policy["limits"]; day: string; month: string; timezone: string }> {
    const current = await latestPolicy(this.db.query, agentId);
    const now = this.now();
    const timezone = current?.policy.timezone ?? "UTC";
    const { day, month } = localDate(now, timezone);
    return { usage: await usageFor(this.db.query, agentId, day, month, now.getTime()), limits: current?.policy.limits, day, month, timezone };
  }

  verifyAudit() {
    return verifyAudit(this.db.query);
  }
}

async function latestPolicy(q: Query, agentId: string): Promise<{ version: number; policy: Policy } | undefined> {
  const [r] = await q("SELECT version, document FROM policies WHERE agent_id = $1 ORDER BY version DESC LIMIT 1", [agentId]);
  // Stored policies were validated on the way in; parsing again applies defaults the same way.
  return r ? { version: Number(r.version), policy: PolicySchema.parse(JSON.parse(String(r.document))) } : undefined;
}

/**
 * Totals that count toward the limits: allowed requests, plus held ones that haven't expired.
 * An expired hold can never be approved, so it stops reserving room.
 */
async function usageFor(q: Query, agentId: string, day: string, month: string, nowMs: number): Promise<Usage> {
  const counted = `(status = 'allowed' OR (status = 'held' AND hold_expires_ms > $3))`;
  const [d] = await q(`SELECT COALESCE(SUM(amount), 0) AS total FROM payment_requests WHERE agent_id = $1 AND local_day = $2 AND ${counted}`, [agentId, day, nowMs]);
  const [m] = await q(`SELECT COALESCE(SUM(amount), 0) AS total FROM payment_requests WHERE agent_id = $1 AND local_month = $2 AND ${counted}`, [agentId, month, nowMs]);
  const [h] = await q(`SELECT COUNT(*) AS n FROM payment_requests WHERE agent_id = $1 AND created_ms > $2 AND ${counted}`, [agentId, nowMs - 3_600_000, nowMs]);
  return { day: Number(d?.total ?? 0), month: Number(m?.total ?? 0), lastHourCount: Number(h?.n ?? 0) };
}

const toAgent = (r: Row): Agent => ({
  id: String(r.id), owner: String(r.owner), name: String(r.name), created_at: String(r.created_at), revoked_at: r.revoked_at ? String(r.revoked_at) : null,
});

function toView(r: Row): PaymentRequestView {
  const v: PaymentRequestView = {
    id: String(r.id), agent_id: String(r.agent_id), status: r.status as Status,
    amount: Number(r.amount), currency: String(r.currency), recipient: String(r.recipient), reference: String(r.reference),
    reason: r.reason == null ? null : String(r.reason),
    decision: JSON.parse(String(r.decision)) as Decision,
    policy_version: r.policy_version == null ? null : Number(r.policy_version),
    created_at: String(r.created_at),
  };
  if (r.status === "held" && r.hold_expires_ms != null) v.approval = { expires_at: new Date(Number(r.hold_expires_ms)).toISOString() };
  return v;
}

