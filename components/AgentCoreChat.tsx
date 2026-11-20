"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { formatUsd } from "@/lib/refund-types";

/**
 * The chat with the AgentCore agent. Same look as the RefundBot chat (components/RefundChat.tsx)
 * — header bar, bubbles, typing dots, pill input — but a much smaller state machine: the
 * server route does the agent call. When the agent started a refund, the answer comes with
 * a confirm card (order, amount, "Confirm your refund"). This component never sees an access
 * token. The customer's confirmation always happens on the confirm page behind the link.
 */

interface Step {
  tool: string;
  ok: boolean;
}

/** The confirm card's data, from the agent's start_refund result (via the server route). */
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
  /** Set when the agent started a refund this turn: shown straight away under the answer. */
  refund?: RefundCard;
  error?: boolean;
  at: string;
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

export default function AgentCoreChat({ customerName }: { customerName?: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => [greeting(customerName)]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const chatId = useRef<string | null>(null);
  const nextId = useRef(1);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  function push(m: Omit<ChatMessage, "id" | "at">) {
    setMessages((cur) => [...cur, { ...m, id: nextId.current++, at: new Date().toISOString() }]);
  }

  async function send(text: string) {
    const prompt = text.trim();
    if (!prompt || busy) return;
    // One id per chat: the server derives the AgentCore runtime session from it.
    chatId.current ??= crypto.randomUUID();
    setInput("");
    push({ role: "user", text: prompt });
    setBusy(true);
    try {
      const res = await fetch("/api/agentcore/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, chatId: chatId.current }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        answer?: string;
        steps?: Step[];
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
        push({ role: "bot", text: answer, steps: data.steps ?? [], refund: data.refund });
      }
    } catch {
      push({ role: "bot", error: true, text: "Could not reach the server. Please try again." });
    } finally {
      setBusy(false);
    }
  }

  function newChat() {
    chatId.current = null;
    setMessages([greeting(customerName)]);
    setInput("");
  }

  return (
    <section
      aria-label="Chat with the RefundBot agent"
      className="mx-auto flex h-[min(46rem,calc(100vh-14rem))] min-h-[32rem] max-w-3xl flex-col overflow-hidden rounded-2xl border border-line bg-card shadow-lg"
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

      <div ref={scroller} className="flex-1 space-y-4 overflow-y-auto bg-surface px-4 py-4">
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

                {m.refund ? (
                  <div className="mt-2 w-fit max-w-[92%]">
                    <RefundConfirmCard r={m.refund} />
                  </div>
                ) : null}

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

function RefundConfirmCard({ r }: { r: RefundCard }) {
  return (
    <div className="rounded-xl border border-line bg-card px-3.5 py-3 shadow-sm">
      <p className="text-xs font-semibold text-ink">
        {r.item ?? r.orderId}
        {r.amountCents != null ? ` · ${formatUsd(r.amountCents)}` : ""}
      </p>
      <p className="mt-0.5 text-xs text-ink-soft">
        Confirm your refund to finish. This can&apos;t be done from chat.
      </p>
      <a
        href={r.confirmUrl}
        className="mt-2 inline-block rounded-full bg-brand px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-brand-ink"
      >
        Confirm your refund →
      </a>
    </div>
  );
}
