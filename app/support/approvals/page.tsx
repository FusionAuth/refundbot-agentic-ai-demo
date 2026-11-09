import { redirect } from "next/navigation";
import Shell from "@/components/Shell";
import DocLink from "@/components/DocLink";
import ApprovalConsole from "@/components/ApprovalConsole";
import TokenExchangeModeBanner from "@/components/TokenExchangeModeBanner";
import { getSession } from "@/lib/session";
import { isSupportStaff } from "@/lib/roles";
import { allRefunds, toView } from "@/lib/approvals";
import { ARTICLES, articleVisible } from "@/lib/knowledge-base";
import { resolveExchangeMode } from "@/lib/token-exchange";

export const dynamic = "force-dynamic";

/**
 * The support employee approval console — the second human in the loop. Gated on the
 * verified token's Application Role (employee / manager / it-admin, or admin), the same
 * pattern as /admin. A customer who isn't registered with one of those roles is sent
 * back to /refund.
 *
 * The internal escalation notes come from the same knowledge base the customer chat
 * reads, through the same scope filter: they need tools:kb.read, which only the
 * employee roles' logins request, so the customer surface can never retrieve them.
 */
export default async function ApprovalsPage() {
  const session = await getSession();
  if (!session) redirect("/api/auth/login?role=employee&redirect_uri=/support/approvals");
  if (!isSupportStaff(session.roles)) redirect("/refund");

  const exchange = await resolveExchangeMode();
  const requests = allRefunds().map(toView);
  const notes = ARTICLES.filter(
    (a) => a.tags.includes("escalation") && a.requiredScope !== "public" && articleVisible(a, session.scopes)
  );

  return (
    <Shell session={session}>
      <div className="mb-5 max-w-3xl">
        <h1 className="text-2xl font-bold tracking-tight text-ink font-display">
          Refund approvals
        </h1>
        <p className="text-sm text-ink-soft">
          You&rsquo;re one of two independent approvals on an escalated refund. Approving
          records your FusionAuth user id against the transaction; that identity is checked
          by the banking service before money moves, not just logged. Until both approvals
          land, no <DocLink to="entityGrantsApi">Entity Grant</DocLink> to banking-api exists,
          so FusionAuth won&rsquo;t <DocLink to="tokenExchange">exchange</DocLink> a token for it.
          Access to this console comes from your{" "}
          <DocLink to="roles">application role</DocLink>.
        </p>
      </div>
      <div className="mb-5">
        <TokenExchangeModeBanner
          mode={exchange.mode}
          reason={exchange.mode === "simulated" ? exchange.reason : undefined}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        <ApprovalConsole requests={requests} viewerId={session.userId} />
        <aside className="h-fit rounded-xl border border-line bg-card shadow-sm">
          <div className="border-b border-line px-5 py-3">
            <h2 className="font-bold text-ink font-display">
              Escalation notes
            </h2>
            <p className="text-xs text-ink-soft">Internal · requires tools:kb.read</p>
          </div>
          {notes.length === 0 ? (
            <p className="px-5 py-4 text-sm text-ink-soft">
              Your token doesn&rsquo;t carry <code>tools:kb.read</code>, so the internal notes
              are filtered out — the same scope filter the chat uses.
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {notes.map((n) => (
                <li key={n.id} className="px-5 py-3">
                  <p className="text-sm font-semibold text-ink">{n.title}</p>
                  <p className="mt-1 text-xs text-ink-soft">{n.body}</p>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </Shell>
  );
}
