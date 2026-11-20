"use client";

import { useMemo, useState } from "react";
import DocLink from "@/components/DocLink";
import type { DocKey } from "@/lib/docs-links";

/**
 * The AgentCore request architecture: how a customer's chat reaches their orders through
 * AgentCore Runtime, Gateway and the RefundBot MCP server, and where FusionAuth and FusionAuth
 * FGA (Permify) sit. Same look as components/RefundArchitectureDiagram.tsx (container frames,
 * hover captions, legend) but static: it draws the whole path, every node idle, with no
 * request playing back.
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
  | "fusionauth"
  | "runtime"
  | "gateway"
  | "interceptor"
  | "fga"
  | "tags"
  | "verify"
  | "order-history"
  | "customer-scoring"
  | "refund-budget"
  | "banking-api"
  | "refund";

interface NodeMeta {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  subtitle: string;
  description: string;
  accent?: string;
  /** FusionAuth docs for this component, shown in the caption on hover. */
  doc?: { to: DocKey; label: string };
}

const NODES: Record<NodeId, NodeMeta> = {
  customer: {
    x: 30, y: 280, w: 180, h: 90,
    title: "Customer", subtitle: "browser",
    doc: { to: "mfa", label: "Multi-factor authentication" },
    description:
      "The signed-in customer, chatting at /agentcore. Their web-login access token is sent to the agent as a Bearer token — by the server, never exposed to the browser. They confirm any refund themselves, in the browser, through FusionAuth's step-up.",
  },
  fusionauth: {
    x: 560, y: 20, w: 330, h: 92,
    title: "FusionAuth", subtitle: "login · token exchange · Entity Grants",
    doc: { to: "tokenExchange", label: "OAuth Token Exchange" },
    accent: "var(--color-brand)",
    description:
      "Signs the customer in (Authorization Code + PKCE) and issues each narrower token (RFC 8693): one service's audience at a time, only if a Grant from the actor to that audience exists right now. Keeps sub = the customer.",
  },
  tags: {
    x: 290, y: 150, w: 250, h: 80,
    title: "Tag filter", subtitle: "keeps each tool under its own target",
    description:
      "Runs in the agent, not in the MCP server. Each MCP tool carries a service tag in its _meta.service, which the server publishes. The agent keeps a gateway tool only when the text before the triple underscore in its name (its gateway target) equals that tag, so each tool stays under its own target and the model is only offered the intended services.",
  },
  runtime: {
    x: 290, y: 280, w: 250, h: 90,
    title: "AgentCore Runtime", subtitle: "agent · Claude on Bedrock",
    description:
      "Runs the agent. Claude on Amazon Bedrock plans in a loop of tool calls, running independent lookups together, and the agent applies the tag filter to the tools the gateway lists. The runtime checks the customer's token before the agent runs, and the agent only ever uses that customer's own token.",
  },
  gateway: {
    x: 290, y: 430, w: 250, h: 90,
    title: "AgentCore Gateway", subtitle: "MCP front door · tools",
    description:
      "Where the agent's tool calls enter. It lists the RefundBot tools and, for each call, gets a narrow token for that one service from FusionAuth before the call reaches the MCP server. Every call passes the request interceptor first.",
  },
  interceptor: {
    x: 290, y: 580, w: 250, h: 90,
    title: "Interceptor Lambda", subtitle: "FGA ownership check",
    description:
      "A request interceptor on the gateway. It only checks get_order_history calls; every other tool call passes through unchanged. Before get_order_history goes through, it asks Permify whether the customer may request a refund on that order (order#request_refund) and denies the call if not. If Permify can't be reached it denies too — it fails closed.",
  },
  fga: {
    x: 290, y: 730, w: 250, h: 90,
    title: "FusionAuth FGA", subtitle: "Permify · permissions/check",
    accent: "var(--color-fga)",
    description:
      "A separate authorization service — no tokens. It answers order#request_refund (is this order yours?) for the interceptor, and the refund pipeline asks it the same, plus account#auto_approve and the approval cascade. Permify entities here are not FusionAuth Entities.",
  },
  verify: {
    x: 660, y: 430, w: 200, h: 100,
    title: "exchangeGate", subtitle: "JWKS · aud · act.sub",
    doc: { to: "mcpServerAccess", label: "Control MCP server access" },
    description:
      "The MCP server's own check: verifies the exchanged token against FusionAuth's JWKS, requires the service's OWN audience and the orchestrator as actor. Refuses the customer's raw token.",
  },
  "order-history": {
    x: 930, y: 320, w: 270, h: 78,
    title: "order-history-service", subtitle: "standing Grant",
    doc: { to: "entityManagement", label: "Entities" },
    description: "Looks up the order. It answers for any id — ownership is checked by Permify before the call (here, by the interceptor).",
  },
  "customer-scoring": {
    x: 930, y: 415, w: 270, h: 78,
    title: "customer-scoring-service", subtitle: "standing Grant",
    doc: { to: "entityManagement", label: "Entities" },
    description: "The customer's order history — context only. Whether review is skipped is Permify's account#auto_approve.",
  },
  "refund-budget": {
    x: 930, y: 510, w: 270, h: 78,
    title: "refund-budget-service", subtitle: "standing Grant",
    doc: { to: "entityManagement", label: "Entities" },
    description: "Budget check and the $100 self-service floor. The amount comes from the order record, never the caller.",
  },
  "banking-api": {
    x: 930, y: 605, w: 270, h: 78,
    title: "banking-api", subtitle: "NO standing Grant",
    doc: { to: "entityPolicyEngine", label: "Entity policy engine" },
    accent: "var(--color-signal)",
    description:
      "The irreversible step. Unreachable until the Grant exists, which the app creates only after every required approval and deletes straight after. Also checks the approval record before moving money.",
  },
  refund: {
    x: 30, y: 740, w: 220, h: 80,
    title: "Refund endpoint", subtitle: "POST /api/agent/refund",
    description:
      "The agent's own start_refund tool calls this with the customer's original token. It runs the same pipeline as the web chat — ownership check, then the lookups — and then waits for the customer's confirmation (and an employee's, when required). It never confirms anything itself.",
  },
};

const AGENTCORE = { x: 270, y: 120, w: 290, h: 440, label: "Amazon Bedrock AgentCore" };
const MCP = { x: 640, y: 160, w: 580, h: 410, label: "RefundBot MCP Server · /api/mcp" };
const AGENTCORE_CHILDREN: NodeId[] = ["tags", "runtime", "gateway", "interceptor"];
const MCP_CHILDREN: NodeId[] = [
  "verify",
  "order-history",
  "customer-scoring",
  "refund-budget",
  "banking-api",
];

type FrameId = "agentcore" | "mcp";

/** Hover captions for the two container frames. */
const FRAME_INFO: Record<FrameId, { title: string; text: string }> = {
  agentcore: {
    title: "Amazon Bedrock AgentCore",
    text:
      "The runtime, the gateway and its interceptor, plus the tag filter the agent applies to the tools it is offered. AgentCore Identity works behind the scenes here: its settings are on the runtime, the gateway and the OAuth client.",
  },
  mcp: {
    title: "RefundBot MCP Server · /api/mcp",
    text:
      "The tool server. exchangeGate checks every exchanged token before any service runs; the three lookup services each have a standing Grant, and banking-api has none until a refund is fully approved.",
  },
};

type EdgeId =
  | "login"
  | "ask"
  | "filter"
  | "tools"
  | "intercept"
  | "ownership"
  | "exchange"
  | "call"
  | "svc-order-history"
  | "svc-customer-scoring"
  | "svc-refund-budget"
  | "start"
  | "approved";

interface EdgeMeta {
  d: string;
  label?: string;
  lx?: number;
  ly?: number;
}

const SVC_Y = { "order-history": 359, "customer-scoring": 454, "refund-budget": 549 };

const EDGES: Record<EdgeId, EdgeMeta> = {
  login: { d: "M80,280 V40 H556", label: "PKCE login → access token", lx: 300, ly: 34 },
  ask: { d: "M210,300 H286", label: "ask", lx: 248, ly: 292 },
  filter: { d: "M415,230 V276", label: "filtered tools", lx: 482, ly: 259 },
  tools: { d: "M415,370 V426", label: "tools/list · call", lx: 492, ly: 404 },
  intercept: { d: "M415,520 V576", label: "tools/call", lx: 468, ly: 554 },
  ownership: { d: "M415,670 V726", label: "ownership", lx: 474, ly: 712 },
  exchange: { d: "M540,455 H575 V116", label: "token exchange", lx: 633, ly: 250 },
  call: { d: "M540,480 H656", label: "Bearer", lx: 612, ly: 472 },
  "svc-order-history": { d: `M860,480 H895 V${SVC_Y["order-history"]} H926` },
  "svc-customer-scoring": { d: `M860,480 H895 V${SVC_Y["customer-scoring"]} H926` },
  "svc-refund-budget": { d: `M860,480 H895 V${SVC_Y["refund-budget"]} H926` },
  start: { d: "M290,350 H240 V736", label: "start_refund", lx: 190, ly: 450 },
  approved: { d: "M140,820 V860 H1065 V687", label: "after approvals", lx: 700, ly: 852 },
};

// --- Fitting the canvas ------------------------------------------------------

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A container frame shrunk vertically to its children; x-extent stays fixed. */
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

// --- Component ---------------------------------------------------------------

export default function AgentCoreArchitectureDiagram({ embedded = false }: { embedded?: boolean }) {
  const [hovered, setHovered] = useState<NodeId | null>(null);
  const [hoveredFrame, setHoveredFrame] = useState<FrameId | null>(null);

  const geometry = useMemo(() => {
    const nodeIds = Object.keys(NODES) as NodeId[];
    const edgeIds = Object.keys(EDGES) as EdgeId[];
    const agentFrame = fitFrame(AGENTCORE, AGENTCORE_CHILDREN);
    const mcpFrame = fitFrame(MCP, MCP_CHILDREN);
    const vb = fitViewBox([...nodeIds.map((id) => NODES[id]), agentFrame, mcpFrame], edgeIds);
    return { nodeIds, edgeIds, agentFrame, mcpFrame, vb };
  }, []);

  const caption: { title: string; text: string; doc?: NodeMeta["doc"] } = hovered
    ? { title: NODES[hovered].title, text: NODES[hovered].description, doc: NODES[hovered].doc }
    : hoveredFrame
      ? FRAME_INFO[hoveredFrame]
      : {
        title: "AgentCore path",
        text: "The customer's chat reaches their orders through AgentCore Runtime and Gateway, past the ownership check, to the RefundBot MCP server.",
      };

  const { vb } = geometry;
  return (
    <div className={embedded ? "" : "rounded-xl border border-line bg-card shadow-sm"}>
      {embedded ? (
        <div className="mb-2 flex justify-end">
          <Legend />
        </div>
      ) : null}
      <div className={embedded ? "" : "px-4 py-4"}>
        <svg
          viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
          className="mx-auto block h-auto"
          role="img"
          aria-label="Architecture diagram of the AgentCore refund flow"
          style={{ fontFamily: "var(--font-body)", width: "100%" }}
        >
          <defs>
            {(Object.keys(STROKE) as Vis[]).map((k) => (
              <marker key={k} id={`ac-arrow-${k}`} viewBox="0 0 8 8" refX="6.5" refY="4" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
                <path d="M0,0 L8,4 L0,8 Z" fill={k === "idle" ? "var(--color-ink-soft)" : STROKE[k]} />
              </marker>
            ))}
          </defs>

          <Frame {...geometry.agentFrame} label={AGENTCORE.label} id="agentcore" onHover={setHoveredFrame} />
          <Frame {...geometry.mcpFrame} label={MCP.label} id="mcp" onHover={setHoveredFrame} />

          {geometry.edgeIds.map((id) => (
            <Edge key={id} meta={EDGES[id]} />
          ))}

          {geometry.nodeIds.map((id) => (
            <Node key={id} id={id} hovered={hovered === id} onHover={setHovered} />
          ))}
        </svg>

        <div className="mt-3 rounded-lg border border-line bg-surface px-4 py-2.5">
          <p className="text-xs font-semibold text-ink font-mono">{caption.title}</p>
          {caption.text ? <p className="mt-0.5 text-xs text-ink-soft">{caption.text}</p> : null}
          {caption.doc ? (
            <p className="mt-1 text-xs">
              <DocLink to={caption.doc.to}>{caption.doc.label}</DocLink>
            </p>
          ) : (
            <p className="mt-1 text-[0.7rem] text-ink-soft">Hover a component or a frame for what it does.</p>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Sub-components ----------------------------------------------------------

function Frame({
  x,
  y,
  w,
  h,
  label,
  id,
  onHover,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  id: FrameId;
  onHover: (id: FrameId | null) => void;
}) {
  return (
    <g
      tabIndex={0}
      role="button"
      aria-label={`${FRAME_INFO[id].title}: ${FRAME_INFO[id].text}`}
      onMouseEnter={() => onHover(id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(id)}
      onBlur={() => onHover(null)}
      className="ia-appear"
      style={{ outline: "none" }}
    >
      <rect x={x} y={y} width={w} height={h} rx={16} fill="var(--color-surface)" stroke="var(--color-line)" strokeWidth={1.5} strokeDasharray="2 5" />
      <text x={x + 14} y={y + 20} fill="var(--color-ink-soft)" fontSize={12} fontWeight={700} style={{ fontFamily: "var(--font-mono)" }}>
        {label}
      </text>
    </g>
  );
}

function Edge({ meta }: { meta: EdgeMeta }) {
  return (
    <g opacity={0.35} className="ia-appear">
      <path
        d={meta.d}
        fill="none"
        stroke="var(--color-ink-soft)"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray="4 4"
        markerEnd="url(#ac-arrow-idle)"
      />
      {meta.label ? (
        <text x={meta.lx} y={meta.ly} fill="var(--color-ink-soft)" fontSize={11} textAnchor="middle" style={{ fontFamily: "var(--font-mono)" }}>
          {meta.label}
        </text>
      ) : null}
    </g>
  );
}

/** Monospace 11px glyph width; subtitles wrap to the box so they never run past its edge. */
const SUB_CHAR_W = 6.6;
function wrapSubtitle(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && (line + " " + word).length > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function Node({
  id,
  hovered,
  onHover,
}: {
  id: NodeId;
  hovered: boolean;
  onHover: (id: NodeId | null) => void;
}) {
  const n = NODES[id];
  const subtitle = wrapSubtitle(n.subtitle, Math.floor((n.w - 28) / SUB_CHAR_W));
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
        fill={FILL.idle}
        stroke={n.accent ?? STROKE.idle}
        strokeWidth={hovered ? 2.5 : 1.75}
        style={{ transition: "fill 0.3s ease, stroke 0.3s ease" }}
      />
      <text x={n.x + 14} y={n.y + 30} fill="var(--color-ink)" fontSize={15} fontWeight={700} style={{ fontFamily: "var(--font-display)" }}>
        {n.title}
      </text>
      <text x={n.x + 14} y={n.y + 50} fill={n.accent ?? INK.idle} fontSize={11} style={{ fontFamily: "var(--font-mono)" }}>
        {subtitle.map((line, i) => (
          <tspan key={i} x={n.x + 14} dy={i === 0 ? 0 : 14}>
            {line}
          </tspan>
        ))}
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
