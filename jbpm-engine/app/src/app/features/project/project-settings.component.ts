import { Component, inject, signal, effect } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ProjectContextService } from './project-context.service';
import { IconComponent } from '../../shared/icon.component';

@Component({
  selector: 'app-project-settings',
  standalone: true,
  imports: [IconComponent, FormsModule],
  template: `
    <h3 class="sec-h">General</h3>
    <div class="setrow"><label>Key</label><input [value]="ctx.wf()?.key" disabled /></div>
    <div class="setrow"><label>Description</label><input [(ngModel)]="ctx.description" (blur)="ctx.saveName()" placeholder="What this project does" /></div>
    <div class="setrow">
      <label>Instance creation mode</label>
      <div class="creation-box">
        <div class="mode-select-row">
          <select [ngModel]="ctx.instanceCreationMode" (ngModelChange)="setCreationMode($event)">
            <option value="">Inherit System Default</option>
            <option value="both">Both (Process &amp; Case Instances)</option>
            <option value="process-only">Process Instances Only</option>
            <option value="case-only">Case Instances Only</option>
            <option value="none">None (Creation Disabled)</option>
          </select>
        </div>

        <div class="switches-grid">
          <div class="switch-item">
            <div class="switch-text">
              <span class="switch-name">Enable Process Creation</span>
              <span class="switch-sub">Start BPMN workflow instances from this project</span>
            </div>
            <button type="button" class="switch" [class.on]="canCreateProcess()" role="switch" [attr.aria-checked]="canCreateProcess()" (click)="toggleProcessSwitch()"></button>
          </div>

          <div class="switch-item">
            <div class="switch-text">
              <span class="switch-name">Enable Case Creation</span>
              <span class="switch-sub">Start dynamic case instances from this project</span>
            </div>
            <button type="button" class="switch" [class.on]="canCreateCase()" role="switch" [attr.aria-checked]="canCreateCase()" (click)="toggleCaseSwitch()"></button>
          </div>
        </div>

        @if (ctx.instanceCreationMode === '') {
          <div class="inherit-note">
            <app-icon name="info" [size]="13" /> Inheriting system default. Toggle switches or select an option to customize.
          </div>
        }
      </div>
      <small>Controls whether users can start process instances, case instances, both, or none within this project.</small>
    </div>
    <div class="setrow"><label>Integration base URL</label><input [(ngModel)]="ctx.baseUrl" placeholder="https://api.yourdomain.com" /><small>Applied per deployment environment for service tasks.</small></div>

    <!-- ENVIRONMENT VARIABLES SECTION -->
    <h3 class="sec-h">Environment Variables (env)</h3>
    <p class="hint">
      Arbitrary project-level environment variables deployed to all environments.
      Accessible at runtime via <code>env.KEY</code>, <code>System.getenv("KEY")</code>,
      <code>System.getProperty("KEY")</code>, and in Java via
      <code>kcontext.getKieRuntime().getEnvironment().get("KEY")</code>.
    </p>

    @if (ctx.envList().length === 0) {
      <div class="empty-state">
        <div class="es-icon"><app-icon name="settings" [size]="24" /></div>
        <h3>No environment variables yet</h3>
        <p>Add key-value variables below (e.g. <code>INTEGRATION_LAYER_URL</code>, <code>API_KEY</code>).</p>
      </div>
    } @else {
      @for (e of ctx.envList(); track $index) {
        <div class="vrow">
          <input placeholder="KEY (e.g. INTEGRATION_LAYER_URL)" [(ngModel)]="e.key" class="env-key" />
          <input placeholder="VALUE" [(ngModel)]="e.value" class="env-val" />
          <button class="x" (click)="ctx.rmEnvVar($index)" aria-label="Remove variable"><app-icon name="close" [size]="13" /></button>
        </div>
      }
    }
    <div class="row">
      <button class="add" (click)="ctx.addEnvVar()">+ add environment variable</button>
      @if (ctx.envList().length) { <button class="btn primary" (click)="ctx.saveEnv()">Save environment variables</button> }
    </div>

    <!-- PROJECT GLOBAL ERROR HANDLER SECTION -->
    <h3 class="sec-h">Project Global Error Handlers (by Error Type)</h3>
    <p class="hint">
      Configures project-level global error routing. In standard BPMN, business processes remain clean on canvas
      without artificial error nodes. Local boundary error events on tasks <strong>always execute first</strong>.
      Unhandled errors automatically route to the designated handler process based on their error type.
    </p>

    <div class="setrow checkrow">
      <label class="toggle-lbl">
        <input type="checkbox" [checked]="ctx.globalErrorHandler().enabled" (change)="toggleGlobalHandler($event)" />
        <span>Enable Project Global Error Handling</span>
      </label>
      <small>When enabled, unhandled process errors route to their matching handler process below.</small>
    </div>

    @if (ctx.globalErrorHandler().enabled) {
      @if (ruleList().length === 0) {
        <div class="empty-state">
          <div class="es-icon"><app-icon name="alert-triangle" [size]="24" /></div>
          <h3>No error handler rules configured yet</h3>
          <p>Add a rule below to route specific error types (e.g. REST/HTTP 5xx, Script crashes, or * for default) to dedicated error processes.</p>
        </div>
      } @else {
        <div class="rules-container">
          @for (r of ruleList(); track r.id; let idx = $index) {
            <div class="rule-card">
              <div class="rule-header">
                <span class="rule-badge">Rule #{{ idx + 1 }}</span>
                <span class="rule-title">{{ getRuleSummary(r) }}</span>
                <button class="x" (click)="rmRule(idx)" title="Remove this rule" aria-label="Remove rule">
                  <app-icon name="close" [size]="13" />
                </button>
              </div>

              <div class="rule-body">
                <div class="setrow">
                  <label>Error Type / Category</label>
                  <select [ngModel]="isStandardType(r.errorType) ? r.errorType : 'CUSTOM'" (ngModelChange)="onTypeChange(r, $event)">
                    <option value="SERVICE_ERROR">SERVICE_ERROR (REST, HTTP 5xx, WorkItem, Timeout)</option>
                    <option value="SCRIPT_ERROR">SCRIPT_ERROR (JavaScript Sandbox, Java Runtime)</option>
                    <option value="RULE_ERROR">RULE_ERROR (DMN Decision Tables, Scorecards, Rules)</option>
                    <option value="TASK_ERROR">TASK_ERROR (Human Task Deadline, Assignment Failure)</option>
                    <option value="*">* (Catch-All / Default for any unhandled exception)</option>
                    <option value="CUSTOM">Custom Error Code / HTTP Status...</option>
                  </select>
                  @if (!isStandardType(r.errorType)) {
                    <input style="margin-top: 4px;" placeholder="e.g. 503, 500, or PAYMENT_GATEWAY_TIMEOUT" [(ngModel)]="r.errorType" />
                  }
                  <small>The category or exact code of error to intercept.</small>
                </div>

                <div class="setrow">
                  <label>Handler Process</label>
                  <select [(ngModel)]="r.processId">
                    <option value="">-- Select error handler process --</option>
                    @for (p of ctx.processes(); track p.id) {
                      <option [value]="p.id">{{ p.name }} ({{ p.id }})</option>
                    }
                  </select>
                  <small>The standalone BPMN process in this project that handles this error.</small>
                </div>

                <div class="setrow">
                  <label>Resolution Strategy</label>
                  <select [(ngModel)]="r.strategy">
                    <option value="repair-and-resume">Repair and Resume (Apply output mappings & continue/retry)</option>
                    <option value="compensate-and-abort">Compensate and Abort (Run cleanup & abort instance)</option>
                    <option value="spawn">Spawn Incident Process (Fire-and-forget notification flow)</option>
                  </select>
                </div>

                @if (r.strategy === 'repair-and-resume') {
                  <div class="setrow">
                    <div class="mapping-header">
                      <label>Output Variable Mappings (Error Process Output &rarr; Target Instance Var)</label>
                      <button class="btn-link" (click)="addRuleMapping(r)">+ add mapping</button>
                    </div>
                    @if (r.outputMappings.length === 0) {
                      <small style="font-style: italic;">No variable mappings. Repaired variables will merge directly.</small>
                    } @else {
                      @for (m of r.outputMappings; track $index; let mIdx = $index) {
                        <div class="vrow">
                          <input placeholder="Error Process Var" [(ngModel)]="m.errVar" />
                          <span class="arr">&rarr;</span>
                          <input placeholder="Target Instance Var" [(ngModel)]="m.targetVar" />
                          <button class="x" (click)="rmRuleMapping(r, mIdx)"><app-icon name="close" [size]="13" /></button>
                        </div>
                      }
                    }
                  </div>
                }
              </div>
            </div>
          }
        </div>
      }

      <div class="row" style="margin-top: 14px;">
        <button class="add" (click)="addRule()">+ add error handler for type</button>
        <button class="btn primary" (click)="saveGlobalHandler()">Save Global Error Handlers</button>
      </div>
    }

    <!-- SHARED VARIABLES SECTION -->
    <h3 class="sec-h">Shared variables</h3>
    <p class="hint">Project-shared variables. (Each process also has its own variables, edited in its canvas toolbar.)</p>
    @if (ctx.vars().length === 0) {
      <div class="empty-state">
        <div class="es-icon"><app-icon name="settings" [size]="24" /></div>
        <h3>No shared variables yet</h3>
        <p>Add one below to share it across every process in this project.</p>
      </div>
    } @else {
      @for (v of ctx.vars(); track $index) {
        <div class="vrow">
          <input placeholder="name" [(ngModel)]="v.name" />
          <select [(ngModel)]="v.type"><option>string</option><option>int</option><option>long</option><option>double</option><option>bool</option><option>date</option><option>object</option><option>list</option><option>map</option></select>
          <button class="x" (click)="ctx.rmVar($index)" aria-label="Remove variable"><app-icon name="close" [size]="13" /></button>
        </div>
      }
    }
    <div class="row">
      <button class="add" (click)="ctx.addVar()">+ add variable</button>
      @if (ctx.vars().length) { <button class="btn primary" (click)="ctx.saveVars()">Save variables</button> }
    </div>
  `,
  styles: [`
    .sec-h { font-size: 14px; margin: 0 0 14px; font-weight: 700; color: var(--text, #f1f5f9); }
    .sec-h:not(:first-child) { margin-top: 28px; padding-top: 24px; border-top: 1px solid var(--border); }
    .setrow { display: flex; flex-direction: column; gap: 5px; margin-bottom: 14px; max-width: 580px; }
    .setrow label { font-size: 12px; color: var(--muted); font-weight: 600; }
    .setrow input, .setrow select { border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; background: var(--surface); color: inherit; font: inherit; }
    .setrow small { color: var(--muted); font-size: 12px; line-height: 1.4; }
    .hint { color: var(--muted); font-size: 13px; margin: 0 0 16px; line-height: 1.4; }
    .hint code { background: rgba(255,255,255,0.06); padding: 1px 4px; border-radius: 4px; font-size: 12px; }
    .vrow { display: flex; gap: 8px; margin-bottom: 8px; max-width: 580px; align-items: center; }
    .vrow input { flex: 1; border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; background: var(--surface); color: inherit; }
    .vrow select { flex: 0 0 120px; border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; background: var(--surface); color: inherit; }
    .env-key { font-family: monospace; font-size: 13px; }
    .env-val { font-family: monospace; font-size: 13px; }
    .arr { color: var(--muted); font-weight: 700; padding: 0 4px; }
    .checkrow { flex-direction: row; align-items: flex-start; gap: 10px; }
    .toggle-lbl { display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px; font-weight: 600; color: inherit; }
    .toggle-lbl input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; }
    .x { width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--border); background: var(--surface); border-radius: 8px; cursor: pointer; color: var(--muted); }
    .x:hover { color: #f87171; border-color: #f87171; }
    .add { border: 1px dashed var(--border); background: var(--surface); border-radius: 8px; padding: 7px 12px; font-size: 13px; cursor: pointer; color: var(--muted); }
    .add:hover { color: inherit; border-color: var(--accent, #6366f1); }
    .btn.primary { background: var(--accent, #6366f1); color: #fff; border: none; border-radius: 8px; padding: 8px 14px; font-size: 13px; font-weight: 600; cursor: pointer; }
    .row { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
    .empty-state { padding: 24px; border: 1px dashed var(--border); border-radius: 12px; text-align: center; max-width: 580px; margin-bottom: 12px; background: rgba(255,255,255,0.01); }
    .empty-state h3 { font-size: 14px; margin: 8px 0 4px; }
    .empty-state p { color: var(--muted); font-size: 12px; margin: 0; }
    .rules-container { display: flex; flex-direction: column; gap: 14px; max-width: 680px; margin-bottom: 12px; }
    .rule-card { border: 1px solid var(--border); border-radius: 10px; background: rgba(255,255,255,0.02); padding: 16px; }
    .rule-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
    .rule-badge { background: var(--accent, #6366f1); color: #fff; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 6px; }
    .rule-title { font-size: 13px; font-weight: 600; color: var(--text, #f1f5f9); flex: 1; }
    .btn-link { background: none; border: none; color: var(--accent, #6366f1); font-size: 12px; font-weight: 600; cursor: pointer; padding: 0; }
    .mapping-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
    .creation-box { display: flex; flex-direction: column; gap: 10px; max-width: 580px; }
    .mode-select-row select { width: 100%; border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; background: var(--surface); color: inherit; }
    .switches-grid { display: flex; flex-direction: column; gap: 8px; background: rgba(255,255,255,0.02); border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px; }
    .switch-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .switch-text { display: flex; flex-direction: column; }
    .switch-name { font-size: 13px; font-weight: 600; color: inherit; }
    .switch-sub { font-size: 11px; color: var(--muted); }
    .switch { width: 36px; height: 20px; border-radius: 10px; background: var(--border-strong, #475569); position: relative; border: none; cursor: pointer; transition: background .15s; flex-shrink: 0; }
    .switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform .15s; box-shadow: 0 1px 3px rgba(0,0,0,0.3); }
    .switch.on { background: var(--primary, #6366f1); }
    .switch.on::after { transform: translateX(16px); }
    .inherit-note { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--muted); font-style: italic; }
  `],
})
export class ProjectSettingsComponent {
  ctx = inject(ProjectContextService);

  canCreateProcess(): boolean {
    const m = this.ctx.instanceCreationMode;
    return m === '' || m === 'both' || m === 'process-only';
  }

  canCreateCase(): boolean {
    const m = this.ctx.instanceCreationMode;
    return m === '' || m === 'both' || m === 'case-only';
  }

  toggleProcessSwitch() {
    const nextProc = !this.canCreateProcess();
    const curCase = this.canCreateCase();
    this.applySwitches(nextProc, curCase);
  }

  toggleCaseSwitch() {
    const curProc = this.canCreateProcess();
    const nextCase = !this.canCreateCase();
    this.applySwitches(curProc, nextCase);
  }

  private applySwitches(proc: boolean, cse: boolean) {
    if (proc && cse) this.ctx.instanceCreationMode = 'both';
    else if (proc && !cse) this.ctx.instanceCreationMode = 'process-only';
    else if (!proc && cse) this.ctx.instanceCreationMode = 'case-only';
    else this.ctx.instanceCreationMode = 'none';
    this.ctx.saveCreationMode();
  }

  setCreationMode(mode: 'both' | 'case-only' | 'process-only' | 'none' | '') {
    this.ctx.instanceCreationMode = mode;
    this.ctx.saveCreationMode();
  }

  ruleList = signal<{
    id: string;
    errorType: string;
    processId: string;
    strategy: 'repair-and-resume' | 'compensate-and-abort' | 'spawn';
    outputMappings: { errVar: string; targetVar: string }[];
  }[]>([]);

  private standardTypes = ['SERVICE_ERROR', 'SCRIPT_ERROR', 'RULE_ERROR', 'TASK_ERROR', '*'];

  constructor() {
    effect(() => {
      const geh = this.ctx.globalErrorHandler();
      if (geh.rules && geh.rules.length > 0) {
        this.ruleList.set(geh.rules.map((r) => ({
          id: r.id || `r_${Math.random().toString(36).slice(2, 8)}`,
          errorType: r.errorType,
          processId: r.processId,
          strategy: r.strategy || 'repair-and-resume',
          outputMappings: Object.entries(r.outputMappings || {}).map(([errVar, targetVar]) => ({ errVar, targetVar })),
        })));
      } else if (geh.processId) {
        // Migrate legacy single-process config into rule list
        this.ruleList.set([{
          id: `r_legacy`,
          errorType: (geh.filter && geh.filter[0]) || '*',
          processId: geh.processId,
          strategy: geh.strategy || 'repair-and-resume',
          outputMappings: Object.entries(geh.outputMappings || {}).map(([errVar, targetVar]) => ({ errVar, targetVar })),
        }]);
      } else {
        this.ruleList.set([]);
      }
    }, { allowSignalWrites: true });
  }

  isStandardType(t: string): boolean {
    return this.standardTypes.includes(t);
  }

  onTypeChange(r: any, val: string) {
    if (val === 'CUSTOM') {
      r.errorType = r.errorType && !this.isStandardType(r.errorType) ? r.errorType : '';
    } else {
      r.errorType = val;
    }
  }

  getRuleSummary(r: any): string {
    const proc = this.ctx.processes().find((p) => p.id === r.processId);
    const procLabel = proc ? proc.name : (r.processId ? r.processId : 'No process selected');
    const typeLabel = r.errorType || 'Custom';
    return `${typeLabel} → ${procLabel}`;
  }

  toggleGlobalHandler(event: Event) {
    const checked = (event.target as HTMLInputElement).checked;
    this.ctx.updateGlobalErrorHandler({ enabled: checked });
    if (checked && this.ruleList().length === 0) {
      this.addRule();
    }
  }

  addRule() {
    const newRule = {
      id: `rule_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      errorType: 'SERVICE_ERROR',
      processId: this.ctx.processes()[0]?.id || '',
      strategy: 'repair-and-resume' as const,
      outputMappings: [],
    };
    this.ruleList.set([...this.ruleList(), newRule]);
  }

  rmRule(idx: number) {
    const list = [...this.ruleList()];
    list.splice(idx, 1);
    this.ruleList.set(list);
  }

  addRuleMapping(r: any) {
    r.outputMappings.push({ errVar: '', targetVar: '' });
  }

  rmRuleMapping(r: any, mIdx: number) {
    r.outputMappings.splice(mIdx, 1);
  }

  saveGlobalHandler() {
    const rules = this.ruleList().map((r) => {
      const map: Record<string, string> = {};
      for (const m of r.outputMappings) {
        if (m.errVar.trim() && m.targetVar.trim()) {
          map[m.errVar.trim()] = m.targetVar.trim();
        }
      }
      return {
        id: r.id,
        errorType: r.errorType.trim() || '*',
        processId: r.processId,
        strategy: r.strategy,
        outputMappings: map,
      };
    });

    this.ctx.updateGlobalErrorHandler({
      enabled: this.ctx.globalErrorHandler().enabled,
      rules,
    });
    this.ctx.saveGlobalErrorHandler();
  }
}
