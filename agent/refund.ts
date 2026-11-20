import type { Tool } from "@aws-sdk/client-bedrock-runtime";

/**
 * start_refund — a tool the agent owns, separate from the gateway tools. It starts a
 * refund by POSTing to the RefundBot app's /api/agent/refund with the customer's ORIGINAL
 * bearer token (the one on the incoming /invocations request). The app verifies that token,
 * takes the customer's identity from it, and runs the normal refund pipeline. It never
 * confirms anything: the customer confirms in their browser afterward.
 *
 * The token is only ever put in the Authorization header. It is never logged, returned, or
 * included in an error message.
 */

export const START_REFUND_TOOL_NAME = "start_refund";

const ORDER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TIMEOUT_MS = 60_000;

export const startRefundTool: Tool = {
  toolSpec: {
    name: START_REFUND_TOOL_NAME,
    description:
      "Start a refund for an order the customer owns. This only starts the request: the " +
      "customer must still confirm it themselves in their browser afterward, using the " +
      "confirmUrl in the result.",
    inputSchema: {
      json: {
        type: "object",
        properties: {
          orderId: { type: "string", description: "The order to refund, as the customer gave it." },
        },
        required: ["orderId"],
      },
    },
  },
};

export type StartRefundResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; message: string };

function baseUrl(): string | undefined {
  const raw = process.env.REFUNDBOT_BASE_URL?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

export async function startRefund(
  token: string,
  args: Record<string, unknown>
): Promise<StartRefundResult> {
  const base = baseUrl();
  if (!base) {
    console.log("[agent] start_refund unavailable: REFUNDBOT_BASE_URL is missing or not a valid URL");
    return {
      ok: false,
      message:
        "start_refund is not configured: the agent's REFUNDBOT_BASE_URL is missing or invalid, " +
        "so a refund cannot be started.",
    };
  }

  const orderId = typeof args.orderId === "string" ? args.orderId.trim() : "";
  if (!ORDER_ID.test(orderId)) {
    return {
      ok: false,
      message: "orderId is required and may only contain letters, digits, hyphen and underscore.",
    };
  }

  let res: Response;
  try {
    res = await fetch(`${base}/api/agent/refund`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ orderId }),
      // Never follow a redirect with the customer's token attached.
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    console.log(`[agent] start_refund request failed: ${timedOut ? "timeout" : "network"}`);
    return {
      ok: false,
      message: timedOut
        ? "The refund service did not respond in time."
        : "Could not reach the refund service.",
    };
  }

  let body: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    // Not JSON — handled below.
  }

  if (!res.ok) {
    const reason = typeof body?.error === "string" ? `: ${body.error.slice(0, 300)}` : "";
    console.log(`[agent] start_refund -> HTTP ${res.status}`);
    return { ok: false, message: `The refund could not be started (HTTP ${res.status})${reason}` };
  }
  if (!body) {
    return { ok: false, message: "The refund service returned an unreadable response." };
  }
  return { ok: true, data: body };
}
