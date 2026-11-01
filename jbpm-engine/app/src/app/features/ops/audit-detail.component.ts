import { Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { JsonPipe } from '@angular/common';
import { OpsApiService } from '../../core/api/ops-api.service';
import { ToastService } from '../../shared/toast.service';
import { BreadcrumbComponent } from '../../shared/breadcrumb.component';
import { IconComponent } from '../../shared/icon.component';
import type { AuditEvent } from '../../core/models';

@Component({
  selector: 'app-audit-detail',
  standalone: true,
  imports: [IconComponent, RouterLink, JsonPipe, BreadcrumbComponent],
  template: `
    <div class="page">
      <div class="crumbwrap">
        <app-breadcrumb [crumbs]="[
          { label: 'Admin', link: ['/admin'] },
          { label: 'Audit Log', link: ['/audit'] },
          { label: event() ? 'Event ' + event()!.id.slice(-6) : 'Event' }
        ]" />
      </div>

      @if (loading()) {
        <div class="card pad">
          <div class="skeleton skeleton-line" style="width:30%"></div>
          <div class="skeleton skeleton-line" style="width:60%"></div>
          <div class="skeleton skeleton-card" style="height:240px; margin-top:16px;"></div>
        </div>
      } @else if (!event()) {
        <div class="card empty-state">
          <div class="es-icon"><app-icon name="warning" [size]="24" /></div>
          <h3>Audit event not found</h3>
          <p>The requested audit event could not be found.</p>
          <a class="btn primary" [routerLink]="['/audit']">Back to Audit Log</a>
        </div>
      } @else {
        @let e = event()!;

        <!-- HEADER BANNER -->
        <header class="detail-head card">
          <div class="head-top">
            <div class="head-title-wrap">
              <a class="back-link" [routerLink]="['/audit']" title="Back to Audit Log">
                <app-icon name="arrowLeft" [size]="16" />
              </a>
              <div class="title-col">
                <div class="title-row">
                  <span class="badge kind-badge">{{ e.kind }}</span>
                  <h1>Audit Event <code class="mono">{{ e.id }}</code></h1>
                </div>
                <div class="meta-row">
                  <span class="meta-item"><span class="lbl">Actor:</span> <b>{{ e.actor }}</b></span>
                  <span class="meta-item"><span class="lbl">Recorded:</span> {{ e.at }} ({{ ago(e.at) }})</span>
                </div>
              </div>
            </div>

            <div class="head-actions">
              <button class="btn sm" (click)="copyJson(e)">
                <app-icon name="code" [size]="12" /> Copy Event JSON
              </button>
            </div>
          </div>
        </header>

        <!-- CONTENT GRID -->
        <div class="content-grid">
          <!-- LEFT COLUMN: CONTEXT -->
          <div class="col-left">
            <div class="card sect-card">
              <div class="sect-header">
                <h3>Event Context</h3>
              </div>
              <table class="kv-table">
                <tbody>
                  <tr>
                    <td class="lbl">Action Kind</td>
                    <td><span class="badge kind-badge">{{ e.kind }}</span></td>
                  </tr>
                  <tr>
                    <td class="lbl">Actor / User</td>
                    <td><b>{{ e.actor }}</b></td>
                  </tr>
                  <tr>
                    <td class="lbl">Timestamp</td>
                    <td class="mono">{{ e.at }}</td>
                  </tr>
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
                    <td class="lbl">Task ID</td>
                    <td>
                      @if (e.taskId) {
                        <a class="ident" [routerLink]="['/tasks', e.taskId]">
                          {{ e.taskId }}
                        </a>
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                  </tr>
                  <tr>
                    <td class="lbl">Deployment ID</td>
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
                    <td class="lbl">Workflow / Project ID</td>
                    <td>
                      @if (e.workflowId) {
                        <a class="ident" [routerLink]="['/projects', e.workflowId, 'processes']">
                          {{ e.workflowId }}
                        </a>
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <!-- QUICK ACTIONS -->
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
                      <span class="sub">Open instance diagram canvas</span>
                    </div>
                    <app-icon name="arrowRight" [size]="13" />
                  </a>
                }
                @if (e.taskId) {
                  <a class="nav-btn" [routerLink]="['/tasks', e.taskId]">
                    <span class="ic-wrap"><app-icon name="tasks" [size]="14" /></span>
                    <div class="nav-txt">
                      <span class="title">Open User Task</span>
                      <span class="sub">View task status and comments</span>
                    </div>
                    <app-icon name="arrowRight" [size]="13" />
                  </a>
                }
                @if (e.deploymentId) {
                  <a class="nav-btn" [routerLink]="['/deployments', e.deploymentId]">
                    <span class="ic-wrap"><app-icon name="deployments" [size]="14" /></span>
                    <div class="nav-txt">
                      <span class="title">Open Deployment Snapshot</span>
                      <span class="sub">View frozen process container</span>
                    </div>
                    <app-icon name="arrowRight" [size]="13" />
                  </a>
                }
              </div>
            </div>
          </div>

          <!-- RIGHT COLUMN: DIFF OR DATA -->
          <div class="col-right">
            @if (diffChanges(e); as changes) {
              <div class="card sect-card">
                <div class="sect-header">
                  <h3>State Changes (Diff)</h3>
                </div>
                @for (c of changes; track c.name) {
                  <div class="diff-block">
                    <div class="diff-title">{{ c.name }}</div>
                    <div class="diff-compare">
                      <div class="diff-box before">
                        <span class="diff-lbl">BEFORE</span>
                        <pre>{{ fmt(c.from) }}</pre>
                      </div>
                      <div class="diff-box after">
                        <span class="diff-lbl">AFTER</span>
                        <pre>{{ fmt(c.to) }}</pre>
                      </div>
                    </div>
                  </div>
                }
              </div>
            }

            @if (e.data) {
              <div class="card sect-card">
                <div class="sect-header">
                  <h3>Event Payload Data</h3>
                </div>
                <pre class="json-box">{{ e.data | json }}</pre>
              </div>
            }

            <div class="card sect-card">
              <div class="sect-header">
                <h3>Raw Audit Event</h3>
              </div>
              <pre class="json-box">{{ e | json }}</pre>
            </div>
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    .page { padding: 12px 14px; max-width: 1500px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }
    .crumbwrap { margin-bottom: 2px; }

    /* HEADER BANNER */
    .detail-head { padding: 20px 24px; }
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
    .kind-badge {
      font-size: 12px;
      font-weight: 700;
      background: rgba(91, 61, 245, 0.1);
      color: var(--primary);
      border: 1px solid rgba(91, 61, 245, 0.25);
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

    .sect-card { padding: 20px; }
    .sect-header { margin-bottom: 14px; }
    .sect-header h3 { margin: 0; font-size: 14px; font-weight: 700; }

    /* CONTEXT TABLE */
    .kv-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .kv-table td { padding: 9px 0; border-bottom: 1px solid var(--border); vertical-align: middle; }
    .kv-table .lbl { width: 170px; color: var(--muted); font-weight: 500; }
    .ident { font-family: var(--font-mono); font-weight: 600; color: var(--primary); text-decoration: none; }
    .ident:hover { text-decoration: underline; }

    /* NAV LINKS */
    .nav-links { display: flex; flex-direction: column; gap: 8px; }
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
    .nav-txt { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .nav-txt .title { font-size: 13px; font-weight: 600; }
    .nav-txt .sub { font-size: 11.5px; color: var(--muted); }

    /* DIFF */
    .diff-block { margin-bottom: 14px; }
    .diff-title { font-size: 12px; font-weight: 700; text-transform: uppercase; color: var(--muted); margin-bottom: 6px; }
    .diff-compare { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .diff-box {
      padding: 10px 12px;
      border-radius: var(--radius-sm);
      border: 1px solid transparent;
      overflow-x: auto;
    }
    .diff-box pre { margin: 0; font-size: 12px; font-family: var(--font-mono); white-space: pre-wrap; }
    .diff-lbl { font-size: 10px; font-weight: 800; letter-spacing: .05em; display: block; margin-bottom: 4px; }
    .diff-box.before { background: #fef2f2; border-color: #fecaca; color: #991b1b; }
    .diff-box.after { background: #f0fdf4; border-color: #bbf7d0; color: #166534; }

    /* JSON BOX */
    .json-box {
      margin: 0;
      padding: 12px;
      background: var(--surface-soft);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      font-size: 12px;
      font-family: var(--font-mono);
      overflow-x: auto;
      max-height: 380px;
    }
  `],
})
export class AuditDetailComponent implements OnInit {
  private api = inject(OpsApiService);
  private toast = inject(ToastService);
  private route = inject(ActivatedRoute);

  eventId = signal<string>(this.route.snapshot.paramMap.get('id') || '');
  event = signal<AuditEvent | null>(null);
  loading = signal(true);

  ngOnInit() {
    this.loadEvent();
  }

  loadEvent() {
    const id = this.eventId();
    if (!id) return;
    this.loading.set(true);
    this.api.getAuditEvent(id).subscribe({
      next: (ev) => {
        this.event.set(ev);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.toast.error('Failed to load audit event');
      },
    });
  }

  diffChanges(e: AuditEvent): Array<{ name: string; from: unknown; to: unknown }> | null {
    const changes = (e.data as any)?.changes;
    if (Array.isArray(changes) && changes.every((c) => c && typeof c === 'object' && 'name' in c)) return changes;
    return null;
  }

  fmt(v: any): string {
    if (v === undefined) return '<undefined>';
    if (v === null) return '<null>';
    return typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v);
  }

  copyJson(e: AuditEvent) {
    navigator.clipboard.writeText(JSON.stringify(e, null, 2)).then(() => {
      this.toast.success('Event JSON copied to clipboard');
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
