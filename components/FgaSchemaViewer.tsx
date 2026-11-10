"use client";

import { useState } from "react";

/**
 * Shows the actual Permify schema inside the app, so the "why" behind a resource
 * decision is one click away during a demo. Highlighted: the line that reaches through a
 * relation into another entity (`account.request_refund`) and the rule calls that read
 * an entity's own attributes (`can_approve_amount(cap_cents)`).
 */
export default function FgaSchemaViewer({ schema }: { schema: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const lines = schema.replace(/\s+$/, "").split("\n");

  return (
    <div className="rounded-xl border border-line bg-card shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left"
      >
        <span>
          <span className="block font-bold text-ink font-display">
            The Permify schema
          </span>
          <span className="mt-0.5 block text-sm text-ink-soft">
            <code className="font-mono">
              permify/schema.perm
            </code>{" "}
            — the source of truth for every resource decision.
          </span>
        </span>
        <span className="shrink-0 rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-ink">
          {open ? "Hide" : "Show schema"}
        </span>
      </button>

      {open ? (
        <div className="ia-animate-in border-t border-line p-4">
          <div className="mb-2 flex justify-end">
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(schema);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                } catch {
                  // clipboard blocked — no-op
                }
              }}
              className="rounded-md border border-line px-2.5 py-1 text-xs font-medium text-ink transition hover:bg-surface"
            >
              {copied ? "Copied ✓" : "Copy .perm"}
            </button>
          </div>
          <pre className="overflow-x-auto rounded-lg border border-line bg-ink px-4 py-3 text-xs leading-relaxed text-white">
            <code className="font-mono">
              {lines.map((line, i) => {
                // A permission that reaches through a relation into another entity.
                const isCascade = /=\s*.*(\b\w+\.\w+|\w+\(\w+\))/.test(line);
                return (
                  <span
                    key={i}
                    className={
                      isCascade
                        ? "block rounded bg-fga/30 px-1 text-white"
                        : "block px-1"
                    }
                  >
                    {line || " "}
                  </span>
                );
              })}
            </code>
          </pre>
          <p className="mt-3 text-xs text-ink-soft">
            <code className="font-mono">order#request_refund</code> reaches <em>through</em>{" "}
            the order&rsquo;s <code className="font-mono">account</code> to its owner or
            delegate; the approval and auto-approval actions combine a relation with a rule
            over that same entity&rsquo;s <code className="font-mono">cap_cents</code>,
            compared against <code className="font-mono">context.data.refund_amount_cents</code>.
            Permify evaluates it; the app just asks.
          </p>
        </div>
      ) : null}
    </div>
  );
}
