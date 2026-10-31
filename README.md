# Spend Guard

Spending limits and human approval for AI agents that move money on mobile money.

> **Status: in progress.** Built and tested: the policy format, the decision engine, the HTTP API with idempotency, SQLite and Postgres storage, and the tamper-evident audit log. Next: approvals, the MoMo One-API connection and the MCP server. Until those land, an "allowed" request is recorded but no money moves. See the [design](docs/design.md).

AI agents are starting to pay suppliers, refund customers and send mobile money. Usually the agent holds the provider's secret key and can send any amount to anyone. One prompt injection, bug or retry loop, and the money is gone, with no record of why.

Spend Guard sits between your agents and your payment provider. The agent never sees the provider keys. It asks Spend Guard to pay, and Spend Guard checks the request against that agent's policy:

- **allowed:** sent on to the provider through [MoMo One-API](https://github.com/Jacksonoseikojo1122/momo-one-api).
- **held:** a person approves or rejects it by SMS, WhatsApp or the dashboard.
- **denied:** refused, with the exact rule that stopped it.

**It never holds money.** Funds stay in your own account at Paystack or MTN. Spend Guard only decides and records.

## What you get (planned for v0.1)

- **Keys per agent, with limits attached:** per payment, per day, per month and per hour. Revoke one agent without touching anything else.
- **Recipient allow lists.** New recipients can be held for approval instead of paid.
- **Approval above an amount you choose,** with links that expire. Unanswered holds are denied, so an agent can't wait them out.
- **Deny by default.** No policy means no payment.
- **The agent's words don't count.** Amount, currency and recipient are typed and validated. The agent's "reason" is shown to the approver but never used to decide.
- **No double payments.** `Idempotency-Key` is required. The same key always gets the same answer.
- **An audit log that shows tampering.** Every request, decision, approval and result is recorded, with the policy version and the rule that decided it.
- **An MCP server,** so Claude and other agents can call `request_payment`, `check_payment` and `get_my_limits` directly.

## Quick start

```bash
git clone https://github.com/Jacksonoseikojo1122/spend-guard.git
cd spend-guard && npm install
OWNER_KEYS=choose-a-long-random-owner-key npm start   # http://localhost:8790, SQLite by default
```

Create an agent (its key is shown once) and give it a policy:

```bash
curl -X POST localhost:8790/v1/agents -H "authorization: Bearer $OWNER_KEY" \
  -H "content-type: application/json" -d '{"name":"procurement-bot"}'

curl -X PUT localhost:8790/v1/agents/$AGENT_ID/policy -H "authorization: Bearer $OWNER_KEY" \
  -H "content-type: application/json" -d @examples/policy.json
```

Set `DATABASE_URL` to use Postgres instead of SQLite.

## Example

The agent asks to pay:

```bash
curl -X POST localhost:8790/v1/payment-requests \
  -H "authorization: Bearer sg_agent_..." -H "Idempotency-Key: invoice-88" \
  -H "content-type: application/json" \
  -d '{"amount":12000,"currency":"GHS","recipient":"supplier:kofi-hardware","reference":"Invoice 88","reason":"Paying for roofing sheets delivered Tuesday"}'
```

Response from a real run (31 Oct 2026), with a policy that holds anything over GH₵ 100:

```json
{
  "id": "pr_Lifkkt4fSRESIlOL",
  "status": "held",
  "amount": 12000,
  "currency": "GHS",
  "recipient": "supplier:kofi-hardware",
  "reference": "Invoice 88",
  "reason": "Paying for roofing sheets delivered Tuesday",
  "decision": {
    "result": "hold",
    "rule": "hold_above",
    "message": "Payments of this size need a person to approve them.",
    "detail": { "amount": 12000, "threshold": 10000 }
  },
  "policy_version": 1,
  "approval": { "expires_at": "2026-10-31T06:17:19.470Z" }
}
```

A GH₵ 800 request from the same agent is refused with `"rule": "per_payment_max"` and `"detail": {"amount": 80000, "limit": 50000}`.

## Docs

| | |
| --- | --- |
| [Design](docs/design.md) | The problem, policies, decision order, API, data model, security, tests and build order |
| [Example policy](examples/policy.json) | A policy you can copy |

## Related projects

- [MoMo One-API](https://github.com/Jacksonoseikojo1122/momo-one-api): one API across MTN MoMo, Telecel Cash, AirtelTigo Money and M-Pesa. Spend Guard sends allowed payments through it.
- [Webhook Relay](https://github.com/Jacksonoseikojo1122/webhook-relay): verifies, stores and retries the payment webhooks.

## Author

Built by **[Jackson Kojo Osei](https://jacksonkojoosei.com)**, CTO in Accra, Ghana.
[LinkedIn](https://www.linkedin.com/in/jackson-kojo-osei-740846189) · [All projects](https://jacksonkojoosei.com/projects)

## License

MIT
