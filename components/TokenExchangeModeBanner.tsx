/**
 * The honest token-exchange banner — the same shape as AgentModeBanner and
 * FgaModeBanner. On the Enterprise instance this demo targets it always reads "Live RFC
 * 8693 Token Exchange". The simulated variant exists so the app degrades honestly if it's
 * ever pointed at an instance that can't do the real thing.
 */
export default function TokenExchangeModeBanner({
  mode,
  reason,
}: {
  mode: "live" | "simulated";
  reason?: string;
}) {
  // Live is the expected state and needs no announcement — only a degrade is shown.
  if (mode === "live") return null;
  return (
    <div
      role="status"
      className="rounded-lg border border-signal/40 bg-signal-soft px-4 py-3 text-sm text-signal-ink"
    >
      <span className="font-semibold">
        Simulated exchange chain — Token Exchange requires a FusionAuth Enterprise plan.
      </span>{" "}
      {reason ? `${reason} ` : ""}
      <a
        href="https://fusionauth.io/docs/concepts/plans-and-limits/plans-features"
        target="_blank"
        rel="noopener noreferrer"
        className="underline"
      >
        Compare plans ↗
      </a>
      . Hops are minted locally under the same Grant rule and
      clearly labeled; nothing here is a FusionAuth decision.
    </div>
  );
}
