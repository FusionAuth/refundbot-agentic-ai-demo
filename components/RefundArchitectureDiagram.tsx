"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ChainEntry, ExchangeHopEntry, RefundService } from "@/lib/refund-types";

/**
 * RefundBot's request-architecture diagram — the /refund counterpart of the /chat
 * demo's ArchitectureDiagram, in the same visual language (container frames, travelling
 * dashes, status colors, progressive playback, hover captions).
 *
 * It is driven by the SAME `ChainEntry[]` the ExchangeChainTrace lists, expanded into
 * "beats": every hop becomes an exchange beat (orchestrator ⇄ FusionAuth /oauth2/token)
 * and — if FusionAuth issued a token — a call beat (orchestrator → MCP resource server →
 * that one service). Hop 4 adds the Grant lifecycle beats against FusionAuth's Entity
 * Grant API: create before the exchange, revoke after the call. Approval notes light the
 * customer's out-of-band confirmation (through FusionAuth's two-factor) or the support
 * console.
 *
 * Kept separate from ArchitectureDiagram on purpose: that one renders `TraceStep[]`, and
 * AGENTS.md requires the two trace models stay apart.
 */

type Vis = "idle" | "info" | "allowed" | "denied" | "required";

const STROKE: Record<Vis, string> = {
  idle: "var(--color-line)",
  info: "var(--color-brand)",
  allowed: "var(--color-verified)",
  denied: "var(--color-denied)",
  required: "var(--color-signal)",
};
const FILL: Record<Vis, string> = {
  idle: "var(--color-card)",
  info: "var(--color-brand-soft)",
  allowed: "var(--color-verified-soft)",
  denied: "var(--color-denied-soft)",
  required: "var(--color-signal-soft)",
};
const INK: Record<Vis, string> = {
  idle: "var(--color-ink-soft)",
  info: "var(--color-brand-ink)",
  allowed: "var(--color-verified)",
  denied: "var(--color-denied)",
  required: "var(--color-signal-ink)",
};

// --- Geometry ----------------------------------------------------------------

type NodeId =
  | "customer"
  | "console"
  | "fusionauth"
  | "planner"
  | "pipeline"
  | "grants"
  | "verify"
  | RefundService;

interface NodeMeta {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  subtitle: string;
  description: string;
  accent?: string;
}

const NODES: Record<NodeId, NodeMeta> = {
  customer: {
    x: 30, y: 150, w: 180, h: 90,
    title: "Customer", subtitle: "browser · /refund",
    description:
      "The signed-in customer (possibly running their own agent). Asks for the refund and confirms it out-of-band through FusionAuth — not through the chat box.",
  },
  console: {
    x: 30, y: 470, w: 180, h: 90,
    title: "Support employee", subtitle: "/support/approvals",
    description:
      "The second, independent human. Required above the value-scaled threshold (never below $100). Approve or deny; their user id is checked by banking-api, not just logged.",
  },
  fusionauth: {
    x: 640, y: 20, w: 330, h: 92,
    title: "FusionAuth", subtitle: "token exchange · Entity Grants · 2FA",
    accent: "var(--color-brand)",
    description:
      "Issues each narrower token (RFC 8693, Entity policy engine): only if a Grant from the orchestrator to that audience exists right now. Keeps sub = customer, act = orchestrator, and copies sid.",
  },
  planner: {
    x: 290, y: 150, w: 250, h: 80,
    title: "Planner", subtitle: "picks the response",
    description:
      "Scripted or Claude. Decides how to respond and extracts an order id — nothing more. It never sets an amount, skips a hop, or approves anything.",
  },
  pipeline: {
    x: 290, y: 300, w: 250, h: 90,
    title: "Exchange pipeline", subtitle: "⇅ exchange → narrow token",
    description:
      "For each hop, trades the customer's original access token for one service's audience, then calls that service with the narrower token. Holds the approval queue, keyed by sid.",
  },
  grants: {
    x: 290, y: 450, w: 250, h: 90,
    title: "Grant manager", subtitle: "lib/entities.ts · banking only",
    description:
      "The only code that creates the orchestrator → banking-api Grant: after both approvals, immediately before the hop-4 exchange — and deletes it in a finally, every time.",
  },
  verify: {
    x: 660, y: 300, w: 200, h: 100,
    title: "exchangeGate", subtitle: "JWKS · aud · act.sub",
    description:
      "The resource server's own check: verifies the exchanged token against FusionAuth's JWKS, requires the service's OWN audience and the orchestrator as actor. Refuses the customer's raw token.",
  },
  "order-history": {
    x: 930, y: 190, w: 270, h: 78,
    title: "order-history-service", subtitle: "hop 1 · standing Grant",
    description: "Does this order exist for this customer? The only source of truth — an empty answer stops the whole chain.",
  },
  "customer-scoring": {
    x: 930, y: 285, w: 270, h: 78,
    title: "customer-scoring-service", subtitle: "hop 2 · standing Grant",
    description: "A mock 0–100 value score that sets the customer's self-service threshold.",
  },
  "refund-budget": {
    x: 930, y: 380, w: 270, h: 78,
    title: "refund-budget-service", subtitle: "hop 3 · standing Grant",
    description: "Budget check and the employee-approval threshold. The amount comes from the order record, never the caller.",
  },
  "banking-api": {
    x: 930, y: 475, w: 270, h: 78,
    title: "banking-api", subtitle: "hop 4 · NO standing Grant",
    accent: "var(--color-signal)",
    description:
      "The irreversible step. Unreachable until the Grant exists; also checks the approval record for the token's sid and the approving employee before moving money.",
  },
};

const ORCH = { x: 270, y: 120, w: 290, h: 440, label: "Orchestrator · /api/refund" };
const MCP = { x: 640, y: 160, w: 580, h: 410, label: "MCP Resource Server · /api/mcp" };
const ORCH_CHILDREN: NodeId[] = ["planner", "pipeline", "grants"];
const MCP_CHILDREN: NodeId[] = [
  "verify",
  "order-history",
  "customer-scoring",
  "refund-budget",
  "banking-api",
];
const FULL_WIDTH = 1220; // the full layout's width, for a consistent on-screen scale

type EdgeId =
  | "login"
  | "ask"
  | "confirm"
  | "approve"
  | "exchange"
  | "token"
  | "grant"
  | "call"
  | `svc-${RefundService}`;

interface EdgeMeta {
  d: string;
  label?: string;
  lx?: number;
  ly?: number;
}

const SVC_Y: Record<RefundService, number> = {
  "order-history": 229,
  "customer-scoring": 324,
  "refund-budget": 419,
  "banking-api": 514,
};

const EDGES: Record<EdgeId, EdgeMeta> = {
  login: { d: "M80,150 V40 H636", label: "PKCE login → access token (sid)", lx: 360, ly: 34 },
  confirm: { d: "M170,150 V84 H636", label: "out-of-band confirm (2FA)", lx: 400, ly: 78 },
  ask: { d: "M210,190 H286", label: "ask", lx: 248, ly: 182 },
  approve: { d: "M210,515 H245 V360 H286", label: "approve / deny", lx: 300, ly: 426 },
  // Exchange up the left gap, token back down a parallel lane into the pipeline's side —
  // never across the planner. Named in the node subtitles and the caption instead of
  // labels, which the narrow gap can't hold.
  exchange: { d: "M540,325 H575 V100 H636" },
  token: { d: "M650,116 V146 H597 V370 H544" },
  grant: { d: "M540,495 H619 V108 H636", label: "create · revoke Grant", lx: 640, ly: 590 },
  call: { d: "M540,350 H656", label: "Bearer", lx: 598, ly: 343 },
  "svc-order-history": { d: `M860,350 H895 V${SVC_Y["order-history"]} H926` },
  "svc-customer-scoring": { d: `M860,350 H895 V${SVC_Y["customer-scoring"]} H926` },
  "svc-refund-budget": { d: `M860,350 H895 V${SVC_Y["refund-budget"]} H926` },
  "svc-banking-api": { d: `M860,350 H895 V${SVC_Y["banking-api"]} H926` },
};

// --- Fitting the canvas to what's visible (same approach as ArchitectureDiagram) ----

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A container frame shrunk vertically to the children on screen; x-extent stays fixed. */
function fitFrame(frame: Box, children: NodeId[]): Box {
  const top = Math.min(...children.map((id) => NODES[id].y)) - 34;
  const bottom = Math.max(...children.map((id) => NODES[id].y + NODES[id].h)) + 20;
  return { x: frame.x, y: top, w: frame.w, h: bottom - top };
}

/** Every vertex of an edge path (all built from M / H / V commands). */
function pathPoints(d: string): [number, number][] {
  const pts: [number, number][] = [];
  let x = 0;
  let y = 0;
  for (const [, cmd, args] of d.matchAll(/([MHV])\s*([-\d.,\s]+)/g)) {
    const n = args.split(/[\s,]+/).filter(Boolean).map(Number);
    if (cmd === "M") [x, y] = n;
    else if (cmd === "H") x = n[0];
    else y = n[0];
    pts.push([x, y]);
  }
  return pts;
}

/** Bounding box of every drawn element, padded — the SVG viewBox. */
function fitViewBox(boxes: Box[], edges: EdgeId[]): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  boxes.forEach((b) => {
    add(b.x, b.y);
    add(b.x + b.w, b.y + b.h);
  });
  edges.forEach((id) => {
    const e = EDGES[id];
    pathPoints(e.d).forEach(([x, y]) => add(x, y));
    if (e.label && e.lx !== undefined && e.ly !== undefined) {
      const half = (e.label.length * 6.8) / 2;
      add(e.lx - half, e.ly - 12);
      add(e.lx + half, e.ly + 4);
    }
  });
  const pad = 24;
  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
}

// --- Entries → beats ---------------------------------------------------------

interface Beat {
  nodes: [NodeId, Vis][];
  edges: [EdgeId, Vis][];
  title: string;
  text: string;
}

function short(v?: string) {
  return v && v.length > 14 ? `${v.slice(0, 8)}…${v.slice(-4)}` : (v ?? "—");
}

function hopBeats(h: ExchangeHopEntry): Beat[] {
  const beats: Beat[] = [];
  if (h.exchange === "skipped") return beats;

  const create = h.grant?.find((g) => g.step === "create");
  const revoke = h.grant?.find((g) => g.step === "revoke");
  if (create) {
    beats.push({
      nodes: [["grants", create.ok ? "allowed" : "denied"], ["fusionauth", create.ok ? "allowed" : "denied"]],
      edges: [["grant", create.ok ? "allowed" : "denied"]],
      title: "① create Grant · orchestrator → banking-api",
      text: create.detail,
    });
  }

  const ok = h.exchange === "allowed";
  beats.push({
    nodes: [["pipeline", "info"], ["fusionauth", ok ? "allowed" : "denied"]],
    edges: [["exchange", ok ? "allowed" : "denied"], ["token", ok ? "allowed" : "denied"]],
    title: `hop ${h.hop} · exchange → aud ${h.serviceLabel}: ${ok ? "ALLOWED" : "DENIED"}`,
    text: ok
      ? `sub ${short(h.sub)} · act ${short(h.act)} · sid ${short(h.sid)}${h.approvedByClaim ? ` · approved_by ${short(h.approvedByClaim)}` : ""}`
      : `FusionAuth: ${h.reason ?? "refused"}`,
  });

  if (!ok) {
    // No token, so the service is unreachable by construction.
    beats.push({
      nodes: [[h.service, "denied"]],
      edges: [],
      title: `${h.serviceLabel}: never called`,
      text: "FusionAuth issued no token, so there was nothing to present to the service.",
    });
  } else if (h.mcp && h.mcp.status !== "skipped") {
    const v: Vis = h.mcp.status === "allowed" ? "allowed" : "denied";
    beats.push({
      nodes: [["pipeline", "info"], ["verify", v], [h.service, v]],
      edges: [["call", v], [`svc-${h.service}`, v]],
      title: `hop ${h.hop} · ${h.tool}`,
      text: h.result ? `${h.mcp.detail} → ${h.result}` : h.mcp.detail,
    });
  }

  if (revoke) {
    beats.push({
      nodes: [["grants", revoke.ok ? "allowed" : "denied"], ["fusionauth", revoke.ok ? "info" : "denied"], ["banking-api", revoke.ok && ok ? "allowed" : "denied"]],
      edges: [["grant", revoke.ok ? "required" : "denied"]],
      title: "③ revoke Grant",
      text: revoke.detail,
    });
  }
  return beats;
}

function noteBeat(e: Extract<ChainEntry, { type: "note" }>): Beat {
  const v: Vis =
    e.status === "allowed" ? "allowed"
    : e.status === "denied" || e.status === "error" ? "denied"
    : e.status === "required" ? "required"
    : "info";
  const base = { title: e.label, text: e.detail ?? "" };
  if (e.layer === "planner") {
    return { ...base, nodes: [["customer", "info"], ["planner", "info"]], edges: [["ask", "info"]] };
  }
  if (e.layer === "approval") {
    if (/customer/.test(e.label) && !/required/.test(e.label)) {
      return { ...base, nodes: [["customer", v], ["fusionauth", v], ["pipeline", v]], edges: [["confirm", v]] };
    }
    if (/support employee/.test(e.label)) {
      return { ...base, nodes: [["console", v], ["pipeline", v]], edges: [["approve", v]] };
    }
    return { ...base, nodes: [["pipeline", v]], edges: [] };
  }
  return { ...base, nodes: [["pipeline", v]], edges: [] };
}

function toBeats(entries: ChainEntry[]): Beat[] {
  return entries.flatMap((e) => (e.type === "hop" ? hopBeats(e) : [noteBeat(e)]));
}

// --- Hooks (same playback as the /chat diagram) ------------------------------

function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false
  );
}

/** Reveals beats one at a time; when more arrive (an approval landed), it continues. */
function useProgressiveReveal(count: number, reduce: boolean): number {
  const [revealed, setRevealed] = useState(0);
  useEffect(() => {
    if (count === 0 || reduce) {
      const id = setTimeout(() => setRevealed(count), 0);
      return () => clearTimeout(id);
    }
    const id = setInterval(() => {
      setRevealed((r) => {
        if (r >= count) {
          clearInterval(id);
          return r;
        }
        return r + 1;
      });
    }, 620);
    return () => clearInterval(id);
  }, [count, reduce]);
  return Math.min(revealed, count);
}

// --- Component ---------------------------------------------------------------

export default function RefundArchitectureDiagram({
  entries,
  mode,
}: {
  entries: ChainEntry[];
  mode: "live" | "simulated";
}) {
  const beats = useMemo(() => toBeats(entries), [entries]);
  const reduce = usePrefersReducedMotion();
  const revealed = useProgressiveReveal(beats.length, reduce);
  const [hovered, setHovered] = useState<NodeId | null>(null);
  const [open, setOpen] = useState(true);

  const view = useMemo(() => {
    const nodeState = Object.fromEntries(
      (Object.keys(NODES) as NodeId[]).map((id) => [id, "idle" as Vis])
    ) as Record<NodeId, Vis>;
    const edgeState: Partial<Record<EdgeId, Vis>> = {};
    let activeNodes: NodeId[] = [];
    let activeEdges: EdgeId[] = [];
    const shown = beats.slice(0, revealed);
    shown.forEach((b, i) => {
      b.nodes.forEach(([n, v]) => (nodeState[n] = v));
      b.edges.forEach(([e, v]) => (edgeState[e] = v));
      if (i === shown.length - 1) {
        activeNodes = b.nodes.map(([n]) => n);
        activeEdges = b.edges.map(([e]) => e);
      }
    });
    // The customer logged in before any of this — draw that edge once FusionAuth
    // itself is in play, the same rule the /chat diagram uses.
    if (shown.length > 0 && nodeState.fusionauth !== "idle") {
      edgeState.login = edgeState.login ?? "allowed";
      if (nodeState.customer === "idle") nodeState.customer = "info";
    }
    return { nodeState, edgeState, activeNodes, activeEdges, current: shown[shown.length - 1] };
  }, [beats, revealed]);

  const caption = hovered
    ? { title: NODES[hovered].title, text: NODES[hovered].description }
    : view.current
      ? { title: view.current.title, text: view.current.text }
      : {
          title: "Idle",
          text: "Ask for a refund to watch each hop trade the customer's token at FusionAuth and call one service with it.",
        };

  // Only what this request has actually touched is drawn. Idle nodes, their edges, and
  // empty container frames stay off the canvas so the path reads cleanly.
  const nodeVisible = (id: NodeId) => view.nodeState[id] !== "idle";
  const visibleNodes = (Object.keys(NODES) as NodeId[]).filter(nodeVisible);
  const visibleEdges = (Object.keys(EDGES) as EdgeId[]).filter(
    (id) => view.edgeState[id] !== undefined
  );
  const orchKids = ORCH_CHILDREN.filter(nodeVisible);
  const mcpKids = MCP_CHILDREN.filter(nodeVisible);
  const orchFrame = orchKids.length ? fitFrame(ORCH, orchKids) : null;
  const mcpFrame = mcpKids.length ? fitFrame(MCP, mcpKids) : null;
  const hasActivity = revealed > 0;
  const vb = fitViewBox(
    [
      ...visibleNodes.map((id) => NODES[id]),
      ...(orchFrame ? [orchFrame] : []),
      ...(mcpFrame ? [mcpFrame] : []),
    ],
    visibleEdges
  );

  return (
    <div className="rounded-xl border border-line bg-card shadow-sm">
      <div className={`flex flex-wrap items-center justify-between gap-2 px-5 py-3 ${open ? "border-b border-line" : ""}`}>
        <h2>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls="rb-diagram-body"
            className="flex items-start gap-2 text-left"
          >
            <span aria-hidden className="mt-0.5 inline-block text-ink-soft transition-transform" style={{ transform: open ? "rotate(90deg)" : "none" }}>
              ▸
            </span>
            <span>
              <span className="block font-bold text-ink font-display">
                Request architecture{mode === "simulated" ? " · simulated exchange" : ""}
              </span>
              <span className="block text-xs text-ink-soft">
                The same exchange chain as the trace, in space: every hop goes to FusionAuth
                first, and only a token it issues reaches a service.
              </span>
            </span>
          </button>
        </h2>
        {open ? <Legend /> : null}
      </div>

      {open ? (
        <div id="rb-diagram-body" className="px-4 py-4">
          {hasActivity ? (
          <svg
            viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
            className="mx-auto block h-auto"
            role="img"
            aria-label="Architecture diagram of the RefundBot token-exchange flow"
            // A share of the full layout's width, so boxes keep one on-screen size as
            // the request grows instead of zooming in when only a few are drawn.
            style={{
              fontFamily: "var(--font-body)",
              width: `${Math.min(100, (vb.w / FULL_WIDTH) * 100)}%`,
            }}
          >
            <defs>
              {(Object.keys(STROKE) as Vis[]).map((k) => (
                <marker key={k} id={`rb-arrow-${k}`} viewBox="0 0 8 8" refX="6.5" refY="4" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
                  <path d="M0,0 L8,4 L0,8 Z" fill={k === "idle" ? "var(--color-ink-soft)" : STROKE[k]} />
                </marker>
              ))}
            </defs>

            {orchFrame ? <Frame {...orchFrame} label={ORCH.label} /> : null}
            {mcpFrame ? <Frame {...mcpFrame} label={MCP.label} /> : null}

            {visibleEdges.map((id) => (
              <Edge key={id} meta={EDGES[id]} state={view.edgeState[id] ?? "idle"} active={view.activeEdges.includes(id) && !reduce} />
            ))}

            {visibleNodes.map((id) => (
              <Node
                key={id}
                id={id}
                state={view.nodeState[id]}
                active={view.activeNodes.includes(id) && !reduce}
                hovered={hovered === id}
                onHover={setHovered}
              />
            ))}
          </svg>
          ) : (
            <p className="rounded-lg border border-dashed border-line bg-surface px-4 py-6 text-center text-xs text-ink-soft">
              Nothing to show yet — ask for a refund and the components it touches will
              appear here.
            </p>
          )}

          {hasActivity ? (
          <div className="mt-3 rounded-lg border border-line bg-surface px-4 py-2.5">
            <p className="text-xs font-semibold text-ink font-mono">{caption.title}</p>
            {caption.text ? <p className="mt-0.5 text-xs text-ink-soft">{caption.text}</p> : null}
          </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// --- Sub-components ----------------------------------------------------------

function Frame({ x, y, w, h, label }: { x: number; y: number; w: number; h: number; label: string }) {
  return (
    <g className="ia-appear">
      <rect x={x} y={y} width={w} height={h} rx={16} fill="var(--color-surface)" stroke="var(--color-line)" strokeWidth={1.5} strokeDasharray="2 5" />
      <text x={x + 14} y={y + 20} fill="var(--color-ink-soft)" fontSize={12} fontWeight={700} style={{ fontFamily: "var(--font-mono)" }}>
        {label}
      </text>
    </g>
  );
}

function Edge({ meta, state, active }: { meta: EdgeMeta; state: Vis; active: boolean }) {
  const dim = state === "idle";
  return (
    <g opacity={dim ? 0.35 : 1} className="ia-appear">
      <path
        d={meta.d}
        fill="none"
        stroke={dim ? "var(--color-ink-soft)" : STROKE[state]}
        strokeWidth={active ? 3 : dim ? 1.5 : 2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={dim ? "4 4" : undefined}
        markerEnd={`url(#rb-arrow-${state})`}
        className={active ? "ia-edge-flow" : undefined}
      />
      {meta.label ? (
        <text x={meta.lx} y={meta.ly} fill={dim ? "var(--color-ink-soft)" : INK[state]} fontSize={11} textAnchor="middle" style={{ fontFamily: "var(--font-mono)" }}>
          {meta.label}
        </text>
      ) : null}
    </g>
  );
}

function Node({
  id,
  state,
  active,
  hovered,
  onHover,
}: {
  id: NodeId;
  state: Vis;
  active: boolean;
  hovered: boolean;
  onHover: (id: NodeId | null) => void;
}) {
  const n = NODES[id];
  const idle = state === "idle";
  return (
    <g
      tabIndex={0}
      role="button"
      aria-label={`${n.title}: ${n.description}`}
      onMouseEnter={() => onHover(id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(id)}
      onBlur={() => onHover(null)}
      className="ia-appear"
      style={{ cursor: "pointer", outline: "none" }}
    >
      <rect
        x={n.x}
        y={n.y}
        width={n.w}
        height={n.h}
        rx={12}
        fill={FILL[state]}
        stroke={idle && n.accent ? n.accent : STROKE[state]}
        strokeWidth={active ? 2 : hovered ? 2.5 : 1.75}
        className={active ? "ia-node-pulse" : undefined}
        style={{ transition: "fill 0.3s ease, stroke 0.3s ease" }}
      />
      <text x={n.x + 14} y={n.y + 30} fill="var(--color-ink)" fontSize={15} fontWeight={700} style={{ fontFamily: "var(--font-display)" }}>
        {n.title}
      </text>
      <text x={n.x + 14} y={n.y + 50} fill={idle && n.accent ? n.accent : INK[state]} fontSize={11} style={{ fontFamily: "var(--font-mono)" }}>
        {n.subtitle}
      </text>
    </g>
  );
}

function Legend() {
  const items = [
    { label: "allowed", color: "var(--color-verified)" },
    { label: "denied", color: "var(--color-denied)" },
    { label: "approval / revoke", color: "var(--color-signal)" },
    { label: "active", color: "var(--color-brand)" },
  ];
  return (
    <ul className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {items.map((it) => (
        <li key={it.label} className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: it.color }} />
          <span className="text-[0.7rem] text-ink-soft font-mono">{it.label}</span>
        </li>
      ))}
    </ul>
  );
}
