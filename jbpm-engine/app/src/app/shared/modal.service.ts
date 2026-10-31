import { Injectable, signal } from '@angular/core';

export interface ConfirmOptions { title?: string; message: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean; }
export interface PromptOptions { title?: string; message?: string; initialValue?: string; placeholder?: string; confirmLabel?: string; options?: string[]; }
type ModalState =
  | ({ kind: 'confirm' } & ConfirmOptions)
  | ({ kind: 'prompt'; value: string } & PromptOptions);

// Imperative confirm()/prompt() replacements — native browser dialogs (blocking, unstyled, look like a
// crashed app next to everything else) replaced with an in-app overlay matching the rest of the design
// system. Usage mirrors the native functions but returns a Promise: `if (await modal.confirm({message}))`.
// Rendered once at the app root (<app-modal>, alongside <app-toast>) — components only inject the
// service, never import the component.
@Injectable({ providedIn: 'root' })
export class ModalService {
  state = signal<ModalState | null>(null);
  private resolver?: (value: any) => void;

  confirm(opts: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolver = resolve;
      this.state.set({ kind: 'confirm', ...opts });
    });
  }
  prompt(opts: PromptOptions): Promise<string | null> {
    return new Promise((resolve) => {
      this.resolver = resolve;
      this.state.set({ kind: 'prompt', value: opts.initialValue || '', ...opts });
    });
  }
  updatePromptValue(value: string) {
    const s = this.state();
    if (s?.kind === 'prompt') this.state.set({ ...s, value });
  }
  resolve(value: any) {
    this.resolver?.(value);
    this.resolver = undefined;
    this.state.set(null);
  }
}
