import { Component, inject } from '@angular/core';
import { TenantService } from '../../core/tenant/tenant.service';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { BreadcrumbComponent } from '../../shared/breadcrumb.component';

// Persistent chrome for the Admin area — same shell+router-outlet pattern as ProjectShellComponent,
// so Users/Roles/Groups are real routed pages (deep-linkable, independently code-split) instead of an
// in-memory tab-switch.
@Component({
  selector: 'app-admin-shell',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, RouterOutlet, BreadcrumbComponent],
  template: `
    <div class="admin">
      <div class="crumbwrap"><app-breadcrumb [crumbs]="[{ label: 'Admin' }]" /></div>
      <header class="ahead"><h1>Admin</h1>
        <p class="muted scope">Users, roles and groups here belong to <b>{{ workspaceName() }}</b> only — other workspaces have their own.</p>
        @if (platformView()) { <p class="warn">Platform view is read-only for users, roles and groups. Switch to a specific workspace (top bar) to change them.</p> }
      </header>
      <nav class="tabs">
        <a routerLink="users" routerLinkActive="active">Users</a>
        <a routerLink="roles" routerLinkActive="active">Roles</a>
        <a routerLink="groups" routerLinkActive="active">Groups</a>
      </nav>
      <div class="tabbody"><router-outlet /></div>
    </div>
  `,
  styles: [`
    .admin { padding: 0; }
    .crumbwrap { padding: 12px 22px 0; }
    .ahead { padding: 10px 22px 14px; }
    h1 { font-size: 20px; margin: 0; }
    .scope { margin: 4px 0 0; font-size: 13px; } .warn { margin: 8px 0 0; padding: 8px 12px; border-radius: 8px; font-size: 13px; background: var(--amber-bg, #fff4d6); color: var(--amber, #8a5a00); }
    .tabs { display: flex; gap: 4px; padding: 0 22px; background: var(--surface); border-bottom: 1px solid var(--border); }
    .tabs a { border: none; background: transparent; padding: 12px 14px; font-size: 13px; font-weight: 600; color: var(--muted); cursor: pointer; border-bottom: 2px solid transparent; }
    .tabs a:hover { color: var(--text); } .tabs a.active { color: var(--primary); border-bottom-color: var(--primary); }
    .tabbody { padding: 22px; }
  `],
})
export class AdminShellComponent {
  private tenant = inject(TenantService);
  platformView = () => this.tenant.tenantId() === 'all';
  workspaceName = () => this.tenant.tenant()?.name || this.tenant.tenantInfo()?.name || 'this workspace';
}
