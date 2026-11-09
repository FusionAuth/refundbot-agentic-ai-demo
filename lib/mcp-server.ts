import { z } from "zod";
import type { McpServer, AuthInfo } from "@modelcontextprotocol/server";
import { scopeForTool, definitionForTool, type ToolName } from "@/lib/scopes";
import { rolesAllowTool } from "@/lib/roles";
import { searchKnowledgeBase, hiddenArticleCount } from "@/lib/knowledge-base";
import { createTicket } from "@/lib/tickets";
import { searchDirectory } from "@/lib/directory";
import { searchDirectoryUsers } from "@/lib/fusionauth";
import {
  PAYROLL_SUMMARY,
  payrollTotalCents,
  formatCents,
  adjustPtoBalance,
} from "@/lib/payroll";
import {
  ensureFgaBootstrap,
  visiblePayrollTeams,
  canAdjustPto,
  readableDocIds,
  type FgaReport,
} from "@/lib/fga";
import { employeeIdForName, employeeName } from "@/lib/org-graph";
import { askPublicDocs, externalDocsConfig } from "@/lib/external-docs";
import { audienceFor, orchestratorId } from "@/lib/refund-services";
import {
  findOrder,
  ordersForCustomer,
  scoreCustomer,
  approvalThresholdCents,
  approvalFloorCents,
  budgetRemainingCents,
  debitBudget,
  markRefunded,
} from "@/lib/refund-data";
import {
  findRefundInSession,
  approvalsSatisfied,
  approvalsRefused,
} from "@/lib/approvals";
import type { RefundService } from "@/lib/refund-types";

/**
 * The MCP tool registry + handlers. Registered onto the McpServer that
 * createMcpHandler builds (see app/api/mcp/route.ts). Every handler runs its OWN
 * scope + role check off `ctx.http?.authInfo` — the AuthInfo produced by the
 * independent verifier in lib/mcp-auth.ts. That check is intentionally separate
 * from the agent's sandbox pre-check in lib/agent.ts: this is the resource
 * server's own decision, made even if the sandbox was bypassed.
 *
 * Authorization is defense-in-depth: a tool runs only if the token carries the
 * required scope AND the caller's role is permitted for it. So a scope FusionAuth
 * mis-issues to the wrong role can't unlock a tool by itself.
 *
 * Passing that gate only settles whether the tool may RUN. Three of the handlers then
 * ask a second, different question — FusionAuth FGA by Permify (lib/fga.ts) — about the
 * specific RESOURCES involved: which teams' payroll, whose PTO, which documents. Scope
 * is per-class and can't express "the team you manage"; a relation can. So a caller who
 * passed every check above still gets a filtered payroll summary, or a flat refusal on
 * an employee outside their team.
 *
 * One handler — `search_public_docs` — reaches OUTSIDE the company instead of inside it,
 * and it runs behind the same gate as the rest. The employee's bearer token is not
 * forwarded past that gate; see lib/external-docs.ts for why, and for why the answer it
 * returns is treated strictly as untrusted data.
 *
 * Handlers return a JSON string in a single text block: `{ ok: true, data }` on
 * success, or `{ ok: false, error: "missing_scope" | "role_not_permitted" |
 * "fga_denied" }` (with isError) — which the agent renders as a scope-level vs.
 * resource-level DENIED in the trace, deliberately distinct from each other.
 */

interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  // The SDK's CallToolResult carries an index signature; mirror it so our
  // handlers' return type is assignable.
  [key: string]: unknown;
}

function ok(data: Record<string, unknown>): ToolResult {
  const payload = { ok: true, data };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function errorResult(payload: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

function denyScope(scope: string): ToolResult {
  return errorResult({
    ok: false,
    error: "missing_scope",
    scope,
    message: `The bearer token is missing the required scope ${scope}.`,
  });
}

function denyRole(tool: ToolName): ToolResult {
  const allowed = definitionForTool(tool)?.defaultForRoles ?? [];
  return errorResult({
    ok: false,
    error: "role_not_permitted",
    message:
      `This tool is restricted to roles: ${allowed.join(", ")}. The token's ` +
      `role isn't permitted, even though the scope is present.`,
  });
}

/**
 * A resource-level refusal from the FGA layer. Deliberately a different `error` from
 * the scope/role denials above: "your token may not use this tool" and "your relations
 * don't reach this resource" are different failures, and the trace shows them as
 * different layers.
 */
function denyFga(
  entity: string,
  permission: string,
  message: string,
  fga: FgaReport
): ToolResult {
  return errorResult({
    ok: false,
    error: "fga_denied",
    entity,
    permission,
    message,
    fga,
  });
}

/** The subject FGA checks run as: the `sub` off the independently-verified token. */
function subjectFor(authInfo: AuthInfo | undefined): string {
  return (authInfo?.extra?.sub as string | undefined) ?? "";
}

/**
 * The MCP server's own authorization gate — scope AND role, checked
 * independently of the agent sandbox. Returns a deny result to return directly,
 * or null when the caller may proceed.
 */
function authGate(tool: ToolName, authInfo: AuthInfo | undefined): ToolResult | null {
  // An RFC 8693 exchanged token was minted for ONE RefundBot service. Its audience isn't
  // this Application, so it may not be replayed against the employee tools — refused
  // here before scope or role are even read.
  if (authInfo?.extra?.exchanged) {
    return errorResult({
      ok: false,
      error: "wrong_audience",
      message:
        "This token was issued by token exchange for a different service's audience; " +
        "the employee tools only accept the Application's own access token.",
    });
  }
  const required = scopeForTool(tool);
  const scopes = authInfo?.scopes ?? [];
  if (required && !scopes.includes(required)) return denyScope(required);
  const roles = (authInfo?.extra?.roles as string[] | undefined) ?? [];
  if (!rolesAllowTool(roles, tool)) return denyRole(tool);
  return null;
}

/** Registers all six InFusion Agent tools onto the MCP server — five internal, one external. */
export function registerAgentTools(server: McpServer): void {
  server.registerTool(
    "search_knowledge_base",
    {
      title: "Search knowledge base",
      description:
        "Search the internal knowledge base and return the most relevant articles. Results are filtered to what the caller's token is allowed to see.",
      inputSchema: z.object({
        query: z.string().describe("What to search the knowledge base for."),
      }),
    },
    async ({ query }, ctx) => {
      const denied = authGate("search_knowledge_base", ctx.http?.authInfo);
      if (denied) return denied;
      const scopes = ctx.http?.authInfo?.scopes ?? [];

      // 1. The OAuth dimension: filter the corpus to what these scopes may see, then
      //    rank. An article the scopes exclude is never scored (lib/knowledge-base.ts).
      const ranked = searchKnowledgeBase(query, scopes);

      // 2. The FGA dimension: ask Permify `kb_doc:<id>#read` for every survivor that
      //    belongs to a space. Document-level ACLs, resolved through the doc's space to
      //    a team — so a doc the caller can't reach never enters the context window.
      await ensureFgaBootstrap();
      const { readable, report } = await readableDocIds(
        subjectFor(ctx.http?.authInfo),
        ranked.map((r) => r.article.id)
      );
      const allowed = ranked.filter((r) => readable.includes(r.article.id));

      return ok({
        query,
        results: allowed.map((r) => ({
          id: r.article.id,
          title: r.article.title,
          body: r.article.body,
          score: r.score,
        })),
        hiddenByScope: hiddenArticleCount(scopes),
        hiddenByFga: ranked.length - allowed.length,
        fga: report,
      });
    }
  );

  server.registerTool(
    "create_it_ticket",
    {
      title: "Create IT ticket",
      description:
        "Open an IT support ticket on the employee's behalf and return its reference id.",
      inputSchema: z.object({
        subject: z.string().describe("A short summary of the issue."),
        category: z
          .string()
          .optional()
          .describe("Optional category, e.g. 'hardware' or 'access'."),
      }),
    },
    async ({ subject, category }, ctx) => {
      const denied = authGate("create_it_ticket", ctx.http?.authInfo);
      if (denied) return denied;
      const openedBy =
        (ctx.http?.authInfo?.extra?.email as string | undefined) ||
        (ctx.http?.authInfo?.extra?.sub as string | undefined) ||
        "unknown";
      const ticket = createTicket({
        subject,
        category: category?.trim() || "general",
        openedBy,
        nowIso: new Date().toISOString(),
      });
      return ok({ ticket });
    }
  );

  server.registerTool(
    "lookup_employee",
    {
      title: "Look up employee",
      description:
        "Look up a colleague in the employee directory by name, email, or department.",
      inputSchema: z.object({
        query: z.string().describe("Name, email, or department to search for."),
      }),
    },
    async ({ query }, ctx) => {
      const denied = authGate("lookup_employee", ctx.http?.authInfo);
      if (denied) return denied;

      // Try a real FusionAuth /api/user search first (the tool server acts under
      // its own identity for outbound calls); fall back to the mock directory.
      const live = await searchDirectoryUsers(query);
      if (live) {
        return ok({
          source: "fusionauth",
          matches: live.map((u) => ({
            name: u.name,
            email: u.email,
            roles: u.roles,
          })),
        });
      }
      const mock = searchDirectory(query);
      return ok({
        source: "mock-directory",
        matches: mock.map((e) => ({
          name: e.name,
          email: e.email,
          title: e.title,
          department: e.department,
          location: e.location,
        })),
      });
    }
  );

  server.registerTool(
    "view_payroll",
    {
      title: "View payroll",
      description:
        "Return last month's payroll summary by team. Sensitive: requires payroll scope and a fresh step-up check.",
    },
    async (ctx) => {
      const denied = authGate("view_payroll", ctx.http?.authInfo);
      if (denied) return denied;

      // The scope said "payroll". FGA says WHICH payroll: one `team#view_payroll`
      // check per team. A team manager sees their own team; an org-level `hr` grant
      // cascades to every team with no per-team tuple.
      await ensureFgaBootstrap();
      const { teamIds, report } = await visiblePayrollTeams(
        subjectFor(ctx.http?.authInfo)
      );
      if (teamIds.length === 0) {
        return denyFga(
          "team:*",
          "view_payroll",
          "Your token carries tools:payroll.read, but your FGA relations don't reach " +
            "any team's payroll. Payroll needs `team#manager` on a team, or " +
            "`organization#hr` to cascade to all of them.",
          report
        );
      }

      const lines = PAYROLL_SUMMARY.filter((l) => teamIds.includes(l.id));
      return ok({
        month: "last month",
        // The total covers only the teams this caller may read — never the
        // company-wide figure with rows quietly removed.
        totalMonthlyGross: formatCents(payrollTotalCents(lines)),
        teams: lines.map((l) => ({
          team: l.team,
          headcount: l.headcount,
          monthlyGross: formatCents(l.monthlyGrossCents),
        })),
        fga: report,
      });
    }
  );

  server.registerTool(
    "update_pto_balance",
    {
      title: "Update PTO balance",
      description:
        "Adjust an employee's PTO balance by a number of days (positive or negative). Sensitive: requires PTO scope and a fresh step-up check.",
      inputSchema: z.object({
        employee: z.string().describe("The employee's full name."),
        deltaDays: z
          .number()
          .describe("Days to add (positive) or remove (negative)."),
      }),
    },
    async ({ employee, deltaDays }, ctx) => {
      const denied = authGate("update_pto_balance", ctx.http?.authInfo);
      if (denied) return denied;

      // Resolve the name to an FGA entity BEFORE mutating anything.
      const employeeId = employeeIdForName(employee);
      if (!employeeId) {
        const payload = {
          ok: false,
          error: "unknown_employee",
          message: `No PTO record for "${employee}".`,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          structuredContent: payload,
          isError: true,
        };
      }

      // The resource-level question the scope can't answer: not "may you write PTO"
      // but "may you write THIS person's PTO". Two hops in the schema —
      // employee → team → (manager | org.hr).
      await ensureFgaBootstrap();
      const { allowed, report } = await canAdjustPto(
        subjectFor(ctx.http?.authInfo),
        employeeId
      );
      if (!allowed) {
        return denyFga(
          `employee:${employeeId}`,
          "adjust_pto",
          `Your relations don't let you adjust PTO for ${
            employeeName(employeeId) ?? employee
          }. That needs \`manager\` on their team, or \`hr\` on the organization.`,
          report
        );
      }

      const updated = adjustPtoBalance(employee, deltaDays);
      if (!updated) {
        const payload = {
          ok: false,
          error: "unknown_employee",
          message: `No PTO record for "${employee}".`,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          structuredContent: payload,
          isError: true,
        };
      }
      return ok({ updated, fga: report });
    }
  );

  server.registerTool(
    "search_public_docs",
    {
      title: "Search public documentation",
      description:
        "Ask about the PUBLIC documentation for the platform this assistant runs on — " +
        "FusionAuth, the Model Context Protocol, and Permify. This is the only tool that " +
        "leaves the company network: it calls a third-party MCP server and returns public " +
        "information. It knows nothing about this company, its people, or its data — use " +
        "an internal tool for anything of that kind.",
      inputSchema: z.object({
        question: z
          .string()
          .describe("The question to ask the public documentation."),
      }),
    },
    async ({ question }, ctx) => {
      // Same gate as every internal tool — here the role gate is the whole of it, because
      // this tool ships without a dedicated scope (see lib/scopes.ts for why, and for how
      // to put it back behind an egress-consent scope).
      const denied = authGate("search_public_docs", ctx.http?.authInfo);
      if (denied) return denied;

      // No FGA check here, deliberately: there is no per-resource dimension to filter.
      // It is one public endpoint with a fixed remit, and the only interesting question —
      // may this agent leave the network at all — is what the scope already answers.
      const result = await askPublicDocs(question);
      if (!result.ok) {
        return errorResult({
          ok: false,
          error: "external_unavailable",
          message:
            `The external documentation server (${result.server}) didn't answer: ` +
            `${result.reason ?? "unknown error"}`,
        });
      }
      return ok({
        question,
        // Untrusted third-party content. Displayed and attributed, never acted on.
        answer: result.answer,
        server: result.server,
        repos: result.repos,
        external: true,
        toolName: externalDocsConfig.toolName,
      });
    }
  );
}

// ===========================================================================
// RefundBot — the four pipeline services, each gated on an EXCHANGED token
// ===========================================================================

/**
 * The refund tools' own gate. It replaces scope + role for these four, because the
 * question is different: not "may this user's token use this tool", but "did FusionAuth
 * mint this token, by token exchange, for THIS service, with the orchestrator as actor".
 *
 *  - `exchanged`  — the customer's own access token (aud = the Application) is refused.
 *                   The orchestrator must trade it; it may not forward it.
 *  - audience     — a token minted for order-history can't be replayed at banking-api.
 *  - `act.sub`    — the orchestrator Entity, and nobody else, is the actor.
 *  - `sub`        — still the customer, and the only identity the service acts for.
 *
 * Signature, issuer, and expiry were already verified by lib/mcp-auth.ts.
 */
interface ExchangedCaller {
  sub: string;
  sid?: string;
  jti?: string;
  approvedBy?: string;
  simulated: boolean;
}

function exchangeGate(
  service: RefundService,
  authInfo: AuthInfo | undefined
): { caller?: ExchangedCaller; denied?: ToolResult } {
  const extra = (authInfo?.extra ?? {}) as Record<string, unknown>;
  const deny = (code: string, message: string) => ({
    denied: errorResult({ ok: false, error: "exchange_gate", code, message }),
  });
  if (!extra.exchanged) {
    return deny(
      "not_exchanged",
      "This service only accepts a token issued by token exchange. The customer's own " +
        "access token was presented directly."
    );
  }
  const aud = (extra.aud as string[] | undefined) ?? [];
  const expected = audienceFor(service);
  if (!aud.includes(expected)) {
    return deny(
      "wrong_audience",
      `Token audience [${aud.join(", ")}] doesn't name this service (${expected}).`
    );
  }
  if (extra.actSub !== orchestratorId()) {
    return deny(
      "wrong_actor",
      `act.sub is ${String(extra.actSub ?? "absent")}; only the RefundBot orchestrator ` +
        `(${orchestratorId()}) may act here.`
    );
  }
  const sub = typeof extra.sub === "string" ? extra.sub : "";
  if (!sub) return deny("no_subject", "The exchanged token has no sub.");
  return {
    caller: {
      sub,
      sid: extra.sid as string | undefined,
      jti: extra.jti as string | undefined,
      approvedBy: extra.approvedBy as string | undefined,
      simulated: extra.simulated === true,
    },
  };
}

/** Registers the four RefundBot pipeline tools. */
export function registerRefundTools(server: McpServer): void {
  server.registerTool(
    "get_order_history",
    {
      title: "Get order history",
      description:
        "Hop 1. Return the customer's order history, or the one order asked about. The " +
        "customer is the token's sub — never an argument.",
      inputSchema: z.object({
        orderId: z.string().optional().describe("The order to look up, e.g. ORD-1042."),
      }),
    },
    async ({ orderId }, ctx) => {
      const { caller, denied } = exchangeGate("order-history", ctx.http?.authInfo);
      if (denied || !caller) return denied!;
      const orders = ordersForCustomer(caller.sub);
      const order = orderId ? findOrder(caller.sub, orderId) : undefined;
      return ok({
        customerId: caller.sub,
        orderId: orderId ?? null,
        found: orderId ? !!order : orders.length > 0,
        order: order ?? null,
        orderCount: orders.length,
      });
    }
  );

  server.registerTool(
    "score_customer_value",
    {
      title: "Score customer value",
      description: "Hop 2. A mock 0–100 value score from the customer's own history.",
    },
    async (ctx) => {
      const { caller, denied } = exchangeGate("customer-scoring", ctx.http?.authInfo);
      if (denied || !caller) return denied!;
      const score = scoreCustomer(caller.sub);
      return ok({ ...score, thresholdCents: approvalThresholdCents(score.score) });
    }
  );

  server.registerTool(
    "check_refund_budget",
    {
      title: "Check refund budget",
      description:
        "Hop 3. Can the refund budget cover this order, and does it cross the " +
        "employee-approval threshold? The amount comes from the order record, never " +
        "from the caller.",
      inputSchema: z.object({
        orderId: z.string().describe("The order being refunded."),
      }),
    },
    async ({ orderId }, ctx) => {
      const { caller, denied } = exchangeGate("refund-budget", ctx.http?.authInfo);
      if (denied || !caller) return denied!;
      const order = findOrder(caller.sub, orderId);
      if (!order) {
        return errorResult({ ok: false, error: "unknown_order", message: `No order ${orderId}.` });
      }
      const { score } = scoreCustomer(caller.sub);
      const thresholdCents = approvalThresholdCents(score);
      const remaining = budgetRemainingCents();
      return ok({
        orderId: order.id,
        amountCents: order.totalCents,
        alreadyRefunded: order.refunded,
        valueScore: score,
        floorCents: approvalFloorCents(),
        thresholdCents,
        needsEmployeeApproval: order.totalCents > thresholdCents,
        budgetRemainingCents: remaining,
        withinBudget: order.totalCents <= remaining,
      });
    }
  );

  server.registerTool(
    "process_refund",
    {
      title: "Process refund",
      description:
        "Hop 4 — the irreversible one. Moves money. Requires an exchanged token for the " +
        "banking-api audience, which FusionAuth only issues while the on-demand Grant " +
        "exists, AND an approval record showing every required approval.",
      inputSchema: z.object({
        requestId: z.string().describe("The refund request id from the approval queue."),
      }),
    },
    async ({ requestId }, ctx) => {
      const { caller, denied } = exchangeGate("banking-api", ctx.http?.authInfo);
      if (denied || !caller) return denied!;
      const refuse = (code: string, message: string) =>
        errorResult({ ok: false, error: "banking_refused", code, message });

      // The service's OWN check of the approval record, looked up by the token's sid —
      // the correlator FusionAuth carried over from the customer's login.
      const record = caller.sid ? findRefundInSession(caller.sid, requestId) : undefined;
      if (!record) {
        return refuse(
          "no_record",
          `No refund ${requestId} in the session named by this token's sid.`
        );
      }
      if (record.customerId !== caller.sub) {
        return refuse("subject_mismatch", "The token's sub isn't this refund's customer.");
      }
      if (record.executed) {
        return refuse("already_executed", "This refund already ran; tokens are single-purpose.");
      }
      if (approvalsRefused(record) || !approvalsSatisfied(record)) {
        return refuse("approvals_incomplete", "The approval record doesn't show every required approval.");
      }

      // The employee's identity is CHECKED here, not just logged. With the populate
      // lambda installed it rides on the token as `approved_by`, signed by FusionAuth,
      // and must match the record; without it, the record alone backs the decision.
      let approvedByPath: "claim" | "server-side record" | "not required" = "not required";
      if (record.needsEmployee) {
        const employeeId = record.employee.employeeId;
        if (!employeeId || employeeId === record.customerId) {
          return refuse("no_employee", "No independent employee approval on record.");
        }
        if (caller.approvedBy) {
          if (caller.approvedBy !== employeeId) {
            return refuse(
              "approved_by_mismatch",
              `approved_by claim (${caller.approvedBy}) doesn't match the approving employee on record.`
            );
          }
          approvedByPath = "claim";
        } else {
          approvedByPath = "server-side record";
        }
      }

      const order = findOrder(record.customerId, record.orderId);
      if (!order || order.refunded) {
        return refuse("order_state", "The order is missing or already refunded.");
      }
      if (!debitBudget(order.totalCents)) {
        return refuse("budget", "The refund budget can no longer cover this order.");
      }
      const confirmationId = `RF-${Date.now().toString(36).toUpperCase()}`;
      markRefunded(record.customerId, record.orderId, confirmationId);
      record.executed = true;

      return ok({
        confirmationId,
        orderId: order.id,
        amountCents: order.totalCents,
        approvedByPath,
        approvedBy: record.employee.employeeId ?? null,
        tokenJti: caller.jti ?? null,
        simulated: caller.simulated,
      });
    }
  );
}
