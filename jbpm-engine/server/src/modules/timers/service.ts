// Durable timer scheduler: fires scheduled TimerJobs whose dueAt has passed by resuming their token.
// A real interval in index.ts calls tick() periodically; tests call tick(now) with a fake clock.
import type { AppContext } from '../../context.ts';
import { inList } from '../../infra/filters.ts';
import { Collections, type TimerJob } from '../../domain.ts';
import { InstanceService } from '../instances/service.ts';
import { SettingsService } from '../settings/service.ts';
import type { EngineEvent } from '../../engine/execution-engine.ts';
import { computeDue, parseCycleRepeatCount } from '../../engine/duration.ts';
import { notFound, conflict, validation } from '../../infra/errors.ts';
import { config } from '../../infra/config.ts';
import { logger } from '../../infra/logger.ts';

/** Multi-replica guards for tick(): `admit` says whether this replica may work this workspace's timers at all (checked
 *  once, and only when something is due), `claim` takes exclusive ownership of ONE job so two replicas never fire it. */
export interface TickGate {
  /** max jobs per tick (default: the workspace's timerBatchSize setting, else config.timerBatchSize) */
  batchSize?: number;
  admit?: () => Promise<boolean>;
  claim?: (job: TimerJob) => Promise<(() => Promise<void>) | null>;
}

export class TimerService {
  private instances: InstanceService;
  private isTicking = false;
  constructor(private ctx: AppContext, emit: (e: EngineEvent) => void = () => {}) {
    this.instances = new InstanceService(ctx, emit);
  }
  private repo() { return this.ctx.store.repo<TimerJob>(Collections.timers); }

  /** Fire scheduled timers of THIS context's workspace due at or before `nowIso`, in bounded batches; returns the number fired.
   *  `arg` is a batch size or a TickGate. Without a gate (one replica, or replicas sharing a database) the STORE claims the due
   *  jobs atomically (claimDueTimers: SKIP LOCKED on Postgres), so concurrent consumers get disjoint slices. With a gate
   *  (replicas coordinated through Redis) `admit` says whether this replica may work the workspace and `claim` leases each job. */
  async tick(nowIso: string, arg?: number | TickGate): Promise<number> {
    const gate = typeof arg === 'object' ? arg : undefined;
    if (this.isTicking) {
      logger.warn('Timer tick still running from previous interval — skipping overlapping tick');
      return 0;
    }
    this.isTicking = true;
    try {
      const store = this.ctx.store as any;
      let limit = typeof arg === 'number' ? arg : gate?.batchSize;
      if (!limit) {
        const settings = await new SettingsService(this.ctx).get().catch(() => null);
        limit = settings?.timerBatchSize || config.timerBatchSize;
      }
      let due: TimerJob[];
      if (gate?.claim) {
        due = (await this.repo().query((t) => t.tenantId === this.ctx.tenantId && t.status === 'scheduled' && t.dueAt <= nowIso)).slice(0, limit);
        if (!due.length) return 0;
        if (gate.admit && !(await gate.admit())) return 0;
      } else {
        if (gate?.admit && !(await gate.admit())) return 0;
        if (typeof store.claimDueTimers === 'function') {
          // atomic claim: marks status='fired' so no other replica can pick up these exact jobs
          due = await store.claimDueTimers(this.ctx.tenantId, nowIso, limit);
        } else {
          // fallback for custom stores without an atomic claim
          const allDue = await this.repo().query((t) =>
            (!this.ctx.tenantId || this.ctx.tenantId === '*' || t.tenantId === this.ctx.tenantId) && t.status === 'scheduled' && t.dueAt <= nowIso);
          due = allDue.slice(0, limit);
          for (const job of due) { job.status = 'fired'; job.fired = (job.fired || 0) + 1; await this.repo().put(job); }
        }
      }

      let fired = 0;
      for (let job of due) {
        // Don't fire (or consume) a timer whose instance is suspended — leave/restore it scheduled to fire on resume.
        if (job.kind !== 'start') {
          const inst = await this.instances.get(job.instanceId).catch(() => null);
          if (inst && inst.status === 'suspended') {
            if (!gate?.claim) { job.status = 'scheduled'; await this.repo().put(job); }
            continue;
          }
        }
        const release = gate?.claim ? await gate.claim(job) : undefined;
        if (gate?.claim && !release) continue;                       // another replica owns this job right now
        try {
          if (gate?.claim) {                                         // it may have been fired (and released) between our query and our claim
            const fresh = await this.repo().get(job.id);
            if (!fresh || fresh.status !== 'scheduled' || fresh.dueAt > nowIso) continue;
            job = fresh;
            job.status = 'fired'; job.fired += 1;
            await this.repo().put(job);
          }
          fired++;
          try {
            if (job.kind === 'start') {
              // reschedule the next occurrence in `finally`, not only on success — a single failed firing
              // (deployment archived, or now a quota rejection) must not permanently kill a recurring
              // cron/cycle start; it should just skip this occurrence and try again next time.
              try { await this.instances.startScheduled(job); }
              finally { if (job.cycle) await this.reschedule(job, nowIso); }
            } else if (job.kind === 'async') {
              // a background node/start. A thrown exception is an infrastructure failure (not a business error — those follow the
              // normal error model inside the engine), so the job is retried with a delay until its attempts are used up.
              job.attempts = (job.attempts ?? 0) + 1;
              try { await this.instances.fireAsync(job); }
              catch (e) {
                job.lastError = (e as Error).message;
                if (job.attempts < (job.maxAttempts ?? 1)) {
                  job.status = 'scheduled'; job.dueAt = new Date(Date.parse(nowIso) + (job.retryDelayMs ?? 10_000) * job.attempts).toISOString();
                } else {
                  const inst = await this.instances.get(job.instanceId).catch(() => null);
                  if (inst && inst.status !== 'completed' && inst.status !== 'aborted' && inst.status !== 'failed') {
                    await this.instances.failAsync(inst, job.nodeId, `async job failed after ${job.attempts} attempt(s): ${job.lastError}`).catch(() => {});
                  }
                }
              }
              await this.repo().put(job);
            } else {
              const inst = await this.instances.fireTimer(job);
              // A non-interrupting boundary timer doesn't remove its host token — if it's also declared
              // with a cycle, that means "keep pinging every period" (e.g. an SLA reminder), so reschedule
              // for the next occurrence. An interrupting boundary (or a plain catch-timer, which always
              // consumes its own wait) removes the token, so this naturally stops recurring on its own.
              if (job.cycle && inst.tokens.some((t) => t.id === job.tokenId)) await this.reschedule(job, nowIso);
            }
          } catch { /* token gone / instance finished / deployment inactive — ignore */ }
        } finally { await release?.(); }
      }
      return fired;
    } finally {
      this.isTicking = false;
    }
  }

  // --- Jobs & Timers screen ---

  async list(q: { status?: string; instanceId?: string; kind?: string } = {}): Promise<TimerJob[]> {
    return (await this.repo().query((t) =>
      t.tenantId === this.ctx.tenantId &&
      inList(q.status, t.status) &&
      (!q.instanceId || t.instanceId === q.instanceId) &&
      (!q.kind || t.kind === q.kind)))
      // scheduled first (soonest due at the top), then the rest newest-first
      .sort((a, b) => (a.status === 'scheduled' ? 0 : 1) - (b.status === 'scheduled' ? 0 : 1) || a.dueAt.localeCompare(b.dueAt) * (a.status === 'scheduled' ? 1 : -1));
  }

  async getJob(id: string): Promise<TimerJob> {
    const j = await this.repo().get(id);
    if (!j || j.tenantId !== this.ctx.tenantId) throw notFound('TimerJob');
    return j;
  }

  async cancel(id: string, actor: string): Promise<TimerJob> {
    const j = await this.getJob(id);
    if (j.status !== 'scheduled') throw conflict(`job is ${j.status}, not cancellable`);
    j.status = 'cancelled';
    await this.repo().put(j);
    await this.ctx.audit({ actor, kind: 'job.cancelled', instanceId: j.instanceId || undefined, nodeId: j.nodeId, data: { jobId: id } });
    return j;
  }

  /** Fire a scheduled job right now instead of waiting for dueAt ("Trigger" on the Jobs screen). Same
   *  "leave it scheduled, don't fire" rule for a suspended instance as tick() above — a manual trigger
   *  shouldn't be able to do what the periodic poller itself refuses to do. */
  async trigger(id: string, actor: string): Promise<TimerJob> {
    const j = await this.getJob(id);
    if (j.status !== 'scheduled') throw conflict(`job is ${j.status}, not triggerable`);
    if (j.kind !== 'start') {
      const inst = await this.instances.get(j.instanceId).catch(() => null);
      if (inst && inst.status === 'suspended') throw conflict('instance is suspended; resume it before triggering this job');
    }
    j.status = 'fired'; j.fired += 1;
    await this.repo().put(j);
    await this.ctx.audit({ actor, kind: 'job.triggered', instanceId: j.instanceId || undefined, nodeId: j.nodeId, data: { jobId: id } });
    if (j.kind === 'start') await this.instances.startScheduled(j);
    else await this.instances.fireTimer(j);
    return j;
  }

  /** Move a scheduled job's fire time ("Reschedule"); also revives a cancelled job. */
  async rescheduleJob(id: string, dueAt: string, actor: string): Promise<TimerJob> {
    const j = await this.getJob(id);
    if (j.status === 'fired') throw conflict('job already fired');
    if (!dueAt || Number.isNaN(Date.parse(dueAt))) throw validation('dueAt must be an ISO date-time');
    j.dueAt = new Date(dueAt).toISOString(); j.status = 'scheduled';
    await this.repo().put(j);
    await this.ctx.audit({ actor, kind: 'job.rescheduled', instanceId: j.instanceId || undefined, nodeId: j.nodeId, data: { jobId: id, dueAt: j.dueAt } });
    return j;
  }

  /** Schedules the next occurrence of a recurring (cycled) job — unless its ISO-8601 repeat count
   *  ("R3/PT1H" = 3 times; "R/PT1H" = unbounded) has already been reached. */
  private async reschedule(job: TimerJob, nowIso: string): Promise<void> {
    const limit = parseCycleRepeatCount(job.cycle!);
    if (limit !== null && job.fired >= limit) return;
    const next: TimerJob = {
      ...job, id: this.ctx.newId(), status: 'scheduled', fired: job.fired,
      dueAt: computeDue({ cycle: job.cycle }, nowIso),
    };
    await this.repo().put(next);
  }
}
