import { Component, inject } from '@angular/core';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs/operators';
import { AuthService } from './core/auth/auth.service';
import { SideNavComponent } from './shell/side-nav.component';
import { HeaderComponent } from './shell/header.component';
import { ToastComponent } from './shared/toast.component';
import { ModalComponent } from './shared/modal.component';
import { ThemeService } from './core/theme.service';
import { installResponsiveTables } from './shared/responsive-tables';

/** pages that render on their own (no sidebar/header): landing, every auth screen, invitation + SSO landing, workspace setup */
const STANDALONE = ['/login', '/register', '/forgot-password', '/reset-password', '/verify-email', '/auth/callback', '/accept-invite', '/no-workspace'];
const isStandalone = (url: string) => { const u = url.split('?')[0].split('#')[0]; return u === '/' || u === '' || STANDALONE.some((p) => u === p || u.startsWith(p + '/')); };

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, SideNavComponent, HeaderComponent, ToastComponent, ModalComponent],
  template: `
    @if (isStandalonePage()) {
      <router-outlet></router-outlet>
    } @else {
      <div class="layout">
        <app-side-nav></app-side-nav>
        <div class="main">
          <app-header></app-header>
          <div class="page-content">
            <router-outlet></router-outlet>
          </div>
        </div>
      </div>
    }
    <app-toast></app-toast>
    <app-modal></app-modal>
  `,
  styles: [`
    :host { display: flex; flex-direction: column; height: 100vh; padding: 0; }
    /* Full-bleed workspace: sidebar and content meet the window edges, separated by hairlines rather than a floating rounded card. */
    /* Floating cards on a lavender canvas: sidebar card on the left, header + content on the right. */
    .layout { flex: 1; display: flex; gap: 8px; padding: 8px; min-height: 0; background: transparent; }
    .main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; background: transparent; position: relative; }
    .page-content { flex: 1; min-height: 0; overflow: auto; position: relative; border-radius: var(--radius-shell); }
    @media (max-width: 900px) { .layout { padding: 0; gap: 0; } .page-content { border-radius: 0; } }
  `],
})
export class AppComponent {
  auth = inject(AuthService);
  private router = inject(Router);
  private theme = inject(ThemeService);
  constructor() { installResponsiveTables(); }

  isStandalonePage = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => {
        return isStandalone(e.urlAfterRedirects);
      }),
    ),
    {
      initialValue: (() => {
        return isStandalone(window.location.pathname);
      })(),
    },
  );
}
