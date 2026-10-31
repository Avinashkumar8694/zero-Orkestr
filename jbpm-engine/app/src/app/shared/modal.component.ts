import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ModalService } from './modal.service';

@Component({
  selector: 'app-modal',
  standalone: true,
  imports: [FormsModule],
  template: `
    @if (modal.state(); as s) {
      <div class="scrim" (click)="cancel()">
        <div class="dialog" (click)="$event.stopPropagation()" role="dialog" aria-modal="true">
          @if (s.title) { <h3>{{ s.title }}</h3> }
          @if (s.kind === 'confirm') {
            <p>{{ s.message }}</p>
          } @else {
            @if (s.message) { <p>{{ s.message }}</p> }
            @if (s.options && s.options.length) {
              <input
                [ngModel]="s.value"
                (ngModelChange)="modal.updatePromptValue($event)"
                list="modal-prompt-datalist"
                class="modal-input"
                [placeholder]="s.placeholder || 'Type to search or select an option...'"
                autocomplete="off"
                autocorrect="off"
                autocapitalize="off"
                spellcheck="false"
                (keyup.enter)="confirmPrompt(s.value)"
                autofocus
              />
              <datalist id="modal-prompt-datalist">
                @for (opt of s.options; track opt) {
                  <option [value]="opt"></option>
                }
              </datalist>
            } @else {
              <input
                [ngModel]="s.value"
                (ngModelChange)="modal.updatePromptValue($event)"
                [placeholder]="s.placeholder || ''"
                (keyup.enter)="confirmPrompt(s.value)"
                autofocus
              />
            }
          }
          <div class="actions">
            <button class="btn" (click)="cancel()">{{ (s.kind === 'confirm' ? s.cancelLabel : null) || 'Cancel' }}</button>
            @if (s.kind === 'confirm') {
              <button class="btn" [class.primary]="!s.danger" [class.danger]="s.danger" (click)="modal.resolve(true)">{{ s.confirmLabel || 'Confirm' }}</button>
            } @else {
              <button class="btn primary" (click)="confirmPrompt(s.value)">{{ s.confirmLabel || 'OK' }}</button>
            }
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .scrim { position: fixed; inset: 0; background: rgba(15, 17, 26, .38); display: grid; place-items: center; z-index: 2000; animation: fade-in .12s ease-out; }
    .dialog { width: 380px; max-width: calc(100vw - 32px); background: var(--surface); border-radius: var(--radius); box-shadow: var(--shadow-pop); padding: 20px; animation: pop-in .14s ease-out; }
    h3 { margin: 0 0 8px; font-size: 15px; }
    p { margin: 0 0 14px; font-size: 13px; color: var(--text-secondary); white-space: pre-line; }
    input, .modal-select { width: 100%; margin-bottom: 14px; }
    .modal-select { padding: 8px 10px; border-radius: var(--radius); border: 1px solid var(--border); background: var(--surface); color: var(--text); font-size: 13.5px; }
    .actions { display: flex; justify-content: flex-end; gap: 8px; }
    @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
    @keyframes pop-in { from { opacity: 0; transform: translateY(4px) scale(.98); } to { opacity: 1; transform: none; } }
  `],
})
export class ModalComponent {
  modal = inject(ModalService);
  cancel() { this.modal.resolve(this.modal.state()?.kind === 'prompt' ? null : false); }
  confirmPrompt(value: string) { this.modal.resolve(value.trim() || null); }
}
