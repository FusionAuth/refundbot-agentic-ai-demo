import { createHash, randomUUID } from "crypto";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import {
  SERVICE_DEFS,
  audienceFor,
  orchestratorId,
} from "@/lib/refund-services";

/**
 * The SIMULATED exchange chain — the portability fallback, not the product. It exists
 * so this app stays honest if someone points it at a FusionAuth instance without Token
 * Exchange (pre-1.70.0, or not Enterprise). On the Enterprise instance this demo targets
 * it is never used.
 *
 * It mimics the Entity policy engine's one rule — "is there a Grant from the exchanger to
 * the audience right now?" — over an in-memory Grant set, and mints HS256 tokens signed
 * with a key derived from SESSION_SECRET under an issuer that can't be mistaken for
 * FusionAuth's. The MCP verifier accepts those tokens ONLY while the app is in simulated
 * mode, and the trace and banner both say "Simulated" the whole time.
 *
 * Deliberately imports nothing from lib/session.ts or lib/fusionauth.ts, so the MCP
 * resource server's verifier can depend on it without inheriting the session's code path.
 */

export const SIMULATED_ISSUER = "urn:refundbot:simulated-token-exchange";

function simulatedKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET || "refundbot-dev-only";
  return new Uint8Array(
    createHash("sha256").update(`simulated-exchange:${secret}`).digest()
  );
}

const globalStore = globalThis as unknown as {
  __refundBotExchangeMode?: "live" | "simulated";
  __refundBotSimGrants?: Set<string>;
};

/** The resolved mode, cached by lib/token-exchange.ts after it probes the instance. */
export function cachedExchangeMode(): "live" | "simulated" | undefined {
  return globalStore.__refundBotExchangeMode;
}

export function setCachedExchangeMode(mode: "live" | "simulated") {
  globalStore.__refundBotExchangeMode = mode;
}

/** The simulated Grant set: `<exchanger>→<audience>`. Seeded with the three standing Grants. */
function grants(): Set<string> {
  if (!globalStore.__refundBotSimGrants) {
    globalStore.__refundBotSimGrants = new Set(
      SERVICE_DEFS.filter((s) => s.standingGrant).map(
        (s) => `${orchestratorId()}→${audienceFor(s.service)}`
      )
    );
  }
  return globalStore.__refundBotSimGrants;
}

export function simulatedGrantExists(audience: string): boolean {
  return grants().has(`${orchestratorId()}→${audience}`);
}

export function simulatedCreateGrant(audience: string) {
  grants().add(`${orchestratorId()}→${audience}`);
}

export function simulatedDeleteGrant(audience: string) {
  grants().delete(`${orchestratorId()}→${audience}`);
}

export interface SimulatedExchangeOutcome {
  ok: boolean;
  token?: string;
  error?: { error: string; description: string; outcome: string };
}

/**
 * The Entity-engine rule, simulated: no Grant → POLICY_DENIED. Otherwise mint a token
 * carrying the same claim shape FusionAuth's would: subject's `sub` and `sid`, the
 * requested `aud`, an `act` naming the exchanger, a fresh `jti`. `approved_by` is never
 * stamped here — the simulated chain has no populate lambda, so the banking service
 * always falls back to the server-side record and the trace says so.
 */
export async function simulatedExchange(
  subjectClaims: JWTPayload,
  audience: string
): Promise<SimulatedExchangeOutcome> {
  if (!subjectClaims.sub) {
    return {
      ok: false,
      error: {
        error: "invalid_request",
        description: "The subject token has a blank sub claim.",
        outcome: "SUBJECT_TOKEN_INVALID",
      },
    };
  }
  if (!simulatedGrantExists(audience)) {
    return {
      ok: false,
      error: {
        error: "invalid_grant",
        description: `No Entity Grant from ${orchestratorId()} to ${audience}.`,
        outcome: "POLICY_DENIED",
      },
    };
  }
  const token = await new SignJWT({
    sid: subjectClaims.sid,
    auth_time: subjectClaims.auth_time,
    scope: subjectClaims.scope,
    client_id: orchestratorId(),
    act: { sub: orchestratorId(), sub_profile: "simulated:RefundBot Orchestrator" },
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(SIMULATED_ISSUER)
    .setSubject(subjectClaims.sub)
    .setAudience([audience])
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(simulatedKey());
  return { ok: true, token };
}

/** Verifies a simulated token. Callers must also check the app is IN simulated mode. */
export async function verifySimulatedToken(
  token: string,
  audiences: string[]
): Promise<JWTPayload | null> {
  try {
    const { payload } = await jwtVerify(token, simulatedKey(), {
      issuer: SIMULATED_ISSUER,
      audience: audiences,
    });
    return payload;
  } catch {
    return null;
  }
}
