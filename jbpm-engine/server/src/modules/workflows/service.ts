// Workflow lifecycle: create (with a main branch + initial draft v1), read/update, permissions, vars.
import type { AppContext } from '../../context.ts';
import { Collections, type Branch, type Folder, type Version, type Workflow, type WorkflowPermission } from '../../domain.ts';
import type { EngineProject, EngineVar } from '../../sdk/index.ts';
import { notFound, validation } from '../../infra/errors.ts';

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function emptyEngine(id: string, name: string, key: string): EngineProject {
  return {
    id: key, name,
    processes: [{
      id: `${key}.process`, name, package: 'com.acme',
      vars: [], nodes: [{ id: 'start', type: 'start', name: 'Start' }], flows: [],
    }],
  } as unknown as EngineProject;
}

import { enforceWorkflowCreate } from '../plans/plans.ts';

export class WorkflowService {
  constructor(private ctx: AppContext) {}
  private wf() { return this.ctx.store.repo<Workflow>(Collections.workflows); }
  private br() { return this.ctx.store.repo<Branch>(Collections.branches); }
  private ve() { return this.ctx.store.repo<Version>(Collections.versions); }
  private fo() { return this.ctx.store.repo<Folder>(Collections.folders); }

  private async assertFolderValid(folderId: string | null | undefined): Promise<void> {
    if (!folderId) return;
    const f = await this.fo().get(folderId);
    if (!f || f.tenantId !== this.ctx.tenantId) throw notFound('Folder');
  }

  async list(includeArchived = false): Promise<Workflow[]> {
    return (await this.wf().query((w) => w.tenantId === this.ctx.tenantId && (includeArchived ? true : !w.archived)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async listArchived(): Promise<Workflow[]> {
    return (await this.wf().query((w) => w.tenantId === this.ctx.tenantId && Boolean(w.archived)))
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }

  async get(id: string): Promise<Workflow> {
    const w = await this.wf().get(id);
    if (!w || w.tenantId !== this.ctx.tenantId) throw notFound('Workflow');
    return w;
  }

  async create(input: { name: string; key?: string; description?: string; folderId?: string | null }, actor: string): Promise<Workflow> {
    const name = (input.name || '').trim();
    if (!name) throw validation('name is required');
    await enforceWorkflowCreate(this.ctx);      // plan: expiry + maxWorkflows
    const key = slug(input.key || name);
    // Archived workflows don't count as a collision — list() already hides them, so a name should be
    // freely reusable once its previous holder is archived, not permanently reserved by a hidden record.
    const dupe = await this.wf().query((w) => w.tenantId === this.ctx.tenantId && w.key === key && !w.archived);
    if (dupe.length) throw validation(`key "${key}" already exists`);
    await this.assertFolderValid(input.folderId);

    const now = this.ctx.clock();
    const wfId = this.ctx.newId();
    const branchId = this.ctx.newId();
    const versionId = this.ctx.newId();

    const workflow: Workflow = {
      id: wfId, tenantId: this.ctx.tenantId, name, key, description: input.description,
      defaultBranchId: branchId, permissions: [], variables: [], folderId: input.folderId || null,
      createdAt: now, createdBy: actor, updatedAt: now, updatedBy: actor,
    };
    const branch: Branch = {
      id: branchId, tenantId: this.ctx.tenantId, workflowId: wfId, name: 'main',
      headVersionId: versionId, protected: true, createdAt: now, createdBy: actor,
    };
    const version: Version = {
      id: versionId, tenantId: this.ctx.tenantId, workflowId: wfId, branchId,
      number: 1, state: 'draft', engine: emptyEngine(wfId, name, key),
      createdAt: now, createdBy: actor,
    };

    await this.wf().put(workflow);
    await this.br().put(branch);
    await this.ve().put(version);
    await this.ctx.audit({ actor, kind: 'workflow.created', workflowId: wfId, data: { name, key } });
    return workflow;
  }

  async update(id: string, patch: Partial<Pick<Workflow, 'name' | 'description' | 'permissions' | 'variables' | 'folderId' | 'instanceCreationMode' | 'env' | 'globalErrorHandler'>>, actor: string): Promise<Workflow> {
    const w = await this.get(id);
    if (patch.name !== undefined) w.name = patch.name.trim() || w.name;
    if (patch.description !== undefined) w.description = patch.description;
    if (patch.permissions !== undefined) w.permissions = patch.permissions;
    if (patch.variables !== undefined) w.variables = patch.variables;
    if (patch.folderId !== undefined) { await this.assertFolderValid(patch.folderId); w.folderId = patch.folderId; }
    if (patch.instanceCreationMode !== undefined) w.instanceCreationMode = patch.instanceCreationMode;
    if (patch.env !== undefined) w.env = patch.env;
    if (patch.globalErrorHandler !== undefined) w.globalErrorHandler = patch.globalErrorHandler;
    w.updatedAt = this.ctx.clock(); w.updatedBy = actor;
    await this.wf().put(w);
    await this.ctx.audit({ actor, kind: 'workflow.updated', workflowId: id });
    return w;
  }

  async setPermissions(id: string, permissions: WorkflowPermission[], actor: string) {
    return this.update(id, { permissions }, actor);
  }
  async setVariables(id: string, variables: EngineVar[], actor: string) {
    return this.update(id, { variables }, actor);
  }

  async archive(id: string, actor: string): Promise<void> {
    const w = await this.get(id);
    w.archived = true; w.updatedAt = this.ctx.clock(); w.updatedBy = actor;
    await this.wf().put(w);
    await this.ctx.audit({ actor, kind: 'workflow.archived', workflowId: id });
  }

  async restore(id: string, actor: string): Promise<Workflow> {
    const w = await this.get(id);
    w.archived = false;
    w.updatedAt = this.ctx.clock();
    w.updatedBy = actor;
    await this.wf().put(w);
    await this.ctx.audit({ actor, kind: 'workflow.restored', workflowId: id });
    return w;
  }

  async purge(id: string, actor: string): Promise<void> {
    const w = await this.get(id);
    // Delete all branches associated with this workflow
    const branches = await this.br().query((b) => b.tenantId === this.ctx.tenantId && b.workflowId === id);
    for (const b of branches) {
      await this.br().delete(b.id);
    }
    // Delete all versions associated with this workflow
    const versions = await this.ve().query((v) => v.tenantId === this.ctx.tenantId && v.workflowId === id);
    for (const v of versions) {
      await this.ve().delete(v.id);
    }
    // Delete the workflow record itself
    await this.wf().delete(id);
    await this.ctx.audit({ actor, kind: 'workflow.purged', workflowId: id, data: { name: w.name, key: w.key } });
  }

  async purgeAllArchived(actor: string): Promise<{ purgedCount: number }> {
    const archived = await this.listArchived();
    for (const w of archived) {
      await this.purge(w.id, actor);
    }
    return { purgedCount: archived.length };
  }
}
