import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

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
  template: `
    <div class="page">
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
  `],
})
export class PlanUsageComponent implements OnInit {
  private http = inject(HttpClient);
  data = signal<PlanUsage | null>(null);
  error = signal<string | null>(null);
  periods: Array<['day' | 'week' | 'month', string]> = [['day', 'Today'], ['week', 'This week'], ['month', 'This month']];
  resources: Array<['workflows' | 'teamMembers' | 'deployments' | 'activeInstances' | 'activeTimers', string]> = [['workflows', 'Workflows'], ['teamMembers', 'Team members (incl. invited)'], ['deployments', 'Deployments'], ['activeInstances', 'Active instances'], ['activeTimers', 'Active timers']];
  limitLabels = LIMIT_LABELS;
  daysLeft = computed(() => { const d = this.data(); return d?.trialEndsAt ? Math.max(0, Math.ceil((Date.parse(d.trialEndsAt) - Date.now()) / 86_400_000)) : 0; });
  pct = (used: number, limit: number | null) => (limit === null || limit <= 0 ? 0 : Math.min(100, Math.round((used / limit) * 100)));

  async ngOnInit() {
    try { this.data.set(await firstValueFrom(this.http.get<PlanUsage>('/api/plan/usage'))); }
    catch (e: any) { this.error.set(e?.error?.error?.message || 'Could not load your plan'); }
  }
}
