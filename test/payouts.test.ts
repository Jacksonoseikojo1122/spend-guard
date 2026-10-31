import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { postgresDb, sqliteDb, type Db } from "../src/db.js";
import { canMoveTo, momoClient, type Payout, type PayoutClient, type PayoutInput, type PayoutStatus } from "../src/momo.js";
import { createApp } from "../src/server.js";
import { Guard } from "../src/service.js";

const OWNER_KEY = "owner-key-for-tests-0123456789";
const SECRET = "momo-webhook-secret";

/**
 * Behaves like MoMo One-API where it matters: the same Idempotency-Key always returns the same
 * payout, and statuses only change when the test says so. `down` makes calls time out.
 */
class FakeMomo implements PayoutClient {
  payouts = new Map<string, Payout & { input: PayoutInput }>();
  byKey = new Map<string, string>();
  calls = 0;
  down = false;
  refuse = false;
  async createPayout(input: PayoutInput): Promise<Payout> {
    this.calls++;
    if (this.down) throw new Error("timeout");
    if (this.refuse) {
      const { PayoutRefused } = await import("../src/momo.js");
      throw new PayoutRefused("MoMo One-API refused the payout (422): No provider for that network");
    }
    const existing = this.byKey.get(input.idempotencyKey);
    if (existing) return this.view(existing);
    const id = `pay_${this.payouts.size + 1}`;
    this.payouts.set(id, { id, status: "pending", failure: null, input });
    this.byKey.set(input.idempotencyKey, id);
    return this.view(id);
  }
  async getPayout(id: string): Promise<Payout> {
    if (this.down) throw new Error("timeout");
    return this.view(id);
  }
  set(id: string, status: PayoutStatus, failure: Payout["failure"] = null) {
    const p = this.payouts.get(id)!;
    p.status = status;
    p.failure = failure;
  }
  private view(id: string): Payout {
    const { input: _, ...p } = this.payouts.get(id)!;
    return { ...p };
  }
}

const policy = {
  currency: "GHS",
  timezone: "Africa/Accra",
  limits: { per_payment_max: 50_000, per_day_max: 100_000, per_month_max: 1_000_000, payments_per_hour_max: 100 },
  recipients: { mode: "allow_list", list: ["supplier:kofi"], new_recipient: "hold" },
  approval: { hold_above: 40_000, approvers: ["+233534884648"], expires_after_minutes: 30 },
};

const backends: [string, () => Promise<Db>][] = [["sqlite", async () => sqliteDb()]];
if (process.env.TEST_DATABASE_URL) {
  backends.push([
    "postgres",
    async () => {
      const db = await postgresDb(process.env.TEST_DATABASE_URL!);
      for (const t of ["agents", "policies", "payment_requests", "approval_tokens", "recipients", "audit_log"]) await db.query(`DELETE FROM ${t}`);
      return db;
    },
  ]);
}

describe.each(backends)("payouts on %s", (_name, makeDb) => {
  let db: Db;
  afterEach(async () => db?.close());

  async function setup() {
    db = await makeDb();
    let now = new Date("2026-11-03T10:00:00Z");
    const momo = new FakeMomo();
    const guard = new Guard(db, { now: () => now, payouts: { client: momo, webhookSecret: SECRET } });
    const app = createApp({ guard, ownerKeys: [OWNER_KEY] });
    const call = async (method: string, path: string, key: string | null, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await app.request(path, {
        method,
        headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as any };
    };
    await call("PUT", "/v1/recipients/supplier:kofi", OWNER_KEY, { name: "Kofi Hardware", phone: "024 123 4567", network: "mtn" });
    const { json: agent } = await call("POST", "/v1/agents", OWNER_KEY, { name: "procurement-bot" });
    await call("PUT", `/v1/agents/${agent.id}/policy`, OWNER_KEY, policy);
    let n = 0;
    const pay = (body: object = {}, idem = `k-${++n}`) =>
      call("POST", "/v1/payment-requests", agent.key, { amount: 12_000, currency: "GHS", recipient: "supplier:kofi", reference: "Invoice 88", ...body }, { "idempotency-key": idem });
    const webhook = (body: object, secret = SECRET) => {
      const raw = JSON.stringify(body);
      return call("POST", "/webhooks/momo", null, raw, { "x-signature": `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}` });
    };
    const get = (id: string) => call("GET", `/v1/payment-requests/${id}`, OWNER_KEY).then((r) => r.json);
    return { guard, momo, call, pay, webhook, get, setNow: (d: Date) => (now = d) };
  }

  it("sends an allowed payment to the owner's recipient, using the request id as the idempotency key", async () => {
    const { momo, pay } = await setup();
    const r = (await pay()).json;
    expect(r).toMatchObject({ status: "allowed", payout: { id: "pay_1", status: "pending", failure: null } });
    const sent = momo.payouts.get("pay_1")!.input;
    expect(sent).toMatchObject({ idempotencyKey: r.id, amount: 12_000, currency: "GHS", phone: "0241234567", network: "mtn", name: "Kofi Hardware", description: "Invoice 88" });
    expect(sent.metadata).toEqual({ spend_guard_request: r.id, spend_guard_agent: r.agent_id });
  });

  it("never pays a retried request twice", async () => {
    const { momo, pay } = await setup();
    const a = (await pay({}, "invoice-88")).json;
    const b = (await pay({}, "invoice-88")).json;
    expect(b.id).toBe(a.id);
    expect(momo.payouts.size).toBe(1);
  });

  it("doesn't send anything for held or denied requests until a person approves", async () => {
    const { momo, pay, call } = await setup();
    const held = (await pay({ amount: 45_000 })).json;
    await pay({ amount: 99_000 }); // denied
    expect(held.payout).toBeUndefined();
    expect(momo.payouts.size).toBe(0);
    const approved = (await call("POST", `/v1/payment-requests/${held.id}/approve`, OWNER_KEY)).json;
    expect(approved).toMatchObject({ status: "approved", payout: { status: "pending" } });
    expect(momo.payouts.size).toBe(1);
  });

  it("takes the status from MoMo One-API, not from the webhook body", async () => {
    const { momo, pay, webhook, get } = await setup();
    const r = (await pay()).json;
    // A correctly signed webhook that claims success, while MoMo One-API still says pending.
    expect((await webhook({ id: "evt_1", type: "payment.succeeded", data: { id: "pay_1", status: "succeeded" } })).json.updated).toBe(false);
    expect((await get(r.id)).payout.status).toBe("pending");
    momo.set("pay_1", "succeeded");
    expect((await webhook({ id: "evt_2", type: "payment.succeeded", data: { id: "pay_1" } })).json.updated).toBe(true);
    expect((await get(r.id)).payout.status).toBe("succeeded");
  });

  it("refuses webhooks with a wrong signature", async () => {
    const { pay, webhook } = await setup();
    await pay();
    const r = await webhook({ id: "evt_1", data: { id: "pay_1" } }, "wrong-secret");
    expect(r.status).toBe(401);
  });

  it("ignores webhooks for payouts that aren't ours", async () => {
    const { webhook } = await setup();
    expect((await webhook({ id: "evt_9", data: { id: "pay_someone_else" } })).json.updated).toBe(false);
  });

  it("frees the limit room when a payout fails, and keeps it when it succeeds", async () => {
    const { momo, pay, webhook, call } = await setup();
    const agentUsage = async () => (await call("GET", "/v1/payment-requests", OWNER_KEY)).json.payment_requests[0].agent_id;
    await pay({ amount: 30_000 });
    await pay({ amount: 30_000 });
    momo.set("pay_1", "failed", { code: "account_not_found", message: "No wallet for that number" });
    momo.set("pay_2", "succeeded");
    await webhook({ data: { id: "pay_1" } });
    await webhook({ data: { id: "pay_2" } });
    const usage = (await call("GET", `/v1/agents/${await agentUsage()}/usage`, OWNER_KEY)).json.usage;
    expect(usage.day).toBe(30_000);
  });

  it("only moves forward: a late pending can't undo success, and only success can be reversed", async () => {
    const { momo, pay, webhook, get } = await setup();
    const r = (await pay()).json;
    momo.set("pay_1", "succeeded");
    await webhook({ data: { id: "pay_1" } });
    momo.set("pay_1", "pending");
    expect((await webhook({ data: { id: "pay_1" } })).json.updated).toBe(false);
    momo.set("pay_1", "reversed");
    expect((await webhook({ data: { id: "pay_1" } })).json.updated).toBe(true);
    expect((await get(r.id)).payout.status).toBe("reversed");
    expect(canMoveTo("failed", "reversed")).toBe(false);
    expect(canMoveTo("pending", "action_required")).toBe(true);
  });

  it("keeps a payout queued when MoMo One-API can't be reached, then sends it once", async () => {
    const { momo, pay, get, guard, setNow } = await setup();
    momo.down = true;
    const r = (await pay()).json;
    expect(r).toMatchObject({ status: "allowed", payout: { id: null, status: "queued" } });
    momo.down = false;
    setNow(new Date("2026-11-03T10:01:00Z"));
    expect(await guard.syncPayouts()).toMatchObject({ sent: 1 });
    expect((await get(r.id)).payout).toMatchObject({ id: "pay_1", status: "pending" });
    await guard.syncPayouts();
    expect(momo.payouts.size).toBe(1);
  });

  it("records a refused payout as failed and frees the room", async () => {
    const { momo, pay, get } = await setup();
    momo.refuse = true;
    const r = (await pay({ amount: 40_000 })).json;
    expect((await get(r.id)).payout).toMatchObject({ status: "failed", failure: { code: "refused" } });
    momo.refuse = false;
    expect((await pay({ amount: 40_000 })).json.status).toBe("allowed");
    expect((await pay({ amount: 40_000 })).json.status).toBe("allowed"); // the refused one doesn't count
  });

  it("re-checks unfinished payouts in case a webhook was missed", async () => {
    const { momo, pay, get, guard, setNow } = await setup();
    const r = (await pay()).json;
    momo.set("pay_1", "succeeded");
    setNow(new Date("2026-11-03T10:02:00Z"));
    expect(await guard.syncPayouts()).toMatchObject({ checked: 1 });
    expect((await get(r.id)).payout.status).toBe("succeeded");
  });

  it("writes every payout step to the audit log", async () => {
    const { momo, pay, webhook, call } = await setup();
    await pay();
    momo.set("pay_1", "succeeded");
    await webhook({ data: { id: "pay_1" } });
    const events = (await call("GET", "/v1/audit/verify", OWNER_KEY)).json;
    expect(events.ok).toBe(true);
  });
});

describe("MoMo One-API client", () => {
  it("speaks MoMo One-API's payout format and reports refusals", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      if (String(url).endsWith("/v1/payouts")) return new Response(JSON.stringify({ id: "pay_9", status: "pending", failure: null }), { status: 201 });
      if (String(url).includes("/v1/payments/")) return new Response(JSON.stringify({ id: "pay_9", status: "succeeded", failure: null }), { status: 200 });
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    const client = momoClient("http://momo.test/", "key-123", fake);
    const p = await client.createPayout({ idempotencyKey: "pr_1", amount: 2500, currency: "GHS", phone: "0241234567", network: "mtn", name: "Ama", description: "x".repeat(150), metadata: { a: "b" } });
    expect(p).toEqual({ id: "pay_9", status: "pending", failure: null });
    const { url, init } = seen[0]!;
    expect(url).toBe("http://momo.test/v1/payouts");
    expect((init.headers as Record<string, string>)["idempotency-key"]).toBe("pr_1");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer key-123");
    expect(JSON.parse(String(init.body))).toEqual({ amount: 2500, currency: "GHS", phone: "0241234567", network: "mtn", customer: { name: "Ama" }, description: "x".repeat(100), metadata: { a: "b" } });
    expect((await client.getPayout("pay_9")).status).toBe("succeeded");

    const refusing = momoClient("http://momo.test", "k", (async () => new Response(JSON.stringify({ error: "No provider" }), { status: 422 })) as unknown as typeof fetch);
    await expect(refusing.createPayout({ idempotencyKey: "x", amount: 1, currency: "GHS", phone: "0241234567", network: "mtn", name: "A", description: "d", metadata: {} })).rejects.toThrow("refused");
  });
});
