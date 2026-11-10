/**
 * The honest planner banner for the customer's RefundBot chat. When ANTHROPIC_API_KEY
 * is set the planner is a real Claude tool-calling turn; when it isn't, a deterministic
 * scripted planner picks the intent. Crucially, the AUTHORIZATION behavior is identical either way — the
 * auth layer never trusts the planner — so the banner is about the planner only.
 */
export default function AgentModeBanner({ mode }: { mode: "live" | "scripted" }) {
  // Live is the expected state and needs no announcement — only a degrade is shown.
  if (mode === "live") return null;
  return (
    <div
      role="status"
      className="rounded-lg border border-signal/40 bg-signal-soft px-4 py-3 text-sm text-signal-ink"
    >
      <span className="font-semibold">Scripted Agent</span> — add{" "}
      <code className="font-mono">ANTHROPIC_API_KEY</code>{" "}
      for live mode. A deterministic keyword planner is reading the chat right now.
      Ownership checks, token exchanges, MCP calls, and step-up are all real — only
      the &ldquo;what did the customer ask for&rdquo; decision is rule-based.
    </div>
  );
}
