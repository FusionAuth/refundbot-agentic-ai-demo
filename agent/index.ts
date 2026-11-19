import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { callGatewayTool } from "./gateway";
import { planRefundTurn } from "./planner";

const PORT = 8080;
const GATEWAY_TOOL_NAME = process.env.GATEWAY_TOOL_NAME || "get_order_history";
const GATEWAY_TARGET_PREFIX = process.env.GATEWAY_TARGET_PREFIX ?? "refundbot-mcp___";
const MAX_BODY_BYTES = 1_000_000;

/** Arguments each tool's schema accepts: orderId for two of them, none for scoring. */
function gatewayToolArgs(tool: string, orderId: string): Record<string, unknown> {
  switch (tool) {
    case "get_order_history":
    case "check_refund_budget":
      return { orderId };
    default:
      return {};
  }
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

const server = createServer(async (req, res) => {
  const { method } = req;
  const path = (req.url ?? "").split("?")[0];

  if (method === "GET" && path === "/ping") {
    return send(res, 200, { status: "Healthy", time_of_last_update: Math.floor(Date.now() / 1000) });
  }

  if (method === "POST" && path === "/invocations") {
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
      const plan = await planRefundTurn(prompt);
      if (plan.kind === "refund") {
        const orderHistory = await callGatewayTool(
          `${GATEWAY_TARGET_PREFIX}${GATEWAY_TOOL_NAME}`,
          gatewayToolArgs(GATEWAY_TOOL_NAME, plan.orderId)
        );
        return send(res, 200, { ...plan, orderHistory });
      }
      return send(res, 200, plan);
    } catch (err) {
      return send(res, 500, { error: err instanceof Error ? err.message : "Planner failed." });
    }
  }

  send(res, 404, { error: "Not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[agent] listening on :${PORT}`);
});
