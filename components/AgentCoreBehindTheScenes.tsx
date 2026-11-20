"use client";

import { useState } from "react";
import ExchangeChainTrace from "@/components/ExchangeChainTrace";
import AgentCoreArchitectureDiagram from "@/components/AgentCoreArchitectureDiagram";
import PermissionsGraph from "@/components/PermissionsGraph";
import DocLink from "@/components/DocLink";
import type { ExchangeMode, RefundRequestView } from "@/lib/refund-types";

/**
 * The "Behind the scenes" card on /agentcore: the same shell, tab bar and panels as the right
 * side of components/RefundChat.tsx, with the AgentCore architecture on the Architecture tab.
 * Token chain and Permissions are fed by the refund the agent started (the same
 * RefundRequestView the confirm panel loads from GET /api/refund?requestId=…), and show
 * RefundChat's own empty text until one exists.
 */
export default function AgentCoreBehindTheScenes({
  active,
  customerId,
  mode,
}: {
  active?: RefundRequestView;
  customerId: string;
  mode: ExchangeMode;
}) {
  const [tab, setTab] = useState<"chain" | "diagram" | "permissions">("diagram");
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <section
        aria-label="Behind the scenes"
        className="scroll-mt-6 overflow-hidden rounded-2xl border border-line bg-card shadow-sm"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 pt-4">
          <div className="pb-3">
            <p className="text-[0.62rem] font-semibold uppercase tracking-wider text-brand-ink">
              Behind the scenes
            </p>
            <h2 className="font-bold text-ink font-display">
              {active ? `${active.orderSummary ?? active.orderId}` : "How the agent is authorized"}
            </h2>
            <p className="text-xs text-ink-soft">
              {tab === "permissions" ? (
                <>Relationship + attribute checks in FusionAuth FGA — a separate system from the token chain.</>
              ) : tab === "diagram" ? (
                <>How a chat message reaches your orders through AgentCore.</>
              ) : (
                <>
                  Each tool call uses a{" "}
                  <DocLink to="tokenExchange">narrow FusionAuth token</DocLink>. Identity and
                  ownership are checked at every step.
                </>
              )}
            </p>
          </div>
          <div role="tablist" className="flex gap-1 self-end">
            {(
              [
                ["chain", "Token chain"],
                ["diagram", "Architecture"],
                ["permissions", "Permissions"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={`-mb-px rounded-t-lg border-b-2 px-3 py-2 text-sm font-medium ${
                  tab === key
                    ? "border-brand text-brand-ink"
                    : "border-transparent text-ink-soft hover:text-ink"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="max-h-[calc(100vh-14rem)] overflow-y-auto px-5 py-4">
          {tab === "chain" ? (
            <>
              {active ? (
                <p className="mb-3 rounded-lg border border-line bg-surface px-3 py-2 text-xs text-ink-soft">
                  This is the refund pipeline&apos;s own record for the refund the agent started
                  (POST /api/agent/refund): the ownership check, then each token exchange and
                  service call. The agent&apos;s own lookups through the gateway aren&apos;t part
                  of this trace.
                </p>
              ) : null}
              <ExchangeChainTrace
                embedded
                entries={active?.trace ?? []}
                sid={active?.sid}
                customerId={customerId}
                mode={active?.mode ?? mode}
                onShowPermissions={() => setTab("permissions")}
              />
            </>
          ) : tab === "permissions" ? (
            <PermissionsGraph request={active} />
          ) : (
            <>
              <div className="mb-2 flex justify-start">
                <button
                  type="button"
                  onClick={() => setExpanded(true)}
                  className="rounded-full border border-line px-3 py-1 text-xs font-medium text-ink hover:bg-surface"
                >
                  ⤢ Expand
                </button>
              </div>
              <AgentCoreArchitectureDiagram embedded />
            </>
          )}
        </div>
      </section>

      {expanded ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="AgentCore architecture"
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4"
          onClick={() => setExpanded(false)}
          onKeyDown={(e) => e.key === "Escape" && setExpanded(false)}
        >
          <div
            className="max-h-full w-full max-w-7xl overflow-auto rounded-2xl bg-card p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-bold text-ink font-display">AgentCore architecture</h2>
              <button
                type="button"
                autoFocus
                onClick={() => setExpanded(false)}
                className="rounded-full border border-line px-3 py-1 text-sm text-ink hover:bg-surface"
              >
                Close
              </button>
            </div>
            <AgentCoreArchitectureDiagram embedded />
          </div>
        </div>
      ) : null}
    </>
  );
}
