import { NextRequest, NextResponse } from "next/server";
import { buildAuthorizeUrl, fusionAuthConfig } from "@/lib/fusionauth";
import { randomUrlSafeString, codeChallengeFromVerifier } from "@/lib/pkce";

/**
 * Shared helpers for the /api/auth/* routes: the Authorization Code + PKCE round
 * trip and the open-redirect guards around it. There is no browser SDK, so these
 * routes are the entire human-auth surface.
 *
 * Every login — customer or employee — requests the same OIDC base scopes. There is no
 * per-role custom scope catalog any more: what a customer's agent may reach is decided by
 * RFC 8693 Token Exchange (lib/token-exchange.ts) and FusionAuth FGA (lib/fga.ts), and
 * what an employee may open is decided by their Application Role.
 */

export const STATE_COOKIE = "ia_oauth_state";
export const VERIFIER_COOKIE = "ia_pkce_verifier";
export const RETURN_COOKIE = "ia_return_to";

/** OIDC + refresh scopes every login requests. All are FusionAuth built-ins. */
export const OIDC_BASE_SCOPES = ["openid", "offline_access", "email", "profile"];

const TEMP_COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: 60 * 10, // 10 minutes
};

function appOrigin() {
  return new URL(fusionAuthConfig.appBaseUrl).origin;
}

/**
 * Reduces a caller-supplied return target to a safe SAME-ORIGIN relative path,
 * so /api/auth/login can't be turned into an open redirect.
 */
export function safeReturnTo(raw: string | null): string {
  // "/" routes by role: support staff to the approval console, everyone else to RefundBot.
  const fallback = "/";
  if (!raw) return fallback;
  try {
    const url = new URL(raw, fusionAuthConfig.appBaseUrl);
    if (url.origin !== appOrigin()) return fallback;
    return `${url.pathname}${url.search}` || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Starts the Authorization Code + PKCE redirect: stashes state/verifier/return in
 * short-lived cookies for the callback to validate, and redirects to FusionAuth's
 * hosted login.
 */
export async function startOAuthRedirect(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  const state = randomUrlSafeString(16);
  const codeVerifier = randomUrlSafeString(32);
  const codeChallenge = codeChallengeFromVerifier(codeVerifier);
  const returnTo = safeReturnTo(q.get("redirect_uri"));
  const scope = OIDC_BASE_SCOPES.join(" ");

  const authorizeUrl = buildAuthorizeUrl({ state, codeChallenge, scope });

  const response = NextResponse.redirect(authorizeUrl);
  response.cookies.set(STATE_COOKIE, state, TEMP_COOKIE_OPTS);
  response.cookies.set(VERIFIER_COOKIE, codeVerifier, TEMP_COOKIE_OPTS);
  response.cookies.set(RETURN_COOKIE, returnTo, TEMP_COOKIE_OPTS);
  return response;
}
