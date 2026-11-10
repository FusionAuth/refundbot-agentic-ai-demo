/**
 * Application Role helpers, the same "no lambda" pattern the sibling apps use:
 * FusionAuth stamps the user's Application Roles onto the ACCESS token's `roles` claim
 * automatically once they're registered for the app, so every role decision keys off
 * the verified access-token claim (see lib/session.ts), never off UI state.
 *
 * Roles answer only the coarse question — "is this person support staff / an admin?" —
 * which gates /support/approvals and /admin. WHICH refund an employee may approve is a
 * relationship question (their store, their region, the amount) and lives in FGA by
 * Permify (lib/fga.ts), deliberately not here.
 */

/** The roles InFusion Agent understands, least → most privileged. */
export const ROLE_EMPLOYEE = "employee";
export const ROLE_MANAGER = "manager";
export const ROLE_IT_ADMIN = "it-admin";

/**
 * The admin role name that unlocks /admin is configurable so it can match
 * whatever the customer's FusionAuth application calls it. Defaults to "admin".
 */
export function adminRoleName(): string {
  return (process.env.INFUSIONAGENT_ADMIN_ROLE || "admin").trim();
}

/** Privilege order for picking a "primary" role to show on a badge. */
function roleRank(role: string): number {
  if (role === adminRoleName()) return 4;
  if (role === ROLE_IT_ADMIN) return 3;
  if (role === ROLE_MANAGER) return 2;
  if (role === ROLE_EMPLOYEE) return 1;
  return 0;
}

/**
 * Parses the OAuth `scope` claim off a set of verified token claims (space-delimited
 * string, or an array on a differently-configured tenant). Informational only — no
 * decision in this app keys off a custom scope any more.
 */
export function scopesFromClaims(claims: Record<string, unknown>): string[] {
  const raw = claims.scope ?? claims.scopes;
  if (Array.isArray(raw)) {
    return raw.filter((s): s is string => typeof s === "string" && s !== "");
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    return raw.split(/\s+/).filter(Boolean);
  }
  return [];
}

/**
 * Extracts roles from a set of verified token claims. FusionAuth emits `roles`
 * as a string array, but we tolerate a single string or comma-separated list
 * too, so a differently-configured tenant still works.
 */
export function rolesFromClaims(claims: Record<string, unknown>): string[] {
  const raw = claims.roles;
  if (Array.isArray(raw)) {
    return raw.filter((r): r is string => typeof r === "string" && r !== "");
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    return raw
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);
  }
  return [];
}

export function hasRole(roles: string[], role: string): boolean {
  const target = role.toLowerCase();
  return roles.some((r) => r.toLowerCase() === target);
}

/** True when the user holds the (configurable) admin role. */
export function isAdmin(roles: string[]): boolean {
  return hasRole(roles, adminRoleName());
}

export interface RoleBadgeStyle {
  label: string;
  /** Text color for the role chip. */
  color: string;
  /** Background for the role chip. */
  background: string;
}

/**
 * The single most-privileged role to feature on a badge, with a display label
 * and chip colors. Falls back to a neutral "Guest" when the token carries no
 * recognized role.
 */
export function primaryRoleBadge(roles: string[]): RoleBadgeStyle {
  const top = [...roles].sort((a, b) => roleRank(b) - roleRank(a))[0];
  if (top && top === adminRoleName()) {
    return { label: "Administrator", color: "#9a4e0a", background: "#fdecd8" };
  }
  if (top && top.toLowerCase() === ROLE_IT_ADMIN) {
    return { label: "IT Admin", color: "#0e4f4a", background: "#cdeeea" };
  }
  if (top && top.toLowerCase() === ROLE_MANAGER) {
    return { label: "Manager", color: "#1e3a8a", background: "#e0e7ff" };
  }
  if (top && top.toLowerCase() === ROLE_EMPLOYEE) {
    return { label: "Employee", color: "#0f5132", background: "#d7f0e2" };
  }
  return { label: "Guest", color: "#5a6478", background: "#eceef4" };
}

/**
 * RefundBot's support console reuses the Application-Role pattern: any of the
 * existing employee roles (or the admin role) may open /support/approvals and approve
 * or deny an escalated refund. Read off the verified access token, never UI state.
 */
export function isSupportStaff(roles: string[]): boolean {
  return (
    isAdmin(roles) ||
    [ROLE_EMPLOYEE, ROLE_MANAGER, ROLE_IT_ADMIN].some((r) => hasRole(roles, r))
  );
}
