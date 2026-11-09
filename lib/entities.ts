import {
  audienceFor,
  orchestratorId,
} from "@/lib/refund-services";
import {
  simulatedCreateGrant,
  simulatedDeleteGrant,
  simulatedGrantExists,
} from "@/lib/simulated-exchange";
import type { ExchangeMode } from "@/lib/refund-types";

/**
 * The Entity Grant wrapper — the literal implementation of "the authority to call the
 * banking service doesn't exist until both approvals do."
 *
 * Under the Entity policy engine, FusionAuth issues a token for an audience only if the
 * exchanger holds a Grant on that audience's Entity. Hops 1–3 have standing Grants,
 * created once in the admin UI. The banking-api Entity never does: this module creates
 * the Grant immediately before the hop-4 exchange and deletes it immediately after —
 * every time, success or failure. NOTHING ELSE in the app may create this Grant.
 *
 * Because a Grant is orchestrator→banking, not per-refund, two refunds executing at once
 * could share one Grant's lifetime. `withBankingGrant` serializes them behind an
 * in-process lock, and the banking service independently checks the approval record for
 * the specific request, so a token minted during someone else's window still can't
 * refund an unapproved order.
 */

export interface GrantOpResult {
  ok: boolean;
  detail: string;
}

function apiConfig(): { url: string; headers: Record<string, string> } | null {
  const url = process.env.FUSIONAUTH_URL?.replace(/\/$/, "");
  const key = process.env.FUSIONAUTH_API_KEY;
  if (!url || !key) return null;
  const headers: Record<string, string> = {
    Authorization: key,
    "Content-Type": "application/json",
  };
  const tenant = process.env.FUSIONAUTH_TENANT_ID;
  if (tenant) headers["X-FusionAuth-TenantId"] = tenant;
  return { url, headers };
}

function bankingEntityId(): string {
  return audienceFor("banking-api");
}

/** POST /api/entity/{banking}/grant — recipient: the orchestrator. */
export async function createBankingGrant(mode: ExchangeMode): Promise<GrantOpResult> {
  if (mode === "simulated") {
    simulatedCreateGrant(bankingEntityId());
    return { ok: true, detail: "Simulated Grant created (in-memory)." };
  }
  const cfg = apiConfig();
  if (!cfg) return { ok: false, detail: "FUSIONAUTH_URL / FUSIONAUTH_API_KEY not set." };
  try {
    const res = await fetch(`${cfg.url}/api/entity/${bankingEntityId()}/grant`, {
      method: "POST",
      headers: cfg.headers,
      body: JSON.stringify({
        grant: { recipientEntityId: orchestratorId(), permissions: [] },
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, detail: `HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}` };
    }
    return {
      ok: true,
      detail: `Grant created: ${orchestratorId()} → ${bankingEntityId()} (Entity Grant API).`,
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : "Grant API unreachable." };
  }
}

/** DELETE /api/entity/{banking}/grant?recipientEntityId={orchestrator}. */
export async function deleteBankingGrant(mode: ExchangeMode): Promise<GrantOpResult> {
  if (mode === "simulated") {
    simulatedDeleteGrant(bankingEntityId());
    return { ok: true, detail: "Simulated Grant revoked (in-memory)." };
  }
  const cfg = apiConfig();
  if (!cfg) return { ok: false, detail: "FUSIONAUTH_URL / FUSIONAUTH_API_KEY not set." };
  const q = new URLSearchParams({ recipientEntityId: orchestratorId() });
  try {
    const res = await fetch(`${cfg.url}/api/entity/${bankingEntityId()}/grant?${q}`, {
      method: "DELETE",
      headers: cfg.headers,
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    // 404 means it's already gone — the state we want.
    if (!res.ok && res.status !== 404) {
      const text = await res.text();
      return { ok: false, detail: `HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}` };
    }
    return {
      ok: true,
      detail: `Grant revoked: ${orchestratorId()} → ${bankingEntityId()} no longer exists.`,
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : "Grant API unreachable." };
  }
}

/**
 * Does an orchestrator → banking-api Grant exist right now? For /admin: outside a hop-4
 * window the answer must be "no", and if it's "yes" someone created a standing Grant by
 * hand, which defeats the whole design. Null when it can't be determined.
 */
export async function bankingGrantExists(mode: ExchangeMode): Promise<boolean | null> {
  if (mode === "simulated") return simulatedGrantExists(bankingEntityId());
  const cfg = apiConfig();
  if (!cfg) return null;
  const q = new URLSearchParams({
    entityId: bankingEntityId(),
    recipientEntityId: orchestratorId(),
  });
  try {
    const res = await fetch(`${cfg.url}/api/entity/grant/search?${q}`, {
      headers: cfg.headers,
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { grants?: unknown[]; total?: number };
    return (body.total ?? body.grants?.length ?? 0) > 0;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The banking-hop lock
// ---------------------------------------------------------------------------

const globalLock = globalThis as unknown as { __refundBotBankingLock?: Promise<void> };

/**
 * Runs `work` with exclusive use of the banking Grant window. Also used by the
 * pre-approval probe, so a probe can never observe another refund's live Grant.
 */
export async function withBankingLock<T>(work: () => Promise<T>): Promise<T> {
  const previous = globalLock.__refundBotBankingLock ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => (release = resolve));
  globalLock.__refundBotBankingLock = previous.then(() => mine);
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}
