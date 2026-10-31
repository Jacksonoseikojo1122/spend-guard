import { createHash, randomBytes } from "node:crypto";
import { appendAudit, canonical, verifyAudit } from "./audit.js";
import type { Db, Query, Row } from "./db.js";
import { decide, type Decision, type Usage } from "./decide.js";
import { canMoveTo, NETWORKS, PayoutRefused, validMomoSignature, type Payout, type PayoutClient, type PayoutStatus } from "./momo.js";
import { formatMoney, type ApprovalNotice, type Notifier } from "./notify.js";
import { PolicySchema, type Policy } from "./policy.js";
import { PaymentRequestSchema } from "./request.js";
import { z } from "zod";

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
  /** Present once the request is allowed or approved and payouts are switched on. */
  payout?: { id: string | null; status: PayoutStatus | "queued"; failure: { code: string; message: string } | null };
  created_at: string;
};

export type Recipient = { id: string; name: string; phone: string; network: (typeof NETWORKS)[number] };
export const RecipientSchema = z
  .object({
    name: z.string().min(1).max(100),
    phone: z.string().regex(/^\+?[\d\s-]{9,20}$/, "a phone number like 024 123 4567 or +233241234567"),
    network: z.enum(NETWORKS),
  })
  .strict();
const RECIPIENT_ID = /^[A-Za-z0-9:_.+-]{1,100}$/;

export type GuardOptions = {
  now?: () => Date;
  notifier?: Notifier;
  /** Where approvers open their links, e.g. https://guard.example.com. */
  publicUrl?: string;
  /** MoMo One-API. Without it, allowed and approved requests are only recorded. */
  payouts?: { client: PayoutClient; webhookSecret?: string };
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
  private payouts?: GuardOptions["payouts"];

  constructor(
    private db: Db,
    opts: GuardOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.notifier = opts.notifier;
    this.publicUrl = (opts.publicUrl ?? "").replace(/\/+$/, "");
    this.payouts = opts.payouts;
  }

  // --- Recipients (owner only) ---------------------------------------------------------
  // Agents name a recipient; only the owner says which phone number that name pays. An agent
  // therefore can't invent a destination for money, only pick from the owner's directory.

  async setRecipient(owner: string, recipientId: string, body: unknown): Promise<Recipient> {
    if (!RECIPIENT_ID.test(recipientId)) throw new ApiError(400, "invalid_recipient_id", "Recipient ids use letters, digits and : _ . + - (up to 100).");
    const r = RecipientSchema.parse(body);
    const phone = r.phone.replace(/[\s-]/g, "");
    const at = this.now().toISOString();
    await this.db.tx(async (q) => {
      await q("DELETE FROM recipients WHERE owner = $1 AND id = $2", [owner, recipientId]);
      await q("INSERT INTO recipients (owner, id, name, phone, network, updated_at) VALUES ($1, $2, $3, $4, $5, $6)", [owner, recipientId, r.name, phone, r.network, at]);
      await appendAudit(q, at, { actor: `owner:${owner}`, event: "recipient.set", subject: recipientId, data: { name: r.name, phone, network: r.network } });
    });
    return { id: recipientId, name: r.name, phone, network: r.network };
  }

  async listRecipients(owner: string): Promise<Recipient[]> {
    const rows = await this.db.query("SELECT id, name, phone, network FROM recipients WHERE owner = $1 ORDER BY id", [owner]);
    return rows.map((r) => ({ id: String(r.id), name: String(r.name), phone: String(r.phone), network: r.network as Recipient["network"] }));
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

      const [known] = await q("SELECT id FROM recipients WHERE owner = $1 AND id = $2", [agent.owner, body.recipient]);
      if (!known) throw new ApiError(422, "unknown_recipient", `"${body.recipient}" isn't in the owner's recipient directory. The owner has to add it before anyone can pay it.`);

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
        // Queued inside the same transaction as the decision, so a crash before sending can't lose it.
        payout_status: status === "allowed" && this.payouts ? "queued" : null,
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
    if (!result.replayed && result.request.status === "allowed" && this.payouts) return { ...result, request: await this.dispatch(result.request.id) };
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
      const payoutStatus = status === "approved" && this.payouts ? "queued" : null;
      await q("UPDATE payment_requests SET status = $1, resolved_at = $2, resolved_by = $3, payout_status = $4 WHERE id = $5", [status, at, actor, payoutStatus, requestId]);
      await q("UPDATE approval_tokens SET used_at = $1 WHERE request_id = $2 AND used_at IS NULL", [at, requestId]);
      await appendAudit(q, at, { actor, event: `payment_request.${status}`, subject: requestId, data: { amount: Number(r.amount), currency: String(r.currency), recipient: String(r.recipient) } });
      const [updated] = await q("SELECT * FROM payment_requests WHERE id = $1", [requestId]);
      return { view: toView(updated!, now.getTime()) };
    });
    if ("expired" in out) throw new ApiError(410, "hold_expired", "Nobody answered in time, so this request expired and can't be approved now.");
    if (out.view.status === "approved" && this.payouts) return this.dispatch(requestId);
    return out.view;
  }

  // --- Payouts through MoMo One-API ---------------------------------------------------

  /**
   * Sends a queued payout. Safe to call more than once: the request id is the Idempotency-Key,
   * so MoMo One-API returns the payout it already made instead of making another.
   */
  async dispatch(requestId: string): Promise<PaymentRequestView> {
    const client = this.payouts?.client;
    const [r] = await this.db.query("SELECT pr.*, a.owner FROM payment_requests pr JOIN agents a ON a.id = pr.agent_id WHERE pr.id = $1", [requestId]);
    if (!client || !r || r.payout_status !== "queued") return this.view(requestId);
    const [to] = await this.db.query("SELECT name, phone, network FROM recipients WHERE owner = $1 AND id = $2", [r.owner, r.recipient]);
    let payout: Payout;
    try {
      if (!to) throw new PayoutRefused(`Recipient "${r.recipient}" was removed from the directory before the payout was sent.`);
      payout = await client.createPayout({
        idempotencyKey: requestId,
        amount: Number(r.amount),
        currency: String(r.currency),
        phone: String(to.phone),
        network: to.network as Recipient["network"],
        name: String(to.name),
        description: String(r.reference),
        metadata: { spend_guard_request: requestId, spend_guard_agent: String(r.agent_id) },
      });
    } catch (e) {
      if (e instanceof PayoutRefused) {
        // Refused outright, so nothing was started: record it as failed and free the room.
        await this.applyPayout(requestId, { id: r.payout_id ? String(r.payout_id) : "", status: "failed", failure: { code: "refused", message: e.message } });
      } else {
        // Timeout or network trouble: it may or may not have reached MoMo One-API. Leave it
        // queued; the next sync sends it again with the same key, which can't pay twice.
        await this.db.query("UPDATE payment_requests SET payout_attempts = payout_attempts + 1, payout_updated_ms = $1 WHERE id = $2", [this.now().getTime(), requestId]);
        console.error(`payout for ${requestId} not confirmed yet:`, e instanceof Error ? e.message : e);
      }
      return this.view(requestId);
    }
    await this.applyPayout(requestId, payout);
    return this.view(requestId);
  }

  /** Records a payout status if it moves the payout forward. Returns true if anything changed. */
  private async applyPayout(requestId: string, payout: Payout): Promise<boolean> {
    return this.db.tx(async (q) => {
      const [r] = await q("SELECT payout_status, payout_id FROM payment_requests WHERE id = $1", [requestId]);
      if (!r || r.payout_status == null) return false;
      const from = r.payout_status as PayoutStatus | "queued";
      if (from === payout.status || !canMoveTo(from, payout.status)) return false;
      const now = this.now();
      await q("UPDATE payment_requests SET payout_id = $1, payout_status = $2, payout_failure = $3, payout_attempts = payout_attempts + 1, payout_updated_ms = $4 WHERE id = $5", [
        payout.id || r.payout_id, payout.status, payout.failure ? JSON.stringify(payout.failure) : null, now.getTime(), requestId,
      ]);
      await appendAudit(q, now.toISOString(), { actor: "momo-one-api", event: `payout.${payout.status}`, subject: requestId, data: { payout_id: payout.id || null, failure: payout.failure } });
      return true;
    });
  }

  /**
   * A MoMo One-API webhook. The signature is checked, and then the payout's status is fetched
   * from MoMo One-API rather than taken from the body: the webhook only says "go and look".
   */
  async handleMomoWebhook(rawBody: string, signature: string | undefined): Promise<{ updated: boolean }> {
    const secret = this.payouts?.webhookSecret;
    if (!this.payouts || !secret) throw new ApiError(404, "not_found", "Payouts aren't configured.");
    if (!validMomoSignature(rawBody, signature, secret)) throw new ApiError(401, "bad_signature", "Webhook signature doesn't match.");
    let event: { data?: { id?: unknown } };
    try {
      event = JSON.parse(rawBody);
    } catch {
      throw new ApiError(400, "invalid_json", "Body must be valid JSON.");
    }
    const payoutId = typeof event.data?.id === "string" ? event.data.id : undefined;
    if (!payoutId) return { updated: false };
    const [r] = await this.db.query("SELECT id FROM payment_requests WHERE payout_id = $1", [payoutId]);
    if (!r) return { updated: false }; // not one of ours (MoMo One-API may serve other apps too)
    return { updated: await this.applyPayout(String(r.id), await this.payouts.client.getPayout(payoutId)) };
  }

  /** Resends queued payouts and re-checks unfinished ones. Run it every minute or so. */
  async syncPayouts(): Promise<{ sent: number; checked: number }> {
    if (!this.payouts) return { sent: 0, checked: 0 };
    const nowMs = this.now().getTime();
    const queued = await this.db.query("SELECT id FROM payment_requests WHERE payout_status = 'queued' AND (payout_updated_ms IS NULL OR payout_updated_ms < $1) LIMIT 50", [nowMs - 30_000]);
    for (const r of queued) await this.dispatch(String(r.id));
    const open = await this.db.query("SELECT id, payout_id FROM payment_requests WHERE payout_status IN ('pending', 'action_required') AND payout_updated_ms < $1 LIMIT 50", [nowMs - 60_000]);
    for (const r of open) {
      try {
        await this.applyPayout(String(r.id), await this.payouts.client.getPayout(String(r.payout_id)));
      } catch (e) {
        console.error(`checking payout ${r.payout_id} failed:`, e instanceof Error ? e.message : e);
      }
    }
    return { sent: queued.length, checked: open.length };
  }

  private async view(requestId: string): Promise<PaymentRequestView> {
    const [r] = await this.db.query("SELECT * FROM payment_requests WHERE id = $1", [requestId]);
    return toView(r!, this.now().getTime());
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
 * haven't expired. An expired hold can never be approved, so it stops reserving room, and a
 * payout that failed or was reversed moved no money, so it frees its room too.
 */
async function usageFor(q: Query, agentId: string, day: string, month: string, nowMs: number): Promise<Usage> {
  const counted = `((status IN ('allowed', 'approved') AND COALESCE(payout_status, '') NOT IN ('failed', 'reversed')) OR (status = 'held' AND hold_expires_ms > $3))`;
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
  if (r.payout_status != null)
    v.payout = { id: r.payout_id ? String(r.payout_id) : null, status: r.payout_status as PayoutStatus | "queued", failure: r.payout_failure ? JSON.parse(String(r.payout_failure)) : null };
  return v;
}

