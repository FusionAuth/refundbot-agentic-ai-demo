"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface ResetResult {
  scope: "all" | "customer";
  orderBooksCleared: number;
  requestsCleared: number;
  budgetRefilled: boolean;
  bankingGrant: string;
  error?: string;
}

/**
 * The /admin "Reset demo data" control — RefundBot's state lives in memory, and on a
 * hosted deploy a restart is the wrong tool for "start the demo over".
 */
export default function DemoResetPanel({ customers }: { customers: string[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function reset() {
    const scope = target ? `${target}'s orders and requests` : "ALL orders, requests, and the budget";
    if (!window.confirm(`Reset ${scope}?`)) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/reset-demo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(target ? { customerEmail: target } : {}),
      });
      const d = (await res.json()) as ResetResult;
      if (!res.ok) {
        setMsg({ ok: false, text: d.error ?? `Reset failed (${res.status}).` });
      } else {
        setMsg({
          ok: d.bankingGrant !== "remove_failed",
          text:
            `Cleared ${d.requestsCleared} request(s) and ${d.orderBooksCleared} order book(s)` +
            `${d.budgetRefilled ? "; budget refilled" : ""}. banking-api Grant: ${
              d.bankingGrant === "none"
                ? "none, as expected"
                : d.bankingGrant === "removed"
                  ? "a stray one was found and removed"
                  : d.bankingGrant === "remove_failed"
                    ? "a stray one exists and COULDN'T be removed — delete it in FusionAuth"
                    : "couldn't check"
            }.`,
        });
        router.refresh();
      }
    } catch {
      setMsg({ ok: false, text: "Couldn't reach the reset endpoint." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-line bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          disabled={busy}
          className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
        >
          <option value="">Everyone (full reset)</option>
          {customers.map((c) => (
            <option key={c} value={c}>
              Only {c}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={reset}
          disabled={busy}
          className="rounded-lg bg-signal px-4 py-2 text-sm font-semibold text-white hover:brightness-95 disabled:opacity-50"
        >
          {busy ? "Resetting…" : "Reset demo data"}
        </button>
      </div>
      <p className="mt-2 text-xs text-ink-soft">
        Orders go back to unrefunded, the approval queue empties, and the banking-api Grant
        is confirmed absent. Permify relations, FusionAuth users, Entities, standing
        Grants, and its audit log are untouched. No restart.
      </p>
      {msg ? (
        <p role="status" className={`mt-2 text-sm font-medium ${msg.ok ? "text-verified" : "text-denied"}`}>
          {msg.text}
        </p>
      ) : null}
    </div>
  );
}
