// WorkflowDefinition — the stable, human-named handle a client app holds onto across redeployments
// (see ../domain.ts's own doc comment). Owns the JSON-Schema (ajv) compile/validate step shared with
// WorkflowInstanceService's create/data-update flows.
import Ajv, { type ValidateFunction } from 'ajv';
import type { AppContext } from '../../context.ts';
import { DeploymentService } from '../../modules/deployments/service.ts';
import { notFound, validation, conflict } from '../../infra/errors.ts';
import type { WorkflowServiceStore } from '../store/types.ts';
import type { WorkflowDefinition } from '../domain.ts';

const ajv = new Ajv({ allErrors: true, strict: false });
// one compiled validator per distinct schema object (identity-cached, not per-definition-id, so an
// unchanged schema across many definitions/instances only ever compiles once).
const compiledCache = new WeakMap<object, ValidateFunction>();

export class WorkflowDefinitionService {
  constructor(private ctx: AppContext, private store: WorkflowServiceStore) {}
  private repo() { return this.store.definitions(); }

  async get(id: string): Promise<WorkflowDefinition> {
    const d = await this.repo().get(id);
    if (!d || d.tenantId !== this.ctx.tenantId) throw notFound('WorkflowDefinition');
    return d;
  }

  async getByName(name: string): Promise<WorkflowDefinition> {
    const [d] = await this.repo().query((x) => x.tenantId === this.ctx.tenantId && x.name === name);
    if (!d) throw notFound(`WorkflowDefinition "${name}"`);
    return d;
  }

  async list(): Promise<WorkflowDefinition[]> {
    return (await this.repo().query((d) => d.tenantId === this.ctx.tenantId)).sort((a, b) => a.name.localeCompare(b.name));
  }

  async create(input: { name: string; deploymentId: string; processId?: string; dataSchema?: Record<string, unknown>; schemaValidationEnabled?: boolean }, actor: string): Promise<WorkflowDefinition> {
    const name = (input.name || '').trim();
    if (!name) throw validation('name is required');
    if (!input.deploymentId?.trim()) throw validation('deploymentId is required');
    await new DeploymentService(this.ctx).get(input.deploymentId);   // 404s if it doesn't resolve in this tenant
    const dupe = await this.repo().query((d) => d.tenantId === this.ctx.tenantId && d.name === name);
    if (dupe.length) throw conflict(`a workflow definition named "${name}" already exists`);
    const dataSchema = input.dataSchema || {};
    this.assertValidSchema(dataSchema);
    const now = this.ctx.clock();
    const def: WorkflowDefinition = {
      id: this.ctx.newId(), tenantId: this.ctx.tenantId, name, deploymentId: input.deploymentId,
      processId: input.processId?.trim() || undefined,
      dataSchema, schemaValidationEnabled: !!input.schemaValidationEnabled,
      createdAt: now, createdBy: actor, updatedAt: now, updatedBy: actor,
    };
    await this.repo().put(def);
    await this.ctx.audit({ actor, kind: 'workflowDefinition.created', deploymentId: def.deploymentId, data: { id: def.id, name } });
    return def;
  }

  async update(id: string, patch: { name?: string; deploymentId?: string; processId?: string; dataSchema?: Record<string, unknown>; schemaValidationEnabled?: boolean }, actor: string): Promise<WorkflowDefinition> {
    const d = await this.get(id);
    if (patch.deploymentId) await new DeploymentService(this.ctx).get(patch.deploymentId);
    if (patch.name && patch.name.trim() !== d.name) {
      const dupe = await this.repo().query((x) => x.tenantId === this.ctx.tenantId && x.id !== id && x.name === patch.name!.trim());
      if (dupe.length) throw conflict(`a workflow definition named "${patch.name}" already exists`);
    }
    if (patch.dataSchema) this.assertValidSchema(patch.dataSchema);
    const next: WorkflowDefinition = {
      ...d,
      name: patch.name?.trim() || d.name,
      deploymentId: patch.deploymentId || d.deploymentId,
      processId: patch.processId !== undefined ? (patch.processId ? patch.processId.trim() : undefined) : d.processId,
      dataSchema: patch.dataSchema ?? d.dataSchema,
      schemaValidationEnabled: patch.schemaValidationEnabled ?? d.schemaValidationEnabled,
      updatedAt: this.ctx.clock(), updatedBy: actor,
    };
    await this.repo().put(next);
    await this.ctx.audit({ actor, kind: 'workflowDefinition.updated', deploymentId: next.deploymentId, data: { id, changed: Object.keys(patch) } });
    return next;
  }

  private assertValidSchema(schema: Record<string, unknown>): void {
    try { this.compiled(schema); } catch (e) { throw validation(`invalid data schema: ${(e as Error).message}`); }
  }

  private compiled(schema: Record<string, unknown>): ValidateFunction {
    let v = compiledCache.get(schema);
    if (!v) { v = ajv.compile(schema); compiledCache.set(schema, v); }
    return v;
  }

  /** Validates `data` against `definition.dataSchema` — a no-op (never throws) when
   *  `schemaValidationEnabled` is false, matching the user's own framing: "if schema validation
   *  enabled that will be validated then updated, if disabled directly can be updated." */
  validateData(definition: WorkflowDefinition, data: Record<string, unknown>): void {
    if (!definition.schemaValidationEnabled) return;
    const validate = this.compiled(definition.dataSchema);
    if (!validate(data)) {
      throw validation('workflowData failed schema validation', { errors: validate.errors });
    }
  }
}
