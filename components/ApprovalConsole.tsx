"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import ExchangeChainTrace from "@/components/ExchangeChainTrace";
import { formatUsd, type RefundRequestView } from "@/lib/refund-types";

/**
 * The support employee's queue. Approve / Deny writes to the approval queue through
 * /api/support/approvals; if the customer already confirmed, approving runs hop 4 in the
 * same request and the trace below picks it up. Refreshes itself every few seconds so a
 * newly escalated refund appears without a reload.
 */
export default function ApprovalConsole({
  requests,
  viewerId,
}: {
  requests: RefundRequestView[];
  viewerId: string;
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    const t = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(t);
  }, [router]);

  const pending = requests.filter(
    (r) => r.needsEmployee && r.employee.state === "pending" && r.decision === "awaiting_approvals"
  );
  const others = requests.filter((r) => !pending.includes(r));

  async function decide(id: string, decision: "approve" | "deny") {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch("/api/support/approvals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: id, decision }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) setError(data.error ?? "That didn't work.");
      setOpenId(id);
      router.refresh();
    } catch {
      setError("Couldn't reach the approval service.");
    } finally {
      setBusyId(null);
    }
  }

  function row(r: RefundRequestView, actionable: boolean) {
    const own = r.customerId === viewerId;
    return (
      <li key={r.id} className="px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-semibold text-ink">
              {r.orderSummary ?? r.orderId}{" "}
              {r.amountCents !== undefined ? (
                <span className="text-brand-ink">{formatUsd(r.amountCents)}</span>
              ) : null}
            </p>
            <p className="text-xs text-ink-soft">
              {r.customerLabel} · request {r.id} · value score {r.valueScore ?? "—"}
              {r.thresholdCents !== undefined
                ? ` · crossed the ${formatUsd(r.thresholdCents)} threshold`
                : ""}
            </p>
            <p className="mt-1 text-xs text-ink-soft">
              Customer confirmation: <strong className="text-ink">{r.customer.state}</strong>
              {" · "}Employee: <strong className="text-ink">{r.employee.state}</strong>
              {r.employee.employeeName ? ` (${r.employee.employeeName})` : ""}
              {" · "}Decision: <strong className="text-ink">{r.decision.replace("_", " ")}</strong>
              {r.confirmationId ? ` · ${r.confirmationId}` : ""}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            {actionable ? (
              own ? (
                <span className="text-xs text-ink-soft">Your own request — someone else must review it.</span>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={busyId !== null}
                    onClick={() => decide(r.id, "approve")}
                    className="rounded-lg bg-verified px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
                  >
                    {busyId === r.id ? "…" : "Approve"}
                  </button>
                  <button
                    type="button"
                    disabled={busyId !== null}
                    onClick={() => decide(r.id, "deny")}
                    className="rounded-lg border border-denied px-3 py-1.5 text-sm font-semibold text-denied disabled:opacity-50"
                  >
                    Deny
                  </button>
                </>
              )
            ) : null}
            <button
              type="button"
              onClick={() => setOpenId(openId === r.id ? null : r.id)}
              className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink hover:bg-surface"
            >
              {openId === r.id ? "Hide chain" : "Show chain"}
            </button>
          </div>
        </div>
        {openId === r.id ? (
          <div className="mt-3">
            <ExchangeChainTrace
              entries={r.trace}
              sid={r.sid}
              customerId={r.customerId}
              mode={r.mode}
              title={`Exchange chain · ${r.id}`}
            />
          </div>
        ) : null}
      </li>
    );
  }

  return (
    <div className="space-y-6">
      {error ? (
        <div role="alert" className="rounded-lg border border-denied/40 bg-denied-soft px-4 py-2 text-sm text-denied">
          {error}
        </div>
      ) : null}
      <section className="overflow-hidden rounded-xl border border-line bg-card shadow-sm">
        <div className="border-b border-line px-5 py-3">
          <h2 className="font-bold text-ink font-display">
            Waiting on you ({pending.length})
          </h2>
          <p className="text-xs text-ink-soft">
            Refunds above the customer&rsquo;s self-service threshold. Until you approve —
            and the customer confirms — no banking-api Grant exists, so FusionAuth won&rsquo;t
            issue a token that can move the money.
          </p>
        </div>
        {pending.length === 0 ? (
          <p className="px-5 py-4 text-sm text-ink-soft">Nothing escalated right now.</p>
        ) : (
          <ul className="divide-y divide-line">{pending.map((r) => row(r, true))}</ul>
        )}
      </section>
      <section className="overflow-hidden rounded-xl border border-line bg-card shadow-sm">
        <div className="border-b border-line px-5 py-3">
          <h2 className="font-bold text-ink font-display">All requests</h2>
        </div>
        {others.length === 0 ? (
          <p className="px-5 py-4 text-sm text-ink-soft">No other requests since the last restart.</p>
        ) : (
          <ul className="divide-y divide-line">{others.map((r) => row(r, false))}</ul>
        )}
      </section>
    </div>
  );
}
