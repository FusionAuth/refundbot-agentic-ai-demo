import { redirect } from "next/navigation";
import Shell from "@/components/Shell";
import AgentModeBanner from "@/components/AgentModeBanner";
import TokenExchangeModeBanner from "@/components/TokenExchangeModeBanner";
import RefundChat from "@/components/RefundChat";
import { getSession } from "@/lib/session";
import { agentMode } from "@/lib/agent";
import { resolveExchangeMode } from "@/lib/token-exchange";

export const dynamic = "force-dynamic";

/**
 * Brightline Help — the customer's chat with RefundBot. proxy.ts bounces signed-out
 * visitors to the hosted login; getSession() does the real verification here.
 *
 * The mode banners render only on a degrade (simulated chain / scripted planner): live
 * is the expected state and isn't announced.
 */
export default async function RefundPage() {
  const session = await getSession();
  if (!session) redirect("/api/auth/login?redirect_uri=/refund");

  const exchange = await resolveExchangeMode();
  const first = (session.name ?? "").split(" ")[0] || undefined;

  return (
    <Shell session={session}>
      <div className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight text-ink font-display">
          {first ? `How can we help, ${first}?` : "How can we help?"}
        </h1>
        <p className="text-sm text-ink-soft">
          Chat with RefundBot about any order from the last 90 days.
        </p>
      </div>
      <div className="space-y-3 empty:hidden">
        <TokenExchangeModeBanner
          mode={exchange.mode}
          reason={exchange.mode === "simulated" ? exchange.reason : undefined}
        />
        <AgentModeBanner mode={agentMode()} />
      </div>
      <RefundChat customerId={session.userId} customerName={session.name} exchangeMode={exchange.mode} />
    </Shell>
  );
}
