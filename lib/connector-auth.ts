import { createRemoteJWKSet, jwtVerify } from "jose";
import type { AuthInfo } from "@modelcontextprotocol/server";

/**
 * Bearer-token verifier for the customer-facing MCP connector (app/mcp) — the endpoint
 * ChatGPT / claude.ai connect to as a Streamable HTTP MCP server.
 *
 * Those apps register with FusionAuth just-in-time as CIMD clients (one CIMD Domain per
 * origin, Tenant-level, Enterprise 1.70+), log the customer in with PKCE, and send
 * `resource=<connector URL>`. FusionAuth then issues an access token whose `aud` holds
 * two values: the app's client_id URL and the connector URL. So the check here is
 * "signed by FusionAuth, for THIS resource" — not the web Application's client id
 * (lib/session.ts) and not a service Entity audience (lib/mcp-auth.ts).
 *
 * This is the orchestrator's front door, not a backend service: the token it accepts is
 * the customer's own, and it becomes the `subject_token` every hop exchanges. An
 * already-exchanged token (one carrying `act`) is refused — the front door takes
 * customers, not actors.
 */

export function connectorResourceUrl(): string {
  const explicit = process.env.CONNECTOR_RESOURCE_URL;
  if (explicit) return explicit;
  const base = (process.env.APP_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
  return `${base}/mcp`;
}

/** Scopes advertised in the protected-resource metadata; enable these on each CIMD Domain. */
export const CONNECTOR_SCOPES = ["openid", "offline_access", "email", "profile"];

function wellKnownUrl(): string {
  const url = process.env.FUSIONAUTH_URL;
  if (!url) throw new Error("Missing FUSIONAUTH_URL.");
  const tenant = process.env.FUSIONAUTH_TENANT_ID;
  return `${url.replace(/\/$/, "")}/.well-known/openid-configuration${tenant ? `/${tenant}` : ""}`;
}

interface Discovery {
  issuer: string;
  jwks_uri: string;
}

// Module-local caches, like lib/mcp-auth.ts — independent of the session reader.
let discovery: Promise<Discovery> | null = null;
function getDiscovery(): Promise<Discovery> {
  if (!discovery) {
    discovery = (async () => {
      const res = await fetch(wellKnownUrl());
      if (!res.ok) {
        discovery = null;
        throw new Error(`OIDC discovery failed (${res.status}).`);
      }
      const doc = (await res.json()) as Discovery;
      return { issuer: doc.issuer, jwks_uri: doc.jwks_uri };
    })();
  }
  return discovery;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
async function getJwks() {
  if (!jwks) jwks = createRemoteJWKSet(new URL((await getDiscovery()).jwks_uri));
  return jwks;
}

export async function verifyConnectorToken(
  _req: Request,
  bearerToken?: string
): Promise<AuthInfo | undefined> {
  if (!bearerToken) return undefined;
  let claims: Record<string, unknown>;
  try {
    const [keys, { issuer }] = await Promise.all([getJwks(), getDiscovery()]);
    const { payload } = await jwtVerify(bearerToken, keys, {
      issuer,
      audience: connectorResourceUrl(),
    });
    claims = payload as Record<string, unknown>;
  } catch (err) {
    console.warn(`[mcp connector] token rejected: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
  if (claims.act) {
    console.warn("[mcp connector] token rejected: carries act (exchanged token)");
    return undefined;
  }
  const sub = typeof claims.sub === "string" ? claims.sub : "";
  if (!sub) return undefined;

  const aud = Array.isArray(claims.aud)
    ? claims.aud.filter((a): a is string => typeof a === "string")
    : typeof claims.aud === "string"
      ? [claims.aud]
      : [];
  // The CIMD client's own id is the audience that isn't us (e.g. https://chatgpt.com/…).
  const clientId =
    (typeof claims.client_id === "string" && claims.client_id) ||
    aud.find((a) => a !== connectorResourceUrl()) ||
    "unknown-client";
  const scope = typeof claims.scope === "string" ? claims.scope.split(" ").filter(Boolean) : [];

  return {
    token: bearerToken,
    clientId,
    scopes: scope,
    expiresAt: typeof claims.exp === "number" ? claims.exp : undefined,
    extra: {
      sub,
      email: typeof claims.email === "string" ? claims.email : undefined,
      name: typeof claims.name === "string" ? claims.name : undefined,
      sid: typeof claims.sid === "string" ? claims.sid : undefined,
      jti: typeof claims.jti === "string" ? claims.jti : undefined,
    },
  };
}
