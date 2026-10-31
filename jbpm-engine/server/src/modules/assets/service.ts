// Project assets (shared across the project's processes). Kinds + seeds are defined per-folder under
// src/assets/<kind>/def.ts (registry in src/assets/index.ts). This module lists/adds/reads/updates/
// removes entries in the head-draft version.engine; the SDK exports them to real jBPM assets and the
// runtime evaluators apply them. Full per-asset editors (fields UI beyond raw JSON), locking and
// version history are still Phase 8 — see ux_design/13-remaining-backlog.md — so this stays scoped to
// what's genuinely backed: list/add/get/update/delete + real usage counts.
import type { AppContext } from '../../context.ts';
import type { EngineProject, EngineNode, EngineProcess } from '../../sdk/index.ts';
import { WorkflowService } from '../workflows/service.ts';
import { VersionService } from '../versions/service.ts';
import { ASSET_KINDS, ASSET_DEFS } from '../../assets/index.ts';
import { slug } from '../../assets/types.ts';
import { notFound, validation, conflict } from '../../infra/errors.ts';
import {
  evaluateDmn, evaluateRules, evaluateDecisionTree, evaluateScorecard,
  evaluateGuidedTable, evaluateTestScenario,
} from '../../engine/decisioning.ts';

export interface AssetRef { kind: string; process: string; processId?: string; nodeId?: string; nodeName?: string; via: string; }

export class AssetsService {
  private wf: WorkflowService;
  private ver: VersionService;
  constructor(private ctx: AppContext) { this.wf = new WorkflowService(ctx); this.ver = new VersionService(ctx); }

  private async head(projectId: string): Promise<{ branchId: string; engine: EngineProject }> {
    const project = await this.wf.get(projectId);
    const versions = await this.ver.listByBranch(project.defaultBranchId);
    const head = versions.filter((v) => v.state === 'draft').at(-1) || versions.at(-1);
    if (!head) throw notFound('draft version');
    return { branchId: project.defaultBranchId, engine: head.engine };
  }

  private def(kind: string) {
    const def = ASSET_DEFS[kind];
    if (!def) throw validation(`unknown asset kind "${kind}"`);
    return def;
  }

  /**
   * Every place a process can point at an asset by name, keyed by asset kind. This is the single
   * source of truth for both the "used by" counts on the list and the "referenced by" panel on an
   * asset's detail — matches the engine node fields each kind's node handler actually reads (see
   * engine/nodes/{user-task,rule,send,receive,catch,throw}/handler.ts).
   */
  private findRefs(engine: EngineProject, kind: string, name: string): AssetRef[] {
    const refs: AssetRef[] = [];
    const visit = (proc: EngineProcess, nodes: EngineNode[]) => {
      for (const n of nodes) {
        const push = (via: string) => refs.push({ kind, process: proc.name || proc.id, processId: proc.id, nodeId: (n as any).id, nodeName: (n as any).name || (n as any).id, via });
        if (kind === 'forms' && (n as any).type === 'userTask' && (n as any).form === name) push('form');
        if (kind === 'rulesets' && (n as any).type === 'rule' && (n as any).ruleflowGroup === name) push('ruleflowGroup');
        if (kind === 'decisions' && (n as any).type === 'rule' && (n as any).dmn?.model === name) push('dmn.model');
        if (kind === 'guidedTables' && (n as any).type === 'rule' && (n as any).guidedTable === name) push('guidedTable');
        if (kind === 'decisionTrees' && (n as any).type === 'rule' && (n as any).decisionTree === name) push('decisionTree');
        if (kind === 'scorecards' && (n as any).type === 'rule' && (n as any).scorecard === name) push('scorecard');
        if (kind === 'messages') {
          if ((n as any).type === 'send' && (n as any).message === name) push('message');
          if ((n as any).type === 'receive' && (n as any).message === name) push('message');
          if ((n as any).type === 'catch' && (n as any).event?.message === name) push('event.message');
          if ((n as any).type === 'throw' && (n as any).event?.message === name) push('event.message');
        }
        if ((n as any).type === 'subprocess' && Array.isArray((n as any).nodes)) visit(proc, (n as any).nodes);
      }
    };
    for (const proc of engine.processes || []) {
      visit(proc, proc.nodes || []);
      if (kind === 'types' && (proc.vars || []).some((v) => v.type === name)) {
        refs.push({ kind, process: proc.name || proc.id, processId: proc.id, via: 'process variable' });
      }
    }
    if (kind === 'types') {
      for (const f of ((engine as any).forms || [])) {
        if (f.model?.className === name || f.model?.className?.endsWith('.' + name)) {
          refs.push({ kind, process: `Form: ${f.name}`, via: 'form model' });
        }
      }
    }
    if (kind !== 'tests') {
      for (const t of ((engine as any).tests || [])) {
        if (t.target === name) {
          refs.push({ kind, process: `Test Suite: ${t.name}`, via: 'test target' });
        }
      }
    }
    return refs;
  }

  async list(projectId: string): Promise<{ kinds: { key: string; label: string; nameField: string }[]; assets: Record<string, { name: string; usedBy: number; refs: AssetRef[] }[]> }> {
    const { engine } = await this.head(projectId);
    const assets: Record<string, { name: string; usedBy: number; refs: AssetRef[] }[]> = {};
    for (const k of ASSET_KINDS) {
      const arr = ((engine as any)[k.key] as any[]) || [];
      assets[k.key] = arr.map((a) => {
        const name = a[k.nameField] || a.name || a.group || a.id || '(unnamed)';
        const refs = this.findRefs(engine, k.key, name);
        return { name, usedBy: refs.length, refs };
      });
    }
    return { kinds: ASSET_KINDS.map((k) => ({ key: k.key, label: k.label, nameField: k.nameField })), assets };
  }

  private findRaw(engine: EngineProject, kind: string, name: string): any {
    const def = this.def(kind);
    const arr = ((engine as any)[kind] as any[]) || [];
    return arr.find((a) => (a[def.nameField] || a.name) === name);
  }

  async get(projectId: string, kind: string, name: string): Promise<{ kind: string; asset: any; usedBy: AssetRef[] }> {
    const { engine } = await this.head(projectId);
    const asset = this.findRaw(engine, kind, name);
    if (!asset) throw notFound(`asset "${name}"`);
    return { kind, asset, usedBy: this.findRefs(engine, kind, name) };
  }

  // `fields` carries kind-specific data beyond the name (e.g. a form's model.className, a scorecard's
  // fact/baseline/target). Only keys already present in def.seed()'s own shape are copied over — that
  // seed shape is each kind's only schema today (see src/assets/types.ts), so this both scopes the
  // payload to what the kind actually supports and blocks injecting arbitrary/prototype keys.
  async add(projectId: string, kind: string, name: string, actor: string, fields?: Record<string, unknown>): Promise<{ kind: string; name: string }> {
    const nm = (name || '').trim();
    if (!nm) throw validation('asset name is required');
    const def = this.def(kind);
    const { branchId, engine } = await this.head(projectId);
    const coll = ((engine as any)[kind] ||= []) as any[];
    if (coll.some((a) => (a[def.nameField] || a.name) === nm)) throw validation(`asset "${nm}" already exists`);
    const seeded = def.seed(nm, fields);
    if (fields && typeof fields === 'object') {
      for (const k of Object.keys(seeded)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        if (k === def.nameField || !(k in fields)) continue;
        const v = (fields as any)[k];
        if (v === undefined || v === '') continue;
        seeded[k] = typeof seeded[k] === 'number' ? Number(v) : v;
      }
    }
    coll.push(seeded);
    await this.ver.saveDraft(branchId, engine, actor);
    await this.ctx.audit({ actor, kind: 'asset.added', workflowId: projectId, data: { kind, name: nm } });
    return { kind, name: nm };
  }

  /** Duplicate an existing asset with a new unique name in the same project. */
  async duplicate(projectId: string, kind: string, name: string, newName: string, actor: string): Promise<{ kind: string; name: string }> {
    const nm = (newName || '').trim();
    if (!nm) throw validation('new asset name is required');
    if (nm === name) throw validation('new asset name must be different from current name');
    const def = this.def(kind);
    const { branchId, engine } = await this.head(projectId);
    const coll = ((engine as any)[kind] ||= []) as any[];
    const original = this.findRaw(engine, kind, name);
    if (!original) throw notFound(`asset "${name}"`);
    if (coll.some((a) => (a[def.nameField] || a.name) === nm)) throw validation(`asset "${nm}" already exists`);

    const cloned = JSON.parse(JSON.stringify(original));
    cloned[def.nameField] = nm;
    if (cloned.name && def.nameField !== 'name') cloned.name = nm;
    if (kind === 'decisions') {
      cloned.namespace = `https://kie.org/dmn/${slug(nm)}`;
      if (Array.isArray(cloned.decisions) && cloned.decisions[0]) {
        cloned.decisions[0].name = nm;
      }
    }
    coll.push(cloned);
    await this.ver.saveDraft(branchId, engine, actor);
    await this.ctx.audit({ actor, kind: 'asset.duplicated', workflowId: projectId, data: { kind, source: name, name: nm } });
    return { kind, name: nm };
  }

  /** Rename and/or merge other top-level field edits (e.g. a data object's field list) into an
   *  existing asset. Renaming re-points every process reference so nothing silently breaks. */
  async update(projectId: string, kind: string, name: string, patch: Record<string, unknown>, actor: string): Promise<{ kind: string; name: string }> {
    const def = this.def(kind);
    const { branchId, engine } = await this.head(projectId);
    const asset = this.findRaw(engine, kind, name);
    if (!asset) throw notFound(`asset "${name}"`);
    const nextName = typeof patch[def.nameField] === 'string' ? (patch[def.nameField] as string).trim() : undefined;
    if (nextName && nextName !== name) {
      const coll = ((engine as any)[kind] as any[]) || [];
      if (coll.some((a) => (a[def.nameField] || a.name) === nextName)) throw validation(`asset "${nextName}" already exists`);
      this.retarget(engine, kind, name, nextName);
    }
    for (const [k, v] of Object.entries(patch)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      asset[k] = v;
    }
    await this.ver.saveDraft(branchId, engine, actor);
    await this.ctx.audit({ actor, kind: 'asset.updated', workflowId: projectId, data: { kind, name, patch: Object.keys(patch) } });
    return { kind, name: nextName || name };
  }

  /** Re-point every process reference to a renamed asset (see update()). Mirrors findRefs' field list. */
  private retarget(engine: EngineProject, kind: string, oldName: string, newName: string): void {
    const visit = (nodes: EngineNode[]) => {
      for (const n of nodes) {
        const any = n as any;
        if (kind === 'forms' && any.type === 'userTask' && any.form === oldName) any.form = newName;
        if (kind === 'rulesets' && any.type === 'rule' && any.ruleflowGroup === oldName) any.ruleflowGroup = newName;
        if (kind === 'decisions' && any.type === 'rule' && any.dmn?.model === oldName) any.dmn.model = newName;
        if (kind === 'decisionTrees' && any.type === 'rule' && any.decisionTree === oldName) any.decisionTree = newName;
        if (kind === 'scorecards' && any.type === 'rule' && any.scorecard === oldName) any.scorecard = newName;
        if (kind === 'messages') {
          if ((any.type === 'send' || any.type === 'receive') && any.message === oldName) any.message = newName;
          if ((any.type === 'catch' || any.type === 'throw') && any.event?.message === oldName) any.event.message = newName;
        }
        if (any.type === 'subprocess' && Array.isArray(any.nodes)) visit(any.nodes);
      }
    };
    for (const proc of engine.processes || []) {
      visit(proc.nodes || []);
      if (kind === 'types') for (const v of proc.vars || []) if (v.type === oldName) v.type = newName;
    }
  }

  /** Blocked while any process still references the asset — matches jBPM's own rule that "used by" is
   *  what makes deletion safe (ux_design/mockups/assets-overview.html). */
  async remove(projectId: string, kind: string, name: string, actor: string): Promise<void> {
    const def = this.def(kind);
    const { branchId, engine } = await this.head(projectId);
    const coll = ((engine as any)[kind] as any[]) || [];
    const idx = coll.findIndex((a) => (a[def.nameField] || a.name) === name);
    if (idx < 0) throw notFound(`asset "${name}"`);
    const refs = this.findRefs(engine, kind, name);
    if (refs.length) throw conflict(`"${name}" is referenced by ${refs.length} process node(s) — remove those references first`, refs);
    coll.splice(idx, 1);
    await this.ver.saveDraft(branchId, engine, actor);
    await this.ctx.audit({ actor, kind: 'asset.removed', workflowId: projectId, data: { kind, name } });
  }

  /** Run/test an asset based on its purpose (e.g. evaluate DMN/DRL/table/tree/scorecard, validate form/type, or run test suite). */
  async testAsset(projectId: string, kind: string, name: string, inputPayload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { engine } = await this.head(projectId);
    const asset = this.findRaw(engine, kind, name);
    if (!asset) throw notFound(`asset "${name}"`);

    switch (kind) {
      case 'decisions': {
        const decisionName = (inputPayload.decision as string) || '';
        const vars = (inputPayload.inputs || inputPayload.vars || inputPayload) as Record<string, unknown>;
        const result = evaluateDmn(engine, { model: name, decision: decisionName }, vars);
        return { success: true, kind, name, outputs: result };
      }
      case 'rulesets': {
        const vars = (inputPayload.vars || inputPayload) as Record<string, unknown>;
        const result = evaluateRules(engine, name, vars);
        return { success: true, kind, name, outputs: result };
      }
      case 'guidedTables': {
        const vars = (inputPayload.vars || inputPayload) as Record<string, unknown>;
        const result = evaluateGuidedTable(engine, name, vars);
        return { success: true, kind, name, outputs: result };
      }
      case 'decisionTrees': {
        const vars = (inputPayload.vars || inputPayload) as Record<string, unknown>;
        const result = evaluateDecisionTree(engine, name, vars);
        return { success: true, kind, name, outputs: result };
      }
      case 'scorecards': {
        const vars = (inputPayload.vars || inputPayload) as Record<string, unknown>;
        const result = evaluateScorecard(engine, name, vars);
        return { success: true, kind, name, outputs: result };
      }
      case 'tests': {
        const result = evaluateTestScenario(engine, name);
        return { success: true, kind, ...result };
      }
      case 'forms': {
        const submission = (inputPayload.submission || inputPayload) as Record<string, unknown>;
        const fields = (asset.fields || []) as any[];
        const errors: string[] = [];
        for (const f of fields) {
          const val = submission[f.bind];
          if (f.required && (val === undefined || val === null || val === '')) {
            errors.push(`Field "${f.label || f.bind}" is required`);
          }
          if (val !== undefined && val !== null && val !== '') {
            if ((f.widget === 'integer' || f.widget === 'number' || f.widget === 'decimal') && isNaN(Number(val))) {
              errors.push(`Field "${f.label || f.bind}" must be a number`);
            }
          }
        }
        return { success: errors.length === 0, valid: errors.length === 0, errors, submission };
      }
      case 'types': {
        const obj = (inputPayload.object || inputPayload) as Record<string, unknown>;
        const typeFields = (asset.fields || []) as any[];
        const errors: string[] = [];
        for (const f of typeFields) {
          const val = obj[f.name];
          if (f.list && val !== undefined && !Array.isArray(val)) {
            errors.push(`Property "${f.name}" must be a list/array`);
          }
        }
        return { success: errors.length === 0, valid: errors.length === 0, errors, sample: obj };
      }
      case 'enumerations': {
        const testVal = (inputPayload.value as string) || '';
        const allowedVals = (asset.values || (asset.entries && asset.entries[Object.keys(asset.entries)[0]]) || []) as string[];
        const allowed = allowedVals.includes(testVal);
        return { success: true, allowed, value: testVal, allowedValues: allowedVals };
      }
      case 'messages': {
        return {
          success: true,
          name,
          dataType: asset.dataType || 'Object',
          correlationKey: asset.correlationKey || 'correlationId',
          description: asset.description,
          activeReferences: this.findRefs(engine, kind, name),
        };
      }
      default:
        throw validation(`testing not supported for asset kind "${kind}"`);
    }
  }
}
