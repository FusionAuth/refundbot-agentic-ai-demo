import type { RefundService, RefundToolName } from "@/lib/refund-types";

/**
 * The four backend services and the orchestrator, as FusionAuth Entities. Their client
 * Ids come from env; each service's client Id is the `audience` a token exchange
 * targets. Imports nothing, so the MCP resource server's independent verifier
 * (lib/mcp-auth.ts) can read the audience list without pulling in any session code.
 *
 * Unset ids fall back to readable placeholder names. Those only ever work in the
 * simulated exchange chain — a live FusionAuth exchange against `banking-api` (not a
 * real Entity client Id) is refused, and the trace says so verbatim.
 */

export interface ServiceDef {
  service: RefundService;
  label: string;
  tool: RefundToolName;
  hop: 1 | 2 | 3 | 4;
  envVar: string;
  fallbackId: string;
  /** Hops 1–3 have a standing Grant; banking-api never does. */
  standingGrant: boolean;
}

export const SERVICE_DEFS: ServiceDef[] = [
  {
    service: "order-history",
    label: "order-history-service",
    tool: "get_order_history",
    hop: 1,
    envVar: "FUSIONAUTH_ORDER_HISTORY_ENTITY_ID",
    fallbackId: "order-history-service",
    standingGrant: true,
  },
  {
    service: "customer-scoring",
    label: "customer-scoring-service",
    tool: "score_customer_value",
    hop: 2,
    envVar: "FUSIONAUTH_SCORING_ENTITY_ID",
    fallbackId: "customer-scoring-service",
    standingGrant: true,
  },
  {
    service: "refund-budget",
    label: "refund-budget-service",
    tool: "check_refund_budget",
    hop: 3,
    envVar: "FUSIONAUTH_BUDGET_ENTITY_ID",
    fallbackId: "refund-budget-service",
    standingGrant: true,
  },
  {
    service: "banking-api",
    label: "banking-api",
    tool: "process_refund",
    hop: 4,
    envVar: "FUSIONAUTH_BANKING_ENTITY_ID",
    fallbackId: "banking-api",
    standingGrant: false,
  },
];

export function serviceDef(service: RefundService): ServiceDef {
  return SERVICE_DEFS.find((s) => s.service === service)!;
}

/** The audience (Entity client Id) for a service. */
export function audienceFor(service: RefundService): string {
  const def = serviceDef(service);
  return process.env[def.envVar]?.trim() || def.fallbackId;
}

/** True when the service's Entity id is actually configured. */
export function serviceConfigured(service: RefundService): boolean {
  return !!process.env[serviceDef(service).envVar]?.trim();
}

/** Every service audience — the set the MCP verifier accepts on an exchanged token. */
export function allServiceAudiences(): string[] {
  return SERVICE_DEFS.map((s) => audienceFor(s.service));
}

/** The service a token's audience names, if any. */
export function serviceForAudience(aud: string[]): RefundService | undefined {
  return SERVICE_DEFS.find((s) => aud.includes(audienceFor(s.service)))?.service;
}

/** The orchestrator Entity's id (its client Id — leave FusionAuth's default, id == client Id). */
export function orchestratorId(): string {
  return process.env.FUSIONAUTH_ORCHESTRATOR_ENTITY_ID?.trim() || "refundbot-orchestrator";
}

export function orchestratorSecret(): string | undefined {
  return process.env.FUSIONAUTH_ORCHESTRATOR_ENTITY_SECRET?.trim() || undefined;
}

/** All six env values a live exchange chain needs. */
export function exchangeEnvConfigured(): boolean {
  return (
    !!process.env.FUSIONAUTH_ORCHESTRATOR_ENTITY_ID?.trim() &&
    !!orchestratorSecret() &&
    SERVICE_DEFS.every((s) => serviceConfigured(s.service))
  );
}
