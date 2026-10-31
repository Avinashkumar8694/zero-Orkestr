import { Component, inject, isDevMode } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AuthService } from '../core/auth/auth.service';
import { TenantService } from '../core/tenant/tenant.service';
import { TenantSwitcherComponent } from './tenant-switcher.component';
import { NotificationsBellComponent } from './notifications-bell.component';
import { NavDrawerService } from './nav-drawer.service';

function roleLabel(role?: string | null): string {
  if (!role) return 'Member';
  return role
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

@Component({
  selector: 'app-header',
  standalone: true,
  imports: [CommonModule, TenantSwitcherComponent, NotificationsBellComponent],
  template: `
    <header class="header">
      <button class="menu-btn" (click)="drawer.toggle()" aria-label="Open navigation menu" [attr.aria-expanded]="drawer.open()">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
      </button>
      <div class="header-breadcrumb">
        <span class="header-badge" title="Your role in this workspace">
          {{ roleLabel(tenant.role()) }}
        </span>
        <span class="header-breadcrumb-separator">/</span>
        <app-tenant-switcher />
      </div>

      <div class="header-actions">
        @if (dev) { <span class="header-dev-badge" title="Development build">DEV</span> }
        <app-notifications-bell />
        @if (auth.user(); as u) {
          <div class="header-user" [title]="u.username">
            <div class="header-user-avatar">
              {{ u.username.slice(0, 1).toUpperCase() }}
            </div>
            <div class="header-user-text">
              <div class="header-user-name">{{ u.username }}</div>
              <div class="header-user-email">{{ u.roles.join(', ') || 'Member' }}</div>
            </div>
          </div>
        }
      </div>
    </header>
  `,
  styles: [`
    .menu-btn { display: none; flex: 0 0 auto; width: 36px; height: 36px; margin-right: 8px; place-items: center; border: 1px solid var(--border); background: transparent; color: var(--text); border-radius: var(--radius-sm); cursor: pointer; }
    .header {
      height: var(--header-h);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 24px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      position: sticky;
      top: 0;
      z-index: 100;
    }
    .header-breadcrumb {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .header-badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: var(--radius-xs);
      background: var(--surface-3);
      color: var(--text-secondary);
      font-size: 12px;
      font-weight: 650;
      text-transform: capitalize;
    }
    .header-breadcrumb-separator {
      color: var(--border-strong);
      font-size: 14px;
      font-weight: 500;
    }
    .header-actions {
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .header-dev-badge {
      font-size: 10px;
      font-weight: 750;
      padding: 2px 6px;
      background: var(--orange-bg);
      color: var(--orange);
      border: 1px solid rgba(234, 88, 12, .3);
      border-radius: var(--radius-xs);
      letter-spacing: .06em;
    }
    .header-user {
      display: flex;
      align-items: center;
      gap: 10px;
      padding-left: 12px;
      border-left: 1px solid var(--border);
    }
    .header-user-avatar {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: var(--grad-brand);
      color: #fff;
      display: grid;
      place-items: center;
      font-size: 12.5px;
      font-weight: 700;
      box-shadow: 0 4px 10px -2px rgba(124, 58, 237, .4);
    }
    .header-user-text {
      line-height: 1.25;
    }
    .header-user-name {
      font-size: 13px;
      font-weight: 650;
      color: var(--text);
    }
    .header-user-email {
      font-size: 11.5px;
      color: var(--muted);
      text-transform: capitalize;
    }
    @media (max-width: 900px) {
      .menu-btn { display: grid; }
      .header { padding: 0 12px; gap: 8px; }
      .header-breadcrumb { min-width: 0; flex: 1; }
      .header-badge, .header-breadcrumb-separator, .header-user-text, .header-dev-badge { display: none; }
      .header-actions { gap: 8px; flex: 0 0 auto; }
      app-tenant-switcher { min-width: 0; flex: 1; display: block; max-width: calc(100vw - 190px); }
      .header-user { padding-left: 0; border-left: none; }
    }
  `],
})
export class HeaderComponent {
  drawer = inject(NavDrawerService);
  auth = inject(AuthService);
  tenant = inject(TenantService);

  roleLabel = roleLabel;
  dev = isDevMode();
}
