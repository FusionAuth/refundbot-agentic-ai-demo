/**
 * Client-safe types for RefundBot's FusionAuth FGA layer. No imports, no secrets — the
 * Permissions tab (`PermissionsGraph`), the approval console, and the refund chat
 * `import type` from here; lib/fga.ts builds these shapes.
 *
 * Vocabulary, kept deliberately apart from the Token Exchange side: everything here is
 * a **Permify entity / relation / attribute** in the FGA schema (permify/schema.perm).
 * None of it is a *FusionAuth Entity* (the orchestrator and the four service audiences
 * in lib/entities.ts). Different system, different fields — no `sub`/`act`/`sid` here.
 */

/** "live" = a real Permify server answered; "demo" = the in-memory fallback resolver. */
export type FgaMode = "live" | "demo";

/** One permission check as Permify was asked it. */
export interface FgaCheckView {
  /** `order:ORD-1042.<uuid>`, `store:downtown`, … */
  entity: string;
  /** `request_refund`, `auto_approve`, `approve_local`, `owner`, … */
  permission: string;
  /** `user:<id>`. */
  subject: string;
  /** `context.data` sent with the check, when the schema's rules read it. */
  context?: Record<string, number>;
  allowed: boolean;
}

/** Feature 1 — does this customer relate to the account that owns this order? */
export interface OwnershipDecision {
  allowed: boolean;
  orderEntity: string;
  /** The `account` the order's `account` relation points at, if Permify has one. */
  accountEntity?: string;
  accountLabel?: string;
  /** Which relation justified it. Undefined on a denial. */
  via?: "owner" | "delegate";
  checks: FgaCheckView[];
  reason: string;
}

/** Feature 3 — did the account's trust tier + cap let the refund skip employee review? */
export interface TierDecision {
  accountEntity: string;
  accountLabel: string;
  /** Read back from Permify's attribute store (or the fallback). */
  tier: string;
  capCents: number;
  amountCents: number;
  autoApprove: boolean;
  checks: FgaCheckView[];
  reason: string;
}

/** Feature 2 — one employee's attempt to decide an escalated refund. */
export interface ApproverDecision {
  employeeId: string;
  employeeName: string;
  decision: "approve" | "deny";
  at: string;
  allowed: boolean;
  /** `approve_local` = their own store; `approve_escalated` = inherited via the region. */
  path?: "approve_local" | "approve_escalated";
  store: { id: string; label: string; capCents: number };
  region: { id: string; label: string; capCents: number };
  /** Why the local check failed, when it did. */
  localReason?: "not_store_manager" | "over_store_cap";
  /** Why the region check failed, when it did. */
  regionReason?: "not_region_director" | "over_region_cap";
  checks: FgaCheckView[];
  reason: string;
  /** Set when the mismatch is "not this employee's store": who to escalate to instead. */
  suggestion?: string;
}

/** Everything FGA decided about one refund request — the Permissions tab's model. */
export interface RefundFgaView {
  mode: FgaMode;
  ownership?: OwnershipDecision;
  tier?: TierDecision;
  /** The order's store and region, once the order is known. */
  store?: { id: string; label: string; capCents: number };
  region?: { id: string; label: string; capCents: number };
  approvals: ApproverDecision[];
}
