import { redirect } from "next/navigation";
import Shell from "@/components/Shell";
import DocLink from "@/components/DocLink";
import ApprovalConsole from "@/components/ApprovalConsole";
import TokenExchangeModeBanner from "@/components/TokenExchangeModeBanner";
import FgaModeBanner from "@/components/FgaModeBanner";
import { getSession } from "@/lib/session";
import { isSupportStaff } from "@/lib/roles";
import { allRefunds, toView } from "@/lib/approvals";
import { ARTICLES } from "@/lib/knowledge-base";
import { resolveExchangeMode } from "@/lib/token-exchange";
import { syncEmployeeFga } from "@/lib/fga";

export const dynamic = "force-dynamic";

/**
 * The support employee approval console — the second human in the loop. Gated on the
 * verified token's Application Role (employee / manager / it-admin, or admin), the same
 * pattern as /admin. A customer who isn't registered with one of those roles is sent
 * back to /refund.
 *
 * The role only opens the door. WHICH refunds this employee may decide is FGA by
 * Permify's call — their store (`store#approve_local`) or, inherited through it, their
 * region (`region#approve_escalated`), each under that entity's own cap.
 *
 * The internal escalation notes are the knowledge base's `support` audience; the
 * customer chat only ever searches the `customer` audience.
 */
export default async function ApprovalsPage() {
  const session = await getSession();
  if (!session) redirect("/api/auth/login?redirect_uri=/support/approvals");
  if (!isSupportStaff(session.roles)) redirect("/refund");

  const name = session.name ?? session.email ?? session.userId;
  const [exchange, fga] = await Promise.all([
    resolveExchangeMode(),
    syncEmployeeFga(session.userId, name, session.roles),
  ]);
  const requests = allRefunds().map(toView);
  const notes = ARTICLES.filter((a) => a.audience === "support");

  return (
    <Shell session={session}>
      <div className="mb-5 max-w-3xl">
        <h1 className="text-2xl font-bold tracking-tight text-ink font-display">
          Refund approvals
        </h1>
        <p className="text-sm text-ink-soft">
          You&rsquo;re one of two independent approvals on an escalated refund. Which ones
          you may decide comes from your store and region relations in FusionAuth FGA, each
          with its own cap. Approving
          records your FusionAuth user id against the transaction; that identity is checked
          by the banking service before money moves, not just logged. Until both approvals
          land, no <DocLink to="entityGrantsApi">Entity Grant</DocLink> to banking-api exists,
          so FusionAuth won&rsquo;t <DocLink to="tokenExchange">exchange</DocLink> a token for it.
          Access to this console comes from your{" "}
          <DocLink to="roles">application role</DocLink>.
        </p>
      </div>
      <div className="mb-5 space-y-3">
        <TokenExchangeModeBanner
          mode={exchange.mode}
          reason={exchange.mode === "simulated" ? exchange.reason : undefined}
        />
        <FgaModeBanner mode={fga.mode} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        <ApprovalConsole requests={requests} viewerId={session.userId} />
        <div className="space-y-6">
        <aside className="h-fit rounded-xl border border-line bg-card shadow-sm">
          <div className="border-b border-line px-5 py-3">
            <h2 className="font-bold text-ink font-display">Your Permify relations</h2>
            <p className="text-xs text-ink-soft">FGA schema · what you may approve</p>
          </div>
          {fga.relations.length === 0 ? (
            <p className="px-5 py-4 text-sm text-ink-soft">
              None — you can see the queue but Permify will refuse every decision. An admin
              can grant <code className="font-mono">store#manager</code> or{" "}
              <code className="font-mono">region#director</code> in /admin.
            </p>
          ) : (
            <ul className="space-y-1 px-5 py-3">
              {fga.relations.map((r) => (
                <li key={r} className="font-mono text-xs text-brand-ink">
                  {r}@user:you
                </li>
              ))}
            </ul>
          )}
        </aside>
        <aside className="h-fit rounded-xl border border-line bg-card shadow-sm">
          <div className="border-b border-line px-5 py-3">
            <h2 className="font-bold text-ink font-display">
              Escalation notes
            </h2>
            <p className="text-xs text-ink-soft">Internal · support staff only</p>
          </div>
          <ul className="divide-y divide-line">
            {notes.map((n) => (
              <li key={n.id} className="px-5 py-3">
                <p className="text-sm font-semibold text-ink">{n.title}</p>
                <p className="mt-1 text-xs text-ink-soft">{n.body}</p>
              </li>
            ))}
          </ul>
        </aside>
        </div>
      </div>
    </Shell>
  );
}
