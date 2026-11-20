"use client";

import { useState } from "react";
import AgentCoreChat from "@/components/AgentCoreChat";
import AgentCoreBehindTheScenes from "@/components/AgentCoreBehindTheScenes";
import type { ExchangeMode, RefundRequestView } from "@/lib/refund-types";

/**
 * The /agentcore two-column layout (same grid as /refund): the chat on the left, "Behind the
 * scenes" on the right. The chat reports the refund the agent started, as it changes, and the
 * right panel shows it.
 */
export default function AgentCoreWorkspace({
  customerName,
  customerId,
  exchangeMode,
}: {
  customerName?: string;
  customerId: string;
  exchangeMode: ExchangeMode;
}) {
  const [active, setActive] = useState<RefundRequestView | undefined>();
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,27rem)_minmax(0,1fr)]">
      <AgentCoreChat customerName={customerName} customerId={customerId} onActiveRequest={setActive} />
      <AgentCoreBehindTheScenes active={active} customerId={customerId} mode={exchangeMode} />
    </div>
  );
}
