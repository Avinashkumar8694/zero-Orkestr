// Tenant and workspace models mirroring zero-payment-ms

/** One row of GET /api/me/tenants - a workspace the signed-in user is an active member of. */
export interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  role: string;
  isCurrent?: boolean;
  /** A platform administrator's support access: a workspace they are not a member of but may open. */
  support?: boolean;
}

/** One row of GET /api/tenants - includes workspaces that are not usable yet (suspended, awaiting e-mail verification). */
export interface InactiveMembership {
  id: string;
  name: string;
  slug: string;
  status: string;
  plan: string;
  role: string;
  memberStatus: string;
}

/** GET /api/tenants/current - the selected workspace (plan, status and settings). */
export interface TenantInfo {
  id: string;
  name: string;
  slug: string;
  plan: string;
  planExpiresAt?: string | null;
  status: string;
  settings?: { timezone?: string; dateFormat?: string; brandName?: string; [key: string]: unknown };
}

/** GET /api/me/profile */
export interface MyProfile {
  /** server's verdict: may manage the platform (plans, limits) */
  platformAdmin?: boolean;
  userId: string;
  email: string;
  member?: {
    id: string;
    tenantId: string;
    role: string;
    status: string;
    displayName: string | null;
    permissions?: string[];
    joinedAt?: string | null;
  };
  tenant: { id: string; name: string; slug: string } | null;
}

export type TenantStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error';
