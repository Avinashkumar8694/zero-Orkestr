import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
  computed,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IconComponent } from './icon.component';
import { MarkdownViewerComponent } from './markdown-viewer.component';

interface Snippet {
  label: string;
  desc: string;
  code: string;
}

@Component({
  selector: 'app-code-editor',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent, MarkdownViewerComponent],
  template: `
    <!-- Top toolbar / Header -->
    <div class="editor-header" [class.max-hdr]="maximized()">
      <div class="hdr-left">
        @if (lang === 'java') {
          <span class="lang-tag java"><span class="badge">Java</span> Sidecar JVM (Language locked)</span>
        } @else {
          <span class="lang-tag js"><span class="badge">JavaScript</span> Node.js Sandbox VM</span>
        }
        <span class="pos-badge">{{ cursorInfo() }}</span>
      </div>

      <div class="hdr-actions">
        <button type="button" class="tool-btn" (click)="formatCode()" title="Format indentation">
          Format
        </button>
        <button type="button" class="tool-btn" (click)="copyCode()" title="Copy to clipboard">
          <app-icon name="copy" [size]="12" />
          {{ copied() ? 'Copied!' : 'Copy' }}
        </button>
        <button
          type="button"
          class="tool-btn cheat"
          (click)="onCheatClick()"
          [title]="lang === 'java' ? 'Open Java & Imported Script Reference' : 'Open JavaScript & Flow Variables Cheat Sheet'"
        >
          <app-icon name="code" [size]="12" />
          {{ lang === 'java' ? 'Java Reference' : 'Cheat Sheet' }}
        </button>
        <button
          type="button"
          class="tool-btn max-btn"
          (click)="toggleMaximize()"
          [title]="maximized() ? 'Minimize (Esc)' : 'Maximize code editor'"
        >
          <app-icon [name]="maximized() ? 'minimize' : 'maximize'" [size]="13" />
          {{ maximized() ? 'Minimize' : 'Maximize' }}
        </button>
      </div>
    </div>

    <!-- Main Editor Body (Gutter + Textarea + Split Drawer) -->
    <div class="editor-body-wrap" [class.maximized-body]="maximized()">
      <div class="editor-main-pane">
        <!-- Line Numbers Gutter -->
        <div class="gutter" #gutterPane>
          @for (n of lineNumbers(); track n) {
            <div class="line-num">{{ n }}</div>
          }
        </div>

        <!-- Code Textarea -->
        <textarea
          #codeArea
          class="code-input"
          [placeholder]="placeholder"
          [disabled]="readOnly"
          [ngModel]="code"
          (ngModelChange)="onCodeChange($event)"
          (scroll)="onEditorScroll()"
          (keydown)="onKeyDown($event)"
          (keyup)="updateCursorInfo()"
          (click)="updateCursorInfo()"
          spellcheck="false"
          autocapitalize="off"
          autocomplete="off"
        ></textarea>
      </div>

      <!-- Maximized Side Drawer: Live Cheat Sheet & Quick Snippets -->
      @if (maximized() && showDrawer()) {
        <aside class="side-drawer card">
          <div class="drawer-header">
            <span>{{ lang === 'java' ? 'Java Reference & Snippets' : 'Flow Variables & Snippets' }}</span>
            <button class="x-btn" (click)="showDrawer.set(false)" aria-label="Close drawer">
              <app-icon name="close" [size]="14" />
            </button>
          </div>

          <div class="drawer-scroll">
            <div class="section-title">Quick Snippet Insert</div>
            <div class="snippet-grid">
              @for (snip of effectiveSnippets(); track snip.label) {
                <button
                  type="button"
                  class="snip-card"
                  (click)="insertSnippet(snip.code)"
                  [title]="snip.desc"
                >
                  <span class="snip-lbl">{{ snip.label }}</span>
                  <code>{{ snip.code }}</code>
                </button>
              }
            </div>

            @if (effectiveCheatSheetContent(); as content) {
              <div class="section-title mt-4">{{ lang === 'java' ? 'Java Reference Manual' : 'Full Quick Reference' }}</div>
              <div class="drawer-markdown">
                <app-markdown-viewer [content]="content" />
              </div>
            }
          </div>
        </aside>
      }
    </div>

    <!-- Backdrop when maximized -->
    @if (maximized()) {
      <div class="max-backdrop" (click)="toggleMaximize()"></div>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        position: relative;
        width: 100%;
      }

      /* Normal inline container */
      .editor-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 6px 10px;
        background: var(--surface-2, rgba(255, 255, 255, 0.05));
        border: 1px solid var(--border);
        border-bottom: none;
        border-radius: 8px 8px 0 0;
        font-size: 11.5px;
      }

      .hdr-left {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }

      .lang-tag {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-weight: 500;
        color: var(--text-secondary);
      }
      .lang-tag .badge {
        font-size: 10.5px;
        font-weight: 700;
        padding: 1.5px 6px;
        border-radius: 4px;
        letter-spacing: 0.3px;
      }
      .lang-tag.js .badge {
        background: #f7df1e;
        color: #000;
      }
      .lang-tag.java .badge {
        background: #e76f51;
        color: #fff;
      }

      .pos-badge {
        font-size: 11px;
        color: var(--muted);
        font-family: var(--font-mono, monospace);
      }

      .hdr-actions {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .tool-btn {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        border: 1px solid var(--border);
        background: var(--surface);
        color: var(--text-secondary);
        border-radius: 5px;
        padding: 3px 8px;
        font-size: 11.5px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .tool-btn:hover {
        color: var(--text);
        border-color: var(--border-strong);
        background: var(--surface-2);
      }
      .tool-btn.cheat {
        color: var(--primary);
      }
      .tool-btn.cheat:hover {
        background: var(--primary-50, rgba(99, 102, 241, 0.12));
        border-color: var(--primary);
      }
      .tool-btn.max-btn {
        background: var(--primary-50, rgba(99, 102, 241, 0.12));
        color: var(--primary);
        font-weight: 600;
      }

      /* Editor Body Container */
      .editor-body-wrap {
        display: flex;
        height: 180px;
        border: 1px solid var(--border);
        border-radius: 0 0 8px 8px;
        background: var(--surface);
        overflow: hidden;
        position: relative;
      }

      .editor-main-pane {
        display: flex;
        flex: 1;
        height: 100%;
        overflow: hidden;
      }

      /* Gutter with line numbers */
      .gutter {
        flex: 0 0 42px;
        background: var(--surface-2, rgba(0, 0, 0, 0.15));
        border-right: 1px solid var(--border);
        padding: 10px 6px 10px 0;
        text-align: right;
        color: var(--muted);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 12px;
        line-height: 1.6;
        user-select: none;
        overflow-y: hidden;
      }
      .line-num {
        height: 19.2px;
      }

      /* Code Textarea */
      .code-input {
        flex: 1;
        height: 100%;
        padding: 10px 12px;
        border: none;
        outline: none;
        resize: none;
        background: transparent;
        color: var(--text);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 12.5px;
        line-height: 1.6;
        white-space: pre;
        word-break: normal;
        overflow-wrap: normal;
        overflow-x: auto;
        overflow-y: auto;
        tab-size: 2;
      }

      /* Maximized / Fullscreen IDE Overlay */
      .editor-header.max-hdr {
        position: fixed;
        top: 20px;
        left: 20px;
        right: 20px;
        z-index: 10002;
        border-radius: 10px 10px 0 0;
        background: var(--surface);
        border: 1px solid var(--border-strong);
        border-bottom: 1px solid var(--border);
        box-shadow: 0 10px 25px rgba(0, 0, 0, 0.35);
        padding: 10px 16px;
      }

      .editor-body-wrap.maximized-body {
        position: fixed;
        top: 61px;
        left: 20px;
        right: 20px;
        bottom: 20px;
        height: auto;
        z-index: 10002;
        border-radius: 0 0 10px 10px;
        border: 1px solid var(--border-strong);
        border-top: none;
        box-shadow: 0 20px 40px rgba(0, 0, 0, 0.45);
      }

      .max-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.65);
        backdrop-filter: blur(4px);
        z-index: 10001;
      }

      /* Maximized Side Drawer */
      .side-drawer {
        flex: 0 0 380px;
        border-left: 1px solid var(--border);
        background: var(--surface);
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .drawer-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        border-bottom: 1px solid var(--border);
        font-weight: 700;
        font-size: 13px;
      }
      .x-btn {
        border: none;
        background: transparent;
        cursor: pointer;
        color: var(--muted);
      }
      .x-btn:hover {
        color: var(--text);
      }

      .drawer-scroll {
        flex: 1;
        overflow-y: auto;
        padding: 16px;
      }

      .section-title {
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        color: var(--muted);
        letter-spacing: 0.5px;
        margin-bottom: 10px;
      }
      .mt-4 {
        margin-top: 16px;
      }

      .snippet-grid {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .snip-card {
        text-align: left;
        border: 1px solid var(--border);
        background: var(--surface-2);
        border-radius: 7px;
        padding: 8px 10px;
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .snip-card:hover {
        border-color: var(--primary);
        background: var(--primary-50, rgba(99, 102, 241, 0.1));
      }
      .snip-lbl {
        display: block;
        font-size: 11.5px;
        font-weight: 600;
        color: var(--primary);
        margin-bottom: 3px;
      }
      .snip-card code {
        display: block;
        font-size: 11px;
        color: var(--text-secondary);
        font-family: var(--font-mono, monospace);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .drawer-markdown {
        font-size: 12px;
      }
    `,
  ],
})
export class CodeEditorComponent implements OnChanges, AfterViewInit {
  @Input() code = '';
  @Input() lang = 'js';
  @Input() placeholder = '// Write JavaScript logic here...';
  @Input() readOnly = false;
  @Input() cheatSheetContent?: string;
  @Input() javaReferenceContent?: string;

  @Output() codeChange = new EventEmitter<string>();
  @Output() openCheatSheet = new EventEmitter<string>();

  gutterPane = viewChild<ElementRef<HTMLDivElement>>('gutterPane');
  codeArea = viewChild<ElementRef<HTMLTextAreaElement>>('codeArea');

  maximized = signal(false);
  showDrawer = signal(false);
  copied = signal(false);
  cursorInfo = signal('Ln 1, Col 1');

  readonly snippets: Snippet[] = [
    {
      label: 'Bare Variable Assignment',
      desc: 'Sets or updates a flow variable directly without ceremony',
      code: 'status = "APPROVED";\namount = amount * 1.1;',
    },
    {
      label: 'The vars Object (Nested JSON)',
      desc: 'Mutates nested properties on process variables',
      code: 'vars.claim.payout = 4500;\nvars.claim.adjudicatedAt = new Date().toISOString();',
    },
    {
      label: 'Functional Get & Set',
      desc: 'Reads or writes variables using global helpers',
      code: 'const tier = getVariable("riskTier");\nsetVariable("level", tier === "HIGH" ? 2 : 1);',
    },
    {
      label: 'KieFunctions Comparisons',
      desc: 'Enterprise safe equality and boundary checks',
      code: 'if (KieFunctions.greaterThan(amount, 5000) && KieFunctions.equalsTo(status, "PENDING")) {\n  vars.isHighValue = true;\n}',
    },
    {
      label: 'Build JSON Request Payload',
      desc: 'Constructs an outgoing JSON payload object for HTTP service tasks',
      code: 'const req = {\n  caseId: instance.correlationKey,\n  amount: amount,\n  items: ["Item-A", "Item-B"],\n  timestamp: new Date().toISOString()\n};\nreqPayload = JSON.stringify(req);',
    },
    {
      label: 'Array Filter & Aggregation',
      desc: 'Standard JavaScript array filtering and reduce operations',
      code: 'const activeItems = (vars.items || []).filter(item => item.isActive);\nconst totalCost = activeItems.reduce((sum, item) => sum + (item.price || 0), 0);\nvars.summary = { count: activeItems.length, total: totalCost };',
    },
    {
      label: 'Instance Signal & Events',
      desc: 'Delivers an event to resume this process instance',
      code: 'instance.signal("DOC_RECEIVED", { docId: "D-101" });',
    },
    {
      label: 'HTTP Exit Script (Parse resPayload)',
      desc: 'Parses raw HTTP response body in service exit script',
      code: 'const res = JSON.parse(resPayload);\nvars.apiStatus = res.status;\nstatus = res.success ? "PROCESSED" : "FAILED";',
    },
    {
      label: 'Gateway Condition Recipe',
      desc: 'Multi-line boolean condition for XOR/OR gateways',
      code: 'const netAmount = requestedAmount - deductible;\nreturn netAmount > 25000 && riskRating !== "LOW";',
    },
    {
      label: 'System Audit Log',
      desc: 'Outputs to the instance execution audit log',
      code: 'console.log(`Processing case ${instance.correlationKey}: amount=${amount}`);',
    },
    {
      label: 'Abort Instance',
      desc: 'Terminates this process instance immediately',
      code: 'if (!vars.policy?.isActive) {\n  instance.abort();\n}',
    },
  ];

  readonly javaSnippets: Snippet[] = [
    {
      label: 'kcontext Read & Write',
      desc: 'Reads and writes process variables via ProcessContext',
      code: 'String caseId = (String) kcontext.getVariable("caseId");\nkcontext.setVariable("status", "APPROVED");',
    },
    {
      label: 'Signal Process Instance',
      desc: 'Delivers an event to this instance to resume waiting nodes',
      code: 'kcontext.getProcessInstance().signalEvent("PAYMENT_CONFIRMED", "TX-101");',
    },
    {
      label: 'Jackson ObjectNode Builder',
      desc: 'Constructs request JSON via Jackson ObjectMapper tree model',
      code: 'com.fasterxml.jackson.databind.ObjectMapper mapper = new com.fasterxml.jackson.databind.ObjectMapper();\ncom.fasterxml.jackson.databind.node.ObjectNode req = mapper.createObjectNode();\nreq.put("caseId", (String) kcontext.getVariable("caseId"));\nkcontext.setVariable("reqPayload", req.toString());',
    },
    {
      label: 'Jackson Response Parser',
      desc: 'Parses raw HTTP response body in on-exit script',
      code: 'com.fasterxml.jackson.databind.ObjectMapper mapper = new com.fasterxml.jackson.databind.ObjectMapper();\ncom.fasterxml.jackson.databind.JsonNode res = mapper.readTree((String) kcontext.getVariable("resPayload"));\nString code = res.path("data").path("code").asText("");\nkcontext.setVariable("authCode", code);',
    },
    {
      label: 'Java Collections (ArrayList / HashMap)',
      desc: 'Constructs standard Java collections',
      code: 'java.util.List<String> list = new java.util.ArrayList<String>();\nlist.add("FirstItem");\njava.util.Map<String, Object> map = new java.util.HashMap<String, Object>();\nmap.put("total", list.size());',
    },
    {
      label: 'System Audit Log',
      desc: 'Outputs to the instance execution audit timeline',
      code: 'System.out.println("Processing case " + kcontext.getProcessInstance().getCorrelationKey());',
    },
    {
      label: 'Sequence Flow Condition Recipe',
      desc: 'Evaluates boolean routing decision in Java condition',
      code: 'return ((Number) kcontext.getVariable("amount")).doubleValue() > 1000.0;',
    },
    {
      label: 'Abort Instance',
      desc: 'Aborts this process instance via KieRuntime',
      code: 'kcontext.getKieRuntime().abortProcessInstance(kcontext.getProcessInstance().getId());',
    },
  ];

  effectiveSnippets = computed<Snippet[]>(() => {
    return this.lang === 'java' ? this.javaSnippets : this.snippets;
  });

  effectiveCheatSheetContent = computed(() => {
    if (this.lang === 'java') {
      return this.javaReferenceContent || this.cheatSheetContent || '';
    }
    return this.cheatSheetContent || '';
  });

  lineNumbers = computed<number[]>(() => {
    const text = this.code || '';
    const count = text.split('\n').length;
    return Array.from({ length: Math.max(count, 1) }, (_, i) => i + 1);
  });

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['code']) {
      this.syncGutter();
    }
  }

  ngAfterViewInit(): void {
    this.syncGutter();
  }

  @HostListener('window:keydown.escape')
  onEscape(): void {
    if (this.maximized()) {
      this.toggleMaximize();
    }
  }

  onCodeChange(val: string): void {
    this.code = val;
    this.codeChange.emit(val);
    this.syncGutter();
    this.updateCursorInfo();
  }

  onEditorScroll(): void {
    this.syncGutter();
  }

  private syncGutter(): void {
    const area = this.codeArea()?.nativeElement;
    const gutter = this.gutterPane()?.nativeElement;
    if (area && gutter) {
      gutter.scrollTop = area.scrollTop;
    }
  }

  toggleMaximize(): void {
    const next = !this.maximized();
    this.maximized.set(next);
    if (next) {
      this.showDrawer.set(true);
    }
    setTimeout(() => {
      this.codeArea()?.nativeElement?.focus();
      this.syncGutter();
    }, 50);
  }

  onCheatClick(): void {
    if (this.maximized()) {
      this.showDrawer.set(!this.showDrawer());
    } else {
      this.openCheatSheet.emit(this.lang);
    }
  }

  copyCode(): void {
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(this.code || '').then(() => {
        this.copied.set(true);
        setTimeout(() => this.copied.set(false), 2000);
      });
    }
  }

  formatCode(): void {
    if (!this.code?.trim()) return;
    try {
      // Basic automatic indentation: indent after '{' or '(', outdent before '}' or ')'
      const lines = this.code.split('\n');
      let indentLevel = 0;
      const formatted = lines.map((raw) => {
        const line = raw.trim();
        if (!line) return '';
        if (/^[})\]]/.test(line)) {
          indentLevel = Math.max(0, indentLevel - 1);
        }
        const indented = '  '.repeat(indentLevel) + line;
        if (/[{([]$/.test(line) && !/^[})\]]/.test(line)) {
          indentLevel++;
        }
        return indented;
      });
      this.onCodeChange(formatted.join('\n'));
    } catch {
      // Keep original on format error
    }
  }

  onKeyDown(event: KeyboardEvent): void {
    const area = this.codeArea()?.nativeElement;
    if (!area) return;

    // Tab key indent
    if (event.key === 'Tab') {
      event.preventDefault();
      const start = area.selectionStart;
      const end = area.selectionEnd;
      const val = area.value;

      if (event.shiftKey) {
        // Shift+Tab: outdent 2 spaces if present
        if (val.substring(start - 2, start) === '  ') {
          const updated = val.substring(0, start - 2) + val.substring(end);
          this.onCodeChange(updated);
          setTimeout(() => {
            area.selectionStart = area.selectionEnd = Math.max(0, start - 2);
          });
        }
      } else {
        // Tab: insert 2 spaces
        const updated = val.substring(0, start) + '  ' + val.substring(end);
        this.onCodeChange(updated);
        setTimeout(() => {
          area.selectionStart = area.selectionEnd = start + 2;
        });
      }
    } else if (event.key === 'Enter') {
      // Auto-indent matching previous line
      const start = area.selectionStart;
      const val = area.value;
      const curLineStart = val.lastIndexOf('\n', start - 1) + 1;
      const curLine = val.substring(curLineStart, start);
      const match = curLine.match(/^(\s+)/);
      if (match && match[1]) {
        event.preventDefault();
        const indent = match[1] + (curLine.trimEnd().endsWith('{') ? '  ' : '');
        const updated = val.substring(0, start) + '\n' + indent + val.substring(start);
        this.onCodeChange(updated);
        setTimeout(() => {
          area.selectionStart = area.selectionEnd = start + 1 + indent.length;
        });
      }
    }
  }

  updateCursorInfo(): void {
    const area = this.codeArea()?.nativeElement;
    if (!area) return;
    const pos = area.selectionStart || 0;
    const textBefore = area.value.substring(0, pos);
    const lines = textBefore.split('\n');
    const lineNum = lines.length;
    const colNum = lines[lines.length - 1].length + 1;
    const totalLines = (area.value || '').split('\n').length;
    this.cursorInfo.set(`Ln ${lineNum}, Col ${colNum} • ${totalLines} lines`);
  }

  insertSnippet(snipCode: string): void {
    const area = this.codeArea()?.nativeElement;
    if (!area) {
      this.onCodeChange((this.code ? this.code + '\n\n' : '') + snipCode);
      return;
    }
    const start = area.selectionStart;
    const end = area.selectionEnd;
    const val = area.value;
    const updated = val.substring(0, start) + snipCode + val.substring(end);
    this.onCodeChange(updated);
    setTimeout(() => {
      area.focus();
      area.selectionStart = area.selectionEnd = start + snipCode.length;
      this.updateCursorInfo();
    });
  }
}
