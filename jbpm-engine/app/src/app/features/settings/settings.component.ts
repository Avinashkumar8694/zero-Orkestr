import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth/auth.service';
import { AuthApiService } from '../../core/auth/auth-api.service';
import { ThemeService } from '../../core/theme.service';
import { SystemApiService } from '../../core/api/system-api.service';
import { TenantService } from '../../core/tenant/tenant.service';
import { ToastService } from '../../shared/toast.service';
import { BreadcrumbComponent } from '../../shared/breadcrumb.component';
import { IconComponent } from '../../shared/icon.component';
import type { SystemSettings } from '../../core/models';

type SettingsTab = 'account' | 'system';

// App-level Settings — distinct from a project's own Settings tab (project-settings.component.ts,
// which configures that one project). Account applies to you; System (admin:iam only) is the
// SystemSettings singleton per ux_design/mockups/system-settings.html.
@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [IconComponent, FormsModule, BreadcrumbComponent],
  template: `
    <div class="page">
      <div class="crumbwrap"><app-breadcrumb [crumbs]="[{ label: 'Settings' }]" /></div>
      <header class="pagehead"><h1>Settings</h1><p class="muted">Your appearance, account and password{{ canAdmin() ? ', plus system-wide configuration' : '' }}.</p></header>

      @if (canAdmin()) {
        <div class="tabs">
          <button class="tab" [class.active]="tab() === 'account'" (click)="setTab('account')">Account</button>
          <button class="tab" [class.active]="tab() === 'system'" (click)="setTab('system')">System</button>
        </div>
      }

      @if (tab() === 'account') {
        <div class="sections">
          <section class="card">
            <h3>Appearance</h3>
            <p class="hint">Applies to your browser only.</p>
            <div class="theme-row">
              <button class="opt" [class.sel]="theme.theme() === 'light'" (click)="theme.theme.set('light')"><app-icon name="sun" [size]="14" /> Light</button>
              <button class="opt" [class.sel]="theme.theme() === 'dark'" (click)="theme.theme.set('dark')"><app-icon name="moon" [size]="14" /> Dark</button>
            </div>
          </section>

          <section class="card">
            <h3>Account</h3>
            @if (auth.user(); as u) {
              <table class="kv"><tbody>
                <tr><td class="k">Username</td><td>{{ u.username }}</td></tr>
                <tr><td class="k">Roles</td><td>@for (r of u.roles; track r) { <span class="badge">{{ r }}</span> } @if (!u.roles.length) { <span class="muted">—</span> }</td></tr>
                <tr><td class="k">Groups</td><td>@for (g of u.groups; track g) { <span class="badge">{{ g }}</span> } @if (!u.groups.length) { <span class="muted">—</span> }</td></tr>
              </tbody></table>
            }
            <h4>Change password</h4>
            <div class="field"><label>Current password</label><input type="password" [(ngModel)]="currentPassword" /></div>
            <div class="field"><label>New password</label><input type="password" [(ngModel)]="newPassword" placeholder="min 8 characters" /></div>
            <button class="btn primary" [disabled]="!currentPassword || newPassword.length < 8" (click)="changePassword()">Update password</button>
          </section>
        </div>
      }

      @if (tab() === 'system' && canAdmin()) {
        @if (draft(); as s) {
          <div class="sections">
            <section class="card">
              <h3>Process engine</h3>
              <p class="hint">Defaults applied to every deployed process unless a project overrides them.</p>
              <div class="setting-row">
                <div class="lbl">Default items per page<span class="shint">Applies to Instances, Tasks, Errors, Jobs and Audit.</span></div>
                <select [(ngModel)]="s.defaultPageSize"><option [ngValue]="10">10</option><option [ngValue]="20">20</option><option [ngValue]="50">50</option><option [ngValue]="100">100</option></select>
              </div>
              <div class="setting-row">
                <div class="lbl">Instance creation mode<span class="shint">Control whether users can create process instances, case instances, or both.</span></div>
                <select [(ngModel)]="s.instanceCreationMode">
                  <option value="both">Both (Process & Case Instances)</option>
                  <option value="case-only">Case Instances Only</option>
                  <option value="process-only">Process Instances Only</option>
                </select>
              </div>
              <div class="setting-row">
                <div class="lbl">Script execution timeout (seconds)<span class="shint">Maximum runtime for JS/Java script tasks before timeout termination.</span></div>
                <input type="number" min="1" [(ngModel)]="s.scriptTimeoutSeconds" style="width:90px;" />
              </div>
              <div class="setting-row">
                <div class="lbl">History audit level<span class="shint">Detail level captured in the compliance audit trail.</span></div>
                <select [(ngModel)]="s.historyAuditLevel">
                  <option value="full">Full (All events, variable updates & activities)</option>
                  <option value="activity">Activity (Lifecycle, tasks & versions)</option>
                  <option value="minimal">Minimal (Core lifecycle & errors only)</option>
                </select>
              </div>
              <div class="setting-row">
                <div class="lbl">Instance history retention (days)<span class="shint">Completed and aborted instances older than this are eligible for pruning.</span></div>
                <input type="number" min="1" [(ngModel)]="s.instanceRetentionDays" style="width:90px;" />
              </div>
              <div class="setting-row">
                <div class="lbl">Allow variable edits on running instances<span class="shint">When off, the Variables tab is read-only for everyone.</span></div>
                <button class="switch" [class.on]="s.allowRunningVariableEdits" role="switch" [attr.aria-checked]="s.allowRunningVariableEdits" (click)="s.allowRunningVariableEdits = !s.allowRunningVariableEdits"></button>
              </div>
            </section>

            <section class="card">
              <h3>Resource quotas</h3>
              <p class="hint">Per-tenant limits that protect the server from a runaway or abusive workflow. Set to 0 for unlimited.</p>
              <div class="setting-row">
                <div class="lbl">Max active instances<span class="shint">Top-level process instances running/waiting at once.@if (s.limitCaps?.maxActiveInstancesCap) { Capped by the platform at {{ s.limitCaps?.maxActiveInstancesCap }}; 0 (unlimited) is not allowed. }</span></div>
                <input type="number" [min]="s.limitCaps?.maxActiveInstancesCap ? 1 : 0" [max]="s.limitCaps?.maxActiveInstancesCap || null" [(ngModel)]="s.maxActiveInstances" style="width:90px;" />
              </div>
              <div class="setting-row">
                <div class="lbl">Max active timers<span class="shint">Scheduled boundary/catch timers at once.@if (s.limitCaps?.maxActiveTimersCap) { Capped by the platform at {{ s.limitCaps?.maxActiveTimersCap }}. }</span></div>
                <input type="number" [min]="s.limitCaps?.maxActiveTimersCap ? 1 : 0" [max]="s.limitCaps?.maxActiveTimersCap || null" [(ngModel)]="s.maxActiveTimers" style="width:90px;" />
              </div>
              @if (tenant.isPlatformAdmin()) {
              <div class="setting-row">
                <div class="lbl">Script pool size<span class="shint">How many scripts run in parallel (each uses its own isolate, ≈64 MB worst case). Platform cap: {{ s.limitCaps?.scriptPoolMaxSize }}. Effective now: {{ s.effectiveLimits?.scriptPoolSize }}. Empty = platform default.</span></div>
                <input type="number" min="1" [max]="s.limitCaps?.scriptPoolMaxSize || null" [(ngModel)]="s.scriptPoolSize" style="width:90px;" />
              </div>
              <div class="setting-row">
                <div class="lbl">Script queue length<span class="shint">How many scripts may wait when the pool is busy (queue mode). Platform cap: {{ s.limitCaps?.scriptQueueMaxCap }}. Effective now: {{ s.effectiveLimits?.scriptQueueMax }}.</span></div>
                <input type="number" min="0" [max]="s.limitCaps?.scriptQueueMaxCap ?? null" [(ngModel)]="s.scriptQueueMax" style="width:90px;" />
              </div>
              <div class="setting-row">
                <div class="lbl">When scripts are at the limit<span class="shint">Queue: wait (bounded) for a free slot. Reject: fail immediately with QUOTA_EXCEEDED. Effective now: {{ s.effectiveLimits?.scriptOverflowMode }}.@if (s.limitCaps?.lockedOverflowMode) { Locked to {{ s.limitCaps?.lockedOverflowMode }} by the platform administrator. }</span></div>
                <select [(ngModel)]="s.scriptOverflowMode" [disabled]="!!s.limitCaps?.lockedOverflowMode" style="width:140px;">
                  <option [ngValue]="null">Platform default</option>
                  <option value="queue">Queue</option>
                  <option value="reject">Reject</option>
                </select>
              </div>
              }
            </section>

            <section class="card">
              <h3>Jobs & timers</h3>
              <p class="hint">Executor behaviour for timers and scheduled starts.</p>
              <div class="setting-row">
                <div class="lbl">Executor interval (seconds)<span class="shint">How often the executor polls for due jobs.</span></div>
                <input type="number" min="1" [(ngModel)]="s.executorIntervalSeconds" style="width:90px;" />
              </div>
              <div class="setting-row">
                <div class="lbl">Timer batch size<span class="shint">Max due timers claimed per execution tick (auto-scaled across replicas).</span></div>
                <input type="number" min="1" [(ngModel)]="s.timerBatchSize" style="width:90px;" />
              </div>
              <div class="setting-row">
                <div class="lbl">Default job retries<span class="shint">Attempts before a job is marked failed and surfaced in Execution Errors.</span></div>
                <input type="number" min="0" [(ngModel)]="s.defaultJobRetries" style="width:90px;" />
              </div>
              <div class="setting-row">
                <div class="lbl">Job retry backoff multiplier<span class="shint">Exponential factor applied between consecutive job retry attempts.</span></div>
                <input type="number" min="1" [(ngModel)]="s.jobRetryBackoffMultiplier" style="width:90px;" />
              </div>
            </section>

            <section class="card">
              <h3>Integrations & Outbound HTTP</h3>
              <p class="hint">Network security, request timeouts, and domain allowlists for REST / service tasks.</p>
              <div class="setting-row">
                <div class="lbl">HTTP request timeout (seconds)<span class="shint">Abort signal timeout for outbound REST service calls.</span></div>
                <input type="number" min="1" [(ngModel)]="s.httpTimeoutSeconds" style="width:90px;" />
              </div>
              <div class="setting-row">
                <div class="lbl">Outbound domain allowlist<span class="shint">Comma-separated hostnames or .domain suffixes permitted to bypass SSRF private network filters.</span></div>
                <input [(ngModel)]="s.outboundAllowlist" placeholder="api.enterprise.com, .internal.corp, localhost" style="width:300px;" />
              </div>
            </section>

            <section class="card">
              <h3>Tasks & SLAs</h3>
              <p class="hint">Default deadlines, escalation thresholds, and task ownership lifecycles.</p>
              <div class="setting-row">
                <div class="lbl">Default task SLA (hours)<span class="shint">Fallback SLA duration if a User Task does not declare an explicit due date.</span></div>
                <input type="number" min="1" [(ngModel)]="s.defaultTaskSlaHours" style="width:90px;" />
              </div>
              <div class="setting-row">
                <div class="lbl">Auto-release idle claimed tasks (hours)<span class="shint">Release claimed tasks back to group pool if untouched for X hours (0 = disabled).</span></div>
                <input type="number" min="0" [(ngModel)]="s.autoReleaseClaimedTaskHours" style="width:90px;" />
              </div>
              <div class="setting-row">
                <div class="lbl">SLA warning threshold<span class="shint">When a task flips from on-track to at-risk.</span></div>
                <select [(ngModel)]="s.slaWarnThresholdPct">
                  <option [ngValue]="70">70% of due time</option>
                  <option [ngValue]="80">80% of due time</option>
                  <option [ngValue]="90">90% of due time</option>
                </select>
              </div>
            </section>

            <section class="card">
              <h3>Notifications & email</h3>
              <div class="setting-row">
                <div class="lbl">Email delivery<span class="shint">Needed for SLA-breach and reminder emails. In-app notifications work without it.</span></div>
                <button class="switch" [class.on]="s.emailEnabled" role="switch" [attr.aria-checked]="s.emailEnabled" (click)="s.emailEnabled = !s.emailEnabled"></button>
              </div>
              @if (s.emailEnabled) {
                <div class="setting-row"><div class="lbl">From address</div><input type="email" [(ngModel)]="s.emailFrom" placeholder="bpm@example.com" style="width:240px;" /></div>
                <div class="setting-row"><div class="lbl">SMTP host</div><input [(ngModel)]="s.smtpHost" placeholder="smtp.example.com" style="width:240px;" /></div>
                <div class="setting-row"><div class="lbl">SMTP port</div><input type="number" [(ngModel)]="s.smtpPort" style="width:90px;" /></div>
                <div class="setting-row"><div class="lbl">SMTP user</div><input [(ngModel)]="s.smtpUser" placeholder="smtp-user" style="width:240px;" /></div>
                <div class="setting-row">
                  <div class="lbl">SMTP password <span class="badge" title="RSA encrypted in-transit and at-rest"><app-icon name="lock" [size]="11" /> RSA Protected</span></div>
                  <input type="password" [(ngModel)]="s.smtpPassword" placeholder="••••••••" style="width:240px;" />
                </div>
              }
            </section>

            <section class="card">
              <h3>System Diagnostics & Logging</h3>
              <p class="hint">Engine log verbosity and system observability level.</p>
              <div class="setting-row">
                <div class="lbl">System log level<span class="shint">Minimum log severity output across all replicas in real-time.</span></div>
                <select [(ngModel)]="s.logLevel">
                  <option value="debug">Debug (Extremely verbose, development only)</option>
                  <option value="info">Info (Recommended for production)</option>
                  <option value="warn">Warn (Only warnings and failures)</option>
                  <option value="error">Error (Only critical operational errors)</option>
                </select>
              </div>
            </section>

            <section class="card">
              <h3>Security & session</h3>
              <div class="setting-row">
                <div class="lbl">Session timeout (hours)</div>
                <select [(ngModel)]="s.sessionTimeoutHours">
                  <option [ngValue]="1">1 hour</option><option [ngValue]="4">4 hours</option>
                  <option [ngValue]="8">8 hours</option><option [ngValue]="24">24 hours</option>
                </select>
              </div>
              <div class="setting-row">
                <div class="lbl">Audit retention (days)<span class="shint">Pruned by the same scheduled job as instance history.</span></div>
                <input type="number" min="1" [(ngModel)]="s.auditRetentionDays" style="width:90px;" />
              </div>
            </section>

            <div class="savebar">
              <button class="btn primary sm" [disabled]="saving()" (click)="saveSystem()">{{ saving() ? 'Saving…' : 'Save changes' }}</button>
              <button class="btn sm" [disabled]="saving()" (click)="resetSystem()">Discard</button>
              <div class="spacer"></div>
              @if (system()?.updatedAt) { <span class="muted" style="font-size:12px;">Last saved {{ system()!.updatedAt }} by {{ system()!.updatedBy }}</span> }
            </div>
          </div>
        } @else {
          <div class="card" style="padding:32px; text-align:center;"><span class="muted">Loading system settings…</span></div>
        }
      }
    </div>
  `,
  styles: [`
    .page { padding: 20px 24px; max-width: 760px; }
    .crumbwrap { margin-bottom: 10px; }
    .pagehead { margin-bottom: 14px; }
    h1 { font-size: 19px; margin: 0; }
    .muted { color: var(--muted); }
    .pagehead p { margin: 4px 0 0; font-size: 13px; }

    .sections { display: flex; flex-direction: column; gap: 16px; }
    .card { padding: 20px; }
    h3 { font-size: 14px; margin: 0 0 4px; }
    h4 { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .03em; margin: 18px 0 12px; padding-top: 14px; border-top: 1px solid var(--border); }
    .hint { color: var(--muted); font-size: 12px; margin: 0 0 12px; }
    .theme-row { display: flex; gap: 8px; }
    .opt { border: 1px solid var(--border); background: var(--surface); border-radius: var(--radius-sm); padding: 8px 16px; font-size: 13px; cursor: pointer; color: var(--text); display: inline-flex; align-items: center; gap: 6px; }
    .opt.sel { border-color: var(--primary); background: var(--primary-50); color: var(--primary); font-weight: 600; }
    .kv { width: 100%; margin-bottom: 4px; } .kv td { padding: 7px 0; border-bottom: 1px solid var(--border); font-size: 13px; } .kv .k { color: var(--muted); width: 30%; }
    .field { margin-bottom: 14px; max-width: 320px; }
    .field label { display: block; font-size: 12px; color: var(--muted); font-weight: 600; margin-bottom: 6px; }
    .field input { width: 100%; }
    .setting-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 12px 0; border-bottom: 1px solid var(--border); }
    .setting-row:last-child { border-bottom: none; }
    .lbl { font-size: 13px; font-weight: 500; display: flex; flex-direction: column; gap: 3px; max-width: 380px; }
    .shint { font-size: 11.5px; font-weight: 400; color: var(--muted); }
    .switch { width: 36px; height: 20px; border-radius: var(--radius-pill); border: 1px solid var(--border-strong); background: var(--surface-3); position: relative; cursor: pointer; flex-shrink: 0; }
    .switch::after { content: ''; position: absolute; top: 1px; left: 1px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: var(--shadow-xs); transition: left .15s; }
    .switch.on { background: var(--primary); border-color: var(--primary); }
    .switch.on::after { left: 17px; }
    .savebar { display: flex; align-items: center; gap: 8px; position: sticky; bottom: 0; background: var(--bg); padding: 12px 0; }
    .spacer { flex: 1; }

    @media (max-width: 768px) {
      .page { padding: 12px 14px; }
      .setting-row { flex-direction: column; align-items: stretch; gap: 8px; }
      .setting-row input, .setting-row select { width: 100% !important; }
      .savebar { flex-wrap: wrap; }
    }
  `],
})
export class SettingsComponent {
  auth = inject(AuthService);
  theme = inject(ThemeService);
  private authApi = inject(AuthApiService);
  private systemApi = inject(SystemApiService);
  tenant = inject(TenantService);
  private toast = inject(ToastService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  canAdmin = computed(() => this.auth.hasPermission('admin:iam'));
  tab = signal<SettingsTab>('account');

  currentPassword = '';
  newPassword = '';

  system = signal<SystemSettings | null>(null);
  draft = signal<SystemSettings | null>(null);
  loadingSystem = signal(false);
  saving = signal(false);

  constructor() {
    const qTab = this.route.snapshot.queryParamMap.get('tab');
    if (qTab === 'system' && this.canAdmin()) this.setTab('system');
  }

  setTab(t: SettingsTab) {
    this.tab.set(t);
    this.router.navigate([], { queryParams: { tab: t }, queryParamsHandling: 'merge', replaceUrl: true });
    if (t === 'system' && !this.system()) this.loadSystem();
  }

  private loadSystem() {
    this.loadingSystem.set(true);
    this.systemApi.getSystemSettings().subscribe({
      next: (s) => { this.system.set(s); this.draft.set({ ...s }); this.loadingSystem.set(false); },
      error: (e) => { this.toast.error(e?.error?.error?.message || 'Could not load system settings'); this.loadingSystem.set(false); },
    });
  }

  resetSystem() { const s = this.system(); if (s) this.draft.set({ ...s }); }

  saveSystem() {
    const d = this.draft();
    if (!d) return;
    this.saving.set(true);
    this.systemApi.updateSystemSettings(d).subscribe({
      next: (s) => { this.system.set(s); this.draft.set({ ...s }); this.saving.set(false); this.toast.success('System settings saved'); },
      error: (e) => { this.saving.set(false); this.toast.error(e?.error?.error?.message || 'Could not save system settings'); },
    });
  }

  changePassword() {
    this.authApi.changePassword(this.currentPassword, this.newPassword).subscribe({
      next: () => { this.toast.success('Password updated'); this.currentPassword = ''; this.newPassword = ''; },
      error: (e) => this.toast.error(e?.error?.error?.message || 'Could not update password'),
    });
  }
}
