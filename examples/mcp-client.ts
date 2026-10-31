// Starts the Spend Guard MCP server the way an agent host does (as a child process over stdio),
// lists its tools and makes a couple of calls. Useful to check your setup before wiring it into
// Claude Desktop, Claude Code or your own agent.
//
//   SPEND_GUARD_URL=http://localhost:8790 SPEND_GUARD_AGENT_KEY=sg_agent_... npx tsx examples/mcp-client.ts

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const env = { SPEND_GUARD_URL: process.env.SPEND_GUARD_URL ?? "", SPEND_GUARD_AGENT_KEY: process.env.SPEND_GUARD_AGENT_KEY ?? "", PATH: process.env.PATH ?? "" };
const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/mcp-stdio.ts"], env });
const client = new Client({ name: "spend-guard-example", version: "1.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));

const show = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  console.log(`\n> ${name} ${JSON.stringify(args)}${r.isError ? "  (error)" : ""}\n${r.content[0]?.text}`);
};
await show("get_my_limits");
await show("request_payment", { amount_minor: 12000, currency: "GHS", recipient: "supplier:kofi-hardware", reference: "Invoice 88", idempotency_key: "invoice-88" });
await show("request_payment", { amount_minor: 35000, currency: "GHS", recipient: "supplier:ama-printing", reference: "Invoice 91", idempotency_key: "invoice-91", reason: "Posters for the launch" });
await client.close();
