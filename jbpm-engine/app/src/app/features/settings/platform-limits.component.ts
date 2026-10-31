import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { PlatformApiService, type LimitInfo, type PlanRow, type PlatformLimits, type PlatformUsage, type PlatformUsageRow, type WorkspaceLimitOverride } from '../../core/api/platform-api.service';
import { ToastService } from '../../shared/toast.service';
import { BreadcrumbComponent } from '../../shared/breadcrumb.component';

const GLOBAL_FIELDS: Array<{ key: keyof PlatformLimits; label: string; hint: string }> = [
  { key: 'scriptPoolDefaultSize', label: 'Default pool size', hint: 'Script parallelism (isolates) for a workspace that does not ask for one.' },
  { key: 'scriptPoolMaxSize', label: 'Pool size cap', hint: 'Hard cap per workspace. Memory worst case ≈ size × 64 MB.' },
  { key: 'scriptQueueDefaultMax', label: 'Default queue length', hint: 'How many executions may wait per workspace.' },
  { key: 'scriptQueueMaxCap', label: 'Queue length cap', hint: 'Hard cap per workspace.' },
  { key: 'scriptQueueTimeoutMs', label: 'Queue wait timeout (ms)', hint: 'Longest an execution waits before QUOTA_EXCEEDED.' },
  { key: 'scriptMaxIsolates', label: 'Server-wide isolate ceiling', hint: 'Per pod. Keep ≥ the sum of busy workspaces’ pool sizes.' },
  { key: 'maxActiveInstancesCap', label: 'Active-instances cap', hint: '0 = no cap. Workspaces cannot raise their quota past it.' },
  { key: 'maxActiveTimersCap', label: 'Active-timers cap', hint: '0 = no cap.' },
  { key: 'maxReplicasCap', label: 'Serving-replicas cap', hint: '0 = no cap. Most replicas (pods) that may serve any one workspace at once; needs Redis when several pods run.' },
];
const WS_FIELDS: Array<keyof WorkspaceLimitOverride> = ['scriptPoolDefaultSize', 'scriptPoolMaxSize', 'scriptQueueDefaultMax', 'scriptQueueMaxCap', 'maxActiveInstancesCap', 'maxActiveTimersCap', 'maxReplicasCap'];

// Platform administrator only (the server answers 403 to everyone else): global limits + per-workspace caps/locks + live usage.
@Component({
  selector: 'app-platform-limits',
  standalone: true,
  imports: [FormsModule, BreadcrumbComponent],
  template: `
    <div class="page">
      <div class="crumbwrap"><app-breadcrumb [crumbs]="[{ label: 'Platform limits' }]" /></div>
      <header class="pagehead"><h1>Platform limits</h1><p class="muted">Effective value = min(workspace setting, per-workspace cap, global cap). Changes apply live — no restart. Caps and queues are per server pod.</p></header>
      @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
      @if (!usage() && !error()) { <p class="muted">Loading…</p> }
      <nav class="tabs">
        <button [class.active]="tab() === 'workspaces'" (click)="tab.set('workspaces')">Workspaces</button>
        <button [class.active]="tab() === 'plans'" (click)="tab.set('plans')">Plans</button>
        <button [class.active]="tab() === 'global'" (click)="tab.set('global')">Global caps</button>
      </nav>
      @if (tab() === 'plans') {
        <section class="card">
          <h3>Plan limits</h3>
          <p class="hint">What each plan allows, per workspace. <b>-1 = unlimited</b>. A plan can only tighten the platform-wide caps, never lift them. Saved plans apply to every workspace on them within a couple of seconds.</p>
          @if (plans().length) {
            <div class="tablewrap"><table>
              <thead><tr><th>Limit</th>@for (p of plans(); track p.key) { <th>{{ p.name }}<div class="muted small">{{ p.key }}</div></th> }</tr></thead>
              <tbody>
                @for (k of limitKeys(); track k) {
                  <tr><td><b>{{ catalog()[k].label || k }}</b><div class="muted small">{{ catalog()[k].unit }}</div></td>
                    @for (p of plans(); track p.key) { <td><input type="number" min="-1" step="1" [ngModel]="planDraft()[p.key][k]" (ngModelChange)="setPlan(p.key, k, $event)" style="width:90px;" /></td> }
                  </tr>
                }
              </tbody>
              <tfoot><tr><td></td>@for (p of plans(); track p.key) { <td><button class="btn primary" [disabled]="!planDirty(p.key)" (click)="savePlan(p)">Save {{ p.name }}</button></td> }</tr></tfoot>
            </table></div>
          } @else { <p class="muted">Loading plans…</p> }
        </section>
      }
      @if (tab() === 'global' && g(); as limits) {
        <section class="card">
          <h3>Global defaults & caps</h3>
          @for (f of fields; track f.key) {
            <div class="setting-row"><div class="lbl">{{ f.label }}<span class="shint">{{ f.hint }}</span></div>
              <input type="number" min="0" [ngModel]="limits[f.key]" (ngModelChange)="setG(f.key, $event)" style="width:110px;" /></div>
          }
          <div class="setting-row"><div class="lbl">Default overflow mode<span class="shint">Queue: wait for a slot. Reject: fail immediately.</span></div>
            <select [ngModel]="limits.scriptOverflowModeDefault" (ngModelChange)="setG('scriptOverflowModeDefault', $event)" style="width:120px;"><option value="queue">Queue</option><option value="reject">Reject</option></select></div>
          <div class="actions"><button class="btn primary" (click)="saveGlobal()">Save global limits</button></div>
        </section>
      }
      @if (tab() === 'workspaces' && usage(); as u) {
        <section class="card">
          <h3>Server <span class="muted">· {{ u.server.totalIsolates }} / {{ u.server.maxIsolates }} isolates · {{ u.server.queuedTotal }} queued · {{ u.server.executions }} runs · {{ u.server.overflowRejected + u.server.queueRejected + u.server.queueTimeouts }} refused</span></h3>
          <div class="tablewrap"><table>
            <thead><tr><th>Workspace</th><th>Plan</th><th>Pool</th><th>Running</th><th>Queued</th><th>Peak</th><th>Created / recycled</th><th>Queue max</th><th>Mode</th><th>Caps (pool / queue)</th><th>Override</th></tr></thead>
            <tbody>
              @for (w of u.workspaces; track w.workspaceId) {
                <tr>
                  <td><b>{{ w.name || w.slug || w.workspaceId }}</b><div class="muted small">{{ w.workspaceId }}</div></td>
                  <td>
                    <select [ngModel]="w.plan || ''" (ngModelChange)="assign(w, $event)" style="width:110px;">
                      @for (p of plans(); track p.key) { <option [value]="p.key">{{ p.name }}</option> }
                    </select>
                    @if (w.planExpiresAt) { <div class="muted small">{{ expiry(w.planExpiresAt) }}</div> }
                    <div><button class="btn small-btn" (click)="extend(w, 7)">+7 days</button></div>
                  </td>
                  <td>{{ w.effective.scriptPoolSize }}</td><td>{{ w.pool.running }}</td><td>{{ w.pool.queued }}</td><td>{{ w.pool.peakRunning }}</td>
                  <td>{{ w.pool.created }} / {{ w.pool.recycled }}</td><td>{{ w.effective.scriptQueueMax }}</td>
                  <td>{{ w.effective.scriptOverflowMode }}@if (w.caps.lockedOverflowMode) { 🔒 }</td>
                  <td>{{ w.caps.scriptPoolMaxSize }} / {{ w.caps.scriptQueueMaxCap }}</td>
                  <td><button class="btn" (click)="edit(w)">Edit</button></td>
                </tr>
              }
            </tbody>
          </table></div>
        </section>
      }
      @if (editing(); as w) {
        <section class="card">
          <h3>Override for {{ w.name || w.slug || w.workspaceId }}</h3>
          <p class="hint">Leave a field empty to inherit the global value. A workspace cap can tighten the global cap, never lift it.</p>
          @for (k of wsFields; track k) {
            <div class="setting-row"><div class="lbl">{{ k }}</div>
              <input type="number" min="0" [ngModel]="ov()[k]" (ngModelChange)="setOv(k, $event)" style="width:110px;" /></div>
          }
          <div class="setting-row"><div class="lbl">Lock overflow mode<span class="shint">When set, the workspace cannot choose its own mode.</span></div>
            <select [ngModel]="ov().lockedOverflowMode ?? null" (ngModelChange)="setOv('lockedOverflowMode', $event)" style="width:140px;"><option [ngValue]="null">Not locked</option><option value="queue">Queue</option><option value="reject">Reject</option></select></div>
          <div class="actions"><button class="btn primary" (click)="saveWs(w)">Save override</button> <button class="btn" (click)="editing.set(null)">Cancel</button></div>
        </section>
      }
    </div>
  `,
  styles: [`
    .page { padding: 20px 28px; } .card { background: var(--surface); border-radius: 12px; padding: 18px 20px; margin: 14px 0; }
    .setting-row { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 8px 0; border-top: 1px solid var(--border); }
    .shint { display: block; font-size: 12px; color: var(--muted); font-weight: 400; } .actions { margin-top: 12px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; } th, td { text-align: left; padding: 7px 8px; border-top: 1px solid var(--border); }
    .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin: 14px 0 0; }
    .tabs button { border: 0; background: transparent; padding: 10px 14px; font-weight: 600; color: var(--muted); border-bottom: 2px solid transparent; cursor: pointer; }
    .tabs button.active { color: var(--primary); border-bottom-color: var(--primary); }
    .hint { color: var(--muted); font-size: 13px; } .small-btn { padding: 2px 8px; font-size: 11px; margin-top: 4px; }
    .tablewrap { overflow-x: auto; } .small { font-size: 11px; } .err { color: var(--danger, #c0392b); }
  `],
})
export class PlatformLimitsComponent implements OnInit, OnDestroy {
  private api = inject(PlatformApiService);
  private toast = inject(ToastService);
  fields = GLOBAL_FIELDS; wsFields = WS_FIELDS;
  g = signal<PlatformLimits | null>(null);
  usage = signal<PlatformUsage | null>(null);
  editing = signal<PlatformUsageRow | null>(null);
  ov = signal<WorkspaceLimitOverride>({});
  error = signal('');
  tab = signal<'workspaces' | 'plans' | 'global'>('workspaces');
  plans = signal<PlanRow[]>([]);
  catalog = signal<Record<string, LimitInfo>>({});
  planDraft = signal<Record<string, Record<string, number>>>({});
  limitKeys = computed(() => Object.keys(this.catalog()));
  private timer?: ReturnType<typeof setInterval>;

  ngOnInit() {
    this.api.getLimits().subscribe({ next: (r) => this.g.set({ ...r.limits }), error: (e) => this.error.set(e?.error?.error?.message || 'Platform administrator access required') });
    this.loadPlans();
    this.refresh();
    this.timer = setInterval(() => this.refresh(), 5000);
  }
  ngOnDestroy() { clearInterval(this.timer); }
  refresh() { this.api.usage().subscribe({ next: (u) => { this.usage.set(u); this.error.set(''); }, error: (e) => this.error.set(e?.error?.error?.message || 'Could not load platform usage') }); }
  loadPlans() {
    this.api.plans().subscribe({
      next: (r) => { this.plans.set(r.plans); this.catalog.set(r.catalog); this.planDraft.set(Object.fromEntries(r.plans.map((p) => [p.key, { ...p.limits }]))); },
      error: (e) => this.error.set(e?.error?.error?.message || 'Could not load plans'),
    });
  }
  setPlan(plan: string, key: string, v: unknown) {
    const n = v === '' || v === null || v === undefined ? NaN : Number(v);
    this.planDraft.update((d) => ({ ...d, [plan]: { ...d[plan], [key]: n } }));
  }
  planDirty(plan: string) {
    const base = this.plans().find((p) => p.key === plan)?.limits ?? {}; const d = this.planDraft()[plan] ?? {};
    return Object.keys(d).some((k) => d[k] !== base[k]);
  }
  savePlan(p: PlanRow) {
    const d = this.planDraft()[p.key] ?? {};
    const bad = Object.entries(d).find(([, v]) => !Number.isInteger(v) || v < -1);
    if (bad) return this.toast.error(`${this.catalog()[bad[0]]?.label || bad[0]}: whole number ≥ -1 (-1 = unlimited)`);
    const changed = Object.fromEntries(Object.entries(d).filter(([k, v]) => v !== p.limits[k]));
    this.api.updatePlan(p.key, changed).subscribe({ next: () => { this.toast.success(`${p.name} plan saved`); this.loadPlans(); }, error: (e) => this.toast.error(e?.error?.error?.message || 'Could not save plan') });
  }
  assign(w: PlatformUsageRow, plan: string) {
    if (!plan || plan === w.plan) return;
    this.api.assignPlan(w.workspaceId, { plan }).subscribe({ next: () => { this.toast.success(`${w.name || w.workspaceId} is now on ${plan}`); this.refresh(); }, error: (e) => { this.toast.error(e?.error?.error?.message || 'Could not change plan'); this.refresh(); } });
  }
  extend(w: PlatformUsageRow, days: number) {
    this.api.assignPlan(w.workspaceId, { plan: w.plan || 'trial', extendDays: days }).subscribe({ next: () => { this.toast.success(`Extended by ${days} days`); this.refresh(); }, error: (e) => this.toast.error(e?.error?.error?.message || 'Could not extend') });
  }
  expiry(iso: string) { const d = Math.ceil((Date.parse(iso) - Date.now()) / 86400000); return d >= 0 ? `ends in ${d} day${d === 1 ? '' : 's'}` : `expired ${-d} day${d === -1 ? '' : 's'} ago`; }
  setG(key: keyof PlatformLimits, value: unknown) { this.g.update((cur) => (cur ? ({ ...cur, [key]: value } as PlatformLimits) : cur)); }
  saveGlobal() {
    this.api.putLimits(this.g()!).subscribe({ next: (r) => { this.g.set({ ...r.limits }); this.toast.success('Platform limits saved and applied live'); this.refresh(); }, error: (e) => this.toast.error(e?.error?.error?.message || 'Could not save') });
  }
  edit(w: PlatformUsageRow) { this.editing.set(w); this.api.getWorkspace(w.workspaceId).subscribe((r) => this.ov.set({ ...r.override })); }
  setOv(k: string, v: unknown) { const next: Record<string, unknown> = { ...this.ov() }; if (v === null || v === '' || v === undefined) delete next[k]; else next[k] = v; this.ov.set(next as WorkspaceLimitOverride); }
  saveWs(w: PlatformUsageRow) {
    const cur = this.ov() as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const k of [...WS_FIELDS, 'lockedOverflowMode']) patch[k] = cur[k] ?? null;   // null clears an inherited field
    this.api.putWorkspace(w.workspaceId, patch).subscribe({ next: () => { this.toast.success('Workspace override saved and applied live'); this.editing.set(null); this.refresh(); }, error: (e) => this.toast.error(e?.error?.error?.message || 'Could not save') });
  }
}
