import { ChangeDetectionStrategy, Component, Input, computed, signal } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { inject } from '@angular/core';

/**
 * Inline SVG icon set (Lucide geometry, ISC-licensed, redrawn here so there's no runtime dep).
 *
 * Replaces the emoji glyphs the UI used to render in chrome. Emoji were a real defect, not a taste
 * call: they render as a different vendor artwork on every OS (so the sidenav's colour changed per
 * machine), they cannot inherit `currentColor` — so they never adapt to dark mode, a danger-red
 * button, or a disabled state — and screen readers announce them inconsistently (JAWS frequently
 * skips them entirely). A stroke icon inheriting `currentColor` fixes all three.
 *
 * Every path is drawn on a 24×24 grid with a 2px stroke, scaled via the `size` input. Default 16px
 * suits dense table/toolbar contexts; use 20px in nav and primary buttons.
 */
type IconName = keyof typeof PATHS;

/** `d` attributes only — all rendered with fill:none, stroke:currentColor, round caps/joins. */
const PATHS = {
  // ── navigation ────────────────────────────────────────────────────────────
  menu:       'M3 12h18M3 6h18M3 18h18',
  projects:   'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
  deployments:'M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09zM12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z',
  instances:  'M22 12h-4l-3 9L9 3l-3 9H2',
  tasks:      'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
  admin:      'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  settings:   'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  // ── actions ───────────────────────────────────────────────────────────────
  plus:       'M12 5v14M5 12h14',
  refresh:    'M23 4v6h-6M1 20v-6h6M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15',
  trash:      'M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6',
  edit:       'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z',
  check:      'M20 6L9 17l-5-5',
  close:      'M18 6L6 18M6 6l12 12',
  search:     'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35',
  download:   'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  upload:     'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
  lock:       'M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2zM7 11V7a5 5 0 0 1 10 0v4',
  undo:       'M3 7v6h6M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13',
  play:       'M5 3l14 9-14 9V3z',
  build:      'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
  power:      'M18.36 6.64a9 9 0 1 1-12.73 0M12 2v10',
  more:       'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM12 6a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM12 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  maximize:   'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7',
  minimize:   'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7',
  copy:       'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z',
  chevronLeft:'M15 18l-6-6 6-6',
  chevronRight:'M9 18l6-6-6-6',
  chevronDown:'M6 9l6 6 6-6',
  arrowLeft:  'M19 12H5M12 19l-7-7 7-7',
  arrowRight: 'M5 12h14M12 5l7 7-7 7',
  cornerDownRight: 'M15 10l5 5-5 5M4 4v7a4 4 0 0 0 4 4h12',
  // ── status ────────────────────────────────────────────────────────────────
  warning:    'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01',
  error:      'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM15 9l-6 6M9 9l6 6',
  success:    'M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4L12 14.01l-3-3',
  info:       'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
  clock:      'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  // ── domain ────────────────────────────────────────────────────────────────
  user:       'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  users:      'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  shield:     'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  code:       'M16 18l6-6-6-6M8 6l-6 6 6 6',
  globe:      'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z',
  mail:       'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM22 6l-10 7L2 6',
  branch:     'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM15 9a9 9 0 0 1-9 9',
  file:       'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8',
  folder:     'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z',
  inbox:      'M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
  puzzle:     'M19.44 12.99l-.01.02c.1-.35.16-.72.16-1.1 0-2.21-1.79-4-4-4-.38 0-.75.06-1.1.16l.02-.01V6a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v2.06l.02.01A3.99 3.99 0 0 0 7.4 7.9c-2.21 0-4 1.79-4 4 0 .38.06.75.16 1.1l-.01-.02H2a2 2 0 0 0 0 4h1.55l-.01.02c-.1.35-.16.72-.16 1.1 0 2.21 1.79 4 4 4',
  moon:       'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z',
  sun:        'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42',
  zap:        'M13 2L3 14h9l-1 8 10-12h-9l1-8z',
  bell:       'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0',
  chart:      'M3 3v18h18M18 17V9M13 17V5M8 17v-3',
  timer:      'M10 2h4M12 14l3-3M12 22a8 8 0 1 0 0-16 8 8 0 0 0 0 16z',
  calendar:   'M19 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zM16 2v4M8 2v4M3 10h18',
  columns:    'M12 3h7a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-7m0-18H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7m0-18v18',
  list:       'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  home:       'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM9 22V12h6v10',
  terminal:   'M4 17l6-6-6-6M12 19h8',
  move:       'M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20',
} as const;

@Component({
  selector: 'app-icon',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<svg
      [attr.width]="size" [attr.height]="size" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" [attr.stroke-width]="strokeWidth"
      stroke-linecap="round" stroke-linejoin="round"
      [attr.aria-hidden]="label ? null : 'true'"
      [attr.role]="label ? 'img' : null"
      [attr.aria-label]="label || null"
      [innerHTML]="markup()"></svg>`,
  styles: [`
    :host { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
    svg { display: block; }
  `],
})
export class IconComponent {
  private sanitizer = inject(DomSanitizer);
  private _name = signal<IconName | string>('info');

  /** Icon key. An unknown name renders nothing rather than throwing. */
  @Input({ required: true }) set name(v: IconName | string) { this._name.set(v); }
  /** Pixel box. 16 for dense table/toolbar use, 20 for nav and primary buttons. */
  @Input() size = 16;
  @Input() strokeWidth = 2;
  /**
   * Accessible name. Leave unset for decorative icons that sit beside visible text — those get
   * aria-hidden so screen readers don't announce them twice. Set it for icon-only controls.
   */
  @Input() label = '';

  markup = computed<SafeHtml>(() => {
    const d = (PATHS as Record<string, string>)[this._name()];
    return this.sanitizer.bypassSecurityTrustHtml(d ? `<path d="${d}"/>` : '');
  });
}
