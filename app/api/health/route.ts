import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Liveness for Railway's healthcheck. Deliberately touches no external service. */
export function GET() {
  return NextResponse.json({ ok: true });
}
