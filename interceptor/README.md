# RefundBot gateway interceptor

An AWS Lambda for **Amazon Bedrock AgentCore Gateway** (Node 22, TypeScript). It is a
**REQUEST interceptor**: before a `tools/call` for `get_order_history` reaches its target, it
asks Permify whether the caller may request a refund on that order. It mirrors
`checkOrderOwnership` in `lib/fga.ts` but is self-contained and imports nothing from the
Next.js app.

## Behavior

Input is `interceptorInputVersion` `1.0`, with the MCP request at `event.mcp.gatewayRequest`.

| Request | Result |
|---|---|
| Not a `tools/call` | Passed through unchanged |
| Tool name does not end with `get_order_history` | Passed through unchanged |
| `arguments.orderId` missing or empty | Passed through unchanged |
| Caller's `sub` can't be read from the `Authorization` JWT | **Denied** (403) |
| `orderId` has anything other than letters, digits, `-` and `_` (for example a `.`) | **Denied** (403), no Permify call |
| Either candidate entity (below) is allowed for `request_refund` | `transformedGatewayRequest` (the original body) |
| Both are denied | **Denied** (403) |
| Either Permify call errors, times out, or is unreachable | **Denied** (403), fail closed |

A denial is `transformedGatewayResponse` with `statusCode` 403 and a short JSON-RPC error
(`code` -32003) carrying the original request `id`.

### Ownership check

The Permify call is the one `check()` makes in `lib/fga.ts`: `POST
{PERMIFY_URL}/v1/tenants/{PERMIFY_TENANT}/permissions/check` with permission
`request_refund` and subject `user:<sub>`.

The app names an order's Permify entity two ways (`orderEntityId()` in
`lib/refund-data.ts`): the bare upper-cased id for an order on a shared account, and
`<ORDERID>.<sub>` for an order on a per-customer account (personal or business). The Lambda
no longer keeps a list of which orders are which. It upper-cases and trims the id as
`orderEntityId()` does, then builds **both** candidates:

- `order:<ORDERID>`
- `order:<ORDERID>.<sub>`

It runs the two checks **in parallel** and allows if **either** passes. If both are denied it
denies. If **either call errors** (network, timeout, non-2xx, unreadable response) it denies,
even when the other call would have passed. The cost is two Permify calls per gated request.

The `orderId` is rejected before any call if it contains characters outside
`[A-Za-z0-9_-]`, so a caller can't splice a `.` into it and have it read as someone else's
`<ORDERID>.<sub>` entity.

The token is only **decoded** (payload read, signature not checked); the gateway has already
verified it. The Lambda never logs the token, its claims, or the user id. It logs the tool
name and the decision, and on a failure the error name and message.

## Environment variables

Same names the app uses (`permifyConfig` in `lib/fga.ts`).

| Variable | Required | Default | Notes |
|---|---|---|---|
| `PERMIFY_URL` | yes | none | Permify REST base URL, reachable from the Lambda. Unset means every gated call is denied. The app's `localhost` default is deliberately not used here. |
| `PERMIFY_TENANT` | no | `t1` | Permify tenant id. |
| `PERMIFY_TOKEN` | no | none | Preshared key, sent as `Authorization: Bearer`. The app calls it `PERMIFY_TOKEN`; there is no `PERMIFY_API_KEY`. Treat it as a secret (Lambda environment encryption, or fetch it from Secrets Manager). |
| `PERMIFY_TIMEOUT_MS` | no | `2500` | Per-check timeout. Keep the Lambda timeout comfortably above it. |

Nothing secret is stored in this folder.

## Build, test and package

```bash
cd interceptor
npm install
npm run typecheck
npm test               # builds, then runs test/mock-permify.mjs against a mock Permify
npm run package        # esbuild bundle -> dist/index.mjs, zipped to interceptor.zip
```

`test/mock-permify.mjs` starts a local mock Permify and runs the bundled handler against it.
It covers: the per-customer form allowed, the shared (bare) form allowed, both forms checked
every time, id normalization, both denied, another customer's order, one call erroring (fails
closed), a `.` in the `orderId`, an unreadable token, the pass-through cases, and Permify
being unreachable.

The bundle has no runtime dependencies. Create the function with runtime `nodejs22.x`,
handler `index.handler`, and upload `interceptor.zip`.

## Attach it to the gateway

1. **Create the Lambda** (runtime `nodejs22.x`, handler `index.handler`) and set the
   environment variables above. It must be able to reach Permify over the network (VPC, NAT
   or a public endpoint, depending on where Permify runs).
2. **Let the gateway invoke it.** The gateway's service role needs `lambda:InvokeFunction`
   on this one function's ARN, not a wildcard.
3. **Attach it as a REQUEST interceptor with `passRequestHeaders` set to `true`.** Headers are
   only sent to the Lambda when this is on; without it the `Authorization` header is absent
   and every gated call is denied. Use `update-gateway` on an existing gateway; it takes the
   gateway's full configuration, so repeat the values you already use:

   ```bash
   aws bedrock-agentcore-control update-gateway \
     --gateway-identifier <gateway-id> \
     --name <gateway-name> \
     --role-arn <gateway-service-role-arn> \
     --protocol-type MCP \
     --authorizer-type CUSTOM_JWT \
     --authorizer-configuration '<your existing authorizer configuration>' \
     --interceptor-configurations '[{
       "interceptor": { "lambda": { "arn": "<interceptor-lambda-arn>" } },
       "interceptionPoints": ["REQUEST"],
       "inputConfiguration": { "passRequestHeaders": true }
     }]' \
     --region <region> --profile <profile>
   ```

   (For `create-gateway` the `--interceptor-configurations` value is the same.) A gateway
   allows at most one REQUEST interceptor.
4. **Test it.** Call `tools/call` for `<target>___get_order_history` with an order you own, an
   order you don't, and no `orderId`; the first and last pass, the second returns 403.

## Things to know

- **Permify must already hold the customer's data.** The Lambda only reads. The app seeds a
  customer's accounts and orders into Permify the first time that customer goes through
  `checkOrderOwnership` (`syncCustomerFga`). A customer who has never done so is denied.
- **No order list to keep in sync.** The Lambda checks both entity forms, so adding an order
  in `lib/refund-data.ts` needs no change here. If the app ever adds a third entity-id form,
  `candidateOrderEntityIds` in `src/index.ts` must learn it.
- **The schema and rules live in the app** (`permify/schema.perm`, `REFUND_SCHEMA` in
  `lib/fga.ts`). This Lambda only asks the question.
- **No in-memory fallback.** The app falls back to a local resolver when Permify is down; the
  Lambda fails closed instead.
- **Scope:** only `get_order_history` is gated. Other tools pass through unchanged.
