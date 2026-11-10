import { redirect } from "next/navigation";
import Link from "next/link";
import BrightlineMark from "@/components/BrightlineMark";
import { getSession } from "@/lib/session";
import { isSupportStaff } from "@/lib/roles";
import { ARTICLES } from "@/lib/knowledge-base";

const ERRORS: Record<string, string> = {
  invalid_state: "That sign-in link expired. Please try again.",
  exchange_failed: "We couldn't complete sign-in. Please try again.",
  access_denied: "Sign-in was cancelled.",
};

const CUSTOMER_LOGIN = "/api/auth/login?redirect_uri=/refund";
const STAFF_LOGIN = "/api/auth/login?redirect_uri=/support/approvals";

const PROMISES = [
  {
    title: "Refunds in minutes",
    body: "Most refunds are approved the moment you confirm them — no forms, no waiting on hold.",
  },
  {
    title: "Nothing happens without you",
    body: "We always ask you to confirm through your Brightline account before any money moves.",
  },
  {
    title: "A real person for big ones",
    body: "Larger refunds get a quick review by a Brightline specialist, so your account stays safe.",
  },
];

const STEPS = [
  ["Sign in", "Use your Brightline account — we'll pull up your recent orders."],
  ["Tell RefundBot what's wrong", "Just name the order. It checks eligibility right away."],
  ["Confirm & relax", "Approve the refund and it's back on your card in 3–5 business days."],
];

/**
 * Brightline's customer help landing page. Brightline is fictional (the root layout's
 * demo bar and footer say so on every page); this page is written the way a real store's
 * help center would be, with the staff and demo entry points kept to a quiet strip.
 */
export default async function LandingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await getSession();
  if (session) redirect(isSupportStaff(session.roles) ? "/support/approvals" : "/refund");

  const { error } = await searchParams;
  const errorMessage = error ? (ERRORS[error] ?? "Sign-in failed. Please try again.") : null;
  const faq = ARTICLES.filter((a) => a.audience === "customer");

  return (
    <main className="flex-1">
      {/* Store header */}
      <header className="border-b border-line bg-card">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3">
          <Link href="/" className="flex items-center gap-2.5">
            <BrightlineMark />
            <span className="text-lg font-bold tracking-tight text-ink font-display">Brightline</span>
          </Link>
          <nav className="flex items-center gap-5 text-sm">
            <span className="hidden text-ink-soft sm:inline">Shop</span>
            <span className="hidden text-ink-soft sm:inline">Orders</span>
            <span className="font-medium text-ink">Help</span>
            <a
              href={CUSTOMER_LOGIN}
              className="rounded-full border border-line px-4 py-1.5 font-medium text-ink hover:bg-surface"
            >
              Sign in
            </a>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="bg-linear-to-b from-brand-soft/60 to-surface">
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-5 py-14 md:grid-cols-[1.1fr_1fr] md:py-20">
          <div>
            {errorMessage ? (
              <div
                role="alert"
                className="mb-6 rounded-lg border border-signal/40 bg-signal-soft px-4 py-3 text-sm font-medium text-signal-ink"
              >
                {errorMessage}
              </div>
            ) : null}
            <p className="text-sm font-semibold text-brand-ink">Brightline Help Center</p>
            <h1 className="mt-2 text-4xl font-bold leading-tight tracking-tight text-ink font-display sm:text-5xl">
              Returns made easy.
              <br />
              Refunds in minutes.
            </h1>
            <p className="mt-4 max-w-lg text-lg text-ink-soft">
              Something not right with your order? Chat with RefundBot, our support assistant,
              and get your money back without filling out a single form.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <a
                href={CUSTOMER_LOGIN}
                className="rounded-full bg-brand px-6 py-3 font-semibold text-white shadow-sm hover:bg-brand-ink"
              >
                Start a refund
              </a>
              <a href="#faq" className="px-2 py-3 font-medium text-brand-ink hover:underline">
                Read our refund policy
              </a>
            </div>
            <p className="mt-4 text-xs text-ink-soft">
              Sign-in secured by FusionAuth · 90-day refund window
            </p>
          </div>

          {/* Chat preview */}
          <div aria-hidden className="mx-auto w-full max-w-sm">
            <div className="overflow-hidden rounded-2xl border border-line bg-card shadow-xl">
              <div className="flex items-center gap-2.5 bg-ink px-4 py-3 text-white">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand text-[0.65rem] font-bold">
                  RB
                </span>
                <div>
                  <p className="text-sm font-semibold">RefundBot</p>
                  <p className="text-[0.65rem] text-white/70">Brightline support</p>
                </div>
              </div>
              <div className="space-y-3 bg-surface px-4 py-4 text-sm">
                <div className="ml-auto w-fit max-w-[80%] rounded-2xl rounded-br-md bg-brand px-3 py-2 text-white">
                  My earbuds stopped charging — can I get a refund?
                </div>
                <div className="w-fit max-w-[85%] rounded-2xl rounded-tl-md bg-card px-3 py-2 text-ink shadow-sm">
                  I found your Wireless earbuds for $48.00 — eligible for an instant refund. Want
                  me to go ahead?
                </div>
                <div className="rounded-xl border border-line bg-card px-3 py-2.5 shadow-sm">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-ink">Wireless earbuds · $48.00</p>
                    <span className="rounded-full bg-verified-soft px-2 py-0.5 text-[0.62rem] font-semibold text-verified">
                      Refunded
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 rounded-full bg-verified" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Promises */}
      <section className="mx-auto max-w-6xl px-5 py-14">
        <div className="grid gap-4 md:grid-cols-3">
          {PROMISES.map((p) => (
            <div key={p.title} className="rounded-2xl border border-line bg-card p-6">
              <h2 className="font-bold text-ink font-display">{p.title}</h2>
              <p className="mt-2 text-sm text-ink-soft">{p.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="border-y border-line bg-card">
        <div className="mx-auto max-w-6xl px-5 py-14">
          <h2 className="text-2xl font-bold tracking-tight text-ink font-display">How it works</h2>
          <ol className="mt-6 grid gap-6 md:grid-cols-3">
            {STEPS.map(([title, body], i) => (
              <li key={title} className="flex gap-4">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand text-sm font-bold text-white">
                  {i + 1}
                </span>
                <div>
                  <p className="font-semibold text-ink">{title}</p>
                  <p className="mt-1 text-sm text-ink-soft">{body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* FAQ — the same customer-visible articles RefundBot answers from */}
      <section id="faq" className="mx-auto max-w-3xl scroll-mt-6 px-5 py-14">
        <h2 className="text-2xl font-bold tracking-tight text-ink font-display">Refund questions</h2>
        <div className="mt-6 divide-y divide-line rounded-2xl border border-line bg-card">
          {faq.map((a) => (
            <details key={a.id} className="group px-5 py-4">
              <summary className="flex cursor-pointer list-none items-center justify-between font-medium text-ink">
                {a.title}
                <span className="text-ink-soft transition group-open:rotate-45">+</span>
              </summary>
              <p className="mt-2 text-sm text-ink-soft">{a.body}</p>
            </details>
          ))}
        </div>
        <div className="mt-8 text-center">
          <a
            href={CUSTOMER_LOGIN}
            className="inline-block rounded-full bg-brand px-6 py-3 font-semibold text-white hover:bg-brand-ink"
          >
            Chat with RefundBot
          </a>
        </div>
      </section>

      {/* Staff / demo entry points */}
      <section className="border-t border-line bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-5 text-sm">
          <p className="text-ink-soft">Brightline staff?</p>
          <div className="flex flex-wrap gap-4">
            <a href={STAFF_LOGIN} className="font-medium text-brand-ink hover:underline">
              Support console sign-in
            </a>
          </div>
        </div>
      </section>
    </main>
  );
}
