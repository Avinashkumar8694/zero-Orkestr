import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SlicePipe } from '@angular/common';
import { IamApiService } from '../../core/api/iam-api.service';
import { ToastService } from '../../shared/toast.service';
import type { AppGroup, AppRole, AppUser } from '../../core/models';
import { IconComponent } from '../../shared/icon.component';

// List+detail split (same convention as Deployments/Instances/Tasks): unselected detail pane = create
// form, selected row = edit form. Password is set-only (backend never returns a hash to compare), so
// editing a user only ever touches roles/groups/active — a separate "reset password" action covers the
// rest.
@Component({
  selector: 'app-users-list',
  standalone: true,
  imports: [IconComponent, FormsModule, SlicePipe],
  template: `
    <div class="split">
      <div class="list card">
        @if (loading()) {
          <div class="pad"><div class="skeleton skeleton-line" style="width:80%"></div><div class="skeleton skeleton-line" style="width:60%"></div></div>
        } @else if (users().length === 0) {
          <div class="empty-state"><div class="es-icon"><app-icon name="user" [size]="24" /></div><h3>No users yet</h3><p>Create the first one on the right.</p></div>
        } @else {
          <table>
            <thead><tr><th>Username</th><th>Roles</th><th>Groups</th><th>Status</th></tr></thead>
            <tbody>
              @for (u of users(); track u.id) {
                <tr (click)="select(u)" [class.sel]="sel()?.id === u.id">
                  <td><b>{{ u.username }}</b></td>
                  <td>@for (r of u.roles; track r) { <span class="badge">{{ r }}</span> } @if (!u.roles.length) { <span class="muted">—</span> }</td>
                  <td>@for (g of u.groups; track g) { <span class="badge">{{ g }}</span> } @if (!u.groups.length) { <span class="muted">—</span> }</td>
                  <td><span class="badge" [class.active]="u.active" [class.archived]="!u.active">{{ u.active ? 'active' : 'disabled' }}</span></td>
                </tr>
              }
            </tbody>
          </table>
        }
      </div>

      <div class="detail card">
        @if (sel(); as u) {
          <div class="d-head"><b>{{ u.username }}</b><span class="spacer"></span><button class="btn" (click)="deselect()">+ New user</button></div>
          <div class="tabbody">
            <div class="field"><label>Roles</label>
              @for (r of roles(); track r.id) {
                <label class="chkrow"><input type="checkbox" [checked]="editRoles.includes(r.name)" (change)="toggle(editRoles, r.name)" /> {{ r.name }}@if (r.builtIn) { <span class="muted sm"> · built-in</span> }</label>
              }
              @if (!roles().length) { <p class="muted sm">No roles could be loaded for this workspace.</p> }
              @if (!editRoles.length) { <p class="muted sm">A user with no role cannot access this workspace.</p> }
            </div>
            <div class="field"><label>Groups</label>
              @for (g of groups(); track g.id) {
                <label class="chkrow"><input type="checkbox" [checked]="editGroups.includes(g.name)" (change)="toggle(editGroups, g.name)" /> {{ g.name }}</label>
              }
              @if (!groups().length) { <p class="muted sm">No groups yet — create one under the Groups tab.</p> }
            </div>
            <label class="chkrow"><input type="checkbox" [(ngModel)]="editActive" /> Active</label>
            <div class="row">
              <button class="btn primary" (click)="save(u)">Save changes</button>
            </div>
            <div class="field pwd">
              <label>Reset password</label>
              <div class="row">
                <input type="password" placeholder="New password (min 8 chars)" [(ngModel)]="newPassword" />
                <button class="btn" [disabled]="newPassword.length < 8" (click)="resetPassword(u)">Set password</button>
              </div>
            </div>
          </div>
        } @else {
          <div class="tabbody">
            <h3 class="sec-h">Create user</h3>
            <div class="field"><label>Username</label><input [(ngModel)]="newUsername" placeholder="username" /></div>
            <div class="field"><label>Password</label><input type="password" [(ngModel)]="newPasswordField" placeholder="min 8 characters" /></div>
            <div class="field"><label>Roles</label>
              @for (r of roles(); track r.id) {
                <label class="chkrow"><input type="checkbox" [checked]="newRoles.includes(r.name)" (change)="toggle(newRoles, r.name)" /> {{ r.name }}@if (r.builtIn) { <span class="muted sm"> · built-in</span> }</label>
              }
              @if (!newRoles.length) { <p class="muted sm">A user with no role cannot access this workspace.</p> }
            </div>
            <div class="field"><label>Groups</label>
              @for (g of groups(); track g.id) {
                <label class="chkrow"><input type="checkbox" [checked]="newGroups.includes(g.name)" (change)="toggle(newGroups, g.name)" /> {{ g.name }}</label>
              }
            </div>
            <button class="btn primary" (click)="create()">Create user</button>
          </div>
        }
      </div>
    </div>
  `,
  styles: [`
    .split { display: grid; grid-template-columns: minmax(360px, 480px) 1fr; gap: 16px; align-items: start; }
    .list tr { cursor: pointer; } .list tbody tr:hover { background: var(--surface-2); } .list tr.sel td { background: var(--primary-50); }
    .badge + .badge { margin-left: 4px; }
    .d-head { display: flex; align-items: center; gap: 8px; padding: 14px 16px; border-bottom: 1px solid var(--border); }
    .tabbody { padding: 14px 16px; }
    .pad { padding: 14px; }
    .field { margin-bottom: 16px; max-width: 420px; }
    .field label { display: block; font-size: 12px; color: var(--muted); font-weight: 600; margin-bottom: 6px; }
    .field input { width: 100%; border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; font-size: 13px; }
    .chkrow { display: flex; align-items: center; gap: 8px; font-size: 13px; margin-bottom: 6px; }
    .chkrow input { width: auto; }
    .row { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
    .pwd { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border); }
    .sec-h { font-size: 13px; margin: 0 0 14px; }
    .sm { font-size: 12px; }
  `],
})
export class UsersListComponent {
  private api = inject(IamApiService);
  private toast = inject(ToastService);
  users = signal<AppUser[]>([]);
  roles = signal<AppRole[]>([]);
  groups = signal<AppGroup[]>([]);
  loading = signal(true);
  sel = signal<AppUser | null>(null);

  editRoles: string[] = []; editGroups: string[] = []; editActive = true; newPassword = '';
  newUsername = ''; newPasswordField = ''; newRoles: string[] = []; newGroups: string[] = [];

  constructor() { this.reload(); }
  reload() {
    this.loading.set(true);
    this.api.listUsers().subscribe({ next: (u) => { this.users.set(u); this.loading.set(false); }, error: (e) => { this.loading.set(false); this.toast.error(e?.error?.error?.message || 'Could not load users'); } });
    this.api.listRoles().subscribe({ next: (r) => this.roles.set(r), error: (e) => this.toast.error(e?.error?.error?.message || 'Could not load roles') });
    this.api.listGroups().subscribe({ next: (g) => this.groups.set(g), error: () => {} });
  }
  toggle(list: string[], name: string) { const i = list.indexOf(name); if (i >= 0) list.splice(i, 1); else list.push(name); }
  select(u: AppUser) { this.sel.set(u); this.editRoles = [...u.roles]; this.editGroups = [...u.groups]; this.editActive = u.active; this.newPassword = ''; }
  deselect() { this.sel.set(null); this.newUsername = ''; this.newPasswordField = ''; this.newRoles = []; this.newGroups = []; }

  create() {
    const username = this.newUsername.trim();
    if (!username) return this.toast.error('Username is required');
    if (this.newPasswordField.length < 8) return this.toast.error('Password must be at least 8 characters');
    this.api.createUser({ username, password: this.newPasswordField, roles: this.newRoles, groups: this.newGroups }).subscribe({
      next: () => { this.toast.success(`User "${username}" created`); this.deselect(); this.reload(); },
      error: (e) => this.toast.error(e?.error?.error?.message || 'Could not create user'),
    });
  }
  save(u: AppUser) {
    this.api.updateUser(u.id, { roles: this.editRoles, groups: this.editGroups, active: this.editActive }).subscribe({
      next: () => { this.toast.success('User updated'); this.reload(); },
      error: (e) => this.toast.error(e?.error?.error?.message || 'Could not update user'),
    });
  }
  resetPassword(u: AppUser) {
    this.api.setPassword(u.id, this.newPassword).subscribe({
      next: () => { this.toast.success(`Password reset for "${u.username}"`); this.newPassword = ''; },
      error: (e) => this.toast.error(e?.error?.error?.message || 'Could not set password'),
    });
  }
}
