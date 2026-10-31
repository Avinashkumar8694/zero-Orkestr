import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AuthService } from '../../core/auth/auth.service';
import { IconComponent } from '../../shared/icon.component';

@Component({
  selector: 'app-integration-guide',
  standalone: true,
  imports: [CommonModule, IconComponent],
  template: `
    <div class="page-container">
      <!-- Header Banner -->
      <header class="page-header">
        <div class="header-content">
          <div class="badge-row">
            <span class="badge primary">OpenAPI 3.0</span>
            <span class="badge success">Authenticated Session Active</span>
            <span class="badge neutral">v1.0.0</span>
          </div>
          <h1 class="page-title">Developer Integration & API Guide</h1>
          <p class="page-subtitle">
            Integrate client web applications, portal frontends, insurance claim intake pipelines, and external webhook services directly with the BPM Workflow Engine.
          </p>
        </div>
        <div class="header-actions">
          <button class="btn primary" (click)="openSwaggerUi()">
            <app-icon name="globe" [size]="15" />
            <span>Open Interactive Swagger UI</span>
          </button>
          <button class="btn secondary" (click)="downloadOpenApiJson()">
            <app-icon name="file" [size]="15" />
            <span>Download OpenAPI Spec</span>
          </button>
        </div>
      </header>

      <!-- Active Token & Session Card -->
      <section class="card token-card">
        <div class="card-header">
          <div class="card-title-row">
            <app-icon name="shield" [size]="17" class="accent-icon" />
            <h3>Active Session Bearer Token</h3>
          </div>
          <span class="pill-info">Signed as: <strong>{{ currentUser()?.username || 'user' }}</strong> (Roles: {{ (currentUser()?.roles || []).join(', ') || 'user' }})</span>
        </div>
        <p class="card-desc">
          Use your active JWT Bearer token below to authenticate API calls from Postman, cURL, or automated scripts. Pass this token in the HTTP <code>Authorization</code> header.
        </p>
        <div class="token-box">
          <div class="token-text" [title]="activeToken()">
            {{ maskedToken() }}
          </div>
          <div class="token-actions">
            <button class="btn outline sm" (click)="copyToken()">
              <app-icon name="list" [size]="13" />
              <span>{{ tokenCopied() ? 'Copied!' : 'Copy Token' }}</span>
            </button>
            <button class="btn outline sm" (click)="copyCurlHeader()">
              <app-icon name="terminal" [size]="13" />
              <span>{{ headerCopied() ? 'Copied Header!' : 'Copy Auth Header' }}</span>
            </button>
          </div>
        </div>
      </section>

      <!-- Navigation Tabs -->
      <nav class="tabs" role="tablist">
        <button
          [class.active]="activeTab() === 'quickstart'"
          (click)="activeTab.set('quickstart')">
          <app-icon name="zap" [size]="15" />
          <span>Quickstart & Auth</span>
        </button>
        <button
          [class.active]="activeTab() === 'claims'"
          (click)="activeTab.set('claims')">
          <app-icon name="projects" [size]="15" />
          <span>Claims Intake & Workflow</span>
        </button>
        <button
          [class.active]="activeTab() === 'tasks'"
          (click)="activeTab.set('tasks')">
          <app-icon name="tasks" [size]="15" />
          <span>Human Task Workbench</span>
        </button>
        <button
          [class.active]="activeTab() === 'events'"
          (click)="activeTab.set('events')">
          <app-icon name="timer" [size]="15" />
          <span>Signals & WebSockets</span>
        </button>
        <button
          [class.active]="activeTab() === 'code'"
          (click)="activeTab.set('code')">
          <app-icon name="code" [size]="15" />
          <span>Multi-Language SDKs</span>
        </button>
      </nav>

      <!-- TAB 1: QUICKSTART & AUTH -->
      @if (activeTab() === 'quickstart') {
        <div class="tab-pane">
          <div class="section-block">
            <h2>1. Authentication & Bearer Token Flow</h2>
            <p>
              The engine uses stateless JSON Web Tokens (JWT) signed with HS256. Every REST request to <code>/api/*</code> must include the Authorization header, except the unauthenticated login endpoint:
            </p>

            <div class="code-wrapper">
              <div class="code-header">
                <span>cURL — Generate JWT Token</span>
                <button class="btn-copy" (click)="copySnippet(authCurl)">Copy</button>
              </div>
              <pre><code>{{ authCurl }}</code></pre>
            </div>

            <div class="callout tip">
              <strong>Tip: Direct Browser Viewing</strong>
              <p>To view Swagger UI directly in your browser, visit <code>/api/docs?token=&lt;YOUR_TOKEN&gt;</code>. The token in the query string validates the session and automatically configures Swagger UI to authenticate all "Try it out" requests.</p>
            </div>

            <h3>Security & Ephemeral In-Transit Cryptography</h3>
            <p>
              For high-security operations (such as initial login and transmission of sensitive policy PII), fetch the temporary RSA-OAEP public key from <code>GET /api/crypto/public-key</code> and encrypt values client-side. The server decrypts them using its in-memory private key.
            </p>
          </div>
        </div>
      }

      <!-- TAB 2: CLAIMS INTAKE & WORKFLOW -->
      @if (activeTab() === 'claims') {
        <div class="tab-pane">
          <div class="section-block">
            <h2>2. Claims Intake & Instance Execution</h2>
            <p>
              Launch a process instance by providing the deployed project ID (or workflow definition), process ID, and business variables:
            </p>

            <div class="code-wrapper">
              <div class="code-header">
                <span>POST /api/instances — Start Process Instance</span>
                <button class="btn-copy" (click)="copySnippet(startProcessCurl)">Copy</button>
              </div>
              <pre><code>{{ startProcessCurl }}</code></pre>
            </div>

            <h3>Tracking Execution Progress & Active Nodes</h3>
            <p>
              Query the current execution diagram state at any time to highlight active tokens and visited path history on the diagram:
            </p>
            <div class="code-wrapper">
              <div class="code-header">
                <span>GET /api/instances/:id/diagram-state</span>
                <button class="btn-copy" (click)="copySnippet(diagramCurl)">Copy</button>
              </div>
              <pre><code>{{ diagramCurl }}</code></pre>
            </div>
          </div>
        </div>
      }

      <!-- TAB 3: HUMAN TASK WORKBENCH -->
      @if (activeTab() === 'tasks') {
        <div class="tab-pane">
          <div class="section-block">
            <h2>3. Human Tasks & Assessor Workbench Integration</h2>
            <p>
              When a workflow reaches a User Task (such as <em>Claims Assessor Review</em> or <em>Senior Manager Approval</em>), it generates a task with candidate groups or users:
            </p>

            <div class="grid-two">
              <div class="code-wrapper">
                <div class="code-header">
                  <span>1. Fetch Ready Tasks for Group</span>
                  <button class="btn-copy" (click)="copySnippet(listTasksCurl)">Copy</button>
                </div>
                <pre><code>{{ listTasksCurl }}</code></pre>
              </div>

              <div class="code-wrapper">
                <div class="code-header">
                  <span>2. Claim Task</span>
                  <button class="btn-copy" (click)="copySnippet(claimTaskCurl)">Copy</button>
                </div>
                <pre><code>{{ claimTaskCurl }}</code></pre>
              </div>
            </div>

            <div class="code-wrapper" style="margin-top: 14px;">
              <div class="code-header">
                <span>3. Complete Task with Output Variables</span>
                <button class="btn-copy" (click)="copySnippet(completeTaskCurl)">Copy</button>
              </div>
              <pre><code>{{ completeTaskCurl }}</code></pre>
            </div>
          </div>
        </div>
      }

      <!-- TAB 4: SIGNALS & WEBSOCKETS -->
      @if (activeTab() === 'events') {
        <div class="tab-pane">
          <div class="section-block">
            <h2>4. Asynchronous Signals & Realtime Event Streams</h2>
            <p>
              Resume waiting boundary catch events, intermediate message catches, or external document intake webhooks:
            </p>

            <div class="code-wrapper">
              <div class="code-header">
                <span>POST /api/instances/:id/signal — Deliver Event Signal</span>
                <button class="btn-copy" (click)="copySnippet(signalCurl)">Copy</button>
              </div>
              <pre><code>{{ signalCurl }}</code></pre>
            </div>

            <h3>Realtime WebSockets</h3>
            <p>
              Connect to <code>ws://&lt;host&gt;/api/ws?token=&lt;JWT_TOKEN&gt;</code> to stream live instance transitions:
            </p>
            <div class="code-wrapper">
              <div class="code-header">
                <span>WebSocket Subscription Protocol</span>
                <button class="btn-copy" (click)="copySnippet(wsPayload)">Copy</button>
              </div>
              <pre><code>{{ wsPayload }}</code></pre>
            </div>
          </div>
        </div>
      }

      <!-- TAB 5: MULTI-LANGUAGE CODE -->
      @if (activeTab() === 'code') {
        <div class="tab-pane">
          <div class="section-block">
            <h2>5. Ready-to-Run Multi-Language Code Snippets</h2>
            <div class="lang-selector">
              <button class="lang-btn" [class.active]="selectedLang() === 'js'" (click)="selectedLang.set('js')">JavaScript / Node.js</button>
              <button class="lang-btn" [class.active]="selectedLang() === 'python'" (click)="selectedLang.set('python')">Python</button>
              <button class="lang-btn" [class.active]="selectedLang() === 'java'" (click)="selectedLang.set('java')">Java</button>
            </div>

            @if (selectedLang() === 'js') {
              <div class="code-wrapper">
                <div class="code-header">
                  <span>Node.js (Fetch API)</span>
                  <button class="btn-copy" (click)="copySnippet(jsSnippet)">Copy</button>
                </div>
                <pre><code>{{ jsSnippet }}</code></pre>
              </div>
            }

            @if (selectedLang() === 'python') {
              <div class="code-wrapper">
                <div class="code-header">
                  <span>Python (requests)</span>
                  <button class="btn-copy" (click)="copySnippet(pythonSnippet)">Copy</button>
                </div>
                <pre><code>{{ pythonSnippet }}</code></pre>
              </div>
            }

            @if (selectedLang() === 'java') {
              <div class="code-wrapper">
                <div class="code-header">
                  <span>Java (java.net.http.HttpClient)</span>
                  <button class="btn-copy" (click)="copySnippet(javaSnippet)">Copy</button>
                </div>
                <pre><code>{{ javaSnippet }}</code></pre>
              </div>
            }
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    .page-container {
      max-width: 1140px;
      margin: 0 auto;
      padding: 24px 28px 48px;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    .page-header {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: 24px 28px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 24px;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
    }
    .badge-row { display: flex; gap: 8px; margin-bottom: 8px; }
    .badge {
      font-size: 11px; font-weight: 700; padding: 3px 8px; border-radius: 4px; text-transform: uppercase; letter-spacing: 0.04em;
    }
    .badge.primary { background: #e0e7ff; color: #4338ca; }
    .badge.success { background: #dcfce7; color: #15803d; }
    .badge.neutral { background: #f1f5f9; color: #475569; }
    .page-title { font-size: 24px; font-weight: 750; margin: 0 0 6px; color: var(--text); letter-spacing: -0.02em; }
    .page-subtitle { font-size: 13.5px; color: var(--muted); margin: 0; max-width: 650px; line-height: 1.5; }
    .header-actions { display: flex; gap: 10px; flex-shrink: 0; }

    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: 20px 24px;
    }
    .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
    .card-title-row { display: flex; align-items: center; gap: 8px; }
    .card-title-row h3 { margin: 0; font-size: 15px; font-weight: 700; color: var(--text); }
    .accent-icon { color: var(--primary); }
    .pill-info { font-size: 12px; color: var(--muted); background: var(--surface-2); padding: 4px 10px; border-radius: 6px; }
    .card-desc { font-size: 12.5px; color: var(--muted); margin: 0 0 12px; line-height: 1.45; }

    .token-box {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: #0f172a;
      border-radius: 8px;
      padding: 10px 14px;
      gap: 16px;
    }
    .token-text {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12.5px;
      color: #38bdf8;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .token-actions { display: flex; gap: 8px; flex-shrink: 0; }
    .btn.outline.sm {
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.2);
      color: #fff;
      padding: 5px 10px;
      font-size: 11.5px;
      border-radius: 5px;
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
    }
    .btn.outline.sm:hover { background: rgba(255, 255, 255, 0.18); }

    .tab-pane {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: 24px 28px;
    }
    .section-block h2 { font-size: 18px; font-weight: 700; margin: 0 0 10px; color: var(--text); }
    .section-block h3 { font-size: 14.5px; font-weight: 650; margin: 20px 0 8px; color: var(--text); }
    .section-block p { font-size: 13px; color: var(--muted); line-height: 1.5; margin: 0 0 14px; }

    .code-wrapper {
      background: #0f172a;
      border-radius: 8px;
      overflow: hidden;
      margin-bottom: 16px;
      border: 1px solid #1e293b;
    }
    .code-header {
      background: #1e293b;
      padding: 8px 14px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      color: #94a3b8;
      font-size: 12px;
      font-weight: 600;
    }
    .btn-copy {
      background: transparent;
      border: 1px solid #334155;
      color: #cbd5e1;
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 11px;
      cursor: pointer;
    }
    .btn-copy:hover { background: #334155; color: #fff; }
    pre {
      margin: 0;
      padding: 14px 16px;
      overflow-x: auto;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      line-height: 1.5;
      color: #e2e8f0;
    }

    .callout {
      border-radius: 8px;
      padding: 14px 16px;
      margin: 16px 0;
      font-size: 13px;
    }
    .callout.tip { background: #f0fdf4; border: 1px solid #bbf7d0; color: #166534; }
    .callout.tip p { margin: 4px 0 0; color: #15803d; }

    .grid-two { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    .lang-selector { display: flex; gap: 8px; margin-bottom: 14px; }
    .lang-btn {
      padding: 6px 14px; border-radius: 6px; border: 1px solid var(--border);
      background: var(--surface); color: var(--muted); font-size: 12.5px; font-weight: 600; cursor: pointer;
    }
    .lang-btn.active { background: var(--primary); color: #fff; border-color: var(--primary); }

    .btn.primary {
      background: var(--primary); color: #fff; border: none; padding: 8px 16px;
      border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer;
      display: flex; align-items: center; gap: 6px;
    }
    .btn.primary:hover { opacity: 0.92; }
    .btn.secondary {
      background: var(--surface-2); color: var(--text); border: 1px solid var(--border);
      padding: 8px 16px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer;
      display: flex; align-items: center; gap: 6px;
    }
    .btn.secondary:hover { background: var(--surface-3); }

    @media (max-width: 900px) {
      .page-header { flex-direction: column; align-items: flex-start; }
      .grid-two { grid-template-columns: 1fr; }
    }
      .page-header { flex-wrap: wrap; gap: 16px; }
    .header-content { min-width: 0; flex: 1 1 320px; }
    .header-actions { flex-wrap: wrap; flex-shrink: 1; }
    .page-subtitle { max-width: 100%; }
      .badge-row { flex-wrap: wrap; }
  `],
})
export class IntegrationGuideComponent {
  auth = inject(AuthService);
  currentUser = computed(() => this.auth.user());
  activeToken = computed(() => this.auth.token() || 'NO_TOKEN_ACTIVE');

  activeTab = signal<'quickstart' | 'claims' | 'tasks' | 'events' | 'code'>('quickstart');
  selectedLang = signal<'js' | 'python' | 'java'>('js');
  tokenCopied = signal(false);
  headerCopied = signal(false);

  maskedToken = computed(() => {
    const t = this.activeToken();
    if (t.length <= 32) return t;
    return `${t.slice(0, 16)}...${t.slice(-16)}`;
  });

  openSwaggerUi() {
    const token = this.auth.token();
    const url = token ? `/api/docs?token=${encodeURIComponent(token)}` : '/api/docs';
    window.open(url, '_blank');
  }

  downloadOpenApiJson() {
    const token = this.auth.token();
    const url = token ? `/api/openapi.json?token=${encodeURIComponent(token)}` : '/api/openapi.json';
    const a = document.createElement('a');
    a.href = url;
    a.download = 'openapi-integration.json';
    a.click();
  }

  copyToken() {
    navigator.clipboard.writeText(this.activeToken());
    this.tokenCopied.set(true);
    setTimeout(() => this.tokenCopied.set(false), 2000);
  }

  copyCurlHeader() {
    navigator.clipboard.writeText(`Authorization: Bearer ${this.activeToken()}`);
    this.headerCopied.set(true);
    setTimeout(() => this.headerCopied.set(false), 2000);
  }

  copySnippet(text: string) {
    navigator.clipboard.writeText(text);
  }

  // Snippets
  get authCurl(): string {
    return `curl -X POST "http://localhost:3000/api/auth/login" \\
  -H "Content-Type: application/json" \\
  -d '{
    "username": "admin",
    "password": "your-secure-password"
  }'

# Response:
# {
#   "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
#   "user": { "username": "admin", "roles": ["admin"] }
# }`;
  }

  get startProcessCurl(): string {
    return `curl -X POST "http://localhost:3000/api/instances" \\
  -H "Authorization: Bearer ${this.activeToken()}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "workflowId": "claims-intake-system",
    "processId": "proc_claims_assessment",
    "correlationKey": "CLM-2026-99214",
    "variables": {
      "policyNumber": "POL-99214",
      "claimant": "Jane Doe",
      "claimAmount": 50000,
      "claimType": "DeathBenefit",
      "autoAssessmentEligible": true
    }
  }'`;
  }

  get diagramCurl(): string {
    return `curl "http://localhost:3000/api/instances/<INSTANCE_ID>/diagram-state" \\
  -H "Authorization: Bearer ${this.activeToken()}"

# Response:
# {
#   "status": "running",
#   "activeNodeIds": ["task_assessor_review"],
#   "visitedNodeIds": ["start", "script_calc_risk", "gw_risk_split"]
# }`;
  }

  get listTasksCurl(): string {
    return `curl "http://localhost:3000/api/tasks?group=claims-reviewers&status=ready" \\
  -H "Authorization: Bearer ${this.activeToken()}"`;
  }

  get claimTaskCurl(): string {
    return `curl -X POST "http://localhost:3000/api/tasks/<TASK_ID>/claim" \\
  -H "Authorization: Bearer ${this.activeToken()}"`;
  }

  get completeTaskCurl(): string {
    return `curl -X POST "http://localhost:3000/api/tasks/<TASK_ID>/complete" \\
  -H "Authorization: Bearer ${this.activeToken()}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "outputs": {
      "approved": true,
      "assessmentNotes": "All medical and beneficiary proofs verified.",
      "payoutAmount": 50000
    }
  }'`;
  }

  get signalCurl(): string {
    return `curl -X POST "http://localhost:3000/api/instances/<INSTANCE_ID>/signal" \\
  -H "Authorization: Bearer ${this.activeToken()}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "DOCUMENT_UPLOADED",
    "payload": {
      "docId": "DOC-8821",
      "documentType": "DeathCertificate",
      "verified": true
    }
  }'`;
  }

  get wsPayload(): string {
    return `// 1. Connect to WebSocket Gateway with query token
const ws = new WebSocket("ws://localhost:3000/api/ws?token=${this.activeToken()}");

// 2. Subscribe to Instance Live Events
ws.onopen = () => {
  ws.send(JSON.stringify({
    op: "sub",
    topics: ["instance:<INSTANCE_ID>"]
  }));
};

// 3. Receive Live State Transitions
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  console.log("Live Event:", msg.kind, msg.data);
};`;
  }

  get jsSnippet(): string {
    return `const BASE_URL = 'http://localhost:3000/api';
const TOKEN = '${this.activeToken()}';

async function startClaimWorkflow() {
  const response = await fetch(\`\${BASE_URL}/instances\`, {
    method: 'POST',
    headers: {
      'Authorization': \`Bearer \${TOKEN}\`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      workflowId: 'claims-intake-system',
      correlationKey: 'CLM-2026-99214',
      variables: {
        policyNumber: 'POL-99214',
        claimAmount: 50000,
        claimType: 'DeathBenefit'
      }
    })
  });

  const instance = await response.json();
  console.log('Claim Process Started. Instance ID:', instance.id);
  return instance;
}

startClaimWorkflow();`;
  }

  get pythonSnippet(): string {
    return `import requests

BASE_URL = "http://localhost:3000/api"
TOKEN = "${this.activeToken()}"

headers = {
    "Authorization": f"Bearer {TOKEN}",
    "Content-Type": "application/json"
}

def start_claim():
    payload = {
        "workflowId": "claims-intake-system",
        "correlationKey": "CLM-2026-99214",
        "variables": {
            "policyNumber": "POL-99214",
            "claimAmount": 50000,
            "claimType": "DeathBenefit"
        }
    }
    r = requests.post(f"{BASE_URL}/instances", json=payload, headers=headers)
    r.raise_for_status()
    instance = r.json()
    print("Instance Started:", instance["id"], "Status:", instance["status"])
    return instance

if __name__ == "__main__":
    start_claim()`;
  }

  get javaSnippet(): string {
    return `import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

public class ClaimIntegrationClient {
    public static void main(String[] args) throws Exception {
        String token = "${this.activeToken()}";
        String body = """
            {
              "workflowId": "claims-intake-system",
              "correlationKey": "CLM-2026-99214",
              "variables": {
                "policyNumber": "POL-99214",
                "claimAmount": 50000,
                "claimType": "DeathBenefit"
              }
            }
            """;

        HttpClient client = HttpClient.newHttpClient();
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create("http://localhost:3000/api/instances"))
            .header("Authorization", "Bearer " + token)
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(body))
            .build();

        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
        System.out.println("Response Status: " + response.statusCode());
        System.out.println("Body: " + response.body());
    }
}`;
  }
}
