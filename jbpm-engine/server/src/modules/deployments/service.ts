// Deployments: immutable runnable snapshots of a published version, labeled with tags, grouped by
// environment. Exactly one deployment is ACTIVE per (workflow, environment). See docs/09.
import type { AppContext } from '../../context.ts';
import { Collections, type Branch, type Deployment, type TimerJob, type Version, type Workflow } from '../../domain.ts';
import { conflict, notFound, validation } from '../../infra/errors.ts';
import { computeDue } from '../../engine/duration.ts';
import { NotificationService } from '../notifications/service.ts';
import { VersionService } from '../versions/service.ts';
import { WorkflowService } from '../workflows/service.ts';
import { ValidationService } from '../validation/service.ts';

import { enforceDeploy } from '../plans/plans.ts';

export class DeploymentService {
  constructor(private ctx: AppContext) {}
  private dp() { return this.ctx.store.repo<Deployment>(Collections.deployments); }
  private ve() { return this.ctx.store.repo<Version>(Collections.versions); }
  private tm() { return this.ctx.store.repo<TimerJob>(Collections.timers); }
  private wf() { return this.ctx.store.repo<Workflow>(Collections.workflows); }

  async get(id: string): Promise<Deployment> {
    const d = await this.dp().get(id);
    if (!d || d.tenantId !== this.ctx.tenantId) throw notFound('Deployment');
    return d;
  }

  async listByWorkflow(workflowId: string): Promise<Deployment[]> {
    return (await this.dp().query((d) => d.tenantId === this.ctx.tenantId && d.workflowId === workflowId))
      .sort((a, b) => b.deployedAt.localeCompare(a.deployedAt));
  }

  /** Cross-project listing (mirrors InstanceService.list) — powers the top-level Deployments page,
   *  which browses across every project rather than requiring one to be picked first. */
  async list(filter: { workflowId?: string; environment?: string; status?: string; search?: string; limit?: number; offset?: number }): Promise<Deployment[]> {
    const q = (filter.search || '').trim().toLowerCase();
    const all = (await this.dp().query((d) =>
      d.tenantId === this.ctx.tenantId &&
      (!filter.workflowId || d.workflowId === filter.workflowId) &&
      (!filter.environment || d.environment === filter.environment) &&
      (!filter.status || d.status === filter.status) &&
      (!q || d.id.toLowerCase().includes(q) || d.workflowId.toLowerCase().includes(q) || d.environment.toLowerCase().includes(q) || (d.versionLabel || '').toLowerCase().includes(q))))
      .sort((a, b) => b.deployedAt.localeCompare(a.deployedAt));

    const offset = filter.offset != null ? Number(filter.offset) : 0;
    const limit = filter.limit != null ? Number(filter.limit) : all.length;
    return all.slice(offset, offset + limit);
  }

  /** Snapshot a published version into an inactive deployment. */
  async deploy(versionId: string, input: { environment: string; tags?: string[]; env?: Record<string, string>; activate?: boolean }, actor: string): Promise<Deployment> {
    const v = await this.ve().get(versionId);
    if (!v || v.tenantId !== this.ctx.tenantId) throw notFound('Version');
    if (v.state !== 'published') throw conflict('only published versions can be deployed');
    const environment = (input.environment || '').trim();
    if (!environment) throw validation('environment is required');
    await enforceDeploy(this.ctx);               // plan: expiry + maxDeployments

    // Strict validation gate: Invalid or unsupported processes cannot be deployed
    await new ValidationService().assertValidProject(v.engine, 'deploy');

    const workflow = await this.wf().get(v.workflowId);
    const mergedEnv = { ...(workflow?.env || {}), ...(input.env || {}) };

    const dep: Deployment = {
      id: this.ctx.newId(), tenantId: this.ctx.tenantId, workflowId: v.workflowId, versionId: v.id, branchId: v.branchId,
      engine: structuredClone(v.engine), env: mergedEnv,
      globalErrorHandler: workflow?.globalErrorHandler,
      tags: [...new Set([environment, ...(input.tags || [])])],
      status: 'inactive', environment,
      versionNumber: v.number, versionLabel: v.label,
      deployedAt: this.ctx.clock(), deployedBy: actor,
      snapshot: {
        frozenAt: this.ctx.clock(),
        versionNumber: v.number,
        versionLabel: v.label,
        frozen: true,
      },
    };
    await this.dp().put(dep);
    await this.ctx.audit({ actor, kind: 'deployment.created', workflowId: v.workflowId, deploymentId: dep.id, data: { versionId, environment, tags: dep.tags } });
    if (input.activate) return this.activate(dep.id, actor);
    return dep;
  }

  async setTags(id: string, change: { add?: string[]; remove?: string[] }, actor: string): Promise<Deployment> {
    const d = await this.get(id);
    const set = new Set(d.tags);
    for (const t of change.add || []) set.add(t);
    for (const t of change.remove || []) if (t !== d.environment) set.delete(t); // never remove the environment tag
    d.tags = [...set];
    await this.dp().put(d);
    await this.ctx.audit({ actor, kind: 'deployment.tagged', workflowId: d.workflowId, deploymentId: id, data: { tags: d.tags } });
    return d;
  }

  /** Activate this deployment in its environment; atomically deactivate the previous active one. */
  async activate(id: string, actor: string): Promise<Deployment> {
    const d = await this.get(id);
    if (d.status === 'archived') throw conflict('cannot activate an archived deployment');
    if (d.engine) {
      await new ValidationService().assertValidProject(d.engine, 'activate');
    }
    const siblings = await this.dp().query((x) =>
      x.tenantId === this.ctx.tenantId && x.workflowId === d.workflowId && x.environment === d.environment && x.status === 'active');
    for (const s of siblings) {
      if (s.id === d.id) continue;
      s.status = 'inactive'; s.undeployedAt = this.ctx.clock();
      await this.dp().put(s);
      await this.ctx.audit({ actor, kind: 'deployment.deactivated', workflowId: d.workflowId, deploymentId: s.id });
    }
    d.status = 'active'; d.undeployedAt = undefined;
    await this.dp().put(d);
    await this.ctx.audit({ actor, kind: 'deployment.activated', workflowId: d.workflowId, deploymentId: id, data: { environment: d.environment } });
    if (actor && actor !== 'system') {
      await new NotificationService(this.ctx).notify({
        userId: actor, kind: 'deployment-succeeded',
        title: `Deployment is live on ${d.environment}`,
        body: d.versionLabel ? `version ${d.versionNumber} (${d.versionLabel})` : `version ${d.versionNumber ?? ''}`.trim(),
        link: `/deployments`, deploymentId: d.id,
      });
    }
    await this.syncStartTimers(d);
    return d;
  }

  /**
   * Reconcile start-timer / cron scheduled starts for (workflow, environment): cancel every scheduled
   * start job in that scope, then schedule a fresh job per timer-triggered start node of whichever
   * deployment is currently active. Called on activate/undeploy/archive so exactly the live
   * deployment's schedule runs. `changed` names the (workflow, environment) scope to reconcile.
   */
  private async syncStartTimers(changed: Deployment): Promise<void> {
    const scope = await this.dp().query((x) =>
      x.tenantId === this.ctx.tenantId && x.workflowId === changed.workflowId && x.environment === changed.environment);
    const ids = new Set(scope.map((x) => x.id));
    const stale = await this.tm().query((t) => t.kind === 'start' && t.status === 'scheduled' && ids.has(t.deploymentId || ''));
    for (const t of stale) { t.status = 'cancelled'; await this.tm().put(t); }
    const active = scope.find((x) => x.status === 'active');
    if (!active) return;
    const now = this.ctx.clock();
    for (const p of active.engine?.processes || []) {
      for (const n of p.nodes || []) {
        if (n.type !== 'start') continue;
        const spec = (n as any).on?.timer ?? (n as any).timer;   // ISO duration/date or { cycle: 'R/PT1H' }
        if (!spec) continue;
        const cycle = typeof spec === 'object' ? spec.cycle : (typeof spec === 'string' && spec.startsWith('R') ? spec : undefined);
        const job: TimerJob = {
          id: this.ctx.newId(), tenantId: this.ctx.tenantId, instanceId: '', tokenId: '', nodeId: n.id!,
          kind: 'start', dueAt: computeDue(cycle ? { cycle } : spec, now), cycle, fired: 0, status: 'scheduled',
          deploymentId: active.id, processId: p.id,
        };
        await this.tm().put(job);
      }
    }
  }

  async rollback(environment: string, toDeploymentId: string, actor: string): Promise<Deployment> {
    const target = await this.get(toDeploymentId);
    if (target.environment !== environment) throw validation('target deployment is in a different environment');
    return this.activate(toDeploymentId, actor);
  }

  async undeploy(id: string, actor: string): Promise<Deployment> {
    const d = await this.get(id);
    d.status = 'inactive'; d.undeployedAt = this.ctx.clock();
    await this.dp().put(d);
    await this.ctx.audit({ actor, kind: 'deployment.undeployed', workflowId: d.workflowId, deploymentId: id });
    await this.syncStartTimers(d);   // no longer active → cancels its scheduled starts
    return d;
  }

  async archive(id: string, actor: string): Promise<Deployment> {
    const d = await this.get(id);
    d.status = 'archived'; d.archivedAt = this.ctx.clock();
    await this.dp().put(d);
    await this.ctx.audit({ actor, kind: 'deployment.archived', workflowId: d.workflowId, deploymentId: id });
    await this.syncStartTimers(d);
    return d;
  }

  /** Resolve the deployment that should serve a new instance for (workflow, environment). */
  async resolveActive(workflowId: string, environment: string): Promise<Deployment> {
    const active = await this.dp().query((d) =>
      d.tenantId === this.ctx.tenantId && d.workflowId === workflowId && d.environment === environment && d.status === 'active');
    if (!active.length) throw conflict(`no active deployment for environment "${environment}"`);
    return active[0]!;
  }

  /** Export frozen deployment snapshot package for download or archiving. */
  async exportSnapshot(id: string): Promise<any> {
    const d = await this.get(id);
    return {
      format: 'jbpm-deployment-snapshot',
      version: 1,
      exportedAt: this.ctx.clock(),
      deployment: {
        id: d.id,
        workflowId: d.workflowId,
        environment: d.environment,
        versionNumber: d.versionNumber,
        versionLabel: d.versionLabel,
        deployedAt: d.deployedAt,
        deployedBy: d.deployedBy,
        tags: d.tags,
        env: d.env,
        status: d.status,
      },
      engine: structuredClone(d.engine),
    };
  }

  /** Restore deployment snapshot into the project (writes a fresh draft to the project's branch). */
  async restore(id: string, actor: string): Promise<{ ok: boolean; workflowId: string; versionNumber?: number; message: string }> {
    const d = await this.get(id);
    const workflows = this.ctx.store.repo<Workflow>(Collections.workflows);
    const w = await workflows.get(d.workflowId);
    if (!w || w.tenantId !== this.ctx.tenantId) throw notFound('Workflow');

    const verSvc = new VersionService(this.ctx);
    const draft = await verSvc.saveDraft(
      w.defaultBranchId,
      structuredClone(d.engine),
      actor,
      `Restored from deployment snapshot ${d.id} (v${d.versionNumber ?? '?'}, ${d.environment})`
    );

    await this.ctx.audit({
      actor,
      kind: 'deployment.restored',
      workflowId: d.workflowId,
      deploymentId: d.id,
      data: {
        draftVersionId: draft.id,
        versionNumber: d.versionNumber,
        environment: d.environment,
      },
    });

    return {
      ok: true,
      workflowId: d.workflowId,
      versionNumber: d.versionNumber,
      message: `Snapshot of deployment v${d.versionNumber ?? ''} restored to project draft successfully.`,
    };
  }

  /** Import a frozen deployment snapshot package and create an immutable deployment unit. */
  async importSnapshot(body: { snapshot?: any; engine?: any; environment?: string; activate?: boolean }, actor: string): Promise<Deployment> {
    const raw = body.snapshot || body;
    const engine = raw.engine || (raw.processes ? raw : undefined);
    if (!engine || !Array.isArray(engine.processes) || engine.processes.length === 0) {
      throw validation('Invalid deployment snapshot: missing engine processes.');
    }

    const env = (body.environment || raw.deployment?.environment || raw.environment || 'dev').trim();
    if (!env) throw validation('Environment is required.');

    let workflowId = raw.deployment?.workflowId || raw.workflowId;
    const workflows = this.ctx.store.repo<Workflow>(Collections.workflows);
    let wf = workflowId ? await workflows.get(workflowId) : undefined;
    if (!wf || wf.tenantId !== this.ctx.tenantId) {
      const name = engine.name || engine.id || 'Imported Project';
      const existing = await workflows.query((w) => w.tenantId === this.ctx.tenantId && (w.name === name || w.id === workflowId));
      if (existing.length) {
        wf = existing[0];
        workflowId = wf.id;
      } else {
        // through the service, so the project gets its key, permissions, first branch/version and is counted against the plan
        wf = await new WorkflowService(this.ctx).create({ name }, actor);
        workflowId = wf.id;
      }
    }

    const depId = this.ctx.newId();
    const verNumber = raw.deployment?.versionNumber ?? 1;
    const verLabel = raw.deployment?.versionLabel ? `${raw.deployment.versionLabel} (imported)` : 'imported';

    const dep: Deployment = {
      id: depId,
      tenantId: this.ctx.tenantId,
      workflowId,
      versionId: raw.deployment?.versionId || this.ctx.newId(),
      branchId: wf.defaultBranchId || '',
      engine: structuredClone(engine),
      env: raw.deployment?.env || raw.env || {},
      tags: [...new Set([env, ...(raw.deployment?.tags || raw.tags || []), 'imported'])],
      status: 'inactive',
      environment: env,
      versionNumber: verNumber,
      versionLabel: verLabel,
      deployedAt: this.ctx.clock(),
      deployedBy: actor,
      snapshot: {
        frozenAt: this.ctx.clock(),
        versionNumber: verNumber,
        versionLabel: verLabel,
        frozen: true,
      },
    };

    await this.dp().put(dep);
    await this.ctx.audit({
      actor,
      kind: 'deployment.imported',
      workflowId,
      deploymentId: dep.id,
      data: { environment: env, versionNumber: verNumber },
    });

    if (body.activate) {
      return this.activate(dep.id, actor);
    }
    return dep;
  }
}
