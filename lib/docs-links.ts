/**
 * FusionAuth documentation links used across the UI — one place, so they can't drift.
 * Every URL (and #anchor) here was checked against fusionauth.io/docs.
 */
const BASE = "https://fusionauth.io/docs";

export const DOCS = {
  tokenExchange: `${BASE}/authorization/token-exchange`,
  tokenExchangeProcess: `${BASE}/authorization/token-exchange#how-fusionauth-processes-an-exchange`,
  actorChain: `${BASE}/authorization/token-exchange#the-actor-chain`,
  entityPolicyEngine: `${BASE}/authorization/token-exchange#entity-policy-engine`,
  subjectTokens: `${BASE}/authorization/token-exchange#subject-tokens`,
  tokenExchangeAuditing: `${BASE}/authorization/token-exchange#auditing`,
  delegationGuide: `${BASE}/authorization/token-exchange-delegation`,
  tokenExchangeGrant: `${BASE}/apis/oauth/token#token-exchange-grant-request`,
  populateLambda: `${BASE}/lambdas/token-exchange/token-exchange-populate`,
  auditLogSearch: `${BASE}/apis/system/search-the-token-exchange-audit-log`,
  auditLogChain: `${BASE}/apis/system/retrieve-a-token-exchange-chain`,
  entityManagement: `${BASE}/concepts/types/entity-management`,
  entityGrantsApi: `${BASE}/apis/entities/grants`,
  mcpServerAccess: `${BASE}/authorization/mcp-server-access`,
  jwks: `${BASE}/apis/oauth/jwks`,
  roles: `${BASE}/get-started/core-concepts/roles`,
  mfa: `${BASE}/lifecycle/authenticate-users/multi-factor-authentication`,
  enterprisePlan: `${BASE}/concepts/plans-and-limits/plans-features`,
} as const;

export type DocKey = keyof typeof DOCS;
