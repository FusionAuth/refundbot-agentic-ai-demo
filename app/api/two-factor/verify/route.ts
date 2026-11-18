import { NextRequest, NextResponse } from "next/server";
import { getSession, setStepUpGrant } from "@/lib/session";
import { completeTwoFactorLogin, enableEmailTwoFactor } from "@/lib/fusionauth";

/**
 * POST /api/two-factor/verify
 * Body: { twoFactorId: string, code: string, action: string }
 *    or { enroll: true, code: string, action: string }
 *
 * Completes the step-up with the code the user entered. Normally that's the challenge
 * /status started. With `enroll`, the customer had no MFA method: /status emailed a code
 * to their account address, and this enables email MFA with it, so the code proves the
 * inbox and enrolls the method in one step. Either way it writes the short-lived step-up
 * grant for `action`.
 */
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: { twoFactorId?: unknown; code?: unknown; action?: unknown; enroll?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const { twoFactorId, code, action } = body;
  const enroll = body.enroll === true;
  if (
    typeof code !== "string" ||
    !code ||
    typeof action !== "string" ||
    !action ||
    (!enroll && typeof twoFactorId !== "string")
  ) {
    return NextResponse.json(
      { verified: false, error: "Missing twoFactorId, code, or action." },
      { status: 400 }
    );
  }

  if (enroll) {
    if (!session.email) {
      return NextResponse.json({ verified: false, error: "No email on this account." }, { status: 409 });
    }
    const result = await enableEmailTwoFactor({ userId: session.userId, email: session.email, code });
    if (!result.success) {
      return NextResponse.json({ verified: false, error: result.error }, { status: 400 });
    }
    await setStepUpGrant(action, "enrolled");
    return NextResponse.json({ verified: true, enrolled: true });
  }

  const result = await completeTwoFactorLogin({ twoFactorId: twoFactorId as string, code });
  if (!result.success) {
    return NextResponse.json(
      { verified: false, error: result.error },
      { status: 400 }
    );
  }

  await setStepUpGrant(action);
  return NextResponse.json({ verified: true });
}
