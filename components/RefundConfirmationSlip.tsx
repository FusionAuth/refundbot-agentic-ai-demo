"use client";

import { useState } from "react";

export interface StepUpMethod {
  id: string;
  method: string;
  email?: string;
  mobilePhone?: string;
}

interface RefundConfirmationSlipProps {
  /** One line under the heading — what's being confirmed. */
  title: string;
  /** Defaults to "Confirm it's you". RefundBot sets "Confirm your refund". */
  heading?: string;
  /**
   * "confirm" — the customer hasn't decided yet: Yes / No buttons. Yes starts the
   *             FusionAuth step-up round trip (which may or may not need a code).
   * "code"    — FusionAuth asked for a fresh two-factor code; enter it.
   */
  phase?: "confirm" | "code";
  methods: StepUpMethod[];
  busy: boolean;
  error?: string;
  onConfirm?: () => void;
  onSubmit: (code: string) => void;
  onCancel: () => void;
  cancelLabel?: string;
}

function methodHint(methods: StepUpMethod[]): string {
  const m = methods[0];
  if (!m) return "Enter the verification code to continue.";
  if (m.method === "email")
    return `We sent a code to ${m.email ?? "your email on file"}.`;
  if (m.method === "sms")
    return `We texted a code to ${m.mobilePhone ?? "your phone on file"}.`;
  return "Enter the code from your authenticator app.";
}

/**
 * The customer's out-of-band refund confirmation — the two-factor step-up slip,
 * repurposed (it was StepUpSlip). Styled as the perforated slip, the shared portfolio
 * motif. Presentational only; the parent owns state and drives the
 * /api/two-factor/status → /verify round trip.
 *
 * For RefundBot this is one of the two independent approvals hop 4 needs: the customer
 * saying, through FusionAuth rather than through the chat box, "yes, I want this." A
 * customer's own agent can type anything into the chat; it can't complete this.
 */
export default function RefundConfirmationSlip({
  title,
  heading = "Confirm it\u2019s you",
  phase = "code",
  methods,
  busy,
  error,
  onConfirm,
  onSubmit,
  onCancel,
  cancelLabel = "Cancel",
}: RefundConfirmationSlipProps) {
  const [code, setCode] = useState("");

  return (
    <div className="overflow-hidden rounded-xl border border-signal/40 bg-card shadow-md">
      <div className="flex items-center gap-2 bg-signal-soft px-5 py-3">
        <span className="text-xl" aria-hidden="true">
          🔐
        </span>
        <div>
          <p className="text-sm font-bold text-signal-ink font-display">
            {heading}
          </p>
          <p className="text-xs text-signal-ink/80">{title}</p>
        </div>
      </div>

      {phase === "confirm" ? (
        <div className="ia-perforated space-y-3 px-5 py-4">
          <p className="text-sm text-ink-soft">
            Refunds are irreversible. Confirming here goes through FusionAuth, not the chat —
            you may be asked for a verification code.
          </p>
          {error ? (
            <p className="text-sm font-medium text-signal-ink" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onConfirm}
              disabled={busy}
              className="flex-1 rounded-lg bg-signal px-4 py-2.5 font-semibold text-white transition hover:brightness-95 disabled:opacity-50"
            >
              {busy ? "Checking…" : "Yes, refund it"}
            </button>
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="rounded-lg border border-line px-4 py-2.5 font-medium text-ink hover:bg-surface disabled:opacity-50"
            >
              {cancelLabel}
            </button>
          </div>
        </div>
      ) : (
        <form
          className="ia-perforated space-y-3 px-5 py-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (code.trim()) onSubmit(code.trim());
          }}
        >
          <p className="text-sm text-ink-soft">{methodHint(methods)}</p>
          <div>
            <label className="sr-only" htmlFor="stepup-code">
              Verification code
            </label>
            <input
              id="stepup-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              autoFocus
              className="w-full rounded-lg border border-line bg-surface px-4 py-2.5 text-center text-lg tracking-[0.5em] text-ink font-mono focus:border-signal focus:outline-none"
            />
          </div>
          {error ? (
            <p className="text-sm font-medium text-signal-ink" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy || !code.trim()}
              className="flex-1 rounded-lg bg-signal px-4 py-2.5 font-semibold text-white transition hover:brightness-95 disabled:opacity-50"
            >
              {busy ? "Verifying…" : "Verify & continue"}
            </button>
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="rounded-lg border border-line px-4 py-2.5 font-medium text-ink hover:bg-surface disabled:opacity-50"
            >
              {cancelLabel}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
