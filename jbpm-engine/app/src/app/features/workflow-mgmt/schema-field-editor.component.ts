import { Component, Input } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IconComponent } from '../../shared/icon.component';
import type { ArrayItemType, FieldType, SchemaField } from './schema-field.model';

/** Recursive field-row editor — a row whose type is `object` (or an `array` of `object`) renders a
 *  nested `<app-schema-field-editor>` for its own `children`, so the builder can express arbitrarily
 *  deep JSON Schema, not just flat top-level properties. `fields` is mutated in place (same
 *  mutate-and-emit-nothing convention as asset-fields.component.ts's dynamic editor — the PARENT
 *  array reference stays stable, so the caller just reads it back on submit). */
@Component({
  selector: 'app-schema-field-editor',
  standalone: true,
  imports: [FormsModule, IconComponent, SchemaFieldEditorComponent],
  template: `
    @for (f of fields; track f) {
      <div class="row" [style.marginLeft.px]="depth * 18">
        <input class="fkey" [(ngModel)]="f.key" placeholder="fieldName" />
        <select [(ngModel)]="f.type" (ngModelChange)="onTypeChange(f)">
          <option value="string">string</option><option value="number">number</option>
          <option value="boolean">boolean</option><option value="array">array</option><option value="object">object</option>
        </select>
        @if (f.type === 'array') {
          <select [(ngModel)]="f.arrayItemType" (ngModelChange)="onArrayItemTypeChange(f)">
            <option value="string">of string</option><option value="number">of number</option>
            <option value="boolean">of boolean</option><option value="object">of object</option>
          </select>
        }
        <label class="reqlbl"><input type="checkbox" [(ngModel)]="f.required" /> required</label>
        <button class="btn sm danger" (click)="remove(f)" title="Delete" aria-label="Delete"><app-icon name="trash" [size]="12" /></button>
      </div>
      @if (f.type === 'object' || (f.type === 'array' && f.arrayItemType === 'object')) {
        <div class="nested" [style.marginLeft.px]="(depth + 1) * 18">
          <app-schema-field-editor [fields]="f.children!" [depth]="depth + 1" />
          <button class="btn sm" (click)="addChild(f)"><app-icon name="plus" [size]="11" /> Add nested field</button>
        </div>
      }
    }
  `,
  styles: [`
    .row { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
    .fkey { flex: 1; min-width: 100px; border: 1px solid var(--border); border-radius: 8px; padding: 6px 9px; font-size: 13px; }
    select { border: 1px solid var(--border); border-radius: 8px; padding: 6px 9px; font-size: 13px; }
    .reqlbl { display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--muted); white-space: nowrap; }
    .btn.danger { color: var(--red); }
    .nested { border-left: 2px solid var(--border); padding-left: 10px; margin-bottom: 8px; }
  `],
})
export class SchemaFieldEditorComponent {
  @Input() fields: SchemaField[] = [];
  @Input() depth = 0;

  // Mutates `fields` IN PLACE (splice, not reassignment) — `fields` here may be a nested `f.children`
  // array passed down by reference from a PARENT instance of this same component; reassigning
  // `this.fields` to a new array would only rebind this instance's own local @Input(), never write
  // back through to the parent's object, so a delete inside a nested object would silently do
  // nothing from the parent's perspective. Splicing the same array object every level shares is what
  // makes delete-at-any-depth actually work.
  remove(f: SchemaField) {
    const i = this.fields.indexOf(f);
    if (i >= 0) this.fields.splice(i, 1);
  }

  onTypeChange(f: SchemaField) {
    if (f.type === 'object' && !f.children) f.children = [];
    if (f.type === 'array' && !f.arrayItemType) f.arrayItemType = 'string';
    if (f.type !== 'array') delete f.arrayItemType;
    if (f.type !== 'object' && !(f.type === 'array' && f.arrayItemType === ('object' as ArrayItemType))) delete f.children;
  }
  onArrayItemTypeChange(f: SchemaField) {
    if (f.arrayItemType === 'object' && !f.children) f.children = [];
    if (f.arrayItemType !== 'object') delete f.children;
  }
  addChild(f: SchemaField) {
    f.children ??= [];
    f.children.push({ key: '', type: 'string' as FieldType, required: false });
  }
}
