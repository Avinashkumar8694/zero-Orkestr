// Developer Integration Parity & End-to-End Suite
// Tests all added integration endpoints:
// - Signals broadcast: POST /api/signals/:signalName & POST /api/workflow-instances/signal/:signalName
// - Human task fail: POST /api/tasks/:id/fail
// - Case lifecycle (close/reopen): POST /api/workflow-instances/:id/close & /reopen
// - Case data CRUD: GET /api/workflow-instances/:id/data & DELETE /api/workflow-instances/:id/data/:key
// - Case roles: GET/PUT/DELETE /api/workflow-instances/:id/roles/...
// - Case milestones: GET/POST /api/workflow-instances/:id/milestones
// - SLA & Workload analytics: GET /api/query/analytics/sla-violations & workload
// - Case Service schema CRUD: POST/GET/PUT/DELETE /api/caseservice/case and GET /api/caseservice/list
import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { createApp } from '../src/app.ts';
import { MemoryStore } from '../src/store/memory-store.ts';
import { makeContext } from '../src/context.ts';
import { config } from '../src/infra/config.ts';
import { IamService } from '../src/modules/iam/service.ts';
import { WorkflowService } from '../src/modules/workflows/service.ts';
import { VersionService } from '../src/modules/versions/service.ts';
import { DeploymentService } from '../src/modules/deployments/service.ts';
import { resolveWorkflowServiceStore } from '../src/workflow-service/store/index.ts';
import { WorkflowDefinitionService } from '../src/workflow-service/services/workflow-definition-service.ts';

let server: http.Server;
let base: string;
let token: string;
let store: MemoryStore;
let depId: string;

const CLAIMS_PROCESS = {
  id: 'claims-intake',
  name: 'Claims Intake Process',
  processes: [{
    id: 'claims-intake.process',
    name: 'Claims Intake',
    package: 'com.prudential.claims',
    nodes: [
      { id: 's', type: 'start' },
      { id: 'reviewTask', type: 'userTask', name: 'Examiner Review' },
      { id: 'waitDoc', type: 'catch', name: 'Wait for Document', event: { signal: 'DOCUMENT_UPLOADED' } },
      { id: 'e', type: 'end' },
    ],
    flows: [
      { id: 'f1', from: 's', to: 'reviewTask' },
      { id: 'f2', from: 'reviewTask', to: 'waitDoc' },
      { id: 'f3', from: 'waitDoc', to: 'e' },
    ],
  }],
};

test.before(async () => {
  store = new MemoryStore();
  const ctx = makeContext({ store, tenantId: config.defaultTenant });
  await new IamService(ctx).ensureSeeded('test-pw-123');

  const { app } = createApp(store);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api`;

  // Login as admin
  const loginRes = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-pw-123' }),
  });
  const loginBody = await loginRes.json() as any;
  token = loginBody.token;

  // Deploy claims intake process
  const wf = await new WorkflowService(ctx).create({ name: 'claims-intake', key: 'claims-intake' }, 'admin');
  const draft = await new VersionService(ctx).saveDraft(wf.defaultBranchId, CLAIMS_PROCESS as any, 'admin');
  const pub = await new VersionService(ctx).publish(draft.id, 'admin');
  const dep = await new DeploymentService(ctx).deploy(pub.published.id, { environment: 'prod', activate: true }, 'admin');
  depId = dep.id;

  // Register workflow definition for cases
  const wfStore = resolveWorkflowServiceStore(store);
  await new WorkflowDefinitionService(ctx, wfStore).create({
    name: 'claims-intake-v1',
    deploymentId: dep.id,
    processId: 'claims-intake.process',
  }, 'admin');
});

test.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

const authHeaders = () => ({
  'content-type': 'application/json',
  authorization: `Bearer ${token}`,
});

test('Case Service CRUD: POST/GET/PUT/DELETE /api/caseservice/case and GET /api/caseservice/list', async () => {
  // 1. Create Case
  const createRes = await fetch(`${base}/caseservice/case`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      policyNumber: 'POL-998877',
      claimType: 'DEATH',
      caseStatus: 'DRAFT',
      dateOfDeath: '2026-01-15',
      causeOfDeath: 'NATURAL',
      totalPayoutAmount: 250000,
      claimant: {
        first_name: 'Jane',
        last_name: 'Doe',
        relationship: 'SPOUSE',
      },
      policyDetails: [
        { policyNumber: 'POL-998877', planCode: 'TERM-80', pasLockStatus: 'PENDING', faceAmount: 250000 },
      ],
    }),
  });
  assert.strictEqual(createRes.status, 201);
  const createdCase = await createRes.json() as any;
  assert.ok(createdCase.caseId);
  assert.strictEqual(createdCase.policyNumber, 'POL-998877');
  assert.strictEqual(createdCase.caseStatus, 'DRAFT');

  // 2. Retrieve Case
  const getRes = await fetch(`${base}/caseservice/case/${createdCase.caseId}`, {
    headers: authHeaders(),
  });
  assert.strictEqual(getRes.status, 200);
  const caseObj = await getRes.json() as any;
  assert.strictEqual(caseObj.caseId, createdCase.caseId);
  assert.strictEqual(caseObj.claimant?.first_name, 'Jane');
  assert.strictEqual(caseObj.totalPayoutAmount, 250000);

  // 3. Update Case
  const putRes = await fetch(`${base}/caseservice/case/${createdCase.caseId}`, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify({
      caseStatus: 'UNDER_REVIEW',
      examinerResolution: 'APPROVED',
      examinerComment: 'Initial intake complete',
    }),
  });
  assert.strictEqual(putRes.status, 200);
  const updatedCase = await putRes.json() as any;
  assert.strictEqual(updatedCase.caseStatus, 'UNDER_REVIEW');

  // 4. List Cases
  const listRes = await fetch(`${base}/caseservice/list?policyNumber=POL-998877`, {
    headers: authHeaders(),
  });
  assert.strictEqual(listRes.status, 200);
  const list = await listRes.json() as any[];
  assert.ok(list.length >= 1);
  assert.strictEqual(list[0].caseId, createdCase.caseId);

  // 5. Delete Case
  const delRes = await fetch(`${base}/caseservice/case/${createdCase.caseId}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  assert.strictEqual(delRes.status, 204);

  // Verify deleted status is TERMINATED
  const getAfterDel = await fetch(`${base}/caseservice/case/${createdCase.caseId}`, {
    headers: authHeaders(),
  });
  const afterDelObj = await getAfterDel.json() as any;
  assert.strictEqual(afterDelObj.caseStatus, 'TERMINATED');
});

test('Workflow Instance Extended Parity: Close, Reopen, Data CRUD, Roles, and Milestones', async () => {
  // Start workflow instance case
  const startRes = await fetch(`${base}/workflow-instances`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      workflowName: 'claims-intake-v1',
      workflowData: { claimNumber: 'CLM-7711', initialAmount: 10000, riskScore: 'LOW' },
    }),
  });
  assert.strictEqual(startRes.status, 201);
  const caseInstance = await startRes.json() as any;
  assert.ok(caseInstance.id);

  // 1. Data GET
  const dataRes = await fetch(`${base}/workflow-instances/${caseInstance.id}/data`, {
    headers: authHeaders(),
  });
  assert.strictEqual(dataRes.status, 200);
  const data = await dataRes.json() as any;
  assert.strictEqual(data.claimNumber, 'CLM-7711');
  assert.strictEqual(data.riskScore, 'LOW');

  // 2. Data key DELETE
  const delKeyRes = await fetch(`${base}/workflow-instances/${caseInstance.id}/data/riskScore`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  assert.strictEqual(delKeyRes.status, 200);
  const afterKeyDel = await delKeyRes.json() as any;
  assert.strictEqual(afterKeyDel.data.riskScore, undefined);
  assert.strictEqual(afterKeyDel.data.claimNumber, 'CLM-7711');

  // 3. Roles PUT & GET & DELETE
  const setRoleRes = await fetch(`${base}/workflow-instances/${caseInstance.id}/roles/examiner`, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify({ members: ['alice', 'bob'] }),
  });
  assert.strictEqual(setRoleRes.status, 200);
  const rolesObj = await setRoleRes.json() as any;
  assert.deepStrictEqual(rolesObj.roles.examiner, ['alice', 'bob']);

  const getRolesRes = await fetch(`${base}/workflow-instances/${caseInstance.id}/roles`, {
    headers: authHeaders(),
  });
  assert.strictEqual(getRolesRes.status, 200);
  assert.deepStrictEqual((await getRolesRes.json() as any).roles.examiner, ['alice', 'bob']);

  const delRoleRes = await fetch(`${base}/workflow-instances/${caseInstance.id}/roles/examiner`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  assert.strictEqual(delRoleRes.status, 200);
  assert.strictEqual((await delRoleRes.json() as any).roles.examiner, undefined);

  // 4. Milestones POST & GET
  const postMilestoneRes = await fetch(`${base}/workflow-instances/${caseInstance.id}/milestones`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ name: 'PAS_VALIDATED' }),
  });
  assert.strictEqual(postMilestoneRes.status, 201);
  const postMilestoneBody = await postMilestoneRes.json() as any;
  assert.ok(postMilestoneBody.milestones.some((m: any) => m.name === 'PAS_VALIDATED' && m.status === 'achieved'));

  const getMilestonesRes = await fetch(`${base}/workflow-instances/${caseInstance.id}/milestones`, {
    headers: authHeaders(),
  });
  assert.strictEqual(getMilestonesRes.status, 200);
  const getMilestonesBody = await getMilestonesRes.json() as any;
  assert.ok(getMilestonesBody.milestones.some((m: any) => m.name === 'PAS_VALIDATED' && m.status === 'achieved'));

  // 5. Close & Reopen Case
  const closeRes = await fetch(`${base}/workflow-instances/${caseInstance.id}/close`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ resolution: 'Claim approved and settled' }),
  });
  assert.strictEqual(closeRes.status, 200);
  const closedCase = await closeRes.json() as any;
  assert.strictEqual(closedCase.status, 'closed');

  const reopenRes = await fetch(`${base}/workflow-instances/${caseInstance.id}/reopen`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ reason: 'Beneficiary appealed payout' }),
  });
  assert.strictEqual(reopenRes.status, 200);
  const reopenedCase = await reopenRes.json() as any;
  assert.strictEqual(reopenedCase.status, 'active');
});

test('Task Failure and Signal Broadcasting', async () => {
  // 1. Start an instance to create an open task
  const startRes = await fetch(`${base}/instances`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      deploymentId: depId,
      processId: 'claims-intake.process',
    }),
  });
  assert.strictEqual(startRes.status, 201);
  const inst = await startRes.json() as any;

  // Retrieve the task
  const tasksRes = await fetch(`${base}/tasks`, {
    headers: authHeaders(),
  });
  assert.strictEqual(tasksRes.status, 200);
  const tasks = (await tasksRes.json() as any).items;
  const myTask = tasks.find((t: any) => t.instanceId === inst.id);
  assert.ok(myTask, 'task was created on claims-intake.process');

  // Claim task
  await fetch(`${base}/tasks/${myTask.id}/claim`, { method: 'POST', headers: authHeaders() });

  // 2. Task FAIL: POST /api/tasks/:id/fail
  const failRes = await fetch(`${base}/tasks/${myTask.id}/fail`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      message: 'Claimant SSN does not match IRS records',
      data: { reasonCode: 'SSN_MISMATCH', rejectionStep: 'examinerReview' },
    }),
  });
  assert.strictEqual(failRes.status, 200);
  const failedTask = await failRes.json() as any;
  assert.strictEqual(failedTask.status, 'failed');

  // 3. Broadcast Signal: POST /api/signals/:signalName
  const signalRes = await fetch(`${base}/signals/DOCUMENT_UPLOADED`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      payload: { documentId: 'DOC-55', verified: true },
    }),
  });
  assert.strictEqual(signalRes.status, 200);
  const signalBody = await signalRes.json() as any;
  assert.strictEqual(typeof signalBody.signaled, 'number');

  // 4. Case-scoped Broadcast Signal: POST /api/workflow-instances/signal/:signalName
  const caseSignalRes = await fetch(`${base}/workflow-instances/signal/DOCUMENT_UPLOADED`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      payload: { documentId: 'DOC-66' },
    }),
  });
  assert.strictEqual(caseSignalRes.status, 200);
});

test('Operational & SLA Analytics: /query/analytics/sla-violations and /query/analytics/workload', async () => {
  const slaRes = await fetch(`${base}/query/analytics/sla-violations`, {
    headers: authHeaders(),
  });
  assert.strictEqual(slaRes.status, 200);
  const sla = await slaRes.json() as any;
  assert.strictEqual(typeof sla.totalOpenTasks, 'number');
  assert.strictEqual(typeof sla.overdueCount, 'number');
  assert.strictEqual(typeof sla.atRiskCount, 'number');
  assert.ok(Array.isArray(sla.overdueTasks));
  assert.ok(Array.isArray(sla.atRiskTasks));

  const workloadRes = await fetch(`${base}/query/analytics/workload`, {
    headers: authHeaders(),
  });
  assert.strictEqual(workloadRes.status, 200);
  const workload = await workloadRes.json() as any;
  assert.strictEqual(typeof workload.totalOpen, 'number');
  assert.ok(Array.isArray(workload.users));
  assert.ok(Array.isArray(workload.groups));

  // 1. Projects analytics: GET /query/analytics/projects
  const projRes = await fetch(`${base}/query/analytics/projects`, { headers: authHeaders() });
  assert.strictEqual(projRes.status, 200);
  const proj = await projRes.json() as any;
  assert.ok(proj.summary);
  assert.strictEqual(typeof proj.summary.totalProjects, 'number');
  assert.ok(Array.isArray(proj.byProject));

  // 2. Users analytics: GET /query/analytics/users and /users/:user
  const usersRes = await fetch(`${base}/query/analytics/users`, { headers: authHeaders() });
  assert.strictEqual(usersRes.status, 200);
  const usersList = await usersRes.json() as any;
  assert.ok(Array.isArray(usersList.items));

  const adminUserRes = await fetch(`${base}/query/analytics/users/admin`, { headers: authHeaders() });
  assert.strictEqual(adminUserRes.status, 200);
  const adminStats = await adminUserRes.json() as any;
  assert.strictEqual(adminStats.user, 'admin');

  // 3. Groups analytics: GET /query/analytics/groups and /groups/:group
  const groupsRes = await fetch(`${base}/query/analytics/groups`, { headers: authHeaders() });
  assert.strictEqual(groupsRes.status, 200);
  const groupsList = await groupsRes.json() as any;
  assert.ok(Array.isArray(groupsList.items));

  const unassignedGroupRes = await fetch(`${base}/query/analytics/groups/unassigned`, { headers: authHeaders() });
  assert.strictEqual(unassignedGroupRes.status, 200);
  const unassignedStats = await unassignedGroupRes.json() as any;
  assert.strictEqual(unassignedStats.group, 'unassigned');

  // 4. Task definitions analytics: GET /query/analytics/task-definitions
  const taskDefsRes = await fetch(`${base}/query/analytics/task-definitions`, { headers: authHeaders() });
  assert.strictEqual(taskDefsRes.status, 200);
  const taskDefsList = await taskDefsRes.json() as any;
  assert.ok(Array.isArray(taskDefsList.items));

  // 5. Process definitions analytics: GET /query/analytics/process-definitions
  const procDefsRes = await fetch(`${base}/query/analytics/process-definitions`, { headers: authHeaders() });
  assert.strictEqual(procDefsRes.status, 200);
  const procDefsList = await procDefsRes.json() as any;
  assert.ok(Array.isArray(procDefsList.items));
});

test('Task Lifecycle (Suspend/Resume), Variables, Attachments and Bulk Operations', async () => {
  // Start 2 instances
  const i1Res = await fetch(`${base}/instances`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ deploymentId: depId, processId: 'claims-intake.process', variables: { claimId: 'CLM-101' } }),
  });
  assert.strictEqual(i1Res.status, 201);
  const inst1 = await i1Res.json() as any;

  const i2Res = await fetch(`${base}/instances`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ deploymentId: depId, processId: 'claims-intake.process', variables: { claimId: 'CLM-102' } }),
  });
  assert.strictEqual(i2Res.status, 201);
  const inst2 = await i2Res.json() as any;

  // 1. Instance Nodes Introspection: GET /instances/:id/nodes
  const nodesRes = await fetch(`${base}/instances/${inst1.id}/nodes`, { headers: authHeaders() });
  assert.strictEqual(nodesRes.status, 200);
  const nodesBody = await nodesRes.json() as any;
  assert.ok(Array.isArray(nodesBody.items));
  assert.ok(nodesBody.items.some((n: any) => n.nodeId === 'reviewTask'));

  // 2. Instance Variables: GET /instances/:id/variables
  const varsRes = await fetch(`${base}/instances/${inst1.id}/variables`, { headers: authHeaders() });
  assert.strictEqual(varsRes.status, 200);
  const vars = await varsRes.json() as any;
  assert.strictEqual(vars.claimId, 'CLM-101');

  // Find tasks
  const tasksRes = await fetch(`${base}/tasks`, { headers: authHeaders() });
  const allTasks = (await tasksRes.json() as any).items;
  const t1 = allTasks.find((t: any) => t.instanceId === inst1.id);
  const t2 = allTasks.find((t: any) => t.instanceId === inst2.id);
  assert.ok(t1 && t2);

  // 3. Task inputs & outputs: GET /tasks/:id/inputs & outputs
  const inputsRes = await fetch(`${base}/tasks/${t1.id}/inputs`, { headers: authHeaders() });
  assert.strictEqual(inputsRes.status, 200);
  const outputsRes = await fetch(`${base}/tasks/${t1.id}/outputs`, { headers: authHeaders() });
  assert.strictEqual(outputsRes.status, 200);

  // 4. Bulk Task Claim: POST /tasks/bulk/claim
  const bulkClaimRes = await fetch(`${base}/tasks/bulk/claim`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ taskIds: [t1.id, t2.id] }),
  });
  assert.strictEqual(bulkClaimRes.status, 200);
  const bulkClaimBody = await bulkClaimRes.json() as any;
  assert.strictEqual(bulkClaimBody.results.length, 2);
  assert.ok(bulkClaimBody.results.every((r: any) => r.ok));

  // 5. Task Suspend & Resume: POST /tasks/:id/suspend & resume
  const suspendRes = await fetch(`${base}/tasks/${t1.id}/suspend`, { method: 'POST', headers: authHeaders() });
  assert.strictEqual(suspendRes.status, 200);
  assert.strictEqual((await suspendRes.json() as any).status, 'suspended');

  const resumeRes = await fetch(`${base}/tasks/${t1.id}/resume`, { method: 'POST', headers: authHeaders() });
  assert.strictEqual(resumeRes.status, 200);
  assert.strictEqual((await resumeRes.json() as any).status, 'reserved');

  // 6. Task Attachments: POST /tasks/:id/attachments, GET, DELETE
  const addAttRes = await fetch(`${base}/tasks/${t1.id}/attachments`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      name: 'death_certificate.pdf',
      mimeType: 'application/pdf',
      url: 'https://s3.amazonaws.com/pru-claims/cert.pdf',
      sizeBytes: 204800,
    }),
  });
  assert.strictEqual(addAttRes.status, 201);
  const attachment = await addAttRes.json() as any;
  assert.ok(attachment.id);
  assert.strictEqual(attachment.name, 'death_certificate.pdf');

  const listAttRes = await fetch(`${base}/tasks/${t1.id}/attachments`, { headers: authHeaders() });
  assert.strictEqual(listAttRes.status, 200);
  const attList = await listAttRes.json() as any;
  assert.ok(attList.items.some((a: any) => a.id === attachment.id));

  const delAttRes = await fetch(`${base}/tasks/${t1.id}/attachments/${attachment.id}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  assert.strictEqual(delAttRes.status, 204);

  // 7. Bulk Task Release: POST /tasks/bulk/release
  const bulkRelRes = await fetch(`${base}/tasks/bulk/release`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ taskIds: [t2.id] }),
  });
  assert.strictEqual(bulkRelRes.status, 200);

  // 8. Bulk Task Complete: POST /tasks/bulk/complete
  const bulkCompRes = await fetch(`${base}/tasks/bulk/complete`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ items: [{ taskId: t1.id, outputs: { examinerApproved: true } }] }),
  });
  assert.strictEqual(bulkCompRes.status, 200);
  const bulkCompBody = await bulkCompRes.json() as any;
  assert.ok(bulkCompBody.results[0]?.ok);

  // 9. Bulk Instance Signal & Abort: POST /instances/bulk/signal & abort
  const bulkSigRes = await fetch(`${base}/instances/bulk/signal`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ instanceIds: [inst1.id], name: 'DOCUMENT_UPLOADED', payload: { ok: true } }),
  });
  assert.strictEqual(bulkSigRes.status, 200);

  const bulkAbortRes = await fetch(`${base}/instances/bulk/abort`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ instanceIds: [inst2.id] }),
  });
  assert.strictEqual(bulkAbortRes.status, 200);
});

test('Case Management Flags, Documents, and Dynamic User Tasks', async () => {
  // Start workflow instance case
  const startRes = await fetch(`${base}/workflow-instances`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      workflowName: 'claims-intake-v1',
      workflowData: { claimNumber: 'CLM-FLAG-TEST' },
    }),
  });
  assert.strictEqual(startRes.status, 201);
  const c = await startRes.json() as any;

  // 1. Case Flags: POST, GET, DELETE
  const addFlagRes = await fetch(`${base}/workflow-instances/${c.id}/flags`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      flagType: 'FRAUD_SUSPICION',
      level: 'caseLevel',
      reason: 'Cross-border payout destination',
    }),
  });
  assert.strictEqual(addFlagRes.status, 201);
  const flag = await addFlagRes.json() as any;
  assert.strictEqual(flag.flagType, 'FRAUD_SUSPICION');

  const getFlagsRes = await fetch(`${base}/workflow-instances/${c.id}/flags`, { headers: authHeaders() });
  assert.strictEqual(getFlagsRes.status, 200);
  const flags = await getFlagsRes.json() as any;
  assert.ok(flags.caseLevel.some((f: any) => f.flagType === 'FRAUD_SUSPICION'));

  const delFlagRes = await fetch(`${base}/workflow-instances/${c.id}/flags/${flag.id}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  assert.strictEqual(delFlagRes.status, 204);

  // 2. Case Documents: POST, GET, DELETE
  const addDocRes = await fetch(`${base}/workflow-instances/${c.id}/documents`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      document_name: 'certified_death_certificate.pdf',
      document_type: 'DEATH_CERTIFICATE',
      s3_key: 'claims/docs/cert_1.pdf',
      required: true,
    }),
  });
  assert.strictEqual(addDocRes.status, 201);
  const doc = await addDocRes.json() as any;
  assert.strictEqual(doc.document_name, 'certified_death_certificate.pdf');

  const getDocsRes = await fetch(`${base}/workflow-instances/${c.id}/documents`, { headers: authHeaders() });
  assert.strictEqual(getDocsRes.status, 200);
  const docsBody = await getDocsRes.json() as any;
  assert.ok(docsBody.documents.some((d: any) => d.id === doc.id));

  const delDocRes = await fetch(`${base}/workflow-instances/${c.id}/documents/${doc.id}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  assert.strictEqual(delDocRes.status, 204);

  // 3. Dynamic Human Task Creation: POST /workflow-instances/:id/dynamic-tasks
  const dynTaskRes = await fetch(`${base}/workflow-instances/${c.id}/dynamic-tasks`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      name: 'Ad-hoc Forensic Toxicology Analysis',
      group: 'investigations',
      priority: 8,
      inputs: { sampleReference: 'TOX-9988' },
    }),
  });
  assert.strictEqual(dynTaskRes.status, 201);
  const dynTask = await dynTaskRes.json() as any;
  assert.ok(dynTask.id);
  assert.strictEqual(dynTask.name, 'Ad-hoc Forensic Toxicology Analysis');
  assert.strictEqual(dynTask.priority, 8);
});

test('Case Service Flags and Documents Parity', async () => {
  // Create a Case Object
  const createRes = await fetch(`${base}/caseservice/case`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      policyNumber: 'POL-CS-555',
      claimType: 'DEATH',
      caseStatus: 'PENDING_DEATH',
    }),
  });
  assert.strictEqual(createRes.status, 201);
  const c = await createRes.json() as any;

  // 1. Add Flag: POST /caseservice/case/:caseId/flags
  const flagRes = await fetch(`${base}/caseservice/case/${c.caseId}/flags`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      flagType: 'OFAC_SANCTION_MATCH',
      level: 'beneficiaryLevel',
      reason: 'Name matches OFAC watchlist SDN list',
    }),
  });
  assert.strictEqual(flagRes.status, 201);
  const flag = await flagRes.json() as any;
  assert.strictEqual(flag.flagType, 'OFAC_SANCTION_MATCH');

  // 2. Get Flags: GET /caseservice/case/:caseId/flags
  const getFlags = await fetch(`${base}/caseservice/case/${c.caseId}/flags`, { headers: authHeaders() });
  assert.strictEqual(getFlags.status, 200);
  const flagsData = await getFlags.json() as any;
  assert.ok(flagsData.beneficiaryLevel.some((f: any) => f.flagType === 'OFAC_SANCTION_MATCH'));

  // 3. Delete Flag: DELETE /caseservice/case/:caseId/flags/:flagId
  const delFlag = await fetch(`${base}/caseservice/case/${c.caseId}/flags/${flag.id}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  assert.strictEqual(delFlag.status, 204);

  // 4. Add Document: POST /caseservice/case/:caseId/documents
  const docRes = await fetch(`${base}/caseservice/case/${c.caseId}/documents`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      document_name: 'power_of_attorney.pdf',
      document_type: 'POA',
      s3_key: 'claims/docs/poa_99.pdf',
    }),
  });
  assert.strictEqual(docRes.status, 201);
  const doc = await docRes.json() as any;
  assert.strictEqual(doc.document_name, 'power_of_attorney.pdf');

  // 5. Get Documents: GET /caseservice/case/:caseId/documents
  const getDocs = await fetch(`${base}/caseservice/case/${c.caseId}/documents`, { headers: authHeaders() });
  assert.strictEqual(getDocs.status, 200);
  const docs = await getDocs.json() as any;
  assert.ok(docs.documents.some((d: any) => d.id === doc.id));

  // 6. Delete Document: DELETE /caseservice/case/:caseId/documents/:docId
  const delDoc = await fetch(`${base}/caseservice/case/${c.caseId}/documents/${doc.id}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  assert.strictEqual(delDoc.status, 204);
});

