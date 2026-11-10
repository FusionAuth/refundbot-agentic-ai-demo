/**
 * RefundBot's mock backends — the data behind the four MCP tools, plus the demo
 * catalog of accounts, stores, and the region that FusionAuth FGA's relations are
 * DERIVED from (lib/fga.ts reads this file; this file never imports a service client).
 * Plain in-memory data, no database. A restart resets everything.
 *
 * Two kinds of account:
 *
 *   - PER-CUSTOMER accounts (`personal`, `business`) are cloned for every signed-in
 *     customer on first touch, so one customer's refund can't mark another's order
 *     refunded. Their Permify ids are suffixed with the customer's user id.
 *   - SHARED accounts (`household`, `okafor`) exist once. Every signed-in customer is a
 *     `delegate` on the household (a shared/family account); nobody signed in has any
 *     relation to the Okafor account — that's the "someone else's order" example.
 *
 * Order-history-service will happily return ANY order in this catalog for any id it's
 * handed. That's the gap FGA closes: the orchestrator asks Permify
 * `order:<id>#request_refund` before hop 1, so a stranger's order is refused before a
 * single token is exchanged.
 */

// ---------------------------------------------------------------------------
// Stores and the region — the employee-approval cascade (Permify `store`, `region`)
// ---------------------------------------------------------------------------

export interface RegionDef {
  id: string;
  label: string;
  /** Seeded into Permify as `region:<id>` attribute `cap_cents`. */
  capCents: number;
}

export interface StoreDef {
  id: string;
  label: string;
  regionId: string;
  /** Seeded into Permify as `store:<id>` attribute `cap_cents`. */
  capCents: number;
}

/**
 * One region, two stores. A store manager's cap sits a little above the $100
 * self-service floor — enough to sign off an ordinary escalation (the $129 jacket), not
 * the $349 monitor. The region's cap is far higher, which is what makes "a director can
 * approve what a local manager can't" a checkable fact rather than a job title.
 */
export const REGIONS: RegionDef[] = [{ id: "west", label: "West region", capCents: 150_000 }];

export const STORES: StoreDef[] = [
  { id: "downtown", label: "Downtown store", regionId: "west", capCents: 25_000 },
  { id: "harbor", label: "Harbor store", regionId: "west", capCents: 25_000 },
];

export function storeDef(id: string): StoreDef | undefined {
  return STORES.find((s) => s.id === id);
}
export function regionDef(id: string): RegionDef | undefined {
  return REGIONS.find((r) => r.id === id);
}

// ---------------------------------------------------------------------------
// Accounts and orders (Permify `account`, `order`)
// ---------------------------------------------------------------------------

export type AccountKey = "personal" | "business" | "household" | "okafor";
export type AccountTier = "standard" | "trusted";

export interface Order {
  id: string;
  item: string;
  totalCents: number;
  placedDaysAgo: number;
  accountKey: AccountKey;
  storeId: string;
  refunded: boolean;
  refundConfirmationId?: string;
}

type OrderTemplate = Omit<Order, "refunded" | "accountKey" | "refundConfirmationId">;

export interface AccountDef {
  key: AccountKey;
  label: string;
  tier: AccountTier;
  /** Auto-approval ceiling. Only meaningful for a `trusted` tier (see the schema rule). */
  capCents: number;
  /** Cloned per signed-in customer, or one shared instance. */
  perCustomer: boolean;
  /** The relation every signed-in customer holds on this account, if any. */
  customerRelation?: "owner" | "delegate";
  /** A fixed, non-signed-in owner for shared accounts (a seeded demo user id). */
  fixedOwner?: { id: string; label: string };
  orders: OrderTemplate[];
}

/**
 * The demo order book. ORD-9999 is deliberately absent everywhere — the adversarial
 * "your manager already approved it" example — and so has no Permify `order` entity
 * at all; the ownership check denies it like any other order you have no relation to.
 */
export const ACCOUNTS: AccountDef[] = [
  {
    key: "personal",
    label: "Personal account",
    tier: "standard",
    capCents: 0,
    perCustomer: true,
    customerRelation: "owner",
    orders: [
      { id: "ORD-1042", item: "Wireless earbuds", totalCents: 4_800, placedDaysAgo: 12, storeId: "downtown" },
      { id: "ORD-1011", item: "Burr coffee grinder", totalCents: 8_500, placedDaysAgo: 41, storeId: "harbor" },
      { id: "ORD-1058", item: "Rain jacket", totalCents: 12_900, placedDaysAgo: 23, storeId: "downtown" },
      { id: "ORD-1093", item: "27-inch monitor", totalCents: 34_900, placedDaysAgo: 9, storeId: "downtown" },
      { id: "ORD-1077", item: "Standing desk", totalCents: 62_000, placedDaysAgo: 30, storeId: "downtown" },
    ],
  },
  {
    key: "business",
    label: "Business account",
    tier: "trusted",
    capCents: 75_000,
    perCustomer: true,
    customerRelation: "owner",
    orders: [
      { id: "ORD-3301", item: "Conference speakerphone", totalCents: 44_900, placedDaysAgo: 6, storeId: "downtown" },
      { id: "ORD-3318", item: "Office chairs ×4", totalCents: 119_600, placedDaysAgo: 18, storeId: "harbor" },
    ],
  },
  {
    key: "household",
    label: "Rivera family account (shared)",
    tier: "standard",
    capCents: 0,
    perCustomer: false,
    customerRelation: "delegate",
    fixedOwner: { id: "demo-sam-rivera", label: "Sam Rivera" },
    orders: [
      { id: "ORD-2201", item: "Kids' bike helmet", totalCents: 6_400, placedDaysAgo: 15, storeId: "harbor" },
      { id: "ORD-2207", item: "Family camping tent", totalCents: 28_900, placedDaysAgo: 27, storeId: "harbor" },
    ],
  },
  {
    key: "okafor",
    label: "J. Okafor's account",
    tier: "standard",
    capCents: 0,
    perCustomer: false,
    fixedOwner: { id: "demo-j-okafor", label: "J. Okafor" },
    orders: [
      { id: "ORD-7001", item: "Carbon road bike", totalCents: 145_000, placedDaysAgo: 4, storeId: "downtown" },
    ],
  },
];

export function accountDef(key: AccountKey): AccountDef {
  return ACCOUNTS.find((a) => a.key === key)!;
}

/** The Permify `account` id for an account as seen by one customer. */
export function accountEntityId(key: AccountKey, customerId: string): string {
  return accountDef(key).perCustomer ? `${key}.${customerId}` : key;
}

/** Inverse of accountEntityId, for labelling whatever Permify said the order belongs to. */
export function accountFromEntityId(entityId: string): AccountDef | undefined {
  const key = entityId.split(".")[0];
  return ACCOUNTS.find((a) => a.key === key);
}

/**
 * The Permify `order` id for the order id a customer typed. Per-customer orders are
 * namespaced with the customer id; shared orders aren't. An id that matches nothing
 * maps to itself — Permify has no relation for it, so the check simply denies.
 *
 * This is naming, not authorization: the decision of which account the order belongs
 * to, and whether this customer relates to that account, is Permify's.
 */
export function orderEntityId(customerId: string, orderId: string): string {
  const wanted = normalize(orderId);
  const perCustomer = ACCOUNTS.some(
    (a) => a.perCustomer && a.orders.some((o) => o.id === wanted)
  );
  return perCustomer ? `${wanted}.${customerId}` : wanted;
}

function normalize(orderId: string): string {
  return orderId.trim().toUpperCase();
}

// ---------------------------------------------------------------------------
// The in-memory books
// ---------------------------------------------------------------------------

const globalStore = globalThis as unknown as {
  __refundBotOrders?: Map<string, Order[]>;
  __refundBotSharedOrders?: Order[];
  __refundBotBudget?: { remainingCents: number };
};

function books(): Map<string, Order[]> {
  if (!globalStore.__refundBotOrders) globalStore.__refundBotOrders = new Map();
  return globalStore.__refundBotOrders;
}

function seedOrders(filter: (a: AccountDef) => boolean): Order[] {
  return ACCOUNTS.filter(filter).flatMap((a) =>
    a.orders.map((o) => ({ ...o, accountKey: a.key, refunded: false }))
  );
}

function sharedOrders(): Order[] {
  if (!globalStore.__refundBotSharedOrders) {
    globalStore.__refundBotSharedOrders = seedOrders((a) => !a.perCustomer);
  }
  return globalStore.__refundBotSharedOrders;
}

/** The customer's OWN orders (personal + business), seeded on first access. */
export function ordersForCustomer(customerId: string): Order[] {
  const store = books();
  let orders = store.get(customerId);
  if (!orders) {
    orders = seedOrders((a) => a.perCustomer);
    store.set(customerId, orders);
  }
  return orders;
}

/**
 * Any order in the catalog by id — the customer's own clones first, then the shared
 * accounts. Deliberately NOT ownership-filtered (see the file comment).
 */
export function findOrder(customerId: string, orderId: string): Order | undefined {
  const wanted = normalize(orderId);
  return (
    ordersForCustomer(customerId).find((o) => o.id === wanted) ??
    sharedOrders().find((o) => o.id === wanted)
  );
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
// Customer history (hop 2) — informational only
// ---------------------------------------------------------------------------

export interface CustomerHistory {
  lifetimeSpendCents: number;
  orderCount: number;
  priorRefunds: number;
}

/**
 * What customer-scoring-service reports. It used to feed a value-score formula that set
 * the escalation threshold; that decision now belongs to the account's trust tier and
 * cap in FusionAuth FGA (`account#auto_approve`), so this is context for the trace only.
 */
export function customerHistory(customerId: string): CustomerHistory {
  const orders = ordersForCustomer(customerId);
  return {
    lifetimeSpendCents: orders.reduce((n, o) => n + o.totalCents, 0),
    orderCount: orders.length,
    priorRefunds: orders.filter((o) => o.refunded).length,
  };
}

// ---------------------------------------------------------------------------
// Refund budget + the standard self-service floor (hop 3)
// ---------------------------------------------------------------------------

/**
 * The standard-tier self-service floor. Default $100. At or under it, the customer's own
 * out-of-band confirmation is enough; above it, a support employee is looped in UNLESS
 * Permify says `account#auto_approve` (a trusted account under its cap).
 */
export function selfServiceFloorCents(): number {
  const raw = Number(process.env.REFUND_APPROVAL_FLOOR_CENTS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 10_000;
}

const DAILY_BUDGET_CENTS = 300_000;

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
 * template with nothing refunded. A full reset also restores the shared accounts' orders
 * and refills the refund budget. Returns how many order books were cleared. Permify
 * relations are untouched: they describe ownership, which a reset doesn't change.
 */
export function resetRefundData(customerId?: string): number {
  const store = books();
  let cleared: number;
  if (customerId) {
    cleared = store.delete(customerId) ? 1 : 0;
  } else {
    cleared = store.size;
    store.clear();
    globalStore.__refundBotSharedOrders = undefined;
    budget().remainingCents = DAILY_BUDGET_CENTS;
  }
  return cleared;
}
