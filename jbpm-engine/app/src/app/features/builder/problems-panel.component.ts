import { Component, EventEmitter, Input, Output, signal } from '@angular/core';
import type { Problem } from '../../core/models';
import { IconComponent } from '../../shared/icon.component';

// Collapsible problems strip (like a designer's "Problems" view). Click a problem to jump to its node.
@Component({
  selector: 'app-problems-panel',
  standalone: true,
  imports: [IconComponent],
  template: `
    <div class="problems" [class.collapsed]="collapsed()">
      <div class="ph" (click)="collapsed.set(!collapsed())">
        <span class="chev">{{ collapsed() ? '▸' : '▾' }}</span>
        <span class="lbl">Problems &amp; Validation</span>
        @if (errorCount) { <span class="pill err">{{ errorCount }} error{{ errorCount === 1 ? '' : 's' }}</span> }
        @if (warnCount) { <span class="pill warn">{{ warnCount }} warning{{ warnCount === 1 ? '' : 's' }}</span> }
        @if (!errorCount && !warnCount) { <span class="pill ok"><app-icon name="check" [size]="13" /> No problems</span> }
        <span class="spacer"></span>
        <span class="hint-toggle">{{ collapsed() ? 'Click to show issue details' : 'Click to hide' }}</span>
      </div>
      @if (!collapsed() && problems.length) {
        <div class="plist">
          @for (p of problems; track $index) {
            <div class="prow" [class.err]="p.severity === 'error'" (click)="pick.emit(p.nodeId || p.flowId || '')">
              <app-icon class="ic" [name]="p.severity === 'error' ? 'error' : 'warning'" [size]="15" />
              <div class="pcontent">
                <div class="pmain">
                  @if (p.nodeName) {
                    <span class="pnode-chip" title="Node Name"><app-icon name="puzzle" [size]="11" /> {{ p.nodeName }}</span>
                  } @else if (p.nodeId) {
                    <span class="pnode-chip mono" title="Node ID">{{ p.nodeId }}</span>
                  }
                  @if (p.flowId) {
                    <span class="pnode-chip mono" title="Sequence Flow ID">Flow: {{ p.flowId }}</span>
                  }
                  <span class="msg">{{ p.message }}</span>
                  <span class="rule">{{ p.rule }}</span>
                </div>
                @if (p.remedy) {
                  <div class="premedy">
                    <app-icon name="info" [size]="12" />
                    <span><strong>Fix:</strong> {{ p.remedy }}</span>
                  </div>
                }
              </div>
              <div class="p-actions">
                <button type="button" class="jump-pill" (click)="pick.emit(p.nodeId || p.flowId || '')">Jump to node &rarr;</button>
                @if (p.nodeId) {
                  <button type="button" class="replace-pill" (click)="$event.stopPropagation(); replace.emit(p.nodeId)" title="Replace this node with a fresh node from palette, keeping connections">
                    <app-icon name="refresh" [size]="11" /> Replace Node
                  </button>
                  @if (hasLifecycle(p)) {
                    <button type="button" class="clear-pill" (click)="$event.stopPropagation(); clearActions.emit(p.nodeId)" title="Clear unresolvable onEntry/onExit lifecycle scripts">
                      Clear Actions
                    </button>
                  }
                }
              </div>
            </div>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .problems { border-top: 1px solid var(--border); background: var(--surface); max-height: 260px; display: flex; flex-direction: column; transition: max-height .15s ease-out; }
    .problems.collapsed { max-height: 34px; }
    .ph { display: flex; align-items: center; gap: 8px; padding: 8px 14px; cursor: pointer; font-size: 13px; user-select: none; }
    .chev { color: var(--muted); width: 12px; } .lbl { font-weight: 600; }
    .pill { font-size: 12px; padding: 2px 8px; border-radius: 999px; font-weight: 600; }
    .pill.err { background: var(--red-bg); color: var(--red); } .pill.warn { background: #fef3e2; color: #b45309; } .pill.ok { background: var(--green-bg); color: var(--green); }
    .hint-toggle { font-size: 11px; color: var(--muted); }
    .plist { overflow: auto; padding-bottom: 4px; }
    .prow { display: flex; align-items: flex-start; gap: 10px; padding: 8px 14px; border-top: 1px solid var(--border); cursor: pointer; font-size: 13px; transition: background .12s; }
    .prow:hover { background: var(--surface-2); }
    .prow.err { background: rgba(239,68,68,0.02); }
    .prow.err:hover { background: rgba(239,68,68,0.06); }
    .ic { flex: 0 0 auto; margin-top: 2px; }
    .pcontent { flex: 1; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .pmain { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .pnode-chip { display: inline-flex; align-items: center; gap: 4px; background: rgba(255,255,255,0.06); border: 1px solid var(--border); padding: 1px 6px; border-radius: 5px; font-size: 11.5px; font-weight: 600; color: var(--text); }
    .pnode-chip.mono { font-family: ui-monospace, Menlo, monospace; font-size: 11px; }
    .msg { font-weight: 500; color: inherit; }
    .rule { color: var(--muted); font-size: 11.5px; font-family: ui-monospace, Menlo, monospace; background: rgba(255,255,255,0.03); padding: 1px 5px; border-radius: 4px; }
    .premedy { display: flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--primary); background: rgba(99,102,241,0.07); padding: 3px 8px; border-radius: 5px; width: fit-content; }
    .p-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; margin-top: 2px; }
    .jump-pill { font-size: 11px; font-weight: 600; color: var(--muted); border: none; background: transparent; cursor: pointer; padding: 2px 4px; }
    .jump-pill:hover { color: var(--primary); text-decoration: underline; }
    .replace-pill {
      display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 600;
      color: var(--primary); background: rgba(99, 102, 241, 0.1); border: 1px solid rgba(99, 102, 241, 0.25);
      border-radius: 5px; padding: 3px 7px; cursor: pointer; transition: all .15s ease;
    }
    .replace-pill:hover { background: var(--primary); color: #fff; }
    .clear-pill {
      display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 600;
      color: #ef4444; background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.2);
      border-radius: 5px; padding: 3px 7px; cursor: pointer; transition: all .15s ease;
    }
    .clear-pill:hover { background: #ef4444; color: #fff; }
  `],
})
export class ProblemsPanelComponent {
  @Input() problems: Problem[] = [];
  @Input() errorCount = 0;
  @Input() warnCount = 0;
  @Output() pick = new EventEmitter<string>();
  @Output() replace = new EventEmitter<string>();
  @Output() clearActions = new EventEmitter<string>();
  collapsed = signal(true);

  hasLifecycle(p: Problem): boolean {
    const m = p.message || '';
    return m.includes('onEntry') || m.includes('onExit');
  }
}
