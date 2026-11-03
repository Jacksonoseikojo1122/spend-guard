# Using Spend Guard from an AI agent (MCP)

Spend Guard ships an [MCP](https://modelcontextprotocol.io) server, so Claude and other MCP-capable agents can ask to pay without ever holding a payment key. It runs as a small local process next to the agent and talks to your Spend Guard with **one agent's key**. It can do exactly what that key can: ask to pay, check its own payments, and read its own limits. It can't approve anything, change a policy, add a recipient or see another agent.

## The tools

| Tool | What it does |
| --- | --- |
| `request_payment` | Ask to pay a recipient from the agent's list. Needs `amount_minor` (GHS 120.50 is `12050`), `currency`, `recipient`, `reference` and an `idempotency_key` such as `invoice-88`. Optional `reason` is shown to the human approver and doesn't affect the decision. |
| `check_payment` | Look up an earlier request by id: still held, approved, rejected, expired, and how its payout went. |
| `get_my_limits` | The agent's policy and usage: limits, today's and this month's spend, allowed recipients, the approval threshold and working hours. |

Every answer is one plain sentence the model can act on. When a payment is held or denied, the answer says why and tells the model not to retry, split the amount or switch recipient, and to tell the user instead. That's the usual way an agent tries to get around a "no".

A real run over stdio against a live Spend Guard (31 Oct 2026, 06:07 in Accra, before the 07:00 start in the example policy):

```
> get_my_limits
You are procurement-bot. Currency GHS, time zone Africa/Accra.
Single payment: up to GHS 500.00.
Today (2026-10-31): GHS 0.00 used of GHS 2000.00. This month (2026-10): GHS 0.00 of GHS 15000.00.
Requests in the last hour: 0 of 10.
Allowed recipients: supplier:kofi-hardware, supplier:ama-printing. Others are held for approval.
Payments over GHS 200.00 need a person to approve them (they have 30 minutes).
Automatic payments only during Mon-Sat 07:00-19:00; outside that they're held.

> request_payment {"amount_minor":12000,"currency":"GHS","recipient":"supplier:kofi-hardware","reference":"Invoice 88","idempotency_key":"invoice-88"}
Held for a person to approve: GHS 120.00 to supplier:kofi-hardware (Invoice 88). Reason: Payments are only automatic
during Mon-Sat 07:00-19:00 (Africa/Accra). They have until 2026-10-31T06:37:15.701Z. Tell the user it's waiting for
approval. Don't send it again, split it into smaller payments, or change the recipient; check it later with
check_payment and id pr_siYryTvEWbTvr0jp.
```

You can run the same check yourself with [`examples/mcp-client.ts`](../examples/mcp-client.ts).

## Setting it up

1. Run Spend Guard and create an agent with a policy (see the [README](../README.md#quick-start)). Keep the `sg_agent_...` key it gives you.
2. Point your agent host at `src/mcp-stdio.ts` with two settings: `SPEND_GUARD_URL` and `SPEND_GUARD_AGENT_KEY`.

Without those two settings the server still starts and lists its tools, but every call answers that it isn't set up, so nothing can be paid. The repo's `Dockerfile` runs this server: `docker build -t spend-guard . && docker run -i -e SPEND_GUARD_URL=... -e SPEND_GUARD_AGENT_KEY=... spend-guard`.

### Claude Desktop

In `claude_desktop_config.json` (Settings → Developer → Edit config):

```json
{
  "mcpServers": {
    "spend-guard": {
      "command": "npx",
      "args": ["tsx", "/path/to/spend-guard/src/mcp-stdio.ts"],
      "env": {
        "SPEND_GUARD_URL": "http://localhost:8790",
        "SPEND_GUARD_AGENT_KEY": "sg_agent_..."
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add spend-guard -e SPEND_GUARD_URL=http://localhost:8790 -e SPEND_GUARD_AGENT_KEY=sg_agent_... -- npx tsx /path/to/spend-guard/src/mcp-stdio.ts
```

### Your own agent

Use any MCP client, as in [`examples/mcp-client.ts`](../examples/mcp-client.ts), or call the HTTP API directly with the agent key.

## Things to know

- **Give each agent its own key.** Then each has its own limits and its own line in the audit log, and you can revoke one without stopping the others.
- **Policies stop size, not intent.** Daily and hourly limits are what stop an agent from splitting one big payment into many small ones. Set them with that in mind, not just the per-payment limit.
- The agent key sits in the MCP config on the machine running the agent. Treat it like a password. If it leaks, revoke the agent; its pending holds are cancelled at once.
