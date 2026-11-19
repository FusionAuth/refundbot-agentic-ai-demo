import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

/**
 * Minimal MCP client for the AgentCore gateway. One short-lived client per operation:
 * open (connect), use (listTools / callTool), close (finally). The URL comes from
 * GATEWAY_URL; the bearer token is supplied by the caller for every operation. Tool names
 * are whatever the gateway lists (target prefix included) -- nothing is hardcoded here.
 * No token exchange, FGA, or approval logic lives here.
 */

export type GatewayResult =
  | { status: "ok"; data: unknown }
  | { status: "tool_error"; message: string; data?: unknown }
  | { status: "not_configured"; message: string }
  | { status: "timeout"; message: string }
  | { status: "network_error"; message: string };

export interface GatewayTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export type GatewayListResult =
  | { status: "ok"; tools: GatewayTool[] }
  | { status: "not_configured"; message: string }
  | { status: "timeout"; message: string }
  | { status: "network_error"; message: string };

class DeadlineError extends Error {}

function timeoutMs(): number {
  return Number(process.env.GATEWAY_TIMEOUT_MS) || 30_000;
}

/** `connect()` and `close()` take no timeout of their own, so bound them explicitly. */
function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(`${label} exceeded ${ms}ms`)), ms);
  });
  return Promise.race([work, guard]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function isTimeout(err: unknown): boolean {
  if (err instanceof DeadlineError) return true;
  // The SDK's own per-request timeout surfaces as an error whose message mentions it.
  const msg = err instanceof Error ? err.message : "";
  return /timed out|timeout/i.test(msg);
}

/** The JSON-RPC method (and tool name) of an outgoing request, for log lines only. */
function describeRequest(init?: RequestInit): string {
  const verb = init?.method ?? "GET";
  if (typeof init?.body !== "string") return verb;
  try {
    const msg = JSON.parse(init.body);
    const first = Array.isArray(msg) ? msg[0] : msg;
    const method = typeof first?.method === "string" ? first.method : undefined;
    const tool =
      method === "tools/call" && typeof first?.params?.name === "string"
        ? ` (${first.params.name})`
        : "";
    return method ? `${verb} ${method}${tool}` : verb;
  } catch {
    return verb;
  }
}

/** fetch wrapper that logs each gateway request. Never logs request headers or the token. */
const loggingFetch: typeof fetch = async (input, init) => {
  const what = describeRequest(init);
  try {
    const res = await fetch(input, init);
    const wwwAuth = res.headers.get("www-authenticate");
    console.log(
      `[gateway] ${what} -> ${res.status}` + (wwwAuth ? ` www-authenticate: ${wwwAuth}` : "")
    );
    if (res.status === 401 || res.status === 403) {
      const body = await res.clone().text().catch(() => "");
      console.log(`[gateway] ${what} -> ${res.status} body: ${body}`);
    }
    return res;
  } catch (err) {
    console.log(
      `[gateway] ${what} failed: ${err instanceof Error ? err.name : "Error"}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    throw err;
  }
};

type Failure = Exclude<GatewayResult, { status: "ok" | "tool_error" }>;

/** Open a client, run `use`, always close. Failures come back as a tagged result. */
async function withGatewayClient<T>(
  token: string,
  label: string,
  use: (client: Client, remaining: () => number) => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; failure: Failure }> {
  const url = process.env.GATEWAY_URL?.trim();
  if (!url || !token) {
    return {
      ok: false,
      failure: {
        status: "not_configured",
        message: "GATEWAY_URL must be set and a bearer token supplied to call the gateway.",
      },
    };
  }

  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: loggingFetch,
  });
  const client = new Client({ name: "refundbot-agent", version: "0.1.0" });
  const deadline = Date.now() + timeoutMs();
  const remaining = () => Math.max(1_000, deadline - Date.now());

  try {
    await withDeadline(client.connect(transport), Math.min(10_000, remaining()), "Gateway connect");
    return { ok: true, value: await use(client, remaining) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.log(`[gateway] ${label} failed: ${err instanceof Error ? err.name : "Error"}: ${detail}`);
    if (isTimeout(err)) {
      return { ok: false, failure: { status: "timeout", message: `Gateway did not respond in time: ${detail}` } };
    }
    return {
      ok: false,
      failure: {
        status: "network_error",
        message: `Could not complete the gateway request (connection, auth, or protocol failure): ${detail}`,
      },
    };
  } finally {
    try {
      await withDeadline(client.close(), 3_000, "Gateway close");
    } catch {
      // Closing must never mask the real result.
    }
  }
}

/** tools/list: every tool the gateway exposes to this token, with its full prefixed name. */
export async function listGatewayTools(token: string): Promise<GatewayListResult> {
  const out = await withGatewayClient(token, "tools/list", async (client, remaining) => {
    const tools: GatewayTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await withDeadline(
        client.listTools(cursor ? { cursor } : undefined, { timeout: remaining() }),
        remaining(),
        "Gateway tools/list"
      );
      for (const t of res.tools) {
        tools.push({
          name: t.name,
          description: t.description,
          inputSchema: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
          _meta: t._meta as Record<string, unknown> | undefined,
        });
      }
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    return tools;
  });
  return out.ok ? { status: "ok", tools: out.value } : out.failure;
}

/** tools/call by the full prefixed name returned from listGatewayTools. */
export async function callGatewayTool(
  token: string,
  name: string,
  args: Record<string, unknown>
): Promise<GatewayResult> {
  const out = await withGatewayClient(token, `tools/call (${name})`, async (client, remaining) => {
    const res = await withDeadline(
      client.callTool({ name, arguments: args }, { timeout: remaining() }),
      remaining(),
      `Gateway ${name} call`
    );
    const content = (res.content ?? []) as Array<{ type: string; text?: string }>;
    const text = content.find((b) => b.type === "text")?.text;
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      // Not JSON; keep the raw text.
    }
    if (res.isError) {
      return {
        status: "tool_error" as const,
        message: typeof text === "string" && text ? text : "The gateway tool reported an error.",
        data,
      };
    }
    return { status: "ok" as const, data };
  });
  return out.ok ? out.value : out.failure;
}
