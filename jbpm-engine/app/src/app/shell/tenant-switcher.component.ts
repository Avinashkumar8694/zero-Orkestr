import {
  Component,
  ElementRef,
  HostListener,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { TenantService } from '../core/tenant/tenant.service';
import type { TenantSummary } from '../core/tenant/tenant.models';

function roleLabel(role?: string | null): string {
  if (!role) return 'Member';
  return role
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

@Component({
  selector: 'app-tenant-switcher',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="tenant-switcher" #root>
      @if (tenant.tenant(); as current) {
        <button
          type="button"
          class="tenant-switcher-button"
          (click)="toggle()"
          [disabled]="!switchable()"
          [attr.aria-expanded]="open()"
          [title]="switchable() ? 'Switch workspace' : current.name"
        >
          <span class="tenant-icon" aria-hidden="true">🏢</span>
          <span class="tenant-name">{{ current.name }}</span>
          <span class="tenant-role-badge">{{ current.support ? 'Support' : roleLabel(current.role) }}</span>
          @if (switchable()) {
            <span class="dropdown-arrow" aria-hidden="true">{{ open() ? '▲' : '▼' }}</span>
          }
        </button>

        @if (open()) {
          <div class="tenant-dropdown">
            <div class="tenant-search">
              <input
                #searchInput
                type="search"
                class="form-input"
                [placeholder]="tenant.isSystemAdmin() ? 'Search all workspaces...' : 'Search your workspaces...'"
                autocomplete="off"
                [(ngModel)]="query"
                (ngModelChange)="onQueryChange($event)"
                (keydown)="onKeyDown($event)"
              />
            </div>

            <div class="dropdown-header">
              @if (searching()) {
                {{ filteredOptions().length }} found
              } @else if (tenant.isSystemAdmin()) {
                Your workspaces - type to find any
              } @else {
                Your workspaces
              }
            </div>

            <div class="tenant-options" role="listbox">
              @for (entry of filteredOptions(); track entry.id; let i = $index) {
                <button
                  type="button"
                  role="option"
                  class="tenant-option"
                  [class.current]="entry.id === tenant.tenantId()"
                  [class.active]="i === cursor()"
                  (mouseenter)="cursor.set(i)"
                  (click)="choose(entry)"
                >
                  <span class="tenant-option-name">
                    {{ entry.name }}
                    <small class="tenant-option-slug">{{ entry.slug }}</small>
                  </span>
                  <span class="tenant-option-role">{{ entry.support ? 'Support' : roleLabel(entry.role) }}</span>
                  @if (entry.id === tenant.tenantId()) {
                    <span class="current-indicator" aria-hidden="true">✓</span>
                  }
                </button>
              }
              @if (filteredOptions().length === 0) {
                <div class="tenant-empty">No workspace matches "{{ query.trim() }}".</div>
              }
            </div>
          </div>
        }
      }
    </div>
  `,
  styles: [`
    .tenant-switcher {
      position: relative;
      display: block;
      max-width: 100%;
      font-family: var(--font);
    }
    .tenant-switcher-button {
      max-width: 100%;
      min-width: 0;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 7px 14px;
      background: var(--surface);
      border: 1px solid transparent;
      box-shadow: var(--shadow-card);
      border-radius: var(--radius-pill);
      color: var(--text);
      font-size: 13.5px;
      font-weight: 550;
      cursor: pointer;
      transition: background-color .15s, border-color .15s;
    }
    .tenant-switcher-button:hover:not(:disabled) {
      background: var(--primary-50);
    }
    .tenant-switcher-button:disabled {
      cursor: default;
      opacity: 0.85;
    }
    .tenant-icon { font-size: 14px; }
    .tenant-name {
      min-width: 0;
      max-width: 170px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .tenant-role-badge {
      display: inline-block;
      padding: 2px 7px;
      border-radius: 99px;
      background: var(--primary-50);
      color: var(--primary);
      font-size: 11px;
      font-weight: 650;
      text-transform: capitalize;
    }
    .dropdown-arrow {
      font-size: 10px;
      color: var(--muted);
      margin-left: 2px;
    }
    .tenant-dropdown {
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      width: 320px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow-pop);
      z-index: 1000;
      padding: 8px;
      animation: pop-in 0.14s ease-out;
    }
    @keyframes pop-in {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .tenant-search {
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border);
    }
    .form-input {
      width: 100%;
      height: 34px;
      padding: 6px 10px;
      border-radius: var(--radius-xs);
      border: 1px solid var(--border-strong);
      background: var(--surface-2);
      font-size: 13px;
      color: var(--text);
      outline: none;
      box-sizing: border-box;
    }
    .form-input:focus {
      border-color: var(--primary);
    }
    .dropdown-header {
      padding: 8px 6px 4px;
      font-size: 11px;
      font-weight: 650;
      text-transform: uppercase;
      letter-spacing: .05em;
      color: var(--muted);
    }
    .tenant-options {
      max-height: 240px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 2px;
      margin-top: 4px;
    }
    .tenant-option {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      padding: 8px 10px;
      background: transparent;
      border: none;
      border-radius: var(--radius-xs);
      cursor: pointer;
      text-align: left;
      color: var(--text);
      font-size: 13px;
      transition: background-color .1s;
    }
    .tenant-option:hover, .tenant-option.active {
      background: var(--surface-3);
    }
    .tenant-option.current {
      font-weight: 650;
      color: var(--primary);
    }
    .tenant-option-name {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    .tenant-option-slug {
      font-size: 11.5px;
      color: var(--muted);
      font-family: var(--font-mono);
    }
    .tenant-option-role {
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 99px;
      background: var(--surface-3);
      color: var(--text-secondary);
      flex-shrink: 0;
      margin-left: 8px;
    }
    .current-indicator {
      font-size: 13px;
      color: var(--primary);
      margin-left: 6px;
    }
    .tenant-empty {
      padding: 12px 8px;
      text-align: center;
      font-size: 12.5px;
      color: var(--muted);
    }
  `],
})
export class TenantSwitcherComponent {
  tenant = inject(TenantService);
  private router = inject(Router);
  private hostRef = inject(ElementRef);
  searchInput = viewChild<ElementRef<HTMLInputElement>>('searchInput');

  open = signal(false);
  query = '';
  cursor = signal(0);
  searching = signal(false);

  filteredOptions = signal<TenantSummary[]>([]);

  roleLabel = roleLabel;

  switchable = () =>
    this.tenant.tenants().length > 1 || this.tenant.isSystemAdmin();

  toggle() {
    if (!this.switchable()) return;
    const next = !this.open();
    this.open.set(next);
    if (next) {
      this.query = '';
      this.searching.set(false);
      this.cursor.set(0);
      this.filteredOptions.set(this.tenant.tenants());
      setTimeout(() => this.searchInput()?.nativeElement?.focus(), 0);
    }
  }

  close() {
    this.open.set(false);
    this.query = '';
    this.cursor.set(0);
  }

  onQueryChange(val: string) {
    const q = val.trim().toLowerCase();
    this.searching.set(q.length > 0);
    this.cursor.set(0);

    if (!q) {
      this.filteredOptions.set(this.tenant.tenants());
      return;
    }

    const matches = this.tenant
      .tenants()
      .filter((t) => t.name.toLowerCase().includes(q) || t.slug.toLowerCase().includes(q));
    this.filteredOptions.set(matches);
  }

  choose(entry: TenantSummary) {
    this.close();
    if (entry.id === this.tenant.tenantId()) return;
    if (this.tenant.tenants().some((own) => own.id === entry.id)) {
      this.tenant.selectTenant(entry.id);
    } else {
      this.tenant.refresh(entry.id).then(() => {
        window.location.href = '/home';
      });
    }
  }

  onKeyDown(event: KeyboardEvent) {
    const options = this.filteredOptions();
    if (event.key === 'Escape') {
      this.close();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.cursor.set(Math.min(options.length - 1, this.cursor() + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.cursor.set(Math.max(0, this.cursor() - 1));
    } else if (event.key === 'Enter' && options[this.cursor()]) {
      event.preventDefault();
      this.choose(options[this.cursor()]);
    }
  }

  @HostListener('document:mousedown', ['$event'])
  onDocumentClick(event: MouseEvent) {
    if (this.open() && !this.hostRef.nativeElement.contains(event.target)) {
      this.close();
    }
  }
}
