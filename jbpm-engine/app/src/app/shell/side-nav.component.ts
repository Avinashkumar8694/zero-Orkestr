import { Component, computed, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive } from '@angular/router';
import { filter, map } from 'rxjs/operators';
import { NavDrawerService } from './nav-drawer.service';
import { AuthService } from '../core/auth/auth.service';
import { ThemeService } from '../core/theme.service';
import { TenantService } from '../core/tenant/tenant.service';
import { IconComponent } from '../shared/icon.component';

/** A dedicated single-entity detail page (instance/task detail) — as opposed to a list page. */
function isDetailRoute(url: string): boolean {
  const path = url.split('?')[0];
  return (/^\/instances\/[^/]+$/.test(path) && path !== '/instances/start') || /^\/projects\/[^/]+\/processes\/[^/]+$/.test(path) || /^\/tasks\/[^/]+$/.test(path) || /^\/workflow-instances\/[^/]+$/.test(path);
}

interface NavItem { label: string; icon: string; link: string; }

@Component({
  selector: 'app-side-nav',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, IconComponent],
  template: `
    @if (drawer.open()) { <div class="backdrop" (click)="drawer.close()"></div> }
    <nav class="sidenav" [class.collapsed]="rail()" [class.open]="drawer.open()" aria-label="Main navigation">
      <div class="brand">
        <span class="logo"><app-icon name="zap" [size]="17" /></span>
        @if (!rail()) { <span class="brand-name">Workflow</span> }
        <button class="theme-toggle" (click)="theme.toggle()" [title]="theme.theme() === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'"><app-icon [name]="theme.theme() === 'dark' ? 'sun' : 'moon'" [size]="15" /></button>
        <button class="collapse" (click)="collapsed.set(!collapsed())" title="Collapse navigation" aria-label="Collapse navigation"><app-icon name="chevronLeft" [size]="16" /></button>
      </div>
      <div class="scroll">
      <ul>
        @for (item of items(); track item.link) {
          <li>
            <a [routerLink]="item.link" routerLinkActive="active" [attr.title]="rail() ? item.label : null" [attr.aria-label]="item.label">
              <app-icon class="ic" [name]="item.icon" [size]="18" />
              @if (!rail()) { <span>{{ item.label }}</span> }
            </a>
          </li>
        }
      </ul>
      @if (governance().length) {
        @if (!rail()) { <div class="glabel">Governance</div> }
        <ul>
          @for (item of governance(); track item.link) {
            <li>
              <a [routerLink]="item.link" routerLinkActive="active" [attr.title]="rail() ? item.label : null" [attr.aria-label]="item.label">
                <app-icon class="ic" [name]="item.icon" [size]="18" />
                @if (!rail()) { <span>{{ item.label }}</span> }
              </a>
            </li>
          }
        </ul>
      }
      </div>
      <div class="spacer"></div>
      @if (auth.user(); as u) {
        <div class="account">
          <span class="avatar">{{ u.username.slice(0, 1).toUpperCase() }}</span>
          @if (!rail()) {
            <div class="who">
              <div class="uname">{{ u.username }}</div>
              <div class="roles muted">{{ tenant.role() || u.roles.join(', ') || 'Member' }}</div>
            </div>
          }
          <button class="btn ghost logout" (click)="logout()" title="Sign out" aria-label="Sign out"><app-icon name="power" [size]="15" /></button>
        </div>
      }
    </nav>
  `,
  styles: [`
    .sidenav { width: var(--sidenav-w); background: var(--surface); border-right: 1px solid var(--border); height: 100%; display: flex; flex-direction: column; transition: width .15s; padding: 0; }
    .sidenav.collapsed { width: 68px; }
    .brand { display: flex; align-items: center; gap: 10px; padding: 0 14px; height: var(--header-h); border-bottom: 1px solid var(--border); flex: 0 0 auto; }
    .sidenav.collapsed .brand { flex-direction: column; justify-content: center; height: auto; padding: 14px 6px 12px; gap: 8px; }
    .sidenav.collapsed .theme-toggle, .sidenav.collapsed .collapse { margin-left: 0; }
    .logo { width: 28px; height: 28px; display: grid; place-items: center; background: var(--grad-brand); color: #fff; border-radius: 8px; box-shadow: 0 1px 2px rgba(35, 42, 110, .35), 0 1px 0 rgba(255,255,255,.2) inset; }
    .brand-name { font-weight: 650; letter-spacing: -.02em; font-size: 15px; }
    .theme-toggle { margin-left: auto; border: none; background: transparent; border-radius: var(--radius-xs); width: 28px; height: 28px; display: grid; place-items: center; cursor: pointer; color: var(--muted); }
    .theme-toggle:hover { background: var(--surface-3); color: var(--text); }
    .collapse { border: none; background: transparent; cursor: pointer; color: var(--muted); width: 28px; height: 28px; border-radius: var(--radius-xs); display: grid; place-items: center; }
    .collapse:hover { background: var(--surface-3); color: var(--text); }
    .glabel { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); font-weight: 600; padding: 18px 22px 6px; }
    .backdrop { display: none; }
    .scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 10px 0 8px; }
    ul { list-style: none; margin: 0; padding: 0 12px; display: flex; flex-direction: column; gap: 1px; }
    /* Quiet rows; the active one gets a tonal fill and an accent bar, not a coloured block. */
    a { position: relative; display: flex; align-items: center; gap: 11px; padding: 7px 10px; color: var(--text-secondary); border-radius: var(--radius-sm); font-size: 13.5px; font-weight: 500; letter-spacing: -.005em; transition: background-color .12s ease, color .12s ease; }
    a:hover { background: var(--surface-3); color: var(--text); }
    a.active { color: var(--text); background: var(--surface-3); font-weight: 600; }
    a.active::before { content: ''; position: absolute; left: -12px; top: 7px; bottom: 7px; width: 3px; border-radius: 0 3px 3px 0; background: var(--primary); }
    .ic { opacity: .75; } a.active .ic { opacity: 1; color: var(--primary); } a:hover .ic { opacity: 1; }
    .spacer { flex: 0 0 0; }
    .account { display: flex; align-items: center; gap: 10px; margin: 0; padding: 12px 14px; border-top: 1px solid var(--border); flex: 0 0 auto; }
    .avatar { flex-shrink: 0; width: 30px; height: 30px; border-radius: 50%; background: var(--primary-50); color: var(--primary); border: 1px solid var(--primary-100); display: grid; place-items: center; font-size: 12px; font-weight: 650; }
    .who { min-width: 0; flex: 1; }
    .uname { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .roles { font-size: 12px; text-transform: capitalize; color: var(--muted); }
    .logout { flex-shrink: 0; padding: 4px 8px; }
    @media (max-width: 900px) {
      .backdrop { display: block; position: fixed; inset: 0; background: rgba(8, 10, 16, .55); backdrop-filter: blur(2px); z-index: 299; }
      .sidenav, .sidenav.collapsed { position: fixed; z-index: 300; top: 0; bottom: 0; left: 0; width: min(300px, 86vw); transform: translateX(-102%); transition: transform .2s ease; box-shadow: var(--shadow-pop); }
      .sidenav.open { transform: none; }
      .collapse { display: none; }
    }
  `],
})
export class SideNavComponent {
  auth = inject(AuthService);
  theme = inject(ThemeService);
  tenant = inject(TenantService);
  private router = inject(Router);
  drawer = inject(NavDrawerService);
  collapsed = signal(isDetailRoute(this.router.url));
  private small = window.matchMedia('(max-width: 900px)');
  private mobile = signal(this.small.matches);
  /** the icon-only rail applies to desktop widths only; in the drawer the labels always show */
  rail = computed(() => this.collapsed() && !this.mobile());

  constructor() {
    this.small.addEventListener('change', (e) => { this.mobile.set(e.matches); if (!e.matches) this.drawer.close(); });
    this.router.events.pipe(filter((e) => e instanceof NavigationEnd)).subscribe(() => this.drawer.close());
    // Auto-collapse on a single-entity detail page (more room for the diagram/tabs); auto-restore
    // once back on a list page. The manual toggle button still works, but the next navigation resets it.
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => isDetailRoute(e.urlAfterRedirects)),
    ).subscribe((detail) => this.collapsed.set(detail));
  }

  // Order mirrors the ux_design sidenav (instances-list.html): Home, Projects, Deployments,
  // Instances, Execution Errors, Jobs & Timers, Tasks, Reports & Analytics.
  items = computed<NavItem[]>(() => {
    const base: NavItem[] = [
      { label: 'Home', icon: 'home', link: '/home' },
      { label: 'Projects', icon: 'projects', link: '/projects' },
    ];
    if (this.auth.hasPermission('workflow:view')) {
      base.push({ label: 'Deployments', icon: 'deployments', link: '/deployments' });
      base.push({ label: 'Instances', icon: 'instances', link: '/instances' });
      base.push({ label: 'Execution Errors', icon: 'warning', link: '/errors' });
      base.push({ label: 'Jobs & Timers', icon: 'timer', link: '/jobs' });
    }
    if (this.auth.hasPermission('task:manage')) base.push({ label: 'Tasks', icon: 'tasks', link: '/tasks' });
    if (this.auth.hasPermission('workflowInstance:manage')) base.push({ label: 'Workflow Instances', icon: 'inbox', link: '/workflow-instances' });
    if (this.auth.hasPermission('query:read')) {
      base.push({ label: 'Reports & Analytics', icon: 'chart', link: '/reports' });
      base.push({ label: 'Workflow Analytics', icon: 'chart', link: '/workflow-analytics' });
    }
    if (this.tenant.isSystemAdmin()) base.push({ label: 'Platform limits', icon: 'settings', link: '/platform-limits' });
    return base;
  });

  /** Separate "Governance" group (mockup convention): admin/config sits apart from daily work. */
  governance = computed<NavItem[]>(() => {
    const g: NavItem[] = [];
    if (this.auth.hasPermission('admin:iam')) {
      g.push({ label: 'Admin', icon: 'admin', link: '/admin' });
      g.push({ label: 'Audit Log', icon: 'list', link: '/audit' });
    }
    if (this.auth.hasPermission('workflowInstance:admin')) g.push({ label: 'Workflow Management', icon: 'puzzle', link: '/workflow-management' });
    if (this.auth.hasPermission('team:read')) { g.push({ label: 'Team', icon: 'admin', link: '/team' }); g.push({ label: 'Plan & usage', icon: 'chart', link: '/plan' }); }
    g.push({ label: 'Settings', icon: 'settings', link: '/settings' });
    return g;
  });

  logout() {
    this.auth.signOut();
    this.router.navigateByUrl('/login');
  }
}
