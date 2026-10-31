import { Injectable, signal } from '@angular/core';

/** Phone / small-tablet navigation: the side menu becomes a slide-in drawer opened from the header's menu button. */
@Injectable({ providedIn: 'root' })
export class NavDrawerService {
  open = signal(false);
  toggle() { this.open.update((v) => !v); }
  close() { this.open.set(false); }
}
