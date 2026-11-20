import { redirect } from "next/navigation";
import Shell from "@/components/Shell";
import AgentCoreChat from "@/components/AgentCoreChat";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Brightline Help — the customer's chat with the AgentCore agent. Like /refund, it needs a
 * signed-in user: getSession() does the real verification and sends a signed-out visitor
 * to the hosted login. The chat itself runs through /api/agentcore/chat, which keeps the
 * access token on the server.
 */
export default async function AgentCorePage() {
  const session = await getSession();
  if (!session) redirect("/api/auth/login?redirect_uri=/agentcore");

  const first = (session.name ?? "").split(" ")[0] || undefined;
  const configured = !!process.env.AGENTCORE_RUNTIME_URL?.trim();

  return (
    <Shell session={session}>
      <div className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight text-ink font-display">
          {first ? `How can we help, ${first}?` : "How can we help?"}
        </h1>
        <p className="text-sm text-ink-soft">
          Chat with the RefundBot agent. It looks up your orders with tools, and you confirm any
          refund yourself.
        </p>
      </div>
      {configured ? null : (
        <div role="status" className="mb-5 rounded-lg border border-signal/40 bg-signal-soft px-4 py-3 text-sm text-signal-ink">
          The AgentCore runtime isn&apos;t configured on this server (<code>AGENTCORE_RUNTIME_URL</code>
          is not set), so chat replies are unavailable.
        </div>
      )}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,27rem)_minmax(0,1fr)]">
        <AgentCoreChat customerName={session.name} />

        {/* Behind the scenes — reserved for the AgentCore diagram */}
        <section
          aria-label="Behind the scenes"
          className="scroll-mt-6 overflow-hidden rounded-2xl border border-line bg-card shadow-sm"
        >
          <div className="border-b border-line px-5 pt-4">
            <div className="pb-3">
              <h2 className="font-bold text-ink font-display">Behind the scenes</h2>
              <p className="text-xs text-ink-soft">How the agent reaches your orders, step by step.</p>
            </div>
          </div>
          <div className="px-5 py-4">
            <p className="rounded-lg border border-dashed border-line bg-surface px-4 py-6 text-center text-xs text-ink-soft">
              The AgentCore diagram goes here.
            </p>
          </div>
        </section>
      </div>
    </Shell>
  );
}
