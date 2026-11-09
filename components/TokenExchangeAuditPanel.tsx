import Link from "next/link";
import ExchangeChainTrace from "@/components/ExchangeChainTrace";
import TokenExchangeModeBanner from "@/components/TokenExchangeModeBanner";
import DocLink from "@/components/DocLink";
import { allRefunds, toView } from "@/lib/approvals";
import { bankingGrantExists } from "@/lib/entities";
import {
  resolveExchangeMode,
  retrieveExchangeChain,
  searchExchangeAuditLog,
  type AuditLookup,
  type TokenExchangeAuditEntry,
} from "@/lib/token-exchange";
import {
  SERVICE_DEFS,
  audienceFor,
  orchestratorId,
  serviceConfigured,
} from "@/lib/refund-services";

/**
 * /admin's token-exchange panel: the app's own trace for one transaction, side by side
 * with FusionAuth's FIRST-PARTY record of the same exchanges — the Search the Token
 * Exchange Audit Log and Retrieve a Token Exchange Chain APIs. The right column owes
 * nothing to what this app logged; if the two ever disagree, FusionAuth's is the truth.
 */

function AuditTable({ entries, jtis }: { entries: TokenExchangeAuditEntry[]; jtis: Set<string> }) {
  if (entries.length === 0) {
    return <p className="px-4 py-3 text-sm text-ink-soft">No entries.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-line text-left uppercase tracking-wide text-ink-soft">
            <th className="px-3 py-2">When</th>
            <th className="px-3 py-2">Outcome</th>
            <th className="px-3 py-2">Requested aud</th>
            <th className="px-3 py-2">Intent</th>
            <th className="px-3 py-2">Issued jti</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line font-mono">
          {entries.map((e, i) => (
            <tr key={e.eventId ?? i}>
              <td className="px-3 py-1.5 text-ink-soft">
                {e.insertInstant ? new Date(e.insertInstant).toLocaleTimeString() : "—"}
              </td>
              <td className={`px-3 py-1.5 font-semibold ${e.outcome === "SUCCESS" ? "text-verified" : "text-denied"}`}>
                {e.outcome ?? "—"}
                {e.policyDecision ? ` · ${e.policyEngine ?? ""} ${e.policyDecision}` : ""}
              </td>
              <td className="px-3 py-1.5 break-all text-ink">{e.requestedAudience ?? "—"}</td>
              <td className="px-3 py-1.5 break-all text-ink-soft">{e.intent ?? "—"}</td>
              <td className="px-3 py-1.5 break-all text-ink">
                {e.issuedTokenJti ?? "—"}
                {e.issuedTokenJti && jtis.has(e.issuedTokenJti) ? (
                  <span className="ml-1 text-verified">✓ in app trace</span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function lookupError(l: AuditLookup) {
  return l.ok ? null : (
    <p className="px-4 py-3 text-sm text-signal-ink">
      FusionAuth didn&rsquo;t return the log: <code>{l.error}</code>. The API key needs the
      Token Exchange Audit Log read permission.
    </p>
  );
}

export default async function TokenExchangeAuditPanel({ selectedId }: { selectedId?: string }) {
  const exchange = await resolveExchangeMode();
  const grantNow = await bankingGrantExists(exchange.mode);
  const requests = allRefunds().filter((r) => r.issuedJtis.length > 0);
  const selected =
    requests.find((r) => r.id === selectedId) ??
    requests.find((r) => r.decision === "refunded") ??
    requests[0];

  let search: AuditLookup | null = null;
  let chain: AuditLookup | null = null;
  let chainJti: string | undefined;
  if (selected && exchange.mode === "live") {
    const start = Date.parse(selected.createdAt) - 60_000;
    const end = Date.parse(selected.updatedAt) + 60_000;
    search = await searchExchangeAuditLog({ start, end, numberOfResults: 100 });
    if (search.ok) {
      search.entries = search.entries.filter((e) => e.subjectTokenSub === selected.customerId);
    }
    chainJti = selected.issuedJtis[selected.issuedJtis.length - 1];
    if (chainJti) chain = await retrieveExchangeChain(chainJti);
  }
  const jtis = new Set(selected?.issuedJtis ?? []);

  return (
    <div className="space-y-4">
      <TokenExchangeModeBanner mode={exchange.mode} reason={exchange.reason} />

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-line bg-card p-4 shadow-sm">
          <h3 className="text-sm font-bold text-ink">
            <DocLink to="entityManagement">Entities</DocLink>
          </h3>
          <ul className="mt-2 space-y-1 text-xs font-mono">
            <li>
              orchestrator · {orchestratorId()}{" "}
              {process.env.FUSIONAUTH_ORCHESTRATOR_ENTITY_ID ? "" : <span className="text-signal-ink">(not set)</span>}
            </li>
            {SERVICE_DEFS.map((s) => (
              <li key={s.service}>
                hop {s.hop} · {s.label} · {audienceFor(s.service)}{" "}
                {serviceConfigured(s.service) ? "" : <span className="text-signal-ink">(not set)</span>}
                <span className="text-ink-soft"> · {s.standingGrant ? "standing Grant" : "no standing Grant"}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-xl border border-line bg-card p-4 shadow-sm">
          <h3 className="text-sm font-bold text-ink">
            orchestrator → banking-api <DocLink to="entityGrantsApi">Grant</DocLink> right now
          </h3>
          <p
            className={`mt-2 text-sm font-semibold ${
              grantNow === false ? "text-verified" : grantNow === true ? "text-denied" : "text-ink-soft"
            }`}
          >
            {grantNow === false
              ? "None — correct. It exists only inside a hop-4 window."
              : grantNow === true
                ? "EXISTS — outside a hop-4 window this is a standing Grant someone created by hand. Delete it."
                : "Couldn't check (Entity Grant search unavailable)."}
          </p>
          {exchange.version ? (
            <p className="mt-1 text-xs text-ink-soft">FusionAuth {exchange.version}</p>
          ) : null}
        </div>
      </div>

      {requests.length === 0 ? (
        <p className="text-sm text-ink-soft">
          No exchanges yet since the last restart. Run a refund on{" "}
          <Link href="/refund" className="text-brand-ink underline">/refund</Link>, then come back.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {requests.map((r) => (
              <Link
                key={r.id}
                href={`/admin?txn=${r.id}`}
                className={`rounded-full border px-3 py-1 text-xs ${
                  r.id === selected?.id ? "border-brand bg-brand-soft text-brand-ink" : "border-line text-ink-soft"
                }`}
              >
                {r.id} · {r.orderId} · {r.decision.replace("_", " ")}
              </Link>
            ))}
          </div>

          {selected ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <ExchangeChainTrace
                entries={toView(selected).trace}
                sid={selected.sid}
                customerId={selected.customerId}
                mode={selected.mode}
                title="This app's trace"
              />
              <div className="space-y-4">
                <div className="rounded-xl border border-line bg-card shadow-sm">
                  <div className="border-b border-line px-4 py-3">
                    <h3 className="font-bold text-ink font-display">
                      FusionAuth · <DocLink to="auditLogSearch">Token Exchange Audit Log</DocLink>
                    </h3>
                    <p className="text-xs text-ink-soft">
                      <code>GET /api/system/token-exchange-audit-log/search</code> — this
                      orchestrator, this customer, this transaction&rsquo;s time window.
                      Refusals are here too.
                    </p>
                  </div>
                  {exchange.mode !== "live" ? (
                    <p className="px-4 py-3 text-sm text-ink-soft">
                      Simulated mode: FusionAuth performed no exchanges, so it has no record to show.
                    </p>
                  ) : search ? (
                    lookupError(search) ?? <AuditTable entries={search.entries} jtis={jtis} />
                  ) : null}
                </div>
                <div className="rounded-xl border border-line bg-card shadow-sm">
                  <div className="border-b border-line px-4 py-3">
                    <h3 className="font-bold text-ink font-display">
                      FusionAuth · <DocLink to="auditLogChain">Token Exchange Chain</DocLink>
                    </h3>
                    <p className="text-xs text-ink-soft">
                      <code>GET /api/system/token-exchange-audit-log/chain?issuedTokenJti=</code>
                      <code className="break-all">{chainJti ?? "—"}</code>. One entry: every hop
                      exchanged the customer&rsquo;s original token, so no chain nests.
                    </p>
                  </div>
                  {exchange.mode !== "live" ? (
                    <p className="px-4 py-3 text-sm text-ink-soft">Not available in simulated mode.</p>
                  ) : chain ? (
                    lookupError(chain) ?? (
                      <>
                        <AuditTable entries={chain.entries} jtis={jtis} />
                        {chain.entries[0]?.actChain ? (
                          <p className="px-4 pb-3 text-xs text-ink-soft">
                            actChain: <code className="break-all">{chain.entries[0].actChain}</code>
                          </p>
                        ) : null}
                      </>
                    )
                  ) : (
                    <p className="px-4 py-3 text-sm text-ink-soft">No issued token to look up.</p>
                  )}
                </div>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
