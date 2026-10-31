import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { PlatformApiService, type LimitInfo, type PlanInput, type PlanRow, type PlanStatus } from '../../core/api/platform-api.service';
import { ModalService } from '../../shared/modal.service';
import { ToastService } from '../../shared/toast.service';
import { IconComponent } from '../../shared/icon.component';

const STATUSES: { key: PlanStatus; label: string; help: string }[] = [
  { key: 'active', label: 'Active', help: 'Workspaces can select this plan.' },
  { key: 'upcoming', label: 'Coming soon', help: 'Listed to workspaces and on the pricing page as "coming soon"; nobody can select it yet.' },
  { key: 'disabled', label: 'Disabled', help: 'Listed, but locked: workspaces cannot select it.' },
  { key: 'hidden', label: 'Hidden', help: 'Not listed anywhere. Only an administrator can assign it to a workspace.' },
];
const HEADLINE = ['concurrentRequests', 'instancesPerMonth', 'maxTeamMembers', 'maxWorkflows'];

interface Draft {
  key: string; name: string; description: string; status: PlanStatus; isDefault: boolean; isCustom: boolean;
  trialDays: string; contactType: 'email' | 'url'; contactValue: string; contactLabel: string; features: string; sortOrder: string;
  limits: Record<string, string>;
}

// The plan catalogue (platform administrator): create, edit, publish (status), set the default, delete. Modelled on payment-ms's
// Plans console. The server enforces every rule; the form mirrors the important ones so mistakes show before the round trip.
@Component({
  selector: 'app-plans-admin',
  standalone: true,
  imports: [FormsModule, IconComponent],
  template: `
    <div class="head">
      <div><h3>Plans</h3><p class="muted sub">The plans workspaces can be on. Publish a plan by setting it <b>Active</b>; new plans start <b>Hidden</b>. Nothing is charged: an administrator assigns a plan, or a workspace selects one you made available.</p></div>
      <span class="spacer"></span>
      <button class="btn primary" (click)="openNew()"><app-icon name="plus" [size]="14" /> New plan</button>
    </div>

    @if (loading()) { <p class="muted">Loading plans…</p> }
    @if (error()) { <p class="err" role="alert">{{ error() }} <button class="btn sm" (click)="load()">Retry</button></p> }

    <div class="stats">
      <div class="card stat"><span class="n">{{ plans().length }}</span><span class="l">Plans</span></div>
      <div class="card stat"><span class="n ok">{{ countStatus('active') }}</span><span class="l">Active</span></div>
      <div class="card stat"><span class="n">{{ workspaces() }}</span><span class="l">Workspaces on a plan</span></div>
    </div>

    <div class="cards">
      @for (p of plans(); track p.key) {
        <article class="card plan" [class.dim]="p.status === 'hidden' || p.status === 'disabled'">
          <header>
            <div class="ptitle"><b>{{ p.name }}</b> <span class="muted key">{{ p.key }}</span></div>
            <div class="badges">
              @if (p.isDefault) { <span class="badge b-default">Default</span> }
              @if (p.isCustom) { <span class="badge b-custom">Contact us</span> }
              @if (p.trialDays) { <span class="badge">{{ p.trialDays }}-day trial</span> }
            </div>
          </header>
          <p class="desc">{{ p.description || 'No description yet.' }}</p>
          <ul class="facts">
            @for (k of headline; track k) { @if (catalog()[k]; as info) { <li><span>{{ info.label }}</span><b>{{ fmt(p.limits[k]) }}</b></li> } }
          </ul>
          @if (p.features.length) { <div class="feat">@for (f of p.features.slice(0, 4); track f) { <span class="chip">{{ f }}</span> } @if (p.features.length > 4) { <span class="chip">+{{ p.features.length - 4 }}</span> }</div> }
          <div class="workspaces">{{ p.workspaces }} workspace{{ p.workspaces === 1 ? '' : 's' }}</div>
          <footer>
            <label class="status">
              <span class="muted">Status</span>
              <select [ngModel]="p.status" (ngModelChange)="setStatus(p, $event)" [attr.aria-label]="'Status of ' + p.name">
                @for (s of statuses; track s.key) { <option [value]="s.key">{{ s.label }}</option> }
              </select>
            </label>
            <span class="spacer"></span>
            @if (!p.isDefault && p.status === 'active' && !p.isCustom) { <button class="btn sm" (click)="makeDefault(p)">Make default</button> }
            <button class="btn sm" (click)="openEdit(p)">Edit</button>
            <button class="btn sm danger" [disabled]="p.isDefault" [title]="p.isDefault ? 'Make another plan the default first' : p.workspaces ? p.workspaces + ' workspace(s) are on it — hide it instead' : 'Delete this plan'" (click)="remove(p)">Delete</button>
          </footer>
        </article>
      }
      <button class="card plan add" (click)="openNew()"><span class="plus">+</span><b>Create a plan</b><span class="muted">Set the limits, the trial length and who can select it.</span></button>
    </div>

    @if (draft(); as d) {
      <div class="overlay" (click)="close()">
        <form class="dialog card" (click)="$event.stopPropagation()" (ngSubmit)="save()" role="dialog" aria-modal="true" [attr.aria-label]="editing() ? 'Edit plan' : 'New plan'">
          <header class="dh"><h3>{{ editing() ? 'Edit ' + d.name : 'New plan' }}</h3><span class="spacer"></span><button type="button" class="x" (click)="close()" aria-label="Close"><app-icon name="close" [size]="16" /></button></header>
          <div class="body">
            <div class="grid2">
              <label class="f">Key<input name="key" [(ngModel)]="d.key" [disabled]="editing()" placeholder="growth" maxlength="32" /><small class="muted">{{ editing() ? 'The key never changes.' : 'Lower-case letters, digits, - and _. Permanent.' }}</small></label>
              <label class="f">Name<input name="name" [(ngModel)]="d.name" placeholder="Growth" maxlength="100" /></label>
            </div>
            <label class="f">Description<input name="desc" [(ngModel)]="d.description" maxlength="500" placeholder="One line shown on the pricing page" /></label>
            <div class="grid2">
              <label class="f">Status
                <select name="status" [(ngModel)]="d.status">@for (s of statuses; track s.key) { <option [value]="s.key">{{ s.label }}</option> }</select>
                <small class="muted">{{ statusHelp(d.status) }}</small>
              </label>
              <label class="f">Trial days<input name="trial" [(ngModel)]="d.trialDays" inputmode="numeric" placeholder="none" [disabled]="d.isCustom" /><small class="muted">A workspace that starts on this plan ends it this many days later. Empty = no end.</small></label>
            </div>
            <div class="checks">
              <label class="chk"><input type="checkbox" name="def" [(ngModel)]="d.isDefault" /> <span><b>Default plan</b> — new workspaces start on it (must be Active, not "contact us").</span></label>
              <label class="chk"><input type="checkbox" name="cus" [(ngModel)]="d.isCustom" (ngModelChange)="d.isCustom && (d.trialDays = '')" /> <span><b>"Contact us" plan</b> — workspaces cannot select it; they contact you and you assign it.</span></label>
            </div>
            @if (d.isCustom) {
              <div class="grid3">
                <label class="f">Contact by<select name="ct" [(ngModel)]="d.contactType"><option value="email">E-mail</option><option value="url">Web link</option></select></label>
                <label class="f">{{ d.contactType === 'email' ? 'E-mail address' : 'Link (https://…)' }}<input name="cv" [(ngModel)]="d.contactValue" /></label>
                <label class="f">Button text<input name="cl" [(ngModel)]="d.contactLabel" maxlength="60" placeholder="Contact sales" /></label>
              </div>
            }
            <h4>Limits <span class="muted">per workspace · -1 = unlimited</span></h4>
            <div class="limits">
              @for (k of limitKeys(); track k) {
                <label class="lim"><span>{{ catalog()[k].label }}<small class="muted">{{ catalog()[k].unit }}</small></span><input type="number" min="-1" step="1" [name]="'l_' + k" [(ngModel)]="d.limits[k]" /></label>
              }
            </div>
            <div class="grid2">
              <label class="f">Feature labels<textarea name="feat" [(ngModel)]="d.features" rows="4" placeholder="One per line — shown on the plan card"></textarea></label>
              <label class="f">Sort order<input name="sort" [(ngModel)]="d.sortOrder" inputmode="numeric" placeholder="0" /><small class="muted">Lower numbers are listed first.</small></label>
            </div>
            @if (formError()) { <p class="err" role="alert">{{ formError() }}</p> }
          </div>
          <footer class="df"><button type="button" class="btn" (click)="close()">Cancel</button><button class="btn primary" type="submit" [disabled]="saving()">{{ saving() ? 'Saving…' : editing() ? 'Save changes' : 'Create plan' }}</button></footer>
        </form>
      </div>
    }
  `,
  styles: [`
    .head { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
    .sub { max-width: 70ch; margin: 4px 0 0; font-size: 13.5px; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px; margin-bottom: 14px; }
    .stat { padding: 14px 18px; display: flex; flex-direction: column-reverse; gap: 2px; } .stat .n { font-size: 28px; font-weight: 700; letter-spacing: -.03em; } .stat .n.ok { color: var(--green); } .stat .l { font-size: 13px; color: var(--text-secondary); font-weight: 600; }
    .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 14px; }
    .plan { padding: 18px 20px; display: flex; flex-direction: column; gap: 10px; text-align: left; font: inherit; color: inherit; }
    .plan.dim { opacity: .82; }
    .plan header { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
    .ptitle b { font-size: 16px; } .key { font-size: 12px; margin-left: 6px; font-family: var(--font-mono); }
    .badges { display: flex; gap: 6px; flex-wrap: wrap; } .b-default { background: var(--green-bg); color: var(--green); } .b-custom { background: var(--purple-bg); color: var(--purple); }
    .desc { font-size: 13.5px; color: var(--text-secondary); margin: 0; min-height: 2.6em; }
    .facts { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; } .facts li { display: flex; justify-content: space-between; gap: 10px; font-size: 13px; padding: 6px 0; border-bottom: 1px solid var(--border); } .facts li span { color: var(--muted); } .facts li b { white-space: nowrap; }
    .feat { display: flex; flex-wrap: wrap; gap: 6px; } .chip { font-size: 12px; padding: 3px 10px; border-radius: var(--radius-pill); background: var(--primary-50); color: var(--primary); font-weight: 600; }
    .workspaces { font-size: 12.5px; color: var(--muted); font-weight: 600; }
    .plan footer { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: auto; padding-top: 4px; }
    .status { display: flex; align-items: center; gap: 8px; font-size: 12.5px; } .status select { padding: 6px 12px; font-size: 13px; }
    .add { align-items: center; justify-content: center; min-height: 220px; border: 2px dashed var(--border-strong); background: transparent; box-shadow: none; cursor: pointer; text-align: center; }
    .add:hover { border-color: var(--primary); background: var(--primary-50); transform: none; } .plus { font-size: 34px; line-height: 1; color: var(--primary); }
    .err { color: var(--red); font-size: 13px; }
    .overlay { position: fixed; inset: 0; z-index: 400; background: rgba(20, 14, 50, .5); backdrop-filter: blur(3px); display: grid; place-items: center; padding: 16px; }
    .dialog { width: min(760px, 100%); max-height: calc(100vh - 32px); display: flex; flex-direction: column; box-shadow: var(--shadow-pop); }
    .dh { display: flex; align-items: center; padding: 16px 22px; border-bottom: 1px solid var(--border); } .x { border: 0; background: var(--surface-3); width: 30px; height: 30px; border-radius: 50%; cursor: pointer; color: var(--muted); display: grid; place-items: center; }
    .body { padding: 18px 22px; overflow-y: auto; display: grid; gap: 14px; }
    .df { display: flex; justify-content: flex-end; gap: 10px; padding: 14px 22px; border-top: 1px solid var(--border); }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; } .grid3 { display: grid; grid-template-columns: 1fr 1.4fr 1fr; gap: 14px; }
    .f { display: grid; gap: 6px; font-size: 12.5px; font-weight: 650; color: var(--text-secondary); } .f input, .f select, .f textarea { width: 100%; font-weight: 400; } .f small { font-weight: 400; font-size: 12px; }
    .checks { display: grid; gap: 8px; } .chk { display: flex; gap: 10px; align-items: flex-start; font-size: 13px; } .chk input { margin-top: 3px; }
    h4 { margin: 4px 0 0; font-size: 14px; } .limits { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 8px 16px; }
    .lim { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 13px; } .lim span { display: grid; } .lim small { font-size: 11.5px; } .lim input { width: 110px; flex: none; }
    @media (max-width: 700px) { .grid2, .grid3 { grid-template-columns: 1fr; } .dialog { max-height: 100vh; border-radius: var(--radius-sm); } }
  `],
})
export class PlansAdminComponent implements OnInit {
  private api = inject(PlatformApiService);
  private toast = inject(ToastService);
  private modal = inject(ModalService);

  statuses = STATUSES;
  headline = HEADLINE;
  plans = signal<PlanRow[]>([]);
  catalog = signal<Record<string, LimitInfo>>({});
  limitKeys = computed(() => Object.keys(this.catalog()));
  loading = signal(true);
  error = signal('');
  draft = signal<Draft | null>(null);
  editing = signal(false);
  saving = signal(false);
  formError = signal('');
  workspaces = computed(() => this.plans().reduce((n, p) => n + p.workspaces, 0));

  ngOnInit() { this.load(); }
  load() {
    this.loading.set(true); this.error.set('');
    this.api.plans().subscribe({
      next: (r) => { this.plans.set(r.plans as PlanRow[]); this.catalog.set(r.catalog); this.loading.set(false); },
      error: (e) => { this.loading.set(false); this.error.set(e?.error?.error?.message || 'Could not load plans'); },
    });
  }
  countStatus(s: PlanStatus) { return this.plans().filter((p) => p.status === s).length; }
  statusHelp(s: PlanStatus) { return STATUSES.find((x) => x.key === s)?.help ?? ''; }
  fmt(v: number | undefined) { return v === undefined ? '—' : v < 0 ? 'Unlimited' : v.toLocaleString(); }

  private toDraft(p?: PlanRow): Draft {
    const limits: Record<string, string> = {};
    for (const k of Object.keys(this.catalog())) limits[k] = String(p ? p.limits[k] ?? -1 : -1);
    return {
      key: p?.key ?? '', name: p?.name ?? '', description: p?.description ?? '', status: p?.status ?? 'hidden', isDefault: p?.isDefault ?? false, isCustom: p?.isCustom ?? false,
      trialDays: p?.trialDays ? String(p.trialDays) : '', contactType: p?.contactConfig?.type ?? 'email', contactValue: p?.contactConfig?.value ?? '', contactLabel: p?.contactConfig?.label ?? '',
      features: (p?.features ?? []).join('\n'), sortOrder: p ? String(p.sortOrder) : '0', limits,
    };
  }
  openNew() { this.editing.set(false); this.formError.set(''); this.draft.set(this.toDraft()); }
  openEdit(p: PlanRow) { this.editing.set(true); this.formError.set(''); this.draft.set(this.toDraft(p)); }
  close() { this.draft.set(null); }

  /** the editor's values as the API wants them; throws a readable message for anything obviously wrong */
  private payload(d: Draft): PlanInput {
    const num = (v: string, what: string, min: number, max: number): number => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${what} must be a whole number between ${min} and ${max}`);
      return n;
    };
    const limits: Record<string, number> = {};
    for (const [k, v] of Object.entries(d.limits)) limits[k] = num(String(v), this.catalog()[k]?.label ?? k, -1, 2_000_000_000);
    const out: PlanInput = {
      name: d.name.trim(), description: d.description.trim(), status: d.status, isDefault: d.isDefault, isCustom: d.isCustom,
      trialDays: d.isCustom || !d.trialDays.trim() ? null : num(d.trialDays, 'Trial days', 1, 365),
      features: d.features.split('\n').map((x) => x.trim()).filter(Boolean), sortOrder: d.sortOrder.trim() ? num(d.sortOrder, 'Sort order', -1000, 1000) : 0, limits,
      contactConfig: d.isCustom ? { type: d.contactType, value: d.contactValue.trim(), ...(d.contactLabel.trim() ? { label: d.contactLabel.trim() } : {}) } : null,
    };
    if (!out.name || out.name.length < 2) throw new Error('Name is required (2+ characters)');
    if (d.isDefault && d.status !== 'active') throw new Error('The default plan must be Active: new workspaces start on it');
    if (d.isDefault && d.isCustom) throw new Error('A "contact us" plan cannot be the default plan');
    return out;
  }

  save() {
    const d = this.draft(); if (!d) return;
    let body: PlanInput;
    try { body = this.payload(d); } catch (e) { this.formError.set((e as Error).message); return; }
    this.formError.set(''); this.saving.set(true);
    const req = this.editing() ? this.api.updatePlan(d.key, body) : this.api.createPlan({ ...body, key: d.key.trim() });
    req.subscribe({
      next: (p) => { this.saving.set(false); this.toast.success(this.editing() ? `"${p.name}" saved` : `"${p.name}" created — it is Hidden until you set it Active`); this.close(); this.load(); },
      error: (e) => { this.saving.set(false); this.formError.set(e?.error?.error?.message || 'Could not save the plan'); },
    });
  }

  setStatus(p: PlanRow, status: PlanStatus) {
    this.api.updatePlan(p.key, { status }).subscribe({
      next: () => { this.toast.success(`"${p.name}" is now ${STATUSES.find((s) => s.key === status)!.label}`); this.load(); },
      error: (e) => { this.toast.error(e?.error?.error?.message || 'Could not change the status'); this.load(); },
    });
  }
  makeDefault(p: PlanRow) {
    this.api.updatePlan(p.key, { isDefault: true }).subscribe({
      next: () => { this.toast.success(`New workspaces now start on "${p.name}"`); this.load(); },
      error: (e) => this.toast.error(e?.error?.error?.message || 'Could not make it the default'),
    });
  }
  async remove(p: PlanRow) {
    const ok = await this.modal.confirm({
      title: `Delete "${p.name}"?`,
      message: p.workspaces ? `${p.workspaces} workspace(s) are on this plan, so it cannot be deleted. Set it to Hidden to retire it instead.` : 'This cannot be undone. Only a plan nobody is on can be deleted.',
      confirmLabel: 'Delete', danger: true,
    });
    if (!ok) return;
    this.api.deletePlan(p.key).subscribe({
      next: () => { this.toast.success(`"${p.name}" deleted`); this.load(); },
      error: (e) => this.toast.error(e?.error?.error?.message || 'Could not delete the plan'),
    });
  }
}
