export type Role = "owner" | "manager" | "staff" | "customer";
export type Action =
  | "client.read" | "client.write"
  | "brief.read" | "brief.write"
  | "estimate.read" | "estimate.write" | "estimate.approve"
  | "rate.bill.write" | "rate.cost.read"
  | "audit.read" | "member.manage";

const ALL: Role[] = ["owner", "manager", "staff"];
const MATRIX: Record<Action, Role[]> = {
  "client.read": ALL, "client.write": ALL,
  "brief.read": ALL, "brief.write": ALL,
  "estimate.read": ALL, "estimate.write": ALL,
  "estimate.approve": ["owner", "manager"],
  "rate.bill.write": ["owner", "manager"],
  "rate.cost.read": ["owner", "manager"],
  "audit.read": ["owner", "manager"],
  "member.manage": ["owner"],
};

/** UI hint only. The database (RLS + triggers) is the authority and must agree with this matrix. */
export const can = (role: Role | null | undefined, action: Action): boolean => !!role && MATRIX[action].includes(role);
