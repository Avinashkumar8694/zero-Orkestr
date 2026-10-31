import { Component, inject, computed, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs/operators';
import { FormsModule } from '@angular/forms';
import { BreadcrumbComponent } from '../../shared/breadcrumb.component';
import { ProjectContextService } from './project-context.service';
import { IconComponent } from '../../shared/icon.component';

// Persistent chrome (header + section nav) for one project. Section pages (Processes/Assets/Settings)
// render in the <router-outlet> below as real routed children — see app.routes.ts — instead of the old
// in-memory tab-switch, so each section is deep-linkable. Angular's default route reuse keeps this
// component (and ProjectContextService, provided here) alive across section navigation, so the header
// never re-fetches or flickers when switching sections.
@Component({
  selector: 'app-project-shell',
  standalone: true,
  imports: [IconComponent, FormsModule, RouterLink, RouterLinkActive, RouterOutlet, BreadcrumbComponent],
  providers: [ProjectContextService],
  template: `
    <div class="proj" [class.focus]="canvasOpen()">
      <div class="crumbwrap"><app-breadcrumb [crumbs]="crumbs()" /></div>
      <header class="phead">
        <a class="icon-btn" routerLink="/projects" title="Projects">‹</a>
        <span class="pic"><app-icon name="zap" [size]="15" /></span>
        <div class="titles">
          <input class="pname" [(ngModel)]="ctx.name" (blur)="ctx.saveName()" />
          <span class="key">{{ ctx.wf()?.key }}</span>
        </div>
        <span class="spacer"></span>
        <a class="btn" routerLink="/instances" [queryParams]="{ workflowId: ctx.id }">Instances</a>
        <a class="btn" routerLink="/deployments" [queryParams]="{ workflowId: ctx.id }">Deployments</a>
        <button class="btn" (click)="ctx.exportEngineProject()" title="Export native project for Node.js engine (JSON)">
          <app-icon name="download" [size]="14" /> Export (Node.js)
        </button>
        @if (ctx.isJbpmCompatible()) {
          <button class="btn" (click)="ctx.exportKjar()" title="Export as a jBPM kjar (BPMN 2.0 / XML / Java)">
            <app-icon name="download" [size]="14" /> Export jBPM
          </button>
        }
        <button class="btn primary" (click)="openDeployModal()" title="Deploy entire project snapshot">
          <app-icon name="deployments" [size]="14" /> Deploy Project
        </button>
      </header>

      <nav class="tabs">
        @for (t of tabs; track t.path) {
          <a [routerLink]="t.path" routerLinkActive="active">{{ t.label }}</a>
        }
      </nav>

      <div class="tabbody">
        <router-outlet />
      </div>

      @if (showDeployModal()) {
        <div class="modal-bg" (click)="closeDeployModal()">
          <div class="modal deploy-modal" (click)="$event.stopPropagation()">
            <div class="modal-h">
              <span class="modal-title"><app-icon name="deployments" [size]="16" /> Deploy Project Snapshot</span>
              <span class="spacer"></span>
              <button class="x" (click)="closeDeployModal()" aria-label="Close"><app-icon name="close" [size]="15" /></button>
            </div>
            <div class="modal-body" style="padding: 18px 20px; display: flex; flex-direction: column; gap: 14px;">
              <p class="muted sm" style="margin: 0; line-height: 1.45;">
                Deploying <strong>{{ ctx.name || ctx.id }}</strong> packages all child processes, workflows, and rule assets together as a single immutable version snapshot.
              </p>

              <div class="card" style="padding: 12px 14px; background: var(--surface-2); border: 1px solid var(--border);">
                <div style="font-size: 11px; text-transform: uppercase; font-weight: 700; color: var(--muted); margin-bottom: 8px;">
                  Processes Included in Deployment Snapshot ({{ ctx.processes().length }})
                </div>
                <div style="display: flex; flex-direction: column; gap: 6px; max-height: 160px; overflow-y: auto;">
                  @for (p of ctx.processes(); track p.id) {
                    <div style="display: flex; justify-content: space-between; align-items: center; font-size: 12.5px; padding: 5px 0; border-bottom: 1px dashed var(--border);">
                      <span class="bold">{{ p.name }}</span>
                      <span class="mono sm muted">{{ p.nodes }} nodes · {{ p.flows }} flows</span>
                    </div>
                  }
                </div>
              </div>

              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                <label class="fld">
                  <span style="font-size: 12px; font-weight: 600; color: var(--text); margin-bottom: 4px; display: block;">Target Environment</span>
                  <select [(ngModel)]="deployEnv" style="width: 100%; padding: 7px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); color: var(--text);">
                    <option value="prod">Production (prod)</option>
                    <option value="staging">Staging (staging)</option>
                    <option value="dev">Development (dev)</option>
                  </select>
                </label>

                <label class="fld">
                  <span style="font-size: 12px; font-weight: 600; color: var(--text); margin-bottom: 4px; display: block;">Version Label (Optional)</span>
                  <input [(ngModel)]="deployLabel" placeholder="e.g. v1.0.0 or Release" style="width: 100%; padding: 7px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); color: var(--text);" />
                </label>
              </div>

              <label style="display: flex; align-items: center; gap: 8px; font-size: 12.5px; cursor: pointer; user-select: none;">
                <input type="checkbox" [(ngModel)]="deployActivate" />
                <span>Activate deployment immediately in <b>{{ deployEnv }}</b></span>
              </label>

              <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px;">
                <button class="btn" (click)="closeDeployModal()">Cancel</button>
                <button class="btn primary" (click)="confirmDeployProject()" [disabled]="deploying()">
                  @if (deploying()) { Deploying... } @else { <app-icon name="deployments" [size]="14" /> Deploy Project Snapshot }
                </button>
              </div>
            </div>
          </div>
        </div>
      }

      @if (ctx.exportDenial(); as denial) {
        <div class="modal-bg" (click)="ctx.closeExportDenial()">
          <div class="modal denial-modal" (click)="$event.stopPropagation()">
            <div class="modal-h denial-h">
              <span class="denial-ic"><app-icon name="error" [size]="18" /></span>
              <div class="denial-titles">
                <span class="denial-title">Export to jBPM Denied</span>
                <span class="denial-sub">Project "{{ denial.projectName }}" contains constructs unsupported by jBPM runtime</span>
              </div>
              <span class="spacer"></span>
              <button class="x" (click)="ctx.closeExportDenial()" aria-label="Close"><app-icon name="close" [size]="15" /></button>
            </div>
            <div class="modal-body denial-body">
              <div class="denial-banner">
                <p><strong>jBPM Compatibility Policy:</strong> Real jBPM / KIE runtime only supports the <strong>Java</strong> (or MVEL) dialect for script execution and standard BPMN 2.0 constructs. JavaScript code, unmodeled raw nodes, and unsupported engine features cannot be compiled or executed in jBPM.</p>
              </div>

              <div class="issues-hdr">
                <span>Incompatibility Issues ({{ denial.issues.length }})</span>
              </div>

              <div class="denial-issues-list">
                @for (issue of denial.issues; track $index) {
                  <div class="issue-card" [class.code]="issue.kind === 'unsupported_code'" [class.node]="issue.kind === 'unsupported_node'">
                    <div class="issue-head">
                      <span class="issue-badge" [class.code]="issue.kind === 'unsupported_code'" [class.node]="issue.kind === 'unsupported_node'">
                        {{ issue.kind === 'unsupported_code' ? 'Unsupported Code' : issue.kind === 'unsupported_node' ? 'Unsupported Node' : 'Unsupported Feature' }}
                      </span>
                      <span class="issue-loc">Process: <strong>{{ issue.processName || issue.processId }}</strong></span>
                      @if (issue.nodeName || issue.nodeId) {
                        <span class="issue-loc">Node: <strong>{{ issue.nodeName || issue.nodeId }}</strong></span>
                      }
                      @if (issue.flowId) {
                        <span class="issue-loc">Flow: <strong>{{ issue.flowId }}</strong></span>
                      }
                    </div>
                    <div class="issue-msg">{{ issue.message }}</div>
                    @if (issue.remedy) {
                      <div class="issue-remedy"><span class="remedy-lbl">Resolution:</span> {{ issue.remedy }}</div>
                    }
                  </div>
                }
              </div>
            </div>
            <div class="modal-footer">
              <button class="btn" (click)="ctx.closeExportDenial()">Close</button>
            </div>
          </div>
        </div>
      }

      @if (ctx.validationDenial(); as denial) {
        <div class="modal-bg" (click)="ctx.closeValidationDenial()">
          <div class="modal denial-modal" (click)="$event.stopPropagation()">
            <div class="modal-h denial-h">
              <span class="denial-ic"><app-icon name="alert-triangle" [size]="18" /></span>
              <div class="denial-titles">
                <span class="denial-title">Validation Blocker: Cannot {{ denial.action === 'build' ? 'Build' : 'Deploy' }} Project</span>
                <span class="denial-sub">Project "{{ denial.projectName }}" has {{ denial.problems.length }} validation {{ denial.problems.length === 1 ? 'error' : 'errors' }} that must be resolved</span>
              </div>
              <span class="spacer"></span>
              <button class="x" (click)="ctx.closeValidationDenial()" aria-label="Close"><app-icon name="close" [size]="15" /></button>
            </div>
            <div class="modal-body denial-body">
              <div class="denial-banner">
                <p><strong>Deployment Integrity Policy:</strong> Workflow projects cannot be compiled, versioned, or deployed with active validation errors. Review the diagnostic breakdown below and apply each recommended fix in the process designer before proceeding.</p>
              </div>

              <div class="issues-hdr">
                <span>Validation Errors ({{ denial.problems.length }})</span>
              </div>

              <div class="denial-issues-list">
                @for (p of denial.problems; track $index) {
                  <div class="issue-card code">
                    <div class="issue-head">
                      <span class="issue-badge code">{{ p.rule }}</span>
                      @if (p.processName || p.processId) {
                        <span class="issue-loc">Process: <strong>{{ p.processName || p.processId }}</strong></span>
                      }
                      @if (p.nodeName || p.nodeId) {
                        <span class="issue-loc">Node: <strong>{{ p.nodeName || p.nodeId }}</strong></span>
                      }
                      @if (p.flowId) {
                        <span class="issue-loc">Sequence Flow: <strong>{{ p.flowId }}</strong></span>
                      }
                    </div>
                    <div class="issue-msg">{{ p.message }}</div>
                    @if (p.remedy) {
                      <div class="issue-remedy"><span class="remedy-lbl">Resolution Fix:</span> {{ p.remedy }}</div>
                    }
                  </div>
                }
              </div>
            </div>
            <div class="modal-footer">
              <button class="btn" (click)="ctx.closeValidationDenial()">Dismiss</button>
            </div>
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    .proj { padding: 0; height: 100%; display: flex; flex-direction: column; min-height: 0; }
    .crumbwrap { padding: 4px 22px 0; }
    /* Editing a process: the canvas needs the room, so the project chrome shrinks to one slim row (actions live on the other project tabs). */
    .proj.focus .crumbwrap, .proj.focus .phead .btn { display: none; }
    .proj.focus .phead { padding: 6px 14px; margin-top: 0; }
    .phead { display: flex; align-items: center; gap: 10px; padding: 12px 18px; margin: 10px 22px 6px; background: var(--surface); border-radius: var(--radius); box-shadow: var(--shadow-card); flex-wrap: wrap; }
    .icon-btn { width: 30px; height: 30px; display: grid; place-items: center; border-radius: 50%; border: 0; background: var(--surface-3); color: var(--muted); }
    .pic { width: 34px; height: 34px; display: grid; place-items: center; background: var(--grad-brand); color: #fff; border-radius: 12px; font-size: 17px; }
    .titles { display: flex; align-items: center; gap: 10px; }
    .pname { border: 1px solid transparent; background: transparent; border-radius: var(--radius-pill); padding: 6px 12px; font-size: 17px; font-weight: 800; width: 240px; }
    .pname:hover { background: var(--surface-3); } .pname:focus { border-color: var(--primary); outline: none; }
    .key { font-size: 12px; color: var(--muted); background: var(--surface-2); padding: 3px 8px; border-radius: 999px; }

    .tabbody { padding: 22px; flex: 1; min-height: 0; overflow-y: auto; }
    .modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: grid; place-items: center; z-index: 100; backdrop-filter: blur(2px); }
    .modal.denial-modal { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; width: 680px; max-width: 92vw; max-height: 88vh; display: flex; flex-direction: column; box-shadow: var(--shadow-pop); }
    .modal-h.denial-h { display: flex; align-items: center; gap: 12px; padding: 16px 20px; border-bottom: 1px solid var(--border); }
    .denial-ic { width: 36px; height: 36px; border-radius: 10px; background: var(--red-bg); color: var(--red); display: grid; place-items: center; flex-shrink: 0; }
    .denial-titles { display: flex; flex-direction: column; gap: 2px; }
    .denial-title { font-weight: 700; font-size: 16px; color: var(--text); }
    .denial-sub { font-size: 12.5px; color: var(--muted); }
    .modal-h .x { border: none; background: transparent; font-size: 16px; cursor: pointer; color: var(--muted); padding: 4px; border-radius: 6px; }
    .modal-h .x:hover { background: var(--surface-2); color: var(--text); }
    .modal-body.denial-body { padding: 18px 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; }
    .denial-banner { background: var(--red-bg); border: 1px solid transparent; border-radius: 8px; padding: 12px 14px; font-size: 12.5px; color: var(--red); line-height: 1.45; }
    .denial-banner strong { color: var(--red); }
    .issues-hdr { font-size: 13px; font-weight: 700; color: var(--text); display: flex; align-items: center; justify-content: space-between; margin-top: 4px; }
    .denial-issues-list { display: flex; flex-direction: column; gap: 10px; }
    .issue-card { border: 1px solid var(--border); border-radius: 9px; padding: 12px 14px; background: var(--surface-2); display: flex; flex-direction: column; gap: 6px; border-left: 4px solid var(--border-strong); }
    .issue-card.code { border-left-color: #ef4444; }
    .issue-card.node { border-left-color: #f59e0b; }
    .issue-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px; }
    .issue-badge { padding: 2px 7px; border-radius: 999px; font-size: 10.5px; font-weight: 700; text-transform: uppercase; background: #f1f2f6; color: var(--muted); }
    .issue-badge.code { background: var(--red-bg); color: var(--red); }
    .issue-badge.node { background: #fef3c7; color: #b45309; }
    .issue-loc { color: var(--muted); }
    .issue-loc strong { color: var(--text); }
    .issue-msg { font-size: 13px; font-weight: 600; color: var(--text); line-height: 1.4; }
    .issue-remedy { font-size: 12px; color: var(--muted); background: var(--surface); padding: 6px 10px; border-radius: 6px; border: 1px dashed var(--border); }
    .remedy-lbl { font-weight: 600; color: var(--text-secondary); }
    .modal.deploy-modal { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; width: 560px; max-width: 92vw; max-height: 88vh; display: flex; flex-direction: column; box-shadow: var(--shadow-pop); }
    .modal-title { font-size: 15px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
    .modal-footer { padding: 12px 20px; border-top: 1px solid var(--border); display: flex; justify-content: flex-end; background: var(--surface); border-radius: 0 0 14px 14px; }
      .tabs { margin: 4px 22px 6px; }
      @media (max-width: 900px) { .proj.focus .phead { display: none; } .phead { margin: 6px 12px; padding: 10px 12px; } .phead .btn { padding: 6px 12px; font-size: 12.5px; } .pname { width: 100%; min-width: 0; flex: 1; } .titles { flex: 1; min-width: 0; } .tabs { margin: 4px 12px 6px; display: flex; overflow-x: auto; flex-wrap: nowrap; } .tabbody { padding: 12px; } .crumbwrap { padding: 4px 14px 0; } }
      @media (max-width: 900px) { .phead .titles { order: 5; flex: 1 1 100%; } .phead .pname { flex: 1; width: auto; min-width: 0; } .phead .key { flex: 0 0 auto; } }
  `],
})
export class ProjectShellComponent {
  ctx = inject(ProjectContextService);
  private router = inject(Router);
  canvasOpen = toSignal(this.router.events.pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd), map((e) => /\/processes\/[^/?]+/.test(e.urlAfterRedirects))), { initialValue: /\/processes\/[^/?]+/.test(this.router.url) });
  tabs = [
    { path: 'processes', label: 'Processes' }, { path: 'assets', label: 'Assets' }, { path: 'audit', label: 'Audit Log' }, { path: 'settings', label: 'Settings' },
  ];
  crumbs = computed(() => [
    { label: 'Projects', link: ['/projects'] },
    { label: this.ctx.wf()?.name || '…' },
  ]);

  showDeployModal = signal(false);
  deployEnv = 'prod';
  deployLabel = '';
  deployActivate = true;
  deploying = signal(false);

  openDeployModal() {
    this.deployEnv = 'prod';
    this.deployLabel = '';
    this.deployActivate = true;
    this.showDeployModal.set(true);
  }

  closeDeployModal() {
    this.showDeployModal.set(false);
    this.deploying.set(false);
  }

  confirmDeployProject() {
    this.deploying.set(true);
    this.ctx.deployProject(
      {
        environment: this.deployEnv,
        versionLabel: this.deployLabel,
        activate: this.deployActivate,
      },
      () => {
        this.closeDeployModal();
      },
      () => {
        this.closeDeployModal();
      }
    );
  }
}
