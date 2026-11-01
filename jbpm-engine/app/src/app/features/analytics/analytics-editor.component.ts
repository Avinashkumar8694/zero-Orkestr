import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { BreadcrumbComponent } from '../../shared/breadcrumb.component';
import { ToastService } from '../../shared/toast.service';
import {
  AnalyticsBuilderApiService, type AnalyticsApiDef, type AnalyticsResult, type Catalog, type CatalogRelation, type ParamSpec, type QCond, type QGroup, type QValue,
} from '../../core/api/analytics-builder-api.service';

const isGroup = (n: QCond | QGroup): n is QGroup => 'items' in n;
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '').slice(0, 48);

@Component({
  selector: 'app-analytics-editor',
  standalone: true,
  imports: [FormsModule, RouterLink, NgTemplateOutlet, BreadcrumbComponent],
  template: `
    <div class="page">
      <div class="crumbwrap"><app-breadcrumb [crumbs]="[{ label: 'Analytics builder', link: ['/analytics'] }, { label: def.name || 'New analytics' }]" /></div>
      @if (loadError()) { <p class="err" role="alert">{{ loadError() }}</p> }
      @if (cat(); as c) {
        <datalist id="fieldrefs">@for (r of fieldRefs(); track r) { <option [value]="r"></option> }</datalist>
        <datalist id="outcols">@for (r of outputCols(); track r) { <option [value]="r"></option> }@for (r of fieldRefs(); track r) { <option [value]="r"></option> }</datalist>

        <div class="cols">
          <div class="left">
            <section class="card">
              <h3>1 · Basics</h3>
              <div class="grid2">
                <label class="f">Name<input [(ngModel)]="def.name" (ngModelChange)="autoSlug()" placeholder="Open cases by examiner" /></label>
                <label class="f">Slug <small class="muted">— the call is /api/analytics/run/{{ def.slug || 'slug' }}</small><input [(ngModel)]="def.slug" (ngModelChange)="slugTouched = true" placeholder="open-cases-by-examiner" /></label>
              </div>
              <label class="f">Description<input [(ngModel)]="def.description" /></label>
              <div class="grid4">
                <label class="f">Status<select [(ngModel)]="def.status"><option value="draft">Draft (preview only)</option><option value="published">Published (callable)</option></select></label>
                <label class="f">Visibility<select [(ngModel)]="def.visibility"><option value="workspace">Workspace</option><option value="private">Private (only me)</option></select></label>
                <label class="f">Cache (seconds)<input type="number" min="0" max="3600" [(ngModel)]="def.cacheSeconds" /></label>
                <label class="f">Also require<input [(ngModel)]="def.requires" placeholder="e.g. admin:iam (optional)" /></label>
              </div>
              <label class="chk"><input type="checkbox" [(ngModel)]="def.allowFlows" /> <span>Allow flows to call this (a Case / Process instance node runs it with the engine’s authority)</span></label>
            </section>

            <section class="card">
              <h3>2 · Source and joins</h3>
              <label class="f">Start from
                <select [ngModel]="def.query.from" (ngModelChange)="setFrom($event)">
                  @for (s of c.sources; track s.key) { <option [value]="s.key" [disabled]="!s.allowed">{{ s.label }}{{ s.allowed ? '' : ' — needs ' + s.permission }}</option> }
                </select>
              </label>
              @for (j of def.query.joins || []; track $index; let i = $index) {
                <div class="row">
                  <span class="chip">{{ relLabel(j.rel) }}</span>
                  <label class="inl">as <input class="sm" [(ngModel)]="j.as" [placeholder]="relTo(j.rel)" /></label>
                  <select class="sm" [(ngModel)]="j.type"><option value="left">keep rows without a match (left)</option><option value="inner">only rows with a match (inner)</option></select>
                  <button class="x" (click)="removeJoin(i)" aria-label="Remove join">×</button>
                </div>
              }
              @if (availableRelations().length) {
                <label class="f">Add a join
                  <select (change)="addJoin($any($event.target).value); $any($event.target).value = ''">
                    <option value="">Choose a relation…</option>
                    @for (r of availableRelations(); track r.key) { <option [value]="r.key" [disabled]="!sourceAllowed(r.to)">{{ r.label }}{{ r.many ? ' (many)' : '' }}{{ r.recursive ? ' ↻' : '' }}{{ sourceAllowed(r.to) ? '' : ' — not permitted' }}</option> }
                  </select>
                </label>
              }
              <p class="muted small">Fields are written <code>alias.field</code> (for example <code>process.status</code>, <code>task.totalMs</code>, <code>case.data.claimAmount</code>). ↻ marks recursive relations: they walk the whole call tree and add <code>depth</code>.</p>
            </section>

            <section class="card">
              <h3>3 · Filters</h3>
              <ng-container *ngTemplateOutlet="grp; context: { $implicit: def.query.where, root: true }"></ng-container>
              <ng-template #grp let-g let-root="root">
                <div class="grp" [class.nested]="!root">
                  <div class="row">
                    <select class="sm" [(ngModel)]="g.op"><option value="and">All of these</option><option value="or">Any of these</option></select>
                    <button class="btn sm" (click)="addCond(g)">+ condition</button>
                    <button class="btn sm" (click)="addGroup(g)">+ group</button>
                    @if (!root) { <button class="x" (click)="$any(g).__remove?.()" aria-label="Remove group">×</button> }
                  </div>
                  @for (it of g.items; track $index; let i = $index) {
                    @if (isGroup(it)) {
                      <ng-container *ngTemplateOutlet="grp; context: { $implicit: withRemove(it, g, i), root: false }"></ng-container>
                    } @else {
                      <div class="row cond">
                        <input class="fld" list="fieldrefs" [(ngModel)]="it.field" placeholder="alias.field" />
                        <select class="sm" [(ngModel)]="it.op">@for (o of c.operators; track o) { <option [value]="o">{{ opLabel(o) }}</option> }</select>
                        @if (needsValue(it.op)) {
                          <select class="sm" [ngModel]="kindOf(it)" (ngModelChange)="setKind(it, $event)"><option value="value">value</option><option value="param">parameter</option><option value="now">time from now</option></select>
                          <input class="val" [ngModel]="valText(it)" (ngModelChange)="setVal(it, $event)" [placeholder]="kindOf(it) === 'param' ? 'parameter name' : kindOf(it) === 'now' ? '-7d' : listOp(it.op) ? 'a, b, c' : 'value'" />
                        }
                        <button class="x" (click)="g.items.splice(i, 1); syncParams()" aria-label="Remove condition">×</button>
                      </div>
                    }
                  }
                  @if (!g.items.length) { <p class="muted small">No conditions: every row qualifies.</p> }
                </div>
              </ng-template>
            </section>

            <section class="card">
              <h3>4 · Output</h3>
              <div class="seg"><button [class.on]="mode() === 'rows'" (click)="setMode('rows')">List rows</button><button [class.on]="mode() === 'aggregate'" (click)="setMode('aggregate')">Group &amp; measure</button></div>
              @if (mode() === 'rows') {
                @for (s of def.query.select || []; track $index; let i = $index) {
                  <div class="row"><input class="fld" list="fieldrefs" [(ngModel)]="s.field" placeholder="alias.field" /><label class="inl">as <input class="sm" [(ngModel)]="s.as" /></label><button class="x" (click)="def.query.select!.splice(i, 1)" aria-label="Remove column">×</button></div>
                }
                <button class="btn sm" (click)="addSelect()">+ column</button>
                <p class="muted small">No columns chosen = the source’s own plain fields.</p>
              } @else {
                <h4>Group by</h4>
                @for (g of def.query.groupBy || []; track $index; let i = $index) {
                  <div class="row"><input class="fld" list="fieldrefs" [(ngModel)]="g.field" placeholder="alias.field" />
                    <select class="sm" [(ngModel)]="g.bucket"><option [ngValue]="undefined">as is</option>@for (b of c.buckets; track b) { <option [value]="b">by {{ b }}</option> }</select>
                    <label class="inl">as <input class="sm" [(ngModel)]="g.as" /></label><button class="x" (click)="def.query.groupBy!.splice(i, 1)" aria-label="Remove group by">×</button></div>
                }
                <button class="btn sm" (click)="addGroupBy()">+ group by</button>
                <h4>Measures</h4>
                @for (m of def.query.metrics || []; track $index; let i = $index) {
                  <div class="row"><select class="sm" [(ngModel)]="m.fn">@for (f of c.functions; track f) { <option [value]="f">{{ f }}</option> }</select>
                    <input class="fld" list="fieldrefs" [(ngModel)]="m.field" [placeholder]="m.fn === 'count' ? '(empty = count rows)' : 'alias.field'" />
                    <label class="inl">as <input class="sm" [(ngModel)]="m.as" /></label><button class="x" (click)="def.query.metrics!.splice(i, 1)" aria-label="Remove measure">×</button></div>
                }
                <button class="btn sm" (click)="addMetric()">+ measure</button>
                <h4>Keep groups where <small class="muted">(optional)</small></h4>
                <ng-container *ngTemplateOutlet="grp; context: { $implicit: havingGroup(), root: true }"></ng-container>
              }
              <h4>Sort and size</h4>
              @for (s of def.query.sort || []; track $index; let i = $index) {
                <div class="row"><input class="fld" list="outcols" [(ngModel)]="s.field" placeholder="column or alias.field" /><select class="sm" [(ngModel)]="s.dir"><option value="asc">ascending</option><option value="desc">descending</option></select><button class="x" (click)="def.query.sort!.splice(i, 1)" aria-label="Remove sort">×</button></div>
              }
              <div class="row"><button class="btn sm" (click)="addSort()">+ sort</button>
                <label class="inl">limit <input class="sm num" type="number" min="1" max="1000" [(ngModel)]="def.query.limit" /></label>
                <label class="inl">offset <input class="sm num" type="number" min="0" [(ngModel)]="def.query.offset" /></label></div>
            </section>

            @if (def.params.length) {
              <section class="card">
                <h3>5 · Parameters <small class="muted">— found in your filters</small></h3>
                @for (p of def.params; track p.name) {
                  <div class="row"><code>{{ p.name }}</code>
                    <select class="sm" [(ngModel)]="p.type"><option value="string">text</option><option value="number">number</option><option value="boolean">yes/no</option><option value="date">date</option><option value="list">list</option></select>
                    <label class="chk"><input type="checkbox" [(ngModel)]="p.required" /> required</label>
                    <label class="inl">default <input class="sm" [(ngModel)]="p.default" /></label></div>
                }
              </section>
            }
          </div>

          <div class="right">
            <section class="card sticky">
              <h3>Preview</h3>
              @for (p of def.params; track p.name) { <label class="f">{{ p.name }}<input [(ngModel)]="testParams[p.name]" [placeholder]="p.type" /></label> }
              <div class="row"><button class="btn primary" (click)="preview()" [disabled]="running()">{{ running() ? 'Running…' : 'Run preview' }}</button>
                <button class="btn" (click)="save()" [disabled]="saving()">{{ saving() ? 'Saving…' : def.id ? 'Save changes' : 'Save' }}</button></div>
              @if (err()) { <p class="err" role="alert">{{ err() }}</p> }
              @if (result(); as r) {
                <p class="muted small">{{ r.meta.returned }} row{{ r.meta.returned === 1 ? '' : 's' }}{{ r.meta.total !== null ? ' of ' + r.meta.total : '' }} · {{ r.meta.tookMs }} ms · scanned {{ r.meta.scanned }}@if (r.meta.truncated) { <b class="warn"> · cut off: {{ r.meta.truncatedReason }}</b> }</p>
                <div class="rt"><table><thead><tr>@for (col of r.columns; track col.key) { <th>{{ col.label }}</th> }</tr></thead>
                  <tbody>@for (row of r.rows; track $index) { <tr>@for (col of r.columns; track col.key) { <td>{{ show(row[col.key]) }}</td> }</tr> }</tbody></table></div>
              }
              @if (def.slug) {
                <h4>Call it</h4>
                <pre class="snip">curl -H "Authorization: Bearer &lt;token&gt;" \\
  "{{ origin }}/api/analytics/run/{{ def.slug }}{{ qs() }}"</pre>
                @if (def.status !== 'published') { <p class="muted small">Draft: set the status to Published and save before calling it.</p> }
              }
            </section>
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    .page { padding: 12px 14px; display: flex; flex-direction: column; gap: 16px; max-width: 1400px; } .err { color: var(--red); font-size: 13px; } .warn { color: var(--red); }
    .cols { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: 16px; align-items: start; } .left, .right { display: grid; gap: 14px; }
    .card { padding: 16px 18px; display: grid; gap: 10px; } h3 { margin: 0; font-size: 15px; } h4 { margin: 6px 0 0; font-size: 13px; }
    .sticky { position: sticky; top: 12px; max-height: calc(100vh - 24px); overflow: auto; }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; } .grid4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
    .f { display: grid; gap: 5px; font-size: 12.5px; font-weight: 650; color: var(--text-secondary); } .f input, .f select { width: 100%; font-weight: 400; } .f small { font-weight: 400; }
    .chk { display: flex; gap: 8px; align-items: center; font-size: 13px; } .inl { display: inline-flex; gap: 6px; align-items: center; font-size: 12.5px; color: var(--muted); }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; } input.fld { flex: 1 1 170px; min-width: 130px; } input.val { flex: 1 1 130px; min-width: 100px; } .sm { max-width: 190px; } .num { width: 80px; }
    .chip { background: var(--primary-50); color: var(--primary); border-radius: 999px; padding: 4px 12px; font-size: 12.5px; font-weight: 600; }
    .grp { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px; display: grid; gap: 8px; } .grp.nested { margin-left: 14px; background: var(--surface-2); }
    .x { border: 0; background: var(--surface-3); width: 26px; height: 26px; border-radius: 50%; cursor: pointer; color: var(--muted); }
    .seg { display: inline-flex; border: 1px solid var(--border); border-radius: 999px; overflow: hidden; width: fit-content; } .seg button { border: 0; background: transparent; padding: 7px 16px; cursor: pointer; font: inherit; font-size: 13px; } .seg button.on { background: var(--primary); color: #fff; }
    .rt { overflow: auto; max-height: 340px; border: 1px solid var(--border); border-radius: var(--radius-sm); } .rt table { width: 100%; border-collapse: collapse; font-size: 12.5px; } .rt th, .rt td { padding: 6px 10px; text-align: left; border-bottom: 1px solid var(--border); white-space: nowrap; } .rt th { position: sticky; top: 0; background: var(--surface-2); }
    .snip { background: var(--surface-3); padding: 10px 12px; border-radius: var(--radius-sm); font-size: 12px; overflow: auto; margin: 0; } .small { font-size: 12px; } code { background: var(--surface-3); padding: 1px 6px; border-radius: 4px; }
    @media (max-width: 1000px) { .cols { grid-template-columns: 1fr; } .grid4 { grid-template-columns: 1fr 1fr; } .grid2 { grid-template-columns: 1fr; } .sticky { position: static; max-height: none; } }
  `],
})
export class AnalyticsEditorComponent implements OnInit {
  private api = inject(AnalyticsBuilderApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private toast = inject(ToastService);

  cat = signal<Catalog | null>(null);
  loadError = signal('');
  result = signal<AnalyticsResult | null>(null);
  err = signal('');
  running = signal(false);
  saving = signal(false);
  origin = location.origin;
  slugTouched = false;
  testParams: Record<string, string> = {};
  isGroup = isGroup;
  /** bumped on every edit so the computed field lists refresh (the query object is edited in place) */
  private tick = signal(0);

  def: AnalyticsApiDef = { slug: '', name: '', status: 'draft', visibility: 'workspace', cacheSeconds: 30, allowFlows: false, params: [], query: { from: 'process', joins: [], where: { op: 'and', items: [] }, select: [], limit: 100 } };

  fieldRefs = computed(() => {
    this.tick(); const c = this.cat(); if (!c) return [];
    const out: string[] = [];
    for (const [alias, src] of this.aliases()) {
      const s = c.sources.find((x) => x.key === src); if (!s) continue;
      for (const f of s.fields) out.push(`${alias}.${f.key}`);
      for (const d of s.dynamic) out.push(`${alias}.${d.key}.`);
    }
    return out;
  });
  outputCols = computed(() => { this.tick(); const q = this.def.query; return [...(q.groupBy || []).map((g) => g.as || g.field.replace(/\./g, '_')), ...(q.metrics || []).map((m) => m.as || (m.field ? `${m.fn}_${m.field.replace(/\./g, '_')}` : m.fn)), ...(q.select || []).map((s) => s.as || s.field.replace(/\./g, '_'))].filter(Boolean); });
  mode = computed<'rows' | 'aggregate'>(() => { this.tick(); return (this.def.query.groupBy?.length || this.def.query.metrics?.length) ? 'aggregate' : 'rows'; });
  availableRelations = computed<CatalogRelation[]>(() => {
    this.tick(); const c = this.cat(); if (!c) return [];
    const have = new Set(this.aliases().values());
    return c.relations.filter((r) => have.has(r.from));
  });

  ngOnInit() {
    this.api.catalog().subscribe({
      next: (c) => { this.cat.set(c); const id = this.route.snapshot.paramMap.get('id'); if (id && id !== 'new') this.load(id); else this.syncParams(); },
      error: (e) => this.loadError.set(e?.error?.error?.message || 'Could not load the catalogue'),
    });
  }
  private load(id: string) {
    this.api.get(id).subscribe({
      next: (d) => { this.def = { ...d, params: d.params ?? [], query: { ...d.query, joins: d.query.joins ?? [], where: d.query.where ?? { op: 'and', items: [] }, select: d.query.select ?? [] } }; this.slugTouched = true; this.tick.update((x) => x + 1); },
      error: (e) => this.loadError.set(e?.error?.error?.message || 'Could not load this analytics API'),
    });
  }

  aliases(): Map<string, string> {
    const m = new Map<string, string>([[this.def.query.from, this.def.query.from]]);
    for (const j of this.def.query.joins || []) m.set(j.as || this.relTo(j.rel), this.relTo(j.rel));
    return m;
  }
  relTo(key: string) { return this.cat()?.relations.find((r) => r.key === key)?.to ?? ''; }
  relLabel(key: string) { return this.cat()?.relations.find((r) => r.key === key)?.label ?? key; }
  sourceAllowed(src: string) { return this.cat()?.sources.find((s) => s.key === src)?.allowed ?? false; }
  touch() { this.tick.update((x) => x + 1); }

  autoSlug() { if (!this.slugTouched) this.def.slug = slugify(this.def.name); }
  setFrom(src: string) { this.def.query.from = src; this.def.query.joins = []; this.touch(); }
  addJoin(rel: string) {
    if (!rel) return;
    const to = this.relTo(rel); const taken = this.aliases();
    const joins = (this.def.query.joins ||= []);
    joins.push({ rel, type: 'left', ...(taken.has(to) ? { as: `${to}${joins.length + 1}` } : {}) });
    this.touch();
  }
  removeJoin(i: number) {
    const joins = this.def.query.joins!; const gone = joins[i]!; const alias = gone.as || this.relTo(gone.rel);
    joins.splice(i, 1);
    // a join that started from the removed alias can no longer work
    for (let k = joins.length - 1; k >= 0; k--) { const r = this.cat()!.relations.find((x) => x.key === joins[k]!.rel)!; if (!this.aliases().has(joins[k]!.from ?? [...this.aliases()].find(([, s]) => s === r.from)?.[0] ?? '') ) joins.splice(k, 1); }
    void alias; this.touch();
  }

  // ---- filters ----
  addCond(g: QGroup) { g.items.push({ field: '', op: 'eq', value: '' }); }
  addGroup(g: QGroup) { g.items.push({ op: 'and', items: [] }); }
  /** lets a nested group remove itself from its parent */
  withRemove(it: QGroup, parent: QGroup, i: number): QGroup { (it as any).__remove = () => { parent.items.splice(i, 1); this.syncParams(); }; return it; }
  opLabel(o: string) { return ({ eq: 'is', ne: 'is not', gt: '>', gte: '≥', lt: '<', lte: '≤', in: 'is one of', nin: 'is none of', contains: 'contains', startsWith: 'starts with', between: 'between', isNull: 'is empty', notNull: 'is not empty' } as Record<string, string>)[o] ?? o; }
  needsValue(op: string) { return op !== 'isNull' && op !== 'notNull'; }
  listOp(op: string) { return op === 'in' || op === 'nin' || op === 'between'; }
  kindOf(c: QCond): 'value' | 'param' | 'now' { const v = c.value; return v && typeof v === 'object' && !Array.isArray(v) ? ('param' in v ? 'param' : 'now') : 'value'; }
  valText(c: QCond): string { const v = c.value; if (v && typeof v === 'object' && !Array.isArray(v)) return 'param' in v ? v.param : v.now; return Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v); }
  setKind(c: QCond, k: string) { const t = this.valText(c); this.setVal(c, t, k as 'value' | 'param' | 'now'); }
  setVal(c: QCond, text: string, kind = this.kindOf(c)) {
    const t = text ?? '';
    c.value = kind === 'param' ? ({ param: t.trim() } as QValue) : kind === 'now' ? ({ now: t.trim() } as QValue) : this.listOp(c.op) ? (t.split(',').map((x) => x.trim()).filter(Boolean) as QValue) : t;
    this.syncParams();
  }
  addSelect() { (this.def.query.select ||= []).push({ field: '' }); }
  addGroupBy() { (this.def.query.groupBy ||= []).push({ field: '' }); this.touch(); }
  addMetric() { (this.def.query.metrics ||= []).push({ fn: 'count' }); this.touch(); }
  addSort() { (this.def.query.sort ||= []).push({ field: '', dir: 'desc' }); }
  havingGroup(): QGroup { return (this.def.query.having ||= { op: 'and', items: [] }); }

  setMode(m: 'rows' | 'aggregate') {
    const q = this.def.query;
    if (m === 'rows') { q.groupBy = []; q.metrics = []; q.having = undefined; if (!q.select) q.select = []; }
    else { q.select = []; if (!q.metrics?.length) q.metrics = [{ fn: 'count', as: 'count' }]; }
    this.touch();
  }

  // ---- parameters ----
  private usedParams(): string[] {
    const out = new Set<string>();
    const walk = (n?: QCond | QGroup) => { if (!n) return; if (isGroup(n)) n.items.forEach(walk); else if (n.value && typeof n.value === 'object' && !Array.isArray(n.value) && 'param' in n.value && n.value.param) out.add(n.value.param); };
    walk(this.def.query.where); walk(this.def.query.having);
    return [...out];
  }
  syncParams() {
    const used = this.usedParams();
    const keep = this.def.params.filter((p) => used.includes(p.name));
    for (const u of used) if (!keep.some((p) => p.name === u)) keep.push({ name: u, type: 'string', required: true } as ParamSpec);
    this.def.params = keep; this.touch();
  }

  // ---- run / save ----
  private body(): Partial<AnalyticsApiDef> {
    const q = JSON.parse(JSON.stringify(this.def.query)) as AnalyticsApiDef['query'];
    const clean = (g?: QGroup) => { if (!g) return undefined; g.items = g.items.filter((i) => (isGroup(i) ? true : !!i.field)).map((i) => { if (isGroup(i)) { delete (i as any).__remove; clean(i); } return i; }); return g.items.length ? g : undefined; };
    q.where = clean(q.where); q.having = clean(q.having);
    q.select = (q.select || []).filter((s) => s.field).map((s) => ({ field: s.field, ...(s.as ? { as: s.as } : {}) }));
    q.groupBy = (q.groupBy || []).filter((g) => g.field).map((g) => ({ field: g.field, ...(g.bucket ? { bucket: g.bucket } : {}), ...(g.as ? { as: g.as } : {}) }));
    q.metrics = (q.metrics || []).map((m) => ({ fn: m.fn, ...(m.field ? { field: m.field } : {}), ...(m.as ? { as: m.as } : {}) }));
    q.sort = (q.sort || []).filter((s) => s.field);
    if (!q.joins?.length) delete q.joins; else q.joins = q.joins.map((j) => ({ rel: j.rel, type: j.type, ...(j.as ? { as: j.as } : {}) }));
    for (const k of ['select', 'groupBy', 'metrics', 'sort'] as const) if (!(q[k] as unknown[]).length) delete q[k];
    if (!q.limit) delete q.limit; if (!q.offset) delete q.offset;
    const params = this.def.params.map((p) => ({ ...p, default: p.default === '' || p.default === undefined ? undefined : p.default }));
    return { ...this.def, query: q, params };
  }
  preview() {
    this.err.set(''); this.running.set(true);
    const b = this.body();
    const values: Record<string, unknown> = {};
    for (const p of this.def.params) values[p.name] = this.testParams[p.name] ?? (p.default as string | undefined);
    this.api.preview(b.query!, values).subscribe({ next: (r) => { this.result.set(r); this.running.set(false); }, error: (e) => { this.running.set(false); this.result.set(null); this.err.set(e?.error?.error?.message || 'The preview failed'); } });
  }
  save() {
    this.err.set(''); this.saving.set(true);
    const b = this.body();
    const req = this.def.id ? this.api.update(this.def.id, b) : this.api.create(b);
    req.subscribe({
      next: (d) => { this.saving.set(false); this.toast.success(`Saved “${d.name}” (v${d.version})${d.status === 'published' ? ' — callable at /api/analytics/run/' + d.slug : ''}`); this.def.id = d.id; this.def.version = d.version; if (!this.route.snapshot.paramMap.get('id') || this.route.snapshot.paramMap.get('id') === 'new') this.router.navigate(['/analytics', d.id], { replaceUrl: true }); },
      error: (e) => { this.saving.set(false); this.err.set(e?.error?.error?.message || 'Could not save'); },
    });
  }
  show(v: unknown): string { return v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); }
  qs() { const ps = this.def.params; return ps.length ? '?' + ps.map((p) => `${p.name}=${this.testParams[p.name] ?? (p.type === 'number' ? '0' : 'value')}`).join('&') : ''; }
}
