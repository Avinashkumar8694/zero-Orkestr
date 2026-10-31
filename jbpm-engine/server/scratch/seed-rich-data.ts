import path from 'node:path';
import { FileStore } from '../src/store/file-store.ts';
import { Collections, type Task, type Instance, type ExecutionError, type AuditEvent } from '../src/domain.ts';

const dataDir = path.resolve(process.cwd(), '.data');
const store = new FileStore(dataDir);
const tenantId = 'default';

async function seed() {
  const taskRepo = store.repo<Task>(Collections.tasks);
  const instRepo = store.repo<Instance>(Collections.instances);
  const errRepo = store.repo<ExecutionError>(Collections.errors);
  const auditRepo = store.repo<AuditEvent>(Collections.audit);

  const now = new Date().toISOString();
  const yesterday = new Date(Date.now() - 86400000).toISOString();

  // 1. Seed Tasks
  const tasks: Task[] = [
    {
      id: 'task_001',
      tenantId,
      instanceId: 'inst_ord_001',
      tokenId: 'tok_001',
      nodeId: 'user_task_ops',
      name: 'High-Value Order Fraud Inspection (Order #98421)',
      group: 'risk-ops',
      assignee: 'admin',
      priority: 90,
      status: 'inprogress',
      inputs: {
        orderId: 'ORD-98421',
        amount: 4850.0,
        fraudScore: 82,
        cardCountry: 'US',
        ipCountry: 'CA',
      },
      createdAt: yesterday,
      dueAt: new Date(Date.now() + 36000000).toISOString(),
    },
    {
      id: 'task_002',
      tenantId,
      instanceId: 'inst_kyc_002',
      tokenId: 'tok_002',
      nodeId: 'task_doc_review',
      name: 'Identity Document Verification - Merchant KYC #81092',
      group: 'compliance',
      priority: 70,
      status: 'reserved',
      inputs: {
        merchantId: 'M-81092',
        companyName: 'AeroDynamics Global LLC',
        riskTier: 'Tier 2',
      },
      createdAt: now,
      dueAt: new Date(Date.now() + 72000000).toISOString(),
    },
    {
      id: 'task_003',
      tenantId,
      instanceId: 'inst_disp_003',
      tokenId: 'tok_003',
      nodeId: 'task_chargeback_eval',
      name: 'Chargeback Dispute Evidence Review (Dispute #4812)',
      group: 'chargeback-ops',
      priority: 50,
      status: 'created',
      inputs: {
        disputeId: 'DISP-4812',
        reasonCode: '10.4 Fraud - Card Absent',
        amount: 890.0,
      },
      createdAt: now,
      dueAt: new Date(Date.now() + 140000000).toISOString(),
    },
    {
      id: 'task_004',
      tenantId,
      instanceId: 'inst_ord_004',
      tokenId: 'tok_004',
      nodeId: 'user_task_approval',
      name: 'Executive Wire Transfer Approval ($250,000.00)',
      group: 'treasury',
      assignee: 'admin',
      priority: 100,
      status: 'completed',
      inputs: { wireId: 'W-9921', recipient: 'Supplier Global Ltd' },
      outputs: { approved: true, authorizationCode: 'AUTH-992182' },
      createdAt: yesterday,
      completedAt: now,
      completedBy: 'admin',
    },
  ];

  for (const t of tasks) {
    await taskRepo.put(t);
  }
  console.log('Seeded tasks:', tasks.length);

  // 2. Seed Instances
  const instances: Instance[] = [
    {
      id: 'inst_ord_001',
      tenantId,
      workflowId: '01M68BVFXHA4M4K6',
      deploymentId: '01M68BXHCGJ8P1NW',
      processId: '01m68bvfxha4m4k6.process',
      status: 'waiting',
      tokens: [
        {
          id: 'tok_001',
          nodeId: 'user_task_ops',
          status: 'waiting',
          data: {},
          history: [{ at: now, event: 'entered', nodeId: 'user_task_ops' }],
        },
      ],
      variables: {
        orderId: 'ORD-98421',
        amount: 4850.0,
        fraudScore: 82,
        customerTier: 'Enterprise',
      },
      history: [
        { at: yesterday, event: 'started', instanceId: 'inst_ord_001' },
        { at: yesterday, event: 'nodeEntered', nodeId: 'start_event' },
        { at: yesterday, event: 'nodeExited', nodeId: 'start_event' },
        { at: yesterday, event: 'nodeEntered', nodeId: 'service_fraud' },
        { at: yesterday, event: 'nodeExited', nodeId: 'service_fraud' },
        { at: yesterday, event: 'nodeEntered', nodeId: 'gateway_eval' },
        { at: yesterday, event: 'nodeEntered', nodeId: 'user_task_ops' },
      ],
      startedAt: yesterday,
      startedBy: 'admin',
    },
    {
      id: 'inst_kyc_002',
      tenantId,
      workflowId: '01M68BVFXHA4M4K6',
      deploymentId: '01M68BXHCGJ8P1NW',
      processId: '01m68bvfxha4m4k6.process',
      status: 'running',
      tokens: [
        {
          id: 'tok_002',
          nodeId: 'service_capture',
          status: 'active',
          data: {},
          history: [{ at: now, event: 'entered', nodeId: 'service_capture' }],
        },
      ],
      variables: {
        orderId: 'ORD-98422',
        amount: 320.0,
        fraudScore: 12,
        customerTier: 'Standard',
      },
      history: [
        { at: now, event: 'started', instanceId: 'inst_kyc_002' },
        { at: now, event: 'nodeEntered', nodeId: 'start_event' },
        { at: now, event: 'nodeEntered', nodeId: 'service_capture' },
      ],
      startedAt: now,
      startedBy: 'system',
    },
    {
      id: 'inst_ord_004',
      tenantId,
      workflowId: '01M68BVFXHA4M4K6',
      deploymentId: '01M68BXHCGJ8P1NW',
      processId: '01m68bvfxha4m4k6.process',
      status: 'completed',
      tokens: [],
      variables: {
        orderId: 'ORD-98400',
        amount: 120.0,
        fraudScore: 5,
        customerTier: 'Standard',
      },
      history: [
        { at: yesterday, event: 'started', instanceId: 'inst_ord_004' },
        { at: now, event: 'completed', instanceId: 'inst_ord_004' },
      ],
      startedAt: yesterday,
      endedAt: now,
      startedBy: 'admin',
    },
    {
      id: 'inst_err_005',
      tenantId,
      workflowId: '01M68BVFXHA4M4K6',
      deploymentId: '01M68BXHCGJ8P1NW',
      processId: '01m68bvfxha4m4k6.process',
      status: 'failed',
      tokens: [
        {
          id: 'tok_005',
          nodeId: 'service_fraud',
          status: 'failed',
          data: {},
          history: [{ at: now, event: 'error', nodeId: 'service_fraud' }],
        },
      ],
      variables: {
        orderId: 'ORD-98433',
        amount: 990.0,
      },
      error: {
        nodeId: 'service_fraud',
        message: 'ETIMEDOUT: Connection timed out reaching outbound endpoint https://risk-scorer.internal:8443/v2/evaluate',
        stack: 'Error: ETIMEDOUT\n    at TLSSocket.onTimeout (node:net:542:12)\n    at OutboundGuard.dispatch (engine/service-task.ts:89:14)',
      },
      history: [
        { at: now, event: 'started', instanceId: 'inst_err_005' },
        { at: now, event: 'failed', nodeId: 'service_fraud' },
      ],
      startedAt: now,
      endedAt: now,
      startedBy: 'api-client',
    },
  ];

  for (const inst of instances) {
    await instRepo.put(inst);
  }
  console.log('Seeded instances:', instances.length);

  // 3. Seed Execution Error Queue
  const err: ExecutionError = {
    id: 'err_001',
    tenantId,
    type: 'process',
    instanceId: 'inst_err_005',
    workflowId: '01M68BVFXHA4M4K6',
    deploymentId: '01M68BXHCGJ8P1NW',
    processId: '01m68bvfxha4m4k6.process',
    nodeId: 'service_fraud',
    nodeName: 'Query Risk Scorer API',
    nodeType: 'serviceTask',
    message: 'ETIMEDOUT: Connection timed out reaching outbound endpoint https://risk-scorer.internal:8443/v2/evaluate',
    stack: 'Error: ETIMEDOUT\n    at TLSSocket.onTimeout (node:net:542:12)\n    at OutboundGuard.dispatch (engine/service-task.ts:89:14)',
    at: now,
    occurrences: 3,
    acknowledged: false,
  };
  await errRepo.put(err);
  console.log('Seeded execution error');

  // 4. Seed Audit Events
  const audits: AuditEvent[] = [
    {
      id: 'aud_001',
      tenantId,
      at: now,
      actor: 'admin',
      kind: 'workflow.deployed',
      workflowId: '01M68BVFXHA4M4K6',
      deploymentId: '01M68BXHCGJ8P1NW',
      data: { environment: 'prod', version: 'v1.0.0-prod' },
    },
    {
      id: 'aud_002',
      tenantId,
      at: now,
      actor: 'admin',
      kind: 'instance.started',
      instanceId: 'inst_ord_001',
      data: { orderId: 'ORD-98421' },
    },
    {
      id: 'aud_003',
      tenantId,
      at: now,
      actor: 'admin',
      kind: 'task.claimed',
      taskId: 'task_001',
      data: { group: 'risk-ops' },
    },
  ];
  for (const a of audits) {
    await auditRepo.put(a);
  }
  console.log('Seeded audit events');
}

seed().catch(console.error);
