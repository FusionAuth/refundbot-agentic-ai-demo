/**
 * Shared runtime helpers for RefundBot's orchestrator: the planner mode toggle and the
 * MCP round-trip plumbing. (Only what the customer-facing pipeline needs.)
 */

/** Live Claude planner when ANTHROPIC_API_KEY is set; the scripted planner otherwise. */
export function agentMode(): "live" | "scripted" {
  return process.env.ANTHROPIC_API_KEY ? "live" : "scripted";
}

/**
 * Wall-clock ceiling for a whole MCP round trip to our own server. `Client.connect()`
 * carries no timeout of its own, so without this a wedged transport hangs the turn.
 */
export function mcpCallDeadlineMs(): number {
  return Number(process.env.MCP_CALL_TIMEOUT_MS) || 30_000;
}

/** A hard bound around a promise — `connect()` and `close()` need one. */
export function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
  });
  return (Promise.race([work, guard]) as Promise<T>).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function appBaseUrl(): string {
  return (process.env.APP_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
}

/**
 * Where the orchestrator reaches its OWN MCP server. The server is this same process, so
 * on a host like Railway there's no reason to leave the container, go out through the
 * public edge, and come back in: `MCP_INTERNAL_URL` wins if set, then loopback on the
 * platform's `PORT`, then APP_BASE_URL (local dev, where PORT is usually unset). The
 * resource server's checks are identical either way — it verifies the bearer token, not
 * the network path.
 */
export function mcpBaseUrl(): string {
  const explicit = process.env.MCP_INTERNAL_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  if (process.env.PORT) return `http://127.0.0.1:${process.env.PORT}`;
  return appBaseUrl();
}
