import { resetRefundData } from "@/lib/refund-data";
import { clearRefunds } from "@/lib/approvals";
import { bankingGrantExists, deleteBankingGrant, withBankingLock } from "@/lib/entities";
import { lastKnownExchangeMode } from "@/lib/token-exchange";

/**
 * Resets RefundBot's demo state in place — no server restart, which matters on a host
 * like Railway where a restart is a redeploy-sized event and drops every session's
 * in-flight state with it.
 *
 * What it clears (all in-memory, by design — see README non-goals):
 *   - order books → re-seeded from the template on next lookup (nothing refunded);
 *     a full reset also restores the shared household / Okafor accounts' orders
 *   - the approval queue → /support/approvals and the /admin audit panel start empty
 *   - the refund budget → refilled (full reset only)
 *
 * And one thing it checks in FusionAuth: that no orchestrator → banking-api Grant is
 * left over. There never should be one — every hop 4 revokes its own in a `finally` —
 * but a reset is the moment to prove it, and to delete one if someone created a standing
 * Grant by hand. Runs under withBankingLock, so it can't interleave with a refund that's
 * executing right now.
 *
 * What it deliberately does NOT touch: FusionAuth FGA relations and attributes (they
 * describe ownership and who may approve, which a reset doesn't change — edit them in
 * /admin), FusionAuth users, Entities, standing Grants, and
 * the Token Exchange audit log. That log is FusionAuth's first-party record and isn't
 * ours to erase; /admin simply won't list old transactions once the queue is empty.
 */

export interface DemoResetResult {
  scope: "all" | "customer";
  customerId?: string;
  orderBooksCleared: number;
  requestsCleared: number;
  budgetRefilled: boolean;
  bankingGrant: "none" | "removed" | "remove_failed" | "unknown";
  at: string;
}

export async function resetDemo(opts: { customerId?: string } = {}): Promise<DemoResetResult> {
  return withBankingLock(async () => {
    const requestsCleared = clearRefunds(opts.customerId);
    const orderBooksCleared = resetRefundData(opts.customerId);

    const mode = lastKnownExchangeMode();
    let bankingGrant: DemoResetResult["bankingGrant"] = "unknown";
    const exists = await bankingGrantExists(mode);
    if (exists === false) bankingGrant = "none";
    else if (exists === true) {
      bankingGrant = (await deleteBankingGrant(mode)).ok ? "removed" : "remove_failed";
    }

    return {
      scope: opts.customerId ? "customer" : "all",
      customerId: opts.customerId,
      orderBooksCleared,
      requestsCleared,
      budgetRefilled: !opts.customerId,
      bankingGrant,
      at: new Date().toISOString(),
    };
  });
}
