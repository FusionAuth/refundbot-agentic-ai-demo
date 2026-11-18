import { NextRequest, NextResponse } from "next/server";
import { getSession, setStepUpGrant } from "@/lib/session";
import {
  checkTwoFactorStatus,
  startTwoFactorChallenge,
  sendEmailEnrollmentCode,
} from "@/lib/fusionauth";

/**
 * POST /api/two-factor/status
 * Body: { action: string }
 *
 * The step-up entry point, triggered by the agent's sensitive tool call. Asks
 * FusionAuth whether this user must complete a fresh two-factor check for
 * `action`. Runs with the app's own API key, never the user's token.
 *
 *  - challenge required → start it and return { challengeRequired, twoFactorId, methods }
 *  - not required       → write the step-up grant immediately and return { challengeRequired: false }
 */
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: { action?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const action = typeof body.action === "string" ? body.action : "";
  if (!action) {
    return NextResponse.json({ error: "Missing action" }, { status: 400 });
  }

  const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0].trim();

  try {
    const status = await checkTwoFactorStatus({
      userId: session.userId,
      action,
      ipAddress: clientIp || undefined,
    });

    if (!status.challengeRequired) {
      // No fresh challenge needed — grant step-up so the chat turn can proceed.
      await setStepUpGrant(action, "not_required");
      return NextResponse.json({ challengeRequired: false });
    }

    const challenge = await startTwoFactorChallenge({ userId: session.userId });

    // FusionAuth asked for a challenge (the MFA Requirement lambda always does for a
    // refund confirmation), but this customer has no method enrolled, so no challenge
    // code can be delivered. Don't wave them through: email a code to the address on the
    // account. Entering it proves the inbox AND enrolls email as their first method
    // (/api/two-factor/verify with enroll: true), so the next confirmation is a normal
    // challenge.
    if (challenge.methods.length === 0) {
      if (!session.email) {
        return NextResponse.json(
          { error: "No MFA method and no email on this account — confirmation isn't possible." },
          { status: 409 }
        );
      }
      await sendEmailEnrollmentCode({ userId: session.userId, email: session.email });
      return NextResponse.json({
        challengeRequired: true,
        enroll: true,
        methods: [{ id: "enroll-email", method: "email", email: session.email }],
      });
    }
    return NextResponse.json({
      challengeRequired: true,
      twoFactorId: challenge.twoFactorId,
      methods: challenge.methods,
    });
  } catch (err) {
    const detail = err as { statusCode?: number; exception?: unknown };
    console.error(
      `[two-factor] step-up for ${action} failed (${detail?.statusCode ?? "no status"}):`,
      JSON.stringify(detail?.exception ?? String(err))
    );
    return NextResponse.json(
      { error: "Could not start a step-up challenge." },
      { status: 502 }
    );
  }
}
