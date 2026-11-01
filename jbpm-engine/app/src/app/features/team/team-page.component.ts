import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { TenantService } from '../../core/tenant/tenant.service';
import { TeamApiService, type InviteResult, type TeamMember } from '../../core/team/team.service';
import { BreadcrumbComponent } from '../../shared/breadcrumb.component';
import { ModalService } from '../../shared/modal.service';
import { ToastService } from '../../shared/toast.service';

@Component({
  selector: 'app-team-page',
  standalone: true,
  imports: [FormsModule, BreadcrumbComponent],
  template: `
    <div class="page">
      <div class="crumbwrap"><app-breadcrumb [crumbs]="[{ label: 'Team' }]" /></div>
      <header class="head">
        <div>
          <h1>Team</h1>
          <p class="muted">Members of <strong>{{ tenant.tenant()?.name }}</strong> and what each can do. Your role: <span class="badge">{{ myRole() }}</span></p>
        </div>
        @if (myRole() !== 'owner' && !isPlatformAdmin()) {
          <button class="btn danger" (click)="leave()">Leave workspace</button>
        }
      </header>

      @if (auth.hasPermission('team:invite')) {
        <form class="card invite" (ngSubmit)="invite()">
          <h3>Invite someone</h3>
          <div class="row">
            <input name="email" type="email" placeholder="name@company.com" [(ngModel)]="email" required />
            <select name="role" [(ngModel)]="role">
              @for (r of assignable(); track r) { <option [value]="r">{{ r }}</option> }
            </select>
            <button class="btn primary" type="submit" [disabled]="busy() || !email">Send invitation</button>
          </div>
          <p class="muted small">Invitations expire after 7 days. The invitee signs in with this email address and opens the link in the email.</p>
          @if (lastInvite(); as inv) {
            @if (inv.invitationPath) {
              <div class="link">
                <code>{{ link(inv) }}</code>
                <button class="btn sm" type="button" (click)="copy(inv)">Copy link</button>
              </div>
              @if (!inv.emailed) { <p class="muted small">Email is not configured on this server — send the link yourself.</p> }
            } @else {
              <p class="muted small">Invitation emailed to {{ inv.member.email }}.</p>
            }
          }
        </form>
      }

      @if (error()) { <div class="error">{{ error() }}</div> }

      <div class="card">
        <table>
          <thead><tr><th>Member</th><th>Role</th><th>Status</th><th>Joined</th><th></th></tr></thead>
          <tbody>
            @for (m of members(); track m.id) {
              <tr>
                <td><strong>{{ m.displayName || m.email }}</strong><div class="muted small">{{ m.email }}</div></td>
                <td>
                  @if (canManage(m) && m.status !== 'invited') {
                    <select [ngModel]="m.role" (ngModelChange)="setRole(m, $event)" [name]="'r' + m.id">
                      @for (r of assignable(); track r) { <option [value]="r">{{ r }}</option> }
                    </select>
                  } @else { <span class="badge">{{ m.role }}</span> }
                </td>
                <td><span class="badge" [class.active]="m.status === 'active'" [class.archived]="m.status === 'suspended'">{{ m.status }}</span>
                  @if (m.status === 'invited' && m.invitationExpiresAt) { <div class="muted small">expires {{ m.invitationExpiresAt.slice(0, 10) }}</div> }</td>
                <td class="muted">{{ m.status === 'invited' ? '—' : m.joinedAt.slice(0, 10) }}</td>
                <td class="actions">
                  @if (canManage(m)) {
                    @if (m.status === 'invited') {
                      <button class="btn sm" (click)="resend(m)">Resend</button>
                      <button class="btn sm danger" (click)="cancel(m)">Cancel</button>
                    } @else {
                      <button class="btn sm" (click)="toggle(m)">{{ m.status === 'suspended' ? 'Reinstate' : 'Suspend' }}</button>
                      <button class="btn sm danger" (click)="remove(m)">Remove</button>
                    }
                  }
                  @if (myRole() === 'owner' && m.status === 'active' && m.role !== 'owner' && m.role !== 'system_admin') {
                    <button class="btn sm" (click)="transfer(m)">Make owner</button>
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </div>
  `,
  styles: [`
    .crumbwrap { margin-bottom: 10px; }
    .page { padding: 12px 14px; display: flex; flex-direction: column; gap: 16px; max-width: 1000px; }
    .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
    h1 { margin: 0 0 4px; font-size: var(--text-xl); } h3 { margin: 0 0 10px; }
    .card { padding: 16px; border-radius: var(--radius-shell); }
    .row { display: flex; gap: 8px; flex-wrap: wrap; }
    input, select { padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); font: inherit; }
    input { flex: 1; min-width: 220px; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; font-size: var(--text-xs); color: var(--muted); padding: 8px 10px; }
    td { padding: 10px; border-top: 1px solid var(--border); vertical-align: middle; }
    .actions { text-align: right; white-space: nowrap; display: flex; gap: 6px; justify-content: flex-end; }
    .muted { color: var(--muted); } .small { font-size: 12px; }
    .link { display: flex; gap: 8px; align-items: center; margin-top: 8px; } .link code { overflow-wrap: anywhere; font-size: 12px; }
    .error { color: var(--red); background: var(--red-bg); border-radius: var(--radius-sm); padding: 8px 10px; font-size: 13px; }
  `],
})
export class TeamPageComponent implements OnInit {
  auth = inject(AuthService);
  tenant = inject(TenantService);
  private api = inject(TeamApiService);
  private toast = inject(ToastService);
  private modal = inject(ModalService);
  private router = inject(Router);

  members = signal<TeamMember[]>([]);
  assignable = signal<string[]>([]);
  error = signal<string | null>(null);
  busy = signal(false);
  lastInvite = signal<InviteResult | null>(null);
  email = '';
  role = 'viewer';

  myRole = computed(() => this.tenant.role() ?? 'member');
  isPlatformAdmin = computed(() => this.tenant.isSystemAdmin());

  ngOnInit() { void this.load(); }

  async load() {
    try {
      const [m, r] = await Promise.all([this.api.members(), this.api.roles()]);
      this.members.set(m);
      this.assignable.set(r.assignableRoles);
      if (!r.assignableRoles.includes(this.role)) this.role = r.assignableRoles[0] ?? 'viewer';
    } catch (e: any) { this.error.set(e?.error?.error?.message || 'Could not load the team'); }
  }

  /** UI mirror of the server's canManage (the server is the authority): not yourself, never the owner,
   *  admins only by the owner, and only with team:manage. */
  canManage(m: TeamMember): boolean {
    if (!this.auth.hasPermission('team:manage')) return false;
    if (m.role === 'owner' || m.role === 'system_admin') return false;
    if (m.userId && m.userId === this.auth.user()?.id) return false;
    if (m.role === 'admin') return this.myRole() === 'owner' || this.isPlatformAdmin();
    return true;
  }

  link(i: InviteResult) { return `${location.origin}${i.invitationPath ?? ''}`; }
  async copy(i: InviteResult) { try { await navigator.clipboard.writeText(this.link(i)); this.toast.success('Invitation link copied'); } catch { this.toast.info('Copy the link manually'); } }

  private async run(fn: () => Promise<unknown>, ok?: string) {
    this.error.set(null); this.busy.set(true);
    try { await fn(); if (ok) this.toast.success(ok); await this.load(); }
    catch (e: any) { this.error.set(e?.error?.error?.message || 'That did not work'); }
    finally { this.busy.set(false); }
  }
  invite() { return this.run(async () => { this.lastInvite.set(await this.api.invite(this.email.trim(), this.role)); this.email = ''; }, 'Invitation created'); }
  resend(m: TeamMember) { return this.run(async () => this.lastInvite.set(await this.api.resend(m.id)), 'Invitation re-issued'); }
  cancel(m: TeamMember) { return this.run(() => this.api.cancelInvite(m.id), 'Invitation cancelled'); }
  setRole(m: TeamMember, role: string) { return this.run(() => this.api.update(m.id, { role }), 'Role updated'); }
  toggle(m: TeamMember) { return this.run(() => this.api.update(m.id, { status: m.status === 'suspended' ? 'active' : 'suspended' })); }
  async remove(m: TeamMember) {
    if (!(await this.modal.confirm({ title: 'Remove member', message: `Remove ${m.email} from this workspace? They lose access immediately.`, confirmLabel: 'Remove', danger: true }))) return;
    return this.run(() => this.api.remove(m.id), 'Member removed');
  }
  async transfer(m: TeamMember) {
    if (!(await this.modal.confirm({ title: 'Transfer ownership', message: `Make ${m.email} the owner? You will become an admin.`, confirmLabel: 'Transfer', danger: true }))) return;
    return this.run(async () => { await this.api.transferOwnership(m.id); await this.tenant.refresh(); }, 'Ownership transferred');
  }
  async leave() {
    if (!(await this.modal.confirm({ title: 'Leave workspace', message: 'Leave this workspace? You will lose access until you are invited again.', confirmLabel: 'Leave', danger: true }))) return;
    try { await this.api.leave(); await this.tenant.refresh(); this.router.navigateByUrl('/home'); }
    catch (e: any) { this.error.set(e?.error?.error?.message || 'Could not leave'); }
  }
}
