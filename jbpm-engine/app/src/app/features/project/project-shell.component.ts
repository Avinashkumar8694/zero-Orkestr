import { Component, inject, computed } from '@angular/core';
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
      </header>

      <nav class="tabs">
        @for (t of tabs; track t.path) {
          <a [routerLink]="t.path" routerLinkActive="active">{{ t.label }}</a>
        }
      </nav>

      <div class="tabbody">
        <router-outlet />
      </div>

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
    </div>
  `,
  styles: [`
    .proj { padding: 0; height: 100%; display: flex; flex-direction: column; min-height: 0; }
    .crumbwrap { padding: 12px 22px 0; }
    /* Editing a process: the canvas needs the room, so the project chrome shrinks to one slim row (actions live on the other project tabs). */
    .proj.focus .crumbwrap, .proj.focus .phead .btn { display: none; }
    .proj.focus .phead { padding: 6px 22px; }
    .proj.focus .tabs a { padding: 8px 14px; }
    .phead { display: flex; align-items: center; gap: 10px; padding: 14px 22px; background: var(--surface); border-bottom: 1px solid var(--border); }
    .icon-btn { width: 30px; height: 30px; display: grid; place-items: center; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); color: var(--muted); }
    .pic { width: 34px; height: 34px; display: grid; place-items: center; background: var(--primary-50); color: var(--primary); border-radius: 9px; font-size: 17px; }
    .titles { display: flex; align-items: center; gap: 10px; }
    .pname { border: 1px solid transparent; border-radius: 8px; padding: 6px 8px; font-size: 17px; font-weight: 700; width: 240px; }
    .pname:hover { border-color: var(--border); } .pname:focus { border-color: var(--primary); outline: none; }
    .key { font-size: 12px; color: var(--muted); background: var(--surface-2); padding: 3px 8px; border-radius: 999px; }
    .tabs { display: flex; gap: 4px; padding: 0 22px; background: var(--surface); border-bottom: 1px solid var(--border); }
    .tabs a { border: none; background: transparent; padding: 12px 14px; font-size: 13px; font-weight: 600; color: var(--muted); cursor: pointer; border-bottom: 2px solid transparent; }
    .tabs a:hover { color: var(--text); } .tabs a.active { color: var(--primary); border-bottom-color: var(--primary); }
    .tabbody { padding: 22px; flex: 1; min-height: 0; overflow-y: auto; }

    .modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: grid; place-items: center; z-index: 100; backdrop-filter: blur(2px); }
    .modal.denial-modal { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; width: 680px; max-width: 92vw; max-height: 88vh; display: flex; flex-direction: column; box-shadow: var(--shadow-pop); }
    .modal-h.denial-h { display: flex; align-items: center; gap: 12px; padding: 16px 20px; border-bottom: 1px solid var(--border); }
    .denial-ic { width: 36px; height: 36px; border-radius: 10px; background: #fee2e2; color: #dc2626; display: grid; place-items: center; flex-shrink: 0; }
    .denial-titles { display: flex; flex-direction: column; gap: 2px; }
    .denial-title { font-weight: 700; font-size: 16px; color: var(--text); }
    .denial-sub { font-size: 12.5px; color: var(--muted); }
    .modal-h .x { border: none; background: transparent; font-size: 16px; cursor: pointer; color: var(--muted); padding: 4px; border-radius: 6px; }
    .modal-h .x:hover { background: var(--surface-2); color: var(--text); }
    .modal-body.denial-body { padding: 18px 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; }
    .denial-banner { background: #fff5f5; border: 1px solid #fed7d7; border-radius: 8px; padding: 12px 14px; font-size: 12.5px; color: #9b2c2c; line-height: 1.45; }
    .denial-banner strong { color: #742a2a; }
    .issues-hdr { font-size: 13px; font-weight: 700; color: var(--text); display: flex; align-items: center; justify-content: space-between; margin-top: 4px; }
    .denial-issues-list { display: flex; flex-direction: column; gap: 10px; }
    .issue-card { border: 1px solid var(--border); border-radius: 9px; padding: 12px 14px; background: var(--surface-2); display: flex; flex-direction: column; gap: 6px; border-left: 4px solid var(--border-strong); }
    .issue-card.code { border-left-color: #ef4444; }
    .issue-card.node { border-left-color: #f59e0b; }
    .issue-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px; }
    .issue-badge { padding: 2px 7px; border-radius: 999px; font-size: 10.5px; font-weight: 700; text-transform: uppercase; background: #f1f2f6; color: var(--muted); }
    .issue-badge.code { background: #fee2e2; color: #dc2626; }
    .issue-badge.node { background: #fef3c7; color: #b45309; }
    .issue-loc { color: var(--muted); }
    .issue-loc strong { color: var(--text); }
    .issue-msg { font-size: 13px; font-weight: 600; color: var(--text); line-height: 1.4; }
    .issue-remedy { font-size: 12px; color: var(--muted); background: var(--surface); padding: 6px 10px; border-radius: 6px; border: 1px dashed var(--border); }
    .remedy-lbl { font-weight: 600; color: var(--text-secondary); }
    .modal-footer { padding: 12px 20px; border-top: 1px solid var(--border); display: flex; justify-content: flex-end; background: var(--surface); border-radius: 0 0 14px 14px; }
  `],
})
export class ProjectShellComponent {
  ctx = inject(ProjectContextService);
  private router = inject(Router);
  canvasOpen = toSignal(this.router.events.pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd), map((e) => /\/processes\/[^/?]+/.test(e.urlAfterRedirects))), { initialValue: /\/processes\/[^/?]+/.test(this.router.url) });
  tabs = [
    { path: 'processes', label: 'Processes' }, { path: 'assets', label: 'Assets' }, { path: 'settings', label: 'Settings' },
  ];
  crumbs = computed(() => [
    { label: 'Projects', link: ['/projects'] },
    { label: this.ctx.wf()?.name || '…' },
  ]);
}
