import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "crypto";
import { getSession } from "@/lib/session";
import { isAdmin } from "@/lib/roles";
import { lookupUserByEmail } from "@/lib/fusionauth";
import { resetDemo } from "@/lib/demo-reset";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/reset-demo — reset RefundBot's demo state without a restart.
 * Body (optional): { customerEmail?: string }  — omit to reset everything.
 *
 * Two ways in:
 *   1. A signed-in admin (the /admin "Reset demo data" button).
 *   2. `Authorization: Bearer $DEMO_RESET_TOKEN` — for a curl one-liner or a Railway cron,
 *      without anyone logging in. Disabled entirely when DEMO_RESET_TOKEN is unset.
 */

function tokenMatches(header: string | null): boolean {
  const expected = process.env.DEMO_RESET_TOKEN?.trim();
  if (!expected || !header?.startsWith("Bearer ")) return false;
  // Hash both sides so the comparison is constant-time regardless of length.
  const a = createHash("sha256").update(header.slice(7).trim()).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function POST(request: NextRequest) {
  let actor: string;
  if (tokenMatches(request.headers.get("authorization"))) {
    actor = "reset token";
  } else {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    if (!isAdmin(session.roles)) {
      return NextResponse.json({ error: "Admins only" }, { status: 403 });
    }
    actor = session.email ?? session.userId;
  }

  let body: { customerEmail?: unknown } = {};
  try {
    const text = await request.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  let customerId: string | undefined;
  if (typeof body.customerEmail === "string" && body.customerEmail.trim()) {
    const user = await lookupUserByEmail(body.customerEmail);
    if (!user) {
      return NextResponse.json(
        { error: `No FusionAuth user with email ${body.customerEmail}.` },
        { status: 404 }
      );
    }
    customerId = user.id;
  }

  const result = await resetDemo({ customerId });
  console.info(`[demo-reset] ${result.scope} reset by ${actor}`, result);
  return NextResponse.json({ ...result, by: actor });
}
