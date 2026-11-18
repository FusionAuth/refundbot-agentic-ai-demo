import { NextRequest, NextResponse } from "next/server";
import { getSession, consumeStepUpGrantDetail } from "@/lib/session";
import { agentMode } from "@/lib/agent";
import { planRefundTurn } from "@/lib/refund-agent";
import { startRefund, maybeExecuteBankingHop } from "@/lib/refund-pipeline";
import { resolveExchangeMode } from "@/lib/token-exchange";
import {
  allRefunds,
  findRefund,
  pushTrace,
  recordCustomerDecision,
  toView,
} from "@/lib/approvals";
import { searchKnowledgeBase } from "@/lib/knowledge-base";
import { replyFor } from "@/lib/refund-replies";
import {
  refundConfirmAction as confirmAction,
  type RefundTurnResponse,
} from "@/lib/refund-types";

export const dynamic = "force-dynamic";

/**
 * /api/refund — the customer's side of RefundBot.
 *
 *   POST { message }                      one chat turn: plan → (policy answer | hops 1–3 + hop-4 probe)
 *   POST { action: "confirm", requestId } the customer's out-of-band confirmation (consumes the
 *                                         step-up grant written by /api/two-factor/*)
 *   POST { action: "decline", requestId } the customer says no; the Grant is never created
 *   GET  ?requestId=…                     poll one of YOUR requests (the console may approve it)
 *
 * The planner chooses the response; it never decides authorization. Whether the
 * customer may touch the order at all is FusionAuth FGA's call (before any exchange);
 * the amount and whether money moves are the services', each reached only through a
 * token FusionAuth agreed to exchange.
 */

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const id = request.nextUrl.searchParams.get("requestId");
  if (id) {
    const record = findRefund(id);
    if (!record || record.customerId !== session.userId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const view = toView(record);
    return NextResponse.json({ request: view, reply: replyFor(view) });
  }
  return NextResponse.json({
    requests: allRefunds()
      .filter((r) => r.customerId === session.userId)
      .map(toView),
  });
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  let body: { message?: unknown; action?: unknown; requestId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  // --- The customer's decision on a pending refund ------------------------------
  if (body.action === "confirm" || body.action === "decline") {
    const record = typeof body.requestId === "string" ? findRefund(body.requestId) : undefined;
    if (!record || record.customerId !== session.userId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (record.decision !== "awaiting_approvals" || record.customer.state !== "pending") {
      const view = toView(record);
      return NextResponse.json({ reply: replyFor(view), request: view, planner: { mode: agentMode() } });
    }

    if (body.action === "decline") {
      recordCustomerDecision(record, false);
      pushTrace(record, {
        type: "note",
        layer: "approval",
        status: "denied",
        label: "customer declined",
        detail: "The customer said no. The banking-api Grant is never created; hop 4 is never attempted.",
        at: new Date().toISOString(),
      });
    } else {
      // The out-of-band confirmation: a fresh, single-use step-up grant for THIS request.
      const grant = await consumeStepUpGrantDetail(confirmAction(record.id));
      if (!grant.ok) {
        return NextResponse.json(
          { error: "Confirmation expired or missing — confirm again." },
          { status: 403 }
        );
      }
      const via =
        grant.via === "challenge"
          ? "two-factor challenge completed"
          : grant.via === "enrolled"
            ? "a code emailed to the account address (no MFA method was enrolled; email MFA is now enabled)"
            : "explicit confirmation (FusionAuth required no MFA challenge for this step-up)";
      recordCustomerDecision(record, true, via);
      pushTrace(record, {
        type: "note",
        layer: "approval",
        status: "allowed",
        label: "customer confirmed out-of-band",
        detail: `Via ${via}.`,
        at: new Date().toISOString(),
      });
      // If this was the last approval needed, hop 4 runs now: Grant → exchange → call → revoke.
      await maybeExecuteBankingHop(record);
    }
    const view = toView(record);
    const response: RefundTurnResponse = {
      reply: replyFor(view),
      request: view,
      planner: { mode: agentMode() },
    };
    return NextResponse.json(response);
  }

  // --- A chat turn ---------------------------------------------------------------
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return NextResponse.json({ error: "Missing message" }, { status: 400 });

  const plan = await planRefundTurn(message);
  const planner = { mode: plan.degraded ? ("scripted" as const) : agentMode(), degraded: plan.degraded };

  if (plan.kind === "reply") {
    return NextResponse.json({ reply: plan.text, planner } satisfies RefundTurnResponse);
  }

  if (plan.kind === "policy") {
    // Customer-visible articles only. The internal escalation notes are a different
    // audience and only ever surface on the role-gated support console.
    const hits = searchKnowledgeBase(plan.query, "customer", 2);
    const reply = hits.length
      ? hits.map((h) => `${h.article.title}: ${h.article.body}`).join("\n\n")
      : "I don't have an answer for that one — try asking about our refund window, timing, or why some refunds get reviewed.";
    return NextResponse.json({ reply, planner } satisfies RefundTurnResponse);
  }

  // A refund. The correlator is the customer's login `sid`, which FusionAuth carries
  // onto every exchanged token for free.
  const { mode } = await resolveExchangeMode();
  const record = await startRefund({
    customerId: session.userId,
    customerLabel: session.email ?? session.name ?? session.userId,
    accessToken: session.accessToken,
    sid: session.sid ?? `jti:${session.tokenJti ?? session.userId}`,
    sidSource: session.sid ? "sid" : "jti-fallback",
    orderId: plan.orderId,
    mode,
  });
  record.trace.unshift({
    type: "note",
    layer: "planner",
    status: "info",
    label: `planner (${planner.mode}): refund ${plan.orderId}`,
    detail:
      (plan.degraded ? `Live planner failed (${plan.degraded}); scripted fallback. ` : "") +
      "The planner only picked the order id. Whether it exists, what it's worth, and " +
      "whether money moves are the services' calls.",
    at: new Date().toISOString(),
  });
  const view = toView(record);
  const response: RefundTurnResponse = {
    reply: replyFor(view),
    request: view,
    planner,
    awaitingCustomer: view.decision === "awaiting_approvals" && view.customer.state === "pending",
  };
  return NextResponse.json(response);
}
