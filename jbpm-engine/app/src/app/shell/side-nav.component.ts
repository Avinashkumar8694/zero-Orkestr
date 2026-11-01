import { Component, HostListener, computed, inject, signal } from '@angular/core';
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
    .sidenav { width: var(--sidenav-w); background: var(--surface); border-radius: var(--radius-shell); box-shadow: var(--shadow-card); border: 1px solid var(--border); height: 100%; display: flex; flex-direction: column; transition: width .18s ease; overflow: hidden; }
    .sidenav.collapsed { width: 78px; }
    .brand { display: flex; align-items: center; gap: 11px; padding: 22px 20px 14px; flex: 0 0 auto; }
    .sidenav.collapsed .brand { flex-direction: column; padding: 20px 8px 10px; gap: 10px; }
    .sidenav.collapsed .theme-toggle, .sidenav.collapsed .collapse { margin-left: 0; }
    .logo { width: 36px; height: 36px; display: grid; place-items: center; background: var(--grad-brand); color: #fff; border-radius: 12px; box-shadow: 0 10px 20px -8px rgba(90, 56, 204, .8); flex: 0 0 auto; }
    .brand-name { font-weight: 800; letter-spacing: -.03em; font-size: 17px; color: var(--text); }
    .theme-toggle, .collapse { border: none; background: var(--surface-3); border-radius: 50%; width: 30px; height: 30px; display: grid; place-items: center; cursor: pointer; color: var(--muted); flex: 0 0 auto; }
    .theme-toggle { margin-left: auto; }
    .theme-toggle:hover, .collapse:hover { background: var(--primary-50); color: var(--primary); }
    .glabel { font-size: 11px; text-transform: uppercase; letter-spacing: .1em; color: var(--muted); font-weight: 700; padding: 18px 26px 6px; }
    .backdrop { display: none; }
    .scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 6px 0 8px; }
    ul { list-style: none; margin: 0; padding: 0 14px; display: flex; flex-direction: column; gap: 2px; }
    /* Quiet rows. The active one is violet (icon + label) with a soft tint and a bar on the card's right edge, as in the reference. */
    a { position: relative; display: flex; align-items: center; gap: 14px; padding: 10px 14px; color: var(--text-secondary); border-radius: 16px; font-size: 14px; font-weight: 600; transition: background-color .14s ease, color .14s ease; }
    .sidenav.collapsed a { justify-content: center; padding: 11px 0; }
    a:hover { background: var(--primary-50); color: var(--primary); }
    a.active { color: var(--primary); background: var(--primary-50); font-weight: 700; }
    a.active::after { content: ''; position: absolute; right: -14px; top: 9px; bottom: 9px; width: 4px; border-radius: 4px 0 0 4px; background: var(--primary); }
    .ic { opacity: .85; flex: 0 0 auto; } a.active .ic, a:hover .ic { opacity: 1; }
    .spacer { flex: 0 0 0; }
    .account { display: flex; align-items: center; gap: 11px; margin: 8px 14px 16px; padding: 10px 12px; border-radius: 20px; background: var(--surface-2); flex: 0 0 auto; }
    .sidenav.collapsed .account { margin: 8px 10px 14px; padding: 8px 0; flex-direction: column; background: transparent; }
    .avatar { flex-shrink: 0; width: 34px; height: 34px; border-radius: 50%; background: var(--grad-brand); color: #fff; display: grid; place-items: center; font-size: 13px; font-weight: 700; box-shadow: 0 0 0 3px var(--surface), 0 0 0 5px var(--primary-100); }
    .who { min-width: 0; flex: 1; }
    .uname { font-size: 13.5px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .roles { font-size: 12px; text-transform: capitalize; color: var(--muted); }
    .logout { flex-shrink: 0; padding: 4px 8px; }
    @media (max-width: 900px) {
      .backdrop { display: block; position: fixed; inset: 0; background: rgba(20, 14, 50, .5); backdrop-filter: blur(3px); z-index: 299; }
      .sidenav, .sidenav.collapsed { position: fixed; z-index: 300; top: 0; bottom: 0; left: 0; width: min(300px, 86vw); border-radius: 0 var(--radius-shell) var(--radius-shell) 0; transform: translateX(-102%); transition: transform .22s ease; box-shadow: var(--shadow-pop); }
      .sidenav.open { transform: none; }
      .collapse { display: none; }
      a.active::after { right: 0; }
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
    ).subscribe((e) => {
      this.collapsed.set(isDetailRoute(e.urlAfterRedirects));
    });
  }

  @HostListener('document:keydown.escape')
  onEscape() {
    if (this.drawer.open()) this.drawer.close();
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
    if (this.auth.hasPermission('query:read')) {
      base.push({ label: 'Reports & Exports', icon: 'file', link: '/reports' });
    }
    if (this.auth.hasPermission('analytics:query')) base.push({ label: 'Analytics builder', icon: 'chart', link: '/analytics' });
    if (this.tenant.isPlatformAdmin()) base.push({ label: 'Plans & platform limits', icon: 'settings', link: '/platform-limits' });
    return base;
  });

  /** Separate "Governance" group (mockup convention): admin/config sits apart from daily work. */
  governance = computed<NavItem[]>(() => {
    const g: NavItem[] = [];
    if (this.auth.hasPermission('admin:iam')) {
      g.push({ label: 'Admin', icon: 'admin', link: '/admin' });
      g.push({ label: 'Audit Log', icon: 'list', link: '/audit' });
    }
    if (this.auth.hasPermission('workflowInstance:admin')) g.push({ label: 'Workflow Definitions', icon: 'puzzle', link: '/workflow-management' });
    if (this.auth.hasPermission('team:read')) { g.push({ label: 'Team', icon: 'admin', link: '/team' }); g.push({ label: 'Plan & usage', icon: 'chart', link: '/plan' }); }
    g.push({ label: 'Integration Guide', icon: 'terminal', link: '/integration-guide' });
    g.push({ label: 'Settings', icon: 'settings', link: '/settings' });
    return g;
  });

  logout() {
    this.auth.signOut();
    this.router.navigateByUrl('/login');
  }
}
