/**
 * Client-safe types for RefundBot's exchange chain. No runtime imports, no secrets — the
 * browser components (`ExchangeChainTrace`, the refund chat, the approval console)
 * `import type` from here, and the server modules build these shapes.
 *
 * The trace is a flat, ordered list of entries. Most are HOPS — one OAuth Token
 * Exchange (RFC 8693) plus the MCP tool call made with the token it produced. The
 * rest are NOTES: planner decisions, approvals landing, the Grant lifecycle on the
 * banking hop. Order is the story, so it's kept as one list rather than two.
 */

import type { RefundFgaView } from "@/lib/fga-types";

export type ExchangeMode = "live" | "simulated";

/** The four backend services, in pipeline order. */
export type RefundService =
  | "order-history"
  | "customer-scoring"
  | "refund-budget"
  | "banking-api";

export type RefundToolName =
  | "get_order_history"
  | "score_customer_value"
  | "check_refund_budget"
  | "process_refund";

export type ApprovalState = "not_required" | "pending" | "approved" | "denied" | "declined";

/** One step of the on-demand Grant's lifecycle on the banking hop. */
export interface GrantEvent {
  step: "create" | "use" | "revoke";
  ok: boolean;
  at: string;
  detail: string;
}

export interface ExchangeHopEntry {
  type: "hop";
  hop: 1 | 2 | 3 | 4;
  service: RefundService;
  serviceLabel: string;
  tool: RefundToolName;
  /**
   * `standing` — hops 1–3, backed by a permanent Entity Grant.
   * `probe` — hop 4 attempted BEFORE approvals exist, to show FusionAuth refuse it.
   * `on-demand` — hop 4 after both approvals, wrapped in create → use → revoke.
   */
  grantKind: "standing" | "probe" | "on-demand";
  /** The `audience` requested — the target service Entity's client Id. */
  audience: string;
  /** Did FusionAuth (or the simulated engine) issue a token? */
  exchange: "allowed" | "denied" | "skipped";
  /** FusionAuth's own refusal, verbatim: `error: description (error_reason)`. */
  reason?: string;
  /** The audit-log outcome FusionAuth's docs map this refusal to, when we can tell. */
  outcome?: string;
  /** Claims off the ISSUED token (decoded — the MCP server verifies it independently). */
  act?: string;
  actProfile?: string;
  sub?: string;
  sid?: string;
  jti?: string;
  aud?: string[];
  /** The `approved_by` claim, when the populate lambda stamped one. */
  approvedByClaim?: string;
  /** The resource server's verdict on the call made with that token. */
  mcp?: { status: "allowed" | "denied" | "error" | "skipped"; detail: string };
  /** One-line human summary of what the service returned. */
  result?: string;
  /** Hop 4 only: approval states at the time of the hop. */
  approvals?: { customer: ApprovalState; employee: ApprovalState; employeeName?: string };
  /** Hop 4 only: the Grant's create → use → revoke lifecycle. */
  grant?: GrantEvent[];
  /** Hop 4 only: which evidence backed the employee-approval check. */
  approvedByPath?: "claim" | "server-side record" | "not required";
  at: string;
}

export interface TraceNoteEntry {
  type: "note";
  /**
   * `fga` marks a breadcrumb from the separate FusionAuth FGA layer (e.g. "Permify:
   * ownership check passed →"). Its details live in `RefundRequestView.fga`, rendered by
   * the Permissions tab — the token chain only points at it.
   */
  layer: "planner" | "fga" | "approval" | "pipeline" | "result";
  status: "info" | "allowed" | "denied" | "required" | "error";
  label: string;
  detail?: string;
  at: string;
}

export type ChainEntry = ExchangeHopEntry | TraceNoteEntry;

export type RefundDecision =
  | "stopped" // refused before approvals (FGA ownership, no order, already refunded, budget)
  | "awaiting_approvals"
  | "executing"
  | "refunded"
  | "denied" // employee said no
  | "declined" // customer said no
  | "failed";

/** What the browser sees of a refund request. The subject token never leaves the server. */
export interface RefundRequestView {
  id: string;
  sid: string;
  sidSource: "sid" | "jti-fallback";
  customerId: string;
  customerLabel: string;
  orderId: string;
  orderSummary?: string;
  amountCents?: number;
  /** Hop 2's informational history. */
  history?: CustomerHistoryView;
  /** The standard self-service floor hop 3 compared against. */
  floorCents?: number;
  needsEmployee: boolean;
  customer: { state: ApprovalState; via?: string; at?: string };
  employee: {
    state: ApprovalState;
    employeeId?: string;
    employeeName?: string;
    at?: string;
    /** Which FGA path authorized the decision. */
    path?: "approve_local" | "approve_escalated";
  };
  decision: RefundDecision;
  confirmationId?: string;
  /** What FusionAuth FGA decided about this request — the Permissions tab. */
  fga: RefundFgaView;
  createdAt: string;
  updatedAt: string;
  mode: ExchangeMode;
  trace: ChainEntry[];
  /** jti of every token issued in this transaction, for the /admin audit-log lookup. */
  issuedJtis: string[];
}

export interface CustomerHistoryView {
  lifetimeSpendCents: number;
  orderCount: number;
  priorRefunds: number;
}

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** /api/refund's response to a chat turn or a customer decision. */
export interface RefundTurnResponse {
  reply: string;
  request?: RefundRequestView;
  planner: { mode: "live" | "scripted"; degraded?: string };
  /** True when the client should show the RefundConfirmationSlip. */
  awaitingCustomer?: boolean;
}

/** The step-up action label that backs a customer's confirmation of one request. */
export function refundConfirmAction(requestId: string): string {
  return `refund:confirm:${requestId}`;
}
