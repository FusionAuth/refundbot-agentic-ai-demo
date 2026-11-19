import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { planRefundTurn } from "./planner";

const PORT = 8080;
const MAX_BODY_BYTES = 1_000_000;

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
      return send(res, 200, await planRefundTurn(prompt));
    } catch (err) {
      return send(res, 500, { error: err instanceof Error ? err.message : "Planner failed." });
    }
  }

  send(res, 404, { error: "Not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[agent] listening on :${PORT}`);
});
