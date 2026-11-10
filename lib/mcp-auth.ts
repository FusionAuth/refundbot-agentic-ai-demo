import { createRemoteJWKSet, jwtVerify } from "jose";
import type { AuthInfo } from "@modelcontextprotocol/server";

import { rolesFromClaims, scopesFromClaims } from "@/lib/roles";
import { allServiceAudiences } from "@/lib/refund-services";
import {
  cachedExchangeMode,
  verifySimulatedToken,
} from "@/lib/simulated-exchange";

/**
 * The MCP resource server's OWN, independent bearer-token verifier.
 *
 * It deliberately does NOT import verifyAccessToken / getSession from lib/session.ts
 * or lib/fusionauth.ts — it stands up its own OIDC discovery + JWKS + jwtVerify
 * here, so the check the MCP server performs is genuinely independent of anything
 * the orchestrator decided, not the same code called twice.
 *
 * mcp-handler's `withMcpAuth` calls `verifyMcpToken(req, bearerToken)`; returning
 * undefined makes it answer 401 with a `WWW-Authenticate` header pointing at the
 * RFC 9728 metadata (see app/.well-known/oauth-protected-resource).
 */

function baseUrl(): string {
  const url = process.env.FUSIONAUTH_URL;
  if (!url) throw new Error("Missing FUSIONAUTH_URL.");
  return url.replace(/\/$/, "");
}

function tenantId(): string | undefined {
  return process.env.FUSIONAUTH_TENANT_ID || undefined;
}

/** Audience the MCP server accepts — the main InFusion Agent Application's client id. */
function expectedAudience(): string {
  const clientId = process.env.FUSIONAUTH_CLIENT_ID;
  if (!clientId) throw new Error("Missing FUSIONAUTH_CLIENT_ID.");
  return clientId;
}

function wellKnownUrl(): string {
  const segment = tenantId() ? `/${tenantId()}` : "";
  return `${baseUrl()}/.well-known/openid-configuration${segment}`;
}

interface OidcDiscovery {
  issuer: string;
  jwks_uri: string;
}

// Separate, module-local caches — intentionally NOT the ones in lib/fusionauth.ts.
let mcpDiscovery: Promise<OidcDiscovery> | null = null;
function getMcpDiscovery(): Promise<OidcDiscovery> {
  if (!mcpDiscovery) {
    mcpDiscovery = (async () => {
      const res = await fetch(wellKnownUrl());
      if (!res.ok) {
        mcpDiscovery = null;
        throw new Error(`OIDC discovery failed (${res.status}).`);
      }
      const doc = (await res.json()) as OidcDiscovery;
      return { issuer: doc.issuer, jwks_uri: doc.jwks_uri };
    })();
  }
  return mcpDiscovery;
}

let mcpJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
async function getMcpJwks() {
  if (!mcpJwks) {
    const { jwks_uri } = await getMcpDiscovery();
    mcpJwks = createRemoteJWKSet(new URL(jwks_uri));
  }
  return mcpJwks;
}

/**
 * Verifies a bearer access token against FusionAuth's JWKS, checking signature,
 * issuer, and audience. Returns the MCP `AuthInfo` (token + client + scopes) on
 * success, or undefined for any missing/expired/wrong-audience/under-verified
 * token so withMcpAuth answers 401.
 */
export async function verifyMcpToken(
  _req: Request,
  bearerToken?: string
): Promise<AuthInfo | undefined> {
  if (!bearerToken) return undefined;

  // Two kinds of bearer can reach this server, verified by the same JWKS path:
  //   - the signed-in user's own access token (aud = the Application) — accepted here
  //     only so the refund tools can refuse it with a precise `not_exchanged` reason; and
  //   - an RFC 8693 EXCHANGED token (aud = one RefundBot service Entity, `act` = the
  //     orchestrator) — the only thing the four refund tools serve.
  // Which audience a tool demands is the tool's own check (lib/mcp-server.ts); here we
  // only establish that FusionAuth signed it for one of the audiences we serve.
  let claims: Record<string, unknown> | undefined;
  let simulated = false;
  try {
    const [keys, { issuer }] = await Promise.all([
      getMcpJwks(),
      getMcpDiscovery(),
    ]);
    const { payload } = await jwtVerify(bearerToken, keys, {
      issuer,
      audience: [expectedAudience(), ...allServiceAudiences()],
    });
    claims = payload as Record<string, unknown>;
  } catch {
    claims = undefined;
  }

  // The portability fallback: a simulated exchange chain's HS256 token, accepted ONLY
  // while the app is actually in simulated mode. On a live instance this branch is dead.
  if (!claims && cachedExchangeMode() === "simulated") {
    const sim = await verifySimulatedToken(bearerToken, allServiceAudiences());
    if (sim) {
      claims = sim as Record<string, unknown>;
      simulated = true;
    }
  }
  if (!claims) return undefined;

  const aud = Array.isArray(claims.aud)
    ? claims.aud.filter((a): a is string => typeof a === "string")
    : typeof claims.aud === "string"
      ? [claims.aud]
      : [];
  const exchanged = !aud.includes(safeAudience());
  const act =
    claims.act && typeof claims.act === "object"
      ? (claims.act as Record<string, unknown>)
      : undefined;

  const scopes = scopesFromClaims(claims);
  const clientId = aud[0] || safeAudience();

  return {
    token: bearerToken,
    clientId,
    scopes,
    expiresAt: typeof claims.exp === "number" ? claims.exp : undefined,
    extra: {
      sub: typeof claims.sub === "string" ? claims.sub : undefined,
      email: typeof claims.email === "string" ? claims.email : undefined,
      name: typeof claims.name === "string" ? claims.name : undefined,
      // Roles from the verified token, informational. (An exchanged token carries
      // none — FusionAuth doesn't copy `roles`.)
      roles: rolesFromClaims(claims),
      // Token-exchange facts, for the refund tools' own audience + actor checks.
      exchanged,
      simulated,
      aud,
      actSub: typeof act?.sub === "string" ? act.sub : undefined,
      sid: typeof claims.sid === "string" ? claims.sid : undefined,
      jti: typeof claims.jti === "string" ? claims.jti : undefined,
      approvedBy:
        typeof claims.approved_by === "string" ? claims.approved_by : undefined,
    },
  };
}

function safeAudience(): string {
  try {
    return expectedAudience();
  } catch {
    return "";
  }
}
