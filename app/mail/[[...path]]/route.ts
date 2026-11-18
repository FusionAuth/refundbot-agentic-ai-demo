import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * /mail — the shared demo inbox. Proxies a private Mailpit service (started with
 * MP_WEBROOT=/mail) that the FusionAuth Tenant uses as its SMTP server, so SEs on the
 * shared demo accounts can read the emailed MFA codes. Any signed-in user may view it;
 * Mailpit itself has no public domain.
 *
 * Mailpit's live-update websocket (/mail/api/events) isn't proxied — the UI shows as
 * disconnected and needs a refresh to show new mail. Everything else works.
 */
const MAILPIT_URL = process.env.MAILPIT_URL?.replace(/\/+$/, "");

const DROP_REQUEST_HEADERS = new Set([
  "host",
  "cookie",
  "authorization",
  "connection",
  "content-length",
  "accept-encoding",
]);
const DROP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "set-cookie",
]);

function notConfigured() {
  const html = `<!doctype html><meta charset="utf-8"><title>Demo inbox</title>
<body style="font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem">
<div style="border:1px solid #f59e0b;background:#fffbeb;padding:1rem;border-radius:.5rem">
<strong>Demo inbox unavailable.</strong> <code>MAILPIT_URL</code> is not set, or Mailpit
isn't answering. MFA codes are still sent by FusionAuth, but there's nowhere to read
them here. See "Demo inbox (Mailpit)" in the README.
</div></body>`;
  return new NextResponse(html, {
    status: 503,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function handle(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    const base = process.env.APP_BASE_URL || request.nextUrl.origin;
    const loginUrl = new URL("/api/auth/login", base);
    loginUrl.searchParams.set("redirect_uri", `${request.nextUrl.pathname}${request.nextUrl.search}`);
    return NextResponse.redirect(loginUrl);
  }
  if (!MAILPIT_URL) return notConfigured();

  // Mailpit serves its UI at "/mail/" — send the bare path there so relative assets resolve.
  if (request.nextUrl.pathname === "/mail") {
    const base = process.env.APP_BASE_URL || request.nextUrl.origin;
    return NextResponse.redirect(new URL(`/mail/${request.nextUrl.search}`, base));
  }

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!DROP_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  let upstream: Response;
  try {
    upstream = await fetch(`${MAILPIT_URL}${request.nextUrl.pathname}${request.nextUrl.search}`, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.warn(`[mail] Mailpit unreachable at ${MAILPIT_URL}: ${(err as Error).message}`);
    return notConfigured();
  }

  const out = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!DROP_RESPONSE_HEADERS.has(key.toLowerCase())) out.set(key, value);
  });
  return new NextResponse(upstream.body, { status: upstream.status, headers: out });
}

export {
  handle as GET,
  handle as HEAD,
  handle as POST,
  handle as PUT,
  handle as PATCH,
  handle as DELETE,
};
