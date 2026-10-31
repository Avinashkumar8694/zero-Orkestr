// Manage the processes inside a PROJECT (Workflow). A project's head-draft version.engine is an
// EngineProject with a processes[] array; this service lists/adds/renames/removes and gets/saves a
// single process while preserving the rest of the project (other processes + assets).
import type { AppContext } from '../../context.ts';
import type { EngineProcess, EngineProject } from '../../sdk/index.ts';
import { WorkflowService } from '../workflows/service.ts';
import { VersionService } from '../versions/service.ts';
import { notFound, validation } from '../../infra/errors.ts';
import { ValidationService, type Problem } from '../validation/service.ts';

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export interface ProcessSummary {
  id: string;
  name: string;
  nodes: number;
  flows: number;
  hasErrors?: boolean;
  errorCount?: number;
  warningCount?: number;
  problems?: Problem[];
}

export class ProcessService {
  private wf: WorkflowService;
  private ver: VersionService;
  constructor(private ctx: AppContext) { this.wf = new WorkflowService(ctx); this.ver = new VersionService(ctx); }

  private async head(projectId: string): Promise<{ branchId: string; key: string; engine: EngineProject }> {
    const project = await this.wf.get(projectId);
    const versions = await this.ver.listByBranch(project.defaultBranchId);
    const head = versions.filter((v) => v.state === 'draft').at(-1) || versions.at(-1);
    if (!head) throw notFound('draft version');
    return { branchId: project.defaultBranchId, key: project.key, engine: head.engine };
  }
  private async saveEngine(branchId: string, engine: EngineProject, actor: string) { await this.ver.saveDraft(branchId, engine, actor); }

  async getEngine(projectId: string): Promise<EngineProject> { return (await this.head(projectId)).engine; }

  async list(projectId: string): Promise<ProcessSummary[]> {
    const { engine } = await this.head(projectId);
    const vService = new ValidationService();
    return Promise.all((engine.processes || []).map(async (p) => {
      const v = await vService.validate(p);
      return {
        id: p.id!,
        name: p.name || p.id!,
        nodes: (p.nodes || []).length,
        flows: (p.flows || []).length,
        hasErrors: !v.ok,
        errorCount: v.errors.length,
        warningCount: v.warnings.length,
        problems: v.problems,
      };
    }));
  }

  async getProcess(projectId: string, processId: string): Promise<EngineProcess> {
    const { engine } = await this.head(projectId);
    const p = (engine.processes || []).find((x) => x.id === processId);
    if (!p) throw notFound('Process');
    return p;
  }

  async add(projectId: string, name: string, actor: string): Promise<ProcessSummary> {
    const nm = (name || '').trim();
    if (!nm) throw validation('process name is required');
    const { branchId, key, engine } = await this.head(projectId);
    engine.processes ||= [];
    let id = `${key}.${slug(nm)}`;
    if (engine.processes.some((p) => p.id === id)) id = `${id}-${engine.processes.length + 1}`;
    const proc: EngineProcess = { id, name: nm, package: 'com.acme', vars: [], nodes: [{ id: 'start', type: 'start', name: 'Start' } as any], flows: [] };
    engine.processes.push(proc);
    await this.saveEngine(branchId, engine, actor);
    await this.ctx.audit({ actor, kind: 'process.added', workflowId: projectId, data: { processId: id } });
    return { id, name: nm, nodes: 1, flows: 0 };
  }

  async rename(projectId: string, processId: string, name: string, actor: string): Promise<void> {
    const { branchId, engine } = await this.head(projectId);
    const p = (engine.processes || []).find((x) => x.id === processId);
    if (!p) throw notFound('Process');
    p.name = (name || '').trim() || p.name;
    await this.saveEngine(branchId, engine, actor);
  }

  async remove(projectId: string, processId: string, actor: string): Promise<void> {
    const { branchId, engine } = await this.head(projectId);
    const before = (engine.processes || []).length;
    engine.processes = (engine.processes || []).filter((x) => x.id !== processId);
    if (engine.processes.length === before) throw notFound('Process');
    await this.saveEngine(branchId, engine, actor);
    await this.ctx.audit({ actor, kind: 'process.removed', workflowId: projectId, data: { processId } });
  }

  /** Replace a single process (from the builder) without touching the rest of the project. */
  async saveProcess(projectId: string, processId: string, process: EngineProcess, actor: string): Promise<void> {
    const { branchId, engine } = await this.head(projectId);
    const idx = (engine.processes || []).findIndex((x) => x.id === processId);
    if (idx < 0) throw notFound('Process');
    engine.processes![idx] = { ...process, id: processId };   // keep the id stable
    await this.saveEngine(branchId, engine, actor);
  }
}
