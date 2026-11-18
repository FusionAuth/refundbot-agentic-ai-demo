import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { registerConnectorTools } from "@/lib/connector-tools";
import { verifyConnectorToken } from "@/lib/connector-auth";

/**
 * /mcp — RefundBot as a headless, customer-facing MCP server over Streamable HTTP, for
 * ChatGPT / claude.ai custom connectors. Those apps register with FusionAuth as CIMD
 * clients and present the customer's own token (aud includes this URL).
 *
 * This is the orchestrator's front door, not the backend tool server: /api/mcp still only
 * serves RFC 8693 exchanged tokens, and nothing here changes that. A 401 points the chat
 * app at /.well-known/oauth-protected-resource/mcp.
 */
const baseHandler = createMcpHandler(
  (server) => registerConnectorTools(server),
  {
    serverInfo: { name: "RefundBot", version: "0.1.0" },
    instructions:
      "RefundBot handles refunds for Brightline orders on behalf of the signed-in customer. " +
      "Refunds always need the customer to confirm in their browser: when a tool returns a " +
      "confirmUrl, give it to the customer and don't claim the refund is done until " +
      "get_refund_status says decision is \"refunded\".",
  }
);

const handler = withMcpAuth(baseHandler, verifyConnectorToken, {
  required: true,
  resourceMetadataPath: "/.well-known/oauth-protected-resource/mcp",
});

export { handler as GET, handler as POST, handler as DELETE };

export const dynamic = "force-dynamic";
