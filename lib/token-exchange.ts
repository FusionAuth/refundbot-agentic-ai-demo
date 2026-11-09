import { decodeJwt, type JWTPayload } from "jose";
import {
  exchangeEnvConfigured,
  orchestratorId,
  orchestratorSecret,
} from "@/lib/refund-services";
import {
  cachedExchangeMode,
  setCachedExchangeMode,
  simulatedExchange,
} from "@/lib/simulated-exchange";
import type { ExchangeMode } from "@/lib/refund-types";

/**
 * A thin client for FusionAuth's OAuth 2.0 Token Exchange grant (RFC 8693,
 * `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, Enterprise, 1.70.0+).
 *
 * The orchestrator Entity authenticates with its own client credentials and hands
 * FusionAuth the customer's access token as `subject_token`, naming ONE service Entity as
 * `audience`. With the Tenant's policy engine set to Entity, FusionAuth issues a token
 * only if a Grant from the orchestrator to that audience exists at that moment. The
 * issued token keeps the customer as `sub`, names the orchestrator in `act`, and carries
 * the subject token's `sid` — the correlator the trace groups hops by.
 *
 * A refusal is returned, never thrown, and never paraphrased: `error`,
 * `error_description`, and `error_reason` go into the trace exactly as FusionAuth sent
 * them. Turn on the Tenant's "Enable debug logging" for the fuller reason in the Event Log.
 *
 * Behind a small interface (`TokenExchanger`) so a simulated chain can stand in on an
 * instance that can't do the real thing — see lib/simulated-exchange.ts. That is a
 * portability fallback; the expected state is live.
 */

export const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
export const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

export interface ExchangeRequest {
  /** The customer's ORIGINAL access token. Never a previous hop's exchanged token. */
  subjectToken: string;
  /** The target service Entity's client Id. */
  audience: string;
  /** Recorded in FusionAuth's audit log and handed to the Token Exchange Populate lambda. */
  intent?: string;
}

export interface ExchangeFailure {
  status: number;
  error: string;
  description?: string;
  reason?: string;
  /** Audit-log outcome — only known for certain in simulated mode. */
  outcome?: string;
}

export interface ExchangeResult {
  ok: boolean;
  mode: ExchangeMode;
  token?: string;
  /** Decoded (not verified) — for the trace. The MCP server verifies independently. */
  claims?: JWTPayload & Record<string, unknown>;
  failure?: ExchangeFailure;
}

export interface TokenExchanger {
  mode: ExchangeMode;
  exchange(req: ExchangeRequest): Promise<ExchangeResult>;
}

/** Renders a refusal for the trace, verbatim. */
export function describeFailure(f: ExchangeFailure): string {
  const parts = [`${f.error}${f.description ? `: ${f.description}` : ""}`];
  if (f.reason) parts.push(`(error_reason: ${f.reason})`);
  if (f.status) parts.push(`[HTTP ${f.status}]`);
  return parts.join(" ");
}

function baseUrl(): string | undefined {
  return process.env.FUSIONAUTH_URL?.replace(/\/$/, "") || undefined;
}

function apiHeaders(): Record<string, string> | null {
  const key = process.env.FUSIONAUTH_API_KEY;
  if (!key) return null;
  const headers: Record<string, string> = { Authorization: key };
  const tenant = process.env.FUSIONAUTH_TENANT_ID;
  if (tenant) headers["X-FusionAuth-TenantId"] = tenant;
  return headers;
}

// ---------------------------------------------------------------------------
// Live: FusionAuth /oauth2/token
// ---------------------------------------------------------------------------

const liveExchanger: TokenExchanger = {
  mode: "live",
  async exchange(req) {
    const url = baseUrl();
    const secret = orchestratorSecret();
    if (!url || !secret) {
      return {
        ok: false,
        mode: "live",
        failure: {
          status: 0,
          error: "not_configured",
          description: "FUSIONAUTH_URL or FUSIONAUTH_ORCHESTRATOR_ENTITY_SECRET is unset.",
        },
      };
    }
    const body = new URLSearchParams({
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: req.subjectToken,
      subject_token_type: ACCESS_TOKEN_TYPE,
      audience: req.audience,
    });
    if (req.intent) body.set("intent", req.intent.slice(0, 255));
    const basic = Buffer.from(`${orchestratorId()}:${secret}`).toString("base64");

    let res: Response;
    try {
      res = await fetch(`${url}/oauth2/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${basic}`,
        },
        body,
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      return {
        ok: false,
        mode: "live",
        failure: {
          status: 0,
          error: "unreachable",
          description: err instanceof Error ? err.message : "FusionAuth unreachable.",
        },
      };
    }

    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      json = {};
    }

    if (!res.ok || typeof json.access_token !== "string") {
      return {
        ok: false,
        mode: "live",
        failure: {
          status: res.status,
          error:
            (typeof json.error === "string" && json.error) ||
            (res.status === 401 ? "invalid_client" : "exchange_failed"),
          description:
            (typeof json.error_description === "string" && json.error_description) ||
            (text && !text.startsWith("{") ? text.slice(0, 200) : undefined),
          reason: typeof json.error_reason === "string" ? json.error_reason : undefined,
        },
      };
    }

    let claims: ExchangeResult["claims"];
    try {
      claims = decodeJwt(json.access_token) as ExchangeResult["claims"];
    } catch {
      claims = undefined;
    }
    return { ok: true, mode: "live", token: json.access_token, claims };
  },
};

// ---------------------------------------------------------------------------
// Simulated: the portability fallback
// ---------------------------------------------------------------------------

const simulatedExchanger: TokenExchanger = {
  mode: "simulated",
  async exchange(req) {
    let subject: JWTPayload;
    try {
      subject = decodeJwt(req.subjectToken);
    } catch {
      return {
        ok: false,
        mode: "simulated",
        failure: {
          status: 400,
          error: "invalid_request",
          description: "The subject token isn't a JWT.",
          outcome: "SUBJECT_TOKEN_INVALID",
        },
      };
    }
    const out = await simulatedExchange(subject, req.audience);
    if (!out.ok || !out.token) {
      return {
        ok: false,
        mode: "simulated",
        failure: {
          status: 400,
          error: out.error?.error ?? "invalid_grant",
          description: out.error?.description,
          outcome: out.error?.outcome,
        },
      };
    }
    return {
      ok: true,
      mode: "simulated",
      token: out.token,
      claims: decodeJwt(out.token) as ExchangeResult["claims"],
    };
  },
};

// ---------------------------------------------------------------------------
// Mode resolution
// ---------------------------------------------------------------------------

export interface ExchangeModeInfo {
  mode: ExchangeMode;
  /** Why we're in this mode — rendered on the simulated banner and on /admin. */
  reason: string;
  version?: string;
}

const MIN_VERSION = [1, 70, 0];

function versionAtLeast(version: string, min: number[]): boolean {
  const parts = version.split(/[.-]/).map((p) => parseInt(p, 10) || 0);
  for (let i = 0; i < min.length; i++) {
    if ((parts[i] ?? 0) > min[i]) return true;
    if ((parts[i] ?? 0) < min[i]) return false;
  }
  return true;
}

const globalProbe = globalThis as unknown as {
  __refundBotModeProbe?: { info: ExchangeModeInfo; at: number };
};

/**
 * Live unless something proves otherwise: no reachable instance, a version older than
 * 1.70.0, or an unlicensed one. `REFUNDBOT_EXCHANGE_MODE=simulated|live` overrides.
 * Cached for a minute. A licensed instance that turns out not to be Enterprise, or has
 * Token Exchange off on the Tenant, stays "live" — and the first exchange's verbatim
 * refusal in the trace tells you exactly that, which is more honest than guessing.
 */
export async function resolveExchangeMode(): Promise<ExchangeModeInfo> {
  const cached = globalProbe.__refundBotModeProbe;
  if (cached && Date.now() - cached.at < 60_000) return cached.info;

  const info = await probe();
  globalProbe.__refundBotModeProbe = { info, at: Date.now() };
  setCachedExchangeMode(info.mode);
  return info;
}

async function probe(): Promise<ExchangeModeInfo> {
  const forced = process.env.REFUNDBOT_EXCHANGE_MODE?.trim().toLowerCase();
  if (forced === "simulated") {
    return { mode: "simulated", reason: "REFUNDBOT_EXCHANGE_MODE=simulated is set." };
  }
  if (forced === "live") {
    return { mode: "live", reason: "REFUNDBOT_EXCHANGE_MODE=live is set." };
  }

  const url = baseUrl();
  const headers = apiHeaders();
  if (!url || !headers) {
    return { mode: "simulated", reason: "No FusionAuth instance is configured." };
  }

  let version: string | undefined;
  try {
    const res = await fetch(`${url}/api/system/version`, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
      version = ((await res.json()) as { version?: string }).version;
    }
  } catch {
    return {
      mode: "simulated",
      reason: `No FusionAuth instance is reachable at ${url}.`,
    };
  }
  if (version && !versionAtLeast(version, MIN_VERSION)) {
    return {
      mode: "simulated",
      reason: `FusionAuth ${version} predates Token Exchange (needs 1.70.0+).`,
      version,
    };
  }

  try {
    // /api/reactor is instance-wide: FusionAuth answers 401 if a tenant header is sent,
    // even with a global key — so send the key alone.
    const res = await fetch(`${url}/api/reactor`, {
      headers: { Authorization: headers.Authorization },
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
      const body = (await res.json()) as { status?: { licensed?: boolean } };
      if (body.status && body.status.licensed === false) {
        return {
          mode: "simulated",
          reason: "This FusionAuth instance has no paid license; Token Exchange is Enterprise-only.",
          version,
        };
      }
    }
  } catch {
    // Can't read the license status — don't guess; the first exchange will tell us.
  }

  if (!exchangeEnvConfigured()) {
    return {
      mode: "live",
      reason:
        "Live, but the orchestrator/service Entity env vars are incomplete — exchanges " +
        "naming a placeholder audience will be refused by FusionAuth.",
      version,
    };
  }
  return {
    mode: "live",
    reason: `FusionAuth ${version ?? "(version unknown)"} with Token Exchange.`,
    version,
  };
}

/** The exchanger for the current mode. */
export async function getExchanger(): Promise<TokenExchanger> {
  const { mode } = await resolveExchangeMode();
  return mode === "live" ? liveExchanger : simulatedExchanger;
}

/** The exchanger for a specific mode — a transaction keeps the mode it started in. */
export function exchangerForMode(mode: ExchangeMode): TokenExchanger {
  return mode === "live" ? liveExchanger : simulatedExchanger;
}

/** Synchronous read of the last resolved mode (defaults to live — the expected state). */
export function lastKnownExchangeMode(): ExchangeMode {
  return cachedExchangeMode() ?? "live";
}

// ---------------------------------------------------------------------------
// FusionAuth's own record: the Token Exchange audit log
// ---------------------------------------------------------------------------

export interface TokenExchangeAuditEntry {
  eventId?: string;
  actChain?: string;
  exchangerClientId?: string;
  grantedAudience?: string;
  grantedScope?: string;
  insertInstant?: number;
  intent?: string;
  issuedTokenJti?: string;
  outcome?: string;
  policyDecision?: string;
  policyEngine?: string;
  requestedAudience?: string;
  subjectTokenJti?: string;
  subjectTokenSub?: string;
}

export interface AuditLookup {
  ok: boolean;
  entries: TokenExchangeAuditEntry[];
  error?: string;
}

async function auditGet(path: string): Promise<AuditLookup> {
  const url = baseUrl();
  const headers = apiHeaders();
  if (!url || !headers) {
    return { ok: false, entries: [], error: "FUSIONAUTH_URL / FUSIONAUTH_API_KEY not set." };
  }
  try {
    const res = await fetch(`${url}${path}`, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    const text = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        entries: [],
        error: `HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`,
      };
    }
    const body = JSON.parse(text) as { tokenExchangeAuditLogs?: TokenExchangeAuditEntry[] };
    return { ok: true, entries: body.tokenExchangeAuditLogs ?? [] };
  } catch (err) {
    return {
      ok: false,
      entries: [],
      error: err instanceof Error ? err.message : "Audit log unreachable.",
    };
  }
}

/**
 * Search the Token Exchange Audit Log — every attempt by the orchestrator in a window,
 * successes and refusals alike. `exchangerClientId` is the Entity's Id (FusionAuth's
 * docs note the name is misleading); with the default id == client Id they coincide.
 */
export function searchExchangeAuditLog(opts: {
  start?: number;
  end?: number;
  numberOfResults?: number;
}): Promise<AuditLookup> {
  const q = new URLSearchParams({
    exchangerClientId: orchestratorId(),
    numberOfResults: String(opts.numberOfResults ?? 50),
  });
  if (opts.start) q.set("start", String(opts.start));
  if (opts.end) q.set("end", String(opts.end));
  return auditGet(`/api/system/token-exchange-audit-log/search?${q}`);
}

/** Retrieve a Token Exchange Chain — the entries behind one issued token's `jti`. */
export function retrieveExchangeChain(issuedTokenJti: string): Promise<AuditLookup> {
  const q = new URLSearchParams({ issuedTokenJti });
  return auditGet(`/api/system/token-exchange-audit-log/chain?${q}`);
}
