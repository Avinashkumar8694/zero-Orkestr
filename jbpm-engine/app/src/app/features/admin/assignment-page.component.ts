import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';
import { AllocationApiService, type AllocationStrategy, type AssignmentRule, type PersonLoad, type Tracker } from '../../core/api/allocation-api.service';
import { IamApiService } from '../../core/api/iam-api.service';
import { WorkflowApiService } from '../../core/api/workflow-api.service';
import { ModalService } from '../../shared/modal.service';
import { ToastService } from '../../shared/toast.service';
import type { AppGroup, Workflow } from '../../core/models';

const STRATEGIES: Array<{ key: AllocationStrategy; label: string; hint: string }> = [
  { key: 'leastLoaded', label: 'Least loaded', hint: 'The person with the fewest open tasks (then fewest given today).' },
  { key: 'roundRobin', label: 'Round robin', hint: 'Each person in turn: whoever was given a task longest ago.' },
  { key: 'skills', label: 'By skills', hint: 'Only people who have every required skill, then the least loaded of them.' },
];

// Admin → Task assignment. The workload of everyone who can take tasks, and the rules that give waiting tasks to a person. A separate runner (the allocator)
// applies the rules; this page only edits them and shows what it did. A task assigned by name, by #{variable}, by swimlane or by hand is never touched.
@Component({
  selector: 'app-assignment-page',
  standalone: true,
  imports: [FormsModule],
  template: `
    <section class="card block">
      <div class="head">
        <h3>Workload</h3>
        <span class="muted sm">who has what right now · updates every few seconds</span>
        <span class="spacer"></span>
        <button class="btn" (click)="loadTracker()">Refresh</button>
        <button class="btn" (click)="runNow()" [disabled]="running()" title="The allocator runs on its own; this runs one pass immediately">Run allocation now</button>
      </div>
      @if (tracker(); as t) {
        <div class="pills">
          <span class="pill" [class.warn]="t.waiting.pending > 0"><b>{{ t.waiting.pending }}</b> waiting for the allocator</span>
          <span class="pill" [class.warn]="t.waiting.queued > 0"><b>{{ t.waiting.queued }}</b> in a group queue (nobody qualified)</span>
          <span class="pill"><b>{{ t.rules }}</b> active rule{{ t.rules === 1 ? '' : 's' }}</span>
        </div>
        <div class="tablewrap">
          <table>
            <thead><tr><th>Person</th><th>Skills</th><th class="num">Open</th><th class="num">In progress</th><th class="num">Given today</th><th class="num">Done today</th><th>Limits</th><th>Status</th></tr></thead>
            <tbody>
              @for (p of t.people; track p.username) {
                <tr [class.away]="!p.available">
                  <td><b>{{ p.username }}</b></td>
                  <td>@for (s of p.skills; track s) { <span class="badge">{{ s }}</span> } @if (!p.skills.length) { <span class="muted">—</span> }</td>
                  <td class="num" [class.full]="p.maxOpenTasks && p.open >= p.maxOpenTasks">{{ p.open }}</td>
                  <td class="num">{{ p.inProgress }}</td>
                  <td class="num" [class.full]="p.maxTasksPerDay && p.assignedToday >= p.maxTasksPerDay">{{ p.assignedToday }}</td>
                  <td class="num">{{ p.completedToday }}</td>
                  <td class="muted sm">{{ limits(p) }}</td>
                  <td><button class="chip" [class.on]="p.available" (click)="toggleAway(p)" [title]="p.available ? 'Mark as away: no new tasks' : 'Mark as available'">{{ p.available ? 'available' : 'away' }}</button></td>
                </tr>
              }
              @if (!t.people.length) { <tr><td colspan="8" class="muted">No active users in this workspace yet.</td></tr> }
            </tbody>
          </table>
        </div>
        <p class="muted sm">Skills, open-task and daily limits are set per person under <b>Users</b>.</p>
      } @else if (trackerError()) { <p class="err">{{ trackerError() }}</p> } @else { <p class="muted">Loading…</p> }
    </section>

    <section class="card block">
      <div class="head">
        <h3>Assignment rules</h3>
        <span class="muted sm">most specific wins: a task node, then a project, then a group · a strategy set on the task itself beats every rule</span>
        <span class="spacer"></span>
        <button class="btn primary" (click)="newRule()">+ New rule</button>
      </div>
      <div class="rules">
        <div class="tablewrap">
          <table>
            <thead><tr><th>Rule</th><th>Applies to</th><th>How</th><th>Skills</th><th></th></tr></thead>
            <tbody>
              @for (r of rules(); track r.id) {
                <tr [class.sel]="draft()?.id === r.id" [class.off]="!r.enabled">
                  <td><b>{{ r.name }}</b>@if (!r.enabled) { <span class="badge archived">off</span> }<div class="muted sm">priority {{ r.priority }}</div></td>
                  <td class="sm">{{ scopeText(r) }}</td>
                  <td class="sm">{{ strategyLabel(r.strategy) }}@if (r.pool) { <div class="muted">among {{ poolText(r) }}</div> }@if (!r.respectLimits) { <div class="muted">ignores limits</div> }</td>
                  <td>@for (s of r.requiredSkills || []; track s) { <span class="badge">{{ s }}</span> } @if (!(r.requiredSkills || []).length) { <span class="muted">—</span> }</td>
                  <td class="acts"><button class="btn" (click)="edit(r)">Edit</button><button class="btn danger" (click)="remove(r)">Delete</button></td>
                </tr>
              }
              @if (!rules().length) { <tr><td colspan="5" class="muted">No rules yet. Without a rule, tasks stay in their group queue until someone claims them, unless the task itself sets a strategy.</td></tr> }
            </tbody>
          </table>
        </div>

        @if (draft(); as d) {
          <form class="editor" (ngSubmit)="save()">
            <h4>{{ d.id ? 'Edit rule' : 'New rule' }}</h4>
            <div class="field"><label>Name</label><input name="name" [(ngModel)]="d.name" placeholder="e.g. Motor claims to motor specialists" /></div>
            <div class="two">
              <div class="field"><label>Priority</label><input name="priority" type="number" [(ngModel)]="d.priority" /><span class="muted sm">lower runs first among equally specific rules</span></div>
              <label class="chkrow"><input name="enabled" type="checkbox" [(ngModel)]="d.enabled" /> Enabled</label>
            </div>
            <h5>Applies to</h5>
            <div class="field"><label>Project</label>
              <select name="wf" [(ngModel)]="d.workflowId"><option value="">Every project</option>@for (w of workflows(); track w.id) { <option [value]="w.id">{{ w.name }}</option> }</select></div>
            <div class="field"><label>Task (node id)</label><input name="node" [(ngModel)]="d.nodeId" placeholder="empty = every task; the id shown in the builder" /></div>
            <div class="field"><label>Offered to group</label>
              <select name="grp" [(ngModel)]="d.group"><option value="">Any group</option>@for (g of groups(); track g.id) { <option [value]="g.name">{{ g.name }}</option> }</select></div>
            <h5>How to pick</h5>
            <div class="field"><label>Strategy</label>
              <select name="st" [(ngModel)]="d.strategy">@for (s of strategies; track s.key) { <option [value]="s.key">{{ s.label }}</option> }</select>
              <span class="muted sm">{{ strategyHint(d.strategy) }}</span></div>
            <div class="field"><label>Required skills</label><input name="skills" [(ngModel)]="d.skills" placeholder="comma separated, e.g. motor, fraud" />
              @if (d.strategy === 'skills' && !d.skills.trim()) { <span class="err sm">The skills strategy needs at least one skill.</span> }</div>
            <div class="field"><label>Choose among (optional)</label>
              <div class="chips">@for (g of groups(); track g.id) { <label class="chkrow"><input type="checkbox" [checked]="d.poolGroups.includes(g.name)" (change)="togglePool(d.poolGroups, g.name)" /> {{ g.name }}</label> }</div>
              <span class="muted sm">Empty = the people or group members the task itself offers.</span></div>
            <label class="chkrow"><input name="limits" type="checkbox" [(ngModel)]="d.respectLimits" /> Skip people at their open-task or daily limit</label>
            <div class="row"><button class="btn primary" type="submit">{{ d.id ? 'Save rule' : 'Create rule' }}</button><button class="btn" type="button" (click)="draft.set(null)">Cancel</button></div>
          </form>
        }
      </div>
    </section>
  `,
  styles: [`
    .block { padding: 16px; margin-bottom: 16px; }
    .head { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
    .head h3 { margin: 0; font-size: 15px; } .spacer { flex: 1; }
    .sm { font-size: 12px; }
    .pills { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
    .pill { background: var(--surface-2); border: 1px solid var(--border); border-radius: 999px; padding: 4px 12px; font-size: 12px; }
    .pill.warn { background: var(--amber-bg, #fff4d6); }
    .tablewrap { overflow-x: auto; }
    .num { text-align: right; font-variant-numeric: tabular-nums; } td.full { color: var(--red, #c0392b); font-weight: 600; }
    tr.away td { opacity: .6; } tr.off td { opacity: .55; } tr.sel td { background: var(--primary-50); }
    .badge + .badge { margin-left: 4px; }
    .chip { border: 1px solid var(--border); background: var(--surface-2); border-radius: 999px; padding: 2px 10px; font-size: 12px; cursor: pointer; }
    .chip.on { background: var(--green-bg, #e3f6e8); }
    .rules { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 380px); gap: 16px; align-items: start; }
    @media (max-width: 1100px) { .rules { grid-template-columns: 1fr; } }
    .acts { white-space: nowrap; display: flex; gap: 6px; }
    .editor { border: 1px solid var(--border); border-radius: 12px; padding: 14px; background: var(--surface); }
    .editor h4 { margin: 0 0 10px; font-size: 14px; } .editor h5 { margin: 14px 0 8px; font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
    .field { margin-bottom: 12px; } .field label { display: block; font-size: 12px; color: var(--muted); font-weight: 600; margin-bottom: 4px; }
    .field input, .field select { width: 100%; border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; font-size: 13px; background: var(--surface); color: inherit; }
    .two { display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: end; }
    .chkrow { display: flex; align-items: center; gap: 8px; font-size: 13px; margin: 4px 0; } .chkrow input { width: auto; }
    .chips { display: flex; flex-wrap: wrap; gap: 4px 14px; }
    .row { display: flex; gap: 8px; margin-top: 14px; }
    .err { color: var(--red, #c0392b); }
  `],
})
export class AssignmentPageComponent implements OnInit, OnDestroy {
  private api = inject(AllocationApiService);
  private iam = inject(IamApiService);
  private wfApi = inject(WorkflowApiService);
  private modal = inject(ModalService);
  private toast = inject(ToastService);

  strategies = STRATEGIES;
  tracker = signal<Tracker | null>(null);
  trackerError = signal('');
  rules = signal<AssignmentRule[]>([]);
  groups = signal<AppGroup[]>([]);
  workflows = signal<Workflow[]>([]);
  running = signal(false);
  draft = signal<Draft | null>(null);
  private wfName = computed(() => new Map(this.workflows().map((w) => [w.id, w.name] as const)));
  private timer?: ReturnType<typeof setInterval>;

  ngOnInit() {
    this.loadTracker(); this.loadRules();
    this.iam.listGroups().subscribe({ next: (g) => this.groups.set(g), error: () => {} });
    this.wfApi.listWorkflows().subscribe({ next: (w) => this.workflows.set(w), error: () => {} });
    this.timer = setInterval(() => this.loadTracker(), 8000);
  }
  ngOnDestroy() { clearInterval(this.timer); }

  loadTracker() { this.api.tracker().subscribe({ next: (t) => { this.tracker.set(t); this.trackerError.set(''); }, error: (e) => this.trackerError.set(e?.error?.error?.message || 'Could not load the workload') }); }
  loadRules() { this.api.rules().subscribe({ next: (r) => this.rules.set(r.items), error: (e) => this.toast.error(e?.error?.error?.message || 'Could not load the rules') }); }
  runNow() {
    this.running.set(true);
    this.api.runNow().subscribe({ next: (r) => { this.running.set(false); this.toast.success(`${r.assigned} assigned, ${r.queued} left in a queue`); this.loadTracker(); }, error: (e) => { this.running.set(false); this.toast.error(e?.error?.error?.message || 'Could not run the allocator'); } });
  }
  toggleAway(p: PersonLoad) {
    this.iam.listUsers().subscribe((us) => {
      const u = us.find((x) => x.username === p.username); if (!u) return;
      this.iam.updateUser(u.id, { available: !p.available }).subscribe({ next: () => { this.toast.success(`${p.username} is ${p.available ? 'away' : 'available'}`); this.loadTracker(); }, error: (e) => this.toast.error(e?.error?.error?.message || 'Could not update the person') });
    });
  }
  limits(p: PersonLoad) { const l = [p.maxOpenTasks ? `${p.maxOpenTasks} open` : '', p.maxTasksPerDay ? `${p.maxTasksPerDay} / day` : ''].filter(Boolean); return l.length ? l.join(' · ') : 'no limits'; }

  strategyLabel(s: string) { return STRATEGIES.find((x) => x.key === s)?.label ?? s; }
  strategyHint(s: string) { return STRATEGIES.find((x) => x.key === s)?.hint ?? ''; }
  scopeText(r: AssignmentRule) {
    const parts = [r.scope.workflowId ? `project ${this.wfName().get(r.scope.workflowId) ?? r.scope.workflowId}` : '', r.scope.nodeId ? `task ${r.scope.nodeId}` : '', r.scope.group ? `group ${r.scope.group}` : ''].filter(Boolean);
    return parts.length ? parts.join(' · ') : 'every task';
  }
  poolText(r: AssignmentRule) { return [...(r.pool?.groups ?? []), ...(r.pool?.users ?? [])].join(', '); }
  togglePool(list: string[], name: string) { const i = list.indexOf(name); if (i >= 0) list.splice(i, 1); else list.push(name); }

  newRule() { this.draft.set({ name: '', enabled: true, priority: 100, workflowId: '', nodeId: '', group: '', strategy: 'leastLoaded', skills: '', poolGroups: [], poolUsers: [], respectLimits: true }); }
  edit(r: AssignmentRule) {
    this.draft.set({ id: r.id, name: r.name, enabled: r.enabled, priority: r.priority, workflowId: r.scope.workflowId ?? '', nodeId: r.scope.nodeId ?? '', group: r.scope.group ?? '', strategy: r.strategy,
      skills: (r.requiredSkills ?? []).join(', '), poolGroups: [...(r.pool?.groups ?? [])], poolUsers: [...(r.pool?.users ?? [])], respectLimits: r.respectLimits });
  }
  save() {
    const d = this.draft(); if (!d) return;
    if (!d.name.trim()) return this.toast.error('Give the rule a name');
    const skills = d.skills.split(',').map((s) => s.trim()).filter(Boolean);
    if (d.strategy === 'skills' && !skills.length) return this.toast.error('The skills strategy needs at least one skill');
    const body = { name: d.name.trim(), enabled: d.enabled, priority: Number(d.priority) || 100, scope: { workflowId: d.workflowId || undefined, nodeId: d.nodeId.trim() || undefined, group: d.group || undefined },
      strategy: d.strategy, requiredSkills: skills, pool: { groups: d.poolGroups, users: d.poolUsers }, respectLimits: d.respectLimits };
    const req = d.id ? this.api.updateRule(d.id, body) : this.api.createRule(body);
    req.subscribe({ next: () => { this.toast.success(d.id ? 'Rule saved' : 'Rule created'); this.draft.set(null); this.loadRules(); }, error: (e) => this.toast.error(e?.error?.error?.message || 'Could not save the rule') });
  }
  async remove(r: AssignmentRule) {
    if (!(await this.modal.confirm({ title: 'Delete rule?', message: `"${r.name}" stops applying. Tasks it already assigned keep their person.`, confirmLabel: 'Delete', danger: true }))) return;
    this.api.deleteRule(r.id).subscribe({ next: () => { this.toast.success('Rule deleted'); if (this.draft()?.id === r.id) this.draft.set(null); this.loadRules(); }, error: (e) => this.toast.error(e?.error?.error?.message || 'Could not delete the rule') });
  }
}

interface Draft { id?: string; name: string; enabled: boolean; priority: number; workflowId: string; nodeId: string; group: string; strategy: AllocationStrategy; skills: string; poolGroups: string[]; poolUsers: string[]; respectLimits: boolean }
