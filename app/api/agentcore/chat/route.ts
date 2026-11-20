import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/agentcore/chat  { prompt, chatId }
 *
 * The signed-in customer's chat turn with the AgentCore agent. The customer's access
 * token is read from the encrypted session cookie HERE, on the server, and sent to the
 * AgentCore runtime as a Bearer token — the browser never sees it. Only `{ answer,
 * steps, refund? }` goes back (`refund` is the confirm card's data when the agent started a
 * refund); no token, claim, or runtime error body is ever returned or logged.
 *
 * AgentCore needs a runtime session id of 33+ characters. It is derived from the user id
 * AND the page's per-chat id, so one customer can never land in another customer's
 * runtime session by choosing a chat id.
 */

const NO_STORE = { "Cache-Control": "no-store" };
const CHAT_ID = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_PROMPT = 4000;
const TIMEOUT_MS = 110_000;
const MAX_HISTORY_MESSAGES = 20; // last 10 exchanges
const MAX_HISTORY_TEXT = 2000;
const MAX_REFUNDS = 5;

/**
 * The only "[System note:" line history may carry: the browser's record that start_refund
 * succeeded, with just an order id and a request id. In an assistant message any other line
 * starting "[System note:" is dropped; in a user message every such line is, so a customer
 * can't type one to pass off a claim as a fact.
 */
const REFUND_NOTE =
  /^\[System note: start_refund succeeded for order [A-Za-z0-9_-]{1,64}, request [A-Za-z0-9_-]{1,64}\. The customer sees a confirm card and must confirm it in the browser\.\]$/;
function cleanNotes(text: string, role: "user" | "assistant"): string {
  return text
    .split("\n")
    .filter((line) => {
      const l = line.trim();
      return !l.startsWith("[System note:") || (role === "assistant" && REFUND_NOTE.test(l));
    })
    .join("\n");
}

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function runtimeSessionId(userId: string, chatId: string): string {
  // "rb-" + 64 hex chars = 67 chars (AgentCore wants 33 to 256).
  return `rb-${createHash("sha256").update(`${userId}:${chatId}`).digest("hex")}`;
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return json({ error: "Not signed in." }, 401);

  const runtimeUrl = process.env.AGENTCORE_RUNTIME_URL?.trim();
  if (!runtimeUrl) return json({ error: "AgentCore is not configured (AGENTCORE_RUNTIME_URL)." }, 503);

  let body: { prompt?: unknown; chatId?: unknown; history?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Request body must be valid JSON." }, 400);
  }
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt || prompt.length > MAX_PROMPT) {
    return json({ error: `\`prompt\` must be 1-${MAX_PROMPT} characters.` }, 400);
  }
  if (typeof body.chatId !== "string" || !CHAT_ID.test(body.chatId)) {
    return json({ error: "`chatId` is missing or invalid." }, 400);
  }

  // Earlier turns, as plain text only: role + text, capped in number and size. Anything else
  // the browser sends (tool results, card data, extra fields) is dropped here.
  const history = (Array.isArray(body.history) ? body.history : [])
    .slice(-MAX_HISTORY_MESSAGES)
    .flatMap((m) => {
      const x = m as { role?: unknown; text?: unknown } | null;
      const role = x?.role === "user" || x?.role === "assistant" ? x.role : undefined;
      const text =
        role && typeof x?.text === "string" ? cleanNotes(x.text, role).trim().slice(0, MAX_HISTORY_TEXT) : "";
      return role && text ? [{ role, text }] : [];
    });

  let res: Response;
  try {
    res = await fetch(runtimeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${session.accessToken}`,
        "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": runtimeSessionId(session.userId, body.chatId),
      },
      body: JSON.stringify({ prompt, history }),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    console.log(`[agentcore-chat] request failed: ${timedOut ? "timeout" : "network"}`);
    return json(
      { error: timedOut ? "The agent took too long to respond." : "Could not reach the agent." },
      502
    );
  }

  if (!res.ok) {
    console.log(`[agentcore-chat] runtime returned HTTP ${res.status}`);
    const hint =
      res.status === 401 || res.status === 403
        ? "The agent runtime rejected the sign-in credentials"
        : "The agent runtime returned an error";
    return json({ error: `${hint} (HTTP ${res.status}).` }, 502);
  }

  let data: { answer?: unknown; steps?: unknown; refund?: unknown; refunds?: unknown };
  try {
    data = await res.json();
  } catch {
    return json({ error: "The agent returned an unreadable response." }, 502);
  }

  // Whitelist the fields: nothing but the answer and the tool steps reaches the browser.
  const answer = typeof data.answer === "string" ? data.answer.slice(0, 8000) : "";
  const steps = (Array.isArray(data.steps) ? data.steps : [])
    .slice(0, 20)
    .flatMap((s) => {
      const step = s as { tool?: unknown; ok?: unknown } | null;
      return step && typeof step.tool === "string"
        ? [{ tool: step.tool.slice(0, 128), ok: step.ok === true }]
        : [];
    });

  // The embedded confirm panels' data: a card for every refund the agent started. Each is
  // re-validated and capped here too; the page loads the full request itself, by requestId.
  // The older single `refund` field is still read, in case the agent is not yet updated.
  type Card = { requestId: string; orderId: string; item: string | null; amountCents: number | null; confirmUrl: string };
  const str = (v: unknown, max: number) => (typeof v === "string" && v ? v.slice(0, max) : undefined);
  const toCard = (raw: unknown): Card | undefined => {
    const r = raw as Record<string, unknown> | null | undefined;
    if (!r || typeof r !== "object") return undefined;
    const requestId = str(r.requestId, 64);
    const orderId = str(r.orderId, 64);
    const rawUrl = str(r.confirmUrl, 500);
    if (!requestId || !orderId || !rawUrl) return undefined;
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
      return {
        requestId,
        orderId,
        item: str(r.item, 200) ?? null,
        amountCents:
          typeof r.amountCents === "number" && Number.isFinite(r.amountCents)
            ? Math.trunc(r.amountCents)
            : null,
        confirmUrl: url.toString(),
      };
    } catch {
      return undefined; // an unusable link: show no card rather than a broken one
    }
  };
  const refunds: Card[] = [];
  for (const raw of Array.isArray(data.refunds) ? data.refunds : data.refund ? [data.refund] : []) {
    const card = toCard(raw);
    if (card && !refunds.some((c) => c.requestId === card.requestId)) refunds.push(card);
    if (refunds.length >= MAX_REFUNDS) break;
  }
  return json({
    answer,
    steps,
    ...(refunds.length ? { refunds, refund: refunds[refunds.length - 1] } : {}),
  });
}
