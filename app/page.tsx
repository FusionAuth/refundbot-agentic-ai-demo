import { redirect } from "next/navigation";
import ScopeConsentPreview from "@/components/ScopeConsentPreview";
import { getSession } from "@/lib/session";
import { isSupportStaff } from "@/lib/roles";

const ERRORS: Record<string, string> = {
  invalid_state: "That sign-in link expired. Please try again.",
  exchange_failed: "We couldn't complete sign-in. Please try again.",
  access_denied: "You declined the requested access.",
};

const HOPS = [
  ["1", "order-history-service", "Does this order exist, for this customer?", "standing Grant"],
  ["2", "customer-scoring-service", "How valuable is this customer? (sets the self-service limit)", "standing Grant"],
  ["3", "refund-budget-service", "Can the budget cover it, and does it need a human?", "standing Grant"],
  ["4", "banking-api", "Move the money — irreversible.", "Grant created on demand, then revoked"],
];

export default async function LandingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  // Signed-in visitors go straight to their surface: support staff to the approval
  // console, everyone else to RefundBot. getSession() fully verifies the access token.
  const session = await getSession();
  if (session) redirect(isSupportStaff(session.roles) ? "/support/approvals" : "/refund");

  const { error } = await searchParams;
  const errorMessage = error ? (ERRORS[error] ?? "Sign-in failed.") : null;

  return (
    <main className="flex-1">
      <section className="border-b border-line bg-ink text-white">
        <div className="mx-auto max-w-5xl px-5 py-16 sm:py-20">
          <div className="flex items-center gap-2.5">
            <span
              className="flex h-8 w-8 items-center justify-center rounded-md bg-white text-sm font-bold text-ink font-display"
              aria-hidden="true"
            >
              RB
            </span>
            <span className="text-base font-bold tracking-tight font-display">
              RefundBot
            </span>
          </div>
          <p className="mt-8 text-xs font-semibold uppercase tracking-[0.2em] text-brand">
            OAuth Token Exchange (RFC 8693) for agentic AI
          </p>
          <h1 className="mt-3 max-w-3xl text-4xl font-bold leading-tight tracking-tight font-display sm:text-5xl">
            One refund. Four services. Never one broad credential.
          </h1>
          <p className="mt-4 max-w-2xl text-lg text-white/70">
            A customer asks for their money back. At every hop the orchestrator trades the
            customer&rsquo;s token for a <strong className="text-white">narrower one</strong>,
            scoped to exactly that service — and the authority to call the bank
            <strong className="text-white"> doesn&rsquo;t exist</strong> until the customer
            and, above their limit, a support employee both say yes.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a
              href="/api/auth/login?redirect_uri=/refund"
              className="rounded-lg bg-brand px-5 py-3 font-semibold text-white hover:bg-brand-ink"
            >
              I&rsquo;m a customer
            </a>
            <a
              href="/api/auth/login?role=employee&redirect_uri=/support/approvals"
              className="rounded-lg border border-white/30 px-5 py-3 font-semibold text-white hover:bg-white/10"
            >
              Support employee sign-in
            </a>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-5 py-12">
        {errorMessage ? (
          <div
            role="alert"
            className="mb-6 rounded-lg border border-signal/40 bg-signal-soft px-4 py-3 text-sm font-medium text-signal-ink"
          >
            {errorMessage}
          </div>
        ) : null}

        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-soft">
          The four hops
        </h2>
        <ol className="mt-4 grid gap-3 md:grid-cols-2">
          {HOPS.map(([n, service, question, grant]) => (
            <li key={n} className="rounded-2xl border border-line bg-card p-5">
              <p className="text-xs font-semibold text-ink-soft font-mono">
                HOP {n} · {grant}
              </p>
              <p className="mt-1 font-bold text-ink font-display">{service}</p>
              <p className="mt-1 text-sm text-ink-soft">{question}</p>
            </li>
          ))}
        </ol>
        <p className="mt-4 max-w-3xl text-sm text-ink-soft">
          Every exchanged token keeps the customer as <code>sub</code>, names the
          orchestrator in <code>act</code>, and carries the login&rsquo;s <code>sid</code> — so
          all four hops are provably the same customer in the same conversation.
        </p>

        <h2 className="mt-14 text-sm font-semibold uppercase tracking-wide text-ink-soft">
          The original employee demo (Ask Fusion)
        </h2>
        <p className="mt-1 mb-6 max-w-2xl text-ink-soft">
          RefundBot is built on InFusion Agent, whose scope-gated employee assistant is still
          here as a secondary mode. The role you choose decides which tool scopes your login
          even <em>requests</em>.
        </p>
        <ScopeConsentPreview />
      </section>
    </main>
  );
}
