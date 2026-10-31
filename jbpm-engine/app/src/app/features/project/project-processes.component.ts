import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ProjectContextService } from './project-context.service';
import { IconComponent } from '../../shared/icon.component';

// Processes tab: a list only, same shape as the Assets tab — no canvas here. The canvas needs real
// width to be usable (a palette + a diagram), so it gets its own routed page (processes/:pid, see
// project-process-canvas-page.component.ts) that the project shell renders full-width, instead of
// permanently reserving a sidebar + toolbar next to a canvas squeezed into whatever's left.
@Component({
  selector: 'app-project-processes',
  standalone: true,
  imports: [IconComponent, FormsModule, RouterLink],
  template: `
    <p class="hint">Processes are the workflows this project runs. Open one to model it on the canvas, then Validate, Build and Deploy from there.</p>

    <div class="toolbar">
      <input class="in" placeholder="New process name" [(ngModel)]="newProc" (keyup.enter)="add()" />
      <button class="btn primary" (click)="add()"><app-icon name="plus" [size]="13" /> Add process</button>
    </div>

    @if (ctx.processes().length === 0) {
      <div class="card empty-state">
        <div class="es-icon"><app-icon name="puzzle" [size]="22" /></div>
        <h3>No processes yet</h3>
        <p>Add one above to start modeling.</p>
      </div>
    } @else {
      <div class="grid">
        @for (p of ctx.processes(); track p.id) {
          <div class="card proc" [class.has-err]="p.hasErrors">
            <div class="proc-head">
              <a class="proc-link" [routerLink]="[p.id]">
                <span class="p-ic"><app-icon [name]="p.hasErrors ? 'alert-triangle' : 'puzzle'" [size]="16" /></span>
                <div class="p-titles">
                  <div class="p-name">{{ p.name }}</div>
                  <div class="muted sm">{{ p.nodes }} nodes</div>
                </div>
              </a>
              <div class="proc-actions">
                <button class="icon-btn" (click)="ctx.renameProcess(p)" title="Rename" aria-label="Rename process"><app-icon name="edit" [size]="14" /></button>
                <button class="icon-btn danger" (click)="ctx.removeProcess(p)" title="Delete" aria-label="Delete process"><app-icon name="trash" [size]="14" /></button>
              </div>
            </div>

            <div class="proc-badges">
              @if (p.hasErrors) {
                <span class="proc-danger-badge" [title]="processProblemTooltip(p)">
                  <app-icon name="alert-triangle" [size]="12" /> {{ p.errorCount }} error{{ (p.errorCount || 0) > 1 ? 's' : '' }}
                </span>
              } @else if ((p.warningCount || 0) > 0) {
                <span class="proc-warn-badge" [title]="processProblemTooltip(p)">
                  <app-icon name="info" [size]="12" /> {{ p.warningCount }} warning{{ (p.warningCount || 0) > 1 ? 's' : '' }}
                </span>
              } @else {
                <span class="proc-valid-badge">
                  <app-icon name="check" [size]="12" /> Valid Flow
                </span>
              }
            </div>

            @if (p.hasErrors && p.problems?.length) {
              <div class="proc-err-preview" [title]="processProblemTooltip(p)">
                <div class="proc-err-title"><app-icon name="alert-triangle" [size]="12" /> Deploy / Build Blocker:</div>
                <div class="proc-err-item">{{ firstError(p) }}</div>
                @if ((p.errorCount || 0) > 1) {
                  <div class="proc-err-more">+{{ (p.errorCount || 0) - 1 }} more issue{{ (p.errorCount || 0) > 2 ? 's' : '' }}</div>
                }
              </div>
            }

            <a class="btn sm full" [class.btn-danger-outline]="p.hasErrors" [routerLink]="[p.id]">
              {{ p.hasErrors ? 'Inspect & Fix Flow →' : 'Open →' }}
            </a>
          </div>
        }
      </div>
    }
  `,
  styles: [`
    .hint { color: var(--muted); font-size: 13px; margin: 0 0 14px; max-width: 760px; line-height: 1.5; }
    .toolbar { display: flex; gap: 8px; margin-bottom: 16px; max-width: 440px; }
    .toolbar .in { flex: 1; min-width: 0; border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font-size: 13px; }
    .empty-state { padding: 40px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; }
    .proc { padding: 16px; display: flex; flex-direction: column; gap: 10px; }
    .proc-link { display: flex; align-items: center; gap: 10px; text-decoration: none; color: inherit; }
    .p-ic { width: 34px; height: 34px; flex-shrink: 0; display: grid; place-items: center; background: var(--green-bg); border-radius: 9px; }
    .p-titles { min-width: 0; } .p-name { font-weight: 700; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sm { font-size: 12px; }
    .proc-actions { display: flex; gap: 4px; margin-top: -4px; }
    .proc-head { display: flex; align-items: center; justify-content: space-between; }
    .icon-btn { width: 26px; height: 26px; display: grid; place-items: center; border: none; background: transparent; border-radius: 6px; cursor: pointer; color: var(--muted); }
    .icon-btn:hover { background: var(--surface-2); color: var(--text); }
    .icon-btn.danger:hover { background: var(--red-bg); color: var(--red); }
    .btn.sm.full { width: 100%; justify-content: center; text-align: center; }

    /* Danger & Warning Indicators */
    .proc.has-err {
      border: 1.5px solid #ef4444 !important;
      background: rgba(239, 68, 68, 0.03);
    }
    .proc.has-err .p-ic {
      background: rgba(239, 68, 68, 0.15) !important;
      color: #ef4444;
    }
    .proc-badges { display: flex; gap: 6px; flex-wrap: wrap; margin-top: -2px; }
    .proc-danger-badge {
      display: inline-flex; align-items: center; gap: 4px;
      background: rgba(239, 68, 68, 0.15); color: #ef4444;
      border: 1px solid rgba(239, 68, 68, 0.3); font-size: 11px;
      font-weight: 700; padding: 2px 7px; border-radius: 6px;
    }
    .proc-warn-badge {
      display: inline-flex; align-items: center; gap: 4px;
      background: rgba(245, 158, 11, 0.15); color: #f59e0b;
      border: 1px solid rgba(245, 158, 11, 0.3); font-size: 11px;
      font-weight: 700; padding: 2px 7px; border-radius: 6px;
    }
    .proc-valid-badge {
      display: inline-flex; align-items: center; gap: 4px;
      background: rgba(34, 197, 94, 0.12); color: #16a34a;
      border: 1px solid rgba(34, 197, 94, 0.25); font-size: 11px;
      font-weight: 600; padding: 2px 7px; border-radius: 6px;
    }
    .proc-err-preview {
      background: rgba(239, 68, 68, 0.08);
      border: 1px solid rgba(239, 68, 68, 0.2);
      border-radius: 6px; padding: 8px 10px; font-size: 11px;
    }
    .proc-err-title {
      color: #ef4444; font-weight: 700; display: flex; align-items: center; gap: 5px; margin-bottom: 3px;
    }
    .proc-err-item {
      color: var(--text, #cbd5e1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .proc-err-more {
      color: var(--muted); font-size: 10px; margin-top: 3px;
    }
    .btn-danger-outline {
      border: 1px solid rgba(239, 68, 68, 0.4) !important;
      color: #ef4444 !important;
      background: rgba(239, 68, 68, 0.06) !important;
    }
    .btn-danger-outline:hover {
      background: rgba(239, 68, 68, 0.15) !important;
    }
  `],
})
export class ProjectProcessesComponent {
  ctx = inject(ProjectContextService);
  newProc = '';

  add() {
    const n = this.newProc.trim(); if (!n) return;
    this.ctx.addProcess(n); this.newProc = '';
  }

  processProblemTooltip(p: any): string {
    if (!p.problems || !p.problems.length) return '';
    return p.problems.map((pr: any) => `[${pr.severity.toUpperCase()}] ${pr.rule}: ${pr.message}`).join('\n');
  }

  firstError(p: any): string {
    const err = p.problems?.find((pr: any) => pr.severity === 'error') || p.problems?.[0];
    return err ? `${err.rule}: ${err.message}` : 'Validation error';
  }
}
