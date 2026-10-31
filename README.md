# Spend Guard

Spending limits and human approval for AI agents that move money on mobile money.

> **Status: in progress.** The policy format and the decision engine are built and tested (`src/decide.ts`). The HTTP API, approvals, MoMo One-API connection and MCP server are next. This README describes what v0.1 will do. See the [design](docs/design.md).

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

## Example

```bash
curl -X POST localhost:8790/v1/payment-requests \
  -H "authorization: Bearer agent_key_..." -H "Idempotency-Key: invoice-88" \
  -H "content-type: application/json" \
  -d '{"amount":12000,"currency":"GHS","recipient":"supplier:kofi-hardware","reference":"Invoice 88","reason":"Paying for roofing sheets delivered Tuesday"}'
```

Example response (not yet produced by a real run):

```json
{
  "id": "pr_01J...",
  "status": "held",
  "decision": { "result": "hold", "rule": "hold_above", "amount": 12000, "threshold": 10000 },
  "approval": { "channel": "sms", "expires_at": "2026-11-20T10:30:00Z" }
}
```

## Docs

| | |
| --- | --- |
| [Design](docs/design.md) | The problem, policies, decision order, API, data model, security, tests and build order |

## Related projects

- [MoMo One-API](https://github.com/Jacksonoseikojo1122/momo-one-api): one API across MTN MoMo, Telecel Cash, AirtelTigo Money and M-Pesa. Spend Guard sends allowed payments through it.
- [Webhook Relay](https://github.com/Jacksonoseikojo1122/webhook-relay): verifies, stores and retries the payment webhooks.

## Author

Built by **[Jackson Kojo Osei](https://jacksonkojoosei.com)**, CTO in Accra, Ghana.
[LinkedIn](https://www.linkedin.com/in/jackson-kojo-osei-740846189) · [All projects](https://jacksonkojoosei.com/projects)

## License

MIT
