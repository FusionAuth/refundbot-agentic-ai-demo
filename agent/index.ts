import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type Message,
  type Tool,
  type ToolResultContentBlock,
} from "@aws-sdk/client-bedrock-runtime";
import { openGatewaySession, type GatewaySession, type GatewayTool } from "./gateway";
import { START_REFUND_TOOL_NAME, startRefund, startRefundTool } from "./refund";

const PORT = 8080;
const MAX_BODY_BYTES = 1_000_000;
const MAX_ITERATIONS = 8;
const BEDROCK_TIMEOUT_MS = 60_000;

const REGION = process.env.AWS_REGION || "us-east-2";
const MODEL_ID = process.env.BEDROCK_MODEL_ID || "anthropic.claude-sonnet-5-5";

const SYSTEM_PROMPT =
  "You are a refund assistant. Use only the provided tools to look anything up or act. " +
  "Never invent order data; every order detail you state must come from a tool result. " +
  "If a tool is denied or fails, say so plainly and stop — do not retry or work around it. " +
  "You can start a refund with start_refund, but only after you have looked up the order " +
  "with the other tools. When lookups are independent, request them together in a single " +
  "turn instead of one at a time: for an order, ask for its order history, the customer " +
  "history and the refund budget check in the same turn. Request start_refund only in a " +
  "LATER turn, after those lookups have succeeded — never in the same turn as them. " +
  "start_refund only STARTS the refund: the customer must still " +
  "confirm it themselves in their browser. When start_refund succeeds and returns a " +
  "confirmUrl, the page shows the order, the amount and the confirm button right under your " +
  "answer, so reply with ONE short line saying the refund is ready to confirm below — and " +
  "nothing else: no order details, amounts, steps, or link. Do NOT print the confirmUrl or " +
  "any link. If the result has no confirmUrl, the refund was not started: explain why from " +
  "its message or failure. " +
  "Use real line breaks; never type the characters backslash-n. You cannot confirm, " +
  "approve, or complete a refund, so never say or imply that you did. If you need an order " +
  "id, ask the customer for it; never suggest, guess, or give an example of a specific " +
  "order id.";

const bedrock = new BedrockRuntimeClient({ region: REGION });

interface Step {
  tool: string;
  ok: boolean;
}

/** What the page needs to show the confirm card. Whitelisted and length-capped; no tokens. */
interface RefundCard {
  requestId: string;
  orderId: string;
  item: string | null;
  amountCents: number | null;
  confirmUrl: string;
}

const cap = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v ? v.slice(0, max) : undefined;

/** The card for a start_refund result — only when it came back with a usable confirmUrl. */
function toRefundCard(data: Record<string, unknown>): RefundCard | undefined {
  const confirmUrl = cap(data.confirmUrl, 500);
  const requestId = cap(data.requestId, 64);
  const orderId = cap(data.orderId, 64);
  if (!confirmUrl || !requestId || !orderId || !/^https?:\/\//i.test(confirmUrl)) return undefined;
  return {
    requestId,
    orderId,
    item: cap(data.item, 200) ?? null,
    amountCents:
      typeof data.amountCents === "number" && Number.isFinite(data.amountCents)
        ? Math.trunc(data.amountCents)
        : null,
    confirmUrl,
  };
}

/**
 * The model sometimes types a literal backslash-n (or /n) straight after a link instead of
 * a real line break — and a browser turns that into ".../rf_1/n/n", a 404. Strip any such
 * residue that directly follows a confirmUrl the start_refund tool actually returned, so the
 * link in the answer is exactly that URL.
 */
function cleanConfirmLinks(answer: string, urls: string[]): string {
  let out = answer;
  for (const url of urls) {
    const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`${escaped}(?:\\\\[nrt]|/n)+`, "g"), url);
  }
  return out;
}

/** What one tool call in a turn produced. Side effects are applied after the whole batch, in order. */
interface ToolOutcome {
  ok: boolean;
  content: ToolResultContentBlock;
  /** start_refund's result data, when it succeeded. */
  refundData?: Record<string, unknown>;
}

/** Thrown for failures that should surface as a 502 with a clear message. */
class UpstreamError extends Error {}

/** The bearer token from the Authorization header, if any. Never logged. */
function bearerToken(req: IncomingMessage): string | undefined {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? "");
  return m?.[1];
}

/** GATEWAY_TOKEN is a test-only fallback, honoured only when ALLOW_TEST_TOKEN=true. */
function resolveGatewayToken(req: IncomingMessage): string | undefined {
  const fromHeader = bearerToken(req);
  if (fromHeader) return fromHeader;
  if (process.env.ALLOW_TEST_TOKEN === "true") {
    return process.env.GATEWAY_TOKEN?.trim() || undefined;
  }
  return undefined;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Tool descriptions sometimes carry an example order id ("e.g. ORD-<number>") that the model then
 * suggests to the customer as if it were theirs. Drop any such example from what the model
 * sees — in the description and anywhere inside the input schema.
 */
function stripExampleOrderIds<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(/,?\s*\(?(?:e\.g\.|for example|such as)\s*ORD-\d+\)?/gi, "") as T;
  }
  if (Array.isArray(value)) return value.map(stripExampleOrderIds) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, stripExampleOrderIds(v)])
    ) as T;
  }
  return value;
}

function toToolConfig(tools: GatewayTool[]): { tools: Tool[] } {
  return {
    tools: tools.map(
      (t): Tool => ({
        toolSpec: {
          name: t.name,
          ...(t.description ? { description: stripExampleOrderIds(t.description) } : {}),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          inputSchema: { json: stripExampleOrderIds(t.inputSchema) as any },
        },
      })
    ),
  };
}

/**
 * One request = one gateway connection, opened here and closed when the request ends. Every
 * gateway call in the loop (list and tool calls) shares it; the user's token stays with this
 * request only.
 */
async function runAgent(
  prompt: string,
  token: string
): Promise<{ answer: string; steps: Step[]; refund?: RefundCard }> {
  const opened = await openGatewaySession(token);
  if (opened.status !== "ok") {
    throw new UpstreamError(`Gateway connection failed (${opened.status}): ${opened.message}`);
  }
  try {
    return await runAgentLoop(prompt, token, opened.session);
  } finally {
    await opened.session.close();
  }
}

/** The model-driven loop: Converse -> tool_use (in parallel) -> gateway -> toolResult -> Converse. */
async function runAgentLoop(
  prompt: string,
  token: string,
  session: GatewaySession
): Promise<{ answer: string; steps: Step[]; refund?: RefundCard }> {
  const listed = await session.listTools();
  if (listed.status !== "ok") {
    throw new UpstreamError(`Gateway tools/list failed (${listed.status}): ${listed.message}`);
  }
  const first = listed.tools[0];
  if (first) {
    console.log(`[agent] first listed tool: ${first.name} _meta: ${JSON.stringify(first._meta ?? null)}`);
  }
  // Keep only tools whose gateway prefix (text before "___") equals their _meta.service tag.
  const tools = listed.tools.filter((t) => {
    const sep = t.name.indexOf("___");
    const service = t._meta?.service;
    return sep > 0 && typeof service === "string" && t.name.slice(0, sep) === service;
  });
  console.log(`[agent] ${tools.length} gateway tools kept: ${tools.map((t) => t.name).join(", ")}`);
  const known = new Set(tools.map((t) => t.name));
  // start_refund is the agent's own tool, offered alongside the filtered gateway tools. It is
  // always present, so the tool list is never empty.
  const toolConfig = { tools: [...toToolConfig(tools).tools, startRefundTool] };

  const messages: Message[] = [{ role: "user", content: [{ text: prompt }] }];
  const steps: Step[] = [];
  const confirmUrls: string[] = [];
  let refund: RefundCard | undefined;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let response;
    try {
      response = await bedrock.send(
        new ConverseCommand({
          modelId: MODEL_ID,
          system: [{ text: SYSTEM_PROMPT }],
          messages,
          toolConfig,
        }),
        { abortSignal: AbortSignal.timeout(BEDROCK_TIMEOUT_MS) }
      );
    } catch (err) {
      const name = err instanceof Error ? err.name : "Error";
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[bedrock] converse failed: ${name}: ${message}`);
      throw new UpstreamError(`Bedrock request failed (${name}): ${message}`);
    }

    const assistant = response.output?.message;
    if (!assistant) throw new UpstreamError("Bedrock returned no message.");
    messages.push(assistant);

    if (response.stopReason !== "tool_use") {
      const answer = (assistant.content ?? [])
        .map((b) => b.text)
        .filter((t): t is string => typeof t === "string")
        .join("\n")
        .trim();
      return { answer: cleanConfirmLinks(answer, confirmUrls), steps, ...(refund ? { refund } : {}) };
    }

    // Run every tool the model asked for in this turn concurrently. Each call settles on its
    // own: a failure becomes that call's error result and never cancels the others. Results go
    // back in a single message, in the order requested.
    const uses = (assistant.content ?? []).flatMap((b) =>
      b.toolUse?.toolUseId && b.toolUse.name ? [b.toolUse] : []
    );
    const batchHasOthers = (name: string) => uses.some((u) => u.name !== name);

    const outcomes = await Promise.all(
      uses.map(async (use): Promise<ToolOutcome> => {
        const name = use.name as string;
        const input =
          use.input && typeof use.input === "object" && !Array.isArray(use.input)
            ? (use.input as Record<string, unknown>)
            : {};
        try {
          if (name === START_REFUND_TOOL_NAME) {
            // Starting a refund must follow the lookups, in a later turn — never in their batch.
            if (batchHasOthers(START_REFUND_TOOL_NAME)) {
              console.log(`[agent] tool ${name} -> refused (same turn as other tools)`);
              return {
                ok: false,
                content: {
                  text:
                    "start_refund was not run: request it alone, in a later turn, after the " +
                    "lookups have succeeded.",
                },
              };
            }
            const result = await startRefund(token, input);
            console.log(`[agent] tool ${name} -> ${result.ok ? "ok" : "error"}`);
            return result.ok
              ? { ok: true, content: { text: JSON.stringify(result.data) }, refundData: result.data }
              : { ok: false, content: { text: result.message } };
          }
          if (!known.has(name)) {
            console.log(`[agent] tool ${name} -> not offered`);
            return { ok: false, content: { text: `Unknown tool "${name}". Use only the provided tools.` } };
          }
          const result = await session.callTool(name, input);
          console.log(`[agent] tool ${name} -> ${result.status}`);
          return result.status === "ok"
            ? { ok: true, content: { text: JSON.stringify(result.data ?? null) } }
            : { ok: false, content: { text: result.message } };
        } catch (err) {
          console.log(`[agent] tool ${name} -> failed: ${err instanceof Error ? err.name : "Error"}`);
          return { ok: false, content: { text: "The tool call failed unexpectedly." } };
        }
      })
    );

    const results: ContentBlock[] = [];
    outcomes.forEach((o, i) => {
      const use = uses[i];
      steps.push({ tool: use.name as string, ok: o.ok });
      if (o.refundData) {
        if (typeof o.refundData.confirmUrl === "string") confirmUrls.push(o.refundData.confirmUrl);
        refund = toRefundCard(o.refundData) ?? refund;
      }
      results.push({
        toolResult: {
          toolUseId: use.toolUseId as string,
          content: [o.content],
          status: o.ok ? "success" : "error",
        },
      });
    });
    messages.push({ role: "user", content: results });
  }

  return {
    answer: `I couldn't finish within ${MAX_ITERATIONS} steps. Please try a more specific request.`,
    steps,
  };
}

const server = createServer(async (req, res) => {
  const { method } = req;
  const path = (req.url ?? "").split("?")[0];

  if (method === "GET" && path === "/ping") {
    return send(res, 200, { status: "Healthy", time_of_last_update: Math.floor(Date.now() / 1000) });
  }

  if (method === "POST" && path === "/invocations") {
    const gatewayToken = resolveGatewayToken(req);
    if (!gatewayToken) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="refundbot-agent"');
      return send(res, 401, {
        error: "Missing bearer token. Send `Authorization: Bearer <token>` with the request.",
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, { error: "Request body must be valid JSON." });
    }
    const prompt = (parsed as { prompt?: unknown } | null)?.prompt;
    if (typeof prompt !== "string" || prompt.trim() === "") {
      return send(res, 400, { error: "`prompt` must be a non-empty string." });
    }
    try {
      return send(res, 200, await runAgent(prompt, gatewayToken));
    } catch (err) {
      if (err instanceof UpstreamError) return send(res, 502, { error: err.message });
      const message = err instanceof Error ? `${err.name}: ${err.message}` : "Unexpected error.";
      console.log(`[agent] unexpected failure: ${message}`);
      return send(res, 500, { error: "The agent failed unexpectedly." });
    }
  }

  send(res, 404, { error: "Not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[agent] listening on :${PORT} (bedrock ${REGION}, model ${MODEL_ID})`);
});
