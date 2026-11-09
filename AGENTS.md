<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# InFusion Agent / RefundBot — repo conventions

Three authorization layers, and they must stay independent. Don't "simplify" one to call
another:

- **Scope + role**, checked twice: `sandboxCheck` in `lib/agent.ts` (the agent's own
  pre-flight) and `authGate` in `lib/mcp-server.ts` (the resource server's). The second
  verifies its bearer token through `lib/mcp-auth.ts`, which deliberately stands up its
  own JWKS path rather than importing `lib/session.ts` — that separation *is* the demo.
- **FGA (Permify)**, `lib/fga.ts`: the per-resource question. Also asked twice —
  `fgaPreflight` in the agent, and inside the three resource-bearing tool handlers.

Invariants worth knowing before you edit:

- `permify/schema.perm`, the `AGENT_SCHEMA` constant, and the `demoCheck` fallback
  resolver in `lib/fga.ts` all encode the same rules. Change one, change all three, or
  live and demo mode will disagree.
- `lib/org-graph.ts` *derives* the FGA entity graph from `lib/payroll.ts`,
  `lib/directory.ts`, and `lib/knowledge-base.ts`. Add a team/employee/restricted article
  there, not here.
- Dependencies point one way: mock data modules (`payroll`, `directory`, `tickets`,
  `knowledge-base`) never import a service client. `org-graph` reads them, `fga` reads
  `org-graph`, and the tool handlers read everything.
- Adding a scope to `lib/scopes.ts` is a change to FusionAuth configuration, not just to
  code: an authorize request naming an undefined scope is rejected wholesale, so a new
  catalog entry would break every login. `lib/bff.ts` absorbs that (learn → drop → retry
  once) and `/admin` flags the gap — keep both working if you touch the login path. A
  catalog entry may set `id: null` to ship a tool gated on role alone, which is how
  `search_public_docs` avoids demanding configuration; `scopeForTool` then returns
  undefined, and callers must read that as "no scope check to run", never as "deny".
- Optional services degrade with a visible banner, never a throw: FusionAuth Entity,
  Anthropic, Permify, User Search, the external MCP server. Keep it that way — an honest
  fallback is part of the product, not a workaround.
- Every MCP round trip is wrapped in a hard wall-clock deadline. `Client.connect()` takes
  no timeout of its own, so a server that accepts the socket and never finishes the
  handshake will hang the turn — the per-call `timeout` option does not cover it. Keep
  `MCP_CALL_TIMEOUT_MS` above `EXTERNAL_MCP_TIMEOUT_MS`: one internal tool proxies outward.
- `lib/external-docs.ts` is the only code that leaves the network. Two rules there are
  load-bearing, not stylistic: the employee's access token is never forwarded, and the
  answer is untrusted content — display it, attribute it, and never let it influence tool
  selection or the planner.
- `components/ArchitectureDiagram.tsx` and `components/AuthorizationTrace.tsx` render the
  *same* `TraceStep[]` (the `/chat` employee demo). A new trace layer needs a `TraceLayer`
  case in both, or the diagram silently ignores it. RefundBot's trace is a separate model
  (`ChainEntry[]` in `lib/refund-types.ts`) rendered by both `ExchangeChainTrace.tsx` and
  `RefundArchitectureDiagram.tsx` — a new entry shape needs handling in both (`toBeats`).

RefundBot (`/refund`, `/support/approvals`) adds a fourth layer — **RFC 8693 Token
Exchange** — with its own invariants:

- Every hop exchanges the customer's *original* access token, never a previous hop's
  exchanged token. Chaining would nest `act` and run into Max act claim depth.
- Only `lib/entities.ts` creates the orchestrator → banking-api Entity Grant, only from
  `executeBankingHop` in `lib/refund-pipeline.ts`, only after `approvalsSatisfied`, and
  it is deleted in a `finally` every time. Hold `withBankingLock` around anything that
  touches or probes that Grant.
- The four refund MCP tools authorize with `exchangeGate` (exchanged token + own audience
  + `act.sub` = orchestrator), not scope + role; `authGate` refuses exchanged tokens.
  Don't merge the two. `process_refund` must keep its own approval-record check —
  `approved_by` on the token is cross-checked against the record, never trusted alone.
- Token-exchange refusals go into the trace verbatim (`describeFailure`). Don't
  paraphrase or swallow them.
- `RefundRecord.subjectToken` never leaves the server: browsers get `toView(record)`.
- `lib/mcp-auth.ts` may import `lib/refund-services.ts` and `lib/simulated-exchange.ts`
  (both import nothing session-related), never `lib/token-exchange.ts` or
  `lib/session.ts`. Simulated tokens are accepted only while the cached mode is
  `simulated`.
- Live Token Exchange is the expected state; the simulated chain is a bannered
  portability fallback. Don't design UI around it being off.
