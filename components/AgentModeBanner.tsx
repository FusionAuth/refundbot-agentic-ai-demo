/**
 * The honest agent-mode banner — mirrors InFusion Market's "Live FGA / demo
 * mode" banner. When ANTHROPIC_API_KEY is set the planner is a real Claude
 * tool-calling loop; when it isn't, a deterministic scripted planner drives tool
 * selection. Crucially, the AUTHORIZATION behavior is identical either way — the
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
      for live mode. A deterministic keyword planner is selecting tools right now.
      It still makes real MCP calls, real scope checks, and real step-up — only
      the &ldquo;which tool&rdquo; decision is rule-based.
    </div>
  );
}
