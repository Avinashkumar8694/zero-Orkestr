import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { ApiKeysApiService, type ApiKeyRow, type CreatedApiKey } from '../../core/api/api-keys-api.service';
import { IamApiService } from '../../core/api/iam-api.service';
import { ModalService } from '../../shared/modal.service';
import { ToastService } from '../../shared/toast.service';
import type { PermissionInfo } from '../../core/models';
import { KNOWN_PERMISSIONS } from './permission-taxonomy';

// Admin → API keys. A key is for a program, not a person: it works in this workspace only, with exactly the permissions ticked here, and can expire or be
// revoked at once. The secret is shown once, when the key is created. Keys can never manage users, roles, keys or the workspace.
@Component({
  selector: 'app-api-keys',
  standalone: true,
  imports: [FormsModule, DatePipe],
  template: `
    @if (created(); as c) {
      <div class="secret card">
        <b>Copy this key now: it is shown only once.</b>
        <div class="keybox"><code>{{ c.key }}</code><button class="btn" (click)="copy(c.key)">{{ copied() ? 'Copied' : 'Copy' }}</button></div>
        <p class="muted sm">Send it as <code>X-API-Key: {{ c.key.slice(0, 14) }}…</code> (or <code>Authorization: ApiKey …</code>). Only a hash is kept here, so it cannot be shown again; if it is lost, revoke it and create another.</p>
        <button class="btn" (click)="created.set(null)">I have saved it</button>
      </div>
    }
    <div class="split">
      <div class="list card">
        <table>
          <thead><tr><th>Key</th><th>Can do</th><th>Expires</th><th>Last used</th><th></th></tr></thead>
          <tbody>
            @for (k of keys(); track k.id) {
              <tr [class.off]="state(k) !== 'active'">
                <td><b>{{ k.name }}</b><div class="muted sm"><code>ork_…{{ k.prefix }}</code> · by {{ k.createdBy }} · {{ k.createdAt | date: 'MMM d, y' }}</div></td>
                <td>@for (p of k.permissions; track p) { <span class="badge">{{ p }}</span> }</td>
                <td class="sm">{{ k.expiresAt ? (k.expiresAt | date: 'MMM d, y') : 'never' }}</td>
                <td class="sm">{{ k.lastUsedAt ? (k.lastUsedAt | date: 'MMM d, HH:mm') : 'never' }}</td>
                <td class="acts">
                  @if (state(k) === 'active') { <button class="btn danger" (click)="revoke(k)">Revoke</button> }
                  @else { <span class="badge archived">{{ state(k) }}</span> }
                </td>
              </tr>
            }
            @if (!keys().length) { <tr><td colspan="5" class="muted">No API keys yet. Create one on the right for an integration that should not sign in as a person.</td></tr> }
          </tbody>
        </table>
      </div>

      <form class="detail card" (ngSubmit)="create()">
        <h3>Create an API key</h3>
        <div class="field"><label>Name</label><input name="name" [(ngModel)]="name" maxlength="80" placeholder="what uses it, e.g. Billing system" /></div>
        <div class="field"><label>Expires</label>
          <select name="exp" [(ngModel)]="expiresInDays"><option [ngValue]="0">Never</option><option [ngValue]="30">In 30 days</option><option [ngValue]="90">In 90 days</option><option [ngValue]="365">In a year</option></select></div>
        <div class="field"><label>Permissions</label>
          @for (g of groups(); track g.name) {
            <div class="pgroup">{{ g.name }}</div>
            @for (p of g.items; track p.key) {
              <label class="chkrow"><input type="checkbox" [checked]="picked.includes(p.key)" (change)="toggle(p.key)" /> {{ p.label }} <span class="muted sm">· {{ p.key }}</span></label>
            }
          }
          <p class="muted sm">You can only give a key what you hold yourself. User, role, key and workspace administration are never available to keys.</p>
        </div>
        <button class="btn primary" type="submit" [disabled]="!name.trim() || !picked.length">Create key</button>
      </form>
    </div>
  `,
  styles: [`
    .split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 380px); gap: 16px; align-items: start; }
    @media (max-width: 1100px) { .split { grid-template-columns: 1fr; } }
    .list, .detail { padding: 14px 16px; } .detail h3 { margin: 0 0 12px; font-size: 14px; }
    .sm { font-size: 12px; } tr.off td { opacity: .55; } .badge + .badge { margin-left: 4px; } .badge { display: inline-block; margin: 1px 4px 1px 0; }
    .acts { white-space: nowrap; }
    .field { margin-bottom: 14px; } .field label { display: block; font-size: 12px; color: var(--muted); font-weight: 600; margin-bottom: 4px; }
    .field input[type=text], .field input:not([type]), .field select { width: 100%; border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; font-size: 13px; background: var(--surface); color: inherit; }
    .pgroup { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin: 10px 0 4px; font-weight: 700; }
    .chkrow { display: flex; align-items: center; gap: 8px; font-size: 13px; margin: 3px 0; } .chkrow input { width: auto; }
    .secret { padding: 14px 16px; margin-bottom: 16px; border: 1px solid var(--amber, #e0a800); background: var(--amber-bg, #fff4d6); display: flex; flex-direction: column; gap: 8px; }
    .keybox { display: flex; gap: 8px; align-items: center; } .keybox code { flex: 1; word-break: break-all; padding: 8px 10px; background: var(--surface); border-radius: 8px; border: 1px solid var(--border); font-size: 12.5px; }
  `],
})
export class ApiKeysComponent {
  private api = inject(ApiKeysApiService);
  private iam = inject(IamApiService);
  private modal = inject(ModalService);
  private toast = inject(ToastService);

  keys = signal<ApiKeyRow[]>([]);
  catalog = signal<PermissionInfo[]>(KNOWN_PERMISSIONS);
  created = signal<CreatedApiKey | null>(null);
  copied = signal(false);
  name = ''; expiresInDays = 0; picked: string[] = [];
  /** keys can never carry these, so they are not offered */
  groups = computed(() => {
    const by = new Map<string, PermissionInfo[]>();
    for (const p of this.catalog()) { if (p.key === '*' || p.key.startsWith('admin:') || p.key === 'team:manage') continue; by.set(p.group, [...(by.get(p.group) ?? []), p]); }
    return [...by].map(([name, items]) => ({ name, items }));
  });

  constructor() { this.load(); this.iam.listPermissions().subscribe({ next: (p) => this.catalog.set(p), error: () => {} }); }
  load() { this.api.list().subscribe({ next: (r) => this.keys.set(r.items), error: (e) => this.toast.error(e?.error?.error?.message || 'Could not load the API keys') }); }
  state(k: ApiKeyRow): 'active' | 'revoked' | 'expired' { return k.revokedAt ? 'revoked' : k.expiresAt && k.expiresAt <= new Date().toISOString() ? 'expired' : 'active'; }
  toggle(key: string) { const i = this.picked.indexOf(key); if (i >= 0) this.picked.splice(i, 1); else this.picked.push(key); }
  create() {
    this.api.create({ name: this.name.trim(), permissions: this.picked, ...(this.expiresInDays ? { expiresInDays: this.expiresInDays } : {}) }).subscribe({
      next: (k) => { this.created.set(k); this.copied.set(false); this.name = ''; this.picked = []; this.expiresInDays = 0; this.load(); },
      error: (e) => this.toast.error(e?.error?.error?.message || 'Could not create the key'),
    });
  }
  async copy(text: string) { try { await navigator.clipboard.writeText(text); this.copied.set(true); } catch { this.toast.error('Could not copy: select the key and copy it by hand'); } }
  async revoke(k: ApiKeyRow) {
    if (!(await this.modal.confirm({ title: 'Revoke API key?', message: `"${k.name}" stops working at once. Whatever uses it will get 401 until you give it a new key.`, confirmLabel: 'Revoke', danger: true }))) return;
    this.api.revoke(k.id).subscribe({ next: () => { this.toast.success('Key revoked'); this.load(); }, error: (e) => this.toast.error(e?.error?.error?.message || 'Could not revoke the key') });
  }
}
