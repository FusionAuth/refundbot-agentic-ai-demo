// Local test: runs the BUNDLED handler against a mock Permify server.
//   npm test        (builds first)
import assert from "node:assert/strict";
import http from "node:http";

// What the mock Permify knows: entity ids (for order:<id>) the user u1 may request_refund on.
const allowed = new Set(["ORD-1042.u1", "ORD-2201"]);
const erroring = new Set(); // entity ids that make the mock answer 500
let seen = []; // every check the mock received

const srv = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const b = JSON.parse(raw);
    seen.push({
      entity: `${b.entity.type}:${b.entity.id}`,
      permission: b.permission,
      subject: `${b.subject.type}:${b.subject.id}`,
      url: req.url,
    });
    if (erroring.has(b.entity.id)) {
      res.statusCode = 500;
      return res.end("boom");
    }
    const ok = b.subject.id === "u1" && allowed.has(b.entity.id);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ can: ok ? "CHECK_RESULT_ALLOWED" : "CHECK_RESULT_DENIED" }));
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
process.env.PERMIFY_URL = `http://127.0.0.1:${srv.address().port}`;
process.env.PERMIFY_TENANT = "t1";

const { handler } = await import(new URL("../dist/index.mjs", import.meta.url));

const jwt = (sub) => "h." + Buffer.from(JSON.stringify({ sub })).toString("base64url") + ".s";
const event = (body, { sub = "u1", auth } = {}) => ({
  interceptorInputVersion: "1.0",
  mcp: {
    gatewayRequest: {
      path: "/mcp",
      httpMethod: "POST",
      headers: { Authorization: auth ?? `Bearer ${jwt(sub)}` },
      body,
    },
  },
});
const call = (orderId, name = "target___get_order_history") => ({
  jsonrpc: "2.0",
  id: 7,
  method: "tools/call",
  params: { name, arguments: orderId === undefined ? {} : { orderId } },
});

const outcome = async (ev) => {
  seen = [];
  const out = await handler(ev);
  const deny = out.mcp.transformedGatewayResponse;
  return deny ? { decision: "deny", status: deny.statusCode, body: deny.body } : { decision: "pass", out };
};
const entitiesChecked = () => seen.map((s) => s.entity).sort();

const quiet = console.log;
console.log = () => {}; // the handler's own decision logs

let failures = 0;
const test = async (name, fn) => {
  try {
    await fn();
    quiet(`ok   ${name}`);
  } catch (e) {
    failures++;
    quiet(`FAIL ${name}\n     ${e.message}`);
  }
};

await test("per-customer order (ORD-1042.<sub> form) is allowed; both forms are checked", async () => {
  const r = await outcome(event(call("ORD-1042")));
  assert.equal(r.decision, "pass");
  assert.deepEqual(entitiesChecked(), ["order:ORD-1042", "order:ORD-1042.u1"]);
  assert.ok(seen.every((s) => s.permission === "request_refund" && s.subject === "user:u1"));
  assert.ok(seen.every((s) => s.url === "/v1/tenants/t1/permissions/check"));
});

await test("shared order (bare form) is allowed; both forms are checked", async () => {
  const r = await outcome(event(call("ORD-2201")));
  assert.equal(r.decision, "pass");
  assert.deepEqual(entitiesChecked(), ["order:ORD-2201", "order:ORD-2201.u1"]);
});

await test("order id is upper-cased and trimmed like orderEntityId()", async () => {
  const r = await outcome(event(call("  ord-1042 ")));
  assert.equal(r.decision, "pass");
  assert.deepEqual(entitiesChecked(), ["order:ORD-1042", "order:ORD-1042.u1"]);
});

await test("neither form passes -> 403 with the request id", async () => {
  const r = await outcome(event(call("ORD-9999")));
  assert.equal(r.decision, "deny");
  assert.equal(r.status, 403);
  assert.equal(r.body.id, 7);
  assert.deepEqual(entitiesChecked(), ["order:ORD-9999", "order:ORD-9999.u1"]);
});

await test("someone else's order -> 403", async () => {
  const r = await outcome(event(call("ORD-1042"), { sub: "u2" }));
  assert.equal(r.decision, "deny");
  assert.deepEqual(entitiesChecked(), ["order:ORD-1042", "order:ORD-1042.u2"]);
});

await test("one check errors (even if the other would pass) -> fail closed", async () => {
  erroring.add("ORD-2201.u1");
  const r = await outcome(event(call("ORD-2201")));
  erroring.clear();
  assert.equal(r.decision, "deny");
  assert.equal(r.status, 403);
});

await test("orderId with a '.' is rejected without calling Permify", async () => {
  const r = await outcome(event(call("ORD-1042.victim")));
  assert.equal(r.decision, "deny");
  assert.equal(seen.length, 0);
});

await test("unreadable token on a gated call -> 403, no Permify call", async () => {
  const r = await outcome(event(call("ORD-1042"), { auth: "garbage" }));
  assert.equal(r.decision, "deny");
  assert.equal(seen.length, 0);
});

await test("pass-through: tools/list, other tool, missing orderId", async () => {
  for (const body of [
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    call("ORD-1042", "target___process_refund"),
    call(undefined),
  ]) {
    const r = await outcome(event(body));
    assert.equal(r.decision, "pass");
    assert.equal(seen.length, 0);
    assert.deepEqual(r.out.mcp.transformedGatewayRequest.body, body);
  }
});

srv.close();
await test("Permify unreachable -> fail closed", async () => {
  const r = await outcome(event(call("ORD-1042")));
  assert.equal(r.decision, "deny");
  assert.equal(r.status, 403);
});

quiet(failures ? `\n${failures} test(s) failed` : "\nall tests passed");
process.exit(failures ? 1 : 0);
