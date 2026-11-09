"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { TraceStep, TraceStatus } from "@/lib/agent";

/**
 * An interactive architecture diagram that plays back a turn the same way the
 * AuthorizationTrace lists it — but spatially. It's driven by the exact same
 * `TraceStep[]`: as each step is revealed, the component(s) it touches light up
 * and the edge(s) between them animate a travelling dash, so a viewer can watch
 * a request route through Client → Orchestrator → (Planner / Sandbox / FGA
 * pre-check / Step-up) → MCP Resource Server → Tools.
 *
 * The two external services sit outside both container frames, mirrored: FusionAuth
 * above (AuthN — who are you, what scopes, step-up) and FusionAuth FGA by Permify
 * below (AuthZ — which resources). Each authorization layer therefore reads as a
 * visually distinct denial point: the agent's local scope/role sandbox, the resource
 * server's independent re-check, and the relationship-level FGA answer — the whole
 * point of the demo. The lone "Outside knowledge" node marks the one path with no
 * authorization decision at all: no internal tool applied, so nothing was reached.
 */

// --- Visual state ----------------------------------------------------------

type Vis = "idle" | "info" | "allowed" | "denied" | "required" | "fga";

function vis(status: TraceStatus): Vis {
  switch (status) {
    case "allowed":
    case "verified":
      return "allowed";
    case "denied":
    case "error":
      return "denied";
    case "required":
      return "required";
    default:
      return "info";
  }
}

const STROKE: Record<Vis, string> = {
  idle: "var(--color-line)",
  info: "var(--color-brand)",
  allowed: "var(--color-verified)",
  denied: "var(--color-denied)",
  required: "var(--color-signal)",
  fga: "var(--color-fga)",
};
const FILL: Record<Vis, string> = {
  idle: "var(--color-card)",
  info: "var(--color-brand-soft)",
  allowed: "var(--color-verified-soft)",
  denied: "var(--color-denied-soft)",
  required: "var(--color-signal-soft)",
  fga: "var(--color-fga-soft)",
};
const INK: Record<Vis, string> = {
  idle: "var(--color-ink-soft)",
  info: "var(--color-brand-ink)",
  allowed: "var(--color-verified)",
  denied: "var(--color-denied)",
  required: "var(--color-signal-ink)",
  fga: "var(--color-fga-ink)",
};
const MARKER: Record<Vis, string> = {
  idle: "gray",
  info: "brand",
  allowed: "verified",
  denied: "denied",
  required: "signal",
  fga: "fga",
};

// --- Node + edge geometry (fixed viewBox, scales responsively) -------------

type NodeId =
  | "client"
  | "fusionauth"
  | "fga"
  | "external"
  | "planner"
  | "sandbox"
  | "stepup"
  | "verify"
  | "tools";

interface NodeMeta {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  subtitle: string;
  description: string;
  /**
   * An idle-state border color, for the two nodes that are standing infrastructure
   * rather than a phase of the turn: FusionAuth (AuthN) and FusionAuth FGA (AuthZ).
   * It keeps them legible as a pair when nothing has happened yet, instead of the
   * whole diagram resting as undifferentiated grey. Any real state overrides it.
   */
  accent?: string;
}

const NODES: Record<NodeId, NodeMeta> = {
  client: {
    x: 44,
    y: 184,
    w: 160,
    h: 96,
    title: "Client",
    subtitle: "the human",
    description:
      "The signed-in employee's browser. It sends the question and renders the reply plus this live trace.",
  },
  fusionauth: {
    x: 404,
    y: 24,
    w: 244,
    h: 92,
    title: "FusionAuth",
    subtitle: "auth server · tokens · 2FA",
    accent: "var(--color-brand)",
    description:
      "The OAuth/OIDC authorization server. Issues the scoped access token, publishes the JWKS used to verify it, and runs step-up two-factor checks.",
  },
  fga: {
    x: 404,
    y: 520,
    w: 244,
    h: 92,
    title: "FusionAuth FGA",
    subtitle: "Permify · relation tuples",
    accent: "var(--color-fga)",
    description:
      "The fine-grained authorization service. Scope says whether a tool may run at all; FGA answers which resources it may touch — whose payroll, whose PTO, which documents — by resolving relationships (employee → team → org) in its schema.",
  },
  external: {
    x: 1052,
    y: 336,
    w: 164,
    h: 92,
    title: "External Tool",
    subtitle: "third-party MCP",
    description:
      "A third-party MCP server (DeepWiki by default) holding public documentation for the platform this app runs on. It sits outside the boundary on purpose: the tool server calls it as an MCP client, the employee's access token is never forwarded, and what comes back is untrusted content — displayed and attributed, never acted on.",
  },
  planner: {
    x: 278,
    y: 184,
    w: 268,
    h: 72,
    title: "Planner",
    subtitle: "picks the tool",
    description:
      "Chooses which tool (if any) to call — a real Claude tool-calling turn, or the deterministic scripted planner. The authorization layers never trust its choice.",
  },
  sandbox: {
    x: 278,
    y: 294,
    w: 268,
    h: 72,
    title: "Sandbox pre-check",
    subtitle: "scopes + roles (local)",
    description:
      "The agent's own local pre-flight check: does the token carry the tool's scope AND is the role permitted? On a denial it refuses before ever calling the MCP server.",
  },
  stepup: {
    x: 278,
    y: 404,
    w: 268,
    h: 72,
    title: "Step-up gate",
    subtitle: "2FA for sensitive tools",
    description:
      "Sensitive tools (payroll, PTO) require a fresh two-factor check via FusionAuth before they may run.",
  },
  verify: {
    x: 706,
    y: 196,
    w: 286,
    h: 72,
    title: "Token verify",
    subtitle: "own JWKS · issuer · aud",
    description:
      "The MCP resource server verifies the bearer token independently against FusionAuth's JWKS — it never trusts the orchestrator that called it.",
  },
  tools: {
    x: 706,
    y: 300,
    w: 286,
    h: 164,
    title: "Tools + RAG",
    subtitle: "2nd scope + role check, then FGA",
    description:
      "Each tool handler runs behind the resource server's own scope + role check (authGate), and the three resource-bearing tools then ask FGA about the specific teams, employees, or documents involved. search_knowledge_base is filtered twice: by scope, then by document relations.",
  },
};

// Container frames (drawn behind nodes, not interactive).
const FULL_WIDTH = 1240; // the full layout's width, for consistent on-screen scale
const ORCH = { x: 244, y: 150, w: 336, h: 346 };
const MCP = { x: 676, y: 150, w: 340, h: 346 };

type EdgeId =
  | "login"
  | "request"
  | "plan_to_sandbox"
  | "fga_preflight"
  | "sandbox_to_stepup"
  | "stepup_2fa"
  | "bearer"
  | "verify_jwks"
  | "exec"
  | "fga_check"
  | "external_call"
  | "reply"
  | "reply_direct";

interface EdgeMeta {
  d: string;
  label?: string;
  lx?: number;
  ly?: number;
}

const EDGES: Record<EdgeId, EdgeMeta> = {
  login: {
    d: "M184,184 V130 H500 V116",
    label: "OAuth login",
    lx: 330,
    ly: 122,
  },
  // Straight into the planner — the old dog-leg collided with the client's label.
  request: { d: "M204,220 H278", label: "ask", lx: 241, ly: 210 },
  plan_to_sandbox: { d: "M412,256 V294" },
  sandbox_to_stepup: { d: "M412,366 V404" },
  stepup_2fa: {
    d: "M546,440 H618 V116",
    label: "2FA",
    lx: 640,
    ly: 134,
  },
  bearer: {
    d: "M580,232 H706",
    label: "Bearer token",
    lx: 620,
    ly: 222,
  },
  verify_jwks: {
    d: "M852,196 V70 H648",
    label: "verify · JWKS",
    lx: 742,
    ly: 60,
  },
  exec: { d: "M852,268 V300" },
  // The resource server's own FGA check: out of the MCP frame and back along the
  // gap into Permify's right edge.
  fga_check: {
    d: "M852,464 V566 H648",
    label: "FGA check",
    lx: 760,
    ly: 556,
  },
  // The agent's resource pre-check, down the gutter between the two frames (dashed —
  // the same question asked earlier and independently, so nobody completes a 2FA
  // challenge for a record FGA is going to refuse).
  fga_preflight: {
    d: "M278,330 H224 V566 H404",
    label: "FGA pre-check",
    lx: 300,
    ly: 556,
  },
  // The one call that leaves the boundary: out of the resource server's right side into
  // the third-party server. Nothing else on the canvas points outward.
  external_call: {
    d: "M992,382 H1052",
    label: "no employee token",
    lx: 1134,
    ly: 326,
  },
  // Back along the bottom and up the free gutter into the client's right edge — the
  // same side the question left from, so ask and answer read as one round trip.
  reply: {
    d: "M970,464 V636 H124 V280",
    label: "reply",
    lx: 560,
    ly: 628,
  },
  // The planner answering on its own (model knowledge): straight back under the
  // `ask` arrow, so the round trip never touches a tool.
  reply_direct: { d: "M278,252 H204", label: "reply", lx: 241, ly: 270 },
};

// Tool leaves rendered inside the `tools` node, highlighted when active.
const TOOL_ROWS: { tool: string; label: string }[] = [
  { tool: "search_knowledge_base", label: "Knowledge base (RAG)" },
  { tool: "create_it_ticket", label: "IT tickets" },
  { tool: "lookup_employee", label: "Directory" },
  { tool: "view_payroll", label: "Payroll" },
  { tool: "update_pto_balance", label: "PTO" },
  // The only handler that leaves the network — hence the node off to the right.
  { tool: "search_public_docs", label: "Public docs (external)" },
];

// --- Fitting the canvas to what's visible ----------------------------------

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const ORCH_CHILDREN: NodeId[] = ["planner", "sandbox", "stepup"];
const MCP_CHILDREN: NodeId[] = ["verify", "tools"];

/**
 * A container frame shrunk vertically to the children actually on screen. Its
 * x-extent stays fixed: edges such as `bearer` start on the frame's side.
 */
function fitFrame(frame: Box, children: NodeId[]): Box {
  const top = Math.min(...children.map((id) => NODES[id].y)) - 34;
  const bottom = Math.max(...children.map((id) => NODES[id].y + NODES[id].h)) + 20;
  return { x: frame.x, y: top, w: frame.w, h: bottom - top };
}

/** Every vertex of an edge path. They're all built from M / H / V commands. */
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

/** The bounding box of every drawn element, padded — used as the SVG viewBox. */
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
      const half = (e.label.length * 6.8) / 2; // 11px mono ≈ 6.6px per glyph
      add(e.lx - half, e.ly - 12);
      add(e.lx + half, e.ly + 4);
    }
  });
  const pad = 24;
  return {
    x: minX - pad,
    y: minY - pad,
    w: maxX - minX + pad * 2,
    h: maxY - minY + pad * 2,
  };
}

// --- Trace step → node/edge mapping ----------------------------------------

interface Mark {
  node: NodeId;
  v: Vis;
}
interface EdgeMark {
  edge: EdgeId;
  v: Vis;
}
interface StepTargets {
  marks: Mark[];
  edges: EdgeMark[];
  tool?: string;
}

function parseTool(label: string): string | undefined {
  return label.match(/(?:Selected|Resuming)\s+([a-z_]+)/i)?.[1];
}

function mapStep(step: TraceStep): StepTargets {
  const v = vis(step.status);
  switch (step.layer) {
    case "planner": {
      // The routing header opens every turn: the internal tools are considered first.
      if (step.label.startsWith("routing:")) {
        return {
          marks: [
            { node: "client", v: "info" },
            { node: "planner", v: "info" },
          ],
          edges: [{ edge: "request", v: "info" }],
        };
      }
      if (step.label.startsWith("No internal tool")) {
        // No reply yet: the external stage that follows decides where the answer
        // comes from, and draws its own route back to the client.
        return {
          marks: [
            { node: "client", v: "info" },
            { node: "planner", v: "info" },
          ],
          edges: [{ edge: "request", v: "info" }],
        };
      }
      return {
        marks: [
          { node: "client", v: "info" },
          { node: "planner", v },
        ],
        edges: [{ edge: "request", v }],
        tool: parseTool(step.label),
      };
    }
    case "sandbox":
      return {
        marks: [{ node: "sandbox", v }],
        edges: [{ edge: "plan_to_sandbox", v }],
      };
    case "fga": {
      // Allowed/filtered FGA answers take the layer's own violet so a resource
      // decision never reads as the scope + role decision above it.
      const fv: Vis = v === "denied" ? "denied" : "fga";
      // The pre-check runs in the orchestrator; the other check runs in the resource
      // server — the trace labels say which, so the diagram lights the right edge.
      if (/pre-check/i.test(step.label)) {
        // Reaching the pre-check at all means the scope + role sandbox passed.
        return {
          marks: [
            { node: "fga", v: fv },
            { node: "sandbox", v: "allowed" },
          ],
          edges: [{ edge: "fga_preflight", v: fv }],
        };
      }
      return {
        marks: [
          { node: "fga", v: fv },
          { node: "tools", v: fv },
        ],
        edges: [{ edge: "fga_check", v: fv }],
      };
    }
    case "external": {
      // `vis` already folds an "error" status into "denied", so v carries the right color
      // either way. Two distinct rungs land here: the external TOOL (which really does
      // leave the boundary) and the model's own knowledge (which reaches nothing).
      const viaTool = /public docs|external tool/i.test(step.label);
      if (!viaTool) {
        // Model knowledge: the planner answers the client directly — no tool, no
        // resource server, so the reply must not appear to come from either.
        return {
          marks: [
            { node: "planner", v },
            { node: "client", v: "info" },
          ],
          edges: [{ edge: "reply_direct", v }],
        };
      }
      if (v === "denied") {
        // The external server didn't answer; a model-knowledge step follows and
        // carries the reply.
        return {
          marks: [
            { node: "external", v },
            { node: "tools", v: "allowed" },
          ],
          edges: [
            { edge: "exec", v: "allowed" },
            { edge: "external_call", v },
          ],
          tool: "search_public_docs",
        };
      }
      // Answered from public docs. The route emits no separate `result` step on
      // this path, so this step closes the loop back to the client itself.
      return {
        marks: [
          { node: "external", v },
          { node: "tools", v: "allowed" },
          { node: "client", v: "info" },
        ],
        edges: [
          { edge: "exec", v: "allowed" },
          { edge: "external_call", v },
          { edge: "reply", v: "allowed" },
        ],
        tool: "search_public_docs",
      };
    }
    case "stepup":
      return {
        marks: [
          { node: "stepup", v },
          { node: "fusionauth", v },
        ],
        edges: [
          { edge: "sandbox_to_stepup", v },
          { edge: "stepup_2fa", v },
        ],
      };
    case "mcp": {
      if (/unauthenticated/i.test(step.label)) {
        // Token rejected at the door — the tool never ran.
        return {
          marks: [{ node: "verify", v: "denied" }],
          edges: [{ edge: "bearer", v: "denied" }],
        };
      }
      if (v === "denied") {
        // Token verified, but the resource server's own scope/role check refused.
        return {
          marks: [
            { node: "verify", v: "allowed" },
            { node: "tools", v: "denied" },
          ],
          edges: [
            { edge: "bearer", v: "allowed" },
            { edge: "verify_jwks", v: "allowed" },
            { edge: "exec", v: "denied" },
          ],
        };
      }
      return {
        marks: [
          { node: "verify", v },
          { node: "fusionauth", v: "info" },
        ],
        edges: [
          { edge: "bearer", v },
          { edge: "verify_jwks", v },
        ],
      };
    }
    case "result":
      return {
        marks: [
          { node: "tools", v },
          { node: "client", v: "info" },
        ],
        edges: [
          { edge: "exec", v },
          { edge: "reply", v },
        ],
      };
    default:
      return { marks: [], edges: [] };
  }
}

// --- Hooks -----------------------------------------------------------------

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

/** Reveals trace steps one at a time so the diagram plays a turn back. */
function useProgressiveReveal(count: number, reduce: boolean): number {
  const [revealed, setRevealed] = useState(0);
  useEffect(() => {
    // Reset (new turn) and reduced-motion jumps run in a deferred callback so we
    // never call setState synchronously inside the effect body.
    if (count === 0 || reduce) {
      const id = setTimeout(() => setRevealed(count === 0 ? 0 : count), 0);
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

// --- Component -------------------------------------------------------------

export default function ArchitectureDiagram({
  steps,
  mode,
}: {
  steps: TraceStep[];
  mode: "live" | "scripted";
}) {
  const reduce = usePrefersReducedMotion();
  const revealed = useProgressiveReveal(steps.length, reduce);
  const [hovered, setHovered] = useState<NodeId | null>(null);
  const [open, setOpen] = useState(true);

  const view = useMemo(() => {
    const nodeState: Record<NodeId, Vis> = {
      client: "idle",
      fusionauth: "idle",
      fga: "idle",
      external: "idle",
      planner: "idle",
      sandbox: "idle",
      stepup: "idle",
      verify: "idle",
      tools: "idle",
    };
    const edgeState: Partial<Record<EdgeId, Vis>> = {};
    let activeTool: string | undefined;
    let activeNodes: NodeId[] = [];
    let activeEdges: EdgeId[] = [];

    const shown = steps.slice(0, revealed);
    shown.forEach((step, i) => {
      const isLast = i === shown.length - 1;
      const t = mapStep(step);
      if (t.tool) activeTool = t.tool;
      t.marks.forEach((m) => (nodeState[m.node] = m.v));
      t.edges.forEach((e) => (edgeState[e.edge] = e.v));
      if (isLast) {
        activeNodes = t.marks.map((m) => m.node);
        activeEdges = t.edges.map((e) => e.edge);
      }
    });

    return {
      nodeState,
      edgeState,
      activeTool,
      activeNodes,
      activeEdges,
      current: shown[shown.length - 1],
    };
  }, [steps, revealed]);

  // Caption: node description on hover, otherwise the current phase's detail.
  const caption = hovered
    ? { title: NODES[hovered].title, text: NODES[hovered].description }
    : view.current
      ? { title: view.current.label, text: view.current.detail ?? "" }
      : {
          title: "Idle",
          text: "Ask something to watch the request route through each component and its authorization checks.",
        };

  const plannerSubtitle =
    mode === "live" ? "Claude LLM · picks the tool" : "scripted · picks the tool";

  // Only what this turn has actually touched is drawn. Idle nodes, their edges,
  // and empty container frames stay off the canvas so the path reads cleanly.
  const nodeVisible = (id: NodeId) => view.nodeState[id] !== "idle";
  const edgeVisible = (id: EdgeId) =>
    // The login happened before the turn; draw it only once FusionAuth is in play.
    id === "login" ? nodeVisible("fusionauth") : view.edgeState[id] !== undefined;
  const orchVisible = ORCH_CHILDREN.some(nodeVisible);
  const mcpVisible = MCP_CHILDREN.some(nodeVisible);
  const hasActivity = revealed > 0;

  const visibleNodes = (Object.keys(NODES) as NodeId[]).filter(nodeVisible);
  const visibleEdges = (Object.keys(EDGES) as EdgeId[]).filter(edgeVisible);
  const orchFrame = orchVisible
    ? fitFrame(ORCH, ORCH_CHILDREN.filter(nodeVisible))
    : null;
  const mcpFrame = mcpVisible ? fitFrame(MCP, MCP_CHILDREN.filter(nodeVisible)) : null;
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
      <div
        className={`flex flex-wrap items-center justify-between gap-2 px-5 py-3 ${
          open ? "border-b border-line" : ""
        }`}
      >
        <h2>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls="ia-diagram-body"
          className="flex items-start gap-2 text-left"
        >
          <span
            aria-hidden
            className="mt-0.5 inline-block text-ink-soft transition-transform"
            style={{ transform: open ? "rotate(90deg)" : "none" }}
          >
            ▸
          </span>
          <span>
            <span className="block font-bold text-ink font-display">
              Request architecture
            </span>
            <span className="block text-xs text-ink-soft">
              Live map of how the components talk for each turn — the same steps as
              the trace, in space.
            </span>
          </span>
        </button>
        </h2>
        {open ? <Legend /> : null}
      </div>

      {open ? (
      <div id="ia-diagram-body" className="px-4 py-4">
        {hasActivity ? (
        <svg
          viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
          className="mx-auto block h-auto"
          role="img"
          aria-label="Interactive architecture diagram of the InFusion Agent request flow"
          // Width is a share of the full 1240-unit layout, so boxes keep the same
          // on-screen size as the turn grows instead of zooming in when few show.
          style={{
            fontFamily: "var(--font-body)",
            width: `${Math.min(100, (vb.w / FULL_WIDTH) * 100)}%`,
          }}
        >
          <defs>
            {(["gray", "brand", "verified", "denied", "signal", "fga"] as const).map(
              (k) => {
                const color =
                  k === "gray"
                    ? "var(--color-ink-soft)"
                    : k === "brand"
                      ? "var(--color-brand)"
                      : k === "verified"
                        ? "var(--color-verified)"
                        : k === "denied"
                          ? "var(--color-denied)"
                          : k === "signal"
                            ? "var(--color-signal)"
                            : "var(--color-fga)";
                return (
                  <marker
                    key={k}
                    id={`ia-arrow-${k}`}
                    viewBox="0 0 8 8"
                    refX="6.5"
                    refY="4"
                    markerWidth="8"
                    markerHeight="8"
                    orient="auto-start-reverse"
                  >
                    <path d="M0,0 L8,4 L0,8 Z" fill={color} />
                  </marker>
                );
              }
            )}
          </defs>

          {/* Container frames — only when one of their components is in play */}
          {orchFrame ? (
            <ContainerFrame
              {...orchFrame}
              label="Agent Orchestrator · Next.js /api/chat"
            />
          ) : null}
          {mcpFrame ? (
            <ContainerFrame
              {...mcpFrame}
              label="MCP Resource Server · /api/mcp"
            />
          ) : null}

          {/* Edges (under nodes) */}
          {visibleEdges.map((id) => (
            <Edge
              key={id}
              id={id}
              state={
                id === "login" ? "allowed" : (view.edgeState[id] ?? "idle")
              }
              active={view.activeEdges.includes(id) && !reduce}
            />
          ))}

          {/* Nodes */}
          {visibleNodes.map((id) => {
            if (id === "tools") return null; // rendered separately below
            const subtitle =
              id === "planner" ? plannerSubtitle : NODES[id].subtitle;
            return (
              <Node
                key={id}
                id={id}
                subtitle={subtitle}
                state={view.nodeState[id]}
                active={view.activeNodes.includes(id) && !reduce}
                hovered={hovered === id}
                onHover={setHovered}
              />
            );
          })}
          {nodeVisible("tools") ? (
            <ToolsNode
              state={view.nodeState.tools}
              active={view.activeNodes.includes("tools") && !reduce}
              hovered={hovered === "tools"}
              activeTool={view.activeTool}
              onHover={setHovered}
            />
          ) : null}
        </svg>
        ) : (
          <p className="rounded-lg border border-dashed border-line bg-surface px-4 py-6 text-center text-xs text-ink-soft">
            Nothing to show yet — ask something and the components this turn
            touches will appear here.
          </p>
        )}

        {/* Caption / phase read-out */}
        {hasActivity ? (
        <div className="mt-3 rounded-lg border border-line bg-surface px-4 py-2.5">
          <p className="text-xs font-semibold text-ink font-mono">
            {caption.title}
          </p>
          {caption.text ? (
            <p className="mt-0.5 text-xs text-ink-soft">{caption.text}</p>
          ) : null}
        </div>
        ) : null}
      </div>
      ) : null}
    </div>
  );
}

// --- Sub-components ---------------------------------------------------------

function ContainerFrame({
  x,
  y,
  w,
  h,
  label,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
}) {
  return (
    <g className="ia-appear">
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={16}
        fill="var(--color-surface)"
        stroke="var(--color-line)"
        strokeWidth={1.5}
        strokeDasharray="2 5"
      />
      <text
        x={x + 16}
        y={y + 22}
        fill="var(--color-ink-soft)"
        fontSize={12}
        fontWeight={700}
        style={{ fontFamily: "var(--font-mono)" }}
      >
        {label}
      </text>
    </g>
  );
}

function Edge({
  id,
  state,
  active,
}: {
  id: EdgeId;
  state: Vis;
  active: boolean;
}) {
  const meta = EDGES[id];
  const dim = state === "idle";
  // Idle edges use a mid-slate so the routing stays legible; active/settled
  // edges take their status color.
  const color = dim ? "var(--color-ink-soft)" : STROKE[state];
  return (
    <g opacity={dim ? 0.5 : 1} className="ia-appear">
      <path
        d={meta.d}
        fill="none"
        stroke={color}
        strokeWidth={active ? 3 : dim ? 2 : 2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        markerEnd={`url(#ia-arrow-${dim ? "gray" : MARKER[state]})`}
        className={active ? "ia-edge-flow" : undefined}
      />
      {meta.label ? (
        <text
          x={meta.lx}
          y={meta.ly}
          fill={dim ? "var(--color-ink-soft)" : INK[state]}
          fontSize={11}
          textAnchor="middle"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {meta.label}
        </text>
      ) : null}
    </g>
  );
}

function Node({
  id,
  subtitle,
  state,
  active,
  hovered,
  onHover,
}: {
  id: NodeId;
  subtitle: string;
  state: Vis;
  active: boolean;
  hovered: boolean;
  onHover: (id: NodeId | null) => void;
}) {
  const n = NODES[id];
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
        stroke={state === "idle" && n.accent ? n.accent : STROKE[state]}
        strokeWidth={active ? 2 : hovered ? 2.5 : 1.75}
        className={active ? "ia-node-pulse" : undefined}
        style={{
          transition: "fill 0.3s ease, stroke 0.3s ease",
        }}
      />
      <text
        x={n.x + 16}
        y={n.y + 30}
        fill="var(--color-ink)"
        fontSize={16}
        fontWeight={700}
        style={{ fontFamily: "var(--font-display)" }}
      >
        {n.title}
      </text>
      <text
        x={n.x + 16}
        y={n.y + 50}
        fill={state === "idle" && n.accent ? n.accent : INK[state]}
        fontSize={11.5}
        style={{ fontFamily: "var(--font-mono)" }}
      >
        {subtitle}
      </text>
    </g>
  );
}

function ToolsNode({
  state,
  active,
  hovered,
  activeTool,
  onHover,
}: {
  state: Vis;
  active: boolean;
  hovered: boolean;
  activeTool?: string;
  onHover: (id: NodeId | null) => void;
}) {
  const n = NODES.tools;
  return (
    <g
      tabIndex={0}
      role="button"
      aria-label={`${n.title}: ${n.description}`}
      onMouseEnter={() => onHover("tools")}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover("tools")}
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
        stroke={STROKE[state]}
        strokeWidth={active ? 2 : hovered ? 2.5 : 1.75}
        className={active ? "ia-node-pulse" : undefined}
        style={{ transition: "fill 0.3s ease, stroke 0.3s ease" }}
      />
      <text
        x={n.x + 16}
        y={n.y + 28}
        fill="var(--color-ink)"
        fontSize={16}
        fontWeight={700}
        style={{ fontFamily: "var(--font-display)" }}
      >
        {n.title}
      </text>
      {TOOL_ROWS.map((row, i) => {
        const on = activeTool === row.tool;
        return (
          <g key={row.tool}>
            <circle
              cx={n.x + 22}
              cy={n.y + 50 + i * 20}
              r={3.5}
              fill={on ? STROKE[state === "idle" ? "info" : state] : "var(--color-line)"}
            />
            <text
              x={n.x + 34}
              y={n.y + 54 + i * 20}
              fill={on ? INK[state === "idle" ? "info" : state] : "var(--color-ink-soft)"}
              fontSize={12}
              fontWeight={on ? 700 : 400}
              style={{ fontFamily: "var(--font-mono)" }}
            >
              {row.label}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function Legend() {
  const items: { label: string; color: string }[] = [
    { label: "allowed", color: "var(--color-verified)" },
    { label: "denied", color: "var(--color-denied)" },
    { label: "step-up", color: "var(--color-signal)" },
    { label: "fga", color: "var(--color-fga)" },
    { label: "active", color: "var(--color-brand)" },
  ];
  return (
    <ul className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {items.map((it) => (
        <li key={it.label} className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: it.color }}
          />
          <span className="text-[0.7rem] text-ink-soft font-mono">
            {it.label}
          </span>
        </li>
      ))}
    </ul>
  );
}
