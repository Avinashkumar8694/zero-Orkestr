import { Component, HostListener, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ProjectContextService } from './project-context.service';
import { ToastService } from '../../shared/toast.service';
import { ModalService } from '../../shared/modal.service';
import { IconComponent } from '../../shared/icon.component';
import { AssetFieldsComponent } from './asset-fields.component';
import { MarkdownViewerComponent } from '../../shared/markdown-viewer.component';
import { WorkflowApiService } from '../../core/api/workflow-api.service';

interface ExtraField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'select';
  placeholder?: string;
  options?: string[];
  default?: any;
  help?: string;
}

// Each kind's schema and initial seed fields for creation dialogs tailored to each asset kind
const EXTRA_FIELDS: Record<string, ExtraField[]> = {
  forms: [
    { key: 'model.className', label: 'Backing Data Object / Class', type: 'text', placeholder: 'com.acme.model.ClaimForm', help: 'Java FQN or type name this form binds to' },
  ],
  rulesets: [
    { key: 'package', label: 'Java Package', type: 'text', placeholder: 'com.acme.rules', default: 'com.acme.rules', help: 'Package name for generated .drl' },
    { key: 'ruleName', label: 'Initial Rule Name', type: 'text', placeholder: 'Standard Evaluation' },
    { key: 'fact', label: 'Target Fact Type', type: 'text', placeholder: 'Claim' },
  ],
  decisions: [
    { key: 'hitPolicy', label: 'Hit Policy', type: 'select', options: ['UNIQUE', 'FIRST', 'ANY', 'COLLECT'], default: 'UNIQUE', help: 'How matching rules are aggregated' },
    { key: 'inputs', label: 'Input Variables (comma-separated)', type: 'text', placeholder: 'amount, creditScore' },
    { key: 'outputs', label: 'Output Variables (comma-separated)', type: 'text', placeholder: 'approved, discount' },
  ],
  guidedTables: [
    { key: 'fact', label: 'Fact Type', type: 'text', placeholder: 'Claim', help: 'The fact type the table conditions evaluate' },
    { key: 'package', label: 'Package', type: 'text', placeholder: 'com.acme.rules', default: 'com.acme.rules' },
  ],
  decisionTrees: [
    { key: 'fact', label: 'Fact Type', type: 'text', placeholder: 'Claim' },
    { key: 'field', label: 'Root Test Field', type: 'text', placeholder: 'amount', help: 'Initial field tested at the root node' },
    { key: 'package', label: 'Package', type: 'text', placeholder: 'com.acme.rules', default: 'com.acme.rules' },
  ],
  scorecards: [
    { key: 'fact', label: 'Fact Type', type: 'text', placeholder: 'Claim' },
    { key: 'baseline', label: 'Baseline Score', type: 'number', placeholder: '100', default: 100 },
    { key: 'target', label: 'Target Score Field', type: 'text', placeholder: 'riskScore', default: 'riskScore' },
    { key: 'package', label: 'Package', type: 'text', placeholder: 'com.acme.rules', default: 'com.acme.rules' },
  ],
  enumerations: [
    { key: 'fact', label: 'Fact / Type Name', type: 'text', placeholder: 'Claim', help: 'Data type this enumeration applies to' },
    { key: 'field', label: 'Field Name', type: 'text', placeholder: 'status' },
    { key: 'values', label: 'Allowed Values (comma-separated)', type: 'text', placeholder: 'NEW, PENDING, APPROVED, REJECTED' },
  ],
  types: [
    { key: 'package', label: 'Java Package', type: 'text', placeholder: 'com.acme.model', default: 'com.acme.model', help: 'Package for generated POJO .java' },
  ],
  messages: [
    { key: 'dataType', label: 'Payload Data Type (Java FQN / Object)', type: 'text', placeholder: 'com.acme.model.Claim', default: 'Object' },
    { key: 'correlationKey', label: 'Correlation Property', type: 'text', placeholder: 'claimId', default: 'correlationId', help: 'Instance variable name used for correlation' },
    { key: 'description', label: 'Description', type: 'text', placeholder: 'Event contract for messaging' },
  ],
  tests: [
    { key: 'target', label: 'Target Asset (Decision / Ruleset / Table)', type: 'text', placeholder: 'Eligibility', help: 'Asset name to test' },
    { key: 'description', label: 'Description', type: 'text', placeholder: 'Unit test suite' },
  ],
};

export interface AssetRefInfo {
  kind: string;
  process: string;
  processId?: string;
  nodeId?: string;
  nodeName?: string;
  via: string;
}

interface AssetRow {
  kind: string;
  kindLabel: string;
  name: string;
  usedBy: number;
  refs: AssetRefInfo[];
}

/**
 * Asset library (ux_design/mockups/assets-overview.html): kind sidebar with counts + search, a list
 * table, and a detail view with the "referenced by" panel that makes deletion safe, plus a structured
 * per-kind configuration editor (AssetFieldsComponent) — one schema per kind matching exactly what its
 * runtime evaluator reads (engine/decisioning.ts) or, for forms/types, what the form renderer and SDK
 * export expect. Deliberately narrower than the mockup: this engine has no per-asset lock or version
 * history yet (see ux_design/13-remaining-backlog.md, items C2/C3), and rename/delete are real (backed
 * by the API's usage-checked update/delete).
 */
@Component({
  selector: 'app-project-assets',
  standalone: true,
  imports: [FormsModule, IconComponent, AssetFieldsComponent, MarkdownViewerComponent],
  template: `
    <p class="hint">Assets are shared across the project's processes and can be exported as standard artifacts. Nodes link to them by name (business rule tasks reference a DRL ruleset's group, forms are picked by name on user tasks, and so on).</p>

    <div class="toolbar">
      <input class="search" placeholder="Search assets…" [(ngModel)]="q" />
      <span class="spacer"></span>
      <button class="btn primary" (click)="openAdd()"><app-icon name="plus" [size]="13" /> Add asset</button>
    </div>

    <div class="layout">
      <aside class="rail card">
        <div class="section-title first">Kind</div>
        <button class="krow" [class.active]="kindFilter() === null" (click)="kindFilter.set(null)">
          <span>All assets</span><span class="badge">{{ allRows().length }}</span>
        </button>
        @for (k of ctx.assetKinds(); track k.key) {
          <div class="krow-wrap" [class.active]="kindFilter() === k.key">
            <button class="krow" [class.active]="kindFilter() === k.key" (click)="kindFilter.set(k.key)">
              <span>{{ k.label }}</span><span class="badge">{{ (ctx.assets()[k.key] || []).length }}</span>
            </button>
            <button type="button" class="k-info-btn" (click)="$event.stopPropagation(); openAssetDocs(k.key, k.label)" title="View {{ k.label }} documentation & examples" aria-label="Documentation">
              <app-icon name="info" [size]="13" />
            </button>
          </div>
        }
      </aside>

      <div class="listcol">
        @if (filtered().length === 0) {
          <div class="card empty-state">
            <div class="es-icon"><app-icon name="file" [size]="22" /></div>
            <h3>{{ hasFilters() ? 'No assets match' : 'No assets yet' }}</h3>
            <p>{{ hasFilters() ? 'Try a different search or kind filter.' : "Add a form, data type, ruleset or decision — nodes reference these by name." }}</p>
            @if (hasFilters()) { <button class="btn sm" (click)="resetFilters()">Reset filters</button> }
          </div>
        } @else {
          <div class="card listcard">
            <table>
              <thead><tr><th>Name</th><th>Kind</th><th>Used by</th><th></th></tr></thead>
              <tbody>
                @for (a of filtered(); track a.kind + '::' + a.name) {
                  <tr>
                    <td><button class="lnk" (click)="openDetail(a)">{{ a.name }}</button></td>
                    <td><span class="badge">{{ a.kindLabel }}</span></td>
                    <td>
                      @if (a.usedBy > 0) {
                        <button class="used-by-pill" (click)="openUsageModal(a, $event)" title="View all usages and navigate to canvas">
                          <span class="ref-summary">{{ getLatestRefSummary(a) }}</span>
                          @if (a.usedBy > 1) {
                            <span class="ref-count-tag">+{{ a.usedBy - 1 }}</span>
                          }
                        </button>
                      } @else {
                        <span class="badge inactive">unused</span>
                      }
                    </td>
                    <td class="menucell" (click)="$event.stopPropagation()">
                      <button class="kebab" (click)="menuFor.set(menuFor() === a ? null : a)" aria-label="Asset actions" aria-haspopup="menu"><app-icon name="more" [size]="15" /></button>
                      @if (menuFor() === a) {
                        <div class="rowmenu card">
                          <button class="mrow" (click)="openDetail(a); menuFor.set(null)"><app-icon name="file" [size]="13" /> Open</button>
                          <button class="mrow" (click)="rename(a); menuFor.set(null)"><app-icon name="edit" [size]="13" /> Rename</button>
                          <button class="mrow" (click)="duplicateAsset(a); menuFor.set(null)"><app-icon name="copy" [size]="13" /> Duplicate</button>
                          <button class="mrow danger" [disabled]="a.usedBy > 0" [title]="a.usedBy > 0 ? 'Referenced by ' + a.usedBy + ' node(s)' : ''" (click)="ctx.removeAsset(a.kind, a.name, a.usedBy); menuFor.set(null)"><app-icon name="trash" [size]="13" /> Delete</button>
                        </div>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </div>
    </div>

    @if (adding()) {
      <div class="modal-bg" (click)="closeAdd()">
        <div class="modal" (click)="$event.stopPropagation()">
          <div class="modal-h"><span>Add asset</span><span class="spacer"></span><button class="x" (click)="closeAdd()" aria-label="Close"><app-icon name="close" [size]="15" /></button></div>
          <div class="modal-body">
            <label class="fld"><span>Kind</span>
              <select [(ngModel)]="addKind" (ngModelChange)="onKindChange($event)">
                @for (k of ctx.assetKinds(); track k.key) { <option [value]="k.key">{{ k.label }}</option> }
              </select>
            </label>
            <label class="fld"><span>{{ nameFieldLabel(addKind) }}</span><input [(ngModel)]="addName" [placeholder]="nameFieldLabel(addKind)" /></label>
            @for (f of extraFields(addKind); track f.key) {
              <label class="fld">
                <span>{{ f.label }}</span>
                @if (f.type === 'select') {
                  <select [ngModel]="fv()[f.key] || f.default || ''" (ngModelChange)="fv()[f.key] = $event">
                    @for (opt of f.options; track opt) { <option [value]="opt">{{ opt }}</option> }
                  </select>
                } @else {
                  <input [type]="f.type" [placeholder]="f.placeholder || f.label" [ngModel]="fv()[f.key] || f.default || ''" (ngModelChange)="fv()[f.key] = $event" />
                }
                @if (f.help) { <small class="help-txt">{{ f.help }}</small> }
              </label>
            }
            <button class="btn primary full" (click)="submitAdd()">Add asset</button>
          </div>
        </div>
      </div>
    }

    @if (detail(); as d) {
      <div class="modal-bg" (click)="closeDetail()">
        <div class="modal wide" (click)="$event.stopPropagation()">
          <div class="modal-h">
            <span>{{ d.row.name }}</span><span class="badge">{{ d.row.kindLabel }}</span><span class="spacer"></span>
            <button class="x" (click)="closeDetail()" aria-label="Close"><app-icon name="close" [size]="15" /></button>
          </div>
          <div class="modal-body">
            <div class="subtabs">
              <button class="subtab-btn" [class.active]="detailTab() === 'config'" (click)="detailTab.set('config')">
                <app-icon name="edit" [size]="13" /> Configuration
              </button>
              <button class="subtab-btn" [class.active]="detailTab() === 'test'" (click)="openTestTab(d)">
                <app-icon name="play" [size]="13" /> Test & Simulate
              </button>
              <button class="subtab-btn" [class.active]="detailTab() === 'docs'" (click)="detailTab.set('docs')">
                <app-icon name="info" [size]="13" /> Guide & Docs
              </button>
            </div>

            @if (detailTab() === 'config') {
              <div class="section-title first">Referenced by</div>
              @if (d.usedBy.length) {
                <div class="panel-list">
                  @for (r of d.usedBy; track r.process + (r.nodeId || '') + r.via) {
                    <div class="prow-card">
                      <div class="prow-left">
                        <span class="prow-main">{{ r.process }}@if (r.nodeName) { · {{ r.nodeName }} }</span>
                        <span class="muted sm via-tag">via: {{ r.via }}</span>
                      </div>
                      @if (r.processId) {
                        <button class="btn sm ghost open-canvas-btn" (click)="navigateToRef(r)" title="Open this node in canvas builder">
                          Open in Canvas ↗
                        </button>
                      }
                    </div>
                  }
                </div>
                <p class="muted sm">Deletion is blocked while anything above still points at this asset.</p>
              } @else {
                <p class="muted sm">Not referenced by any process — safe to delete.</p>
              }

              <div class="section-title">Configuration</div>
              <app-asset-fields [kind]="d.row.kind" [value]="d.raw" />
              @if (detailError()) { <p class="err">{{ detailError() }}</p> }

              <div class="row actionrow">
                <button class="btn primary sm" (click)="saveDetail()">Save</button>
                <button class="btn sm" (click)="rename(d.row)">Rename</button>
                <button class="btn sm" (click)="duplicateAsset(d.row)"><app-icon name="copy" [size]="12" /> Duplicate</button>
                <button class="btn sm danger" [disabled]="d.row.usedBy > 0" [title]="d.row.usedBy > 0 ? 'Referenced by ' + d.row.usedBy + ' node(s)' : ''" (click)="deleteFromDetail(d.row)">Delete</button>
              </div>
            } @else {
              <!-- Test & Simulate Panel -->
              <div class="test-panel">
                <div class="test-header">
                  <div>
                    <h4 class="test-title">Test {{ d.row.kindLabel }}: {{ d.row.name }}</h4>
                    <p class="test-desc">{{ testPurposeDesc(d.row.kind) }}</p>
                  </div>
                  <button class="btn primary" [disabled]="testLoading()" (click)="runTest(d)">
                    <app-icon name="play" [size]="13" /> {{ testButtonLabel(d.row.kind) }}
                  </button>
                </div>

                @if (d.row.kind === 'tests') {
                  <div class="test-scenarios-panel">
                    <p class="muted sm">Runs all test cases against target: <strong>{{ d.raw.target || 'None' }}</strong></p>
                    <div class="cases-preview">
                      @for (c of d.raw.cases || []; track $index) {
                        <div class="case-card">
                          <div class="case-name"><strong>Case {{ $index + 1 }}:</strong> {{ c.name || 'Unnamed' }}</div>
                          <div class="case-io">
                            <span class="io-lbl">Given:</span> <code>{{ jsonStr(c.given) }}</code>
                            <span class="io-lbl">Expect:</span> <code>{{ jsonStr(c.expect) }}</code>
                          </div>
                        </div>
                      }
                    </div>
                  </div>
                } @else if (d.row.kind === 'forms') {
                  <div class="test-form-preview card">
                    <div class="sec-h">{{ d.raw.name }} Live Interactive Preview</div>
                    <div class="form-grid">
                      @for (f of d.raw.fields || []; track f.bind) {
                        <div class="fld">
                          <label>{{ f.label || f.bind }} @if (f.required) { <span class="req">*</span> }</label>
                          @if (f.widget === 'textarea') {
                            <textarea [(ngModel)]="testInputs[f.bind]" [placeholder]="f.placeholder || ''"></textarea>
                          } @else if (f.widget === 'checkbox' || f.widget === 'boolean') {
                            <label class="chk"><input type="checkbox" [(ngModel)]="testInputs[f.bind]" /> <span>{{ f.label || f.bind }}</span></label>
                          } @else if (f.widget === 'number' || f.widget === 'integer' || f.widget === 'decimal') {
                            <input type="number" [(ngModel)]="testInputs[f.bind]" [placeholder]="f.placeholder || ''" />
                          } @else if (f.widget === 'date') {
                            <input type="date" [(ngModel)]="testInputs[f.bind]" />
                          } @else {
                            <input type="text" [(ngModel)]="testInputs[f.bind]" [placeholder]="f.placeholder || ''" />
                          }
                        </div>
                      }
                    </div>
                  </div>
                } @else if (d.row.kind === 'types') {
                  <div class="java-preview-card card">
                    <div class="java-hdr">
                      <span>Generated Data Object POJO ({{ d.raw.package || 'com.acme.model' }}.{{ d.raw.name }})</span>
                      <button class="btn sm ghost" (click)="copyJava(generateJavaPojo(d.raw))">
                        {{ copiedJava() ? 'Copied!' : 'Copy .java' }}
                      </button>
                    </div>
                    <pre class="code-box"><code>{{ generateJavaPojo(d.raw) }}</code></pre>
                  </div>
                } @else if (d.row.kind === 'enumerations') {
                  <div class="enum-preview card">
                    <label class="fld">
                      <span>Form / Task Dropdown Preview for {{ d.raw.type || 'Claim' }}.{{ d.raw.field || 'status' }}</span>
                      <select [(ngModel)]="testInputs['value']">
                        @for (v of getEnumValues(d.raw); track v) {
                          <option [value]="v">{{ v }}</option>
                        }
                      </select>
                    </label>
                  </div>
                } @else {
                  <!-- Standard input parameters grid -->
                  <div class="card test-inputs-card">
                    <div class="sec-h">Test Input Variables</div>
                    <div class="test-inputs-grid">
                      @for (key of getTestInputKeys(); track key) {
                        <div class="fld">
                          <label>{{ key }}</label>
                          <input [(ngModel)]="testInputs[key]" [placeholder]="key" />
                        </div>
                      }
                    </div>
                  </div>
                }

                @if (testError()) {
                  <div class="err-box card">
                    <app-icon name="error" [size]="16" /> {{ testError() }}
                  </div>
                }

                @if (testResult(); as res) {
                  <div class="result-box card">
                    <div class="result-hdr">
                      <span class="badge" [class.active]="res.success || res.valid" [class.inactive]="res.valid === false || res.failed > 0">
                        {{ res.failed > 0 ? (res.passed + '/' + res.total + ' Passed') : (res.valid === false ? 'Validation Failed' : 'Success') }}
                      </span>
                      <span class="muted sm">Execution Result</span>
                    </div>

                    @if (res.cases) {
                      <div class="scenario-results">
                        @for (c of res.cases; track $index) {
                          <div class="scen-card" [class.pass]="c.pass" [class.fail]="!c.pass">
                            <div class="scen-hdr">
                              <span class="badge" [class.active]="c.pass" [class.inactive]="!c.pass">{{ c.pass ? 'PASS' : 'FAIL' }}</span>
                              <strong>{{ c.name }}</strong>
                            </div>
                            @if (!c.pass && c.failures?.length) {
                              <div class="diff-box">
                                @for (f of c.failures; track f.field) {
                                  <div>Property <strong>{{ f.field }}</strong>: expected <code>{{ jsonStr(f.expected) }}</code> but got <code>{{ jsonStr(f.actual) }}</code></div>
                                }
                              </div>
                            }
                          </div>
                        }
                      </div>
                    } @else if (res.errors?.length) {
                      <ul class="err-list">
                        @for (e of res.errors; track e) { <li>{{ e }}</li> }
                      </ul>
                    } @else {
                      <pre class="res-json"><code>{{ jsonStr(res.outputs || res) }}</code></pre>
                    }
                  </div>
                }
              </div>
            }

            @if (detailTab() === 'docs') {
              <div class="docs-scroll-pane">
                <app-markdown-viewer [content]="assetDocsContent(d.row.kind)" />
              </div>
            }
          </div>
        </div>
      </div>
    }

    @if (usageModalFor(); as u) {
      <div class="modal-bg" (click)="closeUsageModal()">
        <div class="modal usage-modal" (click)="$event.stopPropagation()">
          <div class="modal-h">
            <div class="usage-title-row">
              <span>Usages: <strong>{{ u.name }}</strong></span>
              <span class="badge active">{{ u.usedBy }} reference{{ u.usedBy === 1 ? '' : 's' }}</span>
            </div>
            <span class="spacer"></span>
            <button class="x" (click)="closeUsageModal()" aria-label="Close"><app-icon name="close" [size]="15" /></button>
          </div>
          <div class="modal-body">
            <p class="usage-lead">This <strong>{{ u.kindLabel }}</strong> is referenced by the following process flows and nodes:</p>
            <div class="usage-list">
              @for (ref of u.refs; track ref.process + (ref.nodeId || '') + ref.via) {
                <div class="usage-card">
                  <div class="usage-info">
                    <div class="usage-proc">
                      <app-icon name="workflows" [size]="14" />
                      <strong>{{ ref.process }}</strong>
                    </div>
                    @if (ref.nodeName) {
                      <div class="usage-node">
                        <span class="node-bullet">↳</span>
                        <span class="node-lbl">Node:</span>
                        <strong>{{ ref.nodeName }}</strong>
                        <code class="node-id">({{ ref.nodeId }})</code>
                      </div>
                    }
                    <div class="usage-meta">
                      <span class="via-tag">via: {{ ref.via }}</span>
                    </div>
                  </div>
                  @if (ref.processId) {
                    <button class="btn sm primary open-canvas-btn" (click)="navigateToRef(ref)" title="Open this node in canvas builder">
                      Open in Canvas ↗
                    </button>
                  }
                </div>
              }
            </div>
          </div>
        </div>
      </div>
    }

    @if (viewingAssetDocs(); as adoc) {
      <div class="modal-bg" (click)="closeAssetDocs()">
        <div class="modal wide" (click)="$event.stopPropagation()">
          <div class="modal-h">
            <app-icon name="info" [size]="15" />
            <span>{{ adoc.label }} — Specification & Documentation</span>
            <span class="spacer"></span>
            <button class="x" (click)="closeAssetDocs()" aria-label="Close"><app-icon name="close" [size]="15" /></button>
          </div>
          <div class="modal-body docs-scroll-pane">
            <app-markdown-viewer [content]="adoc.content" />
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .hint { color: var(--muted); font-size: 13px; margin: 0 0 14px; max-width: 760px; line-height: 1.5; }
    .hint.sm { font-size: 12px; margin-bottom: 10px; }
    .toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
    .search { width: 260px; }
    .layout { display: grid; grid-template-columns: 220px 1fr; gap: 16px; align-items: start; }
    .rail { padding: 14px; }
    .section-title { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); font-weight: 700; margin: 14px 0 8px; }
    .section-title.first { margin-top: 0; }
    .krow-wrap { display: flex; align-items: center; border-radius: var(--radius-sm); transition: background-color .12s; margin-bottom: 2px; }
    .krow-wrap:hover { background: var(--surface-3); }
    .krow-wrap.active { background: var(--primary-50); }
    .krow-wrap .krow { flex: 1; margin-bottom: 0; }
    .k-info-btn { border: none; background: transparent; color: var(--muted); padding: 5px 6px; border-radius: 4px; cursor: pointer; display: flex; align-items: center; opacity: 0; transition: opacity .12s, color .12s; margin-right: 4px; }
    .krow-wrap:hover .k-info-btn { opacity: 0.8; }
    .k-info-btn:hover { opacity: 1 !important; color: var(--primary, #3b82f6); background: var(--surface-2); }
    .docs-scroll-pane { padding: 18px 24px; overflow-y: auto; flex: 1; max-height: 72vh; background: var(--surface); }
    .krow { display: flex; align-items: center; justify-content: space-between; width: 100%; border: none; background: none; padding: 7px 8px; border-radius: var(--radius-sm); font-size: 13px; cursor: pointer; color: var(--text-secondary); text-align: left; }
    .krow:hover { background: var(--surface-3); }
    .krow.active { background: var(--primary-50); color: var(--primary); font-weight: 600; }
    /* No overflow-x here (unlike a wide operational list) — this table is 4 narrow columns and never
       needs horizontal scroll at desktop widths. That matters because ANY ancestor with a non-visible
       overflow-x also clips overflow-y (the browser can't scroll one axis and clip-hide the other), which
       was cutting the absolutely-positioned row menu down to a sliver — hence "Rename"/"Delete" missing. */
    .listcard { padding: 0; }
    tbody tr:hover { background: var(--surface-2); }
    .lnk { border: none; background: none; color: var(--primary); font-weight: 600; cursor: pointer; font: inherit; padding: 0; }
    .lnk:hover { text-decoration: underline; }
    .menucell { position: relative; text-align: right; }
    .kebab { border: none; background: transparent; cursor: pointer; color: var(--muted); padding: 6px 8px; border-radius: var(--radius-xs); }
    .kebab:hover { background: var(--surface-3); }
    .rowmenu { position: absolute; top: 34px; right: 0; width: 180px; z-index: 20; padding: 4px; box-shadow: var(--shadow-pop); }
    .mrow { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; border: none; background: none; padding: 8px 10px; font-size: 12.5px; cursor: pointer; border-radius: var(--radius-xs); color: inherit; font: inherit; }
    .mrow:hover { background: var(--surface-2); }
    .mrow.danger { color: var(--red); }
    .mrow:disabled { opacity: .45; cursor: not-allowed; }
    .empty-state { padding: 40px; }

    .fld { display: block; margin-bottom: 12px; } .fld span { display: block; font-size: 12px; color: var(--muted); margin-bottom: 5px; }
    .fld input, .fld select, .fld textarea { width: 100%; border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; font-size: 13px; font-family: inherit; }
    .btn.full { width: 100%; justify-content: center; margin-top: 4px; }
    .btn.danger { color: var(--red); border-color: var(--border-strong); } .btn.danger:hover { background: var(--red-bg); }
    .actionrow { gap: 8px; margin-top: 14px; }
    .sm { font-size: 12px; }
    .err { color: var(--red); font-size: 12px; margin: -4px 0 8px; }
    .panel-list { display: flex; flex-direction: column; gap: 2px; margin-bottom: 6px; }
    .prow { display: flex; justify-content: space-between; padding: 6px 8px; border-radius: var(--radius-xs); font-size: 13px; }
    .prow:hover { background: var(--surface-2); }

    .modal-bg { position: fixed; inset: 0; background: rgba(16,24,40,.4); display: grid; place-items: center; z-index: 50; }
    .modal { background: var(--surface); border-radius: 14px; width: 440px; max-width: 92vw; max-height: 80vh; overflow: hidden; display: flex; flex-direction: column; box-shadow: var(--shadow-pop); }
    /* Wide enough that a rule's nested When/Then panels (see asset-fields.component) get real room —
       narrower and every nested list cramps back down to the single column this is meant to avoid. */
    .modal.wide { width: 820px; max-width: 95vw; max-height: 88vh; }
    .modal-h { display: flex; align-items: center; gap: 8px; padding: 14px 18px; border-bottom: 1px solid var(--border); font-weight: 700; }
    .modal-h .x { border: none; background: transparent; font-size: 16px; cursor: pointer; color: var(--muted); }
    .modal-body { padding: 16px 18px; overflow: auto; }

    .subtabs { display: flex; gap: 8px; border-bottom: 1px solid var(--border); margin: -4px 0 14px; padding-bottom: 8px; }
    .subtab-btn { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--border); background: var(--surface); color: var(--text-secondary); padding: 6px 12px; border-radius: var(--radius-sm); font-size: 12.5px; font-weight: 600; cursor: pointer; }
    .subtab-btn:hover { background: var(--surface-2); }
    .subtab-btn.active { background: var(--primary-50); border-color: var(--primary-200, var(--primary)); color: var(--primary); }

    .test-panel { display: flex; flex-direction: column; gap: 14px; }
    .test-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding-bottom: 10px; border-bottom: 1px solid var(--border); }
    .test-title { font-size: 15px; font-weight: 700; margin: 0; }
    .test-desc { font-size: 12px; color: var(--muted); margin: 4px 0 0; line-height: 1.4; }
    .test-scenarios-panel, .test-form-preview, .java-preview-card, .enum-preview, .test-inputs-card { padding: 12px 14px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; }
    .cases-preview { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
    .case-card { padding: 8px 10px; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; }
    .case-name { font-size: 12.5px; margin-bottom: 3px; }
    .case-io { font-size: 11.5px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .io-lbl { color: var(--muted); font-weight: 600; }
    .case-io code { background: var(--surface-2); padding: 2px 6px; border-radius: 4px; font-family: monospace; font-size: 11px; }

    .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; margin-top: 6px; }
    .req { color: var(--red); }
    .chk { display: flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; margin-top: 4px; }
    .chk input { width: auto; margin: 0; }

    .java-hdr { display: flex; align-items: center; justify-content: space-between; font-size: 12.5px; font-weight: 600; margin-bottom: 8px; }
    .code-box { background: var(--surface-3); border: 1px solid var(--border); border-radius: 6px; padding: 10px; font-size: 11.5px; overflow-x: auto; max-height: 240px; margin: 0; font-family: monospace; }

    .test-inputs-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; margin-top: 6px; }
    .sec-h { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); font-weight: 700; }

    .err-box { border: 1px solid var(--red); background: rgba(239, 68, 68, 0.08); color: var(--red); padding: 10px 14px; border-radius: 8px; display: flex; align-items: center; gap: 8px; font-size: 13px; }
    .result-box { padding: 12px 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-2); }
    .result-hdr { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
    .scenario-results { display: flex; flex-direction: column; gap: 6px; }
    .scen-card { padding: 8px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); }
    .scen-card.pass { border-color: rgba(34, 197, 94, 0.35); background: rgba(34, 197, 94, 0.04); }
    .scen-card.fail { border-color: rgba(239, 68, 68, 0.35); background: rgba(239, 68, 68, 0.04); }
    .scen-hdr { display: flex; align-items: center; gap: 8px; font-size: 12.5px; }
    .diff-box { margin-top: 6px; font-size: 12px; color: var(--red); background: var(--surface); padding: 6px 8px; border-radius: 4px; border: 1px solid rgba(239, 68, 68, 0.2); }
    .diff-box code { background: var(--surface-2); padding: 1px 4px; border-radius: 3px; font-family: monospace; }
    .res-json { margin: 0; font-size: 11.5px; background: var(--surface); padding: 8px 10px; border-radius: 6px; border: 1px solid var(--border); overflow-x: auto; max-height: 220px; font-family: monospace; }
    .help-txt { font-size: 11px; color: var(--muted); margin-top: 2px; display: block; }
    .err-list { margin: 0; padding-left: 20px; color: var(--red); font-size: 12.5px; }

    .used-by-pill { display: inline-flex; align-items: center; gap: 6px; max-width: 320px; padding: 4px 10px; border-radius: 999px; background: var(--surface-2); border: 1px solid var(--border); color: var(--text); font-size: 12px; font-weight: 500; cursor: pointer; text-align: left; transition: all .15s ease; }
    .used-by-pill:hover { background: var(--surface-3); border-color: var(--primary); color: var(--primary); }
    .ref-summary { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ref-count-tag { background: var(--primary); color: #fff; font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 999px; flex-shrink: 0; }
    .usage-modal { width: 620px; max-width: 95vw; }
    .usage-title-row { display: flex; align-items: center; gap: 10px; }
    .usage-lead { font-size: 13px; color: var(--muted); margin: 0 0 14px; }
    .usage-list { display: flex; flex-direction: column; gap: 10px; }
    .usage-card { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 12px 14px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; transition: border-color .15s; }
    .usage-card:hover { border-color: var(--primary-200, var(--primary)); }
    .usage-info { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .usage-proc { display: flex; align-items: center; gap: 6px; font-size: 13.5px; color: var(--text); }
    .usage-node { display: flex; align-items: center; gap: 5px; font-size: 12.5px; color: var(--text-secondary); padding-left: 14px; }
    .node-bullet { color: var(--muted); }
    .node-lbl { color: var(--muted); font-size: 11.5px; }
    .node-id { font-size: 11px; color: var(--muted); background: var(--surface); padding: 1px 4px; border-radius: 4px; font-family: monospace; }
    .usage-meta { padding-left: 14px; }
    .via-tag { display: inline-block; font-size: 11px; background: var(--surface-3); padding: 2px 6px; border-radius: 4px; color: var(--muted); font-family: monospace; }
    .open-canvas-btn { flex-shrink: 0; white-space: nowrap; }
    .prow-card { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 10px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px; margin-bottom: 6px; }
    .prow-left { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
    .prow-main { font-size: 13px; font-weight: 500; }
  `],
})
export class ProjectAssetsComponent implements OnInit {
  ctx = inject(ProjectContextService);
  private api = inject(WorkflowApiService);
  private toast = inject(ToastService);
  private modal = inject(ModalService);
  private router = inject(Router);

  // Clicks inside the menu/kebab stop propagation (see the template), so this only ever sees clicks
  // genuinely outside the menu — safe to unconditionally close on every document click.
  @HostListener('document:click') closeMenu() { this.menuFor.set(null); }

  q = '';
  kindFilter = signal<string | null>(null);
  menuFor = signal<AssetRow | null>(null);

  adding = signal(false);
  addKind = '';
  addName = '';
  private fieldVal: Record<string, string> = {};

  detail = signal<{ row: AssetRow; usedBy: { kind: string; process: string; processId?: string; nodeId?: string; nodeName?: string; via: string }[]; raw: any } | null>(null);
  detailError = signal('');
  detailTab = signal<'config' | 'test' | 'docs'>('config');

  usageModalFor = signal<AssetRow | null>(null);
  assetReadmes = signal<Record<string, string>>({});
  viewingAssetDocs = signal<{ kind: string; label: string; content: string } | null>(null);

  ngOnInit() {
    this.api.catalog().subscribe((c) => {
      if (c?.assetReadmes) {
        this.assetReadmes.set(c.assetReadmes);
      }
    });
  }

  assetDocsContent(kind: string): string {
    return this.assetReadmes()[kind] || 'No documentation available for this asset type.';
  }

  openAssetDocs(kind: string, label: string) {
    const content = this.assetDocsContent(kind);
    this.viewingAssetDocs.set({ kind, label, content });
  }

  closeAssetDocs() {
    this.viewingAssetDocs.set(null);
  }

  // Test & Simulation State
  testLoading = signal<boolean>(false);
  testResult = signal<any>(null);
  testError = signal<string>('');
  copiedJava = signal<boolean>(false);
  testInputs: Record<string, any> = {};

  allRows = computed<AssetRow[]>(() => {
    const out: AssetRow[] = [];
    for (const k of this.ctx.assetKinds()) {
      for (const a of this.ctx.assets()[k.key] || []) {
        out.push({
          kind: k.key,
          kindLabel: k.label,
          name: a.name,
          usedBy: a.usedBy,
          refs: (a as any).refs || [],
        });
      }
    }
    return out;
  });
  filtered = computed(() => {
    const kind = this.kindFilter();
    const q = this.q.trim().toLowerCase();
    return this.allRows().filter((a) => (!kind || a.kind === kind) && (!q || a.name.toLowerCase().includes(q)));
  });
  hasFilters = computed(() => !!this.kindFilter() || !!this.q.trim());
  resetFilters() { this.kindFilter.set(null); this.q = ''; }

  openUsageModal(a: AssetRow, ev?: Event) {
    if (ev) ev.stopPropagation();
    this.usageModalFor.set(a);
  }
  closeUsageModal() {
    this.usageModalFor.set(null);
  }
  getLatestRefSummary(a: AssetRow): string {
    if (!a.refs || a.refs.length === 0) {
      return a.usedBy > 0 ? `${a.usedBy} reference${a.usedBy === 1 ? '' : 's'}` : 'unused';
    }
    const r = a.refs[0];
    if (r.nodeName) return `${r.process} · ${r.nodeName}`;
    return r.process;
  }
  navigateToRef(ref: { processId?: string; nodeId?: string }) {
    if (ref.processId) {
      this.closeUsageModal();
      this.closeDetail();
      this.router.navigate(['/projects', this.ctx.id, 'processes', ref.processId], {
        queryParams: ref.nodeId ? { nodeId: ref.nodeId } : undefined,
      });
    }
  }

  extraFields(kind: string) { return EXTRA_FIELDS[kind] || []; }
  fv() { return this.fieldVal; }
  nameFieldLabel(kind: string): string { return this.ctx.assetKinds().find((k) => k.key === kind)?.nameField === 'group' ? 'Ruleflow group name' : 'Name'; }

  onKindChange(kind: string) {
    this.addKind = kind;
    this.fieldVal = {};
    for (const f of this.extraFields(kind)) {
      if (f.default !== undefined) {
        this.fieldVal[f.key] = String(f.default);
      }
    }
  }

  openAdd() {
    const firstKind = this.ctx.assetKinds()[0]?.key || 'forms';
    this.onKindChange(firstKind);
    this.addName = '';
    this.adding.set(true);
  }
  closeAdd() { this.adding.set(false); }
  submitAdd() {
    const name = this.addName.trim();
    if (!name) { this.toast.error('Name is required'); return; }
    const fields = this.buildFields(this.addKind);
    this.ctx.addAsset(this.addKind, name, Object.keys(fields).length ? fields : undefined);
    this.closeAdd();
  }
  private buildFields(kind: string): Record<string, unknown> {
    const out: Record<string, any> = {};
    for (const f of this.extraFields(kind)) {
      const raw = this.fieldVal[f.key];
      if (raw === undefined || raw === '') continue;
      const parts = f.key.split('.');
      let cur = out;
      for (let i = 0; i < parts.length - 1; i++) { cur[parts[i]] ??= {}; cur = cur[parts[i]]; }
      cur[parts[parts.length - 1]] = f.type === 'number' ? Number(raw) : raw;
    }
    return out;
  }

  openDetail(row: AssetRow) {
    this.menuFor.set(null);
    this.ctx.getAsset(row.kind, row.name).subscribe({
      next: (r) => {
        this.detail.set({ row, usedBy: r.usedBy, raw: r.asset });
        this.detailError.set('');
        this.detailTab.set('config');
      },
      error: (e) => this.toast.error(e?.error?.error?.message || 'Could not load asset'),
    });
  }
  closeDetail() { this.detail.set(null); }

  openTestTab(d: any) {
    this.detailTab.set('test');
    this.testResult.set(null);
    this.testError.set('');
    this.initTestData(d.raw, d.row.kind);
  }

  initTestData(raw: any, kind: string) {
    this.testInputs = {};
    if (kind === 'forms') {
      for (const f of raw?.fields || []) {
        this.testInputs[f.bind] = f.widget === 'checkbox' || f.widget === 'boolean' ? false : (f.default ?? '');
      }
    } else if (kind === 'enumerations') {
      const vals = this.getEnumValues(raw);
      this.testInputs['value'] = vals[0] || 'NEW';
    } else if (kind === 'decisions') {
      if (Array.isArray(raw?.inputs)) {
        for (const inp of raw.inputs) {
          const k = typeof inp === 'string' ? inp : (inp.name || inp.id);
          if (k) this.testInputs[k] = 100;
        }
      }
      if (!Object.keys(this.testInputs).length) {
        this.testInputs['amount'] = 1000;
        this.testInputs['creditScore'] = 720;
      }
    } else if (kind === 'rulesets') {
      this.testInputs['amount'] = 2500;
      this.testInputs['region'] = 'NA';
      this.testInputs['status'] = 'NEW';
    } else if (kind === 'guidedTables') {
      if (Array.isArray(raw?.conditions)) {
        for (const c of raw.conditions) {
          if (c.field) this.testInputs[c.field] = c.field === 'amount' ? 500 : (c.field === 'region' ? 'US' : 'VALID');
        }
      }
      if (!Object.keys(this.testInputs).length) {
        this.testInputs['amount'] = 500;
        this.testInputs['region'] = 'US';
      }
    } else if (kind === 'decisionTrees') {
      this.testInputs[raw?.field || 'amount'] = 1500;
      this.testInputs['riskScore'] = 80;
    } else if (kind === 'scorecards') {
      this.testInputs['amount'] = 1200;
      this.testInputs['age'] = 35;
    } else if (kind === 'messages') {
      this.testInputs['correlationId'] = 'CLAIM-1001';
      this.testInputs['payload'] = { id: 'CLAIM-1001', amount: 500 };
    }
  }

  getTestInputKeys(): string[] {
    return Object.keys(this.testInputs);
  }

  testButtonLabel(kind: string): string {
    switch (kind) {
      case 'tests': return 'Run All Scenarios';
      case 'decisions': return 'Evaluate Decision';
      case 'rulesets': return 'Fire Rules';
      case 'guidedTables': return 'Evaluate Table';
      case 'decisionTrees': return 'Traverse Tree';
      case 'scorecards': return 'Calculate Scorecard';
      case 'forms': return 'Validate Submission';
      case 'enumerations': return 'Validate Value';
      case 'types': return 'Validate POJO Schema';
      case 'messages': return 'Inspect Message';
      default: return 'Execute Test';
    }
  }

  testPurposeDesc(kind: string): string {
    switch (kind) {
      case 'forms': return 'Test interactive form layout, constraints, required field checks, and payload submission.';
      case 'rulesets': return 'Execute Drools DRL pattern-matching against fact variables and inspect modified rule outcomes.';
      case 'decisions': return 'Evaluate DMN decision tables and hit policies against input variables.';
      case 'guidedTables': return 'Evaluate guided decision table conditions against facts and apply matched actions.';
      case 'decisionTrees': return 'Traverse decision tree conditions and execute leaf node action consequences.';
      case 'scorecards': return 'Calculate baseline and characteristic score weights against input attributes.';
      case 'enumerations': return 'Validate allowed enumeration values and test form/task dropdown integration.';
      case 'types': return 'Preview generated Java POJO data object definition with getters and setters.';
      case 'messages': return 'Validate BPMN 2.0 message contract, correlation property, and payload structure.';
      case 'tests': return 'Execute all test scenario cases against the target asset and verify expected vs actual outcomes.';
      default: return 'Test asset logic and execution.';
    }
  }

  runTest(d: any) {
    this.testLoading.set(true);
    this.testError.set('');
    this.testResult.set(null);

    const payload: Record<string, any> = {};
    for (const [k, v] of Object.entries(this.testInputs)) {
      if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) {
        payload[k] = Number(v);
      } else {
        payload[k] = v;
      }
    }

    this.ctx.testAsset(d.row.kind, d.row.name, payload).subscribe({
      next: (res: any) => {
        this.testLoading.set(false);
        this.testResult.set(res);
        if (res.success || res.valid || (res.passed !== undefined && res.failed === 0)) {
          this.toast.success('Asset test passed');
        } else if (res.failed > 0) {
          this.toast.error(`${res.failed} test scenario case(s) failed`);
        }
      },
      error: (err: any) => {
        this.testLoading.set(false);
        const msg = err?.error?.error?.message || err?.message || 'Asset test failed';
        this.testError.set(msg);
        this.toast.error(msg);
      }
    });
  }

  jsonStr(val: any): string {
    try {
      return typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val);
    } catch {
      return String(val);
    }
  }

  getEnumValues(raw: any): string[] {
    if (Array.isArray(raw?.values)) return raw.values;
    if (typeof raw?.values === 'string') {
      return raw.values.split(',').map((s: string) => s.trim()).filter(Boolean);
    }
    if (raw?.entries && typeof raw.entries === 'object') {
      return Object.keys(raw.entries);
    }
    return ['NEW', 'PENDING', 'APPROVED', 'REJECTED'];
  }

  generateJavaPojo(type: any): string {
    const pkg = type?.package || 'com.acme.model';
    const className = type?.name || 'DataObject';
    const fields = Array.isArray(type?.fields) ? type.fields : [];
    let code = `package ${pkg};\n\n`;
    code += `/**\n * Data Object: ${className}\n */\n`;
    code += `public class ${className} implements java.io.Serializable {\n\n`;
    code += `    private static final long serialVersionUID = 1L;\n\n`;
    for (const f of fields) {
      const fType = f.type || 'String';
      const fName = f.name || 'field';
      code += `    private ${fType} ${fName};\n`;
    }
    code += `\n    public ${className}() {}\n\n`;
    for (const f of fields) {
      const fType = f.type || 'String';
      const fName = f.name || 'field';
      const cap = fName.charAt(0).toUpperCase() + fName.slice(1);
      code += `    public ${fType} get${cap}() {\n        return this.${fName};\n    }\n\n`;
      code += `    public void set${cap}(${fType} ${fName}) {\n        this.${fName} = ${fName};\n    }\n\n`;
    }
    code += `}\n`;
    return code;
  }

  copyJava(code: string) {
    if (navigator?.clipboard) {
      navigator.clipboard.writeText(code).then(() => {
        this.copiedJava.set(true);
        setTimeout(() => this.copiedJava.set(false), 2000);
      });
    } else {
      this.copiedJava.set(true);
      setTimeout(() => this.copiedJava.set(false), 2000);
    }
  }

  // AssetFieldsComponent mutates `d.raw` in place (see its [value] input) — Save just re-sends the
  // whole object as the patch. The nameField key inside it always matches d.row.name already (rename
  // is a separate action), so this never triggers the update endpoint's rename path by accident.
  saveDetail() {
    const d = this.detail(); if (!d) return;
    this.ctx.updateAsset(d.row.kind, d.row.name, d.raw).subscribe({
      next: () => { this.toast.success('Asset saved'); this.closeDetail(); this.ctx.loadAssets(); },
      error: (e) => this.detailError.set(e?.error?.error?.message || 'Save failed'),
    });
  }

  async rename(row: AssetRow) {
    this.menuFor.set(null);
    const nameField = this.ctx.assetKinds().find((k) => k.key === row.kind)?.nameField || 'name';
    const next = await this.modal.prompt({ title: 'Rename asset', initialValue: row.name });
    if (!next || !next.trim() || next.trim() === row.name) return;
    this.ctx.updateAsset(row.kind, row.name, { [nameField]: next.trim() }).subscribe({
      next: () => { this.toast.success('Renamed'); this.closeDetail(); this.ctx.loadAssets(); },
      error: (e) => this.toast.error(e?.error?.error?.message || 'Rename failed'),
    });
  }

  async duplicateAsset(row: AssetRow) {
    this.menuFor.set(null);
    const next = await this.modal.prompt({
      title: `Duplicate ${row.kindLabel}`,
      initialValue: `${row.name}_Copy`,
    });
    if (!next || !next.trim() || next.trim() === row.name) return;
    const newName = next.trim();
    this.ctx.duplicateAsset(row.kind, row.name, newName).subscribe({
      next: () => {
        this.toast.success(`Duplicated "${row.name}" as "${newName}"`);
        this.ctx.loadAssets();
      },
      error: (e: any) => this.toast.error(e?.error?.error?.message || 'Failed to duplicate asset'),
    });
  }

  deleteFromDetail(row: AssetRow) {
    this.closeDetail();
    this.ctx.removeAsset(row.kind, row.name, row.usedBy);
  }
}
