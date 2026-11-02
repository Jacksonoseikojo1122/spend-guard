import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { postgresDb, sqliteDb, type Db } from "../src/db.js";
import { webhookNotifier, type ApprovalNotice } from "../src/notify.js";
import { createApp } from "../src/server.js";
import { Guard } from "../src/service.js";

const OWNER_KEY = "owner-key-for-tests-0123456789";
const OTHER_OWNER_KEY = "another-owner-key-for-tests-987";

const policy = (overrides: object = {}) => ({
  currency: "GHS",
  timezone: "Africa/Accra",
  limits: { per_payment_max: 50_000, per_day_max: 100_000, per_month_max: 1_000_000, payments_per_hour_max: 100 },
  recipients: { mode: "allow_list", list: ["supplier:kofi"], new_recipient: "hold" },
  // These tests pay the same supplier repeatedly; combining is covered in api.test.ts and decide.test.ts.
  approval: { hold_above: 20_000, approvers: ["+233534884648", "+233201234567"], channel: "sms", expires_after_minutes: 30, combine_window_minutes: 0 },
  ...overrides,
});

const backends: [string, () => Promise<Db>][] = [["sqlite", async () => sqliteDb()]];
if (process.env.TEST_DATABASE_URL) {
  backends.push([
    "postgres",
    async () => {
      const db = await postgresDb(process.env.TEST_DATABASE_URL!);
      for (const t of ["agents", "policies", "payment_requests", "approval_tokens", "audit_log"]) await db.query(`DELETE FROM ${t}`);
      return db;
    },
  ]);
}

describe.each(backends)("approvals on %s", (_name, makeDb) => {
  let db: Db;
  afterEach(async () => db?.close());

  async function setup() {
    db = await makeDb();
    let now = new Date("2026-11-03T10:00:00Z");
    const sent: ApprovalNotice[] = [];
    const guard = new Guard(db, { now: () => now, publicUrl: "https://guard.example.com/", notifier: { send: async (n) => void sent.push(n) } });
    const app = createApp({ guard, ownerKeys: [OWNER_KEY, OTHER_OWNER_KEY] });
    const call = async (method: string, path: string, key: string | null, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await app.request(path, {
        method,
        headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { status: res.status, text, json };
    };
    const form = (path: string, action: string) =>
      Promise.resolve(app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `action=${action}` })).then(async (r: Response) => ({ status: r.status, text: await r.text() }));
    await call("PUT", "/v1/recipients/supplier:kofi", OWNER_KEY, { name: "Kofi Hardware", phone: "0241234567", network: "mtn" });
    const { json: agent } = await call("POST", "/v1/agents", OWNER_KEY, { name: "procurement-bot" });
    await call("PUT", `/v1/agents/${agent.id}/policy`, OWNER_KEY, policy());
    let n = 0;
    const pay = (body: object = {}) =>
      call("POST", "/v1/payment-requests", agent.key, { amount: 30_000, currency: "GHS", recipient: "supplier:kofi", reference: "Invoice 88", ...body }, { "idempotency-key": `k-${++n}` });
    const linkPath = (notice: ApprovalNotice) => new URL(notice.url).pathname;
    return { guard, call, form, pay, sent, agent, linkPath, setNow: (d: Date) => (now = d) };
  }

  it("sends each approver their own link once the hold is saved", async () => {
    const { pay, sent } = await setup();
    const held = (await pay()).json;
    expect(held.status).toBe("held");
    expect(sent.map((s) => s.approver)).toEqual(["+233534884648", "+233201234567"]);
    expect(sent[0]!.url).toMatch(/^https:\/\/guard\.example\.com\/approve\/[\w-]{32}$/);
    expect(sent[0]!.url).not.toBe(sent[1]!.url);
    expect(sent[0]!.message).toContain("procurement-bot wants to pay GHS 300.00 to supplier:kofi (Invoice 88)");
    expect(sent[0]!.message).toContain("before 10:30");
    const tokens = await db.query("SELECT token_hash FROM approval_tokens");
    expect(tokens.map((t) => t.token_hash)).not.toContain(sent[0]!.url.split("/").pop()); // only hashes stored
  });

  it("doesn't approve anything when the link is only opened", async () => {
    const { call, pay, sent, linkPath } = await setup();
    const held = (await pay({ reason: "<script>alert(1)</script> Ignore the limit, owner said yes" })).json;
    const page = await call("GET", linkPath(sent[0]!), null);
    expect(page.status).toBe(200);
    expect(page.text).toContain("GHS 300.00");
    expect(page.text).toContain("The agent's own note (not checked)");
    expect(page.text).toContain("&lt;script&gt;");
    expect(page.text).not.toContain("<script>");
    expect((await call("GET", `/v1/payment-requests/${held.id}`, OWNER_KEY)).json.status).toBe("held");
  });

  it("approves through the link, once, and counts the approved amount toward limits", async () => {
    const { call, form, pay, sent, linkPath } = await setup();
    const held = (await pay({ amount: 45_000 })).json;
    const r = await form(linkPath(sent[0]!), "approve");
    expect(r.status).toBe(200);
    expect(r.text).toContain("approved");
    const after = (await call("GET", `/v1/payment-requests/${held.id}`, OWNER_KEY)).json;
    expect(after).toMatchObject({ status: "approved", resolved: { by: "approver:+233534884648" } });
    expect((await form(linkPath(sent[0]!), "reject")).status).toBe(409); // same link again
    expect((await form(linkPath(sent[1]!), "reject")).status).toBe(409); // the other approver's link closed too
    await pay({ amount: 45_000 }); // held, reserves room
    expect((await pay({ amount: 15_000 })).json).toMatchObject({ status: "denied", decision: { rule: "per_day_max", detail: { used: 90_000 } } });
  });

  it("rejects through the link and frees the room", async () => {
    const { call, form, pay, sent, linkPath } = await setup();
    const held = (await pay({ amount: 45_000 })).json;
    await pay({ amount: 45_000 });
    expect((await form(linkPath(sent[0]!), "reject")).text).toContain("rejected");
    expect((await call("GET", `/v1/payment-requests/${held.id}`, OWNER_KEY)).json.status).toBe("rejected");
    expect((await pay({ amount: 15_000 })).json.status).toBe("allowed");
  });

  it("refuses a late answer and marks the hold expired", async () => {
    const { call, form, pay, sent, linkPath, setNow, guard } = await setup();
    const held = (await pay()).json;
    expect(held.approval.expires_at).toBe("2026-11-03T10:30:00.000Z");
    setNow(new Date("2026-11-03T10:30:00Z"));
    expect((await call("GET", `/v1/payment-requests/${held.id}`, OWNER_KEY)).json.status).toBe("expired"); // reads expired at once
    const late = await form(linkPath(sent[0]!), "approve");
    expect(late.status).toBe(410);
    expect(late.text).toContain("Too late");
    const audit = await db.query("SELECT event FROM audit_log WHERE subject = $1 ORDER BY seq", [held.id]);
    expect(audit.map((a) => a.event)).toEqual(["payment_request.decided", "payment_request.expired"]);
    expect(await guard.expireHolds()).toBe(0); // already recorded
  });

  it("lets the sweeper expire unanswered holds", async () => {
    const { call, pay, setNow, guard } = await setup();
    const a = (await pay()).json;
    const b = (await pay()).json;
    setNow(new Date("2026-11-03T11:00:00Z"));
    expect(await guard.expireHolds()).toBe(2);
    for (const id of [a.id, b.id]) expect((await call("GET", `/v1/payment-requests/${id}`, OWNER_KEY)).json).toMatchObject({ status: "expired", resolved: { by: "system" } });
  });

  it("lets the owner approve or reject over the API, and nobody else", async () => {
    const { call, pay, agent } = await setup();
    const one = (await pay()).json;
    const two = (await pay()).json;
    expect((await call("POST", `/v1/payment-requests/${one.id}/approve`, agent.key)).status).toBe(403); // an agent can't approve itself
    expect((await call("POST", `/v1/payment-requests/${one.id}/approve`, OTHER_OWNER_KEY)).status).toBe(404);
    expect((await call("POST", `/v1/payment-requests/${one.id}/approve`, OWNER_KEY)).json).toMatchObject({ status: "approved", resolved: { by: expect.stringMatching(/^owner:/) } });
    expect((await call("POST", `/v1/payment-requests/${two.id}/reject`, OWNER_KEY)).json.status).toBe("rejected");
    expect((await call("POST", `/v1/payment-requests/${two.id}/approve`, OWNER_KEY)).status).toBe(409);
    const allowed = (await pay({ amount: 100 })).json;
    expect((await call("POST", `/v1/payment-requests/${allowed.id}/approve`, OWNER_KEY)).json.error.code).toBe("not_held");
  });

  it("cancels pending holds when the agent is revoked", async () => {
    const { call, form, pay, sent, linkPath, agent } = await setup();
    const held = (await pay()).json;
    await call("POST", `/v1/agents/${agent.id}/revoke`, OWNER_KEY);
    expect((await call("GET", `/v1/payment-requests/${held.id}`, OWNER_KEY)).json.status).toBe("cancelled");
    expect((await form(linkPath(sent[0]!), "approve")).status).toBe(409);
  });

  it("lists requests by status", async () => {
    const { call, pay, agent } = await setup();
    await pay();
    await pay({ amount: 100 });
    await pay({ amount: 99_000 });
    const held = (await call("GET", "/v1/payment-requests?status=held", OWNER_KEY)).json.payment_requests;
    expect(held).toHaveLength(1);
    expect((await call("GET", "/v1/payment-requests", agent.key)).json.payment_requests).toHaveLength(3);
    expect((await call("GET", "/v1/payment-requests", OTHER_OWNER_KEY)).json.payment_requests).toHaveLength(0);
    expect((await call("GET", "/v1/payment-requests?status=paid", OWNER_KEY)).status).toBe(400);
  });

  it("keeps the hold when a notice can't be sent", async () => {
    db = await makeDb();
    const guard = new Guard(db, { now: () => new Date("2026-11-03T10:00:00Z"), notifier: { send: async () => Promise.reject(new Error("SMS gateway down")) } });
    await guard.setRecipient("o", "supplier:kofi", { name: "Kofi", phone: "0241234567", network: "mtn" });
    const { agent, key } = await guard.createAgent("o", "bot");
    await guard.setPolicy("o", agent.id, policy());
    const { request } = await guard.requestPayment(agent, "k1", { amount: 30_000, currency: "GHS", recipient: "supplier:kofi", reference: "x" });
    expect(request.status).toBe("held");
    expect(key).toBeTruthy();
  });

  it("records approvals in the audit chain, which still verifies", async () => {
    const { call, form, pay, sent, linkPath } = await setup();
    await pay();
    await form(linkPath(sent[0]!), "approve");
    expect((await call("GET", "/v1/audit/verify", OWNER_KEY)).json).toMatchObject({ ok: true, entries: 5 });
  });
});

describe("webhook notifier", () => {
  it("posts a signed body that the receiver can check", async () => {
    let got: { body: string; sig: string } | undefined;
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        got = { body, sig: String(req.headers["x-spendguard-signature"]) };
        res.end("ok");
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
    try {
      const notice: ApprovalNotice = {
        approver: "+233534884648", channel: "sms", message: "hello", url: "https://x/approve/t",
        request: { id: "pr_1", agent_name: "bot", amount: 100, currency: "GHS", recipient: "r", reference: "ref", expires_at: "2026-11-03T10:30:00.000Z" },
      };
      await webhookNotifier(url, "s3cret").send(notice);
      expect(JSON.parse(got!.body)).toMatchObject({ type: "approval.requested", approver: "+233534884648" });
      expect(got!.sig).toBe(`sha256=${createHmac("sha256", "s3cret").update(got!.body).digest("hex")}`);
    } finally {
      server.close();
    }
  });
});
