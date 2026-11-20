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
      <AgentCoreChat customerName={session.name} />
    </Shell>
  );
}
