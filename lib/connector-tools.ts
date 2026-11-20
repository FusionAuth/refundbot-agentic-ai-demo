import { z } from "zod";
import type { McpServer, AuthInfo } from "@modelcontextprotocol/server";
import { appBaseUrl } from "@/lib/agent";
import { ordersForCustomer } from "@/lib/refund-data";
import { searchKnowledgeBase } from "@/lib/knowledge-base";
import { syncCustomerFga } from "@/lib/fga";
import { startRefund } from "@/lib/refund-pipeline";
import { resolveExchangeMode } from "@/lib/token-exchange";
import { allRefunds, findRefund, toView } from "@/lib/approvals";
import { replyFor } from "@/lib/refund-replies";
import type { RefundRequestView } from "@/lib/refund-types";

/**
 * The customer-facing MCP tools ChatGPT / claude.ai call (app/mcp). This is the same
 * orchestrator the web chat drives (app/api/refund), with the chat app in place of the
 * browser: `request_refund` runs `startRefund` unchanged — FGA ownership first, then
 * hops 1–3, each exchanging the customer's ORIGINAL token (the one the chat app sent).
 *
 * There is deliberately no "confirm" tool. The customer's out-of-band step-up is
 * mandatory, and an agent can call any tool it's given — so the tools hand back a link to
 * /refund/confirm/<id>, where the customer confirms through FusionAuth in their browser.
 */

interface Customer {
  sub: string;
  label: string;
  token: string;
  sid?: string;
  jti?: string;
}

function customerOf(authInfo: AuthInfo | undefined): Customer | undefined {
  const extra = (authInfo?.extra ?? {}) as Record<string, unknown>;
  if (!authInfo || typeof extra.sub !== "string") return undefined;
  return {
    sub: extra.sub,
    label: (extra.email as string) ?? (extra.name as string) ?? extra.sub,
    token: authInfo.token,
    sid: extra.sid as string | undefined,
    jti: extra.jti as string | undefined,
  };
}

function result(payload: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

const unauthenticated = () =>
  result({ ok: false, error: "unauthenticated", message: "No verified customer on this request." }, true);

export function confirmUrl(requestId: string): string {
  return `${appBaseUrl()}/refund/confirm/${requestId}`;
}

function firstRefusal(view: RefundRequestView): string | null {
  for (const e of view.trace) {
    if (e.type === "hop" && e.exchange === "denied" && e.grantKind !== "probe") {
      return `hop ${e.hop} (${e.service}): ${e.reason ?? "refused"}`;
    }
    if (e.type === "hop" && e.mcp && (e.mcp.status === "denied" || e.mcp.status === "error")) {
      return `hop ${e.hop} (${e.service}) tool call: ${e.mcp.detail}`;
    }
  }
  return null;
}

export function summarize(view: RefundRequestView) {
  const awaitingCustomer =
    view.decision === "awaiting_approvals" && view.customer.state === "pending";
  return {
    requestId: view.id,
    orderId: view.orderId,
    item: view.orderSummary ?? null,
    amountCents: view.amountCents ?? null,
    decision: view.decision,
    customerConfirmation: view.customer.state,
    employeeReview: view.employee.state,
    confirmationId: view.confirmationId ?? null,
    message: replyFor(view),
    // When the chain stopped on a refusal, FusionAuth's own words (never paraphrased).
    ...(view.decision === "failed" || view.decision === "stopped"
      ? { failure: firstRefusal(view) }
      : {}),
    ...(awaitingCustomer
      ? {
          confirmUrl: confirmUrl(view.id),
          nextStep:
            "The customer must open confirmUrl in their browser and confirm there. " +
            "Share the link with them; this refund cannot be confirmed from chat.",
        }
      : {}),
  };
}

export function registerConnectorTools(server: McpServer): void {
  server.registerTool(
    "list_my_orders",
    {
      title: "List my orders",
      description: "The signed-in customer's recent orders, with refund status.",
      annotations: { readOnlyHint: true },
    },
    async (ctx) => {
      const me = customerOf(ctx.http?.authInfo);
      if (!me) return unauthenticated();
      const orders = ordersForCustomer(me.sub).map((o) => ({
        orderId: o.id,
        item: o.item,
        totalCents: o.totalCents,
        placedDaysAgo: o.placedDaysAgo,
        refunded: o.refunded,
        refundConfirmationId: o.refundConfirmationId ?? null,
      }));
      return result({ ok: true, orders });
    }
  );

  server.registerTool(
    "request_refund",
    {
      title: "Request a refund",
      description:
        "Start a refund for one order. Returns the request's status; when it needs the " +
        "customer's confirmation, it includes a confirmUrl the customer must open in their " +
        "browser. Refunds are never confirmed from chat.",
      inputSchema: z.object({
        orderId: z.string().describe("The order to refund, e.g. ORD-1042."),
      }),
    },
    async ({ orderId }, ctx) => {
      const me = customerOf(ctx.http?.authInfo);
      if (!me) return unauthenticated();
      // The web chat writes the customer's Permify relations on page load; there's no
      // page here, so do it before the ownership check.
      await syncCustomerFga(me.sub);
      const { mode } = await resolveExchangeMode();
      const record = await startRefund({
        customerId: me.sub,
        customerLabel: me.label,
        accessToken: me.token,
        sid: me.sid ?? `jti:${me.jti ?? me.sub}`,
        sidSource: me.sid ? "sid" : "jti-fallback",
        orderId,
        mode,
      });
      record.trace.unshift({
        type: "note",
        layer: "planner",
        status: "info",
        label: `MCP connector (${ctx.http?.authInfo?.clientId ?? "unknown client"}): refund ${orderId}`,
        detail:
          "Requested through the customer-facing MCP connector. The chat app only picked " +
          "the order id; it authenticated as the customer via its CIMD registration.",
        at: new Date().toISOString(),
      });
      return result({ ok: true, ...summarize(toView(record)) });
    }
  );

  server.registerTool(
    "get_refund_status",
    {
      title: "Get refund status",
      description:
        "Status of one of the customer's refund requests, or all of them when requestId is omitted.",
      inputSchema: z.object({
        requestId: z.string().optional().describe("A refund request id, e.g. rf_1a2b3c4d."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ requestId }, ctx) => {
      const me = customerOf(ctx.http?.authInfo);
      if (!me) return unauthenticated();
      if (requestId) {
        const record = findRefund(requestId);
        if (!record || record.customerId !== me.sub) {
          return result({ ok: false, error: "not_found", message: `No refund ${requestId}.` }, true);
        }
        return result({ ok: true, ...summarize(toView(record)) });
      }
      const requests = allRefunds()
        .filter((r) => r.customerId === me.sub)
        .map((r) => summarize(toView(r)));
      return result({ ok: true, requests });
    }
  );

  server.registerTool(
    "refund_policy",
    {
      title: "Refund policy",
      description: "Answer a question about the refund policy (window, timing, reviews).",
      inputSchema: z.object({ question: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async ({ question }, ctx) => {
      if (!customerOf(ctx.http?.authInfo)) return unauthenticated();
      const hits = searchKnowledgeBase(question, "customer", 3);
      return result({
        ok: true,
        articles: hits.map((h) => ({ title: h.article.title, body: h.article.body })),
      });
    }
  );
}
