// End-to-end proof that the real domain services (workflow authoring, deploy, run, human task) work
// unchanged when backed by PgStore instead of MemoryStore/FileStore — same Repository<T> contract,
// zero call-site changes. Needs docker-compose's postgres up (`npm run docker:up`); opt-in via
// `npm run test:pg`, not part of the default suite.
import 'reflect-metadata';
import 'pg';
import { test } from 'node:test';
import assert from 'node:assert';
import { PgStore } from '../../src/store/pg-store.ts';
import { makeContext, type AppContext } from '../../src/context.ts';
import { config } from '../../src/infra/config.ts';
import { WorkflowService } from '../../src/modules/workflows/service.ts';
import { VersionService } from '../../src/modules/versions/service.ts';
import { DeploymentService } from '../../src/modules/deployments/service.ts';
import { InstanceService } from '../../src/modules/instances/service.ts';
import { TaskService } from '../../src/modules/tasks/service.ts';
import { Collections, type Task } from '../../src/domain.ts';

const TENANT = `pg_engine_test_${Date.now()}`;
let store: PgStore;
let ctx: AppContext;
test.before(() => { store = new PgStore(config.pgUrl!); ctx = makeContext({ store, tenantId: TENANT }); });
test.after(async () => { await store.close(); });

test('author -> publish -> deploy -> start -> complete a human task, entirely on Postgres, then re-read after a simulated restart', async () => {
  const wf = await new WorkflowService(ctx).create({ name: 'Pg Approval' }, 'alice');
  const engine = {
    id: wf.key, name: wf.name, processes: [{
      id: `${wf.key}.process`, name: wf.name, package: 'com.acme', vars: [{ name: 'decision', type: 'string' }],
      nodes: [
        { id: 's', type: 'start' },
        { id: 't', type: 'userTask', name: 'Approve', group: 'ops' },
        { id: 'e', type: 'end' },
      ],
      flows: [{ from: 's', to: 't' }, { from: 't', to: 'e' }],
    }],
  };
  const draft = await new VersionService(ctx).saveDraft(wf.defaultBranchId, engine as any, 'alice');
  const pub = await new VersionService(ctx).publish(draft.id, 'alice');
  await new DeploymentService(ctx).deploy(pub.published.id, { environment: 'prod', activate: true }, 'alice');

  const inst = await new InstanceService(ctx).start({ workflowId: wf.id, environment: 'prod' }, 'bob');
  assert.strictEqual(inst.status, 'waiting', 'parked at the human task');

  const task = (await store.repo<Task>(Collections.tasks).query((t) => t.instanceId === inst.id))[0]!;
  assert.strictEqual(task.status, 'created');

  // Simulate a server restart: brand-new PgStore + AppContext, no shared in-process state at all —
  // if this still finds and can act on the same task, it proves real cross-connection persistence.
  const store2 = new PgStore(config.pgUrl!);
  const ctx2 = makeContext({ store: store2, tenantId: TENANT });
  try {
    const rehydratedTask = await new TaskService(ctx2).get(task.id);
    assert.strictEqual(rehydratedTask.instanceId, inst.id, 'task survived across a fresh connection');

    await new TaskService(ctx2).complete(task.id, { decision: 'approved' }, 'carol');
    const done = await new InstanceService(ctx2).get(inst.id);
    assert.strictEqual(done.status, 'completed');
    assert.strictEqual(done.variables.decision, 'approved');
  } finally {
    await store2.close();
  }

  // and the ORIGINAL context/connection sees the same committed state too
  const doneFromOriginal = await new InstanceService(ctx).get(inst.id);
  assert.strictEqual(doneFromOriginal.status, 'completed', 'both connections see the same durable state');
});
