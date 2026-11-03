import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./mcp.js";

// Run by the agent's host (Claude Desktop, Claude Code, your own agent) as a local process.
// It only needs Spend Guard's address and this agent's key. Nothing is printed to stdout,
// which belongs to the MCP protocol.
//
// Without them it still starts and lists its tools, so a host or directory can see what it
// offers, but every tool call answers that it isn't set up yet. Nothing can be paid that way.

const baseUrl = process.env.SPEND_GUARD_URL;
const agentKey = process.env.SPEND_GUARD_AGENT_KEY;
const missing = "Spend Guard isn't set up here: set SPEND_GUARD_URL and SPEND_GUARD_AGENT_KEY (an sg_agent_ key from POST /v1/agents)";

const api =
  baseUrl && agentKey
    ? { baseUrl, agentKey }
    : {
        baseUrl: "http://spend-guard.invalid",
        agentKey: "",
        fetch: (async () => {
          throw new Error(missing);
        }) as typeof fetch,
      };
if (!baseUrl || !agentKey) console.error(`${missing}. Starting anyway; tool calls will fail until they're set.`);

await createMcpServer(api).connect(new StdioServerTransport());
