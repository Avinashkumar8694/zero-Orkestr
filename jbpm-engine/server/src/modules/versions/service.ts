// Versions: immutable-once-published snapshots of the engine JSON on a branch.
// Saving writes to the branch's head DRAFT (creating one if the head is published); publishing freezes
// the draft and opens a fresh draft as the new head.
import type { AppContext } from '../../context.ts';
import { Collections, type Branch, type Version, type Workflow } from '../../domain.ts';
import type { EngineProject } from '../../sdk/index.ts';
import { conflict, notFound, validation } from '../../infra/errors.ts';
import { ValidationService } from '../validation/service.ts';

export interface DiffResult {
  nodes: { added: string[]; removed: string[]; changed: string[] };
  flows: { added: string[]; removed: string[]; changed: string[] };
  vars: { added: string[]; removed: string[]; changed: string[] };
}

export class VersionService {
  constructor(private ctx: AppContext) {}
  private ve() { return this.ctx.store.repo<Version>(Collections.versions); }
  private br() { return this.ctx.store.repo<Branch>(Collections.branches); }

  private async mine(id: string): Promise<Version> {
    const v = await this.ve().get(id);
    if (!v || v.tenantId !== this.ctx.tenantId) throw notFound('Version');
    return v;
  }

  async get(id: string) { return this.mine(id); }

  async listByBranch(branchId: string): Promise<Version[]> {
    return (await this.ve().query((v) => v.tenantId === this.ctx.tenantId && v.branchId === branchId))
      .sort((a, b) => a.number - b.number);
  }

  /** Save engine JSON to the branch's head draft (creating a new draft if head is published). */
  async saveDraft(branchId: string, engine: EngineProject, actor: string, message?: string): Promise<Version> {
    const branch = await this.br().get(branchId);
    if (!branch || branch.tenantId !== this.ctx.tenantId) throw notFound('Branch');

    let head = branch.headVersionId ? await this.ve().get(branch.headVersionId) : undefined;
    let savedVersion: Version;
    if (head && head.state === 'draft') {
      head.engine = engine; head.message = message ?? head.message;
      await this.ve().put(head);
      await this.ctx.audit({ actor, kind: 'version.saved', workflowId: branch.workflowId, data: { versionId: head.id } });
      savedVersion = head;
    } else {
      // head is published (or none) -> open a new draft numbered after the current head
      const all = await this.listByBranch(branchId);
      const nextNumber = (all.at(-1)?.number || 0) + 1;
      const version: Version = {
        id: this.ctx.newId(), tenantId: this.ctx.tenantId, workflowId: branch.workflowId, branchId,
        number: nextNumber, state: 'draft', engine, parentVersionId: head?.id, message,
        createdAt: this.ctx.clock(), createdBy: actor,
      };
      await this.ve().put(version);
      branch.headVersionId = version.id;
      await this.br().put(branch);
      await this.ctx.audit({ actor, kind: 'version.created', workflowId: branch.workflowId, data: { versionId: version.id, number: nextNumber } });
      savedVersion = version;
    }

    // Maintain cached validationSummary on Workflow for fast project-level visual danger indicators
    try {
      const valRes = await new ValidationService().validateProject(engine);
      const wfRepo = this.ctx.store.repo<Workflow>(Collections.workflows);
      const wf = await wfRepo.get(branch.workflowId);
      if (wf) {
        wf.validationSummary = {
          hasErrors: !valRes.ok,
          errorCount: valRes.errors.length,
          warningCount: valRes.warnings.length,
          problems: valRes.problems,
        };
        await wfRepo.put(wf);
      }
    } catch {
      // best-effort cache update
    }

    return savedVersion;
  }

  /** Freeze a draft and open a new draft head that continues from it. Blocks on validation errors. */
  async publish(id: string, actor: string, label?: string): Promise<{ published: Version; newDraft: Version }> {
    const v = await this.mine(id);
    if (v.state === 'published') throw conflict('version already published');
    const procs = v.engine.processes || [];
    if (!procs.length) throw validation('version has no process');
    await new ValidationService().assertValidProject(v.engine, 'publish');   // all processes in project must be valid

    v.state = 'published'; v.label = label ?? v.label;
    await this.ve().put(v);

    const newDraft: Version = {
      id: this.ctx.newId(), tenantId: this.ctx.tenantId, workflowId: v.workflowId, branchId: v.branchId,
      number: v.number + 1, state: 'draft', engine: v.engine, parentVersionId: v.id,
      createdAt: this.ctx.clock(), createdBy: actor,
    };
    await this.ve().put(newDraft);
    const branch = await this.br().get(v.branchId);
    if (branch) { branch.headVersionId = newDraft.id; await this.br().put(branch); }
    await this.ctx.audit({ actor, kind: 'version.published', workflowId: v.workflowId, data: { versionId: v.id, label } });
    return { published: v, newDraft };
  }

  async validate(id: string) {
    const v = await this.mine(id);
    if (!v.engine.processes?.length) throw validation('version has no process');
    return await new ValidationService().validateProject(v.engine);
  }

  async diff(aId: string, bId: string): Promise<DiffResult> {
    const a = await this.mine(aId); const b = await this.mine(bId);
    const pa = a.engine.processes?.[0]; const pb = b.engine.processes?.[0];
    const byId = <T extends { id?: string }>(arr: T[] = []) => new Map(arr.filter((x) => x.id).map((x) => [x.id as string, x]));
    const delta = <T extends { id?: string }>(la: T[] = [], lb: T[] = []) => {
      const ma = byId(la); const mb = byId(lb);
      const added = [...mb.keys()].filter((k) => !ma.has(k));
      const removed = [...ma.keys()].filter((k) => !mb.has(k));
      const changed = [...ma.keys()].filter((k) => mb.has(k) && JSON.stringify(ma.get(k)) !== JSON.stringify(mb.get(k)));
      return { added, removed, changed };
    };
    const varsA = (pa?.vars || []).map((v) => ({ id: v.name, ...v }));
    const varsB = (pb?.vars || []).map((v) => ({ id: v.name, ...v }));
    return {
      nodes: delta(pa?.nodes as any, pb?.nodes as any),
      flows: delta((pa?.flows || []).map((f, i) => ({ id: f.id || `${f.from}->${f.to}#${i}`, ...f })) as any,
                   (pb?.flows || []).map((f, i) => ({ id: f.id || `${f.from}->${f.to}#${i}`, ...f })) as any),
      vars: delta(varsA as any, varsB as any),
    };
  }
}
