import { Component, EventEmitter, Input, OnChanges, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { CallableProcess, UiField as Field, UiSection as Section, VarSource } from '../../core/models';
import { IconComponent } from '../../shared/icon.component';
import { CodeEditorComponent } from '../../shared/code-editor.component';

// Generic, schema-driven property editor. Renders every configurable field for the selected node's
// type (from NODE_SCHEMA) so a node can be fully configured. Emits `changed` on any edit.
@Component({
  selector: 'app-properties-panel',
  standalone: true,
  imports: [IconComponent, FormsModule, CodeEditorComponent],
  template: `
    @if (sections.length === 0) {
      <div class="unsupported-box">
        <div class="unsupported-hdr">
          <span class="unsupported-ic"><app-icon name="alert-triangle" [size]="18" /></span>
          <strong>Unsupported Construct: {{ node?.type || 'unknown' }}</strong>
        </div>
        <p class="unsupported-desc">This construct type is not supported by the execution engine and cannot be configured or executed directly.</p>
        <div class="unsupported-fix">
          <strong>Recommendation:</strong> Use "Replace Node" to replace this construct with a standard Task (Script, REST Service, User Task), Gateway, or Sub-process from the palette.
        </div>
      </div>
    }
    @for (sec of sections; track sec.title) {
      <div class="sec">
        <div class="sec-h">{{ sec.title }}</div>
        @for (f of sec.fields; track f.key) {
          <div class="fld">
            <label>{{ f.label }}</label>
            @switch (f.widget) {
              @case ('text') { <input [ngModel]="val(f.key)" (ngModelChange)="set(f.key, $event)" [placeholder]="f.placeholder || ''" /> }
              @case ('number') { <input type="number" [ngModel]="val(f.key)" (ngModelChange)="set(f.key, num($event))" /> }
              @case ('bool') {
                <label class="tog"><input type="checkbox" [ngModel]="!!val(f.key)" (ngModelChange)="set(f.key, $event)" /><span>{{ !!val(f.key) ? 'On' : 'Off' }}</span></label>
              }
              @case ('select') {
                <select [ngModel]="selVal(f)" (ngModelChange)="onSelect(f, $event)">
                  @for (o of f.options; track o) { <option [value]="o">{{ o }}</option> }
                </select>
              }
              @case ('code') {
                <app-code-editor
                  [code]="val(f.key) || ''"
                  [lang]="val('lang') || val(f.key + 'Lang') || 'js'"
                  [placeholder]="f.placeholder || '// Write script logic here...'"
                  [cheatSheetContent]="cheatSheetContent"
                  [javaReferenceContent]="javaReferenceContent"
                  (codeChange)="set(f.key, $event)"
                  (openCheatSheet)="openCheatSheet.emit($event)"
                ></app-code-editor>
              }
              @case ('textarea') { <textarea rows="3" [ngModel]="val(f.key)" (ngModelChange)="set(f.key, $event)" [placeholder]="f.placeholder || ''"></textarea> }
              @case ('stringlist') {
                <div class="list">
                  @if (f.varSource) {
                    <datalist [id]="f.key + '-sl-dl'">
                      @for (n of varOptions(f.varSource); track n) { <option [value]="n"></option> }
                    </datalist>
                  }
                  @for (item of sl[f.key]; track $index) {
                    <div class="lrow"><input [attr.list]="f.varSource ? (f.key + '-sl-dl') : null" [ngModel]="sl[f.key][$index]" (ngModelChange)="sl[f.key][$index] = $event; syncSl(f.key)" />
                      <button class="x" (click)="rmSl(f.key, $index)" aria-label="Remove"><app-icon name="close" [size]="13" /></button></div>
                  }
                  <button class="add" (click)="addSl(f.key)">+ add</button>
                </div>
              }
              @case ('keyval') {
                <div class="list">
                  @if (f.keySource) {
                    <datalist [id]="f.key + '-k-dl'">
                      @for (n of varOptions(f.keySource); track n) { <option [value]="n"></option> }
                    </datalist>
                  }
                  @if (f.valueSource) {
                    <datalist [id]="f.key + '-v-dl'">
                      @for (n of varOptions(f.valueSource); track n) { <option [value]="n"></option> }
                    </datalist>
                  }
                  @for (row of kv[f.key]; track $index) {
                    <div class="kvrow">
                      <input class="k" placeholder="key" [attr.list]="f.keySource ? (f.key + '-k-dl') : null" [(ngModel)]="row.k" (ngModelChange)="syncKv(f.key)" />
                      <input class="v" placeholder="value" [attr.list]="f.valueSource ? (f.key + '-v-dl') : null" [(ngModel)]="row.v" (ngModelChange)="syncKv(f.key)" />
                      <button class="x" (click)="rmKv(f.key, $index)" aria-label="Remove"><app-icon name="close" [size]="13" /></button>
                    </div>
                  }
                  <button class="add" (click)="addKv(f.key)">+ add entry</button>
                  @if (f.keySource === 'called' || f.valueSource === 'called') {
                    @if (!node?.process) { <small>Pick a process above first — this will suggest its declared variables.</small> }
                    @else if (!calledVars().length) { <small>"{{ node.process }}" declares no variables, or isn't deployed yet — typing still works.</small> }
                  }
                </div>
              }
              @case ('nodes') {
                <label class="tog all"><input type="checkbox" [ngModel]="isAll(f.key)" (ngModelChange)="toggleAll(f.key, $event)" /><span>All nodes (process-wide handler)</span></label>
                @if (!isAll(f.key)) {
                  <div class="nodesel">
                    @for (n of attachable(); track n.id) {
                      <label class="tog"><input type="checkbox" [ngModel]="isAttached(f.key, n.id)" (ngModelChange)="toggleAttach(f.key, n.id)" /><span>{{ n.name || n.id }} <em>{{ n.type }}</em></span></label>
                    }
                    @if (attachable().length === 0) { <span class="muted">No other nodes yet.</span> }
                  </div>
                }
              }
              @case ('assetRef') {
                <input [attr.list]="f.key + '-dl'" [ngModel]="val(f.key)" (ngModelChange)="set(f.key, $event)" [placeholder]="f.placeholder || ('e.g. an existing ' + (f.assetKind || 'asset') + ' name')" />
                <datalist [id]="f.key + '-dl'">
                  @for (n of assetNames(f.assetKind); track n) { <option [value]="n"></option> }
                </datalist>
                @if (assetNames(f.assetKind).length === 0) { <small>No {{ f.assetKind }} assets in this project yet — add one from the project's Assets tab, or type a name to create it there later.</small> }
              }
              @case ('processRef') {
                <input [attr.list]="f.key + '-proc-dl'" [ngModel]="val(f.key)" (ngModelChange)="set(f.key, $event)" [placeholder]="f.placeholder || 'child-workflow.process'" />
                <datalist [id]="f.key + '-proc-dl'">
                  @for (p of callableProcesses; track p.id) { <option [value]="p.id">{{ p.name }} — {{ p.workflowName }} · {{ p.environment }}</option> }
                </datalist>
                @if (callableProcesses.length === 0) { <small>No process behind an active deployment yet — deploy one (in this project or another), then it'll show up here.</small> }
                @else if (val(f.key)) {
                  @if (resolvedProcess(f.key); as rp) { <small>→ {{ rp.name }} ({{ rp.workflowName }} · {{ rp.environment }})</small> }
                  @else { <small>Not one of the currently deployed processes above — it'll fail to call until that changes (typo, or not deployed/active yet).</small> }
                }
              }
              @case ('varRef') {
                <input [attr.list]="f.key + '-var-dl'" [ngModel]="val(f.key)" (ngModelChange)="set(f.key, $event)" [placeholder]="f.placeholder || ''" />
                <datalist [id]="f.key + '-var-dl'">
                  @for (n of varOptions(f.varSource); track n) { <option [value]="n"></option> }
                </datalist>
              }
              @case ('event') {
                <select [ngModel]="eventKind(f.key)" (ngModelChange)="setKind(f, $event)">
                  @for (k of f.options; track k) { <option [value]="k">{{ k }}</option> }
                </select>
                @switch (eventKind(f.key)) {
                  @case ('signal') { <input class="mt" placeholder="Signal name" [ngModel]="val(f.key + '.signal')" (ngModelChange)="set(f.key + '.signal', $event)" /> }
                  @case ('message') {
                    <input class="mt" [attr.list]="f.key + '-msg-dl'" placeholder="Message name" [ngModel]="val(f.key + '.message')" (ngModelChange)="set(f.key + '.message', $event)" />
                    <datalist [id]="f.key + '-msg-dl'">
                      @for (n of assetNames('messages'); track n) { <option [value]="n"></option> }
                    </datalist>
                  }
                  @case ('error') {
                    <input class="mt" placeholder="Error code (blank = any)" [attr.list]="'engine-errs'" [ngModel]="errText(f.key)" (ngModelChange)="set(f.key + '.error', $event || '*')" />
                    <datalist id="engine-errs">@for (c of errorCodes; track c) { <option [value]="c"></option> }</datalist>
                    <small>Runtime codes: SCRIPT_ERROR, SERVICE_ERROR, RULE_ERROR, CALL_ERROR, RUNTIME_ERROR — or your own from an error-throw end. Blank/“*” = any.</small>
                  }
                  @case ('escalation') { <input class="mt" placeholder="Escalation code" [ngModel]="val(f.key + '.escalation')" (ngModelChange)="set(f.key + '.escalation', $event)" /> }
                  @case ('condition') {
                    <div class="cond-header">
                      <span class="cond-sub">Condition (JavaScript)</span>
                      <button type="button" class="cheat-pill" (click)="openCheatSheet.emit()" title="View JavaScript & Flow Variables Cheat Sheet">
                        <app-icon name="code" [size]="12" /> Cheat Sheet
                      </button>
                    </div>
                    <input class="mt" placeholder="Condition expression (JavaScript)" [ngModel]="val(f.key + '.condition')" (ngModelChange)="set(f.key + '.condition', $event); set(f.key + '.lang', 'js')" />
                  }
                  @case ('timer') {
                    <input class="mt" placeholder="Duration e.g. PT5M / P1D" [ngModel]="val(f.key + '.timer.duration')" (ngModelChange)="set(f.key + '.timer.duration', $event)" />
                    <input class="mt" placeholder="Cycle e.g. R/PT1H" [ngModel]="val(f.key + '.timer.cycle')" (ngModelChange)="set(f.key + '.timer.cycle', $event)" />
                    <input class="mt" placeholder="Date (ISO)" [ngModel]="val(f.key + '.timer.date')" (ngModelChange)="set(f.key + '.timer.date', $event)" />
                  }
                }
              }
            }
            @if (f.help) { <small>{{ f.help }}</small> }
          </div>
        }
      </div>
    }

    @if (hasLifecycleActions() || isActivityOrTask()) {
      <div class="sec">
        <div class="sec-h lifecycle-h">
          <span>Lifecycle Actions (On Entry / On Exit)</span>
          @if (hasLifecycleActions()) {
            <button type="button" class="clear-actions-btn" (click)="clearAllLifecycleActions()" title="Clear onEntry and onExit actions">Clear Actions</button>
          }
        </div>
        @if (hasLifecycleActions()) {
          <small class="lifecycle-note">
            These scripts execute when entering or exiting this node. If imported Java code cannot be compiled or referenced, clear these actions or replace this node.
          </small>
        }
        <div class="fld">
          <div class="lifecycle-header">
            <label>On-Entry Script</label>
            <select class="lang-select" [ngModel]="val('onEntryLang') || 'java'" (ngModelChange)="set('onEntryLang', $event)">
              <option value="java">Java</option>
              <option value="js">JavaScript</option>
            </select>
          </div>
          <textarea rows="2" class="mono" [ngModel]="val('onEntry')" (ngModelChange)="set('onEntry', $event)" placeholder="// Statements executed when entering this node"></textarea>
        </div>
        <div class="fld">
          <div class="lifecycle-header">
            <label>On-Exit Script</label>
            <select class="lang-select" [ngModel]="val('onExitLang') || 'java'" (ngModelChange)="set('onExitLang', $event)">
              <option value="java">Java</option>
              <option value="js">JavaScript</option>
            </select>
          </div>
          <textarea rows="2" class="mono" [ngModel]="val('onExit')" (ngModelChange)="set('onExit', $event)" placeholder="// Statements executed when completing this node"></textarea>
        </div>
      </div>
    }
  `,
  styles: [`
    .unsupported-box {
      border: 1px solid #fed7d7; background: #fff5f5; border-radius: 10px; padding: 14px 16px;
      margin: 10px 0 16px; display: flex; flex-direction: column; gap: 8px;
    }
    .unsupported-hdr { display: flex; align-items: center; gap: 8px; color: #9b2c2c; font-size: 13.5px; }
    .unsupported-ic { color: #dc2626; display: grid; place-items: center; }
    .unsupported-desc { font-size: 12.5px; color: #742a2a; margin: 0; line-height: 1.45; }
    .unsupported-fix { font-size: 12px; color: #9b2c2c; background: #fee2e2; border-radius: 6px; padding: 8px 10px; border: 1px dashed #fca5a5; }
    .unsupported-fix strong { color: #742a2a; }

    .sec { margin-bottom: 4px; }
    .sec-h { font-size: 12px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; margin: 14px 0 8px; padding-bottom: 5px; border-bottom: 1px solid var(--border); }
    .fld { margin-bottom: 12px; } .fld > label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 5px; }
    input, select, textarea { width: 100%; border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; font-size: 13px; font-family: inherit; }
    input:focus, select:focus, textarea:focus { outline: none; border-color: var(--primary); }
    textarea.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    .lang-pill { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; margin-bottom: 6px; padding: 3px 8px; border-radius: 6px; }
    .lang-pill.java { background: #fef3c7; color: #92400e; border: 1px solid #fcd34d; }
    .lang-pill.js { background: #f0fdf4; color: #166534; border: 1px solid #bbf7d0; }
    .pill-badge { font-weight: 700; text-transform: uppercase; }
    .cheat-pill { margin-left: auto; display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--border); background: var(--surface-2, rgba(255,255,255,0.06)); border-radius: 6px; padding: 2px 8px; font-size: 11px; font-weight: 600; color: var(--primary); cursor: pointer; transition: all 0.15s ease; }
    .cheat-pill:hover { background: var(--primary-50, rgba(99,102,241,0.15)); border-color: var(--primary); }
    .cond-header { display: flex; align-items: center; justify-content: space-between; margin-top: 6px; margin-bottom: 2px; }
    .cond-sub { font-size: 11.5px; color: var(--text-secondary); }
    .pill-note { opacity: 0.85; font-size: 11px; }
    .mt { margin-top: 6px; }
    small { display: block; color: var(--muted); font-size: 12px; margin-top: 4px; line-height: 1.4; }
    .tog { display: flex; align-items: center; gap: 8px; } .tog input { width: auto; } .tog span { font-size: 13px; }
    .list { display: flex; flex-direction: column; gap: 6px; }
    .lrow, .kvrow { display: flex; gap: 6px; } .kvrow .k { flex: 0 0 40%; } .kvrow .v { flex: 1; }
    .x { flex: 0 0 auto; width: 30px; border: 1px solid var(--border); background: var(--surface); border-radius: 8px; cursor: pointer; color: var(--muted); }
    .x:hover { background: var(--red-bg); color: var(--red); border-color: var(--border-strong); }
    .add { align-self: flex-start; border: 1px dashed var(--border); background: var(--surface); border-radius: 8px; padding: 5px 10px; font-size: 12px; cursor: pointer; color: var(--muted); }
    .add:hover { border-color: var(--primary); color: var(--primary); }
    .all { padding: 8px 10px; background: var(--primary-50); border-radius: 8px; margin-bottom: 8px; }
    .nodesel { display: flex; flex-direction: column; gap: 5px; max-height: 200px; overflow: auto; border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; }
    .nodesel em { color: var(--muted); font-style: normal; font-size: 12px; }
    .lifecycle-h { display: flex; align-items: center; justify-content: space-between; }
    .clear-actions-btn { font-size: 11px; padding: 2px 7px; border: 1px solid var(--border); background: var(--surface-2); color: #ef4444; border-radius: 5px; cursor: pointer; }
    .clear-actions-btn:hover { background: rgba(239,68,68,0.1); border-color: #ef4444; }
    .lifecycle-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
    .lifecycle-header label { margin-bottom: 0; }
    .lang-select { width: auto; font-size: 11px; padding: 2px 6px; }
    .lifecycle-note { color: var(--muted); margin-bottom: 8px; font-size: 11.5px; }
  `],
})
export class PropertiesPanelComponent implements OnChanges {
  @Input() node: any;
  @Input() allNodes: { id: string; type: string; name?: string }[] = [];
  @Input() sections: Section[] = [];   // property form for this node type, served by the backend catalog
  /** The project's real assets by kind — backs every 'assetRef' field's autocomplete suggestions (and
   *  the 'event' widget's message sub-field), so linking a node to a Form/Ruleset/Decision/etc. is a
   *  pick from what actually exists rather than blind free text. */
  @Input() assets: Record<string, { name: string; usedBy: number }[]> = {};
  /** This process's own declared variables — backs 'own'/'ownRef' suggestions everywhere (a call
   *  activity's own-side of an input/output mapping, an http body $var, a correlationKey, etc). */
  @Input() ownVars: { name: string; type?: string }[] = [];
  /** Every process behind a currently-active deployment, tenant-wide — backs the 'processRef' widget
   *  (see server's /catalog/processes) and, once one is picked on THIS node, the 'called' source. */
  @Input() callableProcesses: CallableProcess[] = [];
  @Input() cheatSheetContent?: string;
  @Input() javaReferenceContent?: string;
  @Output() changed = new EventEmitter<void>();
  @Output() openCheatSheet = new EventEmitter<string>();
  kv: Record<string, { k: string; v: string }[]> = {};
  sl: Record<string, string[]> = {};
  errorCodes = ['SCRIPT_ERROR', 'SERVICE_ERROR', 'RULE_ERROR', 'CALL_ERROR', 'RUNTIME_ERROR'];

  hasLifecycleActions(): boolean {
    return !!(this.node?.onEntry || this.node?.onExit);
  }

  isActivityOrTask(): boolean {
    return this.node && ['userTask', 'manual', 'rule', 'call', 'send', 'receive', 'forEach', 'workItem', 'subprocess'].includes(this.node.type);
  }

  clearAllLifecycleActions() {
    if (!this.node) return;
    delete this.node.onEntry;
    delete this.node.onEntryLang;
    delete this.node.onExit;
    delete this.node.onExitLang;
    this.changed.emit();
  }

  assetNames(kind: string | undefined): string[] { return kind ? (this.assets[kind] || []).map((a) => a.name) : []; }

  /** The specific called-process entry this node's own `process` field currently names, if any —
   *  looked up by id against `callableProcesses` (same list the 'processRef' picker offers). */
  resolvedProcess(processFieldKey: string): CallableProcess | undefined {
    const id = this.val(processFieldKey);
    return id ? this.callableProcesses.find((p) => p.id === id) : undefined;
  }
  private calledVarsFor(): { name: string; type?: string }[] { return this.resolvedProcess('process')?.vars || []; }
  calledVars(): { name: string; type?: string }[] { return this.calledVarsFor(); }
  varOptions(source: VarSource | undefined): string[] {
    if (source === 'own') return this.ownVars.map((v) => v.name);
    if (source === 'ownRef') return this.ownVars.map((v) => '$' + v.name);
    if (source === 'called') return this.calledVarsFor().map((v) => v.name);
    return [];
  }

  // nodes-to-catch selector (writes node.on as a string[]; '*' = all)
  attachable() { return (this.allNodes || []).filter((n) => n.id !== this.node?.id && n.type !== 'boundary'); }
  private onArr(path: string): string[] { const v = this.val(path); return Array.isArray(v) ? v : (v ? [v] : []); }
  isAll(path: string) { return this.onArr(path).includes('*'); }
  isAttached(path: string, id: string) { return this.onArr(path).includes(id); }
  toggleAll(path: string, on: boolean) { this.node[path.split('.')[0]] = on ? ['*'] : []; this.changed.emit(); }
  toggleAttach(path: string, id: string) {
    const key = path.split('.')[0]; const arr = this.onArr(path).filter((x) => x !== '*');
    const i = arr.indexOf(id); if (i >= 0) arr.splice(i, 1); else arr.push(id);
    this.node[key] = arr; this.changed.emit();
  }
  errText(path: string) { const e = this.val(path + '.error'); return e === '*' ? '' : e; }

  ngOnChanges() {
    this.kv = {}; this.sl = {};
    for (const sec of this.sections) for (const f of sec.fields) {
      if (f.widget === 'keyval') this.kv[f.key] = Object.entries(this.val(f.key) || {}).map(([k, v]) => ({ k, v: this.str(v) }));
      if (f.widget === 'stringlist') this.sl[f.key] = [...((this.val(f.key) as string[]) || [])];
    }
  }

  // ---- dotted-path get/set ----
  val(path: string): any { return path.split('.').reduce((c: any, p) => (c == null ? c : c[p]), this.node); }
  set(path: string, value: any) {
    const parts = path.split('.'); let cur = this.node;
    for (let i = 0; i < parts.length - 1; i++) { const p = parts[i]!; if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {}; cur = cur[p]; }
    const last = parts[parts.length - 1]!;
    if (value === '' || value === undefined) delete cur[last]; else cur[last] = value;
    this.changed.emit();
  }
  num(v: any) { const n = Number(v); return Number.isFinite(n) ? n : undefined; }
  str(v: any) { return typeof v === 'object' ? JSON.stringify(v) : String(v); }

  // ---- select (with (normal) sentinel for end.result) ----
  selVal(f: Field) { const v = this.val(f.key); if (f.key === 'result') return v || '(normal)'; return v ?? (f.options?.[0] || ''); }
  onSelect(f: Field, v: string) { if (f.key === 'result') this.set(f.key, v === '(normal)' ? undefined : v); else this.set(f.key, v); }

  // ---- event trigger widget ----
  eventKind(path: string): string {
    const o = this.val(path);
    if (!o || typeof o !== 'object') return 'none';
    for (const k of ['timer', 'signal', 'message', 'error', 'escalation', 'condition']) if (k in o) return k;
    return 'none';
  }
  setKind(f: Field, kind: string) {
    let obj: any;
    switch (kind) {
      case 'none': obj = undefined; break;
      case 'signal': obj = { signal: '' }; break;
      case 'message': obj = { message: '' }; break;
      case 'error': obj = { error: '' }; break;
      case 'escalation': obj = { escalation: '' }; break;
      case 'condition': obj = { condition: '', lang: 'js' }; break;
      case 'timer': obj = { timer: { duration: 'PT5M' } }; break;
    }
    if (obj === undefined) { const parts = f.key.split('.'); const p = parts[0]!; delete this.node[p]; this.changed.emit(); }
    else this.node[f.key] = obj, this.changed.emit();
  }

  // ---- key-value maps ----
  addKv(key: string) { (this.kv[key] ||= []).push({ k: '', v: '' }); }
  rmKv(key: string, i: number) { this.kv[key].splice(i, 1); this.syncKv(key); }
  syncKv(key: string) {
    const obj: Record<string, any> = {};
    for (const r of this.kv[key] || []) if (r.k.trim()) obj[r.k.trim()] = this.coerce(r.v);
    if (Object.keys(obj).length) this.node[key] = obj; else delete this.node[key];
    this.changed.emit();
  }
  coerce(v: string): any {
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    if (v === 'true') return true; if (v === 'false') return false;
    return v;
  }

  // ---- string lists ----
  addSl(key: string) { (this.sl[key] ||= []).push(''); }
  rmSl(key: string, i: number) { this.sl[key].splice(i, 1); this.syncSl(key); }
  syncSl(key: string) {
    const arr = (this.sl[key] || []).map((s) => s.trim()).filter(Boolean);
    if (arr.length) this.node[key] = arr; else delete this.node[key];
    this.changed.emit();
  }
}
