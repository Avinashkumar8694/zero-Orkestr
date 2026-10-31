import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { BreadcrumbComponent } from '../../shared/breadcrumb.component';
import { ToastService } from '../../shared/toast.service';

interface PlanOption {
  key: string; name: string; description: string; status: 'active' | 'disabled' | 'upcoming' | 'hidden'; trialDays: number | null; isCustom: boolean;
  contactConfig: { type: 'email' | 'url'; value: string; label?: string } | null; features: string[]; limits: Record<string, number>; isDefault: boolean; current: boolean; selectable: boolean;
}

interface Period { used: number; limit: number | null; remaining: number | null; resetsAt: string }
interface Res { used: number; limit: number | null }
interface PlanUsage {
  plan: { key: string; name: string }; trialEndsAt: string | null; expired: boolean;
  limits: Record<string, number | null>;
  usage: Record<'day' | 'week' | 'month', Period>;
  resources: Record<'workflows' | 'teamMembers' | 'deployments' | 'activeInstances' | 'activeTimers', Res>;
}

const LIMIT_LABELS: Array<[string, string]> = [
  ['concurrentRequests', 'Concurrent API requests'], ['requestsPerMinute', 'API requests per minute'], ['concurrentScripts', 'Parallel script executions'],
  ['instancesPerDay', 'Process starts per day'], ['instancesPerWeek', 'Process starts per week'], ['instancesPerMonth', 'Process starts per month'],
  ['maxActiveInstances', 'Active instances'], ['maxActiveTimers', 'Active timers'], ['maxWorkflows', 'Workflows'], ['maxTeamMembers', 'Team members'], ['maxDeployments', 'Deployments'],
];

@Component({
  selector: 'app-plan-usage',
  standalone: true,
  imports: [BreadcrumbComponent],
  template: `
    <div class="page">
      <div class="crumbwrap"><app-breadcrumb [crumbs]="[{ label: 'Plan & usage' }]" /></div>
      <header>
        <h1>Plan &amp; usage</h1>
        @if (data(); as d) {
          <p class="muted">You are on the <strong>{{ d.plan.name }}</strong> plan.
            @if (d.trialEndsAt) {
              @if (d.expired) { <span class="bad">It ended on {{ d.trialEndsAt.slice(0, 10) }}.</span> Your data is kept and readable; creating or running anything is paused until you choose a plan. }
              @else { <span>{{ daysLeft() }} day{{ daysLeft() === 1 ? '' : 's' }} left (ends {{ d.trialEndsAt.slice(0, 10) }}).</span> }
            }
          </p>
        }
      </header>
      @if (error()) { <div class="error" role="alert">{{ error() }}</div> }
      @if (!data() && !error()) { <p class="muted">Loading your plan…</p> }
      @if (options().length) {
        <section class="card">
          <h3>Available plans</h3>
          @if (switchError()) { <div class="error" role="alert">{{ switchError() }}</div> }
          <div class="plans">
            @for (o of options(); track o.key) {
              <article class="opt" [class.cur]="o.current" [class.dim]="o.status !== 'active' && !o.current">
                <div class="oh"><b>{{ o.name }}</b>
                  @if (o.current) { <span class="tag cur">Current plan</span> }
                  @else if (o.status === 'upcoming') { <span class="tag soon">Coming soon</span> }
                  @else if (o.status === 'disabled') { <span class="tag off">Unavailable</span> }
                  @else if (o.isCustom) { <span class="tag">Custom</span> }
                </div>
                <p class="muted small">{{ o.description }}</p>
                <ul>
                  @for (l of headline; track l[0]) { <li><span>{{ l[1] }}</span><b>{{ o.limits[l[0]] < 0 ? 'Unlimited' : o.limits[l[0]] }}</b></li> }
                  @if (o.trialDays) { <li><span>Trial</span><b>{{ o.trialDays }} days</b></li> }
                  @for (f of o.features; track f) { <li class="f">✓ {{ f }}</li> }
                </ul>
                <div class="act">
                  @if (o.current) { <button class="btn sm" disabled>Your plan</button> }
                  @else if (o.isCustom && o.status === 'active' && o.contactConfig) {
                    <a class="btn sm primary" [href]="contactHref(o)" [attr.target]="o.contactConfig.type === 'url' ? '_blank' : null" rel="noopener">{{ o.contactConfig.label || 'Contact us' }}</a>
                  }
                  @else if (o.status === 'upcoming') { <button class="btn sm" disabled>Coming soon</button> }
                  @else if (o.selectable) { <button class="btn sm primary" [disabled]="switching() === o.key" (click)="choose(o)">{{ switching() === o.key ? 'Switching…' : 'Choose ' + o.name }}</button> }
                  @else { <button class="btn sm" disabled>Not available</button> }
                </div>
              </article>
            }
          </div>
        </section>
      }
      @if (data(); as d) {
        <section class="card">
          <h3>Process starts</h3>
          @for (p of periods; track p[0]) {
            <div class="row">
              <div class="label">{{ p[1] }}</div>
              <div class="bar" [attr.aria-label]="p[1]"><span [style.width.%]="pct(d.usage[p[0]].used, d.usage[p[0]].limit)" [class.warn]="pct(d.usage[p[0]].used, d.usage[p[0]].limit) >= 80"></span></div>
              <div class="num">{{ d.usage[p[0]].used }} / {{ d.usage[p[0]].limit ?? 'unlimited' }}</div>
              <div class="muted small">resets {{ d.usage[p[0]].resetsAt.slice(0, 16).replace('T', ' ') }} UTC</div>
            </div>
          }
        </section>
        <section class="card">
          <h3>Resources</h3>
          @for (r of resources; track r[0]) {
            <div class="row">
              <div class="label">{{ r[1] }}</div>
              <div class="bar"><span [style.width.%]="pct(d.resources[r[0]].used, d.resources[r[0]].limit)" [class.warn]="pct(d.resources[r[0]].used, d.resources[r[0]].limit) >= 80"></span></div>
              <div class="num">{{ d.resources[r[0]].used }} / {{ d.resources[r[0]].limit ?? 'unlimited' }}</div>
            </div>
          }
        </section>
        <section class="card">
          <h3>Everything your plan limits</h3>
          <table><tbody>
            @for (l of limitLabels; track l[0]) { <tr><td>{{ l[1] }}</td><td class="num">{{ d.limits[l[0]] ?? 'unlimited' }}</td></tr> }
          </tbody></table>
        </section>
      }
    </div>
  `,
  styles: [`
    .plans { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 12px; }
    .opt { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; } .opt.cur { border-color: var(--primary); background: var(--primary-50); } .opt.dim { opacity: .75; }
    .oh { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; } .opt p { margin: 0; }
    .tag { font-size: 11.5px; font-weight: 700; padding: 2px 9px; border-radius: 999px; background: var(--surface-3); color: var(--text-secondary); white-space: nowrap; } .tag.cur { background: var(--primary); color: #fff; } .tag.soon { background: var(--purple-bg); color: var(--purple); } .tag.off { background: var(--red-bg); color: var(--red); }
    .opt ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; font-size: 13px; } .opt li { display: flex; justify-content: space-between; gap: 8px; } .opt li span { color: var(--muted); } .opt li.f { color: var(--text-secondary); justify-content: flex-start; }
    .act { margin-top: auto; padding-top: 6px; }
    .crumbwrap { margin-bottom: 10px; }
    .page { padding: 24px; display: flex; flex-direction: column; gap: 16px; max-width: 860px; }
    h1 { margin: 0 0 4px; font-size: var(--text-xl); } h3 { margin: 0 0 12px; font-size: 15px; }
    .card { padding: 16px 18px; border-radius: var(--radius-shell); }
    .row { display: grid; grid-template-columns: 190px 1fr 130px; gap: 12px; align-items: center; padding: 6px 0; }
    .row .small { grid-column: 2 / 4; margin-top: -6px; }
    .bar { height: 8px; border-radius: 4px; background: var(--surface-3); overflow: hidden; }
    .bar span { display: block; height: 100%; background: var(--primary); } .bar span.warn { background: var(--red); }
    .num { text-align: right; font-variant-numeric: tabular-nums; } .muted { color: var(--muted); } .small { font-size: 12px; }
    .bad { color: var(--red); } .error { color: var(--red); background: var(--red-bg); padding: 8px 10px; border-radius: var(--radius-sm); }
    table { width: 100%; border-collapse: collapse; } td { padding: 7px 4px; border-top: 1px solid var(--border); }
      @media (max-width: 900px) { .row { grid-template-columns: minmax(0, 1fr) auto; row-gap: 6px; } .row .bar { grid-column: 1 / -1; grid-row: 2; } .row .small { grid-column: 1 / -1; margin-top: 0; } .num { text-align: right; white-space: nowrap; } }
  `],
})
export class PlanUsageComponent implements OnInit {
  private http = inject(HttpClient);
  private toast = inject(ToastService);
  options = signal<PlanOption[]>([]);
  switching = signal('');
  switchError = signal('');
  headline: Array<[string, string]> = [['concurrentRequests', 'Concurrent requests'], ['instancesPerMonth', 'Starts / month'], ['maxTeamMembers', 'Team members'], ['maxWorkflows', 'Workflows']];
  contactHref = (o: PlanOption) => (o.contactConfig!.type === 'email' ? `mailto:${o.contactConfig!.value}?subject=${encodeURIComponent('Plan enquiry: ' + o.name)}` : o.contactConfig!.value);
  async loadOptions() {
    try { this.options.set((await firstValueFrom(this.http.get<{ items: PlanOption[] }>('/api/plan/options'))).items); } catch { /* the usage below still renders */ }
  }
  async choose(o: PlanOption) {
    this.switchError.set(''); this.switching.set(o.key);
    try {
      await firstValueFrom(this.http.put('/api/plan', { planKey: o.key }));
      this.toast.success(`Your workspace is now on ${o.name}`);
      await Promise.all([this.loadOptions(), this.loadUsage()]);
    } catch (e: any) { this.switchError.set(e?.error?.error?.message || 'Could not switch plan'); }
    this.switching.set('');
  }
  data = signal<PlanUsage | null>(null);
  error = signal<string | null>(null);
  periods: Array<['day' | 'week' | 'month', string]> = [['day', 'Today'], ['week', 'This week'], ['month', 'This month']];
  resources: Array<['workflows' | 'teamMembers' | 'deployments' | 'activeInstances' | 'activeTimers', string]> = [['workflows', 'Workflows'], ['teamMembers', 'Team members (incl. invited)'], ['deployments', 'Deployments'], ['activeInstances', 'Active instances'], ['activeTimers', 'Active timers']];
  limitLabels = LIMIT_LABELS;
  daysLeft = computed(() => { const d = this.data(); return d?.trialEndsAt ? Math.max(0, Math.ceil((Date.parse(d.trialEndsAt) - Date.now()) / 86_400_000)) : 0; });
  pct = (used: number, limit: number | null) => (limit === null || limit <= 0 ? 0 : Math.min(100, Math.round((used / limit) * 100)));

  async ngOnInit() { await Promise.all([this.loadOptions(), this.loadUsage()]); }
  async loadUsage() {
    try { this.data.set(await firstValueFrom(this.http.get<PlanUsage>('/api/plan/usage'))); }
    catch (e: any) { this.error.set(e?.error?.error?.message || 'Could not load your plan'); }
  }
}
