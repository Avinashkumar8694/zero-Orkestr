import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import {
  type InactiveMembership,
  type MyProfile,
  type TenantInfo,
  type TenantStatus,
  type TenantSummary,
} from './tenant.models';
import {
  getSelectedTenantId,
  initTenantSelection,
  resetTenantSelection,
  setSelectedTenantId,
} from './tenant-selection';

export function permissionHeld(held: readonly string[], permission: string): boolean {
  if (held.includes('*') || held.includes(permission)) return true;
  const resource = permission.split(':')[0];
  if (resource === 'system') return false;
  return held.includes(`${resource}:*`);
}

@Injectable({ providedIn: 'root' })
export class TenantService {
  private http = inject(HttpClient);
  private router = inject(Router);

  private statusSig = signal<TenantStatus>('idle');
  private errorSig = signal<string | null>(null);
  private tenantsSig = signal<TenantSummary[]>([]);
  private inactiveSig = signal<InactiveMembership[]>([]);
  private selectedIdSig = signal<string | null>(null);
  private tenantInfoSig = signal<TenantInfo | null>(null);
  private profileSig = signal<MyProfile | null>(null);

  status = this.statusSig.asReadonly();
  error = this.errorSig.asReadonly();
  tenants = this.tenantsSig.asReadonly();
  inactiveMemberships = this.inactiveSig.asReadonly();
  tenantId = this.selectedIdSig.asReadonly();
  tenantInfo = this.tenantInfoSig.asReadonly();
  profile = this.profileSig.asReadonly();

  tenant = computed(() => {
    const id = this.selectedIdSig();
    return this.tenantsSig().find((t) => t.id === id) ?? null;
  });

  role = computed(() => {
    return this.profileSig()?.member?.role ?? this.tenant()?.role ?? null;
  });

  permissions = computed<string[]>(() => {
    return this.profileSig()?.member?.permissions ?? [];
  });

  /** whether the SERVER lets this user manage the platform (plans, limits) — unlike isSystemAdmin, never inferred from a role label */
  isPlatformAdmin = computed(() => this.profileSig()?.platformAdmin === true);

  isSystemAdmin = computed(() => {
    return (
      this.role() === 'system_admin' ||
      this.tenantsSig().some((t) => t.role === 'system_admin')
    );
  });

  private resolveReady!: () => void;
  ready: Promise<void> = new Promise((resolve) => {
    this.resolveReady = resolve;
  });

  can(permission: string): boolean {
    return permissionHeld(this.permissions(), permission);
  }

  async init(userSub: string | null): Promise<void> {
    if (!userSub) {
      this.reset();
      this.resolveReady();
      return;
    }

    this.statusSig.set('loading');
    this.errorSig.set(null);

    try {
      const preferredId = initTenantSelection(userSub);
      await this.loadTenantList(preferredId);
      const chosenId = this.selectedIdSig();

      if (chosenId) {
        await this.loadWorkspaceDetails(chosenId);
        this.statusSig.set('ready');
      } else if (this.tenantsSig().length === 0) {
        this.statusSig.set('empty');
      } else {
        this.statusSig.set('ready');
      }
    } catch (err: any) {
      this.errorSig.set(err?.message || 'Failed to load workspace');
      this.statusSig.set('error');
    } finally {
      this.resolveReady();
    }
  }

  async loadTenantList(preferredId?: string | null): Promise<TenantSummary[]> {
    try {
      const res = await firstValueFrom(
        this.http.get<{ success: boolean; data: TenantSummary[]; currentTenantId?: string | null }>(
          '/api/me/tenants'
        )
      );
      const list = Array.isArray(res.data) ? res.data : [];
      this.tenantsSig.set(list);

      const valid = (id?: string | null): id is string =>
        !!id && list.some((t) => t.id === id);

      const chosen = valid(preferredId)
        ? preferredId
        : valid(res.currentTenantId)
        ? res.currentTenantId
        : list[0]?.id ?? null;

      this.selectedIdSig.set(chosen);
      setSelectedTenantId(chosen);

      if (list.length === 0) {
        await this.loadInactiveMemberships();
      }

      return list;
    } catch (err: any) {
      if (err.status === 403) {
        await this.loadInactiveMemberships();
      }
      throw err;
    }
  }

  private async loadInactiveMemberships(): Promise<void> {
    try {
      const res = await firstValueFrom(
        this.http.get<{ success: boolean; data: InactiveMembership[] }>('/api/tenants')
      );
      const items = (res.data ?? []).filter((m) => m.status !== 'active');
      this.inactiveSig.set(items);
    } catch {
      this.inactiveSig.set([]);
    }
  }

  async loadWorkspaceDetails(tenantId: string): Promise<void> {
    try {
      const profileRes = await firstValueFrom(
        this.http.get<{ success: boolean; data: MyProfile }>('/api/me/profile', {
          headers: { 'x-tenant-id': tenantId },
        })
      );
      const infoRes = await firstValueFrom(
        this.http.get<{ success: boolean; data: TenantInfo }>('/api/tenants/current', {
          headers: { 'x-tenant-id': tenantId },
        })
      ).catch(() => null);

      if (profileRes?.data) this.profileSig.set(profileRes.data);
      if (infoRes?.data) this.tenantInfoSig.set(infoRes.data);
    } catch (err: any) {
      this.errorSig.set(err?.message || 'Failed to load workspace details');
      throw err;
    }
  }

  async selectTenant(tenantId: string): Promise<void> {
    if (!this.tenantsSig().some((t) => t.id === tenantId)) return;
    setSelectedTenantId(tenantId);
    this.selectedIdSig.set(tenantId);
    window.location.href = '/home';
  }

  async refresh(preferTenantId?: string): Promise<TenantSummary[]> {
    const list = await this.loadTenantList(preferTenantId ?? getSelectedTenantId());
    const next = preferTenantId && list.some((t) => t.id === preferTenantId)
      ? preferTenantId
      : getSelectedTenantId() && list.some((t) => t.id === getSelectedTenantId())
      ? getSelectedTenantId()
      : list[0]?.id ?? null;

    this.selectedIdSig.set(next);
    setSelectedTenantId(next);

    if (next) {
      await this.loadWorkspaceDetails(next);
      this.statusSig.set('ready');
    } else {
      this.statusSig.set('empty');
    }
    return list;
  }

  retry(): void {
    const id = this.selectedIdSig() || getSelectedTenantId();
    this.statusSig.set('loading');
    this.errorSig.set(null);
    this.loadTenantList(id)
      .then((list) => {
        const next = this.selectedIdSig() || list[0]?.id;
        if (next) return this.loadWorkspaceDetails(next);
        return null;
      })
      .then(() => {
        this.statusSig.set(this.selectedIdSig() ? 'ready' : 'empty');
      })
      .catch((err) => {
        this.errorSig.set(err?.message || 'Failed to retry loading workspace');
        this.statusSig.set('error');
      });
  }

  reset(): void {
    resetTenantSelection();
    this.statusSig.set('idle');
    this.errorSig.set(null);
    this.tenantsSig.set([]);
    this.inactiveSig.set([]);
    this.selectedIdSig.set(null);
    this.tenantInfoSig.set(null);
    this.profileSig.set(null);
  }

  async checkSlug(slug: string): Promise<{ available: boolean }> {
    const res = await firstValueFrom(
      this.http.get<{ success: boolean; data: { available: boolean } }>(
        `/api/tenants/check/${encodeURIComponent(slug)}`
      )
    );
    return res.data;
  }

  async signup(data: {
    name: string;
    slug: string;
    ownerEmail: string;
    ownerName?: string;
  }): Promise<{ id: string; name: string; slug: string }> {
    const res = await firstValueFrom(
      this.http.post<{ success: boolean; data: { id: string; name: string; slug: string } }>(
        '/api/tenants/signup',
        data
      )
    );
    return res.data;
  }
}
