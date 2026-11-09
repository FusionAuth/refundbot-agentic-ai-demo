import type {
  ApprovalState,
  ChainEntry,
  ExchangeHopEntry,
  ExchangeMode,
  TraceNoteEntry,
} from "@/lib/refund-types";

/**
 * The exchange-chain trace — RefundBot's replacement for the authorization trace.
 *
 * One card per hop, each showing the same five facts so the eye can run down the column
 * and see what changes and what doesn't:
 *
 *   service → audience requested → act (always the orchestrator) → sub (always the
 *   customer) → sid (always the same login session) → ALLOWED / DENIED + FusionAuth's
 *   own reason, verbatim.
 *
 * The audience changes every hop; act, sub, and sid never do. That's the picture of
 * "a fresh, narrower token per service, all provably for the same customer in the same
 * conversation."
 *
 * Hop 4 also shows both approval states and — once they land — the banking Grant's
 * create → use → revoke lifecycle. The revoke row is deliberately the loudest thing on
 * the card: the authority existed for one exchange and is gone again.
 */

function short(value?: string, keep = 8): string {
  if (!value) return "—";
  return value.length > keep * 2 + 1 ? `${value.slice(0, keep)}…${value.slice(-4)}` : value;
}

function Fact({ k, v, title, emphasize }: { k: string; v: string; title?: string; emphasize?: boolean }) {
  return (
    <div className="flex gap-2 text-xs" title={title}>
      <span className="w-16 shrink-0 text-ink-soft font-mono">{k}</span>
      <span
        className={`min-w-0 break-all font-mono ${emphasize ? "font-semibold text-ink" : "text-ink"}`}
      >
        {v}
      </span>
    </div>
  );
}

function approvalChip(label: string, state: ApprovalState, who?: string) {
  const tone =
    state === "approved"
      ? "bg-verified-soft text-verified"
      : state === "denied" || state === "declined"
        ? "bg-denied-soft text-denied"
        : state === "not_required"
          ? "bg-surface text-ink-soft"
          : "bg-signal-soft text-signal-ink";
  return (
    <span className={`rounded-full px-2 py-0.5 text-[0.7rem] font-semibold ${tone}`}>
      {label}: {state.replace("_", " ")}
      {who ? ` · ${who}` : ""}
    </span>
  );
}

function HopCard({ hop, customerId, sid }: { hop: ExchangeHopEntry; customerId?: string; sid?: string }) {
  const verdict =
    hop.exchange === "allowed"
      ? { text: "ALLOWED", cls: "bg-verified-soft text-verified" }
      : hop.exchange === "denied"
        ? { text: "DENIED", cls: "bg-denied-soft text-denied" }
        : { text: "NOT ATTEMPTED", cls: "bg-surface text-ink-soft" };
  const kind =
    hop.grantKind === "standing"
      ? "standing Grant"
      : hop.grantKind === "probe"
        ? "no Grant · pre-approval probe"
        : "on-demand Grant";
  const subMatches = hop.sub && customerId ? hop.sub === customerId : undefined;
  const sidMatches = hop.sid && sid ? hop.sid === sid : undefined;

  return (
    <li className="rounded-lg border border-line bg-card p-3 ia-animate-in">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-ink px-1.5 py-0.5 text-[0.65rem] font-bold text-white font-mono">
          HOP {hop.hop}
        </span>
        <span className="font-semibold text-ink">{hop.serviceLabel}</span>
        <span className="text-[0.7rem] text-ink-soft font-mono">{hop.tool}</span>
        <span className="ml-auto flex items-center gap-1.5">
          <span className="text-[0.65rem] uppercase tracking-wide text-ink-soft">{kind}</span>
          <span className={`rounded-full px-2 py-0.5 text-xs font-bold font-mono ${verdict.cls}`}>
            {verdict.text}
          </span>
        </span>
      </div>

      <div className="mt-2 space-y-0.5">
        <Fact k="audience" v={hop.audience} emphasize />
        {hop.exchange === "allowed" ? (
          <>
            <Fact k="act" v={`${hop.act ?? "—"}${hop.actProfile ? ` (${hop.actProfile})` : ""}`} />
            <Fact
              k="sub"
              v={`${short(hop.sub, 12)}${subMatches === true ? "  ✓ customer" : subMatches === false ? "  ✗ NOT the customer" : ""}`}
              title={hop.sub}
            />
            <Fact
              k="sid"
              v={`${short(hop.sid, 12)}${sidMatches === true ? "  ✓ same session" : sidMatches === false ? "  ✗ different" : ""}`}
              title={hop.sid}
            />
            <Fact k="jti" v={short(hop.jti, 12)} title={hop.jti} />
            {hop.approvedByClaim ? <Fact k="approved_by" v={hop.approvedByClaim} emphasize /> : null}
          </>
        ) : null}
      </div>

      {hop.reason ? (
        <p
          className={`mt-2 rounded px-2 py-1 text-xs font-mono ${
            hop.exchange === "denied" ? "bg-denied-soft text-denied" : "bg-surface text-ink-soft"
          }`}
        >
          {hop.exchange === "denied" ? "FusionAuth: " : ""}
          {hop.reason}
          {hop.outcome ? ` · outcome ${hop.outcome}` : ""}
        </p>
      ) : null}

      {hop.approvals ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {approvalChip("customer", hop.approvals.customer)}
          {approvalChip("employee", hop.approvals.employee, hop.approvals.employeeName)}
        </div>
      ) : null}

      {hop.grant && hop.grant.length > 0 ? (
        <ol className="mt-2 space-y-1 border-l-2 border-signal/50 pl-3">
          {hop.grant.map((g, i) => (
            <li
              key={i}
              className={`text-xs ${
                g.step === "revoke"
                  ? `rounded px-2 py-1 font-semibold ${g.ok ? "bg-verified-soft text-verified" : "bg-denied-soft text-denied"}`
                  : "text-ink"
              }`}
            >
              <span className="mr-1 font-mono uppercase">
                {g.step === "create" ? "① create" : g.step === "use" ? "② use" : "③ revoke"}
              </span>
              {g.ok ? "" : "FAILED — "}
              {g.detail}
            </li>
          ))}
        </ol>
      ) : null}

      {hop.approvedByPath && hop.approvedByPath !== "not required" ? (
        <p className="mt-2 text-xs text-ink">
          <strong>Employee approval backed by:</strong>{" "}
          {hop.approvedByPath === "claim"
            ? "the approved_by claim on the FusionAuth-signed token (checked against the record)"
            : "banking-api's own lookup of the approval record for this sid (no approved_by claim on the token)"}
        </p>
      ) : null}

      {hop.mcp && hop.mcp.status !== "skipped" ? (
        <p
          className={`mt-2 text-xs ${hop.mcp.status === "allowed" ? "text-verified" : "text-denied"}`}
        >
          <span className="font-semibold">mcp server:</span> {hop.mcp.detail}
        </p>
      ) : null}
      {hop.result ? <p className="mt-1 text-xs font-medium text-ink">→ {hop.result}</p> : null}
    </li>
  );
}

function NoteRow({ note }: { note: TraceNoteEntry }) {
  const tone =
    note.status === "allowed"
      ? "text-verified"
      : note.status === "denied" || note.status === "error"
        ? "text-denied"
        : note.status === "required"
          ? "text-signal-ink"
          : "text-brand-ink";
  return (
    <li className="px-1 ia-animate-in">
      <p className={`text-xs font-semibold ${tone}`}>
        <span className="mr-1.5 text-[0.65rem] uppercase tracking-wide text-ink-soft font-mono">
          {note.layer}
        </span>
        {note.label}
      </p>
      {note.detail ? <p className="text-xs text-ink-soft">{note.detail}</p> : null}
    </li>
  );
}

export default function ExchangeChainTrace({
  entries,
  sid,
  customerId,
  mode,
  title = "Exchange chain",
}: {
  entries: ChainEntry[];
  sid?: string;
  customerId?: string;
  mode?: ExchangeMode;
  title?: string;
}) {
  return (
    <div className="rounded-xl border border-line bg-card shadow-sm">
      <div className="border-b border-line px-5 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-bold text-ink font-display">{title}</h2>
          {mode ? (
            <span
              className={`rounded-full px-2 py-0.5 text-[0.65rem] font-semibold ${
                mode === "live" ? "bg-verified-soft text-verified" : "bg-signal-soft text-signal-ink"
              }`}
            >
              {mode === "live" ? "RFC 8693 · live" : "simulated"}
            </span>
          ) : null}
        </div>
        <p className="text-xs text-ink-soft">
          One token exchange per hop. The audience narrows each time; <code>act</code>,{" "}
          <code>sub</code>, and <code>sid</code> never change.
          {sid ? (
            <>
              {" "}Session <code className="font-mono" title={sid}>{short(sid, 10)}</code>.
            </>
          ) : null}
        </p>
      </div>
      {entries.length === 0 ? (
        <p className="px-5 py-6 text-sm text-ink-soft">
          Ask for a refund to watch the orchestrator trade the customer&rsquo;s token, hop by hop.
        </p>
      ) : (
        <ol className="space-y-2.5 px-4 py-4">
          {entries.map((e, i) =>
            e.type === "hop" ? (
              <HopCard key={i} hop={e} customerId={customerId} sid={sid} />
            ) : (
              <NoteRow key={i} note={e} />
            )
          )}
        </ol>
      )}
    </div>
  );
}
