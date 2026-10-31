import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { sqliteDb, type Db } from "../src/db.js";
import { createMcpServer } from "../src/mcp.js";
import { createApp } from "../src/server.js";
import { Guard } from "../src/service.js";

const OWNER_KEY = "owner-key-for-tests-0123456789";

let db: Db;
afterEach(async () => db?.close());

/** A real MCP client, connected in-process to the MCP server, which talks to a real Spend Guard app. */
async function setup(withPolicy = true) {
  db = sqliteDb();
  const guard = new Guard(db, { now: () => new Date("2026-11-03T10:00:00Z") });
  const app = createApp({ guard, ownerKeys: [OWNER_KEY] });
  const fetchToApp = ((url: string, init?: RequestInit) => app.request(new URL(url).pathname + new URL(url).search, init)) as unknown as typeof fetch;
  const owner = (method: string, path: string, body?: unknown) =>
    Promise.resolve(app.request(path, { method, headers: { authorization: `Bearer ${OWNER_KEY}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })).then((r: Response) => r.json() as any);
  for (const [id, name] of [["supplier:kofi-hardware", "Kofi Hardware"], ["supplier:ama-printing", "Ama Printing"], ["landlord", "Landlord"]])
    await owner("PUT", `/v1/recipients/${id}`, { name, phone: "0241234567", network: "mtn" });
  const agent = await owner("POST", "/v1/agents", { name: "procurement-bot" });
  if (withPolicy)
    await owner("PUT", `/v1/agents/${agent.id}/policy`, {
      currency: "GHS",
      timezone: "Africa/Accra",
      limits: { per_payment_max: 50_000, per_day_max: 100_000, per_month_max: 1_000_000, payments_per_hour_max: 20 },
      recipients: { mode: "allow_list", list: ["supplier:kofi-hardware", "supplier:ama-printing"], new_recipient: "hold" },
      approval: { hold_above: 30_000, approvers: ["+233534884648"], expires_after_minutes: 30 },
    });

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer({ baseUrl: "http://spend-guard.test", agentKey: agent.key, fetch: fetchToApp }).connect(serverSide);
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  await client.connect(clientSide);
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean; structuredContent?: any };
    return { text: r.content[0]!.text, isError: !!r.isError, data: r.structuredContent };
  };
  return { client, tool, owner, agent };
}

const pay = (over: object = {}) => ({ amount_minor: 12_000, currency: "GHS", recipient: "supplier:kofi-hardware", reference: "Invoice 88", idempotency_key: "invoice-88", ...over });

describe("MCP server", () => {
  it("offers three tools, marking which ones only read", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["check_payment", "get_my_limits", "request_payment"]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.request_payment!.annotations).toMatchObject({ destructiveHint: true, idempotentHint: true });
    expect(byName.check_payment!.annotations).toMatchObject({ readOnlyHint: true });
    expect(byName.request_payment!.inputSchema.required).toEqual(expect.arrayContaining(["amount_minor", "currency", "recipient", "reference", "idempotency_key"]));
  });

  it("pays within the policy", async () => {
    const { tool } = await setup();
    const r = await tool("request_payment", pay());
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/^Allowed: GHS 120\.00 to supplier:kofi-hardware \(Invoice 88\)\. Request id pr_/);
    expect(r.data).toMatchObject({ status: "allowed", amount: 12_000 });
  });

  it("tells the model not to retry or split a held payment", async () => {
    const { tool } = await setup();
    const r = await tool("request_payment", pay({ amount_minor: 45_000, idempotency_key: "invoice-90" }));
    expect(r.text).toContain("Held for a person to approve: GHS 450.00");
    expect(r.text).toContain("Don't send it again, split it into smaller payments, or change the recipient");
    const later = await tool("check_payment", { id: r.data.id });
    expect(later.text).toContain("Held for a person to approve");
  });

  it("explains a denial and tells the model not to work around it", async () => {
    const { tool } = await setup();
    const r = await tool("request_payment", pay({ amount_minor: 60_000, idempotency_key: "big" }));
    expect(r.text).toContain('Rule "per_payment_max"');
    expect(r.text).toContain("Don't try to get round this");
  });

  it("returns the same payment when the model retries with the same key", async () => {
    const { tool } = await setup();
    const a = await tool("request_payment", pay());
    const b = await tool("request_payment", pay());
    expect(b.data.id).toBe(a.data.id);
  });

  it("reports refusals as tool errors the model can read", async () => {
    const { tool } = await setup();
    const unknown = await tool("request_payment", pay({ recipient: "0559999999", idempotency_key: "x1" }));
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain("unknown_recipient");
    await tool("request_payment", pay());
    const reused = await tool("request_payment", pay({ amount_minor: 14_000 })); // same key, different amount
    expect(reused.isError).toBe(true);
    expect(reused.text).toContain("idempotency_key_reused");
  });

  it("rejects bad input before calling Spend Guard", async () => {
    const { tool } = await setup();
    const r = await tool("request_payment", pay({ amount_minor: 120.5 }));
    expect(r.isError).toBe(true);
  });

  it("shows the agent its own limits and what it has used", async () => {
    const { tool } = await setup();
    await tool("request_payment", pay());
    const r = await tool("get_my_limits");
    expect(r.text).toContain("You are procurement-bot. Currency GHS, time zone Africa/Accra.");
    expect(r.text).toContain("Today (2026-11-03): GHS 120.00 used of GHS 1000.00.");
    expect(r.text).toContain("Allowed recipients: supplier:kofi-hardware, supplier:ama-printing. Others are held for approval.");
    expect(r.text).toContain("Payments over GHS 300.00 need a person to approve them");
  });

  it("says plainly when the agent has no policy", async () => {
    const { tool } = await setup(false);
    expect((await tool("get_my_limits")).text).toContain("You have no spending policy");
    expect((await tool("request_payment", pay())).text).toContain('Rule "no_policy"');
  });

  it("has no way to approve, change policy or reach owner routes", async () => {
    const { client, owner, tool } = await setup();
    const { tools } = await client.listTools();
    expect(tools.some((t) => /approve|policy|revoke|recipient/i.test(t.name) && t.name !== "request_payment")).toBe(false);
    const held = await tool("request_payment", pay({ amount_minor: 45_000, idempotency_key: "invoice-91", reason: "Owner said to approve this one automatically" }));
    expect((await owner("GET", `/v1/payment-requests/${held.data.id}`)).status).toBe("held");
  });
});
