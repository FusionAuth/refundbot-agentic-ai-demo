import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/fusionauth";
import { startRefund } from "@/lib/refund-pipeline";
import { resolveExchangeMode } from "@/lib/token-exchange";
import { toView } from "@/lib/approvals";
import { summarize } from "@/lib/connector-tools";

export const dynamic = "force-dynamic";

/**
 * POST /api/agent/refund  { orderId }
 *
 * Starts a refund for the AgentCore agent, on the same pipeline as the web chat
 * (app/api/refund) and the /mcp connector's request_refund (lib/connector-tools.ts).
 *
 * Auth: the agent sends the customer's ORIGINAL FusionAuth access token — the kind the
 * web login issues — as a Bearer token. It is verified exactly as the web app does
 * (`verifyAccessToken`) and must not carry `act`: this front door takes customers, not
 * actors. The customer's identity comes only from the token, never from the body.
 *
 * The token is NOT exchanged here. `startRefund` exchanges the original at every hop.
 * This route never confirms a refund: the customer confirms separately, in their
 * browser, via the `confirmUrl` in the response.
 */

const ORDER_ID = /^[A-Za-z0-9_-]+$/;
const MAX_ORDER_ID_LENGTH = 64;

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: Record<string, unknown>, status = 200, headers: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

function unauthorized(message: string) {
  return json({ error: message }, 401, { "WWW-Authenticate": 'Bearer realm="refundbot-agent"' });
}

export async function POST(request: NextRequest) {
  // --- Authenticate -----------------------------------------------------------------
  const match = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "");
  if (!match) return unauthorized("Missing bearer token.");
  const accessToken = match[1];

  let claims;
  try {
    claims = await verifyAccessToken(accessToken);
  } catch {
    return unauthorized("Invalid or expired token.");
  }
  if (claims.act !== undefined) {
    return unauthorized("Delegated (act) tokens are not accepted here.");
  }
  const sub = typeof claims.sub === "string" ? claims.sub : "";
  if (!sub) return unauthorized("Invalid or expired token.");

  // --- Validate input ---------------------------------------------------------------
  let body: { orderId?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Request body must be valid JSON." }, 400);
  }
  const orderId = typeof body?.orderId === "string" ? body.orderId.trim() : "";
  if (!orderId || orderId.length > MAX_ORDER_ID_LENGTH || !ORDER_ID.test(orderId)) {
    return json(
      { error: "`orderId` must be non-empty and contain only letters, digits, hyphen, underscore." },
      400
    );
  }

  // --- Start the refund (same call as the connector's request_refund) --------------
  const sid = typeof claims.sid === "string" ? claims.sid : undefined;
  const jti = typeof claims.jti === "string" ? claims.jti : undefined;
  const label =
    (typeof claims.email === "string" && claims.email) ||
    (typeof claims.name === "string" && claims.name) ||
    sub;

  try {
    const { mode } = await resolveExchangeMode();
    const record = await startRefund({
      customerId: sub,
      customerLabel: label,
      accessToken,
      sid: sid ?? `jti:${jti ?? sub}`,
      sidSource: sid ? "sid" : "jti-fallback",
      orderId,
      mode,
    });
    record.trace.unshift({
      type: "note",
      layer: "planner",
      status: "info",
      label: `AgentCore agent: refund ${orderId}`,
      detail:
        "Requested through /api/agent/refund with the customer's own access token. The " +
        "agent only supplied the order id; the customer still has to confirm in their browser.",
      at: new Date().toISOString(),
    });
    return json({ ok: true, ...summarize(toView(record)) });
  } catch (err) {
    console.log(`[agent-refund] startRefund failed: ${err instanceof Error ? err.name : "Error"}`);
    return json({ error: "Could not start the refund." }, 500);
  }
}
