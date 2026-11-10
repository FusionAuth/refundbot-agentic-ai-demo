import { z } from "zod";
import type { McpServer, AuthInfo } from "@modelcontextprotocol/server";
import { audienceFor, orchestratorId } from "@/lib/refund-services";
import {
  findOrder,
  ordersForCustomer,
  customerHistory,
  selfServiceFloorCents,
  budgetRemainingCents,
  debitBudget,
  markRefunded,
} from "@/lib/refund-data";
import {
  findRefundInSession,
  approvalsSatisfied,
  approvalsRefused,
} from "@/lib/approvals";
import type { RefundService } from "@/lib/refund-types";

/**
 * The MCP tool registry + handlers for RefundBot's four backend services. Registered
 * onto the McpServer that createMcpHandler builds (see app/api/mcp/route.ts). Every
 * handler runs its OWN `exchangeGate` off `ctx.http?.authInfo` — the AuthInfo produced
 * by the independent verifier in lib/mcp-auth.ts.
 *
 * What these services deliberately do NOT do is decide whether the customer may ask
 * about an order at all: order-history-service answers for whatever order id it is
 * handed. That question — `order#request_refund` — is FusionAuth FGA's, asked by the
 * orchestrator before hop 1 (lib/fga.ts). The services stay dumb on purpose, so the
 * relationship check is visibly the thing closing the gap.
 *
 * Handlers return a JSON string in a single text block: `{ ok: true, data }` on
 * success, or `{ ok: false, error, code, message }` (with isError).
 */

interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  // The SDK's CallToolResult carries an index signature; mirror it so our
  // handlers' return type is assignable.
  [key: string]: unknown;
}

function ok(data: Record<string, unknown>): ToolResult {
  const payload = { ok: true, data };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function errorResult(payload: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

// ===========================================================================
// RefundBot — the four pipeline services, each gated on an EXCHANGED token
// ===========================================================================

/**
 * The refund tools' own gate. The question is not "may this user's token use this
 * tool", but "did FusionAuth
 * mint this token, by token exchange, for THIS service, with the orchestrator as actor".
 *
 *  - `exchanged`  — the customer's own access token (aud = the Application) is refused.
 *                   The orchestrator must trade it; it may not forward it.
 *  - audience     — a token minted for order-history can't be replayed at banking-api.
 *  - `act.sub`    — the orchestrator Entity, and nobody else, is the actor.
 *  - `sub`        — still the customer, and the only identity the service acts for.
 *
 * Signature, issuer, and expiry were already verified by lib/mcp-auth.ts.
 */
interface ExchangedCaller {
  sub: string;
  sid?: string;
  jti?: string;
  approvedBy?: string;
  simulated: boolean;
}

function exchangeGate(
  service: RefundService,
  authInfo: AuthInfo | undefined
): { caller?: ExchangedCaller; denied?: ToolResult } {
  const extra = (authInfo?.extra ?? {}) as Record<string, unknown>;
  const deny = (code: string, message: string) => ({
    denied: errorResult({ ok: false, error: "exchange_gate", code, message }),
  });
  if (!extra.exchanged) {
    return deny(
      "not_exchanged",
      "This service only accepts a token issued by token exchange. The customer's own " +
        "access token was presented directly."
    );
  }
  const aud = (extra.aud as string[] | undefined) ?? [];
  const expected = audienceFor(service);
  if (!aud.includes(expected)) {
    return deny(
      "wrong_audience",
      `Token audience [${aud.join(", ")}] doesn't name this service (${expected}).`
    );
  }
  if (extra.actSub !== orchestratorId()) {
    return deny(
      "wrong_actor",
      `act.sub is ${String(extra.actSub ?? "absent")}; only the RefundBot orchestrator ` +
        `(${orchestratorId()}) may act here.`
    );
  }
  const sub = typeof extra.sub === "string" ? extra.sub : "";
  if (!sub) return deny("no_subject", "The exchanged token has no sub.");
  return {
    caller: {
      sub,
      sid: extra.sid as string | undefined,
      jti: extra.jti as string | undefined,
      approvedBy: extra.approvedBy as string | undefined,
      simulated: extra.simulated === true,
    },
  };
}

/** Registers the four RefundBot pipeline tools. */
export function registerRefundTools(server: McpServer): void {
  server.registerTool(
    "get_order_history",
    {
      title: "Get order history",
      description:
        "Hop 1. Look up the order asked about (and the customer's own order count). It " +
        "answers for any order id — ownership is checked by FGA before this hop runs.",
      inputSchema: z.object({
        orderId: z.string().optional().describe("The order to look up, e.g. ORD-1042."),
      }),
    },
    async ({ orderId }, ctx) => {
      const { caller, denied } = exchangeGate("order-history", ctx.http?.authInfo);
      if (denied || !caller) return denied!;
      const orders = ordersForCustomer(caller.sub);
      const order = orderId ? findOrder(caller.sub, orderId) : undefined;
      return ok({
        customerId: caller.sub,
        orderId: orderId ?? null,
        found: orderId ? !!order : orders.length > 0,
        order: order ?? null,
        orderCount: orders.length,
      });
    }
  );

  server.registerTool(
    "score_customer_value",
    {
      title: "Score customer value",
      description:
        "Hop 2. The customer's own order history — lifetime spend, order count, prior " +
        "refunds. Context only: whether a refund skips employee review is decided by the " +
        "account's trust tier in FusionAuth FGA, not by a score.",
    },
    async (ctx) => {
      const { caller, denied } = exchangeGate("customer-scoring", ctx.http?.authInfo);
      if (denied || !caller) return denied!;
      return ok({ ...customerHistory(caller.sub) });
    }
  );

  server.registerTool(
    "check_refund_budget",
    {
      title: "Check refund budget",
      description:
        "Hop 3. Can the refund budget cover this order, and is it above the standard " +
        "self-service floor? The amount comes from the order record, never from the caller.",
      inputSchema: z.object({
        orderId: z.string().describe("The order being refunded."),
      }),
    },
    async ({ orderId }, ctx) => {
      const { caller, denied } = exchangeGate("refund-budget", ctx.http?.authInfo);
      if (denied || !caller) return denied!;
      const order = findOrder(caller.sub, orderId);
      if (!order) {
        return errorResult({ ok: false, error: "unknown_order", message: `No order ${orderId}.` });
      }
      const floorCents = selfServiceFloorCents();
      const remaining = budgetRemainingCents();
      return ok({
        orderId: order.id,
        amountCents: order.totalCents,
        alreadyRefunded: order.refunded,
        floorCents,
        aboveFloor: order.totalCents > floorCents,
        budgetRemainingCents: remaining,
        withinBudget: order.totalCents <= remaining,
      });
    }
  );

  server.registerTool(
    "process_refund",
    {
      title: "Process refund",
      description:
        "Hop 4 — the irreversible one. Moves money. Requires an exchanged token for the " +
        "banking-api audience, which FusionAuth only issues while the on-demand Grant " +
        "exists, AND an approval record showing every required approval.",
      inputSchema: z.object({
        requestId: z.string().describe("The refund request id from the approval queue."),
      }),
    },
    async ({ requestId }, ctx) => {
      const { caller, denied } = exchangeGate("banking-api", ctx.http?.authInfo);
      if (denied || !caller) return denied!;
      const refuse = (code: string, message: string) =>
        errorResult({ ok: false, error: "banking_refused", code, message });

      // The service's OWN check of the approval record, looked up by the token's sid —
      // the correlator FusionAuth carried over from the customer's login.
      const record = caller.sid ? findRefundInSession(caller.sid, requestId) : undefined;
      if (!record) {
        return refuse(
          "no_record",
          `No refund ${requestId} in the session named by this token's sid.`
        );
      }
      if (record.customerId !== caller.sub) {
        return refuse("subject_mismatch", "The token's sub isn't this refund's customer.");
      }
      if (record.executed) {
        return refuse("already_executed", "This refund already ran; tokens are single-purpose.");
      }
      if (approvalsRefused(record) || !approvalsSatisfied(record)) {
        return refuse("approvals_incomplete", "The approval record doesn't show every required approval.");
      }

      // The employee's identity is CHECKED here, not just logged. With the populate
      // lambda installed it rides on the token as `approved_by`, signed by FusionAuth,
      // and must match the record; without it, the record alone backs the decision.
      let approvedByPath: "claim" | "server-side record" | "not required" = "not required";
      if (record.needsEmployee) {
        const employeeId = record.employee.employeeId;
        if (!employeeId || employeeId === record.customerId) {
          return refuse("no_employee", "No independent employee approval on record.");
        }
        if (caller.approvedBy) {
          if (caller.approvedBy !== employeeId) {
            return refuse(
              "approved_by_mismatch",
              `approved_by claim (${caller.approvedBy}) doesn't match the approving employee on record.`
            );
          }
          approvedByPath = "claim";
        } else {
          approvedByPath = "server-side record";
        }
      }

      const order = findOrder(record.customerId, record.orderId);
      if (!order || order.refunded) {
        return refuse("order_state", "The order is missing or already refunded.");
      }
      if (!debitBudget(order.totalCents)) {
        return refuse("budget", "The refund budget can no longer cover this order.");
      }
      const confirmationId = `RF-${Date.now().toString(36).toUpperCase()}`;
      markRefunded(record.customerId, record.orderId, confirmationId);
      record.executed = true;

      return ok({
        confirmationId,
        orderId: order.id,
        amountCents: order.totalCents,
        approvedByPath,
        approvedBy: record.employee.employeeId ?? null,
        tokenJti: caller.jti ?? null,
        simulated: caller.simulated,
      });
    }
  );
}
