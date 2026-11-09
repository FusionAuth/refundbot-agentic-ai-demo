import { randomUUID } from "crypto";
import type {
  ApprovalState,
  ChainEntry,
  ExchangeMode,
  RefundDecision,
  RefundRequestView,
} from "@/lib/refund-types";

/**
 * The approval queue — in-memory, keyed by the transaction's session id (`sid`), the
 * correlator FusionAuth copies onto every exchanged token in the chain. One sid can hold
 * several refund requests (a customer can ask for two refunds in one conversation), so
 * each sid maps to a list and each request has its own id.
 *
 * No persistence: a restart forgets every pending refund, same as every other mock store
 * in this portfolio.
 *
 * The record also holds the customer's ORIGINAL access token — the subject token every
 * hop exchanges. It has to live somewhere server-side because hop 4 can be triggered
 * from the employee's request, not the customer's. It is never serialized to a browser:
 * `toView` drops it.
 */

export interface RefundRecord {
  id: string;
  sid: string;
  sidSource: "sid" | "jti-fallback";
  customerId: string;
  customerLabel: string;
  /** Server-only. The customer's original access token; every hop exchanges THIS. */
  subjectToken: string;
  orderId: string;
  orderSummary?: string;
  amountCents?: number;
  valueScore?: number;
  thresholdCents?: number;
  needsEmployee: boolean;
  customer: { state: ApprovalState; via?: string; at?: string };
  employee: { state: ApprovalState; employeeId?: string; employeeName?: string; at?: string };
  decision: RefundDecision;
  /** Set once hop 4 has run — the banking service refuses a second use. */
  executed: boolean;
  confirmationId?: string;
  createdAt: string;
  updatedAt: string;
  mode: ExchangeMode;
  trace: ChainEntry[];
  issuedJtis: string[];
}

const globalStore = globalThis as unknown as {
  __refundBotApprovals?: Map<string, RefundRecord[]>;
};

function queue(): Map<string, RefundRecord[]> {
  if (!globalStore.__refundBotApprovals) globalStore.__refundBotApprovals = new Map();
  return globalStore.__refundBotApprovals;
}

export function createRefundRecord(input: {
  sid: string;
  sidSource: "sid" | "jti-fallback";
  customerId: string;
  customerLabel: string;
  subjectToken: string;
  orderId: string;
  mode: ExchangeMode;
}): RefundRecord {
  const now = new Date().toISOString();
  const record: RefundRecord = {
    id: `rf_${randomUUID().slice(0, 8)}`,
    ...input,
    needsEmployee: false,
    customer: { state: "pending" },
    employee: { state: "not_required" },
    decision: "awaiting_approvals",
    executed: false,
    createdAt: now,
    updatedAt: now,
    trace: [],
    issuedJtis: [],
  };
  const list = queue().get(input.sid) ?? [];
  list.push(record);
  queue().set(input.sid, list);
  return record;
}

export function findRefund(id: string): RefundRecord | undefined {
  for (const list of queue().values()) {
    const hit = list.find((r) => r.id === id);
    if (hit) return hit;
  }
  return undefined;
}

/** The record for (sid, request id) — what the banking service looks up. */
export function findRefundInSession(sid: string, id: string): RefundRecord | undefined {
  return queue().get(sid)?.find((r) => r.id === id);
}

export function allRefunds(): RefundRecord[] {
  return [...queue().values()]
    .flat()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function touch(record: RefundRecord) {
  record.updatedAt = new Date().toISOString();
}

export function pushTrace(record: RefundRecord, entry: ChainEntry) {
  record.trace.push(entry);
  if (entry.type === "hop" && entry.jti && !record.issuedJtis.includes(entry.jti)) {
    record.issuedJtis.push(entry.jti);
  }
  touch(record);
}

/** True once every approval this request needs has been given. */
export function approvalsSatisfied(record: RefundRecord): boolean {
  if (record.customer.state !== "approved") return false;
  if (!record.needsEmployee) return true;
  return record.employee.state === "approved" && !!record.employee.employeeId;
}

/** True once any party has said no — the Grant must never be created after this. */
export function approvalsRefused(record: RefundRecord): boolean {
  return record.customer.state === "declined" || record.employee.state === "denied";
}

export function recordCustomerDecision(
  record: RefundRecord,
  approved: boolean,
  via?: string
) {
  record.customer = {
    state: approved ? "approved" : "declined",
    via,
    at: new Date().toISOString(),
  };
  if (!approved) record.decision = "declined";
  touch(record);
}

export function recordEmployeeDecision(
  record: RefundRecord,
  approved: boolean,
  employee: { id: string; name: string }
) {
  record.employee = {
    state: approved ? "approved" : "denied",
    employeeId: employee.id,
    employeeName: employee.name,
    at: new Date().toISOString(),
  };
  if (!approved) record.decision = "denied";
  touch(record);
}

/** The browser-safe projection: everything except the subject token. */
export function toView(record: RefundRecord): RefundRequestView {
  // Destructure the secret out explicitly so adding a field can't leak it by accident.
  const { subjectToken: _omit, executed: _executed, ...rest } = record;
  void _omit;
  void _executed;
  return { ...rest, trace: [...rest.trace], issuedJtis: [...rest.issuedJtis] };
}

/**
 * Drops refund requests — one customer's, or all of them. Only lib/demo-reset.ts calls
 * this, under withBankingLock, so a request can't vanish mid-hop-4. Returns the count.
 */
export function clearRefunds(customerId?: string): number {
  let removed = 0;
  for (const [sid, list] of queue()) {
    const keep = customerId ? list.filter((r) => r.customerId !== customerId) : [];
    removed += list.length - keep.length;
    if (keep.length) queue().set(sid, keep);
    else queue().delete(sid);
  }
  return removed;
}
