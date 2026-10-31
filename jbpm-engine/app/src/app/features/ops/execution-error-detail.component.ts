import { Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TitleCasePipe } from '@angular/common';
import { OpsApiService } from '../../core/api/ops-api.service';
import { InstanceApiService } from '../../core/api/instance-api.service';
import { ToastService } from '../../shared/toast.service';
import { ModalService } from '../../shared/modal.service';
import { BreadcrumbComponent } from '../../shared/breadcrumb.component';
import { IconComponent } from '../../shared/icon.component';
import type { ExecutionError } from '../../core/models';

@Component({
  selector: 'app-execution-error-detail',
  standalone: true,
  imports: [IconComponent, RouterLink, BreadcrumbComponent, TitleCasePipe],
  template: `
    <div class="page">
      <div class="crumbwrap">
        <app-breadcrumb [crumbs]="[
          { label: 'Execution Errors', link: ['/errors'] },
          { label: error() ? 'Error ' + error()!.id.slice(-6) : 'Error' }
        ]" />
      </div>

      @if (loading()) {
        <div class="card pad">
          <div class="skeleton skeleton-line" style="width:30%"></div>
          <div class="skeleton skeleton-line" style="width:60%"></div>
          <div class="skeleton skeleton-card" style="height:260px; margin-top:16px;"></div>
        </div>
      } @else if (!error()) {
        <div class="card empty-state">
          <div class="es-icon"><app-icon name="warning" [size]="24" /></div>
          <h3>Execution error not found</h3>
          <p>The error could not be found or has been cleaned up by the engine.</p>
          <a class="btn primary" [routerLink]="['/errors']">Back to Execution Errors</a>
        </div>
      } @else {
        @let e = error()!;

        <!-- HEADER BANNER -->
        <header class="detail-head card">
          <div class="head-top">
            <div class="head-title-wrap">
              <a class="back-link" [routerLink]="['/errors']" title="Back to Execution Errors">
                <app-icon name="arrowLeft" [size]="16" />
              </a>
              <div class="title-col">
                <div class="title-row">
                  <h1>Error <span class="mono">{{ e.id }}</span></h1>
                  <span class="badge" [class.failed]="e.type==='process'||e.type==='task'" [class.waiting]="e.type==='job'">
                    {{ e.type | titlecase }}
                  </span>
                  <span class="badge" [class.failed]="!e.acknowledged" [class.active]="e.acknowledged">
                    {{ e.acknowledged ? '✓ Acknowledged' : 'Unacknowledged' }}
                  </span>
                  @if (e.occurrences > 1) {
                    <span class="badge occ-badge">{{ e.occurrences }} occurrences</span>
                  }
                </div>
                <div class="meta-row">
                  <span class="meta-item"><span class="lbl">Recorded:</span> {{ e.at }} ({{ ago(e.at) }})</span>
                  @if (e.acknowledged) {
                    <span class="meta-item"><span class="lbl">Acknowledged by:</span> <b>{{ e.acknowledgedBy }}</b> ({{ ago(e.acknowledgedAt!) }})</span>
                  }
                </div>
              </div>
            </div>

            <div class="head-actions">
              @if (!e.acknowledged) {
                <button class="btn primary sm" (click)="acknowledge(e)">
                  <app-icon name="check" [size]="13" /> Acknowledge Error
                </button>
              }
              @if (e.instanceId) {
                <button class="btn sm" (click)="retryNode(e)">
                  <app-icon name="refresh" [size]="13" /> Retry Failed Node
                </button>
              }
            </div>
          </div>
        </header>

        <!-- CONTENT GRID -->
        <div class="content-grid">
          <!-- LEFT COLUMN: CONTEXT & DETAILS -->
          <div class="col-left">
            <!-- CONTEXT CARD -->
            <div class="card sect-card">
              <div class="sect-header">
                <h3>Execution Context</h3>
              </div>
              <table class="kv-table">
                <tbody>
                  <tr>
                    <td class="lbl">Process Instance (PIID)</td>
                    <td>
                      @if (e.instanceId) {
                        <a class="ident" [routerLink]="['/instances', e.instanceId]">
                          {{ e.instanceId }}
                        </a>
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                  </tr>
                  <tr>
                    <td class="lbl">Process ID</td>
                    <td class="mono">{{ e.processId || '—' }}</td>
                  </tr>
                  <tr>
                    <td class="lbl">Node</td>
                    <td>
                      <span class="mono">{{ e.nodeId || '—' }}</span>
                      @if (e.nodeName) {
                        <span class="node-name-pill">"{{ e.nodeName }}"</span>
                      }
                    </td>
                  </tr>
                  <tr>
                    <td class="lbl">Node Type</td>
                    <td><span class="badge">{{ e.nodeType || '—' }}</span></td>
                  </tr>
                  <tr>
                    <td class="lbl">Deployment</td>
                    <td>
                      @if (e.deploymentId) {
                        <a class="ident" [routerLink]="['/deployments', e.deploymentId]">
                          {{ e.deploymentId }}
                        </a>
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                  </tr>
                  <tr>
                    <td class="lbl">Total Failures</td>
                    <td><b>{{ e.occurrences }}</b></td>
                  </tr>
                  @if (e.taskId) {
                    <tr>
                      <td class="lbl">Associated Task ID</td>
                      <td>
                        <a class="ident" [routerLink]="['/tasks', e.taskId]">{{ e.taskId }}</a>
                      </td>
                    </tr>
                  }
                  @if (e.jobId) {
                    <tr>
                      <td class="lbl">Associated Job ID</td>
                      <td class="mono">{{ e.jobId }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>

            <!-- QUICK ACTIONS CARD -->
            <div class="card sect-card">
              <div class="sect-header">
                <h3>Quick Navigation</h3>
              </div>
              <div class="nav-links">
                @if (e.instanceId) {
                  <a class="nav-btn" [routerLink]="['/instances', e.instanceId]" [queryParams]="{tab:'diagram'}">
                    <span class="ic-wrap"><app-icon name="projects" [size]="14" /></span>
                    <div class="nav-txt">
                      <span class="title">View in Instance Diagram</span>
                      <span class="sub">Inspect node state on the BPMN canvas</span>
                    </div>
                    <app-icon name="arrowRight" [size]="13" />
                  </a>
                  <a class="nav-btn" [routerLink]="['/instances', e.instanceId]" [queryParams]="{tab:'logs'}">
                    <span class="ic-wrap"><app-icon name="file" [size]="14" /></span>
                    <div class="nav-txt">
                      <span class="title">View Instance Logs</span>
                      <span class="sub">Chronological node transition records</span>
                    </div>
                    <app-icon name="arrowRight" [size]="13" />
                  </a>
                }
                @if (e.taskId) {
                  <a class="nav-btn" [routerLink]="['/tasks', e.taskId]">
                    <span class="ic-wrap"><app-icon name="tasks" [size]="14" /></span>
                    <div class="nav-txt">
                      <span class="title">Open User Task</span>
                      <span class="sub">Check assignment and task form</span>
                    </div>
                    <app-icon name="arrowRight" [size]="13" />
                  </a>
                }
                @if (e.deploymentId) {
                  <a class="nav-btn" [routerLink]="['/deployments', e.deploymentId]">
                    <span class="ic-wrap"><app-icon name="deployments" [size]="14" /></span>
                    <div class="nav-txt">
                      <span class="title">Open Deployment Snapshot</span>
                      <span class="sub">Inspect frozen process definition container</span>
                    </div>
                    <app-icon name="arrowRight" [size]="13" />
                  </a>
                }
              </div>
            </div>
          </div>

          <!-- RIGHT COLUMN: ERROR MESSAGE & STACK TRACE -->
          <div class="col-right">
            <div class="card sect-card">
              <div class="sect-header stack-header">
                <h3>Failure Message & Stack Trace</h3>
                <button class="btn sm" (click)="copyStack(e)">
                  <app-icon name="code" [size]="12" /> Copy Stack Trace
                </button>
              </div>

              <div class="error-msg-box">
                <div class="err-summary">
                  <app-icon name="warning" [size]="16" style="color:var(--red);" />
                  <b>{{ e.message || 'Execution error without specific message' }}</b>
                </div>
                <pre class="trace-pre">{{ e.stack || e.message || 'No stack trace captured.' }}</pre>
              </div>
            </div>

            <!-- ACKNOWLEDGEMENT POLICY CARD -->
            <div class="card sect-card">
              <div class="sect-header">
                <h3>Ownership & Resolution</h3>
              </div>
              @if (e.acknowledged) {
                <div class="ack-status-box acked">
                  <app-icon name="check" [size]="18" />
                  <div>
                    <b>Acknowledged by {{ e.acknowledgedBy }}</b>
                    <p class="muted sm" style="margin:2px 0 0 0;">Ownership claimed {{ ago(e.acknowledgedAt!) }} ({{ e.acknowledgedAt }}).</p>
                  </div>
                </div>
              } @else {
                <div class="ack-status-box unacked">
                  <app-icon name="info" [size]="18" />
                  <div>
                    <b>This error is currently unacknowledged.</b>
                    <p class="muted sm" style="margin:2px 0 0 0;">
                      Acknowledging errors registers team ownership so the work queue remains actionable.
                    </p>
                  </div>
                  <button class="btn primary sm" (click)="acknowledge(e)">Acknowledge</button>
                </div>
              }
            </div>
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    .page { padding: 24px; max-width: 1500px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }
    .crumbwrap { margin-bottom: 2px; }

    /* HEADER BANNER */
    .detail-head {
      padding: 20px 24px;
    }
    .head-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 20px;
      flex-wrap: wrap;
    }
    .head-title-wrap {
      display: flex;
      align-items: flex-start;
      gap: 16px;
    }
    .back-link {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text);
      cursor: pointer;
      transition: all .15s;
      margin-top: 2px;
    }
    .back-link:hover {
      background: var(--surface-hover);
      border-color: var(--border-strong);
    }
    .title-col {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .title-row {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .title-row h1 {
      margin: 0;
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -.02em;
    }
    .occ-badge {
      background: var(--surface-soft);
      border: 1px solid var(--border);
      color: var(--text-secondary);
      font-weight: 600;
    }
    .meta-row {
      display: flex;
      align-items: center;
      gap: 18px;
      font-size: 12.5px;
      color: var(--muted);
      flex-wrap: wrap;
    }
    .meta-item .lbl {
      color: var(--text-secondary);
      font-weight: 500;
      margin-right: 4px;
    }
    .head-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    /* CONTENT GRID */
    .content-grid {
      display: grid;
      grid-template-columns: 460px 1fr;
      gap: 16px;
      align-items: start;
    }
    @media (max-width: 1024px) {
      .content-grid { grid-template-columns: 1fr; }
    }
    .col-left, .col-right {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .sect-card {
      padding: 20px;
    }
    .sect-header {
      margin-bottom: 14px;
    }
    .sect-header h3 {
      margin: 0;
      font-size: 14px;
      font-weight: 700;
      color: var(--text);
    }
    .stack-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    /* CONTEXT TABLE */
    .kv-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .kv-table td {
      padding: 9px 0;
      border-bottom: 1px solid var(--border);
      vertical-align: middle;
    }
    .kv-table .lbl {
      width: 160px;
      color: var(--muted);
      font-weight: 500;
    }
    .node-name-pill {
      margin-left: 6px;
      font-size: 12px;
      color: var(--text-secondary);
      background: var(--surface-soft);
      padding: 1px 6px;
      border-radius: 4px;
    }
    .ident {
      font-family: var(--font-mono);
      font-weight: 600;
      color: var(--primary);
      text-decoration: none;
    }
    .ident:hover { text-decoration: underline; }

    /* NAV LINKS */
    .nav-links {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .nav-btn {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 14px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--surface);
      text-decoration: none;
      color: var(--text);
      transition: all .12s;
    }
    .nav-btn:hover {
      background: var(--surface-hover);
      border-color: var(--border-strong);
      transform: translateY(-1px);
    }
    .ic-wrap {
      width: 30px;
      height: 30px;
      border-radius: 8px;
      background: rgba(91, 61, 245, 0.08);
      color: var(--primary);
      display: grid;
      place-items: center;
      flex-shrink: 0;
    }
    .nav-txt {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    .nav-txt .title {
      font-size: 13px;
      font-weight: 600;
    }
    .nav-txt .sub {
      font-size: 11.5px;
      color: var(--muted);
    }

    /* ERROR TRACE */
    .error-msg-box {
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      overflow: hidden;
      background: #18181b;
      color: #f4f4f5;
    }
    .err-summary {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 14px;
      background: rgba(220, 38, 38, 0.12);
      border-bottom: 1px solid rgba(220, 38, 38, 0.25);
      color: #fca5a5;
      font-size: 13.5px;
    }
    .trace-pre {
      margin: 0;
      padding: 14px;
      font-size: 12px;
      font-family: var(--font-mono);
      line-height: 1.5;
      overflow-x: auto;
      max-height: 480px;
      color: #e4e4e7;
    }

    /* ACK STATUS */
    .ack-status-box {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 14px 16px;
      border-radius: var(--radius-sm);
      border: 1px solid transparent;
      font-size: 13px;
    }
    .ack-status-box.acked {
      background: #f0fdf4;
      border-color: #bbf7d0;
      color: #166534;
    }
    .ack-status-box.unacked {
      background: #fff7ed;
      border-color: #fed7aa;
      color: #9a3412;
    }
    .ack-status-box button {
      margin-left: auto;
    }
  `],
})
export class ExecutionErrorDetailComponent implements OnInit {
  private api = inject(OpsApiService);
  private instApi = inject(InstanceApiService);
  private toast = inject(ToastService);
  private modal = inject(ModalService);
  private route = inject(ActivatedRoute);

  errorId = signal<string>(this.route.snapshot.paramMap.get('id') || '');
  error = signal<ExecutionError | null>(null);
  loading = signal(true);

  ngOnInit() {
    this.loadError();
  }

  loadError() {
    const id = this.errorId();
    if (!id) return;
    this.loading.set(true);
    this.api.getError(id).subscribe({
      next: (e) => {
        this.error.set(e);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.toast.error('Failed to load error details');
      },
    });
  }

  acknowledge(e: ExecutionError) {
    this.api.acknowledgeError(e.id).subscribe({
      next: (upd) => {
        this.error.set(upd);
        this.toast.success(`Error ${e.id.slice(-6)} acknowledged`);
      },
      error: (err) => this.toast.error(err?.error?.message || 'Failed to acknowledge error'),
    });
  }

  retryNode(e: ExecutionError) {
    if (!e.instanceId || !e.nodeId) return;
    this.instApi.retryNode(e.instanceId, e.nodeId).subscribe({
      next: () => this.toast.success(`Retry triggered for node "${e.nodeName || e.nodeId}"`),
      error: (err) => this.toast.error(err?.error?.message || 'Failed to retry node'),
    });
  }

  copyStack(e: ExecutionError) {
    const text = e.stack || e.message || '';
    navigator.clipboard.writeText(text).then(() => {
      this.toast.success('Stack trace copied to clipboard');
    });
  }

  ago(iso: string) {
    if (!iso) return '—';
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }
}
