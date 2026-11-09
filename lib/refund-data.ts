/**
 * RefundBot's mock backends — the data behind the four MCP tools. Same rule as every
 * other mock module in this repo: plain in-memory data, no database, and it never
 * imports a service client. The MCP handlers in lib/mcp-server.ts read it; nothing here
 * knows about tokens, Grants, or FusionAuth.
 *
 * Every signed-in customer gets the same demo order book, cloned per customer id on
 * first touch, so one customer's refund can't mark another's order refunded. A restart
 * resets everything.
 */

export interface Order {
  id: string;
  item: string;
  totalCents: number;
  placedDaysAgo: number;
  refunded: boolean;
  refundConfirmationId?: string;
}

/**
 * The demo order book. Chosen so the default value score (~69) puts the employee
 * threshold at ~$172: the earbuds, grinder, and jacket refund on the customer's
 * confirmation alone; the monitor and desk need a support employee too.
 * ORD-9999 is deliberately absent — that's the adversarial example.
 */
const ORDER_TEMPLATE: Omit<Order, "refunded">[] = [
  { id: "ORD-1042", item: "Wireless earbuds", totalCents: 4_800, placedDaysAgo: 12 },
  { id: "ORD-1011", item: "Burr coffee grinder", totalCents: 8_500, placedDaysAgo: 41 },
  { id: "ORD-1058", item: "Rain jacket", totalCents: 12_900, placedDaysAgo: 23 },
  { id: "ORD-1093", item: "27-inch monitor", totalCents: 34_900, placedDaysAgo: 9 },
  { id: "ORD-1077", item: "Standing desk", totalCents: 62_000, placedDaysAgo: 30 },
];

const globalStore = globalThis as unknown as {
  __refundBotOrders?: Map<string, Order[]>;
  __refundBotBudget?: { remainingCents: number };
};

function books(): Map<string, Order[]> {
  if (!globalStore.__refundBotOrders) globalStore.__refundBotOrders = new Map();
  return globalStore.__refundBotOrders;
}

/** The customer's order history, seeded from the template on first access. */
export function ordersForCustomer(customerId: string): Order[] {
  const store = books();
  let orders = store.get(customerId);
  if (!orders) {
    orders = ORDER_TEMPLATE.map((o) => ({ ...o, refunded: false }));
    store.set(customerId, orders);
  }
  return orders;
}

export function findOrder(customerId: string, orderId: string): Order | undefined {
  const wanted = orderId.trim().toUpperCase();
  return ordersForCustomer(customerId).find((o) => o.id === wanted);
}

export function markRefunded(
  customerId: string,
  orderId: string,
  confirmationId: string
): Order | undefined {
  const order = findOrder(customerId, orderId);
  if (!order || order.refunded) return undefined;
  order.refunded = true;
  order.refundConfirmationId = confirmationId;
  return order;
}

// ---------------------------------------------------------------------------
// Customer value scoring — a mock formula, not a model (see README non-goals)
// ---------------------------------------------------------------------------

export interface ValueScore {
  score: number;
  lifetimeSpendCents: number;
  orderCount: number;
  priorRefunds: number;
}

/**
 * 0–100. Up to 60 points for lifetime spend ($25 per point), 4 per order up to 30, minus
 * 10 per refund already taken. Deliberately simple and deterministic, so the threshold
 * a demo viewer sees is one they can recompute by hand.
 */
export function scoreCustomer(customerId: string): ValueScore {
  const orders = ordersForCustomer(customerId);
  const lifetimeSpendCents = orders.reduce((n, o) => n + o.totalCents, 0);
  const priorRefunds = orders.filter((o) => o.refunded).length;
  const raw =
    Math.min(60, Math.floor(lifetimeSpendCents / 2_500)) +
    Math.min(30, orders.length * 4) -
    priorRefunds * 10;
  return {
    score: Math.max(0, Math.min(100, raw)),
    lifetimeSpendCents,
    orderCount: orders.length,
    priorRefunds,
  };
}

// ---------------------------------------------------------------------------
// Refund budget + the employee-approval threshold
// ---------------------------------------------------------------------------

/** The floor the employee-approval threshold never drops below. Default $100. */
export function approvalFloorCents(): number {
  const raw = Number(process.env.REFUND_APPROVAL_FLOOR_CENTS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 10_000;
}

/**
 * Above this amount a support employee must approve. Scales with the value score
 * ($2.50 per point) but never drops below the floor — a zero-score customer still
 * gets $100 of self-service, and nobody gets unlimited self-service.
 */
export function approvalThresholdCents(score: number): number {
  return Math.max(approvalFloorCents(), score * 250);
}

const DAILY_BUDGET_CENTS = 200_000;

function budget(): { remainingCents: number } {
  if (!globalStore.__refundBotBudget) {
    globalStore.__refundBotBudget = { remainingCents: DAILY_BUDGET_CENTS };
  }
  return globalStore.__refundBotBudget;
}

export function budgetRemainingCents(): number {
  return budget().remainingCents;
}

/** Debits the budget; false (and no debit) when it can't cover the amount. */
export function debitBudget(amountCents: number): boolean {
  const b = budget();
  if (amountCents > b.remainingCents) return false;
  b.remainingCents -= amountCents;
  return true;
}

// ---------------------------------------------------------------------------
// Demo reset (see lib/demo-reset.ts — the only caller)
// ---------------------------------------------------------------------------

/**
 * Forgets order books — one customer's, or everyone's — so the next lookup re-seeds the
 * template: five orders, none refunded, value score back to 69. A full reset also
 * refills the refund budget. Returns how many order books were cleared.
 */
export function resetRefundData(customerId?: string): number {
  const store = books();
  let cleared = 0;
  if (customerId) {
    cleared = store.delete(customerId) ? 1 : 0;
  } else {
    cleared = store.size;
    store.clear();
    budget().remainingCents = DAILY_BUDGET_CENTS;
  }
  return cleared;
}
