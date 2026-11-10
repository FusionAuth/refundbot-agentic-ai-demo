import { redirect } from "next/navigation";
import Shell from "@/components/Shell";
import AgentModeBanner from "@/components/AgentModeBanner";
import TokenExchangeModeBanner from "@/components/TokenExchangeModeBanner";
import RefundChat from "@/components/RefundChat";
import { getSession } from "@/lib/session";
import { agentMode } from "@/lib/agent";
import { resolveExchangeMode } from "@/lib/token-exchange";
import FgaModeBanner from "@/components/FgaModeBanner";
import { syncCustomerFga } from "@/lib/fga";

export const dynamic = "force-dynamic";

/**
 * Brightline Help — the customer's chat with RefundBot. proxy.ts bounces signed-out
 * visitors to the hosted login; getSession() does the real verification here.
 *
 * The Token Exchange and planner banners render only on a degrade; the FGA banner always
 * says which engine is answering ("Live FusionAuth FGA" vs. the demo fallback). Loading
 * the page also writes this customer's Permify relations (owner of their own accounts,
 * delegate on the shared household account) if they don't exist yet.
 */
export default async function RefundPage() {
  const session = await getSession();
  if (!session) redirect("/api/auth/login?redirect_uri=/refund");

  const [exchange, fgaMode] = await Promise.all([
    resolveExchangeMode(),
    syncCustomerFga(session.userId),
  ]);
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
      <div className="mb-5 space-y-3">
        <FgaModeBanner mode={fgaMode} />
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
