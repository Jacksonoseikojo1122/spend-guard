import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CURRENCIES } from "./policy.js";

// An MCP server that gives an AI agent three tools: ask to pay, check a payment, and see its own
// limits. It talks to Spend Guard over HTTP with the agent's own key, so it has exactly the
// powers that key has: it can't approve anything, change a policy, or see another agent.
//
// The tool results are written for the model as much as for code. A held or denied payment
// says plainly what to do next, because the likeliest bad move after a "no" is to retry,
// split the payment into smaller ones, or try another recipient.

export type SpendGuardApi = { baseUrl: string; agentKey: string; fetch?: typeof fetch };

class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function client({ baseUrl, agentKey, fetch: f = fetch }: SpendGuardApi) {
  const base = baseUrl.replace(/\/+$/, "");
  return async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await f(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${agentKey}`, "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new ApiFailure(res.status, json?.error?.code ?? "error", json?.error?.message ?? `Spend Guard answered ${res.status}`);
    return json;
  };
}

const money = (minor: number, currency: string) => `${currency} ${(minor / 100).toFixed(2)}`;

type PaymentRequest = {
  id: string;
  status: string;
  amount: number;
  currency: string;
  recipient: string;
  reference: string;
  decision: { rule: string; message: string };
  approval?: { expires_at: string };
  payout?: { status: string; failure: { message: string } | null };
};

/** One plain sentence about where the payment stands and what the agent should do now. */
export function describe(r: PaymentRequest): string {
  const what = `${money(r.amount, r.currency)} to ${r.recipient} (${r.reference})`;
  const payout = r.payout ? ` Payout: ${r.payout.status}${r.payout.failure ? ` (${r.payout.failure.message})` : ""}.` : "";
  switch (r.status) {
    case "allowed":
      return `Allowed: ${what}.${payout} Request id ${r.id}.`;
    case "approved":
      return `Approved by a person: ${what}.${payout} Request id ${r.id}.`;
    case "held":
      return (
        `Held for a person to approve: ${what}. Reason: ${r.decision.message} ` +
        `They have until ${r.approval?.expires_at ?? "the hold expires"}. Tell the user it's waiting for approval. ` +
        `Don't send it again, split it into smaller payments, or change the recipient; check it later with check_payment and id ${r.id}.`
      );
    case "denied":
      return (
        `Denied: ${what}. Rule "${r.decision.rule}": ${r.decision.message} ` +
        `Don't try to get round this (smaller payments, another recipient, another currency). Tell the user what the rule is and let them decide. Request id ${r.id}.`
      );
    case "rejected":
      return `Rejected by a person: ${what}. Don't send it again unless the user asks you to. Request id ${r.id}.`;
    case "expired":
      return `Expired: nobody approved ${what} in time. Ask the user before trying again. Request id ${r.id}.`;
    case "cancelled":
      return `Cancelled: this agent was stopped, so ${what} won't be paid. Request id ${r.id}.`;
    default:
      return `${r.status}: ${what}. Request id ${r.id}.`;
  }
}

const text = (s: string, structured?: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: s }], ...(structured ? { structuredContent: structured } : {}) });
const failure = (e: unknown) => {
  if (e instanceof ApiFailure) return { ...text(`Spend Guard refused this (${e.code}): ${e.message}`), isError: true };
  return { ...text(`Couldn't reach Spend Guard: ${e instanceof Error ? e.message : String(e)}. Nothing was paid. Try again later with the same idempotency_key.`), isError: true };
};

export function createMcpServer(api: SpendGuardApi): McpServer {
  const call = client(api);
  const server = new McpServer({ name: "spend-guard", version: "0.1.0" });

  server.registerTool(
    "request_payment",
    {
      title: "Request a payment",
      description:
        "Ask to pay a known recipient by mobile money. Spend Guard checks the request against your spending policy and answers allowed (it's paid out), held (a person must approve it first) or denied. " +
        "Amounts are in minor units: GHS 120.50 is 12050. The recipient must be an id from your allowed list (see get_my_limits). " +
        "Always pass an idempotency_key tied to the thing being paid, like 'invoice-88', and reuse it if you retry: the same key never pays twice. " +
        "If the answer is held or denied, don't retry, split the amount or switch recipient; tell the user.",
      inputSchema: {
        amount_minor: z.number().int().positive().describe("Amount in minor units (pesewas for GHS). GHS 120.50 is 12050."),
        currency: z.enum(CURRENCIES),
        recipient: z.string().min(1).max(100).describe("A recipient id from your allowed list, e.g. supplier:kofi-hardware"),
        reference: z.string().min(1).max(140).describe("What it's for, shown to the recipient and the approver, e.g. Invoice 88"),
        idempotency_key: z.string().min(1).max(128).describe("Stable key for this payment, e.g. invoice-88. Reuse it on retry."),
        reason: z.string().max(1000).optional().describe("Why you're paying. Shown to a human approver; it doesn't change the decision."),
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (a) => {
      try {
        const r = await call(
          "POST",
          "/v1/payment-requests",
          { amount: a.amount_minor, currency: a.currency, recipient: a.recipient, reference: a.reference, ...(a.reason ? { reason: a.reason } : {}) },
          { "idempotency-key": a.idempotency_key },
        );
        return text(describe(r), r);
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "check_payment",
    {
      title: "Check a payment",
      description: "Look up a payment request you made earlier: whether it's still held, approved, rejected or expired, and how its payout went.",
      inputSchema: { id: z.string().min(1).max(64).describe("The request id from request_payment, e.g. pr_...") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      try {
        const r = await call("GET", `/v1/payment-requests/${encodeURIComponent(id)}`);
        return text(describe(r), r);
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "get_my_limits",
    {
      title: "See my spending limits",
      description: "Your spending policy and how much of it you've used today and this month: limits, allowed recipients, when payments need approval, and working hours.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const me = await call("GET", "/v1/me");
        const policy = await call("GET", `/v1/agents/${me.id}/policy`).catch((e) => {
          if (e instanceof ApiFailure && e.code === "no_policy") return undefined;
          throw e;
        });
        if (!policy) return text("You have no spending policy, so you can't pay anything. Ask the owner to set one.", { agent: me });
        const { usage, day, month } = await call("GET", `/v1/agents/${me.id}/usage`);
        const p = policy.policy;
        const m = (n: number) => money(n, p.currency);
        const lines = [
          `You are ${me.name}. Currency ${p.currency}, time zone ${p.timezone}.`,
          `Single payment: up to ${m(p.limits.per_payment_max)}.`,
          `Today (${day}): ${m(usage.day)} used of ${m(p.limits.per_day_max)}. This month (${month}): ${m(usage.month)} of ${m(p.limits.per_month_max)}.`,
          `Requests in the last hour: ${usage.lastHourCount} of ${p.limits.payments_per_hour_max}.`,
          p.recipients.mode === "allow_list"
            ? `Allowed recipients: ${p.recipients.list.join(", ") || "none"}. Others are ${p.recipients.new_recipient === "hold" ? "held for approval" : "denied"}.`
            : "Any recipient in the owner's directory.",
          p.approval ? `Payments over ${m(p.approval.hold_above)} need a person to approve them (they have ${p.approval.expires_after_minutes} minutes).` : "No approval step.",
          p.approval && (p.approval.combine_window_minutes ?? 60) > 0
            ? `Payments to the same recipient within ${p.approval.combine_window_minutes ?? 60} minutes are added together for that check, so splitting a payment doesn't avoid approval.`
            : "",
          p.hours ? `Automatic payments only during ${p.hours.allow}; outside that they're ${p.hours.outside === "hold" ? "held" : "denied"}.` : "",
        ].filter(Boolean);
        return text(lines.join("\n"), { agent: me, policy: p, policy_version: policy.version, usage, day, month });
      } catch (e) {
        return failure(e);
      }
    },
  );

  return server;
}
