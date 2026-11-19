import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type Message,
  type Tool,
  type ToolResultContentBlock,
} from "@aws-sdk/client-bedrock-runtime";
import { callGatewayTool, listGatewayTools, type GatewayTool } from "./gateway";

const PORT = 8080;
const MAX_BODY_BYTES = 1_000_000;
const MAX_ITERATIONS = 8;
const BEDROCK_TIMEOUT_MS = 60_000;

const REGION = process.env.AWS_REGION || "us-east-2";
const MODEL_ID = process.env.BEDROCK_MODEL_ID || "anthropic.claude-sonnet-5-5";

const SYSTEM_PROMPT =
  "You are a refund assistant. Use only the provided tools to look anything up or act. " +
  "Never invent order data; every order detail you state must come from a tool result. " +
  "If a tool is denied or fails, say so plainly and stop — do not retry or work around it.";

const bedrock = new BedrockRuntimeClient({ region: REGION });

interface Step {
  tool: string;
  ok: boolean;
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

function toToolConfig(tools: GatewayTool[]): { tools: Tool[] } {
  return {
    tools: tools.map(
      (t): Tool => ({
        toolSpec: {
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          inputSchema: { json: t.inputSchema as any },
        },
      })
    ),
  };
}

/** The model-driven loop: Converse -> tool_use -> gateway -> toolResult -> Converse. */
async function runAgent(
  prompt: string,
  token: string
): Promise<{ answer: string; steps: Step[] }> {
  const listed = await listGatewayTools(token);
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
  // Bedrock rejects an empty tool list, so omit toolConfig entirely when there are none.
  const toolConfig = tools.length > 0 ? toToolConfig(tools) : undefined;

  const messages: Message[] = [{ role: "user", content: [{ text: prompt }] }];
  const steps: Step[] = [];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let response;
    try {
      response = await bedrock.send(
        new ConverseCommand({
          modelId: MODEL_ID,
          system: [{ text: SYSTEM_PROMPT }],
          messages,
          ...(toolConfig ? { toolConfig } : {}),
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
      return { answer, steps };
    }

    const results: ContentBlock[] = [];
    for (const block of assistant.content ?? []) {
      const use = block.toolUse;
      if (!use?.toolUseId || !use.name) continue;
      const input =
        use.input && typeof use.input === "object" && !Array.isArray(use.input)
          ? (use.input as Record<string, unknown>)
          : {};

      let ok = false;
      let content: ToolResultContentBlock;
      if (!known.has(use.name)) {
        content = { text: `Unknown tool "${use.name}". Use only the provided tools.` };
        console.log(`[agent] tool ${use.name} -> not offered`);
      } else {
        const result = await callGatewayTool(token, use.name, input);
        if (result.status === "ok") {
          ok = true;
          content = { text: JSON.stringify(result.data ?? null) };
        } else {
          content = { text: result.message };
        }
        console.log(`[agent] tool ${use.name} -> ${result.status}`);
      }
      steps.push({ tool: use.name, ok });
      results.push({
        toolResult: { toolUseId: use.toolUseId, content: [content], status: ok ? "success" : "error" },
      });
    }
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
