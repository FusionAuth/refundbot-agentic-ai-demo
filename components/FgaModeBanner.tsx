/**
 * The honest "not talking to a live Permify server" banner, the same shape as
 * AgentModeBanner's scripted/live distinction. When Permify is reachable this says so
 * plainly; when it isn't, every resource decision on the page came from the in-memory
 * app-code cascade resolver in lib/fga.ts — the very thing FGA exists to replace — and
 * we say that instead of pretending.
 */
export default function FgaModeBanner({ mode }: { mode: "live" | "demo" }) {
  // Live is the expected state and needs no announcement — only a degrade is shown.
  if (mode === "live") return null;
  return (
    <div
      role="status"
      className="rounded-lg border border-signal/40 bg-signal-soft px-4 py-3 text-sm text-signal-ink"
    >
      <span className="font-semibold">Showing demo authorization.</span> No Permify
      server is reachable at{" "}
      <code className="font-mono">PERMIFY_URL</code>, so the
      resource-level decisions came from an in-memory app-code cascade resolver — the
      very thing FGA replaces. Start Permify (see the README); the schema loads itself
      and these checks go live.
    </div>
  );
}
