import { Component, HostListener, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { SlicePipe } from '@angular/common';
import { WorkflowApiService } from '../../core/api/workflow-api.service';
import { BreadcrumbComponent, Crumb } from '../../shared/breadcrumb.component';
import { ToastService } from '../../shared/toast.service';
import { ModalService } from '../../shared/modal.service';
import type { Folder, ImportResult, Workflow, Problem } from '../../core/models';
import { IconComponent } from '../../shared/icon.component';

type Selection = 'all' | 'unfiled' | 'archived' | string;

@Component({
  selector: 'app-workflows',
  standalone: true,
  imports: [IconComponent, RouterLink, FormsModule, BreadcrumbComponent, SlicePipe],
  template: `
    <div class="page">
      <header class="hero">
        <div class="hero-top">
          <div class="hero-titles">
            <h1>Projects</h1>
            <p class="sub">Build, version, and deploy your workflow processes.</p>
          </div>
          <div class="create">
            <input class="in" placeholder="New project name" [(ngModel)]="newName" (keyup.enter)="create()" />
            <button class="btn primary lg" (click)="create()">+ Create Project</button>
            <input #imp type="file" accept="application/json,.json,.bpmn,.bpmn2,.xml,application/xml,text/xml" hidden (change)="importFile($event)" />
            <button class="btn" (click)="imp.click()" title="Import a jBPM kjar exported as JSON, or a single .bpmn file"><app-icon name="upload" [size]="14" /> Import jBPM</button>
            <input #impDeploy type="file" accept="application/json,.json,.bpmn,.bpmn2,.xml,application/xml,text/xml" hidden (change)="importAndDeployFile($event)" />
            <button class="btn" (click)="impDeploy.click()" title="Import a kjar or single .bpmn file and deploy it immediately"><app-icon name="deployments" [size]="14" /> Import &amp; Deploy</button>
          </div>
        </div>

        <div class="filters">
          <button class="chip" [class.on]="selected() === 'all'" (click)="select('all')">All Projects <span class="ct">{{ workflows().length }}</span></button>
          <button class="chip" [class.on]="selected() === 'unfiled'" (click)="select('unfiled')">Unfiled <span class="ct">{{ unfiledCount() }}</span></button>
          @for (row of flatFolders(); track row.folder.id) {
            <button class="chip" [class.on]="selected() === row.folder.id" (click)="select(row.folder.id)"><app-icon name="folder" [size]="14" /> {{ row.folder.name }} <span class="ct">{{ countFor(row.folder.id) }}</span></button>
          }
          <button class="chip" [class.on]="selected() === 'archived'" (click)="select('archived')"><app-icon name="trash" [size]="14" /> Archived <span class="ct">{{ archivedWorkflows().length }}</span></button>
          <span class="spacer"></span>
          <input class="in sm" placeholder="+ New folder" [(ngModel)]="newFolderName" (keyup.enter)="createFolder()" />
        </div>
      </header>

      <div class="main">
        @if (selected() !== 'all') { <div class="crumbwrap"><app-breadcrumb [crumbs]="crumbs()" /></div> }

        @if (selected() === 'archived' && archivedWorkflows().length > 0) {
          <div class="archived-banner">
            <div>
              <strong>Archived Projects</strong>
              <div class="muted sm">These projects are inactive and hidden from process modeling. You can restore them or permanently purge them.</div>
            </div>
            <span class="spacer"></span>
            <button class="btn danger sm" (click)="purgeAllArchived()">
              <app-icon name="trash" [size]="14" /> Purge All Archived ({{ archivedWorkflows().length }})
            </button>
          </div>
        }

        @if (loading()) {
          <div class="grid">
            @for (_ of [1,2,3]; track $index) { <div class="card wf skeleton skeleton-card"></div> }
          </div>
        } @else if (filteredWorkflows().length === 0) {
          <div class="empty-state">
            <div class="es-icon"><app-icon name="zap" [size]="24" /></div>
            <h3>{{ selected() === 'archived' ? 'No archived projects' : (selected() === 'all' ? 'No projects yet' : 'No projects here yet') }}</h3>
            <p>{{ selected() === 'archived' ? 'Archived projects will appear here when archived from the project menu.' : (selected() === 'all' ? 'Create your first project above, or import an existing kjar / BPMN process.' : 'Create a project above, or move an existing one into this folder.') }}</p>
          </div>
        } @else {
          <div class="grid">
            @for (w of filteredWorkflows(); track w.id) {
              <div class="card wf" [class.has-err]="w.validationSummary?.hasErrors" [class.archived-card]="selected() === 'archived'">
                <div class="wf-top">
                  @if (selected() === 'archived') {
                    <div class="wf-link archived-link">
                      <span class="ic"><app-icon name="folder" [size]="16" /></span>
                      <div class="wf-titles">
                        <div class="wf-name">{{ w.name }}</div>
                        <div class="muted key">{{ w.key }} <span class="badge archived sm">archived</span></div>
                      </div>
                    </div>
                  } @else {
                    <a class="wf-link" [routerLink]="['/projects', w.id]">
                      <span class="ic"><app-icon [name]="w.validationSummary?.hasErrors ? 'alert-triangle' : 'zap'" [size]="16" /></span>
                      <div class="wf-titles">
                        <div class="wf-name">{{ w.name }}</div>
                        <div class="muted key">{{ w.key }}</div>
                      </div>
                    </a>
                    <div class="menu-wrap">
                      <button class="kebab" (click)="toggleMenu(w.id, $event)" title="More actions">⋯</button>
                      @if (openMenu() === w.id) {
                        <div class="menu" (click)="$event.stopPropagation()">
                          <div class="menu-h">Move to folder</div>
                          <button class="menu-item" [class.active]="!w.folderId" (click)="pick(w, '')">(No folder)</button>
                          @for (row of flatFolders(); track row.folder.id) {
                            <button class="menu-item" [class.active]="w.folderId === row.folder.id" (click)="pick(w, row.folder.id)">{{ indent(row.depth) }}{{ row.folder.name }}</button>
                          }
                          <div class="menu-sep"></div>
                          <button class="menu-item danger" (click)="archive(w)">Archive project</button>
                        </div>
                      }
                    </div>
                  }
                </div>

                @if (selected() !== 'archived' && w.validationSummary?.hasErrors) {
                  <div class="wf-danger-indicator" role="button" tabindex="0" (click)="openProblemsModal(w, $event)" [title]="workflowProblemTooltip(w)">
                    <app-icon name="alert-triangle" [size]="12" />
                    <span>{{ w.validationSummary?.errorCount }} issue{{ (w.validationSummary?.errorCount || 0) > 1 ? 's' : '' }} (Deploy Blocked)</span>
                    <span class="wf-danger-view">Details →</span>
                  </div>
                }

                @if (w.description) { <p class="wf-desc">{{ w.description }}</p> }
                <div class="wf-footer">
                  @if (selected() === 'archived') {
                    <span class="muted upd">Archived {{ w.updatedAt | slice:0:10 }}</span>
                    <div style="display:flex; gap:8px;">
                      <button class="btn sm" (click)="restore(w)" title="Restore project"><app-icon name="refresh" [size]="12" /> Restore</button>
                      <button class="btn sm danger" (click)="purge(w)" title="Permanently delete project"><app-icon name="trash" [size]="12" /> Purge</button>
                    </div>
                  } @else {
                    <span class="muted upd">Updated {{ w.updatedAt | slice:0:10 }}</span>
                    <a class="btn sm" [class.primary]="!w.validationSummary?.hasErrors" [class.btn-danger-outline]="w.validationSummary?.hasErrors" [routerLink]="['/projects', w.id]">
                      {{ w.validationSummary?.hasErrors ? 'Fix Issues →' : 'Open →' }}
                    </a>
                  }
                </div>
              </div>
            }
          </div>
        }
      </div>

      @if (activeProblemsModal(); as modal) {
        <div class="modal-bg" (click)="closeProblemsModal()">
          <div class="modal denial-modal" (click)="$event.stopPropagation()">
            <div class="modal-h denial-h">
              <span class="denial-ic"><app-icon name="alert-triangle" [size]="18" /></span>
              <div class="denial-titles">
                <span class="denial-title">{{ modal.title }}</span>
                <span class="denial-sub">{{ modal.subtitle }}</span>
              </div>
              <span class="spacer"></span>
              <button class="x" (click)="closeProblemsModal()" aria-label="Close"><app-icon name="close" [size]="15" /></button>
            </div>
            <div class="modal-body denial-body">
              <div class="denial-banner">
                <p><strong>Deployment Integrity Policy:</strong> Projects with validation errors cannot be built or deployed to prevent runtime failures. Each issue below must be addressed in the process designer before deployment can succeed.</p>
              </div>

              <div class="issues-hdr">
                <span>Validation Issues ({{ modal.problems.length }})</span>
              </div>

              <div class="denial-issues-list">
                @for (p of modal.problems; track $index) {
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
              <button class="btn" (click)="closeProblemsModal()">Close</button>
              @if (modal.projectId) {
                <a class="btn primary" [routerLink]="['/projects', modal.projectId]" (click)="closeProblemsModal()">Open Designer to Fix →</a>
              }
            </div>
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    .page { display: flex; flex-direction: column; }
    .hero { padding: 28px 28px 0; background: transparent; border-bottom: 0; }
    .hero-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; padding-bottom: 22px; }
    .hero-titles h1 { font-size: 28px; margin: 0 0 6px; letter-spacing: -.01em; }
    .sub { margin: 0; font-size: 14px; color: var(--text-secondary); }
    .create { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
    .btn.lg { padding: 9px 18px; font-size: 13.5px; }
    .filters { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding-bottom: 16px; }
    .chip { display: flex; align-items: center; gap: 6px; border: 1px solid var(--border); background: var(--surface); border-radius: 999px; padding: 6px 14px; font-size: 13px; color: var(--text-secondary); cursor: pointer; }
    .chip:hover { border-color: var(--border-strong); color: var(--text); }
    /* Brand-tinted rather than near-black: a hard #1a1730 pill was the highest-contrast element on
       an otherwise soft page, so it read as an error/selected-row state rather than a filter. */
    .chip.on { background: var(--primary-50); border-color: var(--primary); color: var(--primary); font-weight: 600; }
    .chip .ct { font-size: 12px; opacity: .7; }
    .main { flex: 1; min-width: 0; padding: 24px 32px 32px; }
    .crumbwrap { margin-bottom: 16px; }
    .in { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px 12px; font-size: 13px; width: 240px; }
    .in.sm { width: 160px; padding: 6px 10px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
    .wf { padding: 16px; display: flex; flex-direction: column; gap: 10px; transition: box-shadow .15s, border-color .15s; }
    .wf:hover { box-shadow: var(--shadow-pop); border-color: var(--border-strong); }
    .wf-top { display: flex; align-items: flex-start; gap: 8px; }
    .wf-link { display: flex; gap: 12px; align-items: center; flex: 1; min-width: 0; }
    .wf-titles { min-width: 0; }
    .ic { width: 40px; height: 40px; flex-shrink: 0; display: grid; place-items: center; background: var(--primary-50); color: var(--primary); border-radius: 10px; font-size: 18px; }
    .wf-name { font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .key { font-size: 12px; }
    .wf-desc { margin: 0; font-size: 12.5px; color: var(--text-secondary); line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .wf-footer { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
    .upd { font-size: 12px; }
    .btn.sm { padding: 5px 11px; font-size: 12px; margin-left: auto; }
    .menu-wrap { position: relative; flex-shrink: 0; }
    .kebab { width: 28px; height: 28px; border: 1px solid transparent; background: transparent; border-radius: var(--radius-sm); cursor: pointer; color: var(--muted); font-size: 15px; line-height: 1; }
    .kebab:hover { background: var(--surface-2); border-color: var(--border); color: var(--text); }
    .menu { position: absolute; right: 0; top: 32px; width: 200px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); box-shadow: var(--shadow-pop); z-index: 20; padding: 6px; max-height: 280px; overflow-y: auto; }
    .menu-h { font-size: 12px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; padding: 6px 8px 4px; }
    .menu-item { display: block; width: 100%; text-align: left; border: none; background: transparent; padding: 7px 8px; border-radius: 6px; font-size: 13px; color: var(--text); cursor: pointer; white-space: pre; overflow: hidden; text-overflow: ellipsis; }
    .menu-item:hover { background: var(--surface-2); }
    .menu-item.active { color: var(--primary); font-weight: 600; }
    .menu-item.danger { color: var(--red); }
    .menu-item.danger:hover { background: var(--red-bg); }
    .menu-sep { height: 1px; background: var(--border); margin: 6px 4px; }
      @media (max-width: 900px) { .hero-top { flex-direction: column; align-items: stretch !important; gap: 14px; } .hero-titles { width: 100%; } .create { flex-wrap: wrap; flex-shrink: 1; width: 100%; } .create .in { flex: 1 1 100%; width: 100% !important; } .create .btn { flex: 1 1 auto; } .hero { padding-left: 16px; padding-right: 16px; } .main { padding-left: 16px; padding-right: 16px; } }

    .archived-banner {
      display: flex; align-items: center; justify-content: space-between; gap: 14px;
      padding: 12px 18px; border-radius: 10px; margin-bottom: 16px;
      background: var(--surface-2); border: 1px dashed var(--border);
    }
    .archived-card { opacity: 0.88; border-style: dashed; }
    .archived-card:hover { opacity: 1; }
    .archived-link { display: flex; align-items: center; gap: 10px; cursor: default; }

    .card.wf.has-err {
      border: 1.5px solid #ef4444 !important;
      background: rgba(239, 68, 68, 0.02);
    }
    .card.wf.has-err .ic {
      background: rgba(239, 68, 68, 0.15) !important;
      color: #ef4444;
    }
    .wf-danger-indicator {
      display: inline-flex; align-items: center; gap: 6px;
      background: rgba(239, 68, 68, 0.12); color: #ef4444;
      border: 1px solid rgba(239, 68, 68, 0.25);
      border-radius: 6px; padding: 4px 8px; font-size: 11px;
      font-weight: 700; margin: 4px 0; cursor: pointer; transition: background 0.15s, border-color 0.15s;
    }
    .wf-danger-indicator:hover {
      background: rgba(239, 68, 68, 0.22);
      border-color: rgba(239, 68, 68, 0.45);
    }
    .wf-danger-view {
      margin-left: 4px;
      font-weight: 600;
      opacity: 0.85;
      text-decoration: underline;
    }
    .btn-danger-outline {
      border: 1px solid rgba(239, 68, 68, 0.4) !important;
      color: #ef4444 !important;
      background: rgba(239, 68, 68, 0.06) !important;
    }
    .btn-danger-outline:hover {
      background: rgba(239, 68, 68, 0.15) !important;
    }

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
    .issue-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px; }
    .issue-badge { padding: 2px 7px; border-radius: 999px; font-size: 10.5px; font-weight: 700; text-transform: uppercase; background: #fee2e2; color: #dc2626; }
    .issue-loc { color: var(--muted); }
    .issue-loc strong { color: var(--text); }
    .issue-msg { font-size: 13px; font-weight: 600; color: var(--text); line-height: 1.4; }
    .issue-remedy { font-size: 12px; color: var(--muted); background: var(--surface); padding: 6px 10px; border-radius: 6px; border: 1px dashed var(--border); }
    .remedy-lbl { font-weight: 600; color: var(--text-secondary); }
    .modal-footer { padding: 12px 20px; border-top: 1px solid var(--border); display: flex; justify-content: flex-end; gap: 8px; background: var(--surface); border-radius: 0 0 14px 14px; }
  `],
})
export class WorkflowsComponent {
  private api = inject(WorkflowApiService);
  private toast = inject(ToastService);
  private modal = inject(ModalService);
  workflows = signal<Workflow[]>([]);
  archivedWorkflows = signal<Workflow[]>([]);
  folders = signal<Folder[]>([]);
  loading = signal(true);
  newName = '';
  newFolderName = '';
  selected = signal<Selection>('all');
  openMenu = signal<string | null>(null);
  activeProblemsModal = signal<{ title: string; subtitle?: string; problems: Problem[]; projectId?: string } | null>(null);

  openProblemsModal(w: Workflow, ev: Event) {
    ev.stopPropagation();
    ev.preventDefault();
    const problems = w.validationSummary?.problems || [];
    this.activeProblemsModal.set({
      title: `Validation Issues: ${w.name}`,
      subtitle: `Project contains ${problems.length} issue${problems.length === 1 ? '' : 's'} preventing compilation and deployment.`,
      problems,
      projectId: w.id,
    });
  }

  closeProblemsModal() {
    this.activeProblemsModal.set(null);
  }

  flatFolders = computed(() => {
    const byParent = new Map<string | null, Folder[]>();
    for (const f of this.folders()) {
      const key = f.parentId || null;
      (byParent.get(key) || byParent.set(key, []).get(key)!).push(f);
    }
    for (const list of byParent.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    const out: { folder: Folder; depth: number }[] = [];
    const walk = (parentId: string | null, depth: number) => {
      for (const f of byParent.get(parentId) || []) { out.push({ folder: f, depth }); walk(f.id, depth + 1); }
    };
    walk(null, 0);
    return out;
  });
  unfiledCount = computed(() => this.workflows().filter((w) => !w.folderId).length);
  filteredWorkflows = computed(() => {
    const sel = this.selected();
    if (sel === 'archived') return this.archivedWorkflows();
    if (sel === 'all') return this.workflows();
    if (sel === 'unfiled') return this.workflows().filter((w) => !w.folderId);
    return this.workflows().filter((w) => w.folderId === sel);
  });
  crumbs = computed<Crumb[]>(() => {
    const sel = this.selected();
    if (sel === 'all') return [{ label: 'Projects' }];
    if (sel === 'archived') return [{ label: 'Projects', onClick: () => this.select('all') }, { label: 'Archived Projects' }];
    if (sel === 'unfiled') return [{ label: 'Projects', onClick: () => this.select('all') }, { label: 'Unfiled' }];
    const byId = new Map(this.folders().map((f) => [f.id, f]));
    const chain: Folder[] = [];
    let cur = byId.get(sel);
    while (cur) { chain.unshift(cur); cur = cur.parentId ? byId.get(cur.parentId) : undefined; }
    const crumbs: Crumb[] = [{ label: 'Projects', onClick: () => this.select('all') }];
    chain.forEach((f, i) => crumbs.push(i === chain.length - 1 ? { label: f.name } : { label: f.name, onClick: () => this.select(f.id) }));
    return crumbs;
  });

  constructor() { this.reload(); this.reloadFolders(); }

  reload() {
    this.loading.set(true);
    this.api.listWorkflows().subscribe({ next: (ws) => { this.workflows.set(ws); this.loading.set(false); }, error: () => this.loading.set(false) });
    this.reloadArchived();
  }
  reloadArchived() {
    this.api.listArchivedWorkflows().subscribe({
      next: (ws) => this.archivedWorkflows.set(ws),
      error: () => {},
    });
  }
  reloadFolders() { this.api.listFolders().subscribe((fs) => this.folders.set(fs)); }
  select(s: Selection) { this.selected.set(s); }
  countFor(folderId: string) { return this.workflows().filter((w) => w.folderId === folderId).length; }
  indent(depth: number) { return ' '.repeat(depth); }

  toggleMenu(id: string, ev: Event) { ev.stopPropagation(); this.openMenu.set(this.openMenu() === id ? null : id); }
  @HostListener('document:click') closeMenuOnOutsideClick() { this.openMenu.set(null); }
  pick(w: Workflow, folderId: string) { this.moveToFolder(w, folderId); this.openMenu.set(null); }

  workflowProblemTooltip(w: Workflow): string {
    const problems = w.validationSummary?.problems || [];
    if (!problems.length) return 'Validation errors found in draft processes';
    return problems.map((p) => {
      const loc = [p.processName || p.processId, p.nodeName || p.nodeId].filter(Boolean).join(' -> ');
      const fix = p.remedy ? `\n  Fix: ${p.remedy}` : '';
      return `[${p.severity.toUpperCase()}] ${loc ? `(${loc}) ` : ''}${p.message}${fix}`;
    }).join('\n\n');
  }

  create() {
    const name = this.newName.trim();
    if (!name) return;
    const sel = this.selected();
    const folderId = sel === 'all' || sel === 'unfiled' ? undefined : sel;
    this.api.createWorkflow({ name, folderId }).subscribe(() => { this.newName = ''; this.reload(); });
  }
  createFolder() {
    const name = this.newFolderName.trim();
    if (!name) return;
    const sel = this.selected();
    const parentId = sel === 'all' || sel === 'unfiled' ? undefined : sel;
    this.api.createFolder({ name, parentId }).subscribe({
      next: () => { this.newFolderName = ''; this.reloadFolders(); },
      error: (e) => this.toast.error(e?.error?.error?.message || 'could not create folder'),
    });
  }
  moveToFolder(w: Workflow, folderId: string) {
    this.api.updateWorkflow(w.id, { folderId: folderId || null }).subscribe(() => this.reload());
  }
  async archive(w: Workflow) {
    this.openMenu.set(null);
    if (await this.modal.confirm({ title: 'Archive project', message: `Archive "${w.name}"? It will disappear from this list — deployments and instances are unaffected.`, confirmLabel: 'Archive', danger: true })) {
      this.api.archiveWorkflow(w.id).subscribe({
        next: () => { this.toast.success(`"${w.name}" archived`); this.reload(); },
        error: (e) => this.toast.error(e?.error?.error?.message || 'Could not archive project'),
      });
    }
  }

  async restore(w: Workflow) {
    this.api.restoreWorkflow(w.id).subscribe({
      next: () => {
        this.toast.success(`"${w.name}" restored`);
        this.reload();
      },
      error: (e) => this.toast.error(e?.error?.error?.message || 'Could not restore project'),
    });
  }

  async purge(w: Workflow) {
    if (await this.modal.confirm({
      title: 'Permanently purge project',
      message: `Permanently delete "${w.name}"? This cannot be undone. All project drafts, branches, and versions will be removed.`,
      confirmLabel: 'Purge Permanently',
      danger: true,
    })) {
      this.api.purgeWorkflow(w.id).subscribe({
        next: () => {
          this.toast.success(`"${w.name}" permanently purged`);
          this.reload();
        },
        error: (e) => this.toast.error(e?.error?.error?.message || 'Could not purge project'),
      });
    }
  }

  async purgeAllArchived() {
    const count = this.archivedWorkflows().length;
    if (count === 0) return;
    if (await this.modal.confirm({
      title: 'Purge all archived projects',
      message: `Permanently delete all ${count} archived project(s)? This cannot be undone.`,
      confirmLabel: `Purge ${count} Project${count > 1 ? 's' : ''}`,
      danger: true,
    })) {
      this.api.purgeAllArchivedWorkflows().subscribe({
        next: (res) => {
          this.toast.success(`Successfully purged ${res.purgedCount} archived project(s)`);
          this.reload();
        },
        error: (e) => this.toast.error(e?.error?.error?.message || 'Could not purge archived projects'),
      });
    }
  }
  /** Accepts either this app's own exported-project JSON (a {files: {relPath: content}} map, or a
   *  bare files map) OR a single raw .bpmn/.bpmn2/.xml file straight from any BPMN 2.0 authoring tool
   *  (bpmn.io, Camunda/Zeebe Modeler, a real jBPM project's .bpmn) — the engine's parser (@fabrixly/
   *  bpmn-sdk's parseBpmn, via kjarToEngine → parseProject) already reads a single .bpmn dropped in a
   *  project dir just fine, so no backend change is needed: just stop insisting the picked file be JSON. */
  private isBpmnXml(name: string, txt: string): boolean {
    // Must check the START of the content, not "contains somewhere" — a files-map JSON export embeds
    // its processes' raw BPMN XML as string values, so a substring search for e.g. "<bpmn2:definitions"
    // anywhere in the text false-positives on every multi-file kjar JSON export, misreading the whole
    // JSON blob as if it were itself one raw BPMN file (caught importing a real jBPM kjar sample).
    return /\.(bpmn2?|xml)$/i.test(name) || /^\s*(<\?xml|<[a-zA-Z0-9:]*definitions[\s>])/.test(txt);
  }
  private filesFromPicked(name: string, txt: string): Record<string, string> | undefined {
    if (this.isBpmnXml(name, txt)) return { [name]: txt };
    try { const j = JSON.parse(txt); return j.files || j; } catch { return undefined; }
  }
  /** Forms/DRL rules convert best-effort (see import/service.ts's convertAssets); anything with no
   *  automatic conversion (e.g. custom work-item definitions) is reported, not silently dropped, so a
   *  kjar with real assets never looks fully imported when part of it actually needs manual follow-up. */
  private importSummary(r: ImportResult, verb: string): string {
    const parts = [`${verb} project with ${r.processes} process(es)`];
    if (r.formsImported.length) parts.push(`${r.formsImported.length} form(s)`);
    if (r.rulesetPlaceholders.length) parts.push(`${r.rulesetPlaceholders.length} rule group(s) needing manual rule entry`);
    if (r.decisionsImported.length) parts.push(`${r.decisionsImported.length} DMN decision model(s)`);
    if (r.skipped.length) parts.push(`${r.skipped.length} file(s) skipped (unsupported)`);
    return parts.join(', ') + '.';
  }
  importFile(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0]; if (!file) return;
    file.text().then((txt) => {
      const files = this.filesFromPicked(file.name, txt);
      if (!files) { this.toast.error('Not a valid exported project JSON or .bpmn file'); return; }
      this.api.importJbpm(files, file.name.replace(/\.(json|bpmn2?|xml)$/i, '')).subscribe({
        next: (r) => { this.toast.success(this.importSummary(r, 'Imported')); this.reload(); },
        error: (e) => this.toast.error('Import failed: ' + (e?.error?.error?.message || 'invalid project')),
      });
    });
    input.value = '';
  }
  /** Same file format as "Import jBPM" above, but publishes + deploys the imported draft immediately —
   *  the project still comes out editable like any other, this just skips the manual Publish/Deploy
   *  detour, matching jBPM's own "deploy this artifact" flow. */
  async importAndDeployFile(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0]; if (!file) { return; }
    const env = await this.modal.prompt({ title: 'Import & Deploy', message: 'Environment to deploy to', initialValue: 'prod', confirmLabel: 'Import & Deploy' });
    input.value = '';
    if (env === null) return;
    const txt = await file.text();
    const files = this.filesFromPicked(file.name, txt);
    if (!files) { this.toast.error('Not a valid exported project JSON or .bpmn file'); return; }
    this.api.importAndDeployJbpm(files, file.name.replace(/\.(json|bpmn2?|xml)$/i, ''), env || 'prod').subscribe({
      next: (r) => { this.toast.success(this.importSummary(r, 'Imported') + ` Deployed to "${env || 'prod'}".`); this.reload(); },
      error: (e) => {
        const probs: Problem[] = e?.error?.error?.details || [];
        if (probs.length > 0) {
          this.activeProblemsModal.set({
            title: 'Import & Deploy Validation Failure',
            subtitle: e?.error?.error?.message || 'Imported project contains validation errors that must be resolved before deployment.',
            problems: probs,
          });
        } else {
          this.toast.error('Import & deploy failed: ' + (e?.error?.error?.message || 'invalid project'));
        }
        this.reload();
      },
    });
  }
}
