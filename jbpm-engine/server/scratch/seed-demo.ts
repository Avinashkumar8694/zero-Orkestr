// Enhanced seed script to populate workflows, versions, deployments, instances, and tasks
const API_BASE = 'http://localhost:4000/api';

async function main() {
  const loginRes = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin-change-me' }),
  });
  const { token } = await loginRes.json();
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'x-tenant-id': 'default',
  };

  console.log('Logged in to default workspace.');

  // List existing workflows or create new
  const wfList = await fetch(`${API_BASE}/workflows`, { headers }).then((r) => r.json());
  console.log('Current workflows:', wfList.items?.length);

  let wf = wfList.items?.[0];
  if (!wf) {
    wf = await fetch(`${API_BASE}/workflows`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'Enterprise Order Fulfillment & Risk Evaluation',
        description: 'Multi-stage BPMN 2.0 orchestration with automated fraud screening, payment reservation, and manual ops review.',
      }),
    }).then((r) => r.json());
  }

  // Get branches and versions for this workflow
  const branches = await fetch(`${API_BASE}/workflows/${wf.id}/branches`, { headers }).then((r) => r.json());
  const mainBranch = branches.items?.[0] || { id: wf.defaultBranchId };
  const versions = await fetch(`${API_BASE}/branches/${mainBranch.id}/versions`, { headers }).then((r) => r.json());
  const draftVersion = versions.items?.[0];

  console.log('Workflow:', wf.id, 'Branch:', mainBranch.id, 'Version:', draftVersion?.id);

  if (draftVersion) {
    // Save rich BPMN engine structure to this version
    const engineData = {
      id: wf.key,
      name: wf.name,
      processes: [
        {
          id: `${wf.key}.process`,
          name: wf.name,
          package: 'com.orkestr.enterprise',
          vars: [
            { name: 'orderId', type: 'string', defaultValue: 'ORD-98421' },
            { name: 'amount', type: 'number', defaultValue: 1250.0 },
            { name: 'customerTier', type: 'string', defaultValue: 'VIP' },
            { name: 'fraudScore', type: 'number', defaultValue: 34 },
            { name: 'status', type: 'string', defaultValue: 'PENDING_REVIEW' },
          ],
          nodes: [
            { id: 'start_event', type: 'start', name: 'Order Placed (Event)' },
            { id: 'service_fraud', type: 'serviceTask', name: 'Query Risk Scorer API', config: { service: 'fraud-scorer' } },
            { id: 'gateway_eval', type: 'exclusiveGateway', name: 'Risk Threshold?' },
            { id: 'user_task_ops', type: 'userTask', name: 'Operations Compliance Review', config: { candidateGroups: ['risk-ops'] } },
            { id: 'service_capture', type: 'serviceTask', name: 'Capture Payment & Reserve Stock' },
            { id: 'end_completed', type: 'end', name: 'Fulfillment Dispatched' },
          ],
          flows: [
            { id: 'f1', from: 'start_event', to: 'service_fraud' },
            { id: 'f2', from: 'service_fraud', to: 'gateway_eval' },
            { id: 'f3', from: 'gateway_eval', to: 'user_task_ops', condition: 'fraudScore > 30' },
            { id: 'f4', from: 'gateway_eval', to: 'service_capture', condition: 'fraudScore <= 30' },
            { id: 'f5', from: 'user_task_ops', to: 'service_capture' },
            { id: 'f6', from: 'service_capture', to: 'end_completed' },
          ],
        },
      ],
    };

    await fetch(`${API_BASE}/branches/${mainBranch.id}/versions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ engine: engineData, message: 'Update process model with exclusive gateway and manual review' }),
    });

    // Publish
    const pubRes = await fetch(`${API_BASE}/versions/${draftVersion.id}/publish`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ label: 'v1.0.0-prod' }),
    }).then((r) => r.json());
    console.log('Published version:', pubRes.id);

    // Deploy
    const depRes = await fetch(`${API_BASE}/versions/${draftVersion.id}/deploy`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ environment: 'prod', active: true }),
    }).then((r) => r.json());
    console.log('Deployed version:', depRes.id);

    // Start 2 instances
    const inst1 = await fetch(`${API_BASE}/instances`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        workflowId: wf.id,
        environment: 'prod',
        variables: { orderId: 'ORD-98421', amount: 1250.0, customerTier: 'VIP', fraudScore: 34 },
      }),
    }).then((r) => r.json());
    console.log('Instance 1:', inst1.id, inst1.status);

    const inst2 = await fetch(`${API_BASE}/instances`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        workflowId: wf.id,
        environment: 'prod',
        variables: { orderId: 'ORD-98422', amount: 480.0, customerTier: 'Standard', fraudScore: 12 },
      }),
    }).then((r) => r.json());
    console.log('Instance 2:', inst2.id, inst2.status);
  }

  // Add 2 tasks
  await fetch(`${API_BASE}/tasks`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'High-Value Order Fraud Inspection (Order #98421)',
      description: 'Fraud score 34 exceeded automated clearance threshold (30). Verify cardholder billing address.',
      assignee: 'admin',
      priority: 'high',
      dueDate: new Date(Date.now() + 86400000).toISOString(),
    }),
  });

  await fetch(`${API_BASE}/tasks`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'Merchant KYC Account Verification - Acquirer Onboarding',
      description: 'Review Certificate of Incorporation and signatory passport.',
      assignee: null,
      priority: 'medium',
      dueDate: new Date(Date.now() + 172800000).toISOString(),
    }),
  });

  console.log('Seeding successfully completed!');
}

main().catch(console.error);
