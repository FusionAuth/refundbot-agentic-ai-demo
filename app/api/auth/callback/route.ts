import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { exchangeCodeForTokens, verifyIdToken, fusionAuthConfig } from "@/lib/fusionauth";
import { setSession } from "@/lib/session";
import {
  STATE_COOKIE,
  VERIFIER_COOKIE,
  RETURN_COOKIE,
} from "@/lib/bff";

/**
 * GET /api/auth/callback
 *
 * FusionAuth redirects here after the user authenticates. We validate
 * `state`, exchange the code for tokens (PKCE), verify the id_token against JWKS,
 * seal the tokens into the encrypted session cookie, then return the browser to
 * the path it started from.
 */
/**
 * Redirects are built on APP_BASE_URL, never `request.url`: behind a proxy (Railway)
 * request.url is the container's internal address (e.g. localhost:8080), which the
 * browser can't reach.
 */
function appUrl(path: string): URL {
  return new URL(path, fusionAuthConfig.appBaseUrl);
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;

  const error = searchParams.get("error");
  if (error) {
    return NextResponse.redirect(
      appUrl(`/?error=${encodeURIComponent(error)}`)
    );
  }

  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const expectedState = request.cookies.get(STATE_COOKIE)?.value;
  const codeVerifier = request.cookies.get(VERIFIER_COOKIE)?.value;
  const returnTo = request.cookies.get(RETURN_COOKIE)?.value || "/";

  if (
    !code ||
    !state ||
    !expectedState ||
    state !== expectedState ||
    !codeVerifier
  ) {
    return NextResponse.redirect(appUrl("/?error=invalid_state"));
  }

  try {
    const tokens = await exchangeCodeForTokens(code, codeVerifier);
    // Fail fast if the id_token doesn't verify — don't trust unchecked claims.
    if (tokens.id_token) {
      await verifyIdToken(tokens.id_token);
    }
    await setSession(tokens);
  } catch {
    return NextResponse.redirect(
      appUrl("/?error=exchange_failed")
    );
  }

  const store = await cookies();
  store.delete(STATE_COOKIE);
  store.delete(VERIFIER_COOKIE);
  store.delete(RETURN_COOKIE);

  return NextResponse.redirect(appUrl(returnTo));
}
