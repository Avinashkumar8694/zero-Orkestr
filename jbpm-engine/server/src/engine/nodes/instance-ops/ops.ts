// The operations behind the Case instance and Process instance nodes — ONE registry, so the property schema (the select + each
// operation's own parameters) and the runtime can never disagree. See docs/19-analytics-builder.md §4.
import type { AppContext } from '../../../context.ts';
import { Collections, type Task } from '../../../domain.ts';
// type-only: the services themselves are loaded inside runOperation(), because they import the engine, which imports the node
// registry, which imports this file — a static import here would be a cycle.
import type { InstanceService } from '../../../modules/instances/service.ts';
import type { WorkflowInstanceService } from '../../../workflow-service/services/workflow-instance-service.ts';
import type { AnalyticsService } from '../../../analytics/service.ts';
import { conflict, validation } from '../../../infra/errors.ts';
import type { HandlerCtx } from '../types.ts';
import type { UiField } from '../def-types.ts';

export type Target = 'case' | 'process' | 'both';
export interface OpEnv { c: HandlerCtx; args: Record<string, any>; actor: string; ctx: AppContext; instances: InstanceService; cases: WorkflowInstanceService; analytics: AnalyticsService }
export interface OpDef {
  key: string; label: string; group: string; target: Target;
  /** changes state — refused on the running instance itself (see SELF_TARGET) */
  mutates: boolean;
  params: UiField[];
  /** `caseId` / `instanceId` parameters that default to the current case / instance */
  run(e: OpEnv): Promise<unknown>;
}

const MAX_RESULT_BYTES = 1_000_000;
const f = (key: string, label: string, widget: UiField['widget'], extra: Partial<UiField> = {}): UiField => ({ key, label, widget, ...extra });
const instanceId = f('instanceId', 'Process instance id', 'text', { placeholder: 'empty = this instance', help: 'A process instance id, or $variable. Empty means the instance this node is running in.' });
const caseId = f('caseId', 'Case id', 'text', { placeholder: 'empty = this flow’s case', help: 'A case id, or $variable. Empty means the case this flow belongs to ($_caseInstanceId).' });
const kv = (key: string, label: string, help: string) => f(key, label, 'keyval', { valueSource: 'ownRef', help });

/** `a.b.c` into a value */
export const pick = (v: unknown, path: string): unknown => path.split('.').filter(Boolean).reduce((c: any, p) => (c == null ? undefined : c[p]), v);

const own = (c: HandlerCtx) => c.inst.id;
const pid = (e: OpEnv) => String(e.args.instanceId || own(e.c));
const cid = (e: OpEnv) => {
  const id = String(e.args.caseId || e.c.inst.variables?._caseInstanceId || '');
  if (!id) throw validation('this flow has no case: give a case id');
  return id;
};
const noSelf = (e: OpEnv, id: string, what: string) => {
  if (id === own(e.c)) throw Object.assign(new Error(`SELF_TARGET: "${what}" would change the instance that is running this node — use a script or another node for that`), { code: 'SELF_TARGET' });
};
const taskRows = async (e: OpEnv, id: string): Promise<Task[]> =>
  (await e.ctx.store.repo<Task>(Collections.tasks).query((t) => t.tenantId === e.ctx.tenantId && t.instanceId === id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

export const OPS: OpDef[] = [
  // ---- process instance -----------------------------------------------------------------------------------------------
  { key: 'process.get', label: 'Get process instance', group: 'Process instance', target: 'process', mutates: false, params: [instanceId],
    run: async (e) => { const id = pid(e); return id === own(e.c) ? { ...e.c.inst } : e.instances.get(id); } },
  { key: 'process.history', label: 'Get node history', group: 'Process instance', target: 'process', mutates: false, params: [instanceId],
    run: async (e) => { const id = pid(e); return id === own(e.c) ? e.c.inst.history : e.instances.history(id); } },
  { key: 'process.related', label: 'Get parent and child instances', group: 'Process instance', target: 'process', mutates: false, params: [instanceId],
    run: async (e) => e.instances.related(pid(e)) },
  { key: 'process.variables.get', label: 'Get variables', group: 'Process instance', target: 'process', mutates: false,
    params: [instanceId, f('name', 'Variable name', 'text', { placeholder: 'empty = all variables', help: 'One variable (dotted path allowed), or empty for all of them.' })],
    run: async (e) => { const id = pid(e); const vars = id === own(e.c) ? e.c.inst.variables : (await e.instances.get(id)).variables; return e.args.name ? pick(vars, String(e.args.name)) : vars; } },
  { key: 'process.variables.set', label: 'Set variables (another instance)', group: 'Process instance', target: 'process', mutates: true,
    params: [instanceId, kv('variables', 'Variables to set', 'name = value ($variable allowed)')],
    run: async (e) => { const id = pid(e); noSelf(e, id, 'set variables'); return (await e.instances.updateVariables(id, e.args.variables || {}, e.actor)).variables; } },
  { key: 'process.tasks', label: 'List tasks of an instance', group: 'Process instance', target: 'process', mutates: false, params: [instanceId],
    run: async (e) => taskRows(e, pid(e)) },
  { key: 'process.start', label: 'Start a process instance', group: 'Process instance', target: 'process', mutates: true,
    params: [f('workflowId', 'Project id', 'text', { help: 'The project (workflow) to start.' }), f('environment', 'Environment', 'text', { placeholder: 'prod' }),
      f('processId', 'Process id', 'text', { placeholder: 'optional' }), kv('variables', 'Start variables', 'name = value'), f('correlationKey', 'Correlation key', 'text'),
      f('background', 'Start in the background', 'bool', { help: 'Do not wait for the first steps: the new instance runs in the worker.' })],
    run: async (e) => e.instances.start({ workflowId: String(e.args.workflowId || ''), environment: e.args.environment || 'prod', processId: e.args.processId || undefined, variables: e.args.variables || {}, correlationKey: e.args.correlationKey || undefined, async: e.args.background === true }, e.actor) },
  { key: 'process.signal', label: 'Signal an instance', group: 'Process instance', target: 'process', mutates: true,
    params: [instanceId, f('name', 'Signal name', 'text'), f('payload', 'Payload', 'text', { placeholder: '$variable or text' })],
    run: async (e) => { const id = pid(e); noSelf(e, id, 'signal'); return e.instances.signal(id, String(e.args.name || ''), e.args.payload, e.actor); } },
  { key: 'process.abort', label: 'Abort an instance', group: 'Process instance', target: 'process', mutates: true, params: [instanceId],
    run: async (e) => { const id = pid(e); noSelf(e, id, 'abort'); return e.instances.abort(id, e.actor); } },
  { key: 'process.suspend', label: 'Suspend an instance', group: 'Process instance', target: 'process', mutates: true, params: [instanceId],
    run: async (e) => { const id = pid(e); noSelf(e, id, 'suspend'); return e.instances.suspend(id, e.actor); } },
  { key: 'process.resume', label: 'Resume an instance', group: 'Process instance', target: 'process', mutates: true, params: [instanceId],
    run: async (e) => { const id = pid(e); noSelf(e, id, 'resume'); return e.instances.resumeInstance(id, e.actor); } },
  { key: 'process.retry', label: 'Retry a failed node', group: 'Process instance', target: 'process', mutates: true, params: [instanceId, f('nodeId', 'Node id', 'text')],
    run: async (e) => { const id = pid(e); noSelf(e, id, 'retry'); return e.instances.retry(id, String(e.args.nodeId || ''), e.actor); } },

  // ---- case instance --------------------------------------------------------------------------------------------------
  { key: 'case.get', label: 'Get case (full view)', group: 'Case instance', target: 'case', mutates: false, params: [caseId], run: async (e) => e.cases.aggregate(cid(e)) },
  { key: 'case.data.get', label: 'Get case data', group: 'Case instance', target: 'case', mutates: false,
    params: [caseId, f('path', 'Data path', 'text', { placeholder: 'empty = all data', help: 'A dotted path such as claim.amount, or empty for everything.' })],
    run: async (e) => { const d = await e.cases.getData(cid(e)); return e.args.path ? pick(d, String(e.args.path)) : d; } },
  { key: 'case.data.update', label: 'Update case data (merge)', group: 'Case instance', target: 'case', mutates: true,
    params: [caseId, kv('data', 'Fields to set', 'name = value ($variable allowed); other fields are kept')],
    run: async (e) => { const id = cid(e); const cur = await e.cases.getData(id); return (await e.cases.updateData(id, { ...cur, ...(e.args.data || {}) }, e.actor)).data; } },
  { key: 'case.status.set', label: 'Set case status', group: 'Case instance', target: 'case', mutates: true, params: [caseId, f('status', 'Status', 'text', { placeholder: 'Pending Review' })],
    run: async (e) => e.cases.updateStatus(cid(e), String(e.args.status || ''), e.actor) },
  { key: 'case.close', label: 'Close case', group: 'Case instance', target: 'case', mutates: true, params: [caseId, f('resolution', 'Resolution', 'text')],
    run: async (e) => e.cases.close(cid(e), String(e.args.resolution || ''), e.actor) },
  { key: 'case.reopen', label: 'Reopen case', group: 'Case instance', target: 'case', mutates: true, params: [caseId, f('reason', 'Reason', 'text')],
    run: async (e) => e.cases.reopen(cid(e), String(e.args.reason || ''), e.actor) },
  { key: 'case.flag.add', label: 'Add case flag', group: 'Case instance', target: 'case', mutates: true,
    params: [caseId, f('flagType', 'Flag type', 'text'), f('level', 'Level', 'select', { options: ['caseLevel', 'policyLevel', 'beneficiaryLevel'] }), f('reason', 'Reason', 'text')],
    run: async (e) => e.cases.addFlag(cid(e), { flagType: String(e.args.flagType || ''), level: e.args.level || 'caseLevel', reason: e.args.reason || undefined }, e.actor) },
  { key: 'case.role.set', label: 'Set case role members', group: 'Case instance', target: 'case', mutates: true,
    params: [caseId, f('role', 'Role name', 'text', { placeholder: 'examiner' }), f('members', 'Members', 'stringlist', { help: 'Usernames or group names.' })],
    run: async (e) => e.cases.setRole(cid(e), String(e.args.role || ''), Array.isArray(e.args.members) ? e.args.members.map(String) : [], e.actor) },
  { key: 'case.milestone.achieve', label: 'Achieve case milestone', group: 'Case instance', target: 'case', mutates: true, params: [caseId, f('name', 'Milestone', 'text')],
    run: async (e) => e.cases.achieveMilestone(cid(e), String(e.args.name || ''), e.actor) },
  { key: 'case.comment.add', label: 'Add case comment', group: 'Case instance', target: 'case', mutates: true, params: [caseId, f('body', 'Comment', 'textarea')],
    run: async (e) => e.cases.addComment(cid(e), String(e.args.body || ''), e.actor) },
  { key: 'case.tasks', label: 'List every task of the case', group: 'Case instance', target: 'case', mutates: false, params: [caseId], run: async (e) => e.cases.tasks(cid(e)) },
  { key: 'case.signal', label: 'Signal the case’s process', group: 'Case instance', target: 'case', mutates: true,
    params: [caseId, f('name', 'Signal name', 'text'), f('payload', 'Payload', 'text')],
    run: async (e) => { const id = cid(e); const w = await e.cases.get(id); noSelf(e, String(w.piid ?? ''), 'signal'); return e.cases.signal(id, String(e.args.name || ''), e.args.payload, e.actor); } },
  { key: 'case.create', label: 'Create (start) a case', group: 'Case instance', target: 'case', mutates: true,
    params: [f('workflowName', 'Workflow name', 'text', { help: 'The workflow definition name registered for cases.' }), kv('workflowData', 'Case data', 'name = value'), kv('variables', 'Process variables', 'name = value')],
    run: async (e) => e.cases.create({ workflowName: String(e.args.workflowName || ''), workflowData: e.args.workflowData || {}, variables: e.args.variables || {} }, e.actor) },

  // ---- both -----------------------------------------------------------------------------------------------------------
  { key: 'analytics.run', label: 'Run an analytics API', group: 'Analytics', target: 'both', mutates: false,
    params: [f('slug', 'Analytics slug', 'text', { placeholder: 'open-cases-by-owner', help: 'A published analytics API whose owner enabled "allow flows".' }), kv('params', 'Parameters', 'name = value ($variable allowed)')],
    run: async (e) => {
      return e.analytics.run(String(e.args.slug || ''), e.args.params || {}, 'flow', { actor: 'flow', permissions: [] });
    } },
];

export const OP_BY_KEY: Record<string, OpDef> = Object.fromEntries(OPS.map((o) => [o.key, o]));
export const opsFor = (target: 'case' | 'process') => OPS.filter((o) => o.target === target || o.target === 'both');

/** an operation's parameter, `$name` / `${name}` filled from the process variables */
function resolveArg(v: unknown, vars: Record<string, unknown>): unknown {
  if (typeof v === 'string') {
    if (v.startsWith('$') && !v.startsWith('${')) return pick(vars, v.slice(1));
    if (v.includes('${')) return v.replace(/\$\{([^}]+)\}/g, (_, n) => String(pick(vars, n.trim()) ?? ''));
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => resolveArg(x, vars));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveArg(x, vars)]));
  return v;
}

/** run the node's configured operation; returns the variables to write (or an error for the engine) */
export async function runOperation(c: HandlerCtx, target: 'case' | 'process') {
  const n = c.node;
  const op = OP_BY_KEY[String(n.operation ?? '')];
  if (!op || (op.target !== target && op.target !== 'both')) return { error: `unknown ${target} operation "${n.operation ?? ''}"`, errorCode: 'INSTANCE_OP_ERROR' };
  const args: Record<string, unknown> = {};
  for (const p of op.params) if (n[p.key] !== undefined) args[p.key] = resolveArg(n[p.key], c.inst.variables);
  const ctx = c.app;
  const [{ InstanceService }, { WorkflowInstanceService }, { resolveWorkflowServiceStore }, { AnalyticsService }] = await Promise.all([
    import('../../../modules/instances/service.ts'), import('../../../workflow-service/services/workflow-instance-service.ts'),
    import('../../../workflow-service/store/index.ts'), import('../../../analytics/service.ts'),
  ]);
  const store = resolveWorkflowServiceStore(ctx.store);
  const env: OpEnv = { c, args, actor: c.inst.startedBy || 'system', ctx, instances: new InstanceService(ctx, c.emit), cases: new WorkflowInstanceService(ctx, store, c.emit), analytics: new AnalyticsService(ctx, store) };
  try {
    let result = await op.run(env);
    if (n.resultPath) result = pick(result, String(n.resultPath));
    const size = JSON.stringify(result ?? null).length;
    if (size > MAX_RESULT_BYTES) throw conflict(`the result is ${Math.round(size / 1024)} KB, over the ${MAX_RESULT_BYTES / 1000} KB a variable may hold — narrow it (a Result path, a smaller query)`);
    return { vars: n.resultTo ? { [String(n.resultTo)]: result ?? null } : {}, outcome: `${op.key}` };
  } catch (e) {
    const err = e as Error & { code?: string };
    if (n.onError === 'store') return { vars: n.resultTo ? { [String(n.resultTo)]: { error: err.message, code: err.code ?? 'INSTANCE_OP_ERROR' } } : {}, outcome: `${op.key} (error stored)` };
    return { error: err.message, errorCode: 'INSTANCE_OP_ERROR', errorDetails: { operation: op.key, code: err.code } };
  }
}

/** the node's property schema: operation select + each operation's own fields (shown only for that operation) + the shared result fields */
export function buildSchema(target: 'case' | 'process'): { operations: OpDef[]; fields: UiField[] } {
  const operations = opsFor(target);
  const byKey = new Map<string, { field: UiField; ops: string[] }>();
  for (const o of operations) for (const p of o.params) {
    const cur = byKey.get(p.key);
    if (cur) cur.ops.push(o.key); else byKey.set(p.key, { field: p, ops: [o.key] });
  }
  const fields = [...byKey.values()].map(({ field, ops }) => ({ ...field, when: { key: 'operation', in: ops } }));
  return { operations, fields };
}
