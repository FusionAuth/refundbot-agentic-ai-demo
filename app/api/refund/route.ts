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
import {
  formatUsd,
  refundConfirmAction as confirmAction,
  type RefundRequestView,
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
 * The planner chooses the response; it never decides authorization. Everything from
 * the order's existence to the amount to whether money moves is decided by the
 * services, each reached only through a token FusionAuth agreed to exchange.
 */

function replyFor(view: RefundRequestView): string {
  const amount = view.amountCents !== undefined ? formatUsd(view.amountCents) : "";
  const item = view.orderSummary ?? view.orderId;
  const said = (label: string) =>
    view.trace.some((e) => e.type === "note" && e.label.includes(label));
  switch (view.decision) {
    case "stopped":
      if (view.amountCents === undefined) {
        return `I couldn't find an order ${view.orderId} on your account, so there's nothing I can refund. If you think that's wrong, double-check the order number in your confirmation email.`;
      }
      if (said("already refunded")) return `${item} has already been refunded — you should see it on your statement within 3–5 business days.`;
      if (said("budget")) return `I can't process ${item} automatically right now. Please try again tomorrow or contact us by email.`;
      return `I'm not able to refund ${item}.`;
    case "failed":
      return "Something went wrong while processing that, and nothing was charged back. Please try again in a moment.";
    case "awaiting_approvals":
      if (view.customer.state === "pending") {
        return view.needsEmployee
          ? `I found ${item} for ${amount}. Refunds over ${formatUsd(view.thresholdCents ?? 0)} on your account also get a quick review by one of our specialists. First, please confirm you want this refund:`
          : `I found ${item} for ${amount}, and it's eligible for an instant refund. Please confirm you want to go ahead:`;
      }
      return `Thanks for confirming! A specialist is reviewing your ${amount} refund now — usually within a few minutes. I'll update you right here.`;
    case "executing":
      return "Everything's approved — processing your refund now.";
    case "refunded":
      return `Done! ${amount} is on its way back to your original payment method (3–5 business days). Your confirmation number is ${view.confirmationId}.`;
    case "denied":
      return `I'm sorry — our specialist reviewed the ${amount} refund for ${item} and wasn't able to approve it. Nothing was charged back. Reply here if you'd like to talk it through.`;
    case "declined":
      return "No problem — I've cancelled that refund request. Nothing was processed.";
  }
}

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
          : grant.via === "no_method"
            ? "explicit confirmation — the step-up policy asked for MFA, but this customer has no method enrolled"
            : "explicit confirmation (FusionAuth required no MFA challenge for this user)";
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
    // Customer-visible articles only: an empty scope list, whoever is signed in. The
    // internal escalation notes need tools:kb.read and surface on the support console.
    const hits = searchKnowledgeBase(plan.query, [], 2);
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
