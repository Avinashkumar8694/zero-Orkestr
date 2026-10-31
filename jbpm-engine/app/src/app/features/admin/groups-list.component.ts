import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';
import { IamApiService } from '../../core/api/iam-api.service';
import { ModalService } from '../../shared/modal.service';
import { ToastService } from '../../shared/toast.service';
import type { AppGroup, AppUser } from '../../core/models';
import { IconComponent } from '../../shared/icon.component';

// Groups of the CURRENT workspace. A group is a name that group-scoped tasks match against, plus the users holding it.
// Rename carries the members along, membership is edited here (or on the Users tab), and deleting a group detaches it
// from everyone who held it — the server does all three so the data never ends up half-updated.
@Component({
  selector: 'app-groups-list',
  standalone: true,
  imports: [IconComponent, FormsModule],
  template: `
    <div class="split">
      <div class="list card">
        @if (loading()) {
          <div class="pad"><div class="skeleton skeleton-line" style="width:60%"></div><div class="skeleton skeleton-line" style="width:40%"></div></div>
        } @else if (loadError()) {
          <div class="empty-state"><div class="es-icon"><app-icon name="users" [size]="24" /></div><h3>Could not load groups</h3><p>{{ loadError() }}</p><button class="btn" (click)="reload()">Retry</button></div>
        } @else if (groups().length === 0) {
          <div class="empty-state"><div class="es-icon"><app-icon name="users" [size]="24" /></div><h3>No groups yet</h3><p>Create the first one on the right — groups gate who can claim group-scoped tasks.</p></div>
        } @else {
          <table>
            <thead><tr><th>Name</th><th>Description</th><th>Members</th></tr></thead>
            <tbody>
              @for (g of groups(); track g.id) {
                <tr (click)="select(g)" [class.sel]="sel()?.id === g.id">
                  <td><b>{{ g.name }}</b></td>
                  <td class="muted">{{ g.description || '—' }}</td>
                  <td class="muted">{{ g.memberCount || 0 }}</td>
                </tr>
              }
            </tbody>
          </table>
        }
      </div>

      <div class="detail card">
        @if (sel(); as g) {
          <div class="d-head"><b>{{ g.name }}</b><span class="spacer"></span>
            <button class="btn danger" (click)="remove(g)">Delete group</button>
            <button class="btn" (click)="deselect()">+ New group</button>
          </div>
          <div class="tabbody">
            <div class="field"><label>Name</label><input [(ngModel)]="editName" maxlength="60" />
              @if (nameProblem(editName, g)) { <span class="err sm">{{ nameProblem(editName, g) }}</span> }</div>
            <div class="field"><label>Description</label><input [(ngModel)]="editDescription" maxlength="300" placeholder="optional" /></div>
            <div class="field">
              <label>Members ({{ editMembers.length }})</label>
              @for (u of users(); track u.id) {
                <label class="chkrow"><input type="checkbox" [checked]="editMembers.includes(u.id)" (change)="toggleMember(u.id)" /> {{ u.username }} @if (!u.active) { <span class="muted sm">(disabled)</span> }</label>
              }
              @if (!users().length) { <p class="muted sm">No users in this workspace yet — create them under the Users tab.</p> }
            </div>
            <button class="btn primary" [disabled]="!dirty(g) || !!nameProblem(editName, g)" (click)="save(g)">Save changes</button>
            <p class="hint">Renaming a group renames it for every member. Existing task / userTask group references are matched by name, so update those too.</p>
          </div>
        } @else {
          <div class="tabbody">
            <h3 class="sec-h">Create group</h3>
            <div class="field"><label>Name</label><input [(ngModel)]="newName" placeholder="e.g. hr-approvers" maxlength="60" />
              @if (newName && nameProblem(newName)) { <span class="err sm">{{ nameProblem(newName) }}</span> }</div>
            <div class="field"><label>Description</label><input [(ngModel)]="newDescription" placeholder="optional" maxlength="300" /></div>
            <button class="btn primary" [disabled]="!newName.trim() || !!nameProblem(newName)" (click)="create()">Create group</button>
          </div>
        }
      </div>
    </div>
  `,
  styles: [`
    .split { display: grid; grid-template-columns: minmax(380px, 520px) 1fr; gap: 16px; align-items: start; }
    .list tr { cursor: pointer; } .list tbody tr:hover { background: var(--surface-2); } .list tr.sel td { background: var(--primary-50); }
    .d-head { display: flex; align-items: center; gap: 8px; padding: 14px 16px; border-bottom: 1px solid var(--border); }
    .tabbody { padding: 14px 16px; }
    .pad { padding: 14px; }
    .field { margin-bottom: 16px; max-width: 440px; }
    .field label:not(.chkrow) { display: block; font-size: 12px; color: var(--muted); font-weight: 600; margin-bottom: 6px; }
    .field input:not([type=checkbox]) { width: 100%; border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; font-size: 13px; }
    .chkrow { display: flex; align-items: center; gap: 8px; font-size: 13px; margin-bottom: 6px; } .chkrow input { width: auto; }
    .hint { color: var(--muted); font-size: 12px; }
    .sec-h { font-size: 13px; margin: 0 0 14px; }
    .sm { font-size: 12px; } .err { color: var(--red, #c0392b); }
    .btn.danger { color: var(--red); border-color: var(--border-strong); } .btn.danger:hover { background: var(--red-bg); }
  `],
})
export class GroupsListComponent {
  private api = inject(IamApiService);
  private toast = inject(ToastService);
  private modal = inject(ModalService);
  groups = signal<AppGroup[]>([]);
  users = signal<AppUser[]>([]);
  loading = signal(true);
  loadError = signal('');
  sel = signal<AppGroup | null>(null);
  newName = ''; newDescription = '';
  editName = ''; editDescription = ''; editMembers: string[] = [];

  constructor() { this.reload(); }
  reload(keepId?: string) {
    this.loading.set(true); this.loadError.set('');
    forkJoin({ groups: this.api.listGroups(), users: this.api.listUsers() }).subscribe({
      next: ({ groups, users }) => {
        this.groups.set(groups); this.users.set(users); this.loading.set(false);
        const again = keepId ? groups.find((g) => g.id === keepId) : null;
        if (again) this.select(again); else this.sel.set(null);
      },
      error: (e) => { this.loading.set(false); this.loadError.set(e?.error?.error?.message || 'The server did not answer'); },
    });
  }
  membersOf(g: AppGroup) { return this.users().filter((u) => u.groups.includes(g.name)).map((u) => u.id); }
  select(g: AppGroup) { this.sel.set(g); this.editName = g.name; this.editDescription = g.description || ''; this.editMembers = this.membersOf(g); }
  deselect() { this.sel.set(null); this.newName = ''; this.newDescription = ''; }
  toggleMember(id: string) { const i = this.editMembers.indexOf(id); if (i >= 0) this.editMembers.splice(i, 1); else this.editMembers.push(id); }
  nameProblem(raw: string, self?: AppGroup) {
    const n = raw.trim();
    if (!n) return self ? 'Name is required' : '';
    if (!/^[A-Za-z0-9][A-Za-z0-9 _.@-]{0,59}$/.test(n)) return 'Letters, digits, space, . - _ @ only (max 60)';
    if (this.groups().some((g) => g.id !== self?.id && g.name.toLowerCase() === n.toLowerCase())) return `A group named "${n}" already exists`;
    return '';
  }
  dirty(g: AppGroup) {
    return this.editName.trim() !== g.name || this.editDescription.trim() !== (g.description || '')
      || [...this.editMembers].sort().join() !== [...this.membersOf(g)].sort().join();
  }

  create() {
    const name = this.newName.trim();
    this.api.createGroup({ name, description: this.newDescription.trim() || undefined }).subscribe({
      next: (g) => { this.toast.success(`Group "${name}" created`); this.newName = ''; this.newDescription = ''; this.reload(g.id); },
      error: (e) => this.toast.error(e?.error?.error?.message || 'Could not create group'),
    });
  }
  save(g: AppGroup) {
    const members = [...this.editMembers];
    const sameMembers = [...members].sort().join() === [...this.membersOf(g)].sort().join();
    const meta = this.editName.trim() !== g.name || this.editDescription.trim() !== (g.description || '');
    // rename first: membership is keyed by user id, so it is unaffected by the new name either way
    const run = () => (sameMembers ? this.done(g.id) : this.api.setGroupMembers(g.id, members).subscribe({ next: () => this.done(g.id), error: (e) => this.toast.error(e?.error?.error?.message || 'Could not update members') }));
    if (!meta) return run();
    this.api.updateGroup(g.id, { name: this.editName.trim(), description: this.editDescription.trim() }).subscribe({ next: run, error: (e) => this.toast.error(e?.error?.error?.message || 'Could not update group') });
  }
  private done(id: string) { this.toast.success('Group updated'); this.reload(id); }
  async remove(g: AppGroup) {
    const n = g.memberCount || 0;
    const ok = await this.modal.confirm({ title: 'Delete group', message: n ? `Delete "${g.name}"? It will be removed from its ${n} member(s).` : `Delete the group "${g.name}"?`, confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    this.api.deleteGroup(g.id).subscribe({
      next: () => { this.toast.success(`Group "${g.name}" deleted`); this.reload(); },
      error: (e) => this.toast.error(e?.error?.error?.message || 'Could not delete group'),
    });
  }
}
