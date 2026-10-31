import { createHash, randomBytes } from "node:crypto";
import { appendAudit, canonical, verifyAudit } from "./audit.js";
import type { Db, Query, Row } from "./db.js";
import { decide, type Decision, type Usage } from "./decide.js";
import { formatMoney, type ApprovalNotice, type Notifier } from "./notify.js";
import { PolicySchema, type Policy } from "./policy.js";
import { PaymentRequestSchema } from "./request.js";

export class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type Agent = { id: string; owner: string; name: string; created_at: string; revoked_at: string | null };

/**
 * allowed, denied: decided by the policy. held: waiting for a person. From held a request
 * becomes approved or rejected (by a person), expired (nobody answered in time) or cancelled
 * (the agent was revoked). Only allowed, approved and unexpired held requests count toward limits.
 */
export type Status = "allowed" | "held" | "approved" | "rejected" | "expired" | "cancelled" | "denied";
export const STATUSES: Status[] = ["allowed", "held", "approved", "rejected", "expired", "cancelled", "denied"];

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
  resolved?: { at: string; by: string };
  created_at: string;
};

export type GuardOptions = {
  now?: () => Date;
  notifier?: Notifier;
  /** Where approvers open their links, e.g. https://guard.example.com. */
  publicUrl?: string;
};

type PendingNotice = Omit<ApprovalNotice, "url"> & { token: string };

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
  private now: () => Date;
  private notifier?: Notifier;
  private publicUrl: string;

  constructor(
    private db: Db,
    opts: GuardOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.notifier = opts.notifier;
    this.publicUrl = (opts.publicUrl ?? "").replace(/\/+$/, "");
  }

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
      // Anything still waiting for approval dies with the agent, so nobody approves a payment
      // for an agent that has just been stopped.
      const held = await q("SELECT id FROM payment_requests WHERE agent_id = $1 AND status = 'held'", [agentId]);
      const ids = held.map((r) => String(r.id));
      if (ids.length) {
        await q("UPDATE payment_requests SET status = 'cancelled', resolved_at = $1, resolved_by = $2 WHERE agent_id = $3 AND status = 'held'", [at, `owner:${owner}`, agentId]);
        await q(`UPDATE approval_tokens SET used_at = $1 WHERE used_at IS NULL AND request_id IN (${ids.map((_, i) => `$${i + 2}`).join(", ")})`, [at, ...ids]);
      }
      await appendAudit(q, at, { actor: `owner:${owner}`, event: "agent.revoked", subject: agentId, data: { cancelled_requests: ids } });
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
    const notices: PendingNotice[] = [];
    const result = await this.db.tx(async (q) => {
      // Checked inside the lock, so a revoke that lands mid-run stops the very next request.
      const [fresh] = await q("SELECT revoked_at FROM agents WHERE id = $1", [agent.id]);
      if (!fresh || fresh.revoked_at) throw new ApiError(403, "agent_revoked", "This agent's key has been revoked.");

      const [existing] = await q("SELECT * FROM payment_requests WHERE agent_id = $1 AND idempotency_key = $2", [agent.id, idempotencyKey]);
      if (existing) {
        if (existing.request_hash !== requestHash)
          throw new ApiError(409, "idempotency_key_reused", "This Idempotency-Key was already used for a different payment request.");
        return { request: toView(existing, this.now().getTime()), replayed: true };
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
      // One single-use link per approver. Only the hash is stored; the token goes out in the notice.
      if (status === "held" && policy?.approval) {
        const expiresAt = new Date(holdExpiresMs!);
        for (const approver of policy.approval.approvers) {
          const token = randomBytes(24).toString("base64url");
          await q("INSERT INTO approval_tokens (token_hash, request_id, approver, expires_ms) VALUES ($1, $2, $3, $4)", [sha256(token), row.id, approver, holdExpiresMs]);
          notices.push({
            token,
            approver,
            channel: policy.approval.channel,
            message: `Spend Guard: ${agent.name} wants to pay ${formatMoney(body.amount, body.currency)} to ${body.recipient} (${body.reference}). ${decision.message} Approve or reject before ${hhmmIn(expiresAt, policy.timezone)}:`,
            request: { id: String(row.id), agent_name: agent.name, amount: body.amount, currency: body.currency, recipient: body.recipient, reference: body.reference, expires_at: expiresAt.toISOString() },
          });
        }
      }
      return { request: toView(row, now.getTime()), replayed: false };
    });
    await this.sendNotices(notices);
    return result;
  }

  private async sendNotices(notices: PendingNotice[]) {
    if (!this.notifier) return;
    for (const { token, ...n } of notices) {
      const url = `${this.publicUrl}/approve/${token}`;
      try {
        await this.notifier.send({ ...n, message: `${n.message} ${url}`, url });
      } catch (e) {
        // The hold stands either way; the owner can approve through the API.
        console.error(`approval notice to ${n.approver} failed:`, e instanceof Error ? e.message : e);
      }
    }
  }

  // --- Approvals -----------------------------------------------------------------------

  /** What an approver sees when they open their link. Opening it changes nothing. */
  async approvalPage(token: string): Promise<{ request: PaymentRequestView; approver: string; agent_name: string; usage: Usage; limits?: Policy["limits"]; usable: boolean }> {
    const [t] = await this.db.query("SELECT request_id, approver, used_at FROM approval_tokens WHERE token_hash = $1", [sha256(token)]);
    if (!t) throw new ApiError(404, "approval_link_not_found", "This approval link isn't valid.");
    const [r] = await this.db.query("SELECT * FROM payment_requests WHERE id = $1", [t.request_id]);
    const [a] = await this.db.query("SELECT name FROM agents WHERE id = $1", [r!.agent_id]);
    const { usage, limits } = await this.usage(String(r!.agent_id));
    const request = toView(r!, this.now().getTime());
    return { request, approver: String(t.approver), agent_name: String(a?.name ?? ""), usage, limits, usable: !t.used_at && request.status === "held" };
  }

  /** Approve or reject through a link. Each link works once, and only while the hold is open. */
  async resolveByToken(token: string, action: "approve" | "reject"): Promise<PaymentRequestView> {
    const [t] = await this.db.query("SELECT request_id, approver, used_at FROM approval_tokens WHERE token_hash = $1", [sha256(token)]);
    if (!t) throw new ApiError(404, "approval_link_not_found", "This approval link isn't valid.");
    if (t.used_at) throw new ApiError(409, "approval_link_used", "This approval link has already been used.");
    return this.resolve(String(t.request_id), action, `approver:${t.approver}`);
  }

  async resolveAsOwner(owner: string, requestId: string, action: "approve" | "reject"): Promise<PaymentRequestView> {
    await this.getRequest(await this.ownerAgentIds(owner), requestId); // 404 unless it's this owner's
    return this.resolve(requestId, action, `owner:${owner}`);
  }

  private async resolve(requestId: string, action: "approve" | "reject", actor: string): Promise<PaymentRequestView> {
    const out = await this.db.tx(async (q) => {
      const [r] = await q("SELECT * FROM payment_requests WHERE id = $1", [requestId]);
      if (!r) throw new ApiError(404, "payment_request_not_found", "No payment request with that id.");
      const now = this.now();
      if (r.status !== "held") throw new ApiError(409, "not_held", `This request is ${r.status}, so it can't be approved or rejected.`);
      if (Number(r.hold_expires_ms) <= now.getTime()) {
        // Record the expiry now rather than leave it to the sweeper, then report it.
        await expire(q, [r], now);
        return { expired: true as const };
      }
      const status: Status = action === "approve" ? "approved" : "rejected";
      const at = now.toISOString();
      await q("UPDATE payment_requests SET status = $1, resolved_at = $2, resolved_by = $3 WHERE id = $4", [status, at, actor, requestId]);
      await q("UPDATE approval_tokens SET used_at = $1 WHERE request_id = $2 AND used_at IS NULL", [at, requestId]);
      await appendAudit(q, at, { actor, event: `payment_request.${status}`, subject: requestId, data: { amount: Number(r.amount), currency: String(r.currency), recipient: String(r.recipient) } });
      const [updated] = await q("SELECT * FROM payment_requests WHERE id = $1", [requestId]);
      return { view: toView(updated!, now.getTime()) };
    });
    if ("expired" in out) throw new ApiError(410, "hold_expired", "Nobody answered in time, so this request expired and can't be approved now.");
    return out.view;
  }

  /** Marks every hold whose time ran out as expired. Run it every minute or so. */
  async expireHolds(): Promise<number> {
    return this.db.tx(async (q) => {
      const now = this.now();
      const rows = await q("SELECT id, amount FROM payment_requests WHERE status = 'held' AND hold_expires_ms <= $1", [now.getTime()]);
      await expire(q, rows, now);
      return rows.length;
    });
  }

  async listRequests(agentIds: string[], filter: { status?: Status; agentId?: string; limit: number }): Promise<PaymentRequestView[]> {
    const ids = filter.agentId ? agentIds.filter((a) => a === filter.agentId) : agentIds;
    if (!ids.length) return [];
    const params: unknown[] = [...ids];
    let sql = `SELECT * FROM payment_requests WHERE agent_id IN (${ids.map((_, i) => `$${i + 1}`).join(", ")})`;
    if (filter.status) {
      params.push(filter.status);
      sql += ` AND status = $${params.length}`;
    }
    params.push(filter.limit);
    sql += ` ORDER BY created_ms DESC LIMIT $${params.length}`;
    const nowMs = this.now().getTime();
    return (await this.db.query(sql, params)).map((r) => toView(r, nowMs));
  }

  async getRequest(agentIds: string[], requestId: string): Promise<PaymentRequestView> {
    const [r] = await this.db.query("SELECT * FROM payment_requests WHERE id = $1", [requestId]);
    if (!r || !agentIds.includes(String(r.agent_id))) throw new ApiError(404, "payment_request_not_found", "No payment request with that id.");
    return toView(r, this.now().getTime());
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

async function expire(q: Query, rows: Row[], now: Date) {
  const at = now.toISOString();
  for (const r of rows) {
    await q("UPDATE payment_requests SET status = 'expired', resolved_at = $1, resolved_by = 'system' WHERE id = $2 AND status = 'held'", [at, r.id]);
    await q("UPDATE approval_tokens SET used_at = $1 WHERE request_id = $2 AND used_at IS NULL", [at, r.id]);
    await appendAudit(q, at, { actor: "system", event: "payment_request.expired", subject: String(r.id), data: { amount: Number(r.amount) } });
  }
}

function hhmmIn(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
}

async function latestPolicy(q: Query, agentId: string): Promise<{ version: number; policy: Policy } | undefined> {
  const [r] = await q("SELECT version, document FROM policies WHERE agent_id = $1 ORDER BY version DESC LIMIT 1", [agentId]);
  // Stored policies were validated on the way in; parsing again applies defaults the same way.
  return r ? { version: Number(r.version), policy: PolicySchema.parse(JSON.parse(String(r.document))) } : undefined;
}

/**
 * Totals that count toward the limits: allowed and approved requests, plus held ones that
 * haven't expired. An expired hold can never be approved, so it stops reserving room.
 */
async function usageFor(q: Query, agentId: string, day: string, month: string, nowMs: number): Promise<Usage> {
  const counted = `(status IN ('allowed', 'approved') OR (status = 'held' AND hold_expires_ms > $3))`;
  const [d] = await q(`SELECT COALESCE(SUM(amount), 0) AS total FROM payment_requests WHERE agent_id = $1 AND local_day = $2 AND ${counted}`, [agentId, day, nowMs]);
  const [m] = await q(`SELECT COALESCE(SUM(amount), 0) AS total FROM payment_requests WHERE agent_id = $1 AND local_month = $2 AND ${counted}`, [agentId, month, nowMs]);
  const [h] = await q(`SELECT COUNT(*) AS n FROM payment_requests WHERE agent_id = $1 AND created_ms > $2 AND ${counted}`, [agentId, nowMs - 3_600_000, nowMs]);
  return { day: Number(d?.total ?? 0), month: Number(m?.total ?? 0), lastHourCount: Number(h?.n ?? 0) };
}

const toAgent = (r: Row): Agent => ({
  id: String(r.id), owner: String(r.owner), name: String(r.name), created_at: String(r.created_at), revoked_at: r.revoked_at ? String(r.revoked_at) : null,
});

/** A hold whose time has run out reads as expired even before the sweeper has marked it. */
function toView(r: Row, nowMs: number): PaymentRequestView {
  const timedOut = r.status === "held" && r.hold_expires_ms != null && Number(r.hold_expires_ms) <= nowMs;
  const v: PaymentRequestView = {
    id: String(r.id), agent_id: String(r.agent_id), status: timedOut ? "expired" : (r.status as Status),
    amount: Number(r.amount), currency: String(r.currency), recipient: String(r.recipient), reference: String(r.reference),
    reason: r.reason == null ? null : String(r.reason),
    decision: JSON.parse(String(r.decision)) as Decision,
    policy_version: r.policy_version == null ? null : Number(r.policy_version),
    created_at: String(r.created_at),
  };
  if (r.hold_expires_ms != null) v.approval = { expires_at: new Date(Number(r.hold_expires_ms)).toISOString() };
  if (r.resolved_at) v.resolved = { at: String(r.resolved_at), by: String(r.resolved_by) };
  return v;
}

