"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import RefundConfirmPanel from "@/components/RefundConfirmPanel";
import RefundProgressCard, { TERMINAL } from "@/components/RefundProgressCard";
import { formatUsd, type RefundRequestView } from "@/lib/refund-types";

/**
 * The chat with the AgentCore agent. Same look as the RefundBot chat (components/RefundChat.tsx)
 * — header bar, bubbles, typing dots, pill input — but a much smaller state machine: the
 * server route does the agent call. When the agent started a refund, the answer comes with
 * the refund's id: the same progress card RefundChat shows, and the same confirm panel the
 * confirm page uses (components/RefundConfirmPanel.tsx), appear right under it, so the customer
 * confirms or declines here, with the same step-up. The card keeps updating, and the bot
 * replies in the chat with the outcome, as in RefundChat. This component never sees an access
 * token.
 */

interface Step {
  tool: string;
  ok: boolean;
}

/** The refund the agent started, from its start_refund result (via the server route). */
interface RefundCard {
  requestId: string;
  orderId: string;
  item: string | null;
  amountCents: number | null;
  confirmUrl: string;
}

interface ChatMessage {
  id: number;
  role: "user" | "bot";
  text: string;
  steps?: Step[];
  /** Set when the agent started refunds this turn: a confirm panel for each shows under the answer. */
  refunds?: RefundCard[];
  error?: boolean;
  at: string;
}

// --- Session storage -----------------------------------------------------------
// So going to the confirm page and back doesn't lose the chat. Per tab (sessionStorage), keyed
// to the signed-in user and the chat id. Only what is visible is kept: message text, the tool
// steps, and the refund card fields. Never a token — the browser doesn't have one.

const STORE_PREFIX = "rb-agentcore:v1:";
const MAX_STORED_MESSAGES = 60;
const pointerKey = (userId: string) => `${STORE_PREFIX}${userId}:current`;
const chatKey = (userId: string, chatId: string) => `${STORE_PREFIX}${userId}:chat:${chatId}`;

function clearStoredChats() {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k?.startsWith(STORE_PREFIX)) sessionStorage.removeItem(k);
    }
  } catch {
    // storage unavailable — nothing to clear
  }
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);

/** Rebuild messages from storage field by field, so nothing unexpected can come back. */
function readStoredMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(-MAX_STORED_MESSAGES).flatMap((m, i): ChatMessage[] => {
    const x = m as Record<string, unknown> | null;
    const role = x?.role === "user" || x?.role === "bot" ? x.role : undefined;
    const text = str(x?.text, 8000);
    if (!x || !role || text === undefined) return [];
    const steps = (Array.isArray(x.steps) ? x.steps : []).slice(0, 20).flatMap((st) => {
      const y = st as { tool?: unknown; ok?: unknown } | null;
      return typeof y?.tool === "string" ? [{ tool: y.tool.slice(0, 128), ok: y.ok === true }] : [];
    });
    const refunds = (Array.isArray(x.refunds) ? x.refunds : []).slice(0, 5).flatMap((rf): RefundCard[] => {
      const y = rf as Record<string, unknown> | null;
      const requestId = str(y?.requestId, 64);
      const orderId = str(y?.orderId, 64);
      const confirmUrl = str(y?.confirmUrl, 500);
      if (!y || !requestId || !orderId || !confirmUrl) return [];
      return [
        {
          requestId,
          orderId,
          item: str(y.item, 200) ?? null,
          amountCents: typeof y.amountCents === "number" ? Math.trunc(y.amountCents) : null,
          confirmUrl,
        },
      ];
    });
    return [
      {
        id: typeof x.id === "number" ? x.id : i,
        role,
        text,
        at: str(x.at, 40) ?? new Date().toISOString(),
        ...(steps.length ? { steps } : {}),
        ...(refunds.length ? { refunds } : {}),
        ...(x.error === true ? { error: true } : {}),
      },
    ];
  });
}

/**
 * What an earlier turn looks like to the agent: the visible text, plus — for a turn where the
 * agent started refunds — one plain line per refund saying so, so it doesn't doubt itself on a
 * follow-up. Only the order id and request id from the card; never the link or any other field.
 * Capped at 2000 characters, with the notes kept and the visible text trimmed to make room.
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
function historyText(m: ChatMessage): string {
  const notes = (m.refunds ?? [])
    .filter((r) => SAFE_ID.test(r.orderId) && SAFE_ID.test(r.requestId))
    .map(
      (r) =>
        `[System note: start_refund succeeded for order ${r.orderId}, request ${r.requestId}. ` +
        "The customer sees a confirm card and must confirm it in the browser.]"
    );
  if (m.role === "user" || notes.length === 0) return m.text.slice(0, 2000);
  const block = notes.join("\n");
  return `${m.text.slice(0, Math.max(0, 2000 - block.length - 1))}\n${block}`;
}

function clock(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function toolLabel(name: string) {
  // Gateway tools arrive as `<target>___<tool>`; show just the tool.
  const i = name.indexOf("___");
  return i >= 0 ? name.slice(i + 3) : name;
}

function Avatar() {
  return (
    <span
      aria-hidden
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-bold text-white"
    >
      RB
    </span>
  );
}

/** Opening message, in RefundChat's voice. Uses the signed-in customer's first name. */
function greeting(customerName?: string): ChatMessage {
  return {
    id: 0,
    role: "bot",
    text:
      `Hi${customerName ? ` ${customerName.split(" ")[0]}` : ""}! I'm RefundBot, Brightline's ` +
      "support assistant. I can look up your orders and start a refund for you. Which order " +
      "can I help with?",
    at: new Date().toISOString(),
  };
}

/** Demo scenarios, phrased the way a customer would type them — no order ids. */
const SCENARIOS: { label: string; message: string }[] = [
  { label: "Refund my earbuds", message: "I'd like a refund for my earbuds — they stopped charging." },
  { label: "Return the monitor", message: "I want my money back for the monitor I bought." },
  { label: "Refund the standing desk", message: "Please refund my standing desk." },
  { label: "Show my recent orders", message: "What orders do I have?" },
];

// --- Safe markdown -------------------------------------------------------------
// The model's answers use markdown (bold, bullets). The repo has no markdown renderer, and
// one isn't worth a dependency here: this builds React elements only — text goes in as text
// nodes, so raw HTML from the model is shown literally and never interpreted, and there
// are no links or images to follow. Supported: paragraphs, "-"/"*"/"•" and "1." lists,
// "#" headings (shown bold), **bold**, *italic*, `code`.

const INLINE = /(\*\*[^*\n]+\*\*|\*[^*\s][^*\n]*\*|`[^`\n]+`)/g;

function inline(text: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong>;
    }
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={i} className="rounded bg-surface px-1 font-mono text-[0.85em]">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.length > 2 && part.startsWith("*") && part.endsWith("*")) {
      return <em key={i}>{part.slice(1, -1)}</em>;
    }
    return part;
  });
}

const LIST_ITEM = /^\s*([-*•]|\d+[.)])\s+(.*)$/;
const HEADING = /^\s*#{1,6}\s+(.*)$/;

function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length) {
      blocks.push(
        <p key={blocks.length} className="whitespace-pre-line">
          {inline(para.join("\n"))}
        </p>
      );
      para = [];
    }
  };
  const flushList = () => {
    if (!list) return;
    const Tag = list.ordered ? "ol" : "ul";
    blocks.push(
      <Tag key={blocks.length} className={`space-y-0.5 pl-5 ${list.ordered ? "list-decimal" : "list-disc"}`}>
        {list.items.map((item, i) => (
          <li key={i}>{inline(item)}</li>
        ))}
      </Tag>
    );
    list = null;
  };

  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const item = LIST_ITEM.exec(line);
    const heading = HEADING.exec(line);
    if (item) {
      flushPara();
      const ordered = /^\d/.test(item[1]);
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push(item[2]);
    } else if (heading) {
      flushPara();
      flushList();
      blocks.push(
        <p key={blocks.length} className="font-semibold">
          {inline(heading[1])}
        </p>
      );
    } else if (line.trim() === "") {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return <div className="space-y-2">{blocks}</div>;
}

export default function AgentCoreChat({
  customerName,
  customerId,
  onActiveRequest,
}: {
  customerName?: string;
  /** The signed-in user's id — keys the saved chat so one user never sees another's. */
  customerId: string;
  /** Told about the latest state of the refund the agent started (or undefined on New chat). */
  onActiveRequest?: (view: RefundRequestView | undefined) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => [greeting(customerName)]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [requests, setRequests] = useState<Record<string, RefundRequestView>>({});
  const lastKey = useRef<Record<string, string>>({});
  const chatId = useRef<string | null>(null);
  const nextId = useRef(1);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  // Restore this tab's chat for this user (after mount, so server and client render the same).
  useEffect(() => {
    try {
      const id = sessionStorage.getItem(pointerKey(customerId));
      if (!id) return;
      const saved = readStoredMessages(JSON.parse(sessionStorage.getItem(chatKey(customerId, id)) ?? "null"));
      if (saved.length === 0) return;
      chatId.current = id;
      nextId.current = Math.max(...saved.map((m) => m.id)) + 1;
      setMessages(saved);
    } catch {
      // unreadable or unavailable storage: start fresh
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  // Keep the saved chat current. Nothing is written until a chat has begun.
  useEffect(() => {
    const id = chatId.current;
    // Greeting-only means nothing worth saving yet (and avoids overwriting a chat that is
    // still being restored on first render).
    if (!id || !messages.some((m) => m.id !== 0)) return;
    try {
      sessionStorage.setItem(pointerKey(customerId), id);
      const slim = messages.slice(-MAX_STORED_MESSAGES).map((m) => ({
        id: m.id,
        role: m.role,
        text: m.text,
        at: m.at,
        ...(m.steps ? { steps: m.steps } : {}),
        ...(m.refunds ? { refunds: m.refunds } : {}),
        ...(m.error ? { error: true } : {}),
      }));
      sessionStorage.setItem(chatKey(customerId, id), JSON.stringify(slim));
    } catch {
      // quota or privacy mode: the chat just won't survive a page change
    }
  }, [messages, customerId]);

  // Sign-out (the shared nav's link) clears the saved chat before the page unloads.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const link = (e.target as Element | null)?.closest?.("a");
      if (link && new URL(link.href, location.href).pathname === "/api/auth/logout") clearStoredChats();
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  function push(m: Omit<ChatMessage, "id" | "at">) {
    setMessages((cur) => [...cur, { ...m, id: nextId.current++, at: new Date().toISOString() }]);
  }

  const keyOf = (v: RefundRequestView) => `${v.decision}:${v.customer.state}:${v.employee.state}`;

  /** Take a refund's latest state; if it comes with a reply, the bot says it in the chat. */
  function adopt(view: RefundRequestView | undefined, reply?: string) {
    if (view) {
      setRequests((r) => ({ ...r, [view.id]: view }));
      lastKey.current[view.id] = keyOf(view);
      onActiveRequest?.(view);
    }
    if (reply) push({ role: "bot", text: reply });
  }

  // Once the customer has confirmed and a specialist is reviewing (or it's executing), poll so
  // the card and the chat pick back up on their own — same as RefundChat.
  const waitingId = Object.values(requests).find(
    (v) => !TERMINAL.has(v.decision) && v.customer.state === "approved"
  )?.id;
  useEffect(() => {
    if (!waitingId) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/refund?requestId=${encodeURIComponent(waitingId)}`, { cache: "no-store" });
        if (!res.ok) return;
        const d = (await res.json()) as { request: RefundRequestView; reply: string };
        if (keyOf(d.request) !== lastKey.current[waitingId]) adopt(d.request, d.reply);
        else {
          setRequests((r) => ({ ...r, [d.request.id]: d.request }));
          onActiveRequest?.(d.request);
        }
      } catch {
        // transient; next tick
      }
    }, 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingId]);

  async function send(text: string) {
    const prompt = text.trim();
    if (!prompt || busy) return;
    // One id per chat: the server derives the AgentCore runtime session from it.
    chatId.current ??= crypto.randomUUID();
    // Earlier turns, as plain text only (no steps, cards, or errors), so the agent remembers the
    // conversation. The greeting is the page's, not part of the conversation. Capped.
    const history = messages
      .filter((m) => m.id !== 0 && !m.error && m.text.trim())
      .slice(-20)
      .map((m) => ({ role: m.role === "user" ? "user" : "assistant", text: historyText(m) }));
    setInput("");
    push({ role: "user", text: prompt });
    setBusy(true);
    try {
      const res = await fetch("/api/agentcore/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, chatId: chatId.current, history }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        answer?: string;
        steps?: Step[];
        refunds?: RefundCard[];
        refund?: RefundCard;
        error?: string;
      };
      if (!res.ok) {
        push({
          role: "bot",
          error: true,
          text:
            res.status === 401
              ? "Your session has expired. Please sign in again."
              : (data.error ?? "Something went wrong talking to the agent."),
        });
      } else {
        const answer = data.answer?.trim() || "The agent didn't return an answer.";
        push({
          role: "bot",
          text: answer,
          steps: data.steps ?? [],
          refunds: data.refunds ?? (data.refund ? [data.refund] : undefined),
        });
      }
    } catch {
      push({ role: "bot", error: true, text: "Could not reach the server. Please try again." });
    } finally {
      setBusy(false);
    }
  }

  function newChat() {
    clearStoredChats();
    chatId.current = null;
    setRequests({});
    lastKey.current = {};
    onActiveRequest?.(undefined);
    setMessages([greeting(customerName)]);
    setInput("");
  }

  return (
    <section
      aria-label="Chat with the RefundBot agent"
      className="flex h-[min(46rem,calc(100vh-10rem))] min-h-[32rem] flex-col overflow-hidden rounded-2xl border border-line bg-card shadow-lg"
    >
      <header className="flex items-center gap-3 bg-ink px-4 py-3 text-white">
        <Avatar />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">RefundBot agent</p>
          <p className="flex items-center gap-1.5 text-[0.7rem] text-white/70">
            <span className="h-1.5 w-1.5 rounded-full bg-verified" /> Brightline support · powered by AgentCore
          </p>
        </div>
        <button
          type="button"
          onClick={newChat}
          disabled={busy}
          className="rounded-full border border-white/30 px-3 py-1 text-xs text-white/90 hover:bg-white/10 disabled:opacity-50"
        >
          New chat
        </button>
      </header>

      <div
        ref={scroller}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label="Conversation with the RefundBot agent"
        className="flex-1 space-y-4 overflow-y-auto bg-surface px-4 py-4"
      >
        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="flex flex-col items-end ia-animate-in">
              <div className="max-w-[85%] rounded-2xl rounded-br-md bg-brand px-3.5 py-2 text-sm text-white">
                {m.text}
              </div>
              <span suppressHydrationWarning className="mt-1 text-[0.62rem] text-ink-soft">{clock(m.at)}</span>
            </div>
          ) : (
            <div key={m.id} className="flex gap-2 ia-animate-in">
              <Avatar />
              <div className="min-w-0 flex-1">
                <div
                  className={`w-fit max-w-[92%] rounded-2xl rounded-tl-md px-3.5 py-2 text-sm shadow-sm ${
                    m.error ? "border border-denied/40 bg-denied-soft text-denied" : "bg-card text-ink"
                  }`}
                >
                  {m.error ? m.text : <Markdown text={m.text} />}
                </div>

                {m.steps && m.steps.length > 0 ? (
                  <div className="mt-2 w-fit max-w-[92%] rounded-lg border border-line bg-card px-3 py-2">
                    <p className="text-[0.62rem] font-semibold uppercase tracking-wider text-ink-soft">
                      Tools the agent used
                    </p>
                    <ul className="mt-1 space-y-0.5">
                      {m.steps.map((s, i) => (
                        <li key={i} className="flex items-center gap-1.5 text-xs font-mono">
                          <span aria-hidden className={s.ok ? "text-verified" : "text-denied"}>
                            {s.ok ? "✓" : "✗"}
                          </span>
                          <span className="text-ink">{toolLabel(s.tool)}</span>
                          <span className={s.ok ? "text-verified" : "text-denied"}>{s.ok ? "worked" : "failed"}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {m.refunds?.map((rf) => (
                  <div key={rf.requestId} className="mt-2 w-fit max-w-[92%]">
                    <EmbeddedConfirm
                      r={rf}
                      view={requests[rf.requestId]}
                      onLoad={(v) => adopt(v)}
                      onChange={adopt}
                    />
                  </div>
                ))}

                <span suppressHydrationWarning className="mt-1 block text-[0.62rem] text-ink-soft">
                  RefundBot agent{m.id === 0 ? "" : ` · ${clock(m.at)}`}
                </span>
              </div>
            </div>
          )
        )}

        {busy ? (
          <div className="flex gap-2" aria-label="The agent is typing">
            <Avatar />
            <div className="flex items-center gap-1 rounded-2xl rounded-tl-md bg-card px-3.5 py-3 shadow-sm">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-soft"
                  style={{ animationDelay: `${i * 0.15}s` }}
                />
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div className="border-t border-line bg-card px-3 pt-2.5">
        <p className="px-1 text-[0.62rem] font-semibold uppercase tracking-wider text-ink-soft">
          Try a demo scenario
        </p>
        <div className="mt-1.5 flex gap-1.5 overflow-x-auto pb-2">
          {SCENARIOS.map((sc) => (
            <button
              key={sc.label}
              type="button"
              title={sc.message}
              onClick={() => send(sc.message)}
              disabled={busy}
              className="shrink-0 rounded-full border border-brand/40 bg-brand-soft/40 px-3 py-1 text-xs text-brand-ink transition hover:bg-brand-soft disabled:opacity-50"
            >
              {sc.label}
            </button>
          ))}
        </div>
      </div>
      <form
        className="flex items-center gap-2 bg-card px-3 pb-3"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about your orders or a refund"
          disabled={busy}
          maxLength={4000}
          aria-label="Message"
          className="flex-1 rounded-full border border-line bg-surface px-4 py-2.5 text-sm text-ink outline-none focus:border-brand disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          aria-label="Send"
          className="flex h-10 w-10 items-center justify-center rounded-full bg-brand text-white transition hover:bg-brand-ink disabled:opacity-40"
        >
          <svg viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor" aria-hidden>
            <path d="M2.5 9.2 16.6 2.6c.6-.3 1.2.3.9.9L10.9 17.6c-.3.6-1.1.5-1.2-.1l-1-5.1-5.1-1c-.6-.1-.7-1-.1-1.2Z" />
          </svg>
        </button>
      </form>
    </section>
  );
}

type ConfirmState =
  | { status: "loading" }
  | { status: "ready"; view: RefundRequestView; reply: string }
  | { status: "error" };

/**
 * The refund's progress card and confirm panel, inside the chat. The refund was started by the
 * agent (through /api/agent/refund), not by this page, so the page loads its current state from
 * GET /api/refund?requestId=… — the route the web chat polls, which only returns the signed-in
 * customer's own requests. That state drives the card (kept fresh by the parent as the customer
 * decides). Confirming or declining goes through the panel's own routes (/api/two-factor/*,
 * POST /api/refund), exactly as in RefundChat.
 */
function EmbeddedConfirm({
  r,
  view,
  onLoad,
  onChange,
}: {
  r: RefundCard;
  view?: RefundRequestView;
  onLoad: (view: RefundRequestView) => void;
  onChange: (view: RefundRequestView | undefined, reply: string) => void;
}) {
  const [state, setState] = useState<ConfirmState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/refund?requestId=${encodeURIComponent(r.requestId)}`, { cache: "no-store" })
      .then(async (res) => {
        const d = (await res.json()) as { request?: RefundRequestView; reply?: string };
        if (!res.ok || !d.request) throw new Error("not found");
        if (cancelled) return;
        onLoad(d.request);
        setState({ status: "ready", view: d.request, reply: d.reply ?? "" });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.requestId]);

  if (state.status === "ready") {
    return (
      <>
        <RefundProgressCard r={view ?? state.view} />
        <div className="mt-2">
          <RefundConfirmPanel embedded initial={state.view} initialReply={state.reply} onChange={onChange} />
        </div>
      </>
    );
  }
  return (
    <div className="rounded-xl border border-line bg-card px-3.5 py-3 shadow-sm">
      <p className="text-xs font-semibold text-ink">
        {r.item ?? r.orderId}
        {r.amountCents != null ? ` · ${formatUsd(r.amountCents)}` : ""}
      </p>
      {state.status === "loading" ? (
        <p className="mt-0.5 text-xs text-ink-soft">Loading your refund…</p>
      ) : (
        <p className="mt-0.5 text-xs text-denied">
          Couldn&apos;t load the confirmation here.{" "}
          <a href={r.confirmUrl} className="underline">
            Open the confirm page
          </a>
        </p>
      )}
    </div>
  );
}
