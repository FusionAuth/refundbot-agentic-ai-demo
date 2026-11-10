import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { isSupportStaff } from "@/lib/roles";
import {
  allRefunds,
  findRefund,
  pushTrace,
  recordEmployeeDecision,
  toView,
} from "@/lib/approvals";
import { maybeExecuteBankingHop } from "@/lib/refund-pipeline";
import { checkApprover, lastFgaMode, syncEmployeeFga } from "@/lib/fga";
import { formatUsd } from "@/lib/refund-types";

export const dynamic = "force-dynamic";

/**
 * /api/support/approvals — the second human in the loop.
 *
 *   GET                                    the queue (staff only)
 *   POST { requestId, decision }           "approve" | "deny"
 *
 * Two independent gates:
 *   1. The Application Role (coarse): only support staff reach this route at all.
 *   2. FusionAuth FGA (per-resource): may THIS employee decide THIS refund? First
 *      `store#approve_local` on the order's store; failing that,
 *      `region#approve_escalated` on that store's region. Both carry the amount in
 *      `context.data`, compared against the entity's own `cap_cents` attribute. A denial
 *      says why (wrong store vs. over the cap) and, for the wrong store, who to escalate to.
 *
 * An employee may not approve their own refund. Approving records WHO approved (their
 * FusionAuth user id) and via which path, and if the customer has already confirmed, this
 * request runs hop 4 right here: create Grant → exchange → call banking-api → revoke
 * Grant. Denying means the Grant is never created at all.
 */

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!isSupportStaff(session.roles)) {
    return NextResponse.json({ error: "Support staff only" }, { status: 403 });
  }
  return NextResponse.json({ requests: allRefunds().map(toView) });
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!isSupportStaff(session.roles)) {
    return NextResponse.json({ error: "Support staff only" }, { status: 403 });
  }

  let body: { requestId?: unknown; decision?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const record = typeof body.requestId === "string" ? findRefund(body.requestId) : undefined;
  if (!record) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (body.decision !== "approve" && body.decision !== "deny") {
    return NextResponse.json({ error: "decision must be approve or deny" }, { status: 400 });
  }
  if (!record.needsEmployee || record.employee.state !== "pending") {
    return NextResponse.json(
      { error: "This request isn't waiting on an employee.", request: toView(record) },
      { status: 409 }
    );
  }
  if (record.decision !== "awaiting_approvals") {
    return NextResponse.json(
      { error: `This request is already ${record.decision}.`, request: toView(record) },
      { status: 409 }
    );
  }
  if (record.customerId === session.userId) {
    return NextResponse.json(
      { error: "You can't approve your own refund — the two approvals must be independent." },
      { status: 403 }
    );
  }

  const approved = body.decision === "approve";
  const name = session.name ?? session.email ?? session.userId;

  // FusionAuth FGA: the store → region cascade, with the amount in context.
  await syncEmployeeFga(session.userId, name, session.roles);
  const fga = await checkApprover({
    employeeId: session.userId,
    employeeName: name,
    storeId: record.storeId ?? "",
    amountCents: record.amountCents ?? 0,
    decision: approved ? "approve" : "deny",
  });
  record.fga.approvals.push(fga);
  record.fga.mode = lastFgaMode();
  // Breadcrumb for the token chain and the architecture diagram; details live on the
  // Permissions tab.
  pushTrace(record, {
    type: "note",
    layer: "fga",
    status: fga.allowed ? "allowed" : "denied",
    label: fga.allowed
      ? `Permify: ${fga.path} ALLOWED · ${name}${fga.path === "approve_escalated" ? " (via cascade)" : ""} →`
      : `Permify: approve_local / approve_escalated DENIED · ${name} →`,
    detail: fga.suggestion ? `${fga.reason} ${fga.suggestion}` : fga.reason,
    at: new Date().toISOString(),
  });
  if (!fga.allowed) {
    return NextResponse.json(
      {
        error: `Permify denied ${approved ? "approval" : "a decision"} on ${formatUsd(record.amountCents ?? 0)} for ${fga.store.label}: ${fga.reason}`,
        suggestion: fga.suggestion,
        fga,
        request: toView(record),
      },
      { status: 403 }
    );
  }

  const employee = { id: session.userId, name, path: fga.path };
  recordEmployeeDecision(record, approved, employee);
  pushTrace(record, {
    type: "note",
    layer: "approval",
    status: approved ? "allowed" : "denied",
    label: approved
      ? `support employee approved · ${employee.name}`
      : `support employee denied · ${employee.name}`,
    detail: approved
      ? `Approver user id ${employee.id} recorded against sid ${record.sid}, authorized by ` +
        `Permify ${fga.path === "approve_local" ? `store#approve_local (${fga.store.label})` : `region#approve_escalated (via cascade, ${fga.region.label})`}. ` +
        (record.customer.state === "approved"
          ? "The customer already confirmed, so hop 4 runs now."
          : "Still waiting on the customer's own confirmation.")
      : "The banking-api Grant will never be created for this request; hop 4 is never attempted.",
    at: new Date().toISOString(),
  });

  if (approved) await maybeExecuteBankingHop(record);
  return NextResponse.json({ request: toView(record) });
}
