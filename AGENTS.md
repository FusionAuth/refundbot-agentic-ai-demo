<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# RefundBot — repo conventions

The employee "Ask Fusion" chat (`/chat`), its scope catalog (`lib/scopes.ts`), its
sandbox/`authGate`, its employee tools, and their mock data are retired. Don't bring
them back piecemeal. What's left is customer-facing RefundBot, authorized by layers that
must stay independent — don't "simplify" one to call another:

- **Application Role** (`lib/roles.ts`): coarse — may this person open
  `/support/approvals` or `/admin` at all.
- **FusionAuth FGA** (`lib/fga.ts`): per-resource — ownership (`order#request_refund`,
  before hop 1), the approval cascade (`store#approve_local` → `region#approve_escalated`),
  and the customer trust tier (`account#auto_approve`).
- **RFC 8693 Token Exchange** (below): may the orchestrator get a token for THIS service.

Vocabulary is load-bearing: a **FusionAuth Entity** is the orchestrator or a service
audience (`lib/entities.ts`, `lib/refund-services.ts`); a **Permify entity / relation**
lives in the FGA schema (`lib/fga.ts`, `permify/schema.perm`). Keep FGA code out of
`lib/entities.ts` and vice versa, and say which one you mean in UI copy.

FGA invariants:

- `permify/schema.perm`, the `REFUND_SCHEMA` constant, and the `demoCheck` fallback
  resolver in `lib/fga.ts` all encode the same rules. Change one, change all three, or
  live and fallback mode will disagree. Rule string literals are single-quoted
  (`'trusted'`) — Permify's lexer drops double-quoted ones. Attribute writes use
  `base.v1.StringValue` / `base.v1.IntegerValue` with `data`.
- `lib/fga.ts` *derives* the Permify graph (accounts, orders, stores, region, tiers, caps)
  from `lib/refund-data.ts`. Add an order, store, or account there, not in `fga.ts`.
- Dependencies point one way: mock data modules (`refund-data`, `knowledge-base`) never
  import a service client. `fga` reads `refund-data`; the pipeline and routes read both.
- The ownership check runs before ANY exchange. On denial the pipeline stops — no token
  is requested and no MCP tool is called. The order-history service deliberately does not
  check ownership; don't "fix" that by duplicating the check there.
- `account#auto_approve` only removes the EMPLOYEE approval. The customer's out-of-band
  step-up confirmation is mandatory regardless of tier.
- Running Permify is not gated on any FusionAuth plan. Never put FGA behind the Token
  Exchange / Enterprise mode probe.
- FGA's results live on `RefundRecord.fga` (`lib/fga-types.ts`), rendered by
  `components/PermissionsGraph.tsx`. Don't merge Permify fields into the token chain;
  the chain only carries `layer: "fga"` breadcrumb notes, which `ExchangeChainTrace`
  (dashed row linking to the Permissions tab) and `RefundArchitectureDiagram`
  (`noteBeat`) both handle explicitly.

Other invariants:

- `/mcp` (`lib/connector-auth.ts`, `lib/connector-tools.ts`) is the customer-facing
  connector for ChatGPT / claude.ai (CIMD clients). It accepts only the customer's own
  token (aud includes the connector URL, no `act`), drives the same `startRefund`, and
  never confirms a refund itself — it returns a `/refund/confirm/<id>` link. Don't add a
  confirm tool, and don't loosen `/api/mcp`'s `exchangeGate` to serve chat apps.

- Logins request only OIDC base scopes (`lib/bff.ts`). There is no custom scope catalog;
  don't add one — an authorize request naming an undefined scope fails every login.
- Optional services degrade with a visible banner, never a throw: FusionAuth Entity,
  Anthropic, Permify, User Search. Keep it that way — an honest fallback is part of the
  product, not a workaround. Live is the expected state for both Token Exchange and FGA.
- Every MCP round trip is wrapped in a hard wall-clock deadline (`withDeadline`,
  `MCP_CALL_TIMEOUT_MS`). `Client.connect()` takes no timeout of its own, so a server that
  accepts the socket and never finishes the handshake would hang the turn.
- `components/RefundArchitectureDiagram.tsx` and `components/ExchangeChainTrace.tsx`
  render the same `ChainEntry[]` (`lib/refund-types.ts`) — a new entry shape or note layer
  needs handling in both (`toBeats` / `noteBeat`).

RFC 8693 Token Exchange invariants:

- Every hop exchanges the customer's *original* access token, never a previous hop's
  exchanged token. Chaining would nest `act` and run into Max act claim depth.
- Only `lib/entities.ts` creates the orchestrator → banking-api Entity Grant, only from
  `executeBankingHop` in `lib/refund-pipeline.ts`, only after `approvalsSatisfied`, and
  it is deleted in a `finally` every time. Hold `withBankingLock` around anything that
  touches or probes that Grant.
- The four refund MCP tools authorize with `exchangeGate` (exchanged token + own audience
  + `act.sub` = orchestrator). `process_refund` must keep its own approval-record check —
  `approved_by` on the token is cross-checked against the record, never trusted alone.
- With the Tenant on the `LAMBDA` policy engine (`fusionauth/lambdas/refund-token-exchange-policy.js`),
  the lambda IS the Grant check: it must keep looking up the orchestrator → service
  Entity Grant, or the on-demand banking-api Grant stops gating hop 4. Change the lambda
  file and re-run `scripts/install-fusionauth-lambdas.mjs`; don't edit it in the Admin UI.
- A refund confirmation always takes a code. A customer with no MFA method gets one
  emailed to enroll (`/api/two-factor/*` with `enroll`); don't restore a no-method bypass.
- Token-exchange refusals go into the trace verbatim (`describeFailure`). Don't
  paraphrase or swallow them.
- `RefundRecord.subjectToken` never leaves the server: browsers get `toView(record)`.
- `lib/mcp-auth.ts` may import `lib/refund-services.ts`, `lib/simulated-exchange.ts`,
  and `lib/roles.ts` (none import anything session-related), never
  `lib/token-exchange.ts`, `lib/session.ts`, or `lib/fga.ts`. Simulated tokens are accepted only while the cached mode is
  `simulated`.
- Live Token Exchange is the expected state; the simulated chain is a bannered
  portability fallback. Don't design UI around it being off.
