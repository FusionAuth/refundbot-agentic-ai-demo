import type {
  ApprovalState,
  ChainEntry,
  ExchangeHopEntry,
  ExchangeMode,
  TraceNoteEntry,
} from "@/lib/refund-types";
import DocLink from "@/components/DocLink";

/**
 * The exchange-chain trace — one timeline row per token exchange.
 *
 * What never changes across hops (`act` = the orchestrator, `sub` = the customer, `sid`
 * = this conversation) is shown ONCE, in the summary strip, with a per-hop ✓ confirming
 * each token actually carried it. What changes — the audience — is the headline of each
 * row. That's the whole RFC 8693 story at a glance: a different, narrower token per
 * service, provably for the same customer in the same session.
 *
 * FusionAuth's refusals are shown verbatim, and on the banking hop the Grant's
 * create → use → revoke lifecycle is drawn inline; revoke is the loudest row.
 *
 * FusionAuth FGA notes (`layer: "fga"`) appear only as dashed breadcrumbs linking to the
 * Permissions tab — that's a different system with different fields, rendered by
 * PermissionsGraph, not merged in here.
 *
 * `embedded` drops the card chrome so the timeline can sit inside another panel (the
 * refund page's "Behind the scenes" tabs); the approval console and /admin use the card.
 */

function short(value?: string, keep = 8): string {
  if (!value) return "—";
  return value.length > keep + 5 ? `${value.slice(0, keep)}…${value.slice(-4)}` : value;
}

const APPROVAL_TONE: Record<ApprovalState, string> = {
  approved: "bg-verified-soft text-verified",
  denied: "bg-denied-soft text-denied",
  declined: "bg-denied-soft text-denied",
  not_required: "bg-surface text-ink-soft",
  pending: "bg-signal-soft text-signal-ink",
};

function Chip({ children, tone }: { children: React.ReactNode; tone: string }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-[0.68rem] font-semibold ${tone}`}>
      {children}
    </span>
  );
}

function HopRow({
  hop,
  customerId,
  sid,
  last,
}: {
  hop: ExchangeHopEntry;
  customerId?: string;
  sid?: string;
  last: boolean;
}) {
  const allowed = hop.exchange === "allowed";
  const skipped = hop.exchange === "skipped";
  const dot = allowed
    ? "bg-verified text-white"
    : skipped
      ? "bg-card text-ink-soft border border-line"
      : "bg-denied text-white";
  const verdict = allowed ? "Token issued" : skipped ? "Not attempted" : "Refused";
  const verdictTone = allowed
    ? "text-verified"
    : skipped
      ? "text-ink-soft"
      : "text-denied";
  const subOk = hop.sub && customerId ? hop.sub === customerId : undefined;
  const sidOk = hop.sid && sid ? hop.sid === sid : undefined;
  const grantLabel =
    hop.grantKind === "standing"
      ? "standing Grant"
      : hop.grantKind === "probe"
        ? "no Grant yet"
        : "on-demand Grant";

  return (
    <li className="relative flex gap-3 pb-4 ia-animate-in">
      {!last ? (
        <span aria-hidden className="absolute top-7 bottom-0 left-[0.8rem] w-px bg-line" />
      ) : null}
      <span
        className={`relative z-10 flex h-[1.6rem] w-[1.6rem] shrink-0 items-center justify-center rounded-full text-[0.7rem] font-bold ${dot}`}
      >
        {hop.hop}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-semibold text-ink">{hop.serviceLabel}</span>
          <span className={`text-xs font-semibold ${verdictTone}`}>{verdict}</span>
          <DocLink to="entityPolicyEngine" className="ml-auto text-[0.68rem]">
            {grantLabel}
          </DocLink>
        </div>

        {allowed ? (
          <p className="mt-0.5 text-[0.7rem] text-ink-soft font-mono">
            aud {short(hop.audience)}
            <span className={subOk === false ? "text-denied" : "text-verified"}>
              {" "}· sub {subOk === false ? "✗" : "✓"}
            </span>
            <span className="text-verified"> · act ✓</span>
            <span className={sidOk === false ? "text-denied" : "text-verified"}>
              {" "}· sid {sidOk === false ? "✗" : "✓"}
            </span>
            {hop.approvedByClaim ? (
              <span className="text-brand-ink"> · approved_by {short(hop.approvedByClaim)}</span>
            ) : null}
          </p>
        ) : null}

        {hop.result ? <p className="mt-0.5 text-xs text-ink">{hop.result}</p> : null}

        {hop.reason && !skipped ? (
          <p className="mt-1 rounded-md bg-denied-soft px-2 py-1 text-[0.7rem] text-denied font-mono">
            FusionAuth: {hop.reason}
          </p>
          ) : null}
        {hop.reason && !skipped && hop.grantKind === "probe" ? (
          <p className="mt-0.5 text-[0.68rem] text-ink-soft">
            The Entity policy engine only issues a token if a Grant to that audience exists
            right now — <DocLink to="entityPolicyEngine">how it decides</DocLink>
          </p>
        ) : null}

        {hop.approvals ? (
          <div className="mt-1.5 flex flex-wrap gap-1">
            <Chip tone={APPROVAL_TONE[hop.approvals.customer]}>
              customer · {hop.approvals.customer.replace("_", " ")}
            </Chip>
            <Chip tone={APPROVAL_TONE[hop.approvals.employee]}>
              employee · {hop.approvals.employee.replace("_", " ")}
              {hop.approvals.employeeName ? ` (${hop.approvals.employeeName})` : ""}
            </Chip>
          </div>
        ) : null}

        {hop.grant && hop.grant.length > 0 ? (
          <>
          <ol className="mt-2 flex flex-wrap items-center gap-1 text-[0.7rem]">
            {hop.grant.map((g, i) => (
              <li key={i} className="flex items-center gap-1">
                {i > 0 ? <span className="text-ink-soft">→</span> : null}
                <span
                  title={g.detail}
                  className={`rounded-md px-2 py-0.5 font-semibold ${
                    !g.ok
                      ? "bg-denied-soft text-denied"
                      : g.step === "revoke"
                        ? "bg-signal text-white"
                        : "bg-verified-soft text-verified"
                  }`}
                >
                  {g.step === "create" ? "Grant created" : g.step === "use" ? "used once" : "Grant revoked"}
                  {g.ok ? "" : " — failed"}
                </span>
              </li>
            ))}
          </ol>
          <p className="mt-0.5 text-[0.68rem] text-ink-soft">
            Created and deleted with the <DocLink to="entityGrantsApi">Entity Grant API</DocLink>
          </p>
          </>
        ) : null}

        {hop.approvedByPath && hop.approvedByPath !== "not required" ? (
          <p className="mt-1 text-[0.7rem] text-ink-soft">
            Employee approval verified via{" "}
            {hop.approvedByPath === "claim"
              ? <>the signed approved_by claim (<DocLink to="populateLambda">populate lambda</DocLink>)</>
              : "banking-api's own approval-record check"}
            .
          </p>
        ) : null}

        {hop.mcp && hop.mcp.status !== "skipped" && hop.mcp.status !== "allowed" ? (
          <p className="mt-1 text-[0.7rem] text-denied">Service refused: {hop.mcp.detail}</p>
        ) : null}

        {allowed ? (
          <details className="mt-1 text-[0.7rem] text-ink-soft">
            <summary className="cursor-pointer select-none hover:text-ink">token details</summary>
            <dl className="mt-1 grid grid-cols-[4.5rem_1fr] gap-x-2 font-mono">
              <dt>audience</dt><dd className="break-all text-ink">{hop.audience}</dd>
              <dt>sub</dt><dd className="break-all text-ink">{hop.sub}</dd>
              <dt>act.sub</dt><dd className="break-all text-ink">{hop.act}{hop.actProfile ? ` (${hop.actProfile})` : ""}</dd>
              <dt>sid</dt><dd className="break-all text-ink">{hop.sid}</dd>
              <dt>jti</dt><dd className="break-all text-ink">{hop.jti}</dd>
              {hop.mcp ? (<><dt>service</dt><dd className="text-ink">{hop.mcp.detail}</dd></>) : null}
            </dl>
          </details>
        ) : null}
      </div>
    </li>
  );
}

/**
 * A breadcrumb from FusionAuth FGA — a different system from the token chain, so it is
 * drawn differently (dashed, labelled "Permify") and carries no sub/act/sid. It only
 * points at the Permissions tab, where the relations and attributes actually live.
 */
function FgaBreadcrumb({
  note,
  last,
  onShowPermissions,
}: {
  note: TraceNoteEntry;
  last: boolean;
  onShowPermissions?: () => void;
}) {
  const tone =
    note.status === "allowed"
      ? "border-verified/40 text-verified"
      : note.status === "denied"
        ? "border-denied/40 text-denied"
        : "border-line text-ink-soft";
  return (
    <li className="relative flex gap-3 pb-4 ia-animate-in">
      {!last ? (
        <span aria-hidden className="absolute top-7 bottom-0 left-[0.8rem] w-px bg-line" />
      ) : null}
      <span className="relative z-10 flex h-[1.6rem] w-[1.6rem] shrink-0 items-center justify-center rounded-full border border-dashed border-brand bg-card text-[0.55rem] font-bold text-brand-ink">
        FGA
      </span>
      <div className={`min-w-0 flex-1 rounded-lg border border-dashed px-2.5 py-1.5 ${tone}`}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-2">
          <p className="text-xs font-semibold">{note.label}</p>
          {onShowPermissions ? (
            <button
              type="button"
              onClick={onShowPermissions}
              className="text-[0.68rem] font-medium text-brand-ink hover:underline"
            >
              Permissions tab →
            </button>
          ) : null}
        </div>
        {note.detail ? <p className="text-[0.7rem] text-ink-soft">{note.detail}</p> : null}
      </div>
    </li>
  );
}

function NoteRow({ note, last }: { note: TraceNoteEntry; last: boolean }) {
  const tone =
    note.status === "allowed"
      ? "text-verified"
      : note.status === "denied" || note.status === "error"
        ? "text-denied"
        : note.status === "required"
          ? "text-signal-ink"
          : "text-ink-soft";
  return (
    <li className="relative flex gap-3 pb-4 ia-animate-in">
      {!last ? (
        <span aria-hidden className="absolute top-4 bottom-0 left-[0.8rem] w-px bg-line" />
      ) : null}
      <span className="relative z-10 flex w-[1.6rem] shrink-0 justify-center pt-1">
        <span className={`h-2 w-2 rounded-full bg-current ${tone}`} />
      </span>
      <div className="min-w-0">
        <p className={`text-xs font-semibold ${tone}`}>{note.label}</p>
        {note.detail ? <p className="text-[0.7rem] text-ink-soft">{note.detail}</p> : null}
      </div>
    </li>
  );
}

export default function ExchangeChainTrace({
  entries,
  sid,
  customerId,
  mode,
  title = "Token exchange chain",
  embedded = false,
  onShowPermissions,
}: {
  entries: ChainEntry[];
  sid?: string;
  customerId?: string;
  mode?: ExchangeMode;
  title?: string;
  embedded?: boolean;
  /** Where an FGA breadcrumb's "Permissions tab →" link goes. */
  onShowPermissions?: () => void;
}) {
  const hops = entries.filter((e): e is ExchangeHopEntry => e.type === "hop");
  const issued = hops.filter((h) => h.exchange === "allowed");
  const act = issued[0]?.act;

  const body =
    entries.length === 0 ? (
      <p className="py-6 text-center text-sm text-ink-soft">
        Ask for a refund to watch RefundBot trade your sign-in token for a narrower one at
        each service.
      </p>
    ) : (
      <>
        <div className="mb-4 grid grid-cols-3 gap-2 rounded-lg bg-surface p-2.5 text-[0.7rem]">
          <div className="min-w-0">
            <p className="text-ink-soft">
              <DocLink to="tokenExchangeProcess">sub</DocLink> · who it&rsquo;s for
            </p>
            <p className="truncate font-mono text-ink" title={customerId}>
              {customerId ? `customer ${short(customerId, 6)}` : "—"}
            </p>
          </div>
          <div className="min-w-0">
            <p className="text-ink-soft">
              <DocLink to="actorChain">act</DocLink> · who&rsquo;s acting
            </p>
            <p className="truncate font-mono text-ink" title={act}>
              {act ? `orchestrator ${short(act, 6)}` : "—"}
            </p>
          </div>
          <div className="min-w-0">
            <p className="text-ink-soft">
              <DocLink to="tokenExchangeProcess">sid</DocLink> · conversation
            </p>
            <p className="truncate font-mono text-ink" title={sid}>{short(sid, 6)}</p>
          </div>
          <p className="col-span-3 text-ink-soft">
            {issued.length} token{issued.length === 1 ? "" : "s"} issued ·{" "}
            {hops.filter((h) => h.exchange === "denied").length} refused by FusionAuth
            {mode === "simulated" ? " · simulated chain" : ""}
            {" · "}
            <DocLink to="tokenExchangeAuditing">audit log</DocLink>
          </p>
        </div>
        <ol>
          {entries.map((e, i) =>
            e.type === "hop" ? (
              <HopRow key={i} hop={e} customerId={customerId} sid={sid} last={i === entries.length - 1} />
            ) : e.layer === "fga" ? (
              <FgaBreadcrumb
                key={i}
                note={e}
                last={i === entries.length - 1}
                onShowPermissions={onShowPermissions}
              />
            ) : (
              <NoteRow key={i} note={e} last={i === entries.length - 1} />
            )
          )}
        </ol>
        <p className="mt-1 border-t border-line pt-3 text-[0.7rem] text-ink-soft">
          Learn more: <DocLink to="tokenExchange">OAuth Token Exchange</DocLink> ·{" "}
          <DocLink to="delegationGuide">Delegate access with Token Exchange</DocLink> ·{" "}
          <DocLink to="tokenExchangeGrant">token exchange grant</DocLink>
        </p>
      </>
    );

  if (embedded) return <div>{body}</div>;
  return (
    <div className="rounded-xl border border-line bg-card shadow-sm">
      <div className="border-b border-line px-5 py-3">
        <h2 className="font-bold text-ink font-display">{title}</h2>
      </div>
      <div className="px-5 py-4">{body}</div>
    </div>
  );
}
