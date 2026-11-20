import { formatUsd, type RefundRequestView } from "@/lib/refund-types";

/**
 * The refund progress card: order, amount, a status pill, the step checklist, and the
 * "Secured by N narrow tokens" footer. Shared by the web chat (components/RefundChat.tsx) and
 * the AgentCore chat (components/AgentCoreChat.tsx); both render it from the same
 * RefundRequestView. Pure display — it holds no state of its own.
 *
 * The token count is the number of ALLOWED token-exchange hops in the request's trace, so it
 * reads the same for a refund the agent started as for one the web chat started.
 */

export const TERMINAL = new Set(["refunded", "denied", "declined", "stopped", "failed"]);

type StepState = "done" | "current" | "todo" | "failed" | "skipped";

function steps(r: RefundRequestView): { label: string; state: StepState }[] {
  const owned = r.fga.ownership?.allowed;
  const found = r.amountCents !== undefined;
  const checked = r.floorCents !== undefined;
  const failedAt = r.decision === "stopped" || r.decision === "failed";
  const out: { label: string; state: StepState }[] = [
    {
      label: r.fga.ownership?.via === "delegate" ? "Shared account verified" : "Your account verified",
      state: owned ? "done" : owned === false ? "failed" : "current",
    },
    {
      label: "Order found",
      state: found ? "done" : owned === false ? "skipped" : failedAt ? "failed" : "current",
    },
    {
      label: "Eligibility checked",
      state: checked ? "done" : found && failedAt ? "failed" : found ? "current" : "todo",
    },
    {
      label: "You confirmed",
      state:
        r.customer.state === "approved"
          ? "done"
          : r.customer.state === "declined"
            ? "failed"
            : checked && !failedAt
              ? "current"
              : "todo",
    },
  ];
  if (r.needsEmployee) {
    out.push({
      label: "Specialist review",
      state:
        r.employee.state === "approved"
          ? "done"
          : r.employee.state === "denied"
            ? "failed"
            : r.customer.state === "approved"
              ? "current"
              : r.decision === "declined"
                ? "skipped"
                : "todo",
    });
  }
  out.push({
    label: "Refunded",
    state:
      r.decision === "refunded"
        ? "done"
        : r.decision === "executing"
          ? "current"
          : TERMINAL.has(r.decision)
            ? "skipped"
            : "todo",
  });
  return out;
}

const STATUS: Record<RefundRequestView["decision"], { label: string; tone: string }> = {
  awaiting_approvals: { label: "In progress", tone: "bg-signal-soft text-signal-ink" },
  executing: { label: "Processing", tone: "bg-brand-soft text-brand-ink" },
  refunded: { label: "Refunded", tone: "bg-verified-soft text-verified" },
  denied: { label: "Not approved", tone: "bg-denied-soft text-denied" },
  declined: { label: "Cancelled", tone: "bg-surface text-ink-soft" },
  stopped: { label: "Can't refund", tone: "bg-denied-soft text-denied" },
  failed: { label: "Problem", tone: "bg-denied-soft text-denied" },
};

export default function RefundProgressCard({
  r,
  onShowChain,
}: {
  r: RefundRequestView;
  /** When given, the footer is a button that jumps to the token chain (RefundChat). */
  onShowChain?: () => void;
}) {
  const status = STATUS[r.decision];
  const hops = r.trace.filter((e) => e.type === "hop" && e.exchange === "allowed").length;
  return (
    <div className="mt-2 w-full max-w-sm overflow-hidden rounded-xl border border-line bg-card text-ink shadow-sm">
      <div className="flex items-start justify-between gap-3 px-4 pt-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{r.orderSummary ?? r.orderId}</p>
          <p className="text-xs text-ink-soft">
            {r.amountCents !== undefined ? formatUsd(r.amountCents) : "No matching order"}
            {r.confirmationId ? ` · ${r.confirmationId}` : ""}
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[0.68rem] font-semibold ${status.tone}`}>
          {status.label}
        </span>
      </div>
      <ol className="space-y-1.5 px-4 py-3">
        {steps(r).map((s) => (
          <li key={s.label} className="flex items-center gap-2 text-xs">
            <span
              className={`flex h-4 w-4 items-center justify-center rounded-full text-[0.6rem] font-bold ${
                s.state === "done"
                  ? "bg-verified text-white"
                  : s.state === "failed"
                    ? "bg-denied text-white"
                    : s.state === "current"
                      ? "border-2 border-signal"
                      : "border border-line"
              }`}
            >
              {s.state === "done" ? "✓" : s.state === "failed" ? "✕" : ""}
            </span>
            <span
              className={
                s.state === "todo" || s.state === "skipped"
                  ? "text-ink-soft"
                  : s.state === "failed"
                    ? "text-denied"
                    : "text-ink"
              }
            >
              {s.label}
            </span>
          </li>
        ))}
      </ol>
      {onShowChain ? (
        <button
          type="button"
          onClick={onShowChain}
          className="flex w-full items-center justify-between border-t border-line bg-surface px-4 py-2 text-left text-[0.7rem] text-ink-soft hover:text-brand-ink"
        >
          <span>
            🔐 Secured by {hops} narrow token{hops === 1 ? "" : "s"} · FusionAuth Token Exchange
          </span>
          <span aria-hidden>→</span>
        </button>
      ) : (
        <div className="flex w-full items-center border-t border-line bg-surface px-4 py-2 text-[0.7rem] text-ink-soft">
          <span>
            🔐 Secured by {hops} narrow token{hops === 1 ? "" : "s"} · FusionAuth Token Exchange
          </span>
        </div>
      )}
    </div>
  );
}
