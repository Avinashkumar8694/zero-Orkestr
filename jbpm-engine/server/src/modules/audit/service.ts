// Read API over the audit trail every service already writes via ctx.audit() (see context.ts).
// The Audit Log screen filters on actor / kind / entity ids / time and pages newest-first.
import type { AppContext } from '../../context.ts';
import { Collections, type AuditEvent } from '../../domain.ts';
import { notFound } from '../../infra/errors.ts';

export interface AuditQuery {
  actor?: string;
  /** exact kind ('task.claimed') or a prefix ('task.' matches every task event) */
  kind?: string;
  workflowId?: string;
  deploymentId?: string;
  instanceId?: string;
  taskId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export class AuditService {
  constructor(private ctx: AppContext) {}
  private repo() { return this.ctx.store.repo<AuditEvent>(Collections.audit); }

  async list(q: AuditQuery = {}): Promise<{ items: AuditEvent[]; total: number }> {
    const all = await this.repo().query((e) => {
      if (e.tenantId !== this.ctx.tenantId) return false;
      if (q.actor && e.actor !== q.actor) return false;
      if (q.kind && e.kind !== q.kind && !(q.kind.endsWith('.') && e.kind.startsWith(q.kind))) return false;
      if (q.workflowId && e.workflowId !== q.workflowId) return false;
      if (q.deploymentId && e.deploymentId !== q.deploymentId) return false;
      if (q.instanceId && e.instanceId !== q.instanceId) return false;
      if (q.taskId && e.taskId !== q.taskId) return false;
      if (q.from && e.at < q.from) return false;
      if (q.to && e.at > q.to) return false;
      return true;
    });
    all.sort((a, b) => (a.at < b.at ? 1 : -1));
    const offset = q.offset ?? 0;
    const limit = q.limit ?? 50;
    return { items: all.slice(offset, offset + limit), total: all.length };
  }

  /** Distinct kinds + actors present in the log — populates the filter dropdowns. Optional workflowId scopes to one project. */
  async facets(workflowId?: string): Promise<{ kinds: string[]; actors: string[] }> {
    const all = await this.repo().query((e) => {
      if (e.tenantId !== this.ctx.tenantId) return false;
      if (workflowId && e.workflowId !== workflowId) return false;
      return true;
    });
    return {
      kinds: [...new Set(all.map((e) => e.kind))].sort(),
      actors: [...new Set(all.map((e) => e.actor))].sort(),
    };
  }

  async get(id: string, workflowId?: string): Promise<AuditEvent> {
    const ev = await this.repo().get(id);
    if (!ev || ev.tenantId !== this.ctx.tenantId) throw notFound('audit event not found');
    if (workflowId && ev.workflowId !== workflowId) throw notFound('audit event not found');
    return ev;
  }
}
