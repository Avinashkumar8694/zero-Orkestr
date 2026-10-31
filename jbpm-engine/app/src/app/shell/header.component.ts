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
    .header { height: var(--header-h); display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 22px; background: transparent; position: sticky; top: 0; z-index: 100; }
    .menu-btn { display: none; flex: 0 0 auto; width: 40px; height: 40px; margin-right: 4px; place-items: center; border: 0; background: var(--surface); color: var(--primary); border-radius: 50%; box-shadow: var(--shadow-card); cursor: pointer; }
    .header-breadcrumb { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .header-badge { display: inline-block; padding: 6px 14px; border-radius: var(--radius-pill); background: var(--surface); box-shadow: var(--shadow-card); color: var(--primary); font-size: 12.5px; font-weight: 700; text-transform: capitalize; }
    .header-breadcrumb-separator { color: var(--border-strong); font-size: 14px; }
    .header-actions { display: flex; align-items: center; gap: 12px; }
    .header-dev-badge { font-size: 10.5px; font-weight: 800; padding: 4px 9px; background: var(--orange-bg); color: var(--orange); border-radius: var(--radius-pill); letter-spacing: .08em; }
    .header-user { display: flex; align-items: center; gap: 10px; padding: 5px 16px 5px 5px; border-radius: var(--radius-pill); background: var(--surface); box-shadow: var(--shadow-card); }
    .header-user-avatar { width: 34px; height: 34px; border-radius: 50%; background: var(--grad-brand); color: #fff; display: grid; place-items: center; font-size: 13px; font-weight: 700; box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px var(--primary-100); }
    .header-user-text { line-height: 1.25; }
    .header-user-name { font-size: 13px; font-weight: 700; color: var(--text); }
    .header-user-email { font-size: 11.5px; color: var(--muted); text-transform: capitalize; }
    @media (max-width: 900px) {
      .menu-btn { display: grid; }
      .header { padding: 0 12px; gap: 8px; }
      .header-breadcrumb { flex: 1; min-width: 0; overflow: hidden; }
      .header-badge, .header-breadcrumb-separator, .header-user-text, .header-dev-badge { display: none; }
      .header-actions { gap: 8px; flex: 0 0 auto; }
      .header-user { padding: 3px; }
      app-tenant-switcher { min-width: 0; display: block; max-width: 100%; }
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
