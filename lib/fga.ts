import {
  ACCOUNTS,
  REGIONS,
  STORES,
  accountDef,
  accountEntityId,
  accountFromEntityId,
  orderEntityId,
  regionDef,
  storeDef,
} from "@/lib/refund-data";
import { isAdmin, hasRole, ROLE_MANAGER } from "@/lib/roles";
import type {
  ApproverDecision,
  FgaCheckView,
  FgaMode,
  OwnershipDecision,
  TierDecision,
} from "@/lib/fga-types";
import { formatUsd } from "@/lib/refund-types";

export type { FgaMode } from "@/lib/fga-types";

/**
 * FusionAuth FGA — every call for RefundBot's relationship + attribute layer
 * lives in this one file, deliberately far from lib/entities.ts.
 *
 * Vocabulary: a Permify "entity" (`account`, `order`, `store`, `region`) is a node in the
 * FGA schema. It is NOT a FusionAuth Entity (the orchestrator and the four service
 * audiences that Token Exchange works with). The two systems share no code, no ids, and
 * no fields; each answers a different question:
 *
 *   - Token Exchange (lib/token-exchange.ts, lib/entities.ts): may the ORCHESTRATOR get a
 *     token for THIS SERVICE, acting for this customer?
 *   - FusionAuth FGA (this file): may THIS PERSON act on THIS RESOURCE — refund this
 *     order, skip review on this account, approve this store's refund at this amount?
 *
 * Three questions are asked here:
 *   1. `order#request_refund`    — ownership, before hop 1 (lib/refund-pipeline.ts)
 *   2. `store#approve_local`, then `region#approve_escalated` — the approval cascade
 *      (app/api/support/approvals/route.ts)
 *   3. `account#auto_approve`    — the customer's trust tier + cap, at the escalation
 *      decision (lib/refund-pipeline.ts)
 *
 * Talking to Permify: its REST API (port 3476), verified against Permify v1.x:
 *   POST /v1/tenants/{tenant}/schemas/write              — load the schema
 *   POST /v1/tenants/{tenant}/data/write                 — tuples + attributes
 *   POST /v1/tenants/{tenant}/data/delete                — delete tuples (/admin)
 *   POST /v1/tenants/{tenant}/data/relationships/read    — read tuples
 *   POST /v1/tenants/{tenant}/data/attributes/read       — read attributes
 *   POST /v1/tenants/{tenant}/permissions/check          — the check, with context.data
 * Attribute values are typed Any messages: `type.googleapis.com/base.v1.StringValue` /
 * `…/base.v1.IntegerValue`, each carrying `data` (an Int32Value is rejected as a type
 * mismatch for an `integer` attribute).
 *
 * Running Permify needs no FusionAuth plan at all — it's open source and self-hostable.
 * Unlike Token Exchange, nothing here is gated on Enterprise.
 *
 * Fallback, the portfolio's honest-degrade convention: when no Permify server answers,
 * every function below resolves against an in-memory tuple + attribute store with a
 * hand-written resolver (`demoCheck`) that mirrors permify/schema.perm, and the UI says
 * so (components/FgaModeBanner.tsx). Same behaviors, different engine underneath.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const permifyConfig = {
  /** Permify REST base URL. Default is the open-source server's REST port. */
  get baseUrl() {
    return (process.env.PERMIFY_URL || "http://localhost:3476").replace(/\/$/, "");
  },
  /** Tenant id. Permify ships a pre-inserted `t1` for single-tenant use. */
  get tenant() {
    return process.env.PERMIFY_TENANT || "t1";
  },
  /** Preshared key — must match PERMIFY_AUTHN_PRESHARED_KEYS on the server. */
  get token() {
    return process.env.PERMIFY_TOKEN || "";
  },
  /** Network timeout — a demo shouldn't hang a chat turn when Permify is down. */
  get timeoutMs() {
    return Number(process.env.PERMIFY_TIMEOUT_MS) || 2500;
  },
};

// Schema names, written once so a typo can't drift between the schema and the calls.
// These MUST match permify/schema.perm.
export const ENTITY = {
  user: "user",
  account: "account",
  order: "order",
  store: "store",
  region: "region",
} as const;

export const RELATION = {
  owner: "owner",
  delegate: "delegate",
  account: "account",
  region: "region",
  manager: "manager",
  director: "director",
} as const;

export const ATTRIBUTE = { tier: "tier", capCents: "cap_cents" } as const;

export const PERMISSION = {
  requestRefund: "request_refund",
  autoApprove: "auto_approve",
  approveLocal: "approve_local",
  approveEscalated: "approve_escalated",
} as const;

/** How long to answer from the fallback after a failure before trying Permify again. */
const BOOT_RETRY_MS = 30_000;

/** The `context.data` key the `can_approve_amount` rule reads. */
const AMOUNT_KEY = "refund_amount_cents";

interface EntityRef {
  type: string;
  id: string;
}
interface SubjectRef {
  type: string;
  id: string;
  relation?: string;
}
export interface RelationTuple {
  entity: EntityRef;
  relation: string;
  subject: SubjectRef;
}
export interface AttributeValue {
  entity: EntityRef;
  attribute: string;
  value: string | number;
}

// ---------------------------------------------------------------------------
// The schema — the same declarations as permify/schema.perm, which carries the
// long-form comments. Change one, change both, AND `demoCheck` below.
//
// Two details verified against a running Permify server rather than assumed:
//   - string literals inside a rule must be SINGLE-quoted ('trusted'); a double-quoted
//     literal is stripped by the schema lexer and the rule fails to compile;
//   - a JSON number in `context.data` compares cleanly against an `integer` attribute.
// ---------------------------------------------------------------------------

export const REFUND_SCHEMA = `entity user {}

entity account {
  relation owner @user
  relation delegate @user

  attribute tier string
  attribute cap_cents integer

  action request_refund = owner or delegate
  action auto_approve = request_refund and tier_is_trusted(tier) and can_approve_amount(cap_cents)
}

entity order {
  relation account @account

  action request_refund = account.request_refund
}

entity region {
  relation director @user

  attribute cap_cents integer

  action approve_escalated = director and can_approve_amount(cap_cents)
}

entity store {
  relation region @region
  relation manager @user

  attribute cap_cents integer

  action approve_local = manager and can_approve_amount(cap_cents)
}

rule tier_is_trusted(tier string) {
  tier == 'trusted'
}

rule can_approve_amount(cap_cents integer) {
  context.data.refund_amount_cents <= cap_cents
}
`;

// ---------------------------------------------------------------------------
// Mode tracking — "live" vs "demo". Pages read this for the banner.
// ---------------------------------------------------------------------------

const g = globalThis as unknown as {
  __refundBotFgaMode?: FgaMode;
  __refundBotFgaBootstrapped?: boolean;
  __refundBotFgaDownUntil?: number;
  __refundBotFgaSeededCustomers?: Set<string>;
  __refundBotFgaSeededEmployees?: Set<string>;
  __refundBotFgaNames?: Map<string, string>;
  __refundBotFgaLogged?: Set<string>;
  __refundBotFgaTuples?: Set<string>;
  __refundBotFgaAttributes?: Map<string, string | number>;
};

function markMode(mode: FgaMode) {
  g.__refundBotFgaMode = mode;
}

/** The mode the LAST FGA operation resolved in. "demo" until something has run. */
export function lastFgaMode(): FgaMode {
  return g.__refundBotFgaMode ?? "demo";
}

// ---------------------------------------------------------------------------
// Low-level REST client
// ---------------------------------------------------------------------------

function endpoint(path: string): string {
  return `${permifyConfig.baseUrl}/v1/tenants/${permifyConfig.tenant}/${path}`;
}

/** POSTs to a Permify endpoint. Throws on network failure, timeout, or non-2xx. */
async function permifyPost<T>(path: string, body: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), permifyConfig.timeoutMs);
  try {
    const res = await fetch(endpoint(path), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(permifyConfig.token ? { Authorization: `Bearer ${permifyConfig.token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Permify ${path} -> ${res.status} ${text}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs a live Permify operation, falling back to the in-memory implementation when the
 * server can't be reached (or rejects the call). Records which path was taken so the UI
 * can be honest. A live failure also forgets the bootstrap, so a Permify that restarted
 * with an empty in-memory store gets its schema and seed data back on the next call
 * instead of leaving the app stuck in fallback.
 *
 * Every successful live write (and every relation read) is MIRRORED into the fallback
 * store, so if Permify drops out mid-demo the very next check is answered from the same
 * data rather than an empty store.
 */
async function withFallback<T>(live: () => Promise<T>, demo: () => T): Promise<T> {
  // Circuit breaker: after a failure, don't pay a network timeout on every check —
  // answer from the fallback until the retry window passes, then try live again.
  if ((g.__refundBotFgaDownUntil ?? 0) > Date.now()) {
    markMode("demo");
    return demo();
  }
  try {
    const value = await live();
    markMode("live");
    return value;
  } catch (err) {
    markMode("demo");
    logFallbackOnce(err);
    g.__refundBotFgaDownUntil = Date.now() + BOOT_RETRY_MS;
    g.__refundBotFgaBootstrapped = false;
    g.__refundBotFgaSeededCustomers?.clear();
    g.__refundBotFgaSeededEmployees?.clear();
    return demo();
  }
}

function logFallbackOnce(err: unknown) {
  const e = err as { message?: string; cause?: { code?: string; message?: string } };
  const reason = [e?.message, e?.cause?.code ?? e?.cause?.message].filter(Boolean).join(" — ");
  const seen = (g.__refundBotFgaLogged ??= new Set());
  if (seen.has(reason)) return;
  seen.add(reason);
  console.warn(
    `[fga] Permify at ${permifyConfig.baseUrl} unavailable, using the in-memory fallback: ${reason}`
  );
}

// ---------------------------------------------------------------------------
// In-memory fallback store + resolver
// ---------------------------------------------------------------------------

function demoTuples(): Set<string> {
  return (g.__refundBotFgaTuples ??= new Set());
}
function demoAttributes(): Map<string, string | number> {
  return (g.__refundBotFgaAttributes ??= new Map());
}

function tupleKey(t: RelationTuple): string {
  return `${t.entity.type}:${t.entity.id}#${t.relation}@${t.subject.type}:${t.subject.id}`;
}
function attrKey(type: string, id: string, attribute: string): string {
  return `${type}:${id}$${attribute}`;
}

function demoWrite(tuples: RelationTuple[], attributes: AttributeValue[]) {
  for (const t of tuples) demoTuples().add(tupleKey(t));
  for (const a of attributes) {
    demoAttributes().set(attrKey(a.entity.type, a.entity.id, a.attribute), a.value);
  }
}

function demoHas(type: string, id: string, relation: string, subjectType: string, subjectId: string) {
  return demoTuples().has(`${type}:${id}#${relation}@${subjectType}:${subjectId}`);
}

function demoReadRelation(type: string, id: string, relation: string): string[] {
  const prefix = `${type}:${id}#${relation}@`;
  const out: string[] = [];
  for (const key of demoTuples()) {
    if (key.startsWith(prefix)) out.push(key.slice(prefix.length).split(":").slice(1).join(":"));
  }
  return out;
}

function demoAttr(type: string, id: string, attribute: string): string | number | undefined {
  return demoAttributes().get(attrKey(type, id, attribute));
}

/**
 * The hand-written resolver — what Permify replaces. Mirrors permify/schema.perm rule
 * for rule; only ever runs in fallback mode. Keep it in step with the schema or the
 * fallback will lie.
 */
function demoCheck(
  type: string,
  id: string,
  permission: string,
  userId: string,
  context: Record<string, number>
): boolean {
  const u = ENTITY.user;
  const amount = context[AMOUNT_KEY];
  const withinCap = (cap: unknown) =>
    typeof amount === "number" && typeof cap === "number" && amount <= cap;

  if (type === ENTITY.account) {
    const owner = demoHas(type, id, RELATION.owner, u, userId);
    const delegate = demoHas(type, id, RELATION.delegate, u, userId);
    if (permission === RELATION.owner) return owner;
    if (permission === RELATION.delegate) return delegate;
    if (permission === PERMISSION.requestRefund) return owner || delegate;
    if (permission === PERMISSION.autoApprove) {
      return (
        (owner || delegate) &&
        demoAttr(type, id, ATTRIBUTE.tier) === "trusted" &&
        withinCap(demoAttr(type, id, ATTRIBUTE.capCents))
      );
    }
    return false;
  }
  if (type === ENTITY.order) {
    if (permission !== PERMISSION.requestRefund) return false;
    return demoReadRelation(type, id, RELATION.account).some((accountId) =>
      demoCheck(ENTITY.account, accountId, PERMISSION.requestRefund, userId, context)
    );
  }
  if (type === ENTITY.region) {
    const director = demoHas(type, id, RELATION.director, u, userId);
    if (permission === RELATION.director) return director;
    if (permission === PERMISSION.approveEscalated) {
      return director && withinCap(demoAttr(type, id, ATTRIBUTE.capCents));
    }
    return false;
  }
  if (type === ENTITY.store) {
    const manager = demoHas(type, id, RELATION.manager, u, userId);
    if (permission === RELATION.manager) return manager;
    if (permission === PERMISSION.approveLocal) {
      return manager && withinCap(demoAttr(type, id, ATTRIBUTE.capCents));
    }
    return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Primitive operations — live + fallback
// ---------------------------------------------------------------------------

function encodeValue(value: string | number) {
  return typeof value === "number"
    ? { "@type": "type.googleapis.com/base.v1.IntegerValue", data: value }
    : { "@type": "type.googleapis.com/base.v1.StringValue", data: value };
}

/** Writes relation tuples and attribute values in one call. Idempotent. */
export async function writeData(
  tuples: RelationTuple[],
  attributes: AttributeValue[] = []
): Promise<void> {
  if (tuples.length === 0 && attributes.length === 0) return;
  await withFallback(
    async () => {
      await permifyPost("data/write", {
        metadata: { schema_version: "" },
        tuples,
        attributes: attributes.map((a) => ({
          entity: a.entity,
          attribute: a.attribute,
          value: encodeValue(a.value),
        })),
      });
      demoWrite(tuples, attributes); // mirror
    },
    () => demoWrite(tuples, attributes)
  );
}

/**
 * Deletes one relation tuple. Permify's DataDelete REQUIRES `attribute_filter` even when
 * only tuples are being deleted — omit it and the server answers 400, which the fallback
 * would otherwise silently swallow.
 */
export async function deleteTuple(tuple: RelationTuple): Promise<void> {
  await withFallback(
    async () => {
      await permifyPost("data/delete", {
        tuple_filter: {
          entity: { type: tuple.entity.type, ids: [tuple.entity.id] },
          relation: tuple.relation,
          subject: { type: tuple.subject.type, ids: [tuple.subject.id], relation: "" },
        },
        attribute_filter: {
          entity: { type: tuple.entity.type, ids: [tuple.entity.id] },
          attributes: [],
        },
      });
      demoTuples().delete(tupleKey(tuple)); // mirror
    },
    () => {
      demoTuples().delete(tupleKey(tuple));
    }
  );
}

/**
 * The permission check. `permission` may be an action or a bare relation (Permify
 * answers both). `context` becomes `context.data`, which the `can_approve_amount` rule
 * reads.
 */
export async function check(
  entity: EntityRef,
  permission: string,
  userId: string,
  context: Record<string, number> = {}
): Promise<boolean> {
  if (!userId) return false;
  return withFallback(
    async () => {
      const res = await permifyPost<{ can?: string }>("permissions/check", {
        metadata: { snap_token: "", schema_version: "", depth: 20 },
        entity,
        permission,
        subject: { type: ENTITY.user, id: userId },
        context: { tuples: [], attributes: [], data: context },
      });
      // v1.x answers "CHECK_RESULT_ALLOWED" / "CHECK_RESULT_DENIED".
      return (res.can ?? "") === "CHECK_RESULT_ALLOWED";
    },
    () => demoCheck(entity.type, entity.id, permission, userId, context)
  );
}

/** The subject ids holding one relation on one entity (`subjectType` filters the type). */
export async function readRelation(
  entityType: string,
  entityId: string,
  relation: string,
  subjectType: string = ENTITY.user
): Promise<string[]> {
  return withFallback(
    async () => {
      const res = await permifyPost<{ tuples?: { subject?: SubjectRef }[] }>(
        "data/relationships/read",
        {
          metadata: { snap_token: "" },
          filter: {
            entity: { type: entityType, ids: [entityId] },
            relation,
            subject: { type: subjectType, ids: [], relation: "" },
          },
        }
      );
      const ids = (res.tuples ?? []).map((t) => t.subject?.id ?? "").filter(Boolean);
      // Mirror what Permify holds (it may predate this process) into the fallback.
      demoWrite(
        ids.map((id) => ({
          entity: { type: entityType, id: entityId },
          relation,
          subject: { type: subjectType, id },
        })),
        []
      );
      return ids;
    },
    () => demoReadRelation(entityType, entityId, relation)
  );
}

/** One entity's attribute values, decoded. */
export async function readAttributes(
  entityType: string,
  entityId: string
): Promise<Record<string, string | number>> {
  return withFallback(
    async () => {
      const res = await permifyPost<{
        attributes?: { attribute?: string; value?: { data?: string | number } }[];
      }>("data/attributes/read", {
        metadata: { snap_token: "" },
        filter: { entity: { type: entityType, ids: [entityId] }, attributes: [] },
      });
      const out: Record<string, string | number> = {};
      for (const a of res.attributes ?? []) {
        if (a.attribute && a.value?.data !== undefined) out[a.attribute] = a.value.data;
      }
      return out;
    },
    () => {
      const out: Record<string, string | number> = {};
      for (const name of Object.values(ATTRIBUTE)) {
        const v = demoAttr(entityType, entityId, name);
        if (v !== undefined) out[name] = v;
      }
      return out;
    }
  );
}

async function recorded(
  type: string,
  id: string,
  permission: string,
  userId: string,
  context?: Record<string, number>
): Promise<FgaCheckView> {
  const allowed = await check({ type, id }, permission, userId, context);
  return { entity: `${type}:${id}`, permission, subject: `user:${userId}`, context, allowed };
}

// ---------------------------------------------------------------------------
// Bootstrap — schema + the catalog-derived structure, once per (live) process
// ---------------------------------------------------------------------------

const userTuple = (type: string, id: string, relation: string, userId: string): RelationTuple => ({
  entity: { type, id },
  relation,
  subject: { type: ENTITY.user, id: userId },
});

/**
 * Everything that doesn't depend on who is signed in: the region and its cap, each
 * store's region and cap, and the shared accounts with their fixed owners, tiers, caps,
 * and orders. Derived from lib/refund-data.ts — add a store or an order there, not here.
 */
function structuralData(): { tuples: RelationTuple[]; attributes: AttributeValue[] } {
  const tuples: RelationTuple[] = [];
  const attributes: AttributeValue[] = [];
  for (const r of REGIONS) {
    attributes.push({ entity: { type: ENTITY.region, id: r.id }, attribute: ATTRIBUTE.capCents, value: r.capCents });
  }
  for (const s of STORES) {
    tuples.push({
      entity: { type: ENTITY.store, id: s.id },
      relation: RELATION.region,
      subject: { type: ENTITY.region, id: s.regionId },
    });
    attributes.push({ entity: { type: ENTITY.store, id: s.id }, attribute: ATTRIBUTE.capCents, value: s.capCents });
  }
  for (const a of ACCOUNTS.filter((x) => !x.perCustomer)) {
    tuples.push(...accountData(a.key, "").tuples);
    attributes.push(...accountData(a.key, "").attributes);
  }
  return { tuples, attributes };
}

/** One account's tier + cap attributes, fixed owner, and order → account tuples. */
function accountData(key: (typeof ACCOUNTS)[number]["key"], customerId: string) {
  const def = accountDef(key);
  const id = accountEntityId(key, customerId);
  const tuples: RelationTuple[] = def.orders.map((o) => ({
    entity: { type: ENTITY.order, id: orderEntityId(customerId, o.id) },
    relation: RELATION.account,
    subject: { type: ENTITY.account, id },
  }));
  if (def.fixedOwner) tuples.push(userTuple(ENTITY.account, id, RELATION.owner, def.fixedOwner.id));
  const attributes: AttributeValue[] = [
    { entity: { type: ENTITY.account, id }, attribute: ATTRIBUTE.tier, value: def.tier },
    { entity: { type: ENTITY.account, id }, attribute: ATTRIBUTE.capCents, value: def.capCents },
  ];
  return { tuples, attributes };
}

/**
 * Loads the schema and writes the structural data. Memoized only once Permify has
 * ACCEPTED both; otherwise the fallback store is seeded and a live attempt is retried
 * after BOOT_RETRY_MS — so the app goes live by itself once Permify comes up.
 *
 * Note the per-customer and per-employee "seeded" sets are cleared on any live failure,
 * so after Permify comes back (possibly empty, if it runs on its in-memory database)
 * they are re-written there too.
 */
async function bootstrap(): Promise<void> {
  if (g.__refundBotFgaBootstrapped) return;

  const schemaLive = await withFallback(
    async () => {
      await permifyPost("schemas/write", { schema: REFUND_SCHEMA });
      return true;
    },
    () => false
  );
  const { tuples, attributes } = structuralData();
  await writeData(tuples, attributes);

  // Only a live bootstrap is memoized. In fallback, the (idempotent) structural write
  // above seeded the in-memory store, and the circuit breaker in withFallback decides
  // when to try Permify again.
  if (schemaLive && lastFgaMode() === "live") g.__refundBotFgaBootstrapped = true;
}

/** Schema + structure only, no per-user seeding. Returns the resolved mode. */
export async function ensureFgaBootstrap(): Promise<FgaMode> {
  await bootstrap();
  return lastFgaMode();
}

function demoSeedEnabled(): boolean {
  const raw = (process.env.INFUSIONAGENT_SEED_DEMO ?? "true").toLowerCase();
  return raw !== "false" && raw !== "0" && raw !== "off" && raw !== "no";
}

/**
 * A signed-in customer's relations: `owner` of their own personal and business accounts
 * (with those accounts' orders, tier, and cap), and — the demo's shared/family case —
 * `delegate` on the Rivera household account.
 *
 * The per-customer accounts are derived structure and are re-written idempotently once
 * per process. The household `delegate` is a demo choice and is written only for a
 * customer Permify has never seen (no `owner` on their personal account yet), so a
 * delegate relation revoked in /admin stays revoked.
 */
export async function syncCustomerFga(customerId: string): Promise<FgaMode> {
  await bootstrap();
  const seeded = (g.__refundBotFgaSeededCustomers ??= new Set());
  if (seeded.has(customerId)) return lastFgaMode();

  const personal = accountEntityId("personal", customerId);
  const known = (await readRelation(ENTITY.account, personal, RELATION.owner)).includes(customerId);
  const tuples: RelationTuple[] = [];
  const attributes: AttributeValue[] = [];
  for (const a of ACCOUNTS) {
    if (a.perCustomer) {
      const data = accountData(a.key, customerId);
      tuples.push(...data.tuples);
      attributes.push(...data.attributes);
      if (a.customerRelation) {
        tuples.push(userTuple(ENTITY.account, accountEntityId(a.key, customerId), a.customerRelation, customerId));
      }
    } else if (a.customerRelation && !known && demoSeedEnabled()) {
      tuples.push(userTuple(ENTITY.account, accountEntityId(a.key, customerId), a.customerRelation, customerId));
    }
  }
  await writeData(tuples, attributes);
  seeded.add(customerId);
  return lastFgaMode();
}

/** Display names for employee ids we've seen, so a suggestion can name a person. */
function names(): Map<string, string> {
  return (g.__refundBotFgaNames ??= new Map());
}

/** The default store/region relation for a support employee, chosen from their role. */
export function seedRelationFor(roles: string[]): { type: string; id: string; relation: string } {
  if (isAdmin(roles)) return { type: ENTITY.region, id: "west", relation: RELATION.director };
  if (hasRole(roles, ROLE_MANAGER)) {
    return { type: ENTITY.store, id: "downtown", relation: RELATION.manager };
  }
  return { type: ENTITY.store, id: "harbor", relation: RELATION.manager };
}

/** Every store-manager / region-director slot, for "does this employee hold anything?" */
async function employeeRelations(userId: string): Promise<string[]> {
  const slots = [
    ...STORES.map((s) => ({ type: ENTITY.store, id: s.id, relation: RELATION.manager })),
    ...REGIONS.map((r) => ({ type: ENTITY.region, id: r.id, relation: RELATION.director })),
  ];
  const held = await Promise.all(
    slots.map(async (s) =>
      (await readRelation(s.type, s.id, s.relation)).includes(userId)
        ? `${s.type}:${s.id}#${s.relation}`
        : ""
    )
  );
  return held.filter(Boolean);
}

/**
 * A support employee's store/region relation, seeded from their Application Role the
 * first time they open the console (admin → West region director; manager → Downtown
 * store manager; employee / it-admin → Harbor store manager). Seeds only an employee who
 * holds NO store or region relation yet, so anything set by hand in /admin sticks.
 * Disable with INFUSIONAGENT_SEED_DEMO=false. Returns the relations they now hold.
 */
export async function syncEmployeeFga(
  userId: string,
  name: string,
  roles: string[]
): Promise<{ mode: FgaMode; relations: string[] }> {
  await bootstrap();
  names().set(userId, name);
  let relations = await employeeRelations(userId);
  const seeded = (g.__refundBotFgaSeededEmployees ??= new Set());
  if (relations.length === 0 && !seeded.has(userId) && demoSeedEnabled()) {
    const r = seedRelationFor(roles);
    await writeData([userTuple(r.type, r.id, r.relation, userId)]);
    relations = [`${r.type}:${r.id}#${r.relation}`];
  }
  seeded.add(userId);
  return { mode: lastFgaMode(), relations };
}

// ---------------------------------------------------------------------------
// Feature 1 — order ownership
// ---------------------------------------------------------------------------

/**
 * `order:<id>#request_refund` for the customer. Runs BEFORE hop 1: on a denial the
 * pipeline stops and no token is ever exchanged. When allowed, two direct relation
 * checks on the order's account say which relation justified it.
 */
export async function checkOrderOwnership(
  customerId: string,
  orderId: string
): Promise<OwnershipDecision> {
  await syncCustomerFga(customerId);
  const orderEntity = orderEntityId(customerId, orderId);
  const main = await recorded(ENTITY.order, orderEntity, PERMISSION.requestRefund, customerId);
  const [accountId] = await readRelation(ENTITY.order, orderEntity, RELATION.account, ENTITY.account);
  const account = accountId ? accountFromEntityId(accountId) : undefined;
  const checks = [main];

  let via: OwnershipDecision["via"];
  if (accountId) {
    const owner = await recorded(ENTITY.account, accountId, RELATION.owner, customerId);
    checks.push(owner);
    if (owner.allowed) via = "owner";
    else {
      const delegate = await recorded(ENTITY.account, accountId, RELATION.delegate, customerId);
      checks.push(delegate);
      if (delegate.allowed) via = "delegate";
    }
  }

  const reason = main.allowed
    ? `Allowed via \`${via ?? "?"}\` on ${account?.label ?? accountId}.`
    : accountId
      ? `Denied — the order belongs to ${account?.label ?? accountId}, and this customer holds no \`owner\` or \`delegate\` relation on it.`
      : `Denied — Permify has no \`order:${orderEntity}\` with an \`account\` relation, so there is nothing this customer could own.`;

  return {
    allowed: main.allowed,
    orderEntity: `order:${orderEntity}`,
    accountEntity: accountId ? `account:${accountId}` : undefined,
    accountLabel: account?.label,
    via: main.allowed ? via : undefined,
    checks,
    reason,
  };
}

// ---------------------------------------------------------------------------
// Feature 3 — the customer's trust tier + cap
// ---------------------------------------------------------------------------

/**
 * `account#auto_approve` with the refund amount in context. Passing means no employee is
 * looped in — the customer's out-of-band MFA confirmation is still mandatory.
 */
export async function checkAutoApprove(
  customerId: string,
  accountEntity: string,
  amountCents: number
): Promise<TierDecision> {
  const accountId = accountEntity.replace(/^account:/, "");
  const context = { [AMOUNT_KEY]: amountCents };
  const attrs = await readAttributes(ENTITY.account, accountId);
  const main = await recorded(ENTITY.account, accountId, PERMISSION.autoApprove, customerId, context);
  const tier = String(attrs[ATTRIBUTE.tier] ?? "unknown");
  const capCents = Number(attrs[ATTRIBUTE.capCents] ?? 0);
  const label = accountFromEntityId(accountId)?.label ?? accountId;

  const reason = main.allowed
    ? `\`${tier}\` tier and ${formatUsd(amountCents)} ≤ the ${formatUsd(capCents)} cap — no employee review.`
    : tier !== "trusted"
      ? `\`${tier}\` tier — auto-approval needs \`trusted\`. Falls through to the standard path.`
      : `${formatUsd(amountCents)} is over the account's ${formatUsd(capCents)} cap. Falls through to the standard path.`;

  return {
    accountEntity: `account:${accountId}`,
    accountLabel: label,
    tier,
    capCents,
    amountCents,
    autoApprove: main.allowed,
    checks: [main],
    reason,
  };
}

// ---------------------------------------------------------------------------
// Feature 2 — the approval cascade
// ---------------------------------------------------------------------------

/**
 * May this employee decide an escalated refund for an order from `storeId`? First
 * `store#approve_local` (their own store, under the store's cap); if not,
 * `region#approve_escalated` (the store's region, under the region's cap). Two separate
 * single-entity checks, each a relation plus a rule over that entity's own attribute.
 * On a denial, direct relation checks explain WHY: wrong store vs. over the cap.
 */
export async function checkApprover(input: {
  employeeId: string;
  employeeName: string;
  storeId: string;
  amountCents: number;
  decision: "approve" | "deny";
}): Promise<ApproverDecision> {
  await bootstrap();
  names().set(input.employeeId, input.employeeName);
  const store = storeDef(input.storeId) ?? STORES[0];
  const region = regionDef(store.regionId) ?? REGIONS[0];
  const context = { [AMOUNT_KEY]: input.amountCents };
  const amount = formatUsd(input.amountCents);
  const base = {
    employeeId: input.employeeId,
    employeeName: input.employeeName,
    decision: input.decision,
    at: new Date().toISOString(),
    store: { id: store.id, label: store.label, capCents: store.capCents },
    region: { id: region.id, label: region.label, capCents: region.capCents },
  };

  const local = await recorded(ENTITY.store, store.id, PERMISSION.approveLocal, input.employeeId, context);
  if (local.allowed) {
    return {
      ...base,
      allowed: true,
      path: "approve_local",
      checks: [local],
      reason: `${store.label} manager, ${amount} ≤ the ${formatUsd(store.capCents)} store cap.`,
    };
  }
  const isManager = await recorded(ENTITY.store, store.id, RELATION.manager, input.employeeId);
  const localReason = isManager.allowed ? "over_store_cap" : "not_store_manager";

  const escalated = await recorded(
    ENTITY.region, region.id, PERMISSION.approveEscalated, input.employeeId, context
  );
  if (escalated.allowed) {
    return {
      ...base,
      allowed: true,
      path: "approve_escalated",
      localReason,
      checks: [local, isManager, escalated],
      reason: `Inherited through ${region.label}: director, ${amount} ≤ the ${formatUsd(region.capCents)} region cap.`,
    };
  }
  const isDirector = await recorded(ENTITY.region, region.id, RELATION.director, input.employeeId);
  const regionReason = isDirector.allowed ? "over_region_cap" : "not_region_director";

  const directorIds = await readRelation(ENTITY.region, region.id, RELATION.director);
  const directors = directorIds.map((id) => names().get(id) ?? `user ${id.slice(0, 8)}…`);
  const directorText = directors.length
    ? `${region.label} director (${directors.join(", ")})`
    : `the ${region.label} director`;

  let reason: string;
  if (regionReason === "over_region_cap") {
    reason = `${amount} is over even the ${formatUsd(region.capCents)} region cap — nobody in this cascade can approve it.`;
  } else if (localReason === "over_store_cap") {
    reason = `${amount} is over the ${formatUsd(store.capCents)} ${store.label} cap — it needs ${directorText}.`;
  } else {
    reason = `Not this employee's store — no \`manager\` relation on ${store.label}, and no \`director\` relation on ${region.label}.`;
  }

  return {
    ...base,
    allowed: false,
    localReason,
    regionReason,
    checks: [local, isManager, escalated, isDirector],
    reason,
    suggestion:
      localReason === "not_store_manager" && regionReason === "not_region_director"
        ? `Escalate to ${directorText} — a region director can approve up to ${formatUsd(region.capCents)} for any ${region.label} store.`
        : undefined,
  };
}

// ---------------------------------------------------------------------------
// /admin — grant and revoke the user-subject relations
// ---------------------------------------------------------------------------

export type FgaEntityType = "store" | "region" | "account";

/** User-subject relations an admin may grant, per entity type. */
export const VALID_RELATIONS: Record<FgaEntityType, string[]> = {
  store: [RELATION.manager],
  region: [RELATION.director],
  account: [RELATION.owner, RELATION.delegate],
};

export interface FgaEntityOption {
  entityType: FgaEntityType;
  entityId: string;
  label: string;
  relations: string[];
}

/**
 * The entities /admin can grant on: every store, the region, and the shared accounts.
 * Per-customer accounts are left out on purpose — their `owner` is the customer, by
 * construction. Structural relations (`store#region`, `order#account`) point at other
 * Permify entities, not users, and aren't grantable here.
 */
export function fgaEntityOptions(): FgaEntityOption[] {
  return [
    ...REGIONS.map((r) => ({
      entityType: "region" as const,
      entityId: r.id,
      label: `${r.label} · cap ${formatUsd(r.capCents)}`,
      relations: VALID_RELATIONS.region,
    })),
    ...STORES.map((s) => ({
      entityType: "store" as const,
      entityId: s.id,
      label: `${s.label} · cap ${formatUsd(s.capCents)}`,
      relations: VALID_RELATIONS.store,
    })),
    ...ACCOUNTS.filter((a) => !a.perCustomer).map((a) => ({
      entityType: "account" as const,
      entityId: a.key,
      label: `${a.label} · ${a.tier}`,
      relations: VALID_RELATIONS.account,
    })),
  ];
}

export function isValidRelation(entityType: string, relation: string): entityType is FgaEntityType {
  return (
    (entityType === "store" || entityType === "region" || entityType === "account") &&
    VALID_RELATIONS[entityType].includes(relation)
  );
}

/** Display label for a grantable entity, or null when unknown (callers 400). */
export function entityLabel(entityType: string, entityId: string): string | null {
  return (
    fgaEntityOptions().find((o) => o.entityType === entityType && o.entityId === entityId)?.label ??
    null
  );
}

export async function assignRelation(
  entityType: FgaEntityType,
  entityId: string,
  relation: string,
  userId: string
): Promise<void> {
  await writeData([userTuple(entityType, entityId, relation, userId)]);
}

export async function unassignRelation(
  entityType: FgaEntityType,
  entityId: string,
  relation: string,
  userId: string
): Promise<void> {
  await deleteTuple(userTuple(entityType, entityId, relation, userId));
}

export interface EntityRelationships {
  entityType: FgaEntityType;
  entityId: string;
  label: string;
  rows: { relation: string; userIds: string[] }[];
}

/** Who holds what on every grantable entity, read from Permify (or the fallback). */
export async function relationshipTable(): Promise<EntityRelationships[]> {
  return Promise.all(
    fgaEntityOptions().map(async (o) => ({
      entityType: o.entityType,
      entityId: o.entityId,
      label: o.label,
      rows: await Promise.all(
        o.relations.map(async (relation) => ({
          relation,
          userIds: await readRelation(o.entityType, o.entityId, relation),
        }))
      ),
    }))
  );
}

/** Names for the fixed demo owners, so /admin can show them as people. */
export function fixedOwnerNames(): Map<string, string> {
  return new Map(
    ACCOUNTS.flatMap((a) => (a.fixedOwner ? [[a.fixedOwner.id, a.fixedOwner.label] as const] : []))
  );
}
