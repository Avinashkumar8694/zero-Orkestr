import { Component, computed, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IamApiService } from '../../core/api/iam-api.service';
import { ToastService } from '../../shared/toast.service';
import { FULL_ACCESS, KNOWN_PERMISSIONS } from './permission-taxonomy';
import type { AppRole, PermissionInfo } from '../../core/models';
import { IconComponent } from '../../shared/icon.component';

// Roles of the CURRENT workspace. Built-in roles (admin, developer, …) are listed in every workspace at their defaults;
// editing one stores this workspace's own copy, and "Reset to default" removes the copy again. Custom roles can be
// created, edited and — while nobody holds them — deleted. The server validates names, permissions and escalation;
// the form mirrors the same rules so mistakes show up before the round trip.
@Component({
  selector: 'app-roles-list',
  standalone: true,
  imports: [IconComponent, FormsModule, NgTemplateOutlet],
  template: `
    <div class="split">
      <div class="list card">
        @if (loading()) {
          <div class="pad"><div class="skeleton skeleton-line" style="width:70%"></div><div class="skeleton skeleton-line" style="width:50%"></div></div>
        } @else if (loadError()) {
          <div class="empty-state"><div class="es-icon"><app-icon name="shield" [size]="24" /></div><h3>Could not load roles</h3><p>{{ loadError() }}</p><button class="btn" (click)="reload()">Retry</button></div>
        } @else {
          <table>
            <thead><tr><th>Role</th><th>Access</th><th>In use</th></tr></thead>
            <tbody>
              @for (r of roles(); track r.id) {
                <tr (click)="select(r)" [class.sel]="sel()?.name === r.name">
                  <td><b>{{ r.name }}</b>
                    @if (r.protected) { <span class="badge">protected</span> } @else if (r.builtIn) { <span class="badge">{{ r.overridden ? 'built-in · customised' : 'built-in' }}</span> } @else { <span class="badge">custom</span> }</td>
                  <td class="muted">{{ summary(r) }}</td>
                  <td class="muted">{{ r.userCount || 0 }} users · {{ r.memberCount || 0 }} seats</td>
                </tr>
              }
            </tbody>
          </table>
        }
      </div>

      <div class="detail card">
        @if (sel(); as r) {
          <div class="d-head"><b>{{ r.name }}</b><span class="spacer"></span>
            @if (r.builtIn && r.overridden && !r.protected) { <button class="btn" (click)="remove(r)">Reset to default</button> }
            @if (!r.builtIn) { <button class="btn danger" [disabled]="inUse(r)" [title]="inUse(r) ? 'Still assigned — reassign its users and seats first' : ''" (click)="remove(r)">Delete role</button> }
            <button class="btn" (click)="deselect()">+ New role</button>
          </div>
          <div class="tabbody">
            @if (r.protected) {
              <p class="muted">The admin role always has full access and can't be changed or deleted.</p>
            } @else {
              @if (r.builtIn) { <p class="muted sm">Built-in role. Changes apply to <b>this workspace only</b>; reset restores the default permissions.</p> }
              @if (inUse(r)) { <p class="muted sm">Held by {{ r.userCount || 0 }} user(s) and {{ r.memberCount || 0 }} team seat(s) — saved changes affect them immediately.</p> }
              <ng-container [ngTemplateOutlet]="perms" [ngTemplateOutletContext]="{ list: editPerms, toggleFn: toggle, fullFn: toggleFull }" />
              <button class="btn primary" [disabled]="!dirty()" (click)="save(r)">Save permissions</button>
            }
          </div>
        } @else {
          <div class="tabbody">
            <h3 class="sec-h">Create role</h3>
            <div class="field"><label>Name</label><input [(ngModel)]="newName" placeholder="e.g. auditor" maxlength="40" />
              @if (newName && nameProblem()) { <span class="err sm">{{ nameProblem() }}</span> }</div>
            <ng-container [ngTemplateOutlet]="perms" [ngTemplateOutletContext]="{ list: newPerms, toggleFn: toggleNew, fullFn: toggleNewFull }" />
            <button class="btn primary" [disabled]="!!nameProblem() || !newName.trim()" (click)="create()">Create role</button>
          </div>
        }
      </div>
    </div>

    <ng-template #perms let-list="list" let-toggleFn="toggleFn" let-fullFn="fullFn">
      <div class="field">
        <label class="chkrow"><input type="checkbox" [checked]="list.includes(full)" (change)="fullFn()" /> <b>Full access (*)</b></label>
        @if (!list.includes(full)) {
          @for (g of groups(); track g.name) {
            <div class="pgroup">{{ g.name }}</div>
            @for (p of g.items; track p.key) {
              <label class="chkrow"><input type="checkbox" [checked]="list.includes(p.key)" (change)="toggleFn(p.key)" /> {{ p.label }} <span class="muted sm">({{ p.key }})</span></label>
            }
          }
        }
      </div>
    </ng-template>
  `,
  styles: [`
    .split { display: grid; grid-template-columns: minmax(380px, 520px) 1fr; gap: 16px; align-items: start; }
    .list tr { cursor: pointer; } .list tbody tr:hover { background: var(--surface-2); } .list tr.sel td { background: var(--primary-50); }
    .badge { margin-left: 6px; }
    .d-head { display: flex; align-items: center; gap: 8px; padding: 14px 16px; border-bottom: 1px solid var(--border); }
    .tabbody { padding: 14px 16px; }
    .pad { padding: 14px; }
    .field { margin-bottom: 16px; max-width: 480px; }
    .field label:not(.chkrow) { display: block; font-size: 12px; color: var(--muted); font-weight: 600; margin-bottom: 6px; }
    .field input:not([type=checkbox]) { width: 100%; border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; font-size: 13px; margin-bottom: 6px; }
    .pgroup { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin: 12px 0 6px; font-weight: 700; }
    .chkrow { display: flex; align-items: center; gap: 8px; font-size: 13px; margin-bottom: 6px; }
    .chkrow input { width: auto; }
    .sec-h { font-size: 13px; margin: 0 0 14px; }
    .sm { font-size: 12px; } .err { color: var(--red, #c0392b); }
    .btn.danger { color: var(--red); border-color: var(--border-strong); } .btn.danger:hover:not(:disabled) { background: var(--red-bg); }
  `],
})
export class RolesListComponent {
  private api = inject(IamApiService);
  private toast = inject(ToastService);
  roles = signal<AppRole[]>([]);
  catalog = signal<PermissionInfo[]>(KNOWN_PERMISSIONS);
  loading = signal(true);
  loadError = signal('');
  sel = signal<AppRole | null>(null);
  full = FULL_ACCESS;
  groups = computed(() => {
    const by = new Map<string, PermissionInfo[]>();
    for (const p of this.catalog()) by.set(p.group, [...(by.get(p.group) ?? []), p]);
    return [...by].map(([name, items]) => ({ name, items }));
  });

  editPerms: string[] = [];
  newName = ''; newPerms: string[] = [];

  constructor() { this.reload(); this.api.listPermissions().subscribe({ next: (p) => p.length && this.catalog.set(p), error: () => {} }); }

  reload(keep?: string) {
    this.loading.set(true); this.loadError.set('');
    this.api.listRoles().subscribe({
      next: (r) => {
        this.roles.set(r); this.loading.set(false);
        const again = keep ? r.find((x) => x.name === keep) : null;
        if (again) this.select(again); else if (this.sel()) this.sel.set(null);
      },
      error: (e) => { this.loading.set(false); this.loadError.set(e?.error?.error?.message || 'The server did not answer'); },
    });
  }
  summary(r: AppRole) { return r.permissions.includes('*') ? 'Full access' : `${r.permissions.length} permission${r.permissions.length === 1 ? '' : 's'}`; }
  inUse(r: AppRole) { return (r.userCount || 0) + (r.memberCount || 0) > 0; }
  select(r: AppRole) { this.sel.set(r); this.editPerms = [...r.permissions]; }
  deselect() { this.sel.set(null); this.newName = ''; this.newPerms = []; }
  dirty() {
    const r = this.sel(); if (!r) return false;
    return [...this.editPerms].sort().join() !== [...r.permissions].sort().join();
  }
  nameProblem() {
    const n = this.newName.trim();
    if (!n) return '';
    if (!/^[A-Za-z][A-Za-z0-9 _.-]{1,39}$/.test(n)) return '2–40 characters, starting with a letter (letters, digits, space, . - _ allowed)';
    if (['owner', 'system_admin'].includes(n.toLowerCase())) return `"${n}" is reserved`;
    if (this.roles().some((r) => r.name.toLowerCase() === n.toLowerCase())) return `A role named "${n}" already exists`;
    return '';
  }

  toggle = (key: string) => { const i = this.editPerms.indexOf(key); if (i >= 0) this.editPerms.splice(i, 1); else this.editPerms.push(key); };
  toggleFull = () => { this.editPerms = this.editPerms.includes(this.full) ? [] : [this.full]; };
  toggleNew = (key: string) => { const i = this.newPerms.indexOf(key); if (i >= 0) this.newPerms.splice(i, 1); else this.newPerms.push(key); };
  toggleNewFull = () => { this.newPerms = this.newPerms.includes(this.full) ? [] : [this.full]; };

  create() {
    const name = this.newName.trim();
    this.api.createRole({ name, permissions: this.newPerms }).subscribe({
      next: () => { this.toast.success(`Role "${name}" created`); this.newName = ''; this.newPerms = []; this.reload(name); },
      error: (e) => this.toast.error(e?.error?.error?.message || 'Could not create role'),
    });
  }
  save(r: AppRole) {
    this.api.updateRolePermissions(r.id, this.editPerms).subscribe({
      next: () => { this.toast.success('Permissions updated'); this.reload(r.name); },
      error: (e) => this.toast.error(e?.error?.error?.message || 'Could not update role'),
    });
  }
  remove(r: AppRole) {
    const reset = !!r.builtIn;
    if (!confirm(reset ? `Reset "${r.name}" to its default permissions?` : `Delete the role "${r.name}"?`)) return;
    this.api.deleteRole(r.id).subscribe({
      next: () => { this.toast.success(reset ? `"${r.name}" reset to default` : `Role "${r.name}" deleted`); this.reload(reset ? r.name : undefined); },
      error: (e) => this.toast.error(e?.error?.error?.message || 'Could not delete role'),
    });
  }
}
