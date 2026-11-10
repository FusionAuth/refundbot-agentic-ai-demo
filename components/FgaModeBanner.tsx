/**
 * The honest FGA banner — the same live / fallback distinction as InFusion Market's.
 * Live: a quiet one-liner saying a real Permify server is answering. Fallback: every
 * ownership, cascade, and tier decision on the page came from the in-memory resolver in
 * lib/fga.ts (same rules, hand-written), and we say so instead of pretending.
 */
export default function FgaModeBanner({ mode }: { mode: "live" | "demo" }) {
  if (mode === "live") {
    return (
      <div
        role="status"
        className="flex items-center gap-2 rounded-lg border border-verified/30 bg-verified-soft px-4 py-2 text-sm text-verified"
      >
        <span className="h-2 w-2 rounded-full bg-verified" aria-hidden />
        <span className="font-semibold">Live FusionAuth FGA</span>
        <span className="text-ink-soft">
          — ownership, approval cascade, and trust tier are checked against a running
          Permify server.
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
        Demo fallback — static ownership/cap rules, no Permify reachable.
      </span>{" "}
      Nothing answered at <code className="font-mono">PERMIFY_URL</code>, so the same
      ownership, cascade, and tier behaviors are being decided by an in-memory resolver in
      app code. Start Permify (see the README); the schema and demo data load themselves
      and these checks go live within 30 seconds.
    </div>
  );
}
