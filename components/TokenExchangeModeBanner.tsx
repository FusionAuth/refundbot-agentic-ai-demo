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
  if (mode === "live") {
    return (
      <div
        role="status"
        className="flex items-center gap-2 rounded-lg border border-verified/30 bg-verified-soft px-4 py-2.5 text-sm text-verified"
      >
        <span aria-hidden="true">●</span>
        <span>
          <strong className="font-semibold">Live RFC 8693 Token Exchange.</strong> Every hop
          below is a real FusionAuth token exchange, authorized by whether an Entity Grant
          exists at that moment.
        </span>
      </div>
    );
  }
  return (
    <div
      role="status"
      className="rounded-lg border border-signal/40 bg-signal-soft px-4 py-3 text-sm text-signal-ink"
    >
      <span className="font-semibold">
        Simulated exchange chain — Token Exchange requires a FusionAuth Enterprise plan.
      </span>{" "}
      {reason ? `${reason} ` : ""}Hops are minted locally under the same Grant rule and
      clearly labeled; nothing here is a FusionAuth decision.
    </div>
  );
}
