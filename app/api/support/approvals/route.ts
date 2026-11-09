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

export const dynamic = "force-dynamic";

/**
 * /api/support/approvals — the second human in the loop.
 *
 *   GET                                    the queue (staff only)
 *   POST { requestId, decision }           "approve" | "deny"
 *
 * Gated on the verified token's Application Role, the same pattern as /admin. An
 * employee may not approve their own refund. Approving records WHO approved (their
 * FusionAuth user id), and if the customer has already confirmed, this request runs
 * hop 4 right here: create Grant → exchange → call banking-api → revoke Grant. Denying
 * means the Grant is never created at all.
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
  const employee = { id: session.userId, name: session.name ?? session.email ?? session.userId };
  recordEmployeeDecision(record, approved, employee);
  pushTrace(record, {
    type: "note",
    layer: "approval",
    status: approved ? "allowed" : "denied",
    label: approved
      ? `support employee approved · ${employee.name}`
      : `support employee denied · ${employee.name}`,
    detail: approved
      ? `Approver user id ${employee.id} recorded against sid ${record.sid}. ` +
        (record.customer.state === "approved"
          ? "The customer already confirmed, so hop 4 runs now."
          : "Still waiting on the customer's own confirmation.")
      : "The banking-api Grant will never be created for this request; hop 4 is never attempted.",
    at: new Date().toISOString(),
  });

  if (approved) await maybeExecuteBankingHop(record);
  return NextResponse.json({ request: toView(record) });
}
