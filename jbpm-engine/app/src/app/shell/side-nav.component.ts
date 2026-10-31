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
    /* Borderless white rail — separation comes from the content pane's tint, not a divider line. */
    .sidenav { width: var(--sidenav-w); background: var(--surface); height: 100%; display: flex; flex-direction: column; transition: width .15s; padding: 6px 0; }
    .sidenav.collapsed { width: 68px; }
    .backdrop { display: none; }
    /* Phones and small tablets: the menu is a drawer over the page instead of a column beside it. */
    @media (max-width: 900px) {
      .backdrop { display: block; position: fixed; inset: 0; background: rgba(0, 0, 0, .5); z-index: 299; }
      .sidenav, .sidenav.collapsed { position: fixed; z-index: 300; top: 0; bottom: 0; left: 0; width: min(290px, 86vw); transform: translateX(-102%); transition: transform .2s ease; box-shadow: 0 0 40px rgba(0, 0, 0, .5); }
      .sidenav.open { transform: none; }
      .collapse { display: none; }
    }
    .brand { display: flex; align-items: center; gap: 10px; padding: 14px 18px 16px; }
    /* Collapsed: no brand-name to fill the row, so the logo + toggle + collapse button (the toggle's
       margin-left:auto especially) would otherwise overflow/overlap a 68px rail — stack them instead. */
    .sidenav.collapsed .brand { flex-direction: column; padding: 14px 6px 12px; gap: 8px; }
    .sidenav.collapsed .theme-toggle, .sidenav.collapsed .collapse { margin-left: 0; }
    .logo { width: 30px; height: 30px; display: grid; place-items: center; background: var(--grad-brand); color: #fff; border-radius: 10px; font-weight: 800; box-shadow: 0 6px 14px -6px rgba(139, 92, 246, .9); }
    .brand-name { font-weight: 700; letter-spacing: -.02em; }
    .theme-toggle { margin-left: auto; border: none; background: transparent; border-radius: var(--radius-xs); width: 28px; height: 28px; display: grid; place-items: center; cursor: pointer; color: var(--muted); font-size: 13px; }
    .theme-toggle:hover { background: var(--surface-3); color: var(--text); }
    .collapse { border: none; background: transparent; cursor: pointer; color: var(--muted); font-size: 16px; }
    .glabel { font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); font-weight: 700; padding: 14px 22px 4px; }
    /* Both lists scroll together (a thin visible scrollbar tells people there is more) — before, only the first list scrolled and the last items were silently clipped on short screens. */
    .scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--border-strong) transparent; }
    ul { list-style: none; margin: 4px 0; padding: 0 10px; display: flex; flex-direction: column; gap: 2px; }
    /* Active state is a soft tinted pill, not a hard left border — matches the airy direction. */
    a { display: flex; align-items: center; gap: 11px; padding: 7px 12px; color: var(--text-secondary); border-radius: var(--radius-sm); font-size: 13.5px; font-weight: 500; transition: background-color .14s ease, color .14s ease; }
    a:hover { background: var(--surface-3); color: var(--text); }
    a.active { color: var(--primary); background: var(--primary-50); font-weight: 650; }
    a.active .ic { opacity: 1; }
    .ic { opacity: .7; }
    a.active .ic, a:hover .ic { opacity: 1; }
    .spacer { flex: 0 0 0; }
    .account { display: flex; align-items: center; gap: 10px; margin: 6px 10px 4px; padding: 10px 12px; border-top: 1px solid var(--border); border-radius: var(--radius-sm); }
    .avatar { flex-shrink: 0; width: 30px; height: 30px; border-radius: 50%; background: var(--grad-brand); color: #fff; display: grid; place-items: center; font-size: 12px; font-weight: 700; }
    .who { min-width: 0; flex: 1; }
    .uname { font-size: 13px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .roles { font-size: 12px; text-transform: capitalize; color: var(--muted); }
    .logout { flex-shrink: 0; padding: 4px 8px; font-size: 14px; }
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
