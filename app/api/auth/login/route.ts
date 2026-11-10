import { NextRequest } from "next/server";
import { startOAuthRedirect } from "@/lib/bff";

/**
 * GET /api/auth/login
 *
 * Starts the Authorization Code + PKCE redirect. Customers and employees sign in the
 * same way; the Application Role on the resulting token decides where they land.
 */
export async function GET(request: NextRequest) {
  return await startOAuthRedirect(request);
}
