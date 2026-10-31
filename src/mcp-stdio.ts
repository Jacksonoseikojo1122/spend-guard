import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./mcp.js";

// Run by the agent's host (Claude Desktop, Claude Code, your own agent) as a local process.
// It only needs Spend Guard's address and this agent's key. Nothing is printed to stdout,
// which belongs to the MCP protocol.

const baseUrl = process.env.SPEND_GUARD_URL;
const agentKey = process.env.SPEND_GUARD_AGENT_KEY;
if (!baseUrl || !agentKey) {
  console.error("Set SPEND_GUARD_URL and SPEND_GUARD_AGENT_KEY (an sg_agent_ key from POST /v1/agents).");
  process.exit(1);
}

await createMcpServer({ baseUrl, agentKey }).connect(new StdioServerTransport());
