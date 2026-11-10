import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { mcpBaseUrl, mcpCallDeadlineMs, withDeadline } from "@/lib/agent";
import {
  describeFailure,
  exchangerForMode,
  type ExchangeResult,
} from "@/lib/token-exchange";
import {
  createBankingGrant,
  deleteBankingGrant,
  withBankingLock,
} from "@/lib/entities";
import {
  approvalsRefused,
  approvalsSatisfied,
  createRefundRecord,
  pushTrace,
  touch,
  type RefundRecord,
} from "@/lib/approvals";
import { audienceFor, serviceDef } from "@/lib/refund-services";
import { checkAutoApprove, checkOrderOwnership, lastFgaMode } from "@/lib/fga";
import { regionDef, storeDef } from "@/lib/refund-data";
import {
  formatUsd,
  type ExchangeHopEntry,
  type ExchangeMode,
  type GrantEvent,
  type RefundService,
  type RefundToolName,
  type TraceNoteEntry,
} from "@/lib/refund-types";

/**
 * The four-hop pipeline. For each hop the orchestrator:
 *
 *   1. exchanges the customer's ORIGINAL access token (never the previous hop's token —
 *      each exchange is independent, so the actor chain never nests and the Tenant's
 *      default Max act claim depth of 2 is plenty) for ONE service's audience;
 *   2. calls that service's MCP tool with the narrower token; and
 *   3. records the hop — audience, act, sub, sid, and FusionAuth's verdict verbatim.
 *
 * Hops 1–3 ride on standing Entity Grants. Hop 4 (banking-api) has none: before
 * approvals it is attempted once as a PROBE, so the trace shows FusionAuth itself
 * refusing; after both approvals, `executeBankingHop` creates the Grant, exchanges, calls,
 * and revokes the Grant — every time, in a `finally`.
 *
 * Two FusionAuth FGA checks bracket the hops — a separate, independent authorization
 * layer (lib/fga.ts) that never touches a token:
 *
 *   - BEFORE hop 1, `order#request_refund`: does the customer hold `owner` or `delegate`
 *     on the account this order belongs to? A denial stops here — no exchange is ever
 *     attempted and no service is touched.
 *   - AFTER hop 3, `account#auto_approve`: a `trusted` account under its cap skips the
 *     employee queue. The customer's out-of-band confirmation is required either way.
 *
 * The planner never reaches this file's decisions. The order id comes from the planner;
 * ownership, the amount, the escalation, and whether anything is refunded at all come
 * from Permify and from the services, through tokens FusionAuth agreed to issue.
 */

function now() {
  return new Date().toISOString();
}

function note(
  record: RefundRecord,
  layer: TraceNoteEntry["layer"],
  status: TraceNoteEntry["status"],
  label: string,
  detail?: string
) {
  pushTrace(record, { type: "note", layer, status, label, detail, at: now() });
}

// ---------------------------------------------------------------------------
// The MCP call — same Streamable HTTP transport and hard deadline as the agent
// ---------------------------------------------------------------------------

interface ToolCallResult {
  reached: boolean;
  ok: boolean;
  data?: Record<string, unknown>;
  code?: string;
  message?: string;
}

async function callRefundTool(
  tool: RefundToolName,
  args: Record<string, unknown>,
  token: string
): Promise<ToolCallResult> {
  const transport = new StreamableHTTPClientTransport(new URL(`${mcpBaseUrl()}/api/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "refundbot-orchestrator", version: "0.1.0" });
  const deadline = Date.now() + mcpCallDeadlineMs();
  const remaining = () => Math.max(1_000, deadline - Date.now());
  try {
    // connect() has no timeout of its own — a wedged handshake would hang the turn.
    await withDeadline(client.connect(transport), Math.min(10_000, remaining()), "MCP handshake");
    const res = await withDeadline(
      client.callTool({ name: tool, arguments: args }, { timeout: remaining() }),
      remaining(),
      `${tool} call`
    );
    const content = (res.content ?? []) as Array<{ type: string; text?: string }>;
    const text = content.find((b) => b.type === "text")?.text;
    let payload: {
      ok?: boolean;
      data?: Record<string, unknown>;
      error?: string;
      code?: string;
      message?: string;
    };
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { ok: false, message: text };
    }
    if (res.isError || payload.ok === false) {
      return {
        reached: true,
        ok: false,
        code: payload.code ?? payload.error,
        message: payload.message ?? "The service refused.",
      };
    }
    return { reached: true, ok: true, data: payload.data };
  } catch (err) {
    return {
      reached: false,
      ok: false,
      code: "unreachable",
      message:
        err instanceof Error
          ? `MCP server rejected the request: ${err.message}`
          : "Could not reach the MCP server.",
    };
  } finally {
    try {
      await withDeadline(client.close(), 3_000, "MCP close");
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// One hop
// ---------------------------------------------------------------------------

function hopFromExchange(
  service: RefundService,
  grantKind: ExchangeHopEntry["grantKind"],
  ex: ExchangeResult
): ExchangeHopEntry {
  const def = serviceDef(service);
  const claims = ex.claims ?? {};
  const act =
    claims.act && typeof claims.act === "object"
      ? (claims.act as Record<string, unknown>)
      : undefined;
  const aud = Array.isArray(claims.aud)
    ? (claims.aud as string[])
    : typeof claims.aud === "string"
      ? [claims.aud]
      : undefined;
  return {
    type: "hop",
    hop: def.hop,
    service,
    serviceLabel: def.label,
    tool: def.tool,
    grantKind,
    audience: audienceFor(service),
    exchange: ex.ok ? "allowed" : "denied",
    reason: ex.failure ? describeFailure(ex.failure) : undefined,
    outcome: ex.failure?.outcome,
    act: typeof act?.sub === "string" ? act.sub : undefined,
    actProfile: typeof act?.sub_profile === "string" ? act.sub_profile : undefined,
    sub: typeof claims.sub === "string" ? claims.sub : undefined,
    sid: typeof claims.sid === "string" ? claims.sid : undefined,
    jti: typeof claims.jti === "string" ? claims.jti : undefined,
    aud,
    approvedByClaim:
      typeof claims.approved_by === "string" ? claims.approved_by : undefined,
    at: now(),
  };
}

function skippedHop(service: RefundService, why: string): ExchangeHopEntry {
  const def = serviceDef(service);
  return {
    type: "hop",
    hop: def.hop,
    service,
    serviceLabel: def.label,
    tool: def.tool,
    grantKind: def.standingGrant ? "standing" : "on-demand",
    audience: audienceFor(service),
    exchange: "skipped",
    reason: why,
    mcp: { status: "skipped", detail: "No token was requested, so no call was made." },
    at: now(),
  };
}

function intentFor(record: RefundRecord, service: RefundService, approvedBy?: string) {
  // Recorded verbatim in FusionAuth's audit log, and handed to the populate lambda —
  // which is how `approved_by` gets onto the hop-4 token (see README).
  return `refundbot:${record.id}:${service}${approvedBy ? `;approved_by=${approvedBy}` : ""}`;
}

/** Exchange + call for a standing-Grant hop (1–3). */
async function standingHop(
  record: RefundRecord,
  service: RefundService,
  args: Record<string, unknown>
): Promise<{ entry: ExchangeHopEntry; data?: Record<string, unknown> }> {
  const ex = await exchangerForMode(record.mode).exchange({
    subjectToken: record.subjectToken,
    audience: audienceFor(service),
    intent: intentFor(record, service),
  });
  const entry = hopFromExchange(service, "standing", ex);
  if (!ex.ok || !ex.token) {
    entry.mcp = { status: "skipped", detail: "FusionAuth issued no token, so the service was never called." };
    pushTrace(record, entry);
    return { entry };
  }
  const call = await callRefundTool(serviceDef(service).tool, args, ex.token);
  entry.mcp = call.ok
    ? {
        status: "allowed",
        detail:
          "Resource server verified the exchanged token: signature, issuer, its own " +
          "audience, act = orchestrator.",
      }
    : {
        status: call.reached ? "denied" : "error",
        detail: `${call.code ? `${call.code}: ` : ""}${call.message ?? ""}`,
      };
  pushTrace(record, entry);
  return { entry, data: call.ok ? call.data : undefined };
}

// ---------------------------------------------------------------------------
// Hops 1–3, then the hop-4 probe
// ---------------------------------------------------------------------------

export interface StartRefundInput {
  customerId: string;
  customerLabel: string;
  accessToken: string;
  sid: string;
  sidSource: "sid" | "jti-fallback";
  orderId: string;
  mode: ExchangeMode;
}

function stopRemaining(record: RefundRecord, from: number, why: string) {
  for (const s of ["order-history", "customer-scoring", "refund-budget", "banking-api"] as const) {
    if (serviceDef(s).hop >= from) pushTrace(record, skippedHop(s, why));
  }
}

/**
 * Runs hops 1–3 for a refund request and, if nothing stopped it, records what
 * approvals hop 4 will need and probes hop 4 to show the refusal. Returns the record;
 * its `decision` says where it ended up.
 */
export async function startRefund(input: StartRefundInput): Promise<RefundRecord> {
  const record = createRefundRecord({
    sid: input.sid,
    sidSource: input.sidSource,
    customerId: input.customerId,
    customerLabel: input.customerLabel,
    subjectToken: input.accessToken,
    orderId: input.orderId,
    mode: input.mode,
    fga: { mode: lastFgaMode(), approvals: [] },
  });

  // FGA gate — before anything else. Permify, not order history, decides whether this
  // customer may ask about this order at all.
  const ownership = await checkOrderOwnership(input.customerId, input.orderId);
  record.fga.mode = lastFgaMode();
  record.fga.ownership = ownership;
  if (!ownership.allowed) {
    record.decision = "stopped";
    note(
      record,
      "fga",
      "denied",
      "Permify: order#request_refund DENIED",
      `${ownership.reason} No token exchange was attempted and no service was called. ` +
        "See the Permissions tab."
    );
    stopRemaining(record, 1, "FusionAuth FGA denied the ownership check — no exchange attempted.");
    return record;
  }
  note(
    record,
    "fga",
    "allowed",
    `Permify: ownership check passed (${ownership.via ?? "allowed"}) →`,
    `order#request_refund allowed via \`${ownership.via ?? "?"}\` on ${ownership.accountLabel ?? "the account"}. ` +
      "Only now does the token chain below begin."
  );

  if (input.sidSource === "jti-fallback") {
    note(
      record,
      "pipeline",
      "info",
      "correlator: no sid on the subject token",
      "The customer's access token carries no `sid` (FusionAuth only adds one when a " +
        "refresh token is issued), so the request is keyed by the subject token's jti. " +
        "banking-api will find the approval record by the exchanged token's `sub` + " +
        "`auth_time` instead, both of which FusionAuth copies from the subject token."
    );
  }

  // Hop 1 — order history. The ONLY source of truth for whether this order exists.
  const h1 = await standingHop(record, "order-history", { orderId: input.orderId });
  if (!h1.data) {
    record.decision = "failed";
    note(record, "result", "error", "chain stopped at hop 1", h1.entry.reason ?? h1.entry.mcp?.detail);
    stopRemaining(record, 2, "Hop 1 failed.");
    return record;
  }
  const order = h1.data.order as
    | { id: string; item: string; totalCents: number; refunded: boolean; storeId: string }
    | null;
  if (!order) {
    h1.entry.result = `No order ${input.orderId} for this customer.`;
    record.decision = "stopped";
    note(
      record,
      "result",
      "denied",
      "chain stopped: order history came back empty",
      `Order history has no ${input.orderId} for this customer. Nothing downstream is ` +
        "attempted — no scoring, no budget check, no banking token — and no human is " +
        "asked to refuse something that was never real."
    );
    stopRemaining(record, 2, `Hop 1 found no ${input.orderId}.`);
    return record;
  }
  h1.entry.result = `${order.id} · ${order.item} · ${formatUsd(order.totalCents)}${order.refunded ? " · already refunded" : ""}`;
  record.orderSummary = `${order.item} (${order.id})`;
  record.amountCents = order.totalCents;
  record.storeId = order.storeId;
  const store = storeDef(order.storeId);
  const region = store ? regionDef(store.regionId) : undefined;
  if (store) record.fga.store = { id: store.id, label: store.label, capCents: store.capCents };
  if (region) record.fga.region = { id: region.id, label: region.label, capCents: region.capCents };
  if (order.refunded) {
    record.decision = "stopped";
    note(record, "result", "denied", "chain stopped: already refunded", `${order.id} was refunded earlier.`);
    stopRemaining(record, 2, "The order was already refunded.");
    return record;
  }

  // Hop 2 — customer history (context only; the escalation decision is FGA's).
  const h2 = await standingHop(record, "customer-scoring", {});
  if (!h2.data) {
    record.decision = "failed";
    note(record, "result", "error", "chain stopped at hop 2", h2.entry.reason ?? h2.entry.mcp?.detail);
    stopRemaining(record, 3, "Hop 2 failed.");
    return record;
  }
  record.history = {
    lifetimeSpendCents: Number(h2.data.lifetimeSpendCents),
    orderCount: Number(h2.data.orderCount),
    priorRefunds: Number(h2.data.priorRefunds),
  };
  h2.entry.result =
    `${record.history.orderCount} orders · ${formatUsd(record.history.lifetimeSpendCents)} lifetime · ` +
    `${record.history.priorRefunds} prior refund${record.history.priorRefunds === 1 ? "" : "s"}`;

  // Hop 3 — budget + the standard self-service floor. The amount comes from the order
  // record, server-side.
  const h3 = await standingHop(record, "refund-budget", { orderId: order.id });
  if (!h3.data) {
    record.decision = "failed";
    note(record, "result", "error", "chain stopped at hop 3", h3.entry.reason ?? h3.entry.mcp?.detail);
    stopRemaining(record, 4, "Hop 3 failed.");
    return record;
  }
  record.floorCents = Number(h3.data.floorCents);
  const aboveFloor = h3.data.aboveFloor === true;
  h3.entry.result =
    `${formatUsd(order.totalCents)} vs. the ${formatUsd(record.floorCents)} self-service floor · ` +
    `budget ${h3.data.withinBudget ? "OK" : "exhausted"}`;
  if (h3.data.withinBudget !== true) {
    record.decision = "stopped";
    note(record, "result", "denied", "chain stopped: refund budget exhausted");
    stopRemaining(record, 4, "Budget can't cover it.");
    return record;
  }

  // The escalation decision. FusionAuth FGA first: a trusted account under its cap skips
  // the employee queue. Otherwise the standard path — above the floor means a support
  // employee, authorized through the store → region cascade on /support/approvals.
  const tier = ownership.accountEntity
    ? await checkAutoApprove(input.customerId, ownership.accountEntity, order.totalCents)
    : undefined;
  record.fga.tier = tier;
  record.fga.mode = lastFgaMode();
  if (tier) {
    note(
      record,
      "fga",
      tier.autoApprove ? "allowed" : "info",
      tier.autoApprove
        ? "Permify: account#auto_approve passed → no employee review"
        : "Permify: account#auto_approve not granted →",
      tier.reason
    );
  }
  record.needsEmployee = !tier?.autoApprove && aboveFloor;

  record.customer = { state: "pending" };
  record.employee = { state: record.needsEmployee ? "pending" : "not_required" };
  record.decision = "awaiting_approvals";
  touch(record);
  note(
    record,
    "approval",
    "required",
    record.needsEmployee
      ? "approvals required: customer + support employee"
      : "approval required: customer only",
    record.needsEmployee
      ? `${formatUsd(order.totalCents)} is above the ${formatUsd(record.floorCents)} self-service floor and the account isn't auto-approved, so a support employee must approve it (Permify store → region cascade) AND the customer must confirm out-of-band.`
      : tier?.autoApprove
        ? "Trusted account under its cap — no employee is looped in. The customer's out-of-band confirmation (step-up MFA) is still mandatory: that's \"is this really you\", not \"do you deserve it\"."
        : `${formatUsd(order.totalCents)} is within the ${formatUsd(record.floorCents)} self-service floor — only the customer's out-of-band confirmation is needed.`
  );

  await probeBankingHop(record);
  return record;
}

/**
 * Hop 4 BEFORE approvals: ask FusionAuth for a banking-api token anyway, and show it
 * refuse. There is no Grant, so the Entity engine says no — the refusal in the trace is
 * FusionAuth's, not ours. If it unexpectedly says yes, a standing Grant exists that
 * shouldn't, and the issued token is thrown away unused.
 */
async function probeBankingHop(record: RefundRecord) {
  await withBankingLock(async () => {
    const ex = await exchangerForMode(record.mode).exchange({
      subjectToken: record.subjectToken,
      audience: audienceFor("banking-api"),
      intent: intentFor(record, "banking-api") + ";probe",
    });
    const entry = hopFromExchange("banking-api", "probe", ex);
    entry.approvals = {
      customer: record.customer.state,
      employee: record.employee.state,
    };
    if (ex.ok) {
      entry.mcp = { status: "skipped", detail: "Token discarded unused." };
      pushTrace(record, entry);
      note(
        record,
        "pipeline",
        "error",
        "misconfiguration: a standing banking-api Grant exists",
        "FusionAuth issued a banking-api token before any approval. Remove the " +
          "orchestrator → banking-api Grant in Entities → banking-api → Grants; only this " +
          "app may create it, on demand. The banking service still refuses without the " +
          "approval record, so no money moved."
      );
      return;
    }
    entry.mcp = { status: "skipped", detail: "No token — the banking service is unreachable by construction." };
    entry.result = "DENIED — no Entity Grant (approvals pending)";
    pushTrace(record, entry);
  });
}

// ---------------------------------------------------------------------------
// Hop 4 — create Grant → exchange → call → revoke Grant
// ---------------------------------------------------------------------------

/**
 * Runs hop 4 if, and only if, the record shows every required approval and nobody has
 * refused. Safe to call after any approval lands; it's a no-op until the second one.
 */
export async function maybeExecuteBankingHop(record: RefundRecord): Promise<void> {
  if (record.decision !== "awaiting_approvals") return;
  if (approvalsRefused(record)) return;
  if (!approvalsSatisfied(record)) return;
  record.decision = "executing";
  touch(record);
  note(
    record,
    "approval",
    "allowed",
    "every required approval is in",
    record.needsEmployee
      ? `Customer confirmed; ${record.employee.employeeName ?? "a support employee"} approved. Creating the banking-api Grant now.`
      : "Customer confirmed. Creating the banking-api Grant now."
  );
  await executeBankingHop(record);
}

async function executeBankingHop(record: RefundRecord) {
  await withBankingLock(async () => {
    const grant: GrantEvent[] = [];
    let entry: ExchangeHopEntry | undefined;
    let call: ToolCallResult | undefined;

    const created = await createBankingGrant(record.mode);
    grant.push({ step: "create", ok: created.ok, at: now(), detail: created.detail });

    try {
      if (!created.ok) {
        entry = skippedHop("banking-api", `Grant creation failed: ${created.detail}`);
        entry.grantKind = "on-demand";
        return;
      }
      const approvedBy = record.needsEmployee ? record.employee.employeeId : undefined;
      const ex = await exchangerForMode(record.mode).exchange({
        subjectToken: record.subjectToken,
        audience: audienceFor("banking-api"),
        intent: intentFor(record, "banking-api", approvedBy),
      });
      entry = hopFromExchange("banking-api", "on-demand", ex);
      if (!ex.ok || !ex.token) {
        grant.push({ step: "use", ok: false, at: now(), detail: "FusionAuth refused the exchange even with the Grant in place." });
        entry.mcp = { status: "skipped", detail: "No token issued." };
        return;
      }
      grant.push({ step: "use", ok: true, at: now(), detail: `Token issued (jti ${entry.jti ?? "?"}) and presented to banking-api once.` });
      call = await callRefundTool("process_refund", { requestId: record.id }, ex.token);
      entry.mcp = call.ok
        ? {
            status: "allowed",
            detail:
              "banking-api verified the token's audience + actor, then checked the " +
              (record.sidSource === "sid"
                ? "approval record for this sid before moving money."
                : "approval record for this sub + auth_time (no sid) before moving money."),
          }
        : {
            status: call.reached ? "denied" : "error",
            detail: `${call.code ? `${call.code}: ` : ""}${call.message ?? ""}`,
          };
    } finally {
      // ALWAYS revoke — on success, on refusal, on exception. Retry once on failure.
      let revoked = await deleteBankingGrant(record.mode);
      if (!revoked.ok) revoked = await deleteBankingGrant(record.mode);
      grant.push({ step: "revoke", ok: revoked.ok, at: now(), detail: revoked.detail });

      entry = entry ?? skippedHop("banking-api", "Hop 4 aborted.");
      entry.grant = grant;
      entry.approvals = {
        customer: record.customer.state,
        employee: record.employee.state,
        employeeName: record.employee.employeeName,
      };
      if (call?.ok && call.data) {
        record.decision = "refunded";
        record.confirmationId = String(call.data.confirmationId);
        entry.approvedByPath = call.data.approvedByPath as ExchangeHopEntry["approvedByPath"];
        entry.result = `Refunded ${formatUsd(Number(call.data.amountCents))} · ${record.confirmationId}`;
      } else {
        record.decision = "failed";
      }
      pushTrace(record, entry);
      if (!revoked.ok) {
        note(
          record,
          "pipeline",
          "error",
          "GRANT REVOKE FAILED — remove it by hand",
          `${revoked.detail}. Until it's deleted, FusionAuth will issue banking-api tokens to the orchestrator. Entities → banking-api → Grants.`
        );
      }
      note(
        record,
        "result",
        record.decision === "refunded" ? "allowed" : "error",
        record.decision === "refunded"
          ? `refund complete · ${record.confirmationId}`
          : "refund did not complete",
        record.decision === "refunded"
          ? "The banking-api Grant existed only for this one exchange and is gone again."
          : (entry.reason ?? entry.mcp?.detail)
      );
    }
  });
}
