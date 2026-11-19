/**
 * AgentCore Gateway REQUEST interceptor: order ownership via Permify, before a
 * `get_order_history` tool call reaches its target.
 *
 * Mirrors `checkOrderOwnership` in lib/fga.ts, but is deliberately self-contained — it
 * imports nothing from the Next.js app. Keep these in step with the app:
 *   - the Permify request shape      -> `check()` in lib/fga.ts
 *   - the entity / permission names  -> `ENTITY`, `PERMISSION` in lib/fga.ts
 *   - the order entity id forms      -> `orderEntityId()` in lib/refund-data.ts
 *
 * Fails closed: if the ownership check can't be completed for a call it should gate
 * (no readable subject, Permify unreachable, bad response), the call is denied.
 *
 * Never logs the token, its claims, or the user id.
 */

// ---------------------------------------------------------------------------
// Event shapes (interceptorInputVersion 1.0, MCP target)
// ---------------------------------------------------------------------------

interface McpBody {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { name?: unknown; arguments?: unknown };
  [key: string]: unknown;
}

interface GatewayRequest {
  path?: string;
  httpMethod?: string;
  headers?: Record<string, string>;
  body?: McpBody | string;
}

interface InterceptorEvent {
  interceptorInputVersion?: string;
  mcp?: { gatewayRequest?: GatewayRequest };
}

interface PassThrough {
  interceptorOutputVersion: "1.0";
  mcp: { transformedGatewayRequest: { body: McpBody | string } };
}

interface Denied {
  interceptorOutputVersion: "1.0";
  mcp: {
    transformedGatewayResponse: {
      statusCode: 403;
      body: {
        jsonrpc: "2.0";
        id: string | number | null;
        error: { code: number; message: string };
      };
    };
  };
}

type InterceptorOutput = PassThrough | Denied;

// ---------------------------------------------------------------------------
// Config — same variable names the app uses (lib/fga.ts `permifyConfig`)
// ---------------------------------------------------------------------------

const TOOL_SUFFIX = "get_order_history";
const USER_ENTITY = "user";
const ORDER_ENTITY = "order";
const REQUEST_REFUND = "request_refund";

/** JSON-RPC server-error range (-32000..-32099); used for "forbidden". */
const FORBIDDEN_CODE = -32003;

/** Order ids are `ORD-1042`-style. Anything else is not safe to splice into an entity id. */
const SAFE_ORDER_ID = /^[A-Za-z0-9_-]+$/;

function config() {
  const baseUrl = process.env.PERMIFY_URL?.trim().replace(/\/$/, "");
  if (!baseUrl) throw new Error("PERMIFY_URL is not set");
  return {
    baseUrl,
    tenant: process.env.PERMIFY_TENANT?.trim() || "t1",
    token: process.env.PERMIFY_TOKEN?.trim() || "",
    timeoutMs: Number(process.env.PERMIFY_TIMEOUT_MS) || 2500,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The two entity ids `orderEntityId()` (lib/refund-data.ts) can produce for an order: the
 * bare upper-cased id (orders on a shared account) and `<ID>.<customerId>` (orders on a
 * per-customer account). The Lambda doesn't know which kind an order is, so it checks both.
 */
function candidateOrderEntityIds(customerId: string, orderId: string): string[] {
  const wanted = orderId.trim().toUpperCase();
  return [wanted, `${wanted}.${customerId}`];
}

function header(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === wanted) return v;
  }
  return undefined;
}

/**
 * The `sub` claim from the Authorization header's JWT. Decodes the payload only — the
 * gateway has already verified the token. Returns undefined if it can't be read.
 */
function subjectFromAuthorization(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const token = value.replace(/^Bearer\s+/i, "").trim();
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      sub?: unknown;
    };
    return typeof claims.sub === "string" && claims.sub ? claims.sub : undefined;
  } catch {
    return undefined;
  }
}

function parseBody(body: GatewayRequest["body"]): McpBody | undefined {
  if (body && typeof body === "object") return body;
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as McpBody) : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** `order:<entityId>#request_refund` for the customer — the same call `check()` makes in lib/fga.ts. */
async function permifyAllows(customerId: string, orderEntityId: string): Promise<boolean> {
  const cfg = config();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(`${cfg.baseUrl}/v1/tenants/${cfg.tenant}/permissions/check`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
      },
      body: JSON.stringify({
        metadata: { snap_token: "", schema_version: "", depth: 20 },
        entity: { type: ORDER_ENTITY, id: orderEntityId },
        permission: REQUEST_REFUND,
        subject: { type: USER_ENTITY, id: customerId },
        context: { tuples: [], attributes: [], data: {} },
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Permify permissions/check -> ${res.status}`);
    const json = (await res.json()) as { can?: string };
    return (json.can ?? "") === "CHECK_RESULT_ALLOWED";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Allow if EITHER candidate entity passes. The two checks run in parallel. Any error from
 * either one rejects, so the caller fails closed.
 */
async function ownsOrder(customerId: string, orderId: string): Promise<boolean> {
  const results = await Promise.all(
    candidateOrderEntityIds(customerId, orderId).map((id) => permifyAllows(customerId, id))
  );
  return results.some(Boolean);
}

function pass(body: McpBody | string): PassThrough {
  return {
    interceptorOutputVersion: "1.0",
    mcp: { transformedGatewayRequest: { body } },
  };
}

function deny(id: McpBody["id"], message: string): Denied {
  return {
    interceptorOutputVersion: "1.0",
    mcp: {
      transformedGatewayResponse: {
        statusCode: 403,
        body: {
          jsonrpc: "2.0",
          id: id ?? null,
          error: { code: FORBIDDEN_CODE, message },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler = async (event: InterceptorEvent): Promise<InterceptorOutput> => {
  const request = event.mcp?.gatewayRequest;
  const rawBody = request?.body;
  const body = parseBody(rawBody);

  // Not something we can gate: hand the request back untouched.
  if (!request || !body || rawBody === undefined) {
    return pass(rawBody ?? {});
  }
  if (body.method !== "tools/call") return pass(rawBody);

  const toolName = body.params?.name;
  if (typeof toolName !== "string" || !toolName.endsWith(TOOL_SUFFIX)) return pass(rawBody);

  const args = body.params?.arguments;
  const orderId =
    args && typeof args === "object" ? (args as Record<string, unknown>).orderId : undefined;
  if (typeof orderId !== "string" || orderId.trim() === "") return pass(rawBody);

  // From here the call is gated: anything that stops us checking means deny.
  const sub = subjectFromAuthorization(header(request.headers, "authorization"));
  if (!sub) {
    console.log(`[interceptor] ${toolName} denied: no readable subject on the request`);
    return deny(body.id, "Access denied: the caller could not be identified.");
  }

  if (!SAFE_ORDER_ID.test(orderId.trim())) {
    console.log(`[interceptor] ${toolName} denied: malformed orderId`);
    return deny(body.id, "Access denied: the order id is not valid.");
  }

  try {
    if (await ownsOrder(sub, orderId)) {
      console.log(`[interceptor] ${toolName} allowed`);
      return pass(rawBody);
    }
    console.log(`[interceptor] ${toolName} denied by Permify`);
    return deny(body.id, "Access denied: you do not have access to that order.");
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[interceptor] ${toolName} denied (fail closed): ${name}: ${message}`);
    return deny(body.id, "Access denied: the order ownership check could not be completed.");
  }
};
