import { Component, EventEmitter, Input, OnChanges, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IconComponent } from '../../shared/icon.component';

export type AssetFieldWidget = 'text' | 'number' | 'checkbox' | 'select' | 'keyval' | 'rows';
export interface AssetFieldSpec {
  key: string; label: string; widget: AssetFieldWidget; options?: string[]; placeholder?: string; help?: string; rowFields?: AssetFieldSpec[];
  /** Singular noun for one row, used in per-row numbering ("Rule 2") and the add-button — falls back
   *  to `label` (fine for kinds where the label is already singular, e.g. Forms' "Field"). */
  itemLabel?: string;
  /** Only meaningful on a 'keyval' field: constrains the KEY column's suggestions to names declared
   *  elsewhere in this SAME asset — 'decisionInputs'/'decisionOutputs' read decisions[0].inputs/outputs
   *  (see decisioning.ts's evaluateDmn: a when/then key that isn't one of these literally can't match
   *  anything at runtime, so this is a closed, fully-knowable list, not a loose suggestion). */
  keyOptionsFrom?: 'decisionInputs' | 'decisionOutputs';
}
export interface AssetSection { title: string; fields: AssetFieldSpec[]; }

/**
 * Real per-kind schemas, matching what each kind's engine evaluator actually reads — see
 * engine/decisioning.ts (rulesets/decisions/decisionTrees/scorecards) and the SDK's FormField/
 * EngineTypeField shapes (forms/types). Two kinds don't fit the generic path+rows model and get a
 * bespoke template instead: decisionTrees (a real tree, presented here as single-level branches —
 * see the note on DECISION_TREE_HELP) and guidedTables (no runtime consumer in this engine at all,
 * so its shape is a free design choice: named condition/action columns + a row grid).
 */
export const KIND_SCHEMAS: Record<string, AssetSection[]> = {
  forms: [
    { title: 'Backing class', fields: [{ key: 'model.className', label: 'Class name', widget: 'text', placeholder: 'com.acme.ClaimIntake' }] },
    { title: 'Fields', fields: [{ key: 'fields', label: 'Fields', itemLabel: 'Field', widget: 'rows', rowFields: [
      { key: 'bind', label: 'Bind (variable path)', widget: 'text', placeholder: 'claim.amount' },
      { key: 'label', label: 'Label', widget: 'text' },
      { key: 'widget', label: 'Widget', widget: 'select', options: ['text', 'textarea', 'integer', 'number', 'decimal', 'checkbox', 'boolean', 'dropdown', 'select', 'radio', 'date'] },
      { key: 'required', label: 'Required', widget: 'checkbox' },
      { key: 'readOnly', label: 'Read-only', widget: 'checkbox' },
      { key: 'placeholder', label: 'Placeholder', widget: 'text' },
    ] }] },
  ],
  types: [
    { title: 'Java Package', fields: [{ key: 'package', label: 'Package', widget: 'text', placeholder: 'com.acme.model' }] },
    { title: 'Fields', fields: [{ key: 'fields', label: 'Fields', itemLabel: 'Field', widget: 'rows', rowFields: [
      { key: 'name', label: 'Name', widget: 'text' },
      { key: 'type', label: 'Type', widget: 'select', options: ['string', 'int', 'long', 'double', 'bool', 'date', 'object'] },
      { key: 'list', label: 'Is a list', widget: 'checkbox' },
    ] }] },
  ],
  enumerations: [
    { title: 'Target', fields: [
      { key: 'type', label: 'Fact / Data Type', widget: 'text', placeholder: 'Claim' },
      { key: 'field', label: 'Field Name', widget: 'text', placeholder: 'status' },
    ] },
    { title: 'Entries', fields: [{ key: 'entries', label: 'Entries Map (Fact.field = [values])', widget: 'keyval' }] },
  ],
  messages: [
    { title: 'Message Contract', fields: [
      { key: 'dataType', label: 'Payload Data Type (Java FQN / Object)', widget: 'text', placeholder: 'com.acme.model.Claim' },
      { key: 'correlationKey', label: 'Correlation Property', widget: 'text', placeholder: 'claimId', help: 'Process instance variable name matched when delivering throw/catch messages.' },
      { key: 'description', label: 'Description', widget: 'text', placeholder: 'Event contract for messaging' },
    ] },
  ],
  rulesets: [
    { title: 'Java Package', fields: [{ key: 'package', label: 'Package', widget: 'text', placeholder: 'com.acme.rules' }] },
    { title: 'Rules', fields: [{ key: 'rules', label: 'Rules', itemLabel: 'Rule', widget: 'rows', rowFields: [
      { key: 'name', label: 'Name', widget: 'text' },
      { key: 'priority', label: 'Priority (higher runs first)', widget: 'number' },
      { key: 'when', label: 'When (all conditions must match)', itemLabel: 'Condition', widget: 'rows', rowFields: [
        { key: 'fact', label: 'Fact (variable, optional)', widget: 'text', help: 'A process variable name holding an object to test — leave blank to test the whole variable map directly (this asset is shared, so it can\'t know the calling process\'s variable names in advance).' },
        { key: 'as', label: 'Bind as', widget: 'text' },
        { key: 'not', label: 'Negate (must NOT exist)', widget: 'checkbox' },
        { key: 'where', label: 'Where (field = value)', widget: 'keyval', help: 'Editing here writes a literal-equality match. Comparison operators (greater-than, in-list, etc.) already on a condition are kept unless you touch that value.' },
      ] },
      { key: 'then', label: 'Then (actions)', itemLabel: 'Action', widget: 'rows', help: 'Each action either sets fields on the matched fact OR inserts a brand-new fact — fill in exactly one of "Set fields on" / "Insert new fact", not both.', rowFields: [
        { key: 'set', label: 'Set fields on fact (variable, optional)', widget: 'text', help: 'Same convention as "Fact" above — leave blank (or any name that isn\'t an existing variable) to set fields directly on the whole variable map.' },
        { key: 'insert', label: 'Or insert a new fact (type)', widget: 'text' },
        { key: 'fields', label: 'Fields to set', widget: 'keyval' },
      ] },
    ] }] },
  ],
  decisions: [
    { title: 'Decision', fields: [{ key: 'decisions.0.hitPolicy', label: 'Hit policy', widget: 'select', options: ['UNIQUE', 'FIRST', 'ANY', 'COLLECT'] }] },
    { title: 'Inputs', fields: [{ key: 'decisions.0.inputs', label: 'Input variables', itemLabel: 'Input variable', widget: 'rows', rowFields: [{ key: 'name', label: 'Name', widget: 'text' }] }] },
    { title: 'Outputs', fields: [{ key: 'decisions.0.outputs', label: 'Output variables', itemLabel: 'Output variable', widget: 'rows', rowFields: [{ key: 'name', label: 'Name', widget: 'text' }] }] },
    { title: 'Rules', fields: [{ key: 'decisions.0.rules', label: 'Rules', itemLabel: 'Rule', widget: 'rows', rowFields: [
      { key: 'when', label: 'When (input = value)', widget: 'keyval', keyOptionsFrom: 'decisionInputs', help: 'Keys are input-variable names from Inputs above; an input left out of When matches any value.' },
      { key: 'then', label: 'Then (output = value)', widget: 'keyval', keyOptionsFrom: 'decisionOutputs', help: 'Keys are output-variable names from Outputs above; this rule sets each to the given value when When matches.' },
    ] }] },
  ],
  scorecards: [
    { title: 'Model', fields: [
      { key: 'fact', label: 'Fact (variable, optional)', widget: 'text', help: 'A process variable name holding an object to score — leave blank to score fields on the whole variable map directly (this asset is shared, so it can\'t know the calling process\'s variable names in advance).' },
      { key: 'baseline', label: 'Baseline score', widget: 'number' },
      { key: 'target', label: 'Target field (written on the instance)', widget: 'text' },
    ] },
    { title: 'Characteristics', fields: [{ key: 'characteristics', label: 'Characteristics', itemLabel: 'Characteristic', widget: 'rows', rowFields: [
      { key: 'field', label: 'Field (on the fact)', widget: 'text' },
      { key: 'attributes', label: 'Attributes (first match wins, in order)', itemLabel: 'Attribute', widget: 'rows', rowFields: [
        { key: 'match', label: 'Match value', widget: 'text' },
        { key: 'points', label: 'Points', widget: 'number' },
        { key: 'reason', label: 'Reason (optional)', widget: 'text' },
      ] },
    ] }] },
  ],
  tests: [
    { title: 'Target', fields: [{ key: 'target', label: 'Target decision, ruleset, table, tree, or scorecard name', widget: 'text', help: 'The target asset this test suite verifies with Given/Expect assertions.' }] },
    { title: 'Cases', fields: [{ key: 'cases', label: 'Cases', itemLabel: 'Case', widget: 'rows', rowFields: [
      { key: 'name', label: 'Name', widget: 'text' },
      { key: 'given', label: 'Given (input variables)', widget: 'keyval', help: 'Keys should match the target\'s declared input/variable names.' },
      { key: 'expect', label: 'Expect (output variables)', widget: 'keyval', help: 'Keys should match the target\'s declared output/variable names.' },
    ] }] },
  ],
  decisionTrees: [],
  guidedTables: [],
};

const DECISION_TREE_HELP = "This engine's decision-tree evaluator descends one field test at a time, applying each branch's output on the way; a branch with no further test is a leaf. This editor covers the common single-level case — every branch below is a leaf off one root field.";

@Component({
  selector: 'app-asset-fields',
  standalone: true,
  imports: [FormsModule, IconComponent],
  template: `
    @if (kind === 'decisionTrees') {
      <p class="hint">{{ help }}</p>
      <div class="fld"><label>Fact (variable, optional)</label><input [ngModel]="value.fact" (ngModelChange)="value.fact = $event || undefined; emit()" /><small>A process variable name holding an object to test — leave blank to test the whole variable map directly (this asset is shared, so it can't know the calling process's variable names in advance).</small></div>
      <div class="fld"><label>Field to test (on the fact)</label><input [ngModel]="treeField()" (ngModelChange)="setTreeField($event)" placeholder="e.g. amount" /></div>
      <div class="sec-h">Branches</div>
      @for (b of treeBranches(); track $index) {
        <div class="rowblock">
          <div class="rowgrid">
            <div class="rowfld"><label>Match value</label><input [ngModel]="b.match" (ngModelChange)="b.match = coerce($event); emit()" /></div>
          </div>
          <div class="fld" style="margin-top:6px;"><label>Output (variables set on this branch)</label>
            <div class="kvlist">
              @for (p of entries(branchThen(b), 'output'); track p[0]) {
                <div class="kvrow">
                  <input class="k" [ngModel]="p[0]" (ngModelChange)="setEntryKey(branchThen(b), 'output', p[0], $event)" placeholder="variable" />
                  <input class="v" [ngModel]="p[1]" (ngModelChange)="setEntryVal(branchThen(b), 'output', p[0], $event)" placeholder="value" />
                  <button class="x" (click)="removeEntry(branchThen(b), 'output', p[0])" title="Remove" aria-label="Remove"><app-icon name="close" [size]="11" /></button>
                </div>
              }
              <button class="add" (click)="addEntry(branchThen(b), 'output')">+ add</button>
            </div>
          </div>
          <button class="rm" (click)="removeTreeBranch($index)" title="Remove branch"><app-icon name="trash" [size]="13" /></button>
        </div>
      }
      <button class="add" (click)="addTreeBranch()">+ add branch</button>
    } @else if (kind === 'guidedTables') {
      <div class="fld"><label>Fact (variable, optional)</label><input [ngModel]="value.fact" (ngModelChange)="value.fact = $event || undefined; emit()" /><small>The fact variable tested by the table conditions and updated by actions when executed by a business rule task.</small></div>
      <div class="sec-h">Condition columns</div>
      <div class="stringlist">
        @for (c of gtConditions(); track $index) { <div class="lrow"><input [ngModel]="c" (ngModelChange)="setListItem(gtConditions(), $index, $event)" /><button class="x" (click)="removeListItem(gtConditions(), $index)" title="Remove" aria-label="Remove"><app-icon name="close" [size]="11" /></button></div> }
        <button class="add" (click)="addListItem(gtConditions())">+ add condition column</button>
      </div>
      <div class="sec-h">Action columns</div>
      <div class="stringlist">
        @for (a of gtActions(); track $index) { <div class="lrow"><input [ngModel]="a" (ngModelChange)="setListItem(gtActions(), $index, $event)" /><button class="x" (click)="removeListItem(gtActions(), $index)" title="Remove" aria-label="Remove"><app-icon name="close" [size]="11" /></button></div> }
        <button class="add" (click)="addListItem(gtActions())">+ add action column</button>
      </div>
      <div class="sec-h">Rows</div>
      @for (row of gtRows(); track $index) {
        <div class="rowblock">
          <div class="rowgrid">
            @for (fn of gtFieldNames(); track fn) {
              <div class="rowfld"><label>{{ fn }}</label><input [ngModel]="val(row, fn)" (ngModelChange)="setVal(row, fn, coerce($event))" /></div>
            }
          </div>
          <button class="rm" (click)="removeGtRow($index)" title="Remove row"><app-icon name="trash" [size]="13" /></button>
        </div>
      }
      <button class="add" (click)="addGtRow()">+ add row</button>
    } @else {
      @for (sec of schema(); track sec.title) {
        <div class="sec">
          <div class="sec-h">{{ sec.title }}</div>
          @for (f of sec.fields; track f.key) {
            <div class="fld">
              <label>{{ f.label }}</label>
              @switch (f.widget) {
                @case ('text') { <input [ngModel]="topVal(f.key)" (ngModelChange)="topSet(f.key, $event)" [placeholder]="f.placeholder || ''" /> }
                @case ('number') { <input type="number" [ngModel]="topVal(f.key)" (ngModelChange)="topSet(f.key, numOrUndef($event))" /> }
                @case ('checkbox') { <label class="chk"><input type="checkbox" [ngModel]="!!topVal(f.key)" (ngModelChange)="topSet(f.key, $event)" /> <span>{{ !!topVal(f.key) ? 'On' : 'Off' }}</span></label> }
                @case ('select') {
                  <select [ngModel]="topVal(f.key)" (ngModelChange)="topSet(f.key, $event)">
                    <option value="">—</option>
                    @for (o of f.options; track o) { <option [value]="o">{{ o }}</option> }
                  </select>
                }
                @case ('keyval') {
                  <div class="kvlist">
                    @for (p of topEntries(f.key); track p[0]) {
                      <div class="kvrow">
                        <input class="k" [ngModel]="p[0]" (ngModelChange)="topSetEntryKey(f.key, p[0], $event)" placeholder="key" />
                        <input class="v" [ngModel]="p[1]" (ngModelChange)="topSetEntryVal(f.key, p[0], $event)" placeholder="value" />
                        <button class="x" (click)="topRemoveEntry(f.key, p[0])" title="Remove" aria-label="Remove"><app-icon name="close" [size]="12" /></button>
                      </div>
                    }
                    <button class="add" (click)="topAddEntry(f.key)">+ add</button>
                  </div>
                }
                @case ('rows') {
                  @for (row of topRows(f.key); track $index; let outerIdx = $index) {
                    <div class="rowblock">
                      <div class="rowidx">{{ itemLabelOf(f) }} {{ $index + 1 }}</div>
                      @if (simpleOf(f.rowFields!).length) {
                        <div class="rowgrid">
                          @for (rf of simpleOf(f.rowFields!); track rf.key) {
                            <div class="rowfld">
                              <label>{{ rf.label }}</label>
                              @switch (rf.widget) {
                                @case ('text') { <input [ngModel]="val(row, rf.key)" (ngModelChange)="setVal(row, rf.key, coerce($event))" [placeholder]="rf.placeholder || ''" /> }
                                @case ('number') { <input type="number" [ngModel]="val(row, rf.key)" (ngModelChange)="setVal(row, rf.key, numOrUndef($event))" /> }
                                @case ('checkbox') { <input type="checkbox" [ngModel]="!!val(row, rf.key)" (ngModelChange)="setVal(row, rf.key, $event)" /> }
                                @case ('select') {
                                  <select [ngModel]="val(row, rf.key)" (ngModelChange)="setVal(row, rf.key, $event)">
                                    <option value="">—</option>
                                    @for (o of rf.options; track o) { <option [value]="o">{{ o }}</option> }
                                  </select>
                                }
                              }
                            </div>
                          }
                        </div>
                      }
                      @for (rf of complexOf(f.rowFields!); track rf.key) {
                        <div class="complexfld" [class]="tint(rf.key)">
                          <div class="complexfld-h">{{ rf.label }}</div>
                          @switch (rf.widget) {
                            @case ('keyval') {
                              <div class="kvlist">
                                @if (rf.keyOptionsFrom) {
                                  <datalist [id]="rf.key + '-' + outerIdx + '-keydl'">
                                    @for (n of keyOptions(rf.keyOptionsFrom); track n) { <option [value]="n"></option> }
                                  </datalist>
                                }
                                @for (p of entries(row, rf.key); track p[0]) {
                                  <div class="kvrow">
                                    <input class="k" [attr.list]="rf.keyOptionsFrom ? (rf.key + '-' + outerIdx + '-keydl') : null" [ngModel]="p[0]" (ngModelChange)="setEntryKey(row, rf.key, p[0], $event)" placeholder="key" />
                                    <input class="v" [ngModel]="p[1]" (ngModelChange)="setEntryVal(row, rf.key, p[0], $event)" placeholder="value" />
                                    <button class="x" (click)="removeEntry(row, rf.key, p[0])" title="Remove" aria-label="Remove"><app-icon name="close" [size]="11" /></button>
                                  </div>
                                }
                                <button class="add" (click)="addEntry(row, rf.key)">+ add</button>
                                @if (rf.keyOptionsFrom && keyOptions(rf.keyOptionsFrom).length === 0) { <small>No {{ rf.keyOptionsFrom === 'decisionInputs' ? 'input' : 'output' }} variables declared above yet.</small> }
                              </div>
                            }
                            @case ('rows') {
                              @for (row2 of rows(row, rf.key); track $index) {
                                <div class="rowblock level2">
                                  <div class="rowidx">{{ itemLabelOf(rf) }} {{ $index + 1 }}</div>
                                  @if (simpleOf(rf.rowFields!).length) {
                                    <div class="rowgrid">
                                      @for (rf2 of simpleOf(rf.rowFields!); track rf2.key) {
                                        <div class="rowfld">
                                          <label>{{ rf2.label }}</label>
                                          @switch (rf2.widget) {
                                            @case ('text') { <input [ngModel]="val(row2, rf2.key)" (ngModelChange)="setVal(row2, rf2.key, coerce($event))" /> }
                                            @case ('number') { <input type="number" [ngModel]="val(row2, rf2.key)" (ngModelChange)="setVal(row2, rf2.key, numOrUndef($event))" /> }
                                            @case ('checkbox') { <input type="checkbox" [ngModel]="!!val(row2, rf2.key)" (ngModelChange)="setVal(row2, rf2.key, $event)" /> }
                                          }
                                        </div>
                                      }
                                    </div>
                                  }
                                  @for (rf2 of complexOf(rf.rowFields!); track rf2.key) {
                                    <div class="complexfld">
                                      <div class="complexfld-h">{{ rf2.label }}</div>
                                      <div class="kvlist">
                                        @for (p of entries(row2, rf2.key); track p[0]) {
                                          <div class="kvrow">
                                            <input class="k" [ngModel]="p[0]" (ngModelChange)="setEntryKey(row2, rf2.key, p[0], $event)" placeholder="key" />
                                            <input class="v" [ngModel]="p[1]" (ngModelChange)="setEntryVal(row2, rf2.key, p[0], $event)" placeholder="value" />
                                            <button class="x" (click)="removeEntry(row2, rf2.key, p[0])" title="Remove" aria-label="Remove"><app-icon name="close" [size]="11" /></button>
                                          </div>
                                        }
                                        <button class="add" (click)="addEntry(row2, rf2.key)">+ add</button>
                                      </div>
                                      @if (rf2.help) { <small>{{ rf2.help }}</small> }
                                    </div>
                                  }
                                  <button class="rm" (click)="removeRow(row, rf.key, $index)" title="Remove"><app-icon name="trash" [size]="12" /></button>
                                </div>
                              }
                              <button class="add" (click)="addRow(row, rf.key, rf.rowFields!)">+ add {{ itemLabelOf(rf) }}</button>
                            }
                          }
                          @if (rf.help) { <small>{{ rf.help }}</small> }
                        </div>
                      }
                      <button class="rm" (click)="topRemoveRow(f.key, $index)" title="Remove"><app-icon name="trash" [size]="13" /></button>
                    </div>
                  }
                  <button class="add" (click)="topAddRow(f.key, f.rowFields!)">+ add {{ itemLabelOf(f) }}</button>
                }
              }
              @if (f.help) { <small>{{ f.help }}</small> }
            </div>
          }
        </div>
      }
      @if (schema().length === 0) { <p class="hint">This kind has no additional configuration beyond its name.</p> }
    }
  `,
  styles: [`
    .hint { color: var(--muted); font-size: 12px; margin: 0 0 10px; line-height: 1.5; }
    .sec { margin-bottom: 4px; }
    .sec-h { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 14px 0 8px; padding-bottom: 5px; border-bottom: 1px solid var(--border); }
    .fld { margin-bottom: 12px; } .fld > label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 5px; }
    input, select { width: 100%; border: 1px solid var(--border); border-radius: 8px; padding: 6px 9px; font-size: 12.5px; font-family: inherit; }
    input:focus, select:focus { outline: none; border-color: var(--primary); }
    small { display: block; color: var(--muted); font-size: 11.5px; margin-top: 4px; line-height: 1.4; }
    .chk { display: flex; align-items: center; gap: 8px; } .chk input { width: auto; } .chk span { font-size: 12.5px; }
    .kvlist, .stringlist { display: flex; flex-direction: column; gap: 6px; }
    .kvrow, .lrow { display: flex; gap: 6px; } .kvrow .k { flex: 0 0 38%; } .kvrow .v { flex: 1; } .lrow input { flex: 1; }
    .x { flex: 0 0 auto; width: 28px; border: 1px solid var(--border); background: var(--surface); border-radius: 7px; cursor: pointer; color: var(--muted); }
    .x:hover { background: var(--red-bg); color: var(--red); }
    .add { align-self: flex-start; border: 1px dashed var(--border); background: var(--surface); border-radius: 8px; padding: 5px 10px; font-size: 12px; cursor: pointer; color: var(--muted); margin-top: 4px; }
    .add:hover { border-color: var(--primary); color: var(--primary); }
    .rowblock { position: relative; border: 1px solid var(--border); border-radius: 10px; padding: 10px 34px 12px 12px; margin-bottom: 10px; background: var(--surface-2); }
    .rowblock.level2 { background: var(--surface); }
    .rowidx { font-size: 11px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: .03em; margin-bottom: 8px; }
    .rowgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; }
    .rowfld label { display: block; font-size: 11px; color: var(--muted); margin-bottom: 3px; }
    /* Rows/keyval fields never share the auto-fit grid with scalar fields — a keyval list or a nested
       row list needs its own full-width line, not a ~160px column (that's what "shrinks" everything). */
    .complexfld { margin-top: 10px; padding: 10px; border-radius: 8px; background: var(--surface); border: 1px solid var(--border); }
    .complexfld.tint-when { background: var(--blue-bg); }
    .complexfld.tint-then { background: var(--green-bg); }
    .complexfld-h { font-size: 11.5px; font-weight: 600; color: var(--text); margin-bottom: 8px; }
    .rm { position: absolute; top: 8px; right: 8px; width: 24px; height: 24px; border: 1px solid var(--border); background: var(--surface); border-radius: 6px; cursor: pointer; color: var(--muted); }
    .rm:hover { background: var(--red-bg); color: var(--red); }
  `],
})
export class AssetFieldsComponent implements OnChanges {
  @Input({ required: true }) kind!: string;
  @Input({ required: true }) value: any;
  @Output() valueChange = new EventEmitter<any>();

  help = DECISION_TREE_HELP;

  ngOnChanges() { /* value is edited in place; nothing to precompute */ }
  emit() { this.valueChange.emit(this.value); }

  schema(): AssetSection[] { return KIND_SCHEMAS[this.kind] || []; }

  // decisions-only: the fully-knowable set of names a Rules when/then key can ever match at runtime
  // (see decisioning.ts's evaluateDmn) — read straight off this same asset's own Inputs/Outputs.
  keyOptions(from: 'decisionInputs' | 'decisionOutputs'): string[] {
    const arr = from === 'decisionInputs' ? this.value?.decisions?.[0]?.inputs : this.value?.decisions?.[0]?.outputs;
    return (arr || []).map((x: any) => x.name).filter(Boolean);
  }

  // A 'rows'/'keyval' field can hold arbitrarily many entries — it always gets its own full-width
  // block (see .complexfld) rather than sharing the auto-fit scalar grid, which is what was squeezing
  // "When"/"Then" (and any keyval) down to a ~160px column.
  private isComplex(w: AssetFieldWidget): boolean { return w === 'rows' || w === 'keyval'; }
  simpleOf(fields: AssetFieldSpec[]): AssetFieldSpec[] { return fields.filter((f) => !this.isComplex(f.widget)); }
  complexOf(fields: AssetFieldSpec[]): AssetFieldSpec[] { return fields.filter((f) => this.isComplex(f.widget)); }
  itemLabelOf(f: AssetFieldSpec): string { return f.itemLabel || f.label; }
  tint(key: string): string { return key === 'when' ? 'tint-when' : key === 'then' ? 'tint-then' : ''; }

  // ---- shared coercion / list helpers ----
  str(v: unknown): string { return v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); }
  coerce(v: string): any {
    if (v === '') return v;
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    if (v === 'true') return true; if (v === 'false') return false;
    return v;
  }
  numOrUndef(v: string): number | undefined { const n = Number(v); return v === '' || !Number.isFinite(n) ? undefined : n; }
  setListItem(list: string[], i: number, v: string) { list[i] = v; this.emit(); }
  addListItem(list: string[]) { list.push(''); this.emit(); }
  removeListItem(list: string[], i: number) { list.splice(i, 1); this.emit(); }

  // ---- row-relative primitives (operate directly on an already-resolved object) ----
  val(obj: any, key: string): any { return obj?.[key]; }
  setVal(obj: any, key: string, v: any) { obj[key] = v; this.emit(); }
  rows(obj: any, key: string): any[] { return (obj[key] ||= []); }
  // Text/number/select fields are left UNSET on a fresh row rather than defaulted to '' — some kinds
  // (rulesets' "then" actions) use `'set' in action` / `'insert' in action` presence checks, not
  // truthiness, to pick behavior (see engine/decisioning.ts evaluateRules), so an eager '' would wrongly
  // make both branches "present" until the author actually types into one of them.
  addRow(obj: any, key: string, template: AssetFieldSpec[]) {
    const blank: any = {};
    for (const f of template) {
      if (f.widget === 'rows') blank[f.key] = [];
      else if (f.widget === 'keyval') blank[f.key] = {};
      else if (f.widget === 'checkbox') blank[f.key] = false;
    }
    this.rows(obj, key).push(blank); this.emit();
  }
  removeRow(obj: any, key: string, i: number) { this.rows(obj, key).splice(i, 1); this.emit(); }
  entries(obj: any, key: string): [string, string][] { return Object.entries(obj?.[key] || {}).map(([k, v]) => [k, this.str(v)]); }
  setEntryKey(obj: any, key: string, oldK: string, newK: string) {
    const o = (obj[key] ||= {}); const nk = newK.trim();
    if (!nk || nk === oldK) return;
    const v = o[oldK]; delete o[oldK]; o[nk] = v; this.emit();
  }
  setEntryVal(obj: any, key: string, k: string, v: string) { (obj[key] ||= {})[k] = this.coerce(v); this.emit(); }
  addEntry(obj: any, key: string) {
    const o = (obj[key] ||= {}); let n = 'key', i = 1;
    while (n in o) n = 'key' + (i++);
    o[n] = ''; this.emit();
  }
  removeEntry(obj: any, key: string, k: string) { delete (obj[key] || {})[k]; this.emit(); }

  // ---- top-level (dotted-path) wrappers over the same primitives ----
  private containerFor(path: string): { obj: any; key: string } {
    const parts = path.split('.');
    let cur = this.value;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = /^\d+$/.test(parts[i + 1]) ? [] : {};
      cur = cur[p];
    }
    return { obj: cur, key: parts[parts.length - 1] };
  }
  topVal(path: string): any { const { obj, key } = this.containerFor(path); return this.val(obj, key); }
  topSet(path: string, v: any) { const { obj, key } = this.containerFor(path); this.setVal(obj, key, v); }
  topRows(path: string): any[] { const { obj, key } = this.containerFor(path); return this.rows(obj, key); }
  topAddRow(path: string, template: AssetFieldSpec[]) { const { obj, key } = this.containerFor(path); this.addRow(obj, key, template); }
  topRemoveRow(path: string, i: number) { const { obj, key } = this.containerFor(path); this.removeRow(obj, key, i); }
  topEntries(path: string): [string, string][] { const { obj, key } = this.containerFor(path); return this.entries(obj, key); }
  topSetEntryKey(path: string, oldK: string, newK: string) { const { obj, key } = this.containerFor(path); this.setEntryKey(obj, key, oldK, newK); }
  topSetEntryVal(path: string, k: string, v: string) { const { obj, key } = this.containerFor(path); this.setEntryVal(obj, key, k, v); }
  topAddEntry(path: string) { const { obj, key } = this.containerFor(path); this.addEntry(obj, key); }
  topRemoveEntry(path: string, k: string) { const { obj, key } = this.containerFor(path); this.removeEntry(obj, key, k); }

  // ---- decision trees (bespoke: single-level branch list, see DECISION_TREE_HELP) ----
  treeField(): string { return this.value?.root?.test?.field || ''; }
  setTreeField(f: string) { (this.value.root ||= {}).test = { field: f }; this.emit(); }
  treeBranches(): any[] { return ((this.value.root ||= {}).branches ||= []); }
  branchThen(b: any): any { return (b.then ||= {}); }
  addTreeBranch() { this.treeBranches().push({ match: '', then: { output: {} } }); this.emit(); }
  removeTreeBranch(i: number) { this.treeBranches().splice(i, 1); this.emit(); }

  // ---- guided tables (bespoke: no runtime consumer, free-form condition/action columns + rows) ----
  gtConditions(): string[] { return (this.value.conditions ||= []); }
  gtActions(): string[] { return (this.value.actions ||= []); }
  gtFieldNames(): string[] { return [...this.gtConditions(), ...this.gtActions()]; }
  gtRows(): any[] { return (this.value.rows ||= []); }
  addGtRow() { this.gtRows().push({}); this.emit(); }
  removeGtRow(i: number) { this.gtRows().splice(i, 1); this.emit(); }
}
