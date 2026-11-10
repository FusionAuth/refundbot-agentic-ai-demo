import type { FgaCheckView, RefundFgaView } from "@/lib/fga-types";
import { formatUsd, type RefundRequestView } from "@/lib/refund-types";

/**
 * The Permissions tab — what FusionAuth FGA decided about the refund on screen, in
 * Permify's own terms: entities, relations, attributes, and the checks that ran. Same
 * spirit as InFusion Market's FgaGraph, including its "via cascade" badge for a
 * permission inherited through a parent entity.
 *
 * Deliberately NOT part of the token chain: there is no sub / act / sid here. Permify
 * entities (`account`, `order`, `store`, `region`) are nodes in an FGA schema, not
 * FusionAuth Entities. The token chain only carries a breadcrumb pointing here.
 */

function Verdict({ allowed, children }: { allowed: boolean; children?: React.ReactNode }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[0.68rem] font-bold ${
        allowed ? "bg-verified-soft text-verified" : "bg-denied-soft text-denied"
      }`}
    >
      {children ?? (allowed ? "ALLOWED" : "DENIED")}
    </span>
  );
}

function CascadeBadge() {
  return (
    <span className="rounded-full border border-brand/40 bg-brand-soft px-2 py-0.5 text-[0.65rem] font-semibold text-brand-ink">
      via cascade
    </span>
  );
}

function Node({ type, id, note, tone = "idle" }: { type: string; id: string; note?: string; tone?: "idle" | "ok" | "no" }) {
  const border =
    tone === "ok" ? "border-verified" : tone === "no" ? "border-denied" : "border-line";
  return (
    <div className={`min-w-0 rounded-lg border-2 bg-card px-2.5 py-1.5 ${border}`}>
      <p className="font-mono text-[0.62rem] uppercase tracking-wider text-ink-soft">{type}</p>
      <p className="truncate font-mono text-xs text-ink" title={id}>
        {id}
      </p>
      {note ? <p className="text-[0.65rem] text-ink-soft">{note}</p> : null}
    </div>
  );
}

function Edge({ label, tone = "idle" }: { label: string; tone?: "idle" | "ok" | "no" }) {
  const color = tone === "ok" ? "text-verified" : tone === "no" ? "text-denied" : "text-ink-soft";
  return (
    <div className={`flex shrink-0 flex-col items-center px-1 text-[0.62rem] font-mono ${color}`}>
      <span>{label}</span>
      <span aria-hidden>{tone === "no" ? "╳" : "──▶"}</span>
    </div>
  );
}

function shortEntity(entity: string): string {
  // Per-customer ids carry a long user-id suffix; keep the readable part.
  const [type, id = ""] = entity.split(":");
  const [head, tail] = id.split(".");
  return tail ? `${type}:${head}.${tail.slice(0, 6)}…` : entity;
}

function Checks({ checks }: { checks: FgaCheckView[] }) {
  return (
    <details className="mt-2 text-[0.7rem] text-ink-soft">
      <summary className="cursor-pointer select-none hover:text-ink">
        {checks.length} Permify check{checks.length === 1 ? "" : "s"}
      </summary>
      <ul className="mt-1 space-y-0.5 font-mono">
        {checks.map((c, i) => (
          <li key={i} className="flex flex-wrap items-center gap-x-2">
            <span className="text-ink" title={`${c.entity}#${c.permission}@${c.subject}`}>
              {shortEntity(c.entity)}#{c.permission}
            </span>
            {c.context ? (
              <span>
                ctx {Object.entries(c.context).map(([k, v]) => `${k}=${v}`).join(" ")}
              </span>
            ) : null}
            <span className={c.allowed ? "text-verified" : "text-denied"}>
              → {c.allowed ? "ALLOWED" : "DENIED"}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-surface/60 p-3">
      <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-ink-soft">{title}</h3>
      {children}
    </section>
  );
}

function Ownership({ fga }: { fga: RefundFgaView }) {
  const o = fga.ownership;
  if (!o) return null;
  const tone = o.allowed ? "ok" : "no";
  return (
    <Section title="1 · Order ownership">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs font-semibold text-ink">order#request_refund</span>
        <Verdict allowed={o.allowed} />
        {o.via ? (
          <span className="rounded-full bg-card px-2 py-0.5 text-[0.68rem] font-semibold text-ink">
            via <code className="font-mono">{o.via}</code>
          </span>
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <Node type="user" id="you" tone={tone} />
        <Edge label={o.via ?? "owner | delegate"} tone={tone} />
        <Node
          type="account"
          id={o.accountEntity ? shortEntity(o.accountEntity).replace("account:", "") : "—"}
          note={o.accountLabel}
          tone={o.accountEntity ? tone : "no"}
        />
        <Edge label="account" tone={o.accountEntity ? "ok" : "no"} />
        <Node type="order" id={shortEntity(o.orderEntity).replace("order:", "")} tone={tone} />
      </div>
      <p className="mt-2 text-xs text-ink-soft">{o.reason}</p>
      {!o.allowed ? (
        <p className="mt-1 text-xs font-semibold text-denied">
          Stopped before hop 1 — no token exchange was attempted.
        </p>
      ) : null}
      <Checks checks={o.checks} />
    </Section>
  );
}

function Tier({ fga }: { fga: RefundFgaView }) {
  const t = fga.tier;
  if (!t) return null;
  return (
    <Section title="2 · Customer trust tier">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs font-semibold text-ink">account#auto_approve</span>
        <Verdict allowed={t.autoApprove}>{t.autoApprove ? "FIRED" : "NOT GRANTED"}</Verdict>
      </div>
      <dl className="mt-2 grid grid-cols-[6.5rem_1fr] gap-x-2 gap-y-0.5 text-xs">
        <dt className="text-ink-soft">account</dt>
        <dd className="text-ink">{t.accountLabel}</dd>
        <dt className="text-ink-soft">tier</dt>
        <dd>
          <code
            className={`rounded px-1.5 font-mono ${
              t.tier === "trusted" ? "bg-verified-soft text-verified" : "bg-card text-ink"
            }`}
          >
            {t.tier}
          </code>
        </dd>
        <dt className="text-ink-soft">cap_cents</dt>
        <dd className="font-mono text-ink">
          {t.capCents} <span className="text-ink-soft">({formatUsd(t.capCents)})</span>
        </dd>
        <dt className="text-ink-soft">refund amount</dt>
        <dd className="font-mono text-ink">
          {t.amountCents} <span className="text-ink-soft">({formatUsd(t.amountCents)})</span>
        </dd>
      </dl>
      <p className="mt-2 text-xs text-ink-soft">{t.reason}</p>
      <p className="mt-1 text-[0.7rem] text-ink-soft">
        Either way the customer still confirms out-of-band (step-up MFA) — the tier decides
        whether an employee is looped in, never whether it&rsquo;s really them.
      </p>
      <Checks checks={t.checks} />
    </Section>
  );
}

function Cascade({ request }: { request: RefundRequestView }) {
  const fga = request.fga;
  if (!fga.store || !fga.region) return null;
  const escalated = request.needsEmployee || fga.approvals.length > 0;
  return (
    <Section title="3 · Approval cascade">
      <div className="flex flex-wrap items-center gap-1">
        <Node type="store" id={fga.store.id} note={`${fga.store.label} · cap ${formatUsd(fga.store.capCents)}`} />
        <Edge label="region" />
        <Node type="region" id={fga.region.id} note={`${fga.region.label} · cap ${formatUsd(fga.region.capCents)}`} />
      </div>
      {!escalated ? (
        <p className="mt-2 text-xs text-ink-soft">
          Not escalated — no employee approval needed for this refund.
        </p>
      ) : fga.approvals.length === 0 ? (
        <p className="mt-2 text-xs text-ink-soft">
          Waiting on a support employee. Permify will check <code className="font-mono">store#approve_local</code>{" "}
          first, then <code className="font-mono">region#approve_escalated</code>.
        </p>
      ) : (
        <ul className="mt-2 space-y-2">
          {fga.approvals.map((a, i) => (
            <li key={i} className="rounded-lg border border-line bg-card px-2.5 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-ink">{a.employeeName}</span>
                <span className="text-[0.68rem] text-ink-soft">tried to {a.decision}</span>
                <Verdict allowed={a.allowed} />
                {a.path ? (
                  <code className="font-mono text-[0.68rem] text-ink">{a.path}</code>
                ) : null}
                {a.path === "approve_escalated" ? <CascadeBadge /> : null}
                {a.path === "approve_local" ? (
                  <span className="rounded-full bg-surface px-2 py-0.5 text-[0.65rem] font-semibold text-ink-soft">
                    own store
                  </span>
                ) : null}
              </div>
              <p className="mt-1 text-xs text-ink-soft">{a.reason}</p>
              {a.suggestion ? (
                <p className="mt-1 text-xs font-semibold text-signal-ink">→ {a.suggestion}</p>
              ) : null}
              <Checks checks={a.checks} />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export default function PermissionsGraph({ request }: { request?: RefundRequestView }) {
  if (!request) {
    return (
      <p className="py-6 text-center text-sm text-ink-soft">
        Ask for a refund to see FusionAuth FGA check whether the order is yours, whether
        your account is trusted for the amount, and who may approve it.
      </p>
    );
  }
  const fga = request.fga;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface p-2.5 text-[0.7rem]">
        <span className="text-ink-soft">
          FusionAuth FGA · Permify relations and attributes, not FusionAuth Entities
        </span>
        <span
          className={`rounded-full px-2 py-0.5 font-semibold ${
            fga.mode === "live" ? "bg-verified-soft text-verified" : "bg-signal-soft text-signal-ink"
          }`}
        >
          {fga.mode === "live" ? "Live FusionAuth FGA" : "Demo fallback — no Permify reachable"}
        </span>
      </div>
      <Ownership fga={fga} />
      <Tier fga={fga} />
      <Cascade request={request} />
    </div>
  );
}
