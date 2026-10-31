import { Component, computed, inject, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { ProjectContextService } from './project-context.service';
import { ProcessCanvasComponent } from '../builder/process-canvas.component';
import { IconComponent } from '../../shared/icon.component';

// The canvas needs real width — a node palette plus a diagram — so it's a dedicated full-bleed page
// (routed at processes/:pid) rather than sharing a row with the process list (see
// project-processes.component.ts, which is list-only). All the header controls that used to live in
// the workspace toolbar (Run/Validate/Build/Deploy/Variables/Auto-layout) live in this page's own
// header instead, alongside a back-to-list link.
@Component({
  selector: 'app-project-process-canvas-page',
  standalone: true,
  imports: [IconComponent, RouterLink, ProcessCanvasComponent],
  template: `
    <div class="page">
      <div class="pheader">
        <a class="back" routerLink=".." title="Back to processes"><app-icon name="chevronLeft" [size]="15" /></a>
        <div class="titles">
          <span class="pname">{{ canvas()?.processName() || processName() || '…' }}</span>
          <span class="savestate" [class.dirty]="canvas()?.saveState()==='dirty'">{{ saveLabel() }}</span>
        </div>
        <span class="divider"></span>
        <button class="btn ghost" (click)="canvas()?.openVars()">Variables ({{ canvas()?.procVars()?.length || 0 }})</button>
        <button class="icon-btn" (click)="canvas()?.autoLayout()" title="Auto-layout">▦</button>
        <span class="spacer"></span>
        <button class="btn" (click)="canvas()?.run()">▷ Run</button>
        <button class="btn" (click)="canvas()?.validate()">
          @if ((canvas()?.errorCount() ?? 0) > 0) { <app-icon name="close" [size]="14" /> Validate ({{ canvas()?.errorCount() }}) }
          @else { <app-icon name="check" [size]="14" /> Validate }
        </button>
        <button class="btn" (click)="build()"><app-icon name="build" [size]="14" /> Build</button>
        <button class="btn primary" (click)="deploy()" [disabled]="(canvas()?.errorCount() ?? 0) > 0"
                [title]="(canvas()?.errorCount() ?? 0) > 0 ? 'Fix validation errors before deploying' : 'Publish + deploy to prod'"><app-icon name="deployments" [size]="14" /> Deploy</button>
      </div>
      <div class="canvas-body">
        @if (pid(); as p) { <app-process-canvas [workflowId]="ctx.id" [processId]="p" [assets]="ctx.assets()" [focusNodeId]="nodeId()" (saved)="ctx.refreshCompatibility()" /> }
      </div>
    </div>
  `,
  styles: [`
    .page { display: flex; flex-direction: column; height: 100%; min-height: 520px; background: var(--surface); border-radius: var(--radius); box-shadow: var(--shadow-card); overflow: hidden; }
    .pheader { display: flex; align-items: center; gap: 8px; padding: 10px 16px; background: var(--surface); border-bottom: 1px solid var(--border); flex-wrap: wrap; }
    @media (max-width: 900px) { .pheader { flex-wrap: wrap; row-gap: 6px; padding: 8px 12px; } .pheader .btn { padding: 6px 12px; font-size: 12.5px; } .spacer { flex-basis: 100%; height: 0; } .page { height: calc(100vh - 150px) !important; min-height: 460px !important; border-radius: var(--radius-sm); } }
    .back { width: 30px; height: 30px; flex-shrink: 0; display: grid; place-items: center; border-radius: 50%; border: 0; background: var(--surface-3); color: var(--muted); text-decoration: none; }
    .back:hover { color: var(--text); background: var(--surface-2); }
    .titles { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .pname { font-weight: 700; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 260px; }
    .savestate { font-size: 12px; color: var(--muted); flex-shrink: 0; } .savestate.dirty { color: var(--amber); }
    .divider { width: 1px; height: 20px; background: var(--border); }
    .icon-btn { width: 30px; height: 30px; display: grid; place-items: center; border: 0; background: var(--surface-3); border-radius: 50%; cursor: pointer; color: var(--muted); font-size: 13px; }
    .icon-btn:hover { background: var(--surface-2); color: var(--text); }
    .canvas-body { flex: 1; min-height: 0; }
  `],
})
export class ProjectProcessCanvasPageComponent {
  ctx = inject(ProjectContextService);
  private route = inject(ActivatedRoute);
  canvas = viewChild(ProcessCanvasComponent);

  pid = toSignal(this.route.paramMap.pipe(map((m) => m.get('pid'))), { initialValue: this.route.snapshot.paramMap.get('pid') });
  nodeId = toSignal(this.route.queryParamMap.pipe(map((m) => m.get('nodeId'))), { initialValue: this.route.snapshot.queryParamMap.get('nodeId') });
  processName = computed(() => this.ctx.processes().find((p) => p.id === this.pid())?.name);

  saveLabel() { return ({ saved: 'Saved', saving: 'Saving…', dirty: 'Unsaved' } as const)[this.canvas()?.saveState() ?? 'saved']; }
  build() { this.canvas()?.saveNow(); setTimeout(() => this.ctx.build(), 300); }
  deploy() { this.canvas()?.saveNow(); setTimeout(() => this.ctx.deploy(), 300); }
}
