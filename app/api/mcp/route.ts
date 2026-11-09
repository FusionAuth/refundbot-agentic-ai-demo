import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { registerAgentTools, registerRefundTools } from "@/lib/mcp-server";
import { verifyMcpToken } from "@/lib/mcp-auth";

/**
 * The real MCP server — a genuine OAuth 2.1 resource server exposed over
 * Streamable HTTP via Vercel's mcp-handler (built on @modelcontextprotocol/server).
 * mcp-handler 2.3+ serves the streamable endpoint at whatever route mounts it — here,
 * /api/mcp.
 *
 * `withMcpAuth` makes it a real resource server: every request's bearer token is
 * verified by our OWN, independent verifier (lib/mcp-auth.ts) — a separate JWKS
 * code path from the human session reader — and a missing/expired/under-verified
 * token is answered with 401 + WWW-Authenticate pointing at the RFC 9728 metadata
 * (app/.well-known/oauth-protected-resource). Per-tool scope checks then run
 * inside each handler (lib/mcp-server.ts). That's the second, independent
 * authorization layer the demo makes visible.
 */
const baseHandler = createMcpHandler(
  (server) => {
    registerAgentTools(server);
    // RefundBot's four pipeline services. Same transport, same bearer verifier — but each
    // demands an RFC 8693 exchanged token for its own audience (see exchangeGate).
    registerRefundTools(server);
  },
  {
    serverInfo: {
      name: "InFusion Agent — MCP Tool Server",
      version: "0.1.0",
    },
  }
);

const handler = withMcpAuth(baseHandler, verifyMcpToken, {
  required: true,
  resourceMetadataPath: "/.well-known/oauth-protected-resource",
});

export { handler as GET, handler as POST, handler as DELETE };
