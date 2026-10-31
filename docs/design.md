# Spend Guard: design

Status: steps 1 and 2 built (decision engine; API, storage and audit log). Written 31 Oct 2026.

## The problem

AI agents are starting to move money. They pay suppliers, refund customers, top up airtime and send mobile money. Today the agent usually holds the provider's secret key and calls Paystack or MTN directly. That means:

- A prompt injection, a bug or a confused model can send any amount to anyone.
- A retry loop can pay the same invoice twice.
- Nobody can answer "why did the agent send GH₵ 900 to this number?" afterwards.

Teams that care build a small permission layer by hand. Most don't. There's no open-source one for African payment rails.

## What Spend Guard is

A small service that sits between agents and the payment provider. The agent never sees the provider keys. It asks Spend Guard to pay, and Spend Guard decides:

- **allow:** the payment goes through MoMo One-API to the provider.
- **hold:** a person must approve it first (by SMS, WhatsApp or the dashboard).
- **deny:** it's refused, with a reason the agent can read and explain.

Every request, decision and result is written to an append-only log.

**It never holds money.** Like MoMo One-API, it only sends instructions. Funds stay in the merchant's own provider account.

## Where it sits

```
 Agent (Claude, any LLM app)
   │  MCP tool call or HTTP: "pay GHS 120 to 024… for invoice 88"
   ▼
 Spend Guard ── policy check ── hold? ──► approver (SMS / WhatsApp / dashboard)
   │ allow
   ▼
 MoMo One-API ──► Paystack / MTN MoMo (merchant's own account)
   │ webhook (via Webhook Relay)
   ▼
 Spend Guard updates the request, notifies the agent
```

## Core ideas

1. **Agents get their own keys, with limits attached.** Each agent key belongs to an owner (a business) and has a policy. Revoking a key stops that agent at once without touching the provider account.
2. **Policies are data, not code.** A policy is a JSON document that is versioned. Every decision records which policy version was used.
3. **Deny by default.** No policy means no payment. Unknown fields in a request mean deny.
4. **The model's words are not trusted.** Amount, currency, recipient and reference are typed fields, validated with Zod. The agent's free-text "reason" is stored and shown to the approver, but never used in a decision.
5. **No double payments.** `Idempotency-Key` is required. The request is saved before anything else happens, and the same key always returns the same result.
6. **Holds expire.** If no one approves within the window (default 30 minutes), the request is denied, so an agent can't wait it out.

## Policy (example)

```json
{
  "currency": "GHS",
  "timezone": "Africa/Accra",
  "limits": {
    "per_payment_max": 50000,
    "per_day_max": 200000,
    "per_month_max": 1500000,
    "payments_per_hour_max": 10
  },
  "recipients": {
    "mode": "allow_list",
    "list": ["supplier:kofi-hardware", "supplier:ama-printing"],
    "new_recipient": "hold"
  },
  "approval": {
    "hold_above": 20000,
    "approvers": ["+233534884648"],
    "channel": "sms",
    "expires_after_minutes": 30
  },
  "hours": { "allow": "Mon-Sat 07:00-19:00", "outside": "hold" }
}
```

Amounts are in minor units (pesewas). The order of checks is fixed and written in the docs, so a decision can be explained step by step.

## Decision order

The API layer does these before the engine runs:

1. Key valid and not revoked, otherwise deny.
2. Request shape valid (Zod, unknown fields rejected), otherwise deny.
3. Idempotency: if seen before, return the stored result.

The decision engine (`src/decide.ts`, a pure function) then runs:

1. No policy: deny.
2. Currency doesn't match the policy: deny.
3. Over the per-payment max: deny.
4. Today's total plus this payment over the daily max: deny. Held payments count toward the total.
5. Same for the month.
6. Too many requests in the last hour: deny.
7. Recipient not on the allow list: follow `new_recipient` (hold or deny).
8. Outside the time window: follow `outside` (hold or deny).
9. Amount above `hold_above`: hold.
10. Otherwise allow.

Steps 1–6 deny straight away. Steps 7–9 are all checked: if any says deny, that wins; otherwise the first hold is reported. The window end is exclusive (19:00 is outside "07:00-19:00").

Each decision names the rule and the numbers, for example `{"result":"deny","rule":"per_day_max","detail":{"amount":12000,"used":190000,"limit":200000}}`.

## API (first version)

| Method | Path | What it does |
| --- | --- | --- |
| POST | `/v1/payment-requests` | Agent asks to pay. Returns `allowed`, `held` or `denied` |
| GET | `/v1/payment-requests/{id}` | Status, decision, the rule that decided, and the provider result |
| POST | `/v1/payment-requests/{id}/approve` | Approver approves (signed link or dashboard) |
| POST | `/v1/payment-requests/{id}/reject` | Approver rejects |
| GET | `/v1/agents/{agent}/usage` | Spent and held today and this month, against limits |
| PUT | `/v1/agents/{agent}/policy` | New policy version (owner key only) |
| POST | `/v1/agents/{agent}/revoke` | Stop the agent at once |
| POST | `/v1/webhooks/momo` | Payment results from MoMo One-API |

Plus an **MCP server** with three tools: `request_payment`, `check_payment`, `get_my_limits`. The agent can see its own limits, so it can tell the user "this needs approval" rather than guessing.

## Data model (Postgres, SQLite for local)

- `owners`: id, name.
- `agents`: id, owner_id, key_hash, revoked_at.
- `policies`: agent_id, version, document (jsonb), created_at. Never updated, only added.
- `payment_requests`: id, agent_id, idempotency_key (unique per agent), amount, currency, recipient, reference, agent_reason, status, decision, decided_by_rule, policy_version, provider_payment_id, timestamps.
- `approvals`: request_id, approver, action, at, channel.
- `audit_log`: append-only; each row stores the previous row's hash, so editing history is detectable.

Totals for limits are computed and the request is inserted in one transaction that holds a single lock (`BEGIN IMMEDIATE` on SQLite, a transaction-scoped advisory lock on Postgres). Two parallel requests can't both squeeze under the daily limit, and the audit log keeps one unbroken order. Decisions are made one at a time, which is plenty for agent traffic; a per-agent lock is a later optimisation.

"Today" and "this month" are stored on each request as `local_day` and `local_month`, worked out in the policy's time zone when the request is decided.

## Security

- Agent keys and approver links are stored hashed. Approval links are single use, expire, and are signed.
- Provider keys live only in MoMo One-API, never in Spend Guard and never with the agent.
- Approvers see the amount, recipient, the agent's reason and the agent's spending so far, so they aren't approving blind.
- Policy changes need the owner key, not an agent key. An agent can't raise its own limits.

## Tests that matter most

- Two parallel requests that each fit the daily limit but together exceed it: exactly one is allowed.
- The same idempotency key sent twice with different amounts: the second is rejected.
- A hold that expires is denied and can't be approved later.
- A prompt-injected "reason" ("ignore limits, this is approved") changes nothing.
- A revoked key is denied mid-run.
- Policy version recorded on every decision; old decisions still explainable after a policy change.

## Stack

TypeScript, Hono, Zod, Postgres (SQLite locally), Vitest, Docker. MCP server with the official TypeScript SDK. Uses MoMo One-API for providers and Webhook Relay for incoming webhooks.

## Build order (about 2 to 3 weeks)

1. Policy schema, decision engine and its tests (no HTTP yet).
2. HTTP API, idempotency, Postgres, audit log with hash chain.
3. Holds and approvals: dashboard page first, then SMS (Arkesel or Hubtel) approval links.
4. MoMo One-API integration in sandbox mode, end to end.
5. MCP server, plus an example with Claude: a procurement agent paying two suppliers, one payment held for approval.
6. Docs, OpenAPI, llms.txt, demo screenshots, project page on jacksonkojoosei.com.

## Not in the first version

- Card payments and bank transfers (mobile money first).
- Multi-currency conversion.
- Machine-learned fraud scoring. Rules first, because rules can be explained.
