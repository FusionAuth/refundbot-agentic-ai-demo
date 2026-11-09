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
 * RefundBot — the customer-facing surface. proxy.ts bounces signed-out visitors to the
 * hosted login (any FusionAuth login method works; passwordless is a nice touch); this
 * page does the real verification via getSession().
 */
export default async function RefundPage() {
  const session = await getSession();
  if (!session) redirect("/api/auth/login?redirect_uri=/refund");

  const exchange = await resolveExchangeMode();
  const mode = agentMode();

  return (
    <Shell session={session}>
      <div className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight text-ink font-display">
          RefundBot
        </h1>
        <p className="text-sm text-ink-soft">
          Signed in as {session.name ?? session.email ?? "you"}. Four services, four
          exchanged tokens, and nothing irreversible without your say-so.
        </p>
      </div>
      <div className="mb-5 space-y-3">
        <TokenExchangeModeBanner
          mode={exchange.mode}
          reason={exchange.mode === "simulated" ? exchange.reason : undefined}
        />
        <AgentModeBanner mode={mode} />
      </div>
      <RefundChat customerId={session.userId} exchangeMode={exchange.mode} />
    </Shell>
  );
}
