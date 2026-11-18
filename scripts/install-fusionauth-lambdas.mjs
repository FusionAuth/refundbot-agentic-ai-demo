// Installs RefundBot's FusionAuth lambdas and wires them into the Tenant. Idempotent.
//
//   node --env-file=.env.local scripts/install-fusionauth-lambdas.mjs
//
//   1. MFA Requirement lambda  → tenant.lambdaConfiguration.multiFactorRequirementId
//   2. A narrow API key (GET /api/entity/grant only, Tenant-locked), stored as the
//      lambda secret `refundbot-grant-reader`
//   3. Token Exchange Policy lambda → tenant.tokenExchangeConfiguration.policyEngine = LAMBDA
//
// Set ROLLBACK=1 to put the Tenant back on the ENTITY policy engine (lambdas are kept).
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const env = (k, fallback) => {
  const v = process.env[k]?.trim() || fallback;
  if (!v) throw new Error(`Missing ${k}`);
  return v;
};
const FA = env("FUSIONAUTH_URL").replace(/\/$/, "");
const TENANT = env("FUSIONAUTH_TENANT_ID");
const headers = {
  Authorization: env("FUSIONAUTH_API_KEY"),
  "X-FusionAuth-TenantId": TENANT,
  "Content-Type": "application/json",
};
const APP_BASE = env("APP_PUBLIC_URL", process.env.APP_BASE_URL).replace(/\/$/, "");

// Fixed ids so re-running updates instead of duplicating.
const IDS = {
  mfaLambda: "7e3f2a10-5b1c-4d7e-9a01-0c0f5e6d2b11",
  policyLambda: "7e3f2a10-5b1c-4d7e-9a01-0c0f5e6d2b12",
  apiKey: "7e3f2a10-5b1c-4d7e-9a01-0c0f5e6d2b13",
  secret: "7e3f2a10-5b1c-4d7e-9a01-0c0f5e6d2b14",
};

async function call(method, path, body, { allow404 = false, global = false } = {}) {
  const h = { ...headers };
  if (global) delete h["X-FusionAuth-TenantId"];
  const res = await fetch(`${FA}${path}`, { method, headers: h, body: body && JSON.stringify(body) });
  if (allow404 && res.status === 404) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

async function upsertLambda(id, name, type, file, replacements = {}) {
  let body = readFileSync(new URL(`../fusionauth/lambdas/${file}`, import.meta.url), "utf8");
  for (const [k, v] of Object.entries(replacements)) body = body.replaceAll(k, v);
  const lambda = { name, type, body, engineType: "GraalJS", debug: true };
  const existing = await call("GET", `/api/lambda/${id}`, undefined, { allow404: true, global: true });
  await call(existing ? "PUT" : "POST", `/api/lambda/${id}`, { lambda }, { global: true });
  console.log(`${existing ? "updated" : "created"} lambda ${name} (${id})`);
}

if (process.env.ROLLBACK === "1") {
  await call("PATCH", `/api/tenant/${TENANT}`, {
    tenant: { tokenExchangeConfiguration: { policyEngine: "ENTITY", policyEngineLambdaId: null } },
  });
  console.log("Tenant token exchange policy engine → ENTITY");
  process.exit(0);
}

// 1. MFA Requirement
await upsertLambda(IDS.mfaLambda, "RefundBot — refund step-up requirement", "MFARequirement",
  "refund-step-up-requirement.js");

await call("PATCH", `/api/tenant/${TENANT}`, {
  tenant: { lambdaConfiguration: { multiFactorRequirementId: IDS.mfaLambda } },
});
console.log("Tenant: MFA requirement lambda assigned");

// 2. Grant-reader API key + lambda secret. Creating an API key needs a key that may call
// /api/api-key; if ours can't, create one in the Admin UI (Settings → API Keys: Tenant
// RefundBot, endpoint GET /api/entity/grant only) and pass it as GRANT_READER_API_KEY.
const haveSecret = await call("GET", `/api/key/${IDS.secret}`, undefined, { allow404: true, global: true });
if (!haveSecret) {
  let keyValue = process.env.GRANT_READER_API_KEY?.trim();
  if (!keyValue) {
    keyValue = randomBytes(32).toString("base64url");
    const probe = await fetch(`${FA}/api/api-key`, { headers: { Authorization: headers.Authorization } });
    if (probe.status === 401) {
      console.log(
        "\nSkipping the token exchange policy: this API key can't create API keys.\n" +
        "Create one in Settings → API Keys (Tenant: RefundBot; endpoint GET /api/entity/grant only),\n" +
        "then re-run with GRANT_READER_API_KEY=<key>."
      );
      process.exit(0);
    }
    await call("POST", `/api/api-key/${IDS.apiKey}`, {
      apiKey: {
        key: keyValue,
        tenantId: TENANT,
        metaData: { attributes: { description: "RefundBot token exchange policy lambda — reads Entity Grants only" } },
        permissions: { endpoints: { "/api/entity/grant": ["GET"] } },
      },
    }, { global: true });
    console.log("created grant-reader API key");
  }
  await call("POST", `/api/key/import/${IDS.secret}`, {
    key: { name: "refundbot-grant-reader", type: "Secret", secret: keyValue },
  }, { global: true });
  console.log("stored lambda secret refundbot-grant-reader");
} else {
  console.log("lambda secret refundbot-grant-reader already exists");
}

// 3. Token Exchange Policy
await upsertLambda(IDS.policyLambda, "RefundBot — token exchange policy", "TokenExchangePolicy",
  "refund-token-exchange-policy.js", {
    __ORCHESTRATOR_ID__: env("FUSIONAUTH_ORCHESTRATOR_ENTITY_ID"),
    __ORDER_HISTORY_ID__: env("FUSIONAUTH_ORDER_HISTORY_ENTITY_ID"),
    __SCORING_ID__: env("FUSIONAUTH_SCORING_ENTITY_ID"),
    __BUDGET_ID__: env("FUSIONAUTH_BUDGET_ENTITY_ID"),
    __BANKING_ID__: env("FUSIONAUTH_BANKING_ENTITY_ID"),
    __APP_CLIENT_ID__: env("FUSIONAUTH_CLIENT_ID"),
    __CONNECTOR_RESOURCE_URL__: env("CONNECTOR_RESOURCE_URL", `${APP_BASE}/mcp`),
    __FUSIONAUTH_URL__: FA,
  });

await call("PATCH", `/api/tenant/${TENANT}`, {
  tenant: {
    tokenExchangeConfiguration: { policyEngine: "LAMBDA", policyEngineLambdaId: IDS.policyLambda },
  },
});
console.log("Tenant: token exchange policy engine → LAMBDA");
