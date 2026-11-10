import { redirect } from "next/navigation";
import Shell from "@/components/Shell";
import NonHumanIdentityCard from "@/components/NonHumanIdentityCard";
import AccountLinks from "@/components/AccountLinks";
import FgaModeBanner from "@/components/FgaModeBanner";
import FgaSchemaViewer from "@/components/FgaSchemaViewer";
import FgaRelationshipAdmin, {
  type FgaEntityChoice,
  type FgaEntityRow,
} from "@/components/FgaRelationshipAdmin";
import TokenExchangeAuditPanel from "@/components/TokenExchangeAuditPanel";
import DemoResetPanel from "@/components/DemoResetPanel";
import { allRefunds } from "@/lib/approvals";
import { getSession } from "@/lib/session";
import { isAdmin, primaryRoleBadge } from "@/lib/roles";
import {
  getMcpServiceIdentity,
  searchTenantUsers,
  accountManagementUrl,
  twoFactorManagementUrl,
} from "@/lib/fusionauth";
import {
  REFUND_SCHEMA,
  ensureFgaBootstrap,
  fgaEntityOptions,
  fixedOwnerNames,
  relationshipTable,
} from "@/lib/fga";

export const dynamic = "force-dynamic";

/**
 * Admin console. proxy.ts only checks the session cookie is present; the real
 * gate is HERE, off the verified access-token `roles` claim — a signed-in
 * non-admin is bounced to /. Shows RefundBot's Token Exchange audit, the two
 * FusionAuth identities (the user-login Application vs. the MCP tool server's own
 * Client-Credentials Entity), the FusionAuth FGA schema and relations, and which demo
 * users hold which roles.
 *
 * The FGA section is where the two halves of the platform meet: an Application ROLE
 * gates this page, and what you edit inside it are Permify RELATIONS. Move an employee
 * from one store to another here and the next approval attempt changes — same token,
 * same role, different answer.
 */
export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ txn?: string }>;
}) {
  const { txn } = await searchParams;
  const session = await getSession();
  if (!session) redirect("/api/auth/login?redirect_uri=/admin");
  if (!isAdmin(session.roles)) redirect("/");

  // All degrade honestly: null identity → "not connected"; null roster → "unavailable";
  // unreachable Permify → the in-memory fallback plus a banner that says so.
  const [mcp, users, fgaMode] = await Promise.all([
    getMcpServiceIdentity(),
    searchTenantUsers(),
    // Bootstrap only — never seed from /admin, or opening this page would hand the
    // viewer the demo relations for their role.
    ensureFgaBootstrap(),
  ]);
  const fgaTable = await relationshipTable();

  // Resolve raw Permify subject ids to something human, reusing the roster this page
  // already fetched. An id with no match still renders — as itself.
  const nameById = new Map([
    ...fixedOwnerNames(),
    ...(users ?? []).map((u) => [u.id, u.name || u.email || u.id] as const),
  ]);
  const fgaEntities: FgaEntityChoice[] = fgaEntityOptions().map((o) => ({
    type: o.entityType,
    id: o.entityId,
    label: o.label,
    relations: o.relations,
  }));
  const fgaRows: FgaEntityRow[] = fgaTable.map((row) => ({
    entityType: row.entityType,
    entityId: row.entityId,
    label: row.label,
    groups: row.rows.map((r) => ({
      relation: r.relation,
      members: r.userIds.map((id) => ({
        userId: id,
        label: nameById.get(id) ?? id,
      })),
    })),
  }));

  return (
    <Shell session={session}>
      <div className="max-w-3xl">
        <h1 className="text-3xl font-bold tracking-tight text-ink font-display">
          Admin console
        </h1>
        <p className="mt-2 text-ink-soft">
          You see this because your access token carries the admin role. Below:
          RefundBot&rsquo;s Token Exchange audit, the FusionAuth FGA relations behind
          ownership and approvals, the two FusionAuth identities behind this demo, and
          the demo users&rsquo; roles.
        </p>
      </div>

      {/* RefundBot — the app's exchange chain next to FusionAuth's own audit log */}
      <section className="mt-8">
        <h2 className="font-bold text-ink font-display">
          RefundBot · Token Exchange
        </h2>
        <p className="mb-3 text-sm text-ink-soft">
          Left: the exchange chain this app recorded. Right: the same transaction pulled
          straight from FusionAuth&rsquo;s Token Exchange Audit Log — an independent,
          first-party record of every exchange the orchestrator attempted.
        </p>
        <div className="mb-4">
          <DemoResetPanel
            customers={[...new Set(allRefunds().map((r) => r.customerLabel))].filter((c) =>
              c.includes("@")
            )}
          />
        </div>
        <TokenExchangeAuditPanel selectedId={txn} />
      </section>

      {/* The two FusionAuth identities */}
      <section className="mt-6">
        <h2 className="font-bold text-ink font-display">
          Two FusionAuth identities
        </h2>
        <p className="mb-3 text-sm text-ink-soft">
          The human logs in through an <strong className="text-ink">Application</strong>;
          the MCP tool server has its own non-human identity as a
          Client-Credentials <strong className="text-ink">Entity</strong>.
        </p>
        <NonHumanIdentityCard
          user={{
            subject: session.userId,
            name: session.name,
            roles: session.roles,
            scopes: session.scopes,
          }}
          mcp={mcp}
        />
      </section>

      {/* FusionAuth FGA — the per-resource layer */}
      <section className="mt-8">
        <h2 className="font-bold text-ink font-display">
          FusionAuth FGA
        </h2>
        <p className="mb-3 text-sm text-ink-soft">
          Token Exchange decides which <em>service</em> the orchestrator may reach. The
          Permify relations below decide which <em>resource</em> a person may act on —
          whose order a customer may refund, which store&rsquo;s escalations an employee
          may approve. These are Permify entities in an FGA schema, not FusionAuth
          Entities. Per-customer accounts aren&rsquo;t listed: their <code className="font-mono">owner</code>{" "}
          is always that customer.
        </p>
        <div className="space-y-4">
          <FgaModeBanner mode={fgaMode} />
          <FgaSchemaViewer schema={REFUND_SCHEMA} />
          <FgaRelationshipAdmin entities={fgaEntities} initial={fgaRows} />
        </div>
      </section>

      {/* Demo users + roles (a proxy for who can consent to what) */}
      <section className="mt-6 overflow-hidden rounded-xl border border-line bg-card shadow-sm">
        <div className="border-b border-line px-5 py-3">
          <h2 className="font-bold text-ink font-display">
            Demo users
          </h2>
          <p className="text-sm text-ink-soft">
            {users === null
              ? "User Search is unavailable on this instance."
              : `${users.length} user${users.length === 1 ? "" : "s"} — any employee role opens /support/approvals; which refunds they may approve is their Permify store/region relation.`}
          </p>
        </div>
        {users === null ? (
          <p className="px-5 py-4 text-sm text-ink-soft">
            The User Search API didn&rsquo;t return results — it needs the
            Elasticsearch/OpenSearch backend and an API key with the{" "}
            <code className="font-mono text-xs text-ink">
              /api/user/search
            </code>{" "}
            scope. This is the honest fallback, not a crash.
          </p>
        ) : users.length === 0 ? (
          <p className="px-5 py-4 text-sm text-ink-soft">No users found yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {users.map((person) => {
              const badge = primaryRoleBadge(person.roles);
              return (
                <li
                  key={person.id}
                  className="flex items-center justify-between gap-4 px-5 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium text-ink">{person.name}</p>
                    {person.email ? (
                      <p className="truncate text-sm text-ink-soft">
                        {person.email}
                      </p>
                    ) : null}
                  </div>
                  <span
                    className="shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold"
                    style={{ background: badge.background, color: badge.color }}
                  >
                    {badge.label}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Hosted account self-service */}
      <section className="mt-6">
        <h2 className="mb-3 font-bold text-ink font-display">
          Your account
        </h2>
        <AccountLinks
          accountUrl={accountManagementUrl()}
          twoFactorUrl={twoFactorManagementUrl()}
        />
      </section>
    </Shell>
  );
}
