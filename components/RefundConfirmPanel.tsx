"use client";

import { useState } from "react";
import Link from "next/link";
import RefundConfirmationSlip, { type StepUpMethod } from "@/components/RefundConfirmationSlip";
import {
  formatUsd,
  refundConfirmAction,
  type RefundRequestView,
  type RefundTurnResponse,
} from "@/lib/refund-types";

/**
 * The out-of-band confirmation for a refund requested from a chat app (ChatGPT /
 * claude.ai via /mcp). Same round trip as the web chat's slip:
 * /api/two-factor/status → (/verify) → POST /api/refund { action: "confirm" }.
 */
export default function RefundConfirmPanel({
  initial,
  initialReply,
  embedded = false,
}: {
  initial: RefundRequestView;
  initialReply: string;
  /**
   * Inside a chat: drop the closing "close this tab / open RefundBot" footer, and the intro
   * line while the confirmation is still pending (the chat has already said it). The result
   * message after the customer decides still shows.
   */
  embedded?: boolean;
}) {
  const [view, setView] = useState(initial);
  const [reply, setReply] = useState(initialReply);
  const [phase, setPhase] = useState<"confirm" | "code">("confirm");
  const [twoFactorId, setTwoFactorId] = useState<string>();
  const [enroll, setEnroll] = useState(false);
  const [methods, setMethods] = useState<StepUpMethod[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const pending = view.decision === "awaiting_approvals" && view.customer.state === "pending";
  const action = refundConfirmAction(view.id);

  async function decide(decision: "confirm" | "decline") {
    const res = await fetch("/api/refund", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: decision, requestId: view.id }),
    });
    const d = (await res.json()) as RefundTurnResponse | { error: string };
    if ("error" in d) return setError(d.error);
    if (d.request) setView(d.request);
    setReply(d.reply);
    setError(undefined);
  }

  async function beginConfirm() {
    setBusy(true);
    try {
      const res = await fetch("/api/two-factor/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const d = (await res.json()) as {
        challengeRequired?: boolean;
        twoFactorId?: string;
        methods?: StepUpMethod[];
        enroll?: boolean;
        error?: string;
      };
      if (!res.ok) return setError(d.error ?? "Couldn't start the confirmation.");
      if (!d.challengeRequired) return await decide("confirm");
      setTwoFactorId(d.twoFactorId);
      setEnroll(d.enroll === true);
      setMethods(d.methods ?? []);
      setPhase("code");
      setError(undefined);
    } catch {
      setError("Couldn't reach the confirmation service.");
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(code: string) {
    setBusy(true);
    try {
      const res = await fetch("/api/two-factor/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ twoFactorId, enroll, code, action }),
      });
      const d = (await res.json()) as { verified?: boolean; error?: string };
      if (!res.ok || !d.verified) return setError(d.error ?? "Incorrect code. Try again.");
      await decide("confirm");
    } catch {
      setError("Verification failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function decline() {
    setBusy(true);
    try {
      await decide("decline");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-md space-y-4">
      {embedded && pending ? null : <p className="text-sm text-ink">{reply}</p>}
      {pending ? (
        <RefundConfirmationSlip
          heading="Confirm your refund"
          title={`${view.orderSummary ?? view.orderId} · ${formatUsd(view.amountCents ?? 0)}`}
          phase={phase}
          methods={methods}
          busy={busy}
          error={error}
          onConfirm={beginConfirm}
          onSubmit={submitCode}
          onCancel={decline}
          cancelLabel="No, cancel it"
        />
      ) : embedded ? null : (
        <p className="text-sm text-ink-soft">
          You can close this tab and go back to your chat — ask it for the refund status any
          time. <Link href="/refund" className="underline">Open RefundBot</Link>
        </p>
      )}
    </div>
  );
}
