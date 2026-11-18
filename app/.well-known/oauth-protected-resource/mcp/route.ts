import {
  generateProtectedResourceMetadata,
  metadataCorsOptionsRequestHandler,
} from "mcp-handler";
import { authorizationServerIssuer } from "@/lib/fusionauth";
import { connectorResourceUrl, CONNECTOR_SCOPES } from "@/lib/connector-auth";

/**
 * GET /.well-known/oauth-protected-resource/mcp  (RFC 9728, path-suffixed)
 *
 * Metadata for the customer-facing connector at /mcp. `resource` must match a CIMD
 * Domain's Authorized resource URI exactly, and `authorization_servers` must be the
 * Tenant issuer (https://<fusionauth>/<tenantId>) so ChatGPT / claude.ai find FusionAuth's
 * Tenant discovery document, which advertises client_id_metadata_document_supported.
 */
export async function GET() {
  const issuer = await authorizationServerIssuer();
  const metadata = generateProtectedResourceMetadata({
    authServerUrls: [issuer],
    resourceUrl: connectorResourceUrl(),
    additionalMetadata: {
      scopes_supported: CONNECTOR_SCOPES,
      resource_name: "RefundBot",
    },
  });
  return Response.json(metadata, {
    headers: {
      "Cache-Control": "max-age=3600",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
