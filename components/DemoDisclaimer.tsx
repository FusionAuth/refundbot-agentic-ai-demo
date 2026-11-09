/**
 * Site-wide demo disclaimers, rendered by the root layout on every page — the landing
 * page included. Brightline is a fictional store; nothing here is a real purchase,
 * refund, or payment.
 */

export function DemoHeaderBar() {
  return (
    <div
      role="note"
      className="bg-ink px-4 py-1.5 text-center text-[0.72rem] text-white/80"
    >
      <span className="mr-2 rounded bg-signal px-1.5 py-0.5 text-[0.62rem] font-bold uppercase tracking-wider text-white">
        Demo
      </span>
      Brightline is a fictional store. No real orders, payments, or refunds — this site
      demonstrates FusionAuth OAuth Token Exchange.
    </div>
  );
}

export function DemoFooter() {
  return (
    <footer className="mt-auto border-t border-line bg-card px-5 py-6 text-xs text-ink-soft">
      <div className="mx-auto flex max-w-6xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p>
          <strong className="text-ink">Demo application.</strong> Brightline, its orders,
          and its customers are fictional. Refunds are simulated; no money moves and no
          payment provider is contacted.
        </p>
        <p className="shrink-0">
          RefundBot · a{" "}
          <a
            href="https://fusionauth.io/docs/authorization/token-exchange"
            target="_blank"
            rel="noopener noreferrer"
            className="text-brand-ink underline decoration-brand/30 underline-offset-2 hover:decoration-brand"
          >
            FusionAuth Token Exchange ↗
          </a>{" "}
          (RFC 8693) demo
        </p>
      </div>
    </footer>
  );
}
