// OpenAPI 3.0 specification for the engine's REST API, served at GET /api/openapi.json and rendered
// by Swagger UI at GET /api/docs. Hand-authored to mirror the jBPM KIE-Server Swagger surface: authoring,
// versioning, deployment lifecycle, runtime instances, human tasks, and the query/analytics module.

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const listOf = (name: string) => ({ type: 'object', properties: { items: { type: 'array', items: ref(name) } } });
const ok = (schema: any) => ({ '200': { description: 'OK', content: { 'application/json': { schema } } } });
const created = (schema: any) => ({ '201': { description: 'Created', content: { 'application/json': { schema } } } });
const idParam = (name = 'id', desc = 'Resource id') => ({ name, in: 'path', required: true, schema: { type: 'string' }, description: desc });
const q = (name: string, desc: string) => ({ name, in: 'query', required: false, schema: { type: 'string' }, description: desc });
const jsonBody = (schema: any, required = true) => ({ required, content: { 'application/json': { schema } } });

// ---- reusable component schemas (core entities) ----
const schemas = {
  Error: { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} } } } },
  Problem: { type: 'object', properties: { rule: { type: 'string' }, severity: { type: 'string', enum: ['error', 'warning'] }, message: { type: 'string' }, nodeId: { type: 'string' } } },
  ValidationResult: { type: 'object', properties: { ok: { type: 'boolean' }, errors: { type: 'array', items: ref('Problem') }, warnings: { type: 'array', items: ref('Problem') } } },
  Workflow: { type: 'object', properties: { id: { type: 'string' }, key: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, defaultBranchId: { type: 'string' }, folderId: { type: 'string', nullable: true }, variables: { type: 'array', items: {} }, createdAt: { type: 'string', format: 'date-time' } } },
  Folder: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, parentId: { type: 'string', nullable: true }, createdAt: { type: 'string', format: 'date-time' } } },
  Branch: { type: 'object', properties: { id: { type: 'string' }, workflowId: { type: 'string' }, name: { type: 'string' }, headVersionId: { type: 'string' } } },
  Version: { type: 'object', properties: { id: { type: 'string' }, branchId: { type: 'string' }, workflowId: { type: 'string' }, number: { type: 'integer' }, label: { type: 'string' }, state: { type: 'string', enum: ['draft', 'published'] }, engine: { type: 'object' } } },
  Deployment: { type: 'object', properties: { id: { type: 'string' }, workflowId: { type: 'string' }, versionId: { type: 'string' }, environment: { type: 'string' }, status: { type: 'string', enum: ['active', 'inactive', 'archived'] }, tags: { type: 'array', items: { type: 'string' } }, versionNumber: { type: 'integer' }, versionLabel: { type: 'string' }, env: { type: 'object', additionalProperties: { type: 'string' } }, deployedAt: { type: 'string', format: 'date-time' } } },
  NodeVisit: { type: 'object', properties: { tokenId: { type: 'string' }, nodeId: { type: 'string' }, type: { type: 'string' }, enteredAt: { type: 'string' }, exitedAt: { type: 'string' }, outcome: { type: 'string' } } },
  Token: { type: 'object', properties: { id: { type: 'string' }, nodeId: { type: 'string' }, state: { type: 'string', enum: ['active', 'waiting'] }, waitFor: { type: 'object' } } },
  Instance: { type: 'object', properties: { id: { type: 'string' }, workflowId: { type: 'string' }, deploymentId: { type: 'string' }, processId: { type: 'string' }, correlationKey: { type: 'string' }, status: { type: 'string', enum: ['running', 'waiting', 'completed', 'aborted', 'failed', 'suspended'] }, variables: { type: 'object' }, tokens: { type: 'array', items: ref('Token') }, history: { type: 'array', items: ref('NodeVisit') }, parentInstanceId: { type: 'string' }, startedAt: { type: 'string' }, startedBy: { type: 'string' }, endedAt: { type: 'string' } } },
  InstanceGraph: { type: 'object', properties: { nodes: { type: 'array', items: {} }, flows: { type: 'array', items: {} }, diagram: { type: 'object', properties: { activeNodeIds: { type: 'array', items: { type: 'string' } }, visitedNodeIds: { type: 'array', items: { type: 'string' } }, status: { type: 'string' } } }, counts: { type: 'object', additionalProperties: { type: 'integer' }, description: 'per-node execution count' }, status: { type: 'string' } } },
  Task: { type: 'object', properties: { id: { type: 'string' }, instanceId: { type: 'string' }, nodeId: { type: 'string' }, name: { type: 'string' }, group: { type: 'string' }, assignee: { type: 'string' }, status: { type: 'string', enum: ['created', 'reserved', 'inprogress', 'completed', 'skipped', 'error'] }, inputs: { type: 'object' }, outputs: { type: 'object' }, createdAt: { type: 'string' }, dueAt: { type: 'string' }, completedAt: { type: 'string' }, completedBy: { type: 'string' } } },
  TimerJob: { type: 'object', properties: { id: { type: 'string' }, instanceId: { type: 'string' }, nodeId: { type: 'string' }, kind: { type: 'string', enum: ['duration', 'cycle', 'date', 'start'] }, dueAt: { type: 'string' }, cycle: { type: 'string' }, status: { type: 'string', enum: ['scheduled', 'fired', 'cancelled'] }, deploymentId: { type: 'string' }, processId: { type: 'string' } } },
  UserRow: { type: 'object', properties: { user: { type: 'string' }, groups: { type: 'array', items: { type: 'string' } }, startedInstances: { type: 'integer' }, openTasks: { type: 'integer' }, completedTasks: { type: 'integer' } } },
  ProcessDef: { type: 'object', properties: { processId: { type: 'string' }, name: { type: 'string' }, package: { type: 'string' }, deploymentId: { type: 'string' }, environment: { type: 'string' }, version: { type: 'string' }, nodes: { type: 'integer' }, instances: { type: 'object', properties: { total: { type: 'integer' }, active: { type: 'integer' } } } } },
  DurStats: { type: 'object', properties: { count: { type: 'integer' }, avgMs: { type: 'integer' }, minMs: { type: 'integer' }, maxMs: { type: 'integer' } } },
  Summary: { type: 'object', properties: { instances: { type: 'object' }, tasks: { type: 'object' }, deployments: { type: 'object' }, jobs: { type: 'object' } } },
  User: { type: 'object', properties: { id: { type: 'string' }, username: { type: 'string' }, roles: { type: 'array', items: { type: 'string' } }, groups: { type: 'array', items: { type: 'string' } }, active: { type: 'boolean' }, createdAt: { type: 'string' } } },
  ExecutionError: { type: 'object', properties: { id: { type: 'string' }, type: { type: 'string', enum: ['process', 'task', 'job', 'integration'] }, instanceId: { type: 'string' }, taskId: { type: 'string' }, jobId: { type: 'string' }, workflowId: { type: 'string' }, deploymentId: { type: 'string' }, processId: { type: 'string' }, nodeId: { type: 'string' }, nodeName: { type: 'string' }, nodeType: { type: 'string' }, message: { type: 'string' }, stack: { type: 'string' }, at: { type: 'string' }, occurrences: { type: 'integer' }, acknowledged: { type: 'boolean' }, acknowledgedBy: { type: 'string' }, acknowledgedAt: { type: 'string' } } },
  AuditEvent: { type: 'object', properties: { id: { type: 'string' }, at: { type: 'string' }, actor: { type: 'string' }, kind: { type: 'string' }, workflowId: { type: 'string' }, deploymentId: { type: 'string' }, instanceId: { type: 'string' }, taskId: { type: 'string' }, nodeId: { type: 'string' }, data: { type: 'object' } } },
  Notification: { type: 'object', properties: { id: { type: 'string' }, userId: { type: 'string' }, kind: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, link: { type: 'string' }, instanceId: { type: 'string' }, taskId: { type: 'string' }, deploymentId: { type: 'string' }, read: { type: 'boolean' }, at: { type: 'string' } } },
  TaskComment: { type: 'object', properties: { id: { type: 'string' }, taskId: { type: 'string' }, author: { type: 'string' }, body: { type: 'string' }, at: { type: 'string' } } },
  SystemSettings: { type: 'object', properties: { defaultPageSize: { type: 'integer', enum: [10, 20, 50, 100] }, instanceRetentionDays: { type: 'integer' }, auditRetentionDays: { type: 'integer' }, allowRunningVariableEdits: { type: 'boolean' }, executorIntervalSeconds: { type: 'integer' }, timerBatchSize: { type: 'integer' }, defaultJobRetries: { type: 'integer' }, jobRetryBackoffMultiplier: { type: 'number' }, scriptTimeoutSeconds: { type: 'integer' }, slaWarnThresholdPct: { type: 'integer' }, defaultTaskSlaHours: { type: 'integer' }, autoReleaseClaimedTaskHours: { type: 'number' }, httpTimeoutSeconds: { type: 'integer' }, outboundAllowlist: { type: 'string' }, historyAuditLevel: { type: 'string', enum: ['full', 'activity', 'minimal'] }, logLevel: { type: 'string', enum: ['debug', 'info', 'warn', 'error'] }, sessionTimeoutHours: { type: 'integer' }, emailEnabled: { type: 'boolean' }, emailFrom: { type: 'string' }, smtpHost: { type: 'string' }, smtpPort: { type: 'integer' }, updatedAt: { type: 'string' }, updatedBy: { type: 'string' } } },
  VariableChange: { type: 'object', properties: { name: { type: 'string' }, from: {}, to: {}, at: { type: 'string' }, actor: { type: 'string' } } },
  Group: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' } } },
  Role: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, permissions: { type: 'array', items: { type: 'string' } } } },
  WorkflowDefinition: {
    type: 'object',
    properties: {
      id: { type: 'string', example: 'def_claims_assessment' },
      name: { type: 'string', example: 'System Claim Assessment' },
      workflowId: { type: 'string', example: 'wf_pru_claims' },
      deploymentId: { type: 'string', example: 'dep_prod_v1' },
      active: { type: 'boolean', example: true },
      schema: { type: 'object' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  WorkflowInstance: {
    type: 'object',
    properties: {
      id: { type: 'string', example: 'case_clm_99214' },
      workflowDefinitionId: { type: 'string', example: 'def_claims_assessment' },
      status: { type: 'string', enum: ['initiated', 'active', 'completed', 'aborted', 'failed'], example: 'active' },
      workflowData: { type: 'object', example: { claimId: 'CLM-99214', claimAmount: 50000, claimantName: 'John Doe', policyNumber: 'POL-3321' } },
      correlationKey: { type: 'string', example: 'POL-3321-CLM-99214' },
      currentTasks: { type: 'array', items: { type: 'string' } },
      history: { type: 'array', items: { type: 'object' } },
      piid: { type: 'string', example: 'inst_882194' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  WorkflowComment: {
    type: 'object',
    properties: {
      id: { type: 'string', example: 'cmt_102' },
      workflowInstanceId: { type: 'string', example: 'case_clm_99214' },
      author: { type: 'string', example: 'alice' },
      body: { type: 'string', example: 'Verified medical report and beneficiary ID documents.' },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  WorkflowAudit: {
    type: 'object',
    properties: {
      id: { type: 'string', example: 'aud_501' },
      workflowInstanceId: { type: 'string', example: 'case_clm_99214' },
      actor: { type: 'string', example: 'bob' },
      kind: { type: 'string', example: 'workflowInstance.status_updated' },
      data: { type: 'object' },
      at: { type: 'string', format: 'date-time' },
    },
  },
  SavedQuery: {
    type: 'object',
    properties: {
      id: { type: 'string', example: 'qry_pending_high_value' },
      name: { type: 'string', example: 'High-Value Pending Claims' },
      query: { type: 'object', example: { collection: 'instances', filter: { status: 'waiting', 'variables.claimAmount': { $gte: 25000 } } } },
      author: { type: 'string', example: 'admin' },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  TATReport: {
    type: 'object',
    properties: {
      count: { type: 'integer', example: 142 },
      avgHours: { type: 'number', example: 18.4 },
      minHours: { type: 'number', example: 1.2 },
      maxHours: { type: 'number', example: 72.0 },
      byAssignee: { type: 'object' },
    },
  },
  SLAViolations: {
    type: 'object',
    properties: {
      totalOpenTasks: { type: 'integer', example: 45 },
      overdueCount: { type: 'integer', example: 3 },
      atRiskCount: { type: 'integer', example: 7 },
      overdueTasks: { type: 'array', items: { type: 'object' } },
      atRiskTasks: { type: 'array', items: { type: 'object' } },
      overdueByGroup: { type: 'object' },
      overdueByPriority: { type: 'object' },
    },
  },
  WorkloadDistribution: {
    type: 'object',
    properties: {
      totalOpen: { type: 'integer', example: 45 },
      users: { type: 'array', items: { type: 'object' } },
      groups: { type: 'array', items: { type: 'object' } },
    },
  },
  ProjectAnalytics: {
    type: 'object',
    properties: {
      summary: {
        type: 'object',
        properties: {
          totalProjects: { type: 'integer', example: 4 },
          totalInstances: { type: 'integer', example: 120 },
          activeInstances: { type: 'integer', example: 15 },
          completedInstances: { type: 'integer', example: 100 },
          failedInstances: { type: 'integer', example: 5 },
          totalTasks: { type: 'integer', example: 250 },
          completedTasks: { type: 'integer', example: 210 },
          openTasks: { type: 'integer', example: 35 },
          overdueTasks: { type: 'integer', example: 5 },
          instanceTat: { type: 'object' },
          taskTat: { type: 'object' },
          sla: { type: 'object' },
        },
      },
      byProject: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            workflowId: { type: 'string', example: 'claims-intake' },
            name: { type: 'string', example: 'Claims Intake' },
            instances: { type: 'object' },
            tasks: { type: 'object' },
            instanceTat: { type: 'object' },
            taskTat: { type: 'object' },
            sla: { type: 'object' },
          },
        },
      },
    },
  },
  UserAnalytics: {
    type: 'object',
    properties: {
      user: { type: 'string', example: 'john.examiner' },
      tasksCompleted: { type: 'integer', example: 48 },
      tasksActive: { type: 'integer', example: 3 },
      tasksTotal: { type: 'integer', example: 51 },
      byStatus: { type: 'object' },
      tat: {
        type: 'object',
        properties: {
          count: { type: 'integer', example: 48 },
          avgMs: { type: 'integer', example: 45000 },
          minMs: { type: 'integer', example: 12000 },
          maxMs: { type: 'integer', example: 120000 },
          p50Ms: { type: 'integer', example: 42000 },
          p95Ms: { type: 'integer', example: 98000 },
        },
      },
      sla: {
        type: 'object',
        properties: {
          totalWithDue: { type: 'integer', example: 48 },
          onTime: { type: 'integer', example: 46 },
          overdue: { type: 'integer', example: 2 },
          complianceRate: { type: 'integer', example: 96 },
        },
      },
      byTaskName: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            taskName: { type: 'string', example: 'Examiner Review' },
            count: { type: 'integer', example: 30 },
            avgMs: { type: 'integer', example: 42000 },
          },
        },
      },
    },
  },
  GroupAnalytics: {
    type: 'object',
    properties: {
      group: { type: 'string', example: 'examiners' },
      tasksTotal: { type: 'integer', example: 85 },
      tasksCompleted: { type: 'integer', example: 70 },
      tasksOpen: { type: 'integer', example: 15 },
      tasksUnassigned: { type: 'integer', example: 5 },
      tasksInProgress: { type: 'integer', example: 10 },
      tat: { type: 'object' },
      sla: { type: 'object' },
      byUser: { type: 'array', items: { type: 'object' } },
      byTaskName: { type: 'array', items: { type: 'object' } },
    },
  },
  TaskDefinitionAnalytics: {
    type: 'object',
    properties: {
      taskName: { type: 'string', example: 'Examiner Review' },
      processId: { type: 'string', example: 'claims-intake.process' },
      workflowId: { type: 'string', example: 'claims-intake' },
      totalCount: { type: 'integer', example: 120 },
      completedCount: { type: 'integer', example: 105 },
      openCount: { type: 'integer', example: 15 },
      failedCount: { type: 'integer', example: 0 },
      tat: { type: 'object' },
      sla: { type: 'object' },
      byAssignee: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            user: { type: 'string', example: 'alice' },
            count: { type: 'integer', example: 40 },
            avgMs: { type: 'integer', example: 38000 },
          },
        },
      },
      byGroup: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            group: { type: 'string', example: 'examiners' },
            count: { type: 'integer', example: 105 },
            avgMs: { type: 'integer', example: 41000 },
          },
        },
      },
    },
  },
  ProcessDefinitionAnalytics: {
    type: 'object',
    properties: {
      processId: { type: 'string', example: 'claims-intake.process' },
      name: { type: 'string', example: 'Claims Intake' },
      workflowId: { type: 'string', example: 'claims-intake' },
      package: { type: 'string', example: 'com.enterprise.claims' },
      deploymentId: { type: 'string', example: 'dep_101' },
      version: { type: 'string', example: 'v1' },
      instances: {
        type: 'object',
        properties: {
          total: { type: 'integer', example: 80 },
          running: { type: 'integer', example: 10 },
          completed: { type: 'integer', example: 68 },
          failed: { type: 'integer', example: 2 },
          aborted: { type: 'integer', example: 0 },
          successRate: { type: 'integer', example: 97 },
        },
      },
      tat: { type: 'object' },
      totalTasks: { type: 'integer', example: 160 },
      tasksCompleted: { type: 'integer', example: 140 },
      avgTasksPerInstance: { type: 'number', example: 2.0 },
      sla: { type: 'object' },
    },
  },
  CaseObject: {
    type: 'object',
    properties: {
      caseId: { type: 'string', example: '5f3a0937-bdcd-4d8e-be89-7cfc1f3c3a03' },
      policyNumber: { type: 'string', example: 'POL-11111' },
      claimType: { type: 'string', example: 'DEATH' },
      caseStatus: { type: 'string', example: 'PENDING_DEATH' },
      dateOfDeath: { type: 'string', nullable: true, example: '2025-04-01' },
      causeOfDeath: { type: 'string', nullable: true, example: 'NATURAL' },
      placeOfDeath: { type: 'string', nullable: true, example: 'New York City Hospital' },
      examinerResolution: { type: 'string', nullable: true, example: 'APPROVED' },
      examinerComment: { type: 'string', nullable: true, example: 'Manual review passed.' },
      interestMethodConfirmed: { type: 'boolean', example: false },
      totalPayoutAmount: { type: 'number', example: 500000 },
      jbpmProcessInstanceId: { type: 'string', nullable: true, example: '99812' },
      claimant: { type: 'object' },
      policyDetails: { type: 'array', items: { type: 'object' } },
      beneficiaries: { type: 'array', items: { type: 'object' } },
      taxWithholdings: { type: 'array', items: { type: 'object' } },
      documents: { type: 'array', items: { type: 'object' } },
      flags: { type: 'object' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  Milestone: {
    type: 'object',
    properties: {
      id: { type: 'string', example: 'mls_01' },
      name: { type: 'string', example: 'DOCS_RECEIVED' },
      status: { type: 'string', example: 'achieved' },
      achievedAt: { type: 'string', format: 'date-time' },
      achievedBy: { type: 'string', example: 'alice' },
    },
  },
  TaskAttachment: {
    type: 'object',
    properties: {
      id: { type: 'string', example: 'att_01' },
      taskId: { type: 'string', example: 'tsk_101' },
      name: { type: 'string', example: 'death_certificate.pdf' },
      mimeType: { type: 'string', example: 'application/pdf' },
      url: { type: 'string', example: 'https://s3.amazonaws.com/claims-docs/cert.pdf' },
      sizeBytes: { type: 'integer', example: 1048576 },
      author: { type: 'string', example: 'john.doe' },
      at: { type: 'string', format: 'date-time' },
    },
  },
  NodeInstance: {
    type: 'object',
    properties: {
      id: { type: 'string', example: 'hist_0_start' },
      tokenId: { type: 'string', example: 'tok_1' },
      nodeId: { type: 'string', example: 'reviewNode' },
      nodeName: { type: 'string', example: 'Examiner Review' },
      type: { type: 'string', example: 'userTask' },
      state: { type: 'string', enum: ['active', 'waiting', 'completed'], example: 'completed' },
      enteredAt: { type: 'string', format: 'date-time' },
      exitedAt: { type: 'string', format: 'date-time' },
      outcome: { type: 'string' },
    },
  },
  BulkResult: {
    type: 'object',
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            ok: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
      },
    },
  },
  CaseFlag: {
    type: 'object',
    properties: {
      id: { type: 'string', example: 'flg_01' },
      flagType: { type: 'string', example: 'FRAUD_SUSPICION' },
      flagValue: {},
      reason: { type: 'string', example: 'Address mismatch on claim submission' },
      raisedAt: { type: 'string', format: 'date-time' },
      raisedBy: { type: 'string', example: 'system' },
    },
  },
  CaseDocument: {
    type: 'object',
    properties: {
      id: { type: 'string', example: 'doc_01' },
      document_name: { type: 'string', example: 'certified_death_certificate.pdf' },
      document_type: { type: 'string', example: 'DEATH_CERTIFICATE' },
      s3_key: { type: 'string', nullable: true, example: 'claims/docs/cert.pdf' },
      required: { type: 'boolean', example: true },
      status: { type: 'string', example: 'UPLOADED' },
      type: { type: 'string', example: 'USER_UPLOADED' },
      uploadedAt: { type: 'string', format: 'date-time' },
      uploadedBy: { type: 'string', example: 'john.examiner' },
    },
  },
};

// ---- paths (grouped by tag) ----
const paths: Record<string, any> = {
  '/catalog/nodes': { get: { tags: ['Catalog'], summary: 'Node palette, property schemas and connection ports', responses: ok({ type: 'object' }) } },
  '/catalog/cheat-sheet': { get: { tags: ['Catalog'], summary: 'JavaScript and flow variables cheat sheet', responses: ok({ type: 'object', properties: { cheatSheet: { type: 'string' } } }) } },
  '/catalog/nodes/{engineType}': { get: { tags: ['Catalog'], summary: 'One node type definition', parameters: [idParam('engineType', 'Engine node type')], responses: { ...ok({ type: 'object' }), '404': { description: 'Not found', content: { 'application/json': { schema: ref('Error') } } } } } },
  '/catalog/assets/readmes': { get: { tags: ['Catalog'], summary: 'All asset markdown documentation', responses: ok({ type: 'object' }) } },
  '/catalog/assets/{kind}/readme': { get: { tags: ['Catalog'], summary: 'Asset markdown documentation by kind', parameters: [idParam('kind', 'Asset kind')], responses: { ...ok({ type: 'object' }), '404': { description: 'Not found', content: { 'application/json': { schema: ref('Error') } } } } } },
  '/catalog/processes': { get: { tags: ['Catalog'], summary: 'Every process behind a currently-active deployment, tenant-wide — what a call activity / multi-instance node can resolve', responses: ok({ type: 'object' }) } },
  '/validate': { post: { tags: ['Authoring'], summary: 'Validate an in-progress process (no save)', requestBody: jsonBody({ type: 'object' }), responses: ok(ref('ValidationResult')) } },
  '/import/jbpm': { post: { tags: ['Import/Export'], summary: 'Import a jBPM kjar (file map) as a new project', requestBody: jsonBody({ type: 'object', properties: { files: { type: 'object', additionalProperties: { type: 'string' } }, name: { type: 'string' } } }), responses: created({ type: 'object', properties: { workflowId: { type: 'string' }, processes: { type: 'integer' } } }) } },
  '/import/jbpm/deploy': { post: { tags: ['Import/Export'], summary: 'Import a jBPM kjar and deploy it immediately, in one step', requestBody: jsonBody({ type: 'object', properties: { files: { type: 'object', additionalProperties: { type: 'string' } }, name: { type: 'string' }, environment: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, env: { type: 'object', additionalProperties: { type: 'string' } } } }), responses: created({ type: 'object', properties: { workflowId: { type: 'string' }, processes: { type: 'integer' }, deploymentId: { type: 'string' } } }) } },

  '/folders': {
    get: { tags: ['Projects'], summary: 'List folders (Projects-page tree)', responses: ok(listOf('Folder')) },
    post: { tags: ['Projects'], summary: 'Create a folder', requestBody: jsonBody({ type: 'object', properties: { name: { type: 'string' }, parentId: { type: 'string', nullable: true } } }), responses: created(ref('Folder')) },
  },
  '/folders/{id}': {
    get: { tags: ['Projects'], summary: 'Get a folder', parameters: [idParam()], responses: ok(ref('Folder')) },
    patch: { tags: ['Projects'], summary: 'Rename or move a folder', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { name: { type: 'string' }, parentId: { type: 'string', nullable: true } } }), responses: ok(ref('Folder')) },
    delete: { tags: ['Projects'], summary: 'Delete an empty folder', parameters: [idParam()], responses: { '204': { description: 'Deleted' }, '409': { description: 'Folder is not empty', content: { 'application/json': { schema: ref('Error') } } } } },
  },
  '/workflows': {
    get: { tags: ['Projects'], summary: 'List projects', parameters: [q('archived', 'Set to true to list only archived projects'), q('includeArchived', 'Include archived projects in the list')], responses: ok(listOf('Workflow')) },
    post: { tags: ['Projects'], summary: 'Create a project', requestBody: jsonBody({ type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' } } }), responses: created(ref('Workflow')) },
  },
  '/workflows/purge-archived': {
    post: { tags: ['Projects'], summary: 'Permanently purge all archived projects', responses: ok({ type: 'object', properties: { purgedCount: { type: 'number' } } }) },
  },
  '/workflows/{id}': {
    get: { tags: ['Projects'], summary: 'Get a project', parameters: [idParam()], responses: ok(ref('Workflow')) },
    patch: { tags: ['Projects'], summary: 'Update a project', parameters: [idParam()], requestBody: jsonBody({ type: 'object' }), responses: ok(ref('Workflow')) },
    delete: { tags: ['Projects'], summary: 'Archive a project (or purge with ?purge=true)', parameters: [idParam(), q('purge', 'Set true to permanently purge instead of archive')], responses: { '204': { description: 'Archived or purged' } } },
  },
  '/workflows/{id}/restore': {
    post: { tags: ['Projects'], summary: 'Restore an archived project', parameters: [idParam()], responses: ok(ref('Workflow')) },
  },
  '/workflows/{id}/purge': {
    delete: { tags: ['Projects'], summary: 'Permanently delete an archived project', parameters: [idParam()], responses: { '204': { description: 'Permanently purged' } } },
  },
  '/workflows/{id}/permissions': { put: { tags: ['Projects'], summary: 'Set project permissions', parameters: [idParam()], requestBody: jsonBody({ type: 'array', items: {} }), responses: ok(ref('Workflow')) } },
  '/workflows/{id}/variables': { put: { tags: ['Projects'], summary: 'Set project variables', parameters: [idParam()], requestBody: jsonBody({ type: 'array', items: {} }), responses: ok(ref('Workflow')) } },
  '/workflows/{id}/processes': {
    get: { tags: ['Processes'], summary: 'List processes in a project', parameters: [idParam()], responses: ok(listOf('ProcessDef')) },
    post: { tags: ['Processes'], summary: 'Add a process', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { name: { type: 'string' } } }), responses: created({ type: 'object' }) },
  },
  '/workflows/{id}/processes/{pid}': {
    get: { tags: ['Processes'], summary: 'Get a process definition', parameters: [idParam(), idParam('pid', 'Process id')], responses: ok({ type: 'object' }) },
    put: { tags: ['Processes'], summary: 'Save a process definition', parameters: [idParam(), idParam('pid', 'Process id')], requestBody: jsonBody({ type: 'object' }), responses: ok({ type: 'object' }) },
    patch: { tags: ['Processes'], summary: 'Rename a process', parameters: [idParam(), idParam('pid', 'Process id')], requestBody: jsonBody({ type: 'object' }), responses: ok({ type: 'object' }) },
    delete: { tags: ['Processes'], summary: 'Remove a process', parameters: [idParam(), idParam('pid', 'Process id')], responses: { '204': { description: 'Removed' } } },
  },
  '/workflows/{id}/engine': { get: { tags: ['Projects'], summary: 'Assembled engine model (all processes + assets) for a project', parameters: [idParam()], responses: ok({ type: 'object' }) } },
  '/workflows/{id}/export-engine': { get: { tags: ['Projects'], summary: 'Export project engine JSON for Node engine runner', parameters: [idParam()], responses: ok({ type: 'object' }) } },
  '/workflows/{id}/jbpm-compatibility': { get: { tags: ['Projects'], summary: 'Inspect project compatibility with jBPM KIE runtime', parameters: [idParam()], responses: ok({ type: 'object', properties: { compatible: { type: 'boolean' }, errors: { type: 'array', items: { type: 'string' } }, warnings: { type: 'array', items: { type: 'string' } } } }) } },
  '/workflows/{id}/assets': {
    get: { tags: ['Assets'], summary: 'List project assets by kind', parameters: [idParam()], responses: ok({ type: 'object' }) },
    post: { tags: ['Assets'], summary: 'Add an asset', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { kind: { type: 'string' }, name: { type: 'string' }, fields: { type: 'object', description: 'Kind-specific fields beyond the name, e.g. { fact, baseline, target } for a scorecard — see GET /workflows/{id}/assets for each kind\'s nameField.' } } }), responses: created({ type: 'object' }) },
  },
  '/workflows/{id}/assets/{kind}/{name}': {
    get: { tags: ['Assets'], summary: 'Get one asset, with the process nodes that reference it', parameters: [idParam(), idParam('kind', 'Asset kind key, e.g. forms/rulesets/decisions'), idParam('name', "The asset's name (or nameField value, e.g. a ruleset's group)")], responses: ok({ type: 'object', properties: { kind: { type: 'string' }, asset: { type: 'object' }, usedBy: { type: 'array', items: { type: 'object' } } } }) },
    patch: { tags: ['Assets'], summary: 'Update an asset (rename and/or edit its fields); renaming re-points every process reference', parameters: [idParam(), idParam('kind', 'Asset kind key'), idParam('name', 'Current asset name')], requestBody: jsonBody({ type: 'object' }), responses: ok({ type: 'object', properties: { kind: { type: 'string' }, name: { type: 'string' } } }) },
    delete: { tags: ['Assets'], summary: 'Delete an asset — blocked (409) while any process node still references it', parameters: [idParam(), idParam('kind', 'Asset kind key'), idParam('name', 'Asset name')], responses: { '204': { description: 'Deleted' }, '409': { description: 'Still referenced', content: { 'application/json': { schema: ref('Error') } } } } },
  },
  '/workflows/{id}/assets/{kind}/{name}/test': {
    post: { tags: ['Assets'], summary: 'Execute, simulate, or test an asset according to its purpose', parameters: [idParam(), idParam('kind', 'Asset kind key'), idParam('name', 'Asset name')], requestBody: jsonBody({ type: 'object' }, false), responses: ok({ type: 'object' }) },
  },
  '/workflows/{id}/assets/{kind}/{name}/duplicate': {
    post: {
      tags: ['Assets'],
      summary: 'Duplicate an asset within a project',
      description: 'Clones an existing project asset (DMN decision, DRL ruleset, data type, scorecard, decision tree, form, etc.) with a new unique name in the current project.',
      parameters: [idParam(), idParam('kind', 'Asset kind key'), idParam('name', 'Source asset name')],
      requestBody: jsonBody({ type: 'object', required: ['newName'], properties: { newName: { type: 'string', example: 'CreditRiskModel_Copy' } } }),
      responses: created({ type: 'object', properties: { kind: { type: 'string' }, name: { type: 'string' } } }),
    },
  },
  '/workflows/{id}/audit': {
    get: {
      tags: ['Workflows'],
      summary: 'Get audit log events scoped to a specific project / workspace',
      description: 'Returns the audit trail for this project (assets added/updated/duplicated/removed, processes modified/saved/renamed, deployments, and executions). Requires workflow:view permission.',
      parameters: [idParam(), q('actor', 'Filter by actor'), q('kind', "Exact kind or prefix ending in '.'"), q('from', 'ISO lower bound'), q('to', 'ISO upper bound'), q('limit', 'Page size'), q('offset', 'Page offset')],
      responses: ok({ type: 'object', properties: { items: { type: 'array', items: ref('AuditEvent') }, total: { type: 'integer' } } }),
    },
  },
  '/workflows/{id}/audit/facets': {
    get: {
      tags: ['Workflows'],
      summary: 'Distinct kinds + actors present in this project’s audit log',
      parameters: [idParam()],
      responses: ok({ type: 'object', properties: { kinds: { type: 'array', items: { type: 'string' } }, actors: { type: 'array', items: { type: 'string' } } } }),
    },
  },
  '/workflows/{id}/audit/{eventId}': {
    get: {
      tags: ['Workflows'],
      summary: 'Get a specific audit event scoped to this project',
      parameters: [idParam(), idParam('eventId', 'Audit event ID')],
      responses: ok(ref('AuditEvent')),
    },
  },
  '/workflows/{id}/branches': {
    get: { tags: ['Versioning'], summary: 'List branches', parameters: [idParam()], responses: ok(listOf('Branch')) },
    post: { tags: ['Versioning'], summary: 'Create a branch', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { name: { type: 'string' }, fromVersionId: { type: 'string' } } }), responses: created(ref('Branch')) },
  },
  '/branches/{id}': { get: { tags: ['Versioning'], summary: 'Get a branch', parameters: [idParam()], responses: ok(ref('Branch')) } },
  '/branches/{id}/versions': {
    get: { tags: ['Versioning'], summary: 'List versions on a branch', parameters: [idParam()], responses: ok(listOf('Version')) },
    post: { tags: ['Versioning'], summary: 'Save a draft version', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { engine: { type: 'object' }, message: { type: 'string' } } }), responses: created(ref('Version')) },
  },
  '/versions/{id}': { get: { tags: ['Versioning'], summary: 'Get a version', parameters: [idParam()], responses: ok(ref('Version')) } },
  '/versions/{id}/publish': { post: { tags: ['Versioning'], summary: 'Publish a draft (immutable) version', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { label: { type: 'string' } } }, false), responses: ok({ type: 'object' }) } },
  '/versions/{id}/validate': { post: { tags: ['Versioning'], summary: 'Validate a version', parameters: [idParam()], responses: ok(ref('ValidationResult')) } },
  '/versions/{a}/diff/{b}': { get: { tags: ['Versioning'], summary: 'Diff two versions', parameters: [idParam('a', 'Version A'), idParam('b', 'Version B')], responses: ok({ type: 'object' }) } },
  '/versions/{id}/deploy': { post: { tags: ['Deployments'], summary: 'Deploy a published version', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { environment: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, env: { type: 'object' }, activate: { type: 'boolean' } } }), responses: created(ref('Deployment')) } },
  '/versions/{id}/export': { get: { tags: ['Import/Export'], summary: 'Export a version as a jBPM kjar (file map)', parameters: [idParam()], responses: ok({ type: 'object', properties: { files: { type: 'object', additionalProperties: { type: 'string' } } } }) } },
  '/versions/{id}/export-engine': { get: { tags: ['Import/Export'], summary: 'Export version engine JSON for Node engine runner', parameters: [idParam()], responses: ok({ type: 'object' }) } },
  '/versions/{id}/jbpm-compatibility': { get: { tags: ['Import/Export'], summary: 'Inspect version compatibility with jBPM KIE runtime', parameters: [idParam()], responses: ok({ type: 'object', properties: { compatible: { type: 'boolean' }, errors: { type: 'array', items: { type: 'string' } }, warnings: { type: 'array', items: { type: 'string' } } } }) } },

  '/deployments': { get: { tags: ['Deployments'], summary: 'List deployments across all projects', parameters: [q('workflowId', 'Filter by project'), q('environment', 'Filter by environment'), q('status', 'Filter by status')], responses: ok(listOf('Deployment')) } },
  '/workflows/{id}/deployments': { get: { tags: ['Deployments'], summary: 'List deployments for a project', parameters: [idParam()], responses: ok(listOf('Deployment')) } },
  '/deployments/{id}': { get: { tags: ['Deployments'], summary: 'Get a deployment', parameters: [idParam()], responses: ok(ref('Deployment')) } },
  '/deployments/{id}/tags': { post: { tags: ['Deployments'], summary: 'Add/remove deployment tags', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { add: { type: 'array', items: { type: 'string' } }, remove: { type: 'array', items: { type: 'string' } } } }), responses: ok(ref('Deployment')) } },
  '/deployments/{id}/activate': { post: { tags: ['Deployments'], summary: 'Activate (swaps the active one in the environment)', parameters: [idParam()], responses: ok(ref('Deployment')) } },
  '/deployments/{id}/rollback': { post: { tags: ['Deployments'], summary: 'Roll back to this deployment', parameters: [idParam()], responses: ok(ref('Deployment')) } },
  '/deployments/{id}/undeploy': { post: { tags: ['Deployments'], summary: 'Undeploy (deactivate)', parameters: [idParam()], responses: ok(ref('Deployment')) } },
  '/deployments/{id}/archive': { post: { tags: ['Deployments'], summary: 'Archive a deployment', parameters: [idParam()], responses: ok(ref('Deployment')) } },
  '/deployments/{id}/export': { get: { tags: ['Import/Export'], summary: 'Export a deployment as a jBPM kjar', parameters: [idParam()], responses: ok({ type: 'object' }) } },
  '/deployments/{id}/snapshot': { get: { tags: ['Deployments'], summary: 'Export a self-contained deployment snapshot (.json)', parameters: [idParam()], responses: ok({ type: 'object' }) } },
  '/deployments/{id}/restore': { post: { tags: ['Deployments'], summary: 'Restore a deployment snapshot back into the project draft', parameters: [idParam()], responses: ok({ type: 'object' }) } },
  '/deployments/import': { post: { tags: ['Deployments'], summary: 'Import a deployment snapshot package', requestBody: jsonBody({ type: 'object' }), responses: created(ref('Deployment')) } },
  '/deployments/{id}/definitions': { get: { tags: ['Processes'], summary: 'Process definitions in a deployment', parameters: [idParam()], responses: ok(listOf('ProcessDef')) } },

  '/instances': {
    get: { tags: ['Instances'], summary: 'List process instances', parameters: [q('workflowId', 'Filter by project'), q('status', 'Filter by status'), q('deploymentId', 'Filter by deployment'), q('correlationKey', 'Filter by correlation key')], responses: ok(listOf('Instance')) },
    post: { tags: ['Instances'], summary: 'Start a process instance', requestBody: jsonBody({ type: 'object', properties: { workflowId: { type: 'string' }, processId: { type: 'string' }, environment: { type: 'string' }, deploymentId: { type: 'string' }, variables: { type: 'object' }, correlationKey: { type: 'string' } } }), responses: created(ref('Instance')) },
  },
  '/instances/{id}': { get: { tags: ['Instances'], summary: 'Get an instance', parameters: [idParam()], responses: ok(ref('Instance')) } },
  '/instances/{id}/history': { get: { tags: ['Instances'], summary: 'Node-visit history', parameters: [idParam()], responses: ok({ type: 'array', items: ref('NodeVisit') }) } },
  '/instances/{id}/graph': { get: { tags: ['Instances'], summary: 'Diagram + per-node execution counts (instance badges)', parameters: [idParam()], responses: ok(ref('InstanceGraph')) } },
  '/instances/{id}/diagram-state': { get: { tags: ['Instances'], summary: 'Active/visited node ids', parameters: [idParam()], responses: ok({ type: 'object' }) } },
  '/instances/{id}/related': { get: { tags: ['Instances'], summary: 'Parent + child (sub-process) instances', parameters: [idParam()], responses: ok({ type: 'object' }) } },
  '/instances/{id}/signal': { post: { tags: ['Instances'], summary: 'Send a signal/message to the instance', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { name: { type: 'string' }, payload: {} } }), responses: ok(ref('Instance')) } },
  '/instances/{id}/retry': { post: { tags: ['Instances'], summary: 'Re-trigger a node (retry / replay)', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { nodeId: { type: 'string' } } }), responses: ok(ref('Instance')) } },
  '/instances/{id}/suspend': { post: { tags: ['Instances'], summary: 'Suspend (cascades to the whole subtree)', parameters: [idParam()], responses: ok(ref('Instance')) } },
  '/instances/{id}/resume': { post: { tags: ['Instances'], summary: 'Resume the subtree', parameters: [idParam()], responses: ok(ref('Instance')) } },
  '/instances/{id}/abort': { post: { tags: ['Instances'], summary: 'Abort (cascades to active children)', parameters: [idParam()], responses: ok(ref('Instance')) } },
  '/instances/{id}/nodes': { get: { tags: ['Instances'], summary: 'List executed and active node instances', parameters: [idParam()], responses: ok({ type: 'object', properties: { items: { type: 'array', items: ref('NodeInstance') } } }) } },
  '/instances/{id}/variables': {
    get: { tags: ['Instances'], summary: 'Get current variables dictionary of an instance', parameters: [idParam()], responses: ok({ type: 'object' }) },
    put: { tags: ['Instances'], summary: 'Edit instance variables inline (audited; refused once the instance has ended)', parameters: [idParam()], requestBody: jsonBody({ type: 'object', additionalProperties: {} }), responses: ok(ref('Instance')) },
  },
  '/instances/{id}/variable-history': { get: { tags: ['Instances'], summary: 'Per-variable change history (from the audit trail)', parameters: [idParam(), q('name', 'Only this variable')], responses: ok(listOf('VariableChange')) } },
  '/instances/bulk/abort': { post: { tags: ['Instances'], summary: 'Bulk abort process instances', requestBody: jsonBody({ type: 'object', properties: { instanceIds: { type: 'array', items: { type: 'string' } } } }), responses: ok(ref('BulkResult')) } },
  '/instances/bulk/signal': { post: { tags: ['Instances'], summary: 'Bulk signal process instances', requestBody: jsonBody({ type: 'object', properties: { instanceIds: { type: 'array', items: { type: 'string' } }, name: { type: 'string' }, payload: { type: 'object' } } }), responses: ok(ref('BulkResult')) } },

  '/tasks': { get: { tags: ['Human Tasks'], summary: 'List tasks', parameters: [q('assignee', 'Owned by user'), q('group', 'Group queue'), q('status', 'Task status'), q('overdue', 'true = only tasks past their dueAt and not yet completed/skipped')], responses: ok(listOf('Task')) } },
  '/tasks/bulk/claim': { post: { tags: ['Human Tasks'], summary: 'Bulk claim tasks', requestBody: jsonBody({ type: 'object', properties: { taskIds: { type: 'array', items: { type: 'string' } } } }), responses: ok(ref('BulkResult')) } },
  '/tasks/bulk/release': { post: { tags: ['Human Tasks'], summary: 'Bulk release tasks', requestBody: jsonBody({ type: 'object', properties: { taskIds: { type: 'array', items: { type: 'string' } } } }), responses: ok(ref('BulkResult')) } },
  '/tasks/bulk/complete': { post: { tags: ['Human Tasks'], summary: 'Bulk complete tasks', requestBody: jsonBody({ type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { taskId: { type: 'string' }, outputs: { type: 'object' } } } } } }), responses: ok(ref('BulkResult')) } },
  '/tasks/{id}': {
    get: { tags: ['Human Tasks'], summary: 'Get a task', parameters: [idParam()], responses: ok(ref('Task')) },
    patch: { tags: ['Human Tasks'], summary: 'Admin edits: priority / due date (null dueAt clears it)', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { priority: { type: 'integer' }, dueAt: { type: 'string', format: 'date-time', nullable: true } } }), responses: ok(ref('Task')) },
  },
  '/tasks/{id}/inputs': { get: { tags: ['Human Tasks'], summary: 'Get task input variables', parameters: [idParam()], responses: ok({ type: 'object' }) } },
  '/tasks/{id}/outputs': { get: { tags: ['Human Tasks'], summary: 'Get task output variables', parameters: [idParam()], responses: ok({ type: 'object' }) } },
  '/tasks/{id}/claim': { post: { tags: ['Human Tasks'], summary: 'Claim a task', parameters: [idParam()], responses: ok(ref('Task')) } },
  '/tasks/{id}/release': { post: { tags: ['Human Tasks'], summary: 'Release a task', parameters: [idParam()], responses: ok(ref('Task')) } },
  '/tasks/{id}/complete': { post: { tags: ['Human Tasks'], summary: 'Complete a task (resumes the instance)', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { outputs: { type: 'object' } } }), responses: ok(ref('Task')) } },
  '/tasks/{id}/skip': { post: { tags: ['Human Tasks'], summary: 'Skip a task without completing it (only if the node is declared skippable)', parameters: [idParam()], responses: ok(ref('Task')) } },
  '/tasks/{id}/fail': {
    post: {
      tags: ['Human Tasks'],
      summary: 'Fail / reject a task with error details',
      description: 'Transitions task to failed state and raises a TASK_FAILED error to trigger error boundaries or incident handling.',
      parameters: [idParam()],
      requestBody: jsonBody({ type: 'object', properties: { message: { type: 'string', example: 'Medical report mismatch' }, data: { type: 'object' } } }, false),
      responses: ok(ref('Task')),
    },
  },
  '/tasks/{id}/suspend': { post: { tags: ['Human Tasks'], summary: 'Suspend task (pause work)', parameters: [idParam()], responses: ok(ref('Task')) } },
  '/tasks/{id}/resume': { post: { tags: ['Human Tasks'], summary: 'Resume task from suspended state', parameters: [idParam()], responses: ok(ref('Task')) } },
  '/tasks/{id}/start': { post: { tags: ['Human Tasks'], summary: 'Start working (reserved → inprogress; starting from Ready implicitly claims)', parameters: [idParam()], responses: ok(ref('Task')) } },
  '/tasks/{id}/stop': { post: { tags: ['Human Tasks'], summary: 'Stop working (inprogress → reserved, ownership kept)', parameters: [idParam()], responses: ok(ref('Task')) } },
  '/tasks/{id}/save': { post: { tags: ['Human Tasks'], summary: 'Save partial outputs without completing', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { outputs: { type: 'object' } } }), responses: ok(ref('Task')) } },
  '/tasks/{id}/delegate': { post: { tags: ['Human Tasks'], summary: 'Delegate to a user (lands reserved in their inbox)', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { to: { type: 'string' } } }), responses: ok(ref('Task')) } },
  '/tasks/{id}/forward': { post: { tags: ['Human Tasks'], summary: 'Forward to a user or group queue (back to Ready; target must claim)', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { user: { type: 'string' }, group: { type: 'string' } } }), responses: ok(ref('Task')) } },
  '/tasks/{id}/remind': { post: { tags: ['Human Tasks'], summary: 'Send the current owner a reminder notification', parameters: [idParam()], responses: ok({ type: 'object', properties: { notified: { type: 'string' } } }) } },
  '/tasks/{id}/comments': {
    get: { tags: ['Human Tasks'], summary: 'List comments', parameters: [idParam()], responses: ok(listOf('TaskComment')) },
    post: { tags: ['Human Tasks'], summary: 'Add a comment', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { body: { type: 'string' } } }), responses: created(ref('TaskComment')) },
  },
  '/tasks/{id}/comments/{cid}': { delete: { tags: ['Human Tasks'], summary: 'Delete a comment (author or business admin)', parameters: [idParam(), idParam('cid', 'Comment id')], responses: { '204': { description: 'Deleted' } } } },
  '/tasks/{id}/attachments': {
    get: { tags: ['Human Tasks'], summary: 'List task document attachments', parameters: [idParam()], responses: ok({ type: 'object', properties: { items: { type: 'array', items: ref('TaskAttachment') } } }) },
    post: { tags: ['Human Tasks'], summary: 'Add attachment/evidence to task', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { name: { type: 'string' }, mimeType: { type: 'string' }, url: { type: 'string' }, sizeBytes: { type: 'integer' } } }), responses: created(ref('TaskAttachment')) },
  },
  '/tasks/{id}/attachments/{aid}': { delete: { tags: ['Human Tasks'], summary: 'Delete a task attachment', parameters: [idParam(), idParam('aid', 'Attachment id')], responses: { '204': { description: 'Deleted' } } } },
  '/tasks/{id}/events': { get: { tags: ['Human Tasks'], summary: 'Task audit trail (the Logs tab)', parameters: [idParam()], responses: ok(listOf('AuditEvent')) } },
  '/signals/{signalName}': {
    post: {
      tags: ['Signals'],
      summary: 'Broadcast signal across all active instances in the tenant',
      description: 'Broadcasts a signal event by name to all waiting instances (and matching signal start events), optionally constrained by correlationKey.',
      parameters: [idParam('signalName', 'Signal event name')],
      requestBody: jsonBody({ type: 'object', properties: { payload: { type: 'object', description: 'Signal data payload' }, correlationKey: { type: 'string', description: 'Optional correlation key filter' } } }, false),
      responses: ok({ type: 'object', properties: { signaled: { type: 'integer', description: 'Number of resumed instances' } } }),
    },
  },

  '/errors': { get: { tags: ['Execution Errors'], summary: 'List execution errors (the operational failure queue)', parameters: [q('type', 'Comma-separated: process,task,job,integration'), q('instanceId', 'Filter by instance'), q('taskId', 'Filter by task'), q('jobId', 'Filter by job'), q('workflowId', 'Filter by project'), q('processId', 'Filter by process'), q('acknowledged', 'true / false'), q('from', 'ISO lower bound'), q('to', 'ISO upper bound'), q('limit', 'Page size'), q('offset', 'Page offset')], responses: ok({ type: 'object', properties: { items: { type: 'array', items: ref('ExecutionError') }, total: { type: 'integer' } } }) } },
  '/errors/summary': { get: { tags: ['Execution Errors'], summary: 'Counts for the nav badge / Home KPI', responses: ok({ type: 'object', properties: { total: { type: 'integer' }, unacknowledged: { type: 'integer' }, last24h: { type: 'integer' } } }) } },
  '/errors/{id}': { get: { tags: ['Execution Errors'], summary: 'Get one error', parameters: [idParam()], responses: ok(ref('ExecutionError')) } },
  '/errors/{id}/ack': { post: { tags: ['Execution Errors'], summary: 'Acknowledge (take ownership; idempotent)', parameters: [idParam()], responses: ok(ref('ExecutionError')) } },
  '/errors/ack': { post: { tags: ['Execution Errors'], summary: 'Bulk acknowledge', requestBody: jsonBody({ type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } } }), responses: ok({ type: 'object', properties: { results: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, ok: { type: 'boolean' }, reason: { type: 'string' } } } } } }) } },

  '/jobs': { get: { tags: ['Jobs & Timers'], summary: 'List timer jobs', parameters: [q('status', 'scheduled|fired|cancelled'), q('instanceId', 'Filter by instance'), q('kind', 'duration|cycle|date|start')], responses: ok(listOf('TimerJob')) } },
  '/jobs/{id}': { get: { tags: ['Jobs & Timers'], summary: 'Get a job', parameters: [idParam()], responses: ok(ref('TimerJob')) } },
  '/jobs/{id}/cancel': { post: { tags: ['Jobs & Timers'], summary: 'Cancel a scheduled job', parameters: [idParam()], responses: ok(ref('TimerJob')) } },
  '/jobs/{id}/trigger': { post: { tags: ['Jobs & Timers'], summary: 'Fire a scheduled job now', parameters: [idParam()], responses: ok(ref('TimerJob')) } },
  '/jobs/{id}/reschedule': { post: { tags: ['Jobs & Timers'], summary: 'Move the fire time (also revives a cancelled job)', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { dueAt: { type: 'string', format: 'date-time' } } }), responses: ok(ref('TimerJob')) } },

  '/audit': { get: { tags: ['Governance'], summary: 'Audit log (admin)', parameters: [q('actor', 'Filter by actor'), q('kind', "Exact kind or prefix ending in '.' (e.g. 'task.')"), q('workflowId', 'Filter by project'), q('deploymentId', 'Filter by deployment'), q('instanceId', 'Filter by instance'), q('taskId', 'Filter by task'), q('from', 'ISO lower bound'), q('to', 'ISO upper bound'), q('limit', 'Page size'), q('offset', 'Page offset')], responses: ok({ type: 'object', properties: { items: { type: 'array', items: ref('AuditEvent') }, total: { type: 'integer' } } }) } },
  '/audit/facets': { get: { tags: ['Governance'], summary: 'Distinct kinds + actors for the filter dropdowns (admin)', responses: ok({ type: 'object', properties: { kinds: { type: 'array', items: { type: 'string' } }, actors: { type: 'array', items: { type: 'string' } } } }) } },
  '/audit/{id}': { get: { tags: ['Governance'], summary: 'Get an audit event (admin)', parameters: [idParam()], responses: ok(ref('AuditEvent')) } },

  '/notifications': { get: { tags: ['Notifications'], summary: "The caller's notifications (bell panel)", parameters: [q('unread', 'true = unread only'), q('limit', 'Max rows (default 50)')], responses: ok({ type: 'object', properties: { items: { type: 'array', items: ref('Notification') }, unread: { type: 'integer' } } }) } },
  '/notifications/read-all': { post: { tags: ['Notifications'], summary: 'Mark all read', responses: ok({ type: 'object', properties: { marked: { type: 'integer' } } }) } },
  '/notifications/{id}/read': { post: { tags: ['Notifications'], summary: 'Mark one read', parameters: [idParam()], responses: ok(ref('Notification')) } },

  '/settings/system': {
    get: { tags: ['Governance'], summary: 'Global system settings (singleton; defaults if never saved)', responses: ok(ref('SystemSettings')) },
    put: { tags: ['Governance'], summary: 'Update system settings (admin)', requestBody: jsonBody(ref('SystemSettings')), responses: ok(ref('SystemSettings')) },
  },

  '/query/process-definitions': { get: { tags: ['Query & Analytics'], summary: 'All active process definitions with live stats', responses: ok(listOf('ProcessDef')) } },
  '/query/process-definitions/{processId}/instances': { get: { tags: ['Query & Analytics'], summary: 'Instances of a process definition', parameters: [idParam('processId', 'Process id'), q('status', 'Filter by status')], responses: ok(listOf('Instance')) } },
  '/query/process-definitions/{processId}/signals': { get: { tags: ['Query & Analytics'], summary: 'Signals a process listens-for / throws', parameters: [idParam('processId', 'Process id')], responses: ok({ type: 'object', properties: { processId: { type: 'string' }, listensFor: { type: 'array', items: { type: 'string' } }, throws: { type: 'array', items: { type: 'string' } } } }) } },
  '/query/users': { get: { tags: ['Query & Analytics'], summary: 'Derived user directory with work counts', responses: ok(listOf('UserRow')) } },
  '/query/users/{user}/tasks': { get: { tags: ['Query & Analytics'], summary: 'Tasks owned by a user (inbox)', parameters: [idParam('user', 'User'), q('status', 'Task status')], responses: ok(listOf('Task')) } },
  '/query/users/{user}/tasks/completed': { get: { tags: ['Query & Analytics'], summary: 'Tasks completed by a user', parameters: [idParam('user', 'User')], responses: ok(listOf('Task')) } },
  '/query/groups/{group}/tasks': { get: { tags: ['Query & Analytics'], summary: 'Tasks for a group (queue)', parameters: [idParam('group', 'Group'), q('status', 'Task status')], responses: ok(listOf('Task')) } },
  '/query/instances/{id}/tasks': { get: { tags: ['Query & Analytics'], summary: 'Tasks of a process instance', parameters: [idParam()], responses: ok(listOf('Task')) } },
  '/query/analytics/tasks': { get: { tags: ['Query & Analytics'], summary: 'Task turn-around-time (by task, by assignee)', parameters: [q('workflowId', 'Filter by project/workflowId'), q('processId', 'Filter by process definition ID'), q('from', 'ISO lower bound'), q('to', 'ISO upper bound'), q('since', 'Alternative lower bound')], responses: ok({ type: 'object' }) } },
  '/query/analytics/processes': { get: { tags: ['Query & Analytics'], summary: 'Process turn-around-time + status mix', parameters: [q('workflowId', 'Filter by project/workflowId'), q('processId', 'Filter by process definition ID'), q('from', 'ISO lower bound'), q('to', 'ISO upper bound'), q('days', 'Number of days for daily throughput')], responses: ok({ type: 'object' }) } },
  '/query/analytics/summary': { get: { tags: ['Query & Analytics'], summary: 'Dashboard summary counts', parameters: [q('workflowId', 'Filter by project/workflowId'), q('processId', 'Filter by process definition ID'), q('from', 'ISO lower bound'), q('to', 'ISO upper bound')], responses: ok(ref('Summary')) } },
  '/query/analytics/sla-violations': { get: { tags: ['Query & Analytics'], summary: 'SLA breach and overdue analytics across tasks and processes', parameters: [q('workflowId', 'Filter by project/workflowId')], responses: ok(ref('SLAViolations')) } },
  '/query/analytics/workload': { get: { tags: ['Query & Analytics'], summary: 'Workload distribution across users and examiner groups', parameters: [q('workflowId', 'Filter by project/workflowId')], responses: ok(ref('WorkloadDistribution')) } },
  '/query/analytics/projects': { get: { tags: ['Query & Analytics'], summary: 'Project-level rollup analytics (instances, completed tasks, and TAT across projects)', parameters: [q('workflowId', 'Filter by project/workflowId'), q('from', 'ISO lower bound'), q('to', 'ISO upper bound'), q('since', 'Alternative lower bound')], responses: ok(ref('ProjectAnalytics')) } },
  '/query/analytics/users': { get: { tags: ['Query & Analytics'], summary: 'User performance and productivity analytics (completed tasks, active workload, and TAT)', parameters: [q('workflowId', 'Filter by project/workflowId'), q('group', 'Filter by group'), q('from', 'ISO lower bound'), q('to', 'ISO upper bound')], responses: ok(listOf('UserAnalytics')) } },
  '/query/analytics/users/{user}': { get: { tags: ['Query & Analytics'], summary: 'Detailed performance analytics for a specific user', parameters: [idParam('user', 'Username'), q('workflowId', 'Filter by project/workflowId'), q('group', 'Filter by group'), q('from', 'ISO lower bound'), q('to', 'ISO upper bound')], responses: ok(ref('UserAnalytics')) } },
  '/query/analytics/groups': { get: { tags: ['Query & Analytics'], summary: 'Group / queue analytics (completed tasks, open backlog, unassigned tasks, and TAT)', parameters: [q('workflowId', 'Filter by project/workflowId'), q('from', 'ISO lower bound'), q('to', 'ISO upper bound')], responses: ok(listOf('GroupAnalytics')) } },
  '/query/analytics/groups/{group}': { get: { tags: ['Query & Analytics'], summary: 'Detailed performance analytics for a specific group/queue', parameters: [idParam('group', 'Group name'), q('workflowId', 'Filter by project/workflowId'), q('from', 'ISO lower bound'), q('to', 'ISO upper bound')], responses: ok(ref('GroupAnalytics')) } },
  '/query/analytics/task-definitions': { get: { tags: ['Query & Analytics'], summary: 'Task definitions analytics: total runs, completions, TAT, and TAT per user / group', parameters: [q('workflowId', 'Filter by project/workflowId'), q('processId', 'Filter by process definition ID'), q('from', 'ISO lower bound'), q('to', 'ISO upper bound')], responses: ok(listOf('TaskDefinitionAnalytics')) } },
  '/query/analytics/process-definitions': { get: { tags: ['Query & Analytics'], summary: 'Process definitions analytics: cycle time TAT, success rate, and human task volume', parameters: [q('workflowId', 'Filter by project/workflowId'), q('from', 'ISO lower bound'), q('to', 'ISO upper bound')], responses: ok(listOf('ProcessDefinitionAnalytics')) } },
  '/query/jobs': { get: { tags: ['Query & Analytics'], summary: 'Timer jobs', parameters: [q('status', 'scheduled|fired|cancelled')], responses: ok(listOf('TimerJob')) } },

  '/auth/login': { post: { tags: ['IAM'], security: [], summary: 'Log in — issues a JWT (Bearer token) for every other endpoint', requestBody: jsonBody({ type: 'object', properties: { username: { type: 'string' }, password: { type: 'string' } } }), responses: { ...ok({ type: 'object', properties: { token: { type: 'string' }, user: ref('User') } }), '401': { description: 'Invalid credentials', content: { 'application/json': { schema: ref('Error') } } } } } },
  '/plan/usage': { get: { tags: ['IAM'], summary: 'The workspace plan, its limits and current usage (process starts per day / week / month, workflows, team members, deployments, active instances and timers) with the reset times', responses: ok({ type: 'object', properties: { plan: { type: 'object' }, trialEndsAt: { type: 'string', nullable: true }, expired: { type: 'boolean' }, limits: { type: 'object' }, usage: { type: 'object' }, resources: { type: 'object' } } }) } },
  '/plan/options': { get: { tags: ['IAM'], summary: 'The plans this workspace is offered: active ones can be selected, disabled ones are shown locked, upcoming ones as coming soon; hidden plans are not listed', responses: { '200': { description: 'Plan cards (status, limits, features, selectable, current)' } } } },
  '/plan': { put: { tags: ['IAM'], summary: 'Switch the workspace to an offered plan (team:manage). 409 when the plan is not selectable or the workspace is over its limits', requestBody: jsonBody({ type: 'object', properties: { planKey: { type: 'string' } }, required: ['planKey'] }), responses: { '200': { description: 'New plan and its end date' } } } },
  // --- analytics builder (docs/19-analytics-builder.md) ---
  '/analytics-builder/catalog': { get: { tags: ['Analytics'], summary: 'Everything a query may use — sources, fields (with types and computed flags), relations, functions, operators, buckets — and which sources THIS caller may read (analytics:query)', responses: { '200': { description: 'The catalogue' } } } },
  '/analytics-builder/preview': { post: { tags: ['Analytics'], summary: 'Run an unsaved query (analytics:query; the caller also needs the read permission of every source it touches). Never cached, never saved', requestBody: jsonBody({ type: 'object', properties: { query: { type: 'object' }, params: { type: 'object' } }, required: ['query'] }), responses: { '200': { description: 'mode, columns, rows, meta {tookMs, scanned, returned, total, truncated}' }, '403': { description: 'A source needs a permission the caller lacks' }, '422': { description: 'The query is not valid for the catalogue' } } } },
  '/analytics-builder/apis': {
    get: { tags: ['Analytics'], summary: 'Analytics APIs of this workspace (private ones only for their owner) (analytics:query)', responses: { '200': { description: 'Definitions' } } },
    post: { tags: ['Analytics'], summary: 'Create an analytics API: slug, query, parameters, cache, status, visibility, requires, allowFlows. You cannot publish a query over data you may not read yourself (analytics:query)', requestBody: jsonBody({ type: 'object', properties: { slug: { type: 'string' }, name: { type: 'string' }, query: { type: 'object' }, params: { type: 'array', items: { type: 'object' } }, status: { type: 'string', enum: ['draft', 'published'] }, visibility: { type: 'string', enum: ['workspace', 'private'] }, cacheSeconds: { type: 'integer' }, requires: { type: 'string' }, allowFlows: { type: 'boolean' } }, required: ['slug', 'name', 'query'] }), responses: { '201': { description: 'Created (version 1)' }, '409': { description: 'Slug already used in this workspace' }, '422': { description: 'Invalid definition' } } },
  },
  '/analytics-builder/apis/{id}': {
    get: { tags: ['Analytics'], summary: 'One analytics API definition (analytics:query)', parameters: [idParam()], responses: { '200': { description: 'Definition' } } },
    put: { tags: ['Analytics'], summary: 'Update an analytics API; bumps its version so no stale cached result is served (owner or admin:iam)', parameters: [idParam()], requestBody: jsonBody({ type: 'object' }), responses: { '200': { description: 'Updated definition' } } },
    delete: { tags: ['Analytics'], summary: 'Delete an analytics API (owner or admin:iam)', parameters: [idParam()], responses: { '204': { description: 'Deleted' } } },
  },
  '/analytics/run/{slug}': {
    get: { tags: ['Analytics'], summary: 'Call a published analytics API by slug; parameters in the query string (query:read + the read permission of every source + the API’s own requirement)', parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'slug, version, mode, columns, rows, meta {tookMs, scanned, returned, total, truncated, cached}' }, '403': { description: 'Not permitted to read one of its sources, or it requires a permission the caller lacks' }, '404': { description: 'Unknown, not published, or private to someone else' }, '422': { description: 'Missing / unknown / badly typed parameter' } } },
    post: { tags: ['Analytics'], summary: 'Same as GET, parameters in the JSON body', parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }], requestBody: jsonBody({ type: 'object', properties: { params: { type: 'object' } } }), responses: { '200': { description: 'Result' } } },
  },
  // --- team: workspace members, invitations, ownership ---
  '/team/roles': { get: { tags: ['Team'], summary: 'Roles this caller may hand out in the workspace (built-ins + custom; never owner/system_admin)', responses: { '200': { description: 'Role names and their permissions' } } } },
  '/team/members': { get: { tags: ['Team'], summary: 'Members of the workspace (active, suspended and invited)', responses: { '200': { description: 'Members' } } } },
  '/team/members/pending': { get: { tags: ['Team'], summary: 'Pending invitations (team:manage)', responses: { '200': { description: 'Invited members' } } } },
  '/team/members/invite': { post: { tags: ['Team'], summary: 'Invite someone to the workspace by e-mail with a role (team:invite)', requestBody: jsonBody({ type: 'object', properties: { email: { type: 'string' }, role: { type: 'string' }, displayName: { type: 'string' } }, required: ['email', 'role'] }), responses: { '201': { description: 'Invitation created (and e-mailed)' } } } },
  '/team/members/{id}': {
    put: { tags: ['Team'], summary: 'Change a member’s role or suspend/reactivate them (team:manage)', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { role: { type: 'string' }, status: { type: 'string', enum: ['active', 'suspended'] } } }), responses: { '200': { description: 'Updated member' } } },
    delete: { tags: ['Team'], summary: 'Remove a member from the workspace (team:manage)', parameters: [idParam()], responses: { '204': { description: 'Removed' } } },
  },
  '/team/members/{id}/invitation': { delete: { tags: ['Team'], summary: 'Cancel a pending invitation (team:manage)', parameters: [idParam()], responses: { '204': { description: 'Cancelled' } } } },
  '/team/members/{id}/resend': { post: { tags: ['Team'], summary: 'Re-issue an invitation (team:invite)', parameters: [idParam()], responses: { '200': { description: 'Invitation re-issued' } } } },
  '/team/ownership/transfer': { post: { tags: ['Team'], summary: 'Hand workspace ownership to another member (owner only; the owner becomes an admin)', requestBody: jsonBody({ type: 'object', properties: { memberId: { type: 'string' } }, required: ['memberId'] }), responses: { '200': { description: 'Ownership transferred' } } } },
  '/team/leave': { post: { tags: ['Team'], summary: 'Leave the workspace (not the owner, not the platform administrator)', responses: { '204': { description: 'Left' } } } },
  '/auth/config': { get: { tags: ['IAM'], security: [], summary: 'Configuration-driven sign-in surface: which of SSO / local login / registration / forgot-password / email-verification are on, plus the password policy', responses: ok({ type: 'object', properties: { appName: { type: 'string' }, sso: { type: 'boolean' }, localLogin: { type: 'boolean' }, registration: { type: 'boolean' }, forgotPassword: { type: 'boolean' }, emailVerification: { type: 'boolean' }, registrationMethod: { type: 'string', enum: ['temp_password', 'password'] }, tempPasswordHours: { type: 'integer' }, otpLogin: { type: 'boolean' }, tosUrl: { type: 'string', nullable: true }, passwordMinLength: { type: 'integer' }, ssoLoginUrl: { type: 'string', nullable: true } } }) } },
  '/auth/oidc/login': { get: { tags: ['IAM'], security: [], summary: 'Start single sign-on — redirects the browser to the identity server (authorization code + PKCE)', parameters: [{ in: 'query', name: 'redirect', schema: { type: 'string' }, description: 'Same-origin path to return to after sign-in' }], responses: { '302': { description: 'Redirect to the identity server; sets the signed HttpOnly oidc_tx login-transaction cookie' }, '404': { description: 'Single sign-on is not configured', content: { 'application/json': { schema: ref('Error') } } }, '503': { description: 'Identity server unreachable', content: { 'application/json': { schema: ref('Error') } } } } } },
  '/auth/oidc/callback': { get: { tags: ['IAM'], security: [], summary: 'OIDC redirect URI — exchanges the code and sends the browser to the app with the tokens in the URL fragment (never the query string)', parameters: [{ in: 'query', name: 'code', schema: { type: 'string' } }, { in: 'query', name: 'state', schema: { type: 'string' } }, { in: 'query', name: 'error', schema: { type: 'string' } }], responses: { '302': { description: 'Redirect to <app>/auth/callback#access_token=…&id_token=…&expires_in=… (or #error=…)' } } } },
  '/auth/oidc/logout': { get: { tags: ['IAM'], security: [], summary: 'Sign out — ends the identity-server session and returns to the app', parameters: [{ in: 'query', name: 'id_token_hint', schema: { type: 'string' } }], responses: { '302': { description: 'Redirect to the identity server’s end-session endpoint, or the app when it has none' } } } },
  '/auth/register': { post: { tags: ['IAM'], security: [], summary: 'Self-register (AUTH_REGISTRATION + local login). Default method temp_password: no password is collected — a temporary password is emailed and the account is created when it is used to sign in (always 202, whether or not the address is new). Method password: the caller chooses a password (201)', requestBody: jsonBody({ type: 'object', properties: { email: { type: 'string' }, password: { type: 'string' }, name: { type: 'string' } } }), responses: { '201': { description: 'Created (method password); verificationRequired tells the UI whether to ask the user to confirm their email' }, '202': { description: 'Temporary password emailed (method temp_password)' }, '404': { description: 'Registration is disabled', content: { 'application/json': { schema: ref('Error') } } }, '409': { description: 'Email already registered', content: { 'application/json': { schema: ref('Error') } } }, '422': { description: 'Invalid email or weak password', content: { 'application/json': { schema: ref('Error') } } } } } },
  '/auth/set-password': { post: { tags: ['IAM'], security: [], summary: 'Temp-password onboarding step 2: replace the emailed temporary password with your own (needs the short-lived setupToken returned by sign-in); returns the first session', requestBody: jsonBody({ type: 'object', properties: { setupToken: { type: 'string' }, password: { type: 'string' } } }), responses: { ...ok({ type: 'object', properties: { token: { type: 'string' }, user: ref('User') } }), '401': { description: 'Setup step expired — sign in again', content: { 'application/json': { schema: ref('Error') } } }, '422': { description: 'Weak password, or same as the temporary one', content: { 'application/json': { schema: ref('Error') } } } } } },
  '/auth/otp/request': { post: { tags: ['IAM'], security: [], summary: 'Email a 6-digit sign-in code (AUTH_OTP_LOGIN; always 202, never reveals whether the address exists)', requestBody: jsonBody({ type: 'object', properties: { email: { type: 'string' } } }), responses: { '202': { description: 'Accepted' }, '404': { description: 'OTP sign-in is disabled', content: { 'application/json': { schema: ref('Error') } } } } } },
  '/auth/otp/verify': { post: { tags: ['IAM'], security: [], summary: 'Sign in with the emailed code (10 min, 5 attempts, single use)', requestBody: jsonBody({ type: 'object', properties: { email: { type: 'string' }, code: { type: 'string' } } }), responses: { ...ok({ type: 'object', properties: { token: { type: 'string' }, user: ref('User') } }), '401': { description: 'Invalid or expired code', content: { 'application/json': { schema: ref('Error') } } } } } },
  '/auth/verify-email': { post: { tags: ['IAM'], security: [], summary: 'Confirm an email address with the emailed single-use token', requestBody: jsonBody({ type: 'object', properties: { token: { type: 'string' } } }), responses: { '204': { description: 'Verified' }, '404': { description: 'Unknown or expired link', content: { 'application/json': { schema: ref('Error') } } } } } },
  '/auth/resend-verification': { post: { tags: ['IAM'], security: [], summary: 'Re-send the verification email (always 202 — never reveals whether the address exists)', requestBody: jsonBody({ type: 'object', properties: { email: { type: 'string' } } }), responses: { '202': { description: 'Accepted' } } } },
  '/auth/forgot-password': { post: { tags: ['IAM'], security: [], summary: 'Request a password-reset email (always 202 — never reveals whether the address exists)', requestBody: jsonBody({ type: 'object', properties: { email: { type: 'string' } } }), responses: { '202': { description: 'Accepted' }, '404': { description: 'Disabled', content: { 'application/json': { schema: ref('Error') } } } } } },
  '/auth/reset-password/check': { post: { tags: ['IAM'], security: [], summary: 'Is this reset link still valid?', requestBody: jsonBody({ type: 'object', properties: { token: { type: 'string' } } }), responses: ok({ type: 'object', properties: { valid: { type: 'boolean' } } }) } },
  '/auth/reset-password': { post: { tags: ['IAM'], security: [], summary: 'Set a new password with the emailed single-use token (1 h, one use); also unlocks the account', requestBody: jsonBody({ type: 'object', properties: { token: { type: 'string' }, password: { type: 'string' } } }), responses: { '204': { description: 'Password changed; existing sessions are revoked' }, '404': { description: 'Unknown or expired link', content: { 'application/json': { schema: ref('Error') } } }, '422': { description: 'Weak or reused password', content: { 'application/json': { schema: ref('Error') } } } } } },
  '/auth/me': { get: { tags: ['IAM'], summary: 'The caller’s own identity + resolved permissions (from their current roles)', responses: ok({ type: 'object', properties: { user: { type: 'object', properties: { id: { type: 'string' }, username: { type: 'string' }, roles: { type: 'array', items: { type: 'string' } }, groups: { type: 'array', items: { type: 'string' } } } }, permissions: { type: 'array', items: { type: 'string' } } } }) } },
  '/auth/me/password': { post: { tags: ['IAM'], summary: 'Change your own password (requires the current one)', requestBody: jsonBody({ type: 'object', properties: { currentPassword: { type: 'string' }, newPassword: { type: 'string' } } }), responses: { '204': { description: 'Changed' }, '403': { description: 'Current password incorrect', content: { 'application/json': { schema: ref('Error') } } } } } },
  '/users': {
    get: { tags: ['IAM'], summary: 'List users (admin)', responses: ok(listOf('User')) },
    post: { tags: ['IAM'], summary: 'Create a user (admin)', requestBody: jsonBody({ type: 'object', properties: { username: { type: 'string' }, password: { type: 'string' }, roles: { type: 'array', items: { type: 'string' } }, groups: { type: 'array', items: { type: 'string' } } } }), responses: created(ref('User')) },
  },
  '/users/{id}': {
    get: { tags: ['IAM'], summary: 'Get a user (admin)', parameters: [idParam()], responses: ok(ref('User')) },
    patch: { tags: ['IAM'], summary: 'Update a user’s roles/groups/active flag (admin)', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { roles: { type: 'array', items: { type: 'string' } }, groups: { type: 'array', items: { type: 'string' } }, active: { type: 'boolean' } } }), responses: ok(ref('User')) },
  },
  '/users/{id}/password': { post: { tags: ['IAM'], summary: 'Set a user’s password (admin)', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { password: { type: 'string' } } }), responses: { '204': { description: 'Changed' } } } },
  '/api-keys': {
    get: { tags: ['API keys'], summary: 'List the workspace’s API keys (never the secret): name, prefix, permissions, expiry, last use, revoked (admin)', responses: { '200': { description: '{ items: ApiKey[] }' } } },
    post: { tags: ['API keys'], summary: 'Create an API key. The response carries the key ONCE (key); keep it. Permissions must be ones you hold yourself and can never include admin rights (admin)', requestBody: jsonBody({ type: 'object', required: ['name', 'permissions'], properties: { name: { type: 'string', description: 'what uses the key' }, permissions: { type: 'array', items: { type: 'string' }, example: ['workflow:run', 'workflow:view', 'task:manage'] }, expiresInDays: { type: 'integer', description: '1–3650; omit for a key that does not expire' }, expiresAt: { type: 'string', description: 'ISO date-time, instead of expiresInDays' } } }), responses: { '201': { description: '{ id, name, prefix, permissions, createdAt, expiresAt?, key: "ork_<id>.<secret>" }' } } },
  },
  '/api-keys/{id}': { delete: { tags: ['API keys'], summary: 'Revoke a key: it stops working at once (the record stays for audit) (admin)', parameters: [idParam()], responses: { '204': { description: 'Revoked' } } } },
  '/me/availability': {
    get: { tags: ['Task assignment'], summary: 'Whether I am available for automatic task assignment (and until when I am away)', responses: { '200': { description: '{ available, awayUntil?, managed }' } } },
    put: { tags: ['Task assignment'], summary: 'Mark myself away (optionally until a time) or back. Away: no new automatic assignments, and tasks I have not started return to the pool (keepTasks keeps them)', requestBody: jsonBody({ type: 'object', properties: { available: { type: 'boolean' }, awayUntil: { type: 'string' }, keepTasks: { type: 'boolean' } } }), responses: { '200': { description: '{ available, awayUntil?, released }' } } },
  },
  '/allocation/rules': {
    get: { tags: ['Task assignment'], summary: 'List automatic-assignment rules (most specific first)', responses: { '200': { description: '{ items: AssignmentRule[] }' } } },
    post: { tags: ['Task assignment'], summary: 'Create a rule: scope (project / task node / group), strategy roundRobin | leastLoaded | skills, required skills, optional pool, respectLimits (admin)', requestBody: jsonBody({ type: 'object', properties: { name: { type: 'string' }, enabled: { type: 'boolean' }, priority: { type: 'number' }, strategy: { type: 'string' }, requiredSkills: { type: 'array', items: { type: 'string' } }, respectLimits: { type: 'boolean' }, scope: { type: 'object', properties: { workflowId: { type: 'string' }, nodeId: { type: 'string' }, group: { type: 'string' } } }, pool: { type: 'object', properties: { groups: { type: 'array', items: { type: 'string' } }, users: { type: 'array', items: { type: 'string' } } } } } }), responses: { '201': { description: 'Created' } } },
  },
  '/allocation/rules/{id}': {
    put: { tags: ['Task assignment'], summary: 'Change a rule (admin)', parameters: [idParam()], requestBody: jsonBody({ type: 'object' }), responses: { '200': { description: 'Updated' } } },
    delete: { tags: ['Task assignment'], summary: 'Delete a rule (admin)', parameters: [idParam()], responses: { '204': { description: 'Deleted' } } },
  },
  '/allocation/tracker': { get: { tags: ['Task assignment'], summary: 'Per person: open, in progress, assigned today, completed today, limits, away; plus how many tasks wait for a person (pending / queued)', responses: { '200': { description: '{ people, waiting, rules }' } } } },
  '/allocation/run': { post: { tags: ['Task assignment'], summary: 'Run one allocation pass now (the allocator runner does this on its own loop) (admin)', responses: { '200': { description: '{ assigned, queued }' } } } },
  '/groups': {
    get: { tags: ['IAM'], summary: 'List groups (admin)', responses: ok(listOf('Group')) },
    post: { tags: ['IAM'], summary: 'Create a group (admin)', requestBody: jsonBody({ type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' } } }), responses: created(ref('Group')) },
  },
  '/groups/{id}': {
    patch: { tags: ['IAM'], summary: 'Rename / re-describe a group; a rename carries every member along (admin)', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' } } }), responses: ok(ref('Group')) },
    delete: { tags: ['IAM'], summary: 'Delete a group and detach it from its members (admin)', parameters: [idParam()], responses: { '204': { description: 'Deleted' } } },
  },
  '/groups/{id}/members': { put: { tags: ['IAM'], summary: 'Replace a group’s membership with exactly these users (admin)', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { userIds: { type: 'array', items: { type: 'string' } } } }), responses: { '200': { description: 'Updated' } } } },
  '/roles': {
    get: { tags: ['IAM'], summary: 'List roles (admin)', responses: ok(listOf('Role')) },
    post: { tags: ['IAM'], summary: 'Create a role (admin)', requestBody: jsonBody({ type: 'object', properties: { name: { type: 'string' }, permissions: { type: 'array', items: { type: 'string' } } } }), responses: created(ref('Role')) },
  },
  '/roles/permissions': { get: { tags: ['IAM'], summary: 'The permission strings roles may carry, grouped for display (admin)', responses: { '200': { description: 'Permission catalogue' } } } },
  '/roles/{id}': {
    patch: { tags: ['IAM'], summary: 'Replace a role’s permissions (admin; the built-in "admin" role is immutable)', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { permissions: { type: 'array', items: { type: 'string' } } } }), responses: ok(ref('Role')) },
    delete: { tags: ['IAM'], summary: 'Delete a custom role (409 while assigned), or reset a customised built-in role to its defaults (200 { reset: true }); "admin" cannot be deleted (admin)', parameters: [idParam()], responses: { '204': { description: 'Deleted' }, '200': { description: 'Built-in role reset to defaults' } } },
  },

  // ---- Workflow Definitions (Case Definitions) ----
  '/workflow-definitions': {
    get: { tags: ['Workflow Definitions'], summary: 'List registered workflow definitions', responses: ok(listOf('WorkflowDefinition')) },
    post: { tags: ['Workflow Definitions'], summary: 'Register a workflow definition mapping (admin)', requestBody: jsonBody({ type: 'object', properties: { name: { type: 'string', example: 'System Claim Assessment' }, workflowId: { type: 'string', example: 'wf_pru_claims' }, deploymentId: { type: 'string', example: 'dep_prod_v1' }, schema: { type: 'object' } } }), responses: created(ref('WorkflowDefinition')) },
  },
  '/workflow-definitions/{id}': {
    get: { tags: ['Workflow Definitions'], summary: 'Get a workflow definition by id', parameters: [idParam()], responses: ok(ref('WorkflowDefinition')) },
    patch: { tags: ['Workflow Definitions'], summary: 'Update a workflow definition (admin)', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { name: { type: 'string' }, deploymentId: { type: 'string' }, active: { type: 'boolean' }, schema: { type: 'object' } } }), responses: ok(ref('WorkflowDefinition')) },
  },

  // ---- Workflow Instances (Cases) ----
  '/workflow-instances': {
    get: { tags: ['Workflow Instances'], summary: 'List business workflow instances (cases)', parameters: [q('definitionId', 'Filter by workflow definition ID'), q('status', 'initiated|active|completed|aborted|failed'), q('correlationKey', 'Business key / policy number'), q('limit', 'Max results (default 50)'), q('offset', 'Pagination offset')], responses: ok(listOf('WorkflowInstance')) },
    post: { tags: ['Workflow Instances'], summary: 'Start a new business workflow instance (Case)', requestBody: jsonBody({ type: 'object', properties: { definitionId: { type: 'string', example: 'def_claims_assessment' }, workflowData: { type: 'object', example: { claimId: 'CLM-99214', claimAmount: 50000, claimantName: 'John Doe', policyNumber: 'POL-3321' } }, correlationKey: { type: 'string', example: 'POL-3321-CLM-99214' } } }), responses: created(ref('WorkflowInstance')) },
  },
  '/workflow-instances/search': {
    post: { tags: ['Workflow Instances'], summary: 'Advanced search across cases, status, and payload data', requestBody: jsonBody({ type: 'object', properties: { definitionId: { type: 'string' }, status: { type: 'string' }, dataFilter: { type: 'object' }, limit: { type: 'integer' } } }), responses: ok(listOf('WorkflowInstance')) },
  },
  '/workflow-instances/signal/{signalName}': {
    post: {
      tags: ['Workflow Instances'],
      summary: 'Broadcast signal across workflow cases',
      parameters: [idParam('signalName', 'Signal name')],
      requestBody: jsonBody({ type: 'object', properties: { payload: { type: 'object' } } }, false),
      responses: ok({ type: 'object', properties: { signaled: { type: 'integer' } } }),
    },
  },
  '/workflow-instances/{id}': {
    get: { tags: ['Workflow Instances'], summary: 'Get aggregated case details with tasks, history, and variables', parameters: [idParam()], responses: ok(ref('WorkflowInstance')) },
  },
  '/workflow-instances/{id}/close': {
    post: {
      tags: ['Workflow Instances'],
      summary: 'Close a case (transition to closed status with resolution)',
      parameters: [idParam()],
      requestBody: jsonBody({ type: 'object', properties: { resolution: { type: 'string', example: 'Settled and closed' } } }, false),
      responses: ok(ref('WorkflowInstance')),
    },
  },
  '/workflow-instances/{id}/reopen': {
    post: {
      tags: ['Workflow Instances'],
      summary: 'Reopen a closed case',
      parameters: [idParam()],
      requestBody: jsonBody({ type: 'object', properties: { reason: { type: 'string', example: 'Additional documentation provided' } } }, false),
      responses: ok(ref('WorkflowInstance')),
    },
  },
  '/workflow-instances/{id}/status': {
    patch: { tags: ['Workflow Instances'], summary: 'Update workflow instance case status', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { status: { type: 'string', enum: ['initiated', 'active', 'completed', 'aborted', 'failed'] } } }), responses: ok(ref('WorkflowInstance')) },
  },
  '/workflow-instances/{id}/data': {
    get: { tags: ['Workflow Instances'], summary: 'Get case business data dictionary', parameters: [idParam()], responses: ok({ type: 'object' }) },
    put: { tags: ['Workflow Instances'], summary: 'Update case business data payload', parameters: [idParam()], requestBody: jsonBody({ type: 'object', additionalProperties: {} }), responses: ok(ref('WorkflowInstance')) },
  },
  '/workflow-instances/{id}/data/{key}': {
    delete: { tags: ['Workflow Instances'], summary: 'Delete a key from case business data', parameters: [idParam(), idParam('key', 'Data attribute key')], responses: ok(ref('WorkflowInstance')) },
  },
  '/workflow-instances/{id}/roles': {
    get: { tags: ['Workflow Instances'], summary: 'Get assigned case roles', parameters: [idParam()], responses: ok({ type: 'object', properties: { roles: { type: 'object' } } }) },
  },
  '/workflow-instances/{id}/roles/{roleName}': {
    put: { tags: ['Workflow Instances'], summary: 'Assign users or groups to a case role', parameters: [idParam(), idParam('roleName', 'Role name (e.g. examiner, approver)')], requestBody: jsonBody({ type: 'object', properties: { members: { type: 'array', items: { type: 'string' } } } }), responses: ok({ type: 'object', properties: { roles: { type: 'object' } } }) },
    delete: { tags: ['Workflow Instances'], summary: 'Remove a case role assignment', parameters: [idParam(), idParam('roleName', 'Role name')], responses: ok({ type: 'object', properties: { roles: { type: 'object' } } }) },
  },
  '/workflow-instances/{id}/milestones': {
    get: { tags: ['Workflow Instances'], summary: 'List achieved case milestones', parameters: [idParam()], responses: ok({ type: 'object', properties: { milestones: { type: 'array', items: ref('Milestone') } } }) },
    post: { tags: ['Workflow Instances'], summary: 'Achieve or record a case milestone', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { name: { type: 'string', example: 'PAS_VALIDATED' } } }), responses: created({ type: 'object', properties: { milestones: { type: 'array', items: ref('Milestone') } } }) },
  },
  '/workflow-instances/{id}/flags': {
    get: {
      tags: ['Workflow Instances'],
      summary: 'List active and cleared flags for case (caseLevel, policyLevel, beneficiaryLevel)',
      parameters: [idParam()],
      responses: ok({
        type: 'object',
        properties: {
          caseLevel: { type: 'array', items: ref('CaseFlag') },
          policyLevel: { type: 'array', items: ref('CaseFlag') },
          beneficiaryLevel: { type: 'array', items: ref('CaseFlag') },
        },
      }),
    },
    post: {
      tags: ['Workflow Instances'],
      summary: 'Add compliance or operational flag to case',
      parameters: [idParam()],
      requestBody: jsonBody({
        type: 'object',
        required: ['flagType'],
        properties: {
          flagType: { type: 'string', example: 'FRAUD_SUSPICION' },
          level: { type: 'string', enum: ['caseLevel', 'policyLevel', 'beneficiaryLevel'], example: 'caseLevel' },
          reason: { type: 'string', example: 'Claim amount exceeds normal threshold' },
          flagValue: {},
        },
      }),
      responses: created(ref('CaseFlag')),
    },
  },
  '/workflow-instances/{id}/flags/{flagId}': {
    delete: {
      tags: ['Workflow Instances'],
      summary: 'Clear or delete a flag from case',
      parameters: [idParam(), idParam('flagId', 'Flag identifier or flagType')],
      responses: { '204': { description: 'Flag cleared' } },
    },
  },
  '/workflow-instances/{id}/documents': {
    get: {
      tags: ['Workflow Instances'],
      summary: 'List supporting documents registered for case',
      parameters: [idParam()],
      responses: ok({
        type: 'object',
        properties: {
          documents: { type: 'array', items: ref('CaseDocument') },
        },
      }),
    },
    post: {
      tags: ['Workflow Instances'],
      summary: 'Attach supporting document reference to case',
      parameters: [idParam()],
      requestBody: jsonBody({
        type: 'object',
        required: ['document_name'],
        properties: {
          document_name: { type: 'string', example: 'death_cert.pdf' },
          document_type: { type: 'string', example: 'DEATH_CERTIFICATE' },
          s3_key: { type: 'string', example: 'claims/2026/04/cert.pdf' },
          required: { type: 'boolean', example: true },
          status: { type: 'string', example: 'UPLOADED' },
          type: { type: 'string', example: 'USER_UPLOADED' },
        },
      }),
      responses: created(ref('CaseDocument')),
    },
  },
  '/workflow-instances/{id}/documents/{docId}': {
    delete: {
      tags: ['Workflow Instances'],
      summary: 'Remove document reference from case',
      parameters: [idParam(), idParam('docId', 'Document identifier or document_name')],
      responses: { '204': { description: 'Document removed' } },
    },
  },
  '/workflow-instances/{id}/dynamic-tasks': {
    post: {
      tags: ['Workflow Instances'],
      summary: 'Create dynamic ad-hoc human task in running case',
      parameters: [idParam()],
      requestBody: jsonBody({
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', example: 'Special Investigation Unit Review' },
          assignee: { type: 'string', example: 'examiner1' },
          group: { type: 'string', example: 'fraud_investigators' },
          priority: { type: 'integer', example: 9 },
          dueAt: { type: 'string', format: 'date-time' },
          inputs: { type: 'object' },
        },
      }),
      responses: created(ref('Task')),
    },
  },
  '/workflow-instances/{id}/signal': {
    post: { tags: ['Workflow Instances'], summary: 'Deliver business signal to workflow instance', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { name: { type: 'string', example: 'DOCUMENTS_RECEIVED' }, payload: { type: 'object', example: { docCount: 3, verified: true } } } }), responses: ok(ref('WorkflowInstance')) },
  },
  '/workflow-instances/{id}/tasks/{taskId}/decision': {
    post: { tags: ['Workflow Instances'], summary: 'Submit case task decision outputs (claim approval/rejection)', parameters: [idParam(), idParam('taskId', 'Human task id')], requestBody: jsonBody({ type: 'object', properties: { outputs: { type: 'object', example: { approved: true, payoutAmount: 50000, remarks: 'Verified policy coverage' } } } }), responses: ok(ref('WorkflowInstance')) },
  },
  '/workflow-instances/{id}/delegate': {
    post: { tags: ['Workflow Instances'], summary: 'Delegate case or task to another user', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { to: { type: 'string', example: 'senior_assessor' }, taskId: { type: 'string' } } }), responses: ok(ref('WorkflowInstance')) },
  },
  '/workflow-instances/{id}/tasks': {
    get: { tags: ['Workflow Instances'], summary: 'List tasks linked to this workflow instance', parameters: [idParam()], responses: ok(listOf('Task')) },
  },
  '/workflow-instances/{id}/signals': {
    get: { tags: ['Workflow Instances'], summary: 'List expected signals for this workflow instance', parameters: [idParam()], responses: ok({ type: 'array', items: { type: 'string' } }) },
  },
  '/workflow-instances/{id}/comments': {
    get: { tags: ['Workflow Instances'], summary: 'List case notes and comments', parameters: [idParam()], responses: ok(listOf('WorkflowComment')) },
    post: { tags: ['Workflow Instances'], summary: 'Add a case note or comment', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { body: { type: 'string', example: 'Reviewed medical examination and verified beneficiary status.' } } }), responses: created(ref('WorkflowComment')) },
  },
  '/workflow-instances/{id}/comments/{commentId}': {
    delete: { tags: ['Workflow Instances'], summary: 'Delete a case comment', parameters: [idParam(), idParam('commentId', 'Comment id')], responses: { '204': { description: 'Deleted' } } },
  },
  '/workflow-instances/{id}/audits': {
    get: { tags: ['Workflow Instances'], summary: 'List case audit history', parameters: [idParam()], responses: ok(listOf('WorkflowAudit')) },
    post: { tags: ['Workflow Instances'], summary: 'Record manual case audit note or event', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { kind: { type: 'string', example: 'workflowInstance.manual_review' }, data: { type: 'object' } } }), responses: created(ref('WorkflowAudit')) },
  },
  '/workflow-instances/{id}/audits/{auditId}': {
    delete: { tags: ['Workflow Instances'], summary: 'Delete an audit record (admin)', parameters: [idParam(), idParam('auditId', 'Audit entry id')], responses: { '204': { description: 'Deleted' } } },
  },

  // ---- Workflow Analytics ----
  '/workflow-analytics/summary': {
    get: { tags: ['Workflow Analytics'], summary: 'Get overall workflow execution metrics', parameters: [q('from', 'ISO start date'), q('to', 'ISO end date')], responses: ok(ref('Summary')) },
  },
  '/workflow-analytics/tat': {
    get: { tags: ['Workflow Analytics'], summary: 'Turnaround time (TAT) metrics across processes and human tasks', parameters: [q('from', 'ISO start date'), q('to', 'ISO end date'), q('definitionId', 'Filter by workflow definition')], responses: ok(ref('TATReport')) },
  },
  '/workflow-instances/{id}/tasks/{taskId}/ownership-timeline': {
    get: { tags: ['Workflow Analytics'], summary: 'Task claim/delegate ownership duration timeline', parameters: [idParam(), idParam('taskId', 'Task id')], responses: ok({ type: 'array', items: { type: 'object' } }) },
  },
  '/analytics/tasks-and-processes/{piid}': {
    get: { tags: ['Workflow Analytics'], summary: 'Linked process instance tasks and timeline by process instance id', parameters: [idParam('piid', 'Process instance ID (PIID)')], responses: ok({ type: 'object' }) },
  },

  // ---- Ad-Hoc Query Engine ----
  '/analytics/query/run': {
    post: { tags: ['Ad-Hoc Query Engine'], summary: 'Execute ad-hoc query with tenant isolation and projection', requestBody: jsonBody({ type: 'object', properties: { collection: { type: 'string', example: 'instances' }, filter: { type: 'object', example: { status: 'waiting' } }, select: { type: 'array', items: { type: 'string' } }, limit: { type: 'integer', example: 50 } } }), responses: ok({ type: 'object', properties: { items: { type: 'array', items: {} }, count: { type: 'integer' } } }) },
  },
  '/analytics/queries': {
    get: { tags: ['Ad-Hoc Query Engine'], summary: 'List saved queries for the caller', responses: ok(listOf('SavedQuery')) },
    post: { tags: ['Ad-Hoc Query Engine'], summary: 'Save a reusable query', requestBody: jsonBody({ type: 'object', properties: { name: { type: 'string', example: 'High-Value Claims' }, query: { type: 'object' } } }), responses: created(ref('SavedQuery')) },
  },
  '/analytics/queries/{id}/run': {
    post: { tags: ['Ad-Hoc Query Engine'], summary: 'Run a saved query by id', parameters: [idParam()], responses: ok({ type: 'object' }) },
  },
  '/analytics/queries/{id}': {
    delete: { tags: ['Ad-Hoc Query Engine'], summary: 'Delete a saved query', parameters: [idParam()], responses: { '204': { description: 'Deleted' } } },
  },

  // ---- Case Service (Consolidated Claim Case APIs) ----
  '/caseservice/case': {
    post: {
      tags: ['Case Service'],
      summary: 'Initialize a new consolidated claim case',
      description: 'Creates a claim case in DRAFT status following the Claim Case schema specification.',
      requestBody: jsonBody(ref('CaseObject')),
      responses: created({ type: 'object', properties: { caseId: { type: 'string' }, policyNumber: { type: 'string' }, claimType: { type: 'string' }, caseStatus: { type: 'string' }, createdAt: { type: 'string' }, updatedAt: { type: 'string' } } }),
    },
  },
  '/caseservice/case/{caseId}': {
    get: {
      tags: ['Case Service'],
      summary: 'Retrieve complete consolidated claim case object',
      description: 'Returns the full Claim Case including claimant, policyDetails, beneficiaries, documents, taxWithholdings, and flags.',
      parameters: [idParam('caseId', 'Case Object UUID')],
      responses: ok(ref('CaseObject')),
    },
    put: {
      tags: ['Case Service'],
      summary: 'Update or patch claim case attributes',
      parameters: [idParam('caseId', 'Case Object UUID')],
      requestBody: jsonBody({ type: 'object' }),
      responses: ok({ type: 'object', properties: { caseId: { type: 'string' }, caseStatus: { type: 'string' }, updatedAt: { type: 'string' } } }),
    },
    delete: {
      tags: ['Case Service'],
      summary: 'Archive or soft-delete claim case',
      parameters: [idParam('caseId', 'Case Object UUID')],
      responses: { '204': { description: 'Deleted' } },
    },
  },
  '/caseservice/case/{caseId}/flags': {
    get: {
      tags: ['Case Service'],
      summary: 'List flags on claim case (caseLevel, policyLevel, beneficiaryLevel)',
      parameters: [idParam('caseId', 'Case Object UUID')],
      responses: ok({
        type: 'object',
        properties: {
          caseLevel: { type: 'array', items: ref('CaseFlag') },
          policyLevel: { type: 'array', items: ref('CaseFlag') },
          beneficiaryLevel: { type: 'array', items: ref('CaseFlag') },
        },
      }),
    },
    post: {
      tags: ['Case Service'],
      summary: 'Raise a compliance or evaluation flag on claim case',
      parameters: [idParam('caseId', 'Case Object UUID')],
      requestBody: jsonBody({
        type: 'object',
        required: ['flagType'],
        properties: {
          flagType: { type: 'string', example: 'MANUAL_PAYOUT_OVERRIDE' },
          level: { type: 'string', enum: ['caseLevel', 'policyLevel', 'beneficiaryLevel'], example: 'caseLevel' },
          reason: { type: 'string', example: 'Beneficiary split adjustment requires compliance review' },
          flagValue: {},
        },
      }),
      responses: created(ref('CaseFlag')),
    },
  },
  '/caseservice/case/{caseId}/flags/{flagId}': {
    delete: {
      tags: ['Case Service'],
      summary: 'Clear or resolve a compliance flag from claim case',
      parameters: [idParam('caseId', 'Case Object UUID'), idParam('flagId', 'Flag identifier or flagType')],
      responses: { '204': { description: 'Flag resolved' } },
    },
  },
  '/caseservice/case/{caseId}/documents': {
    get: {
      tags: ['Case Service'],
      summary: 'List registered documents on claim case',
      parameters: [idParam('caseId', 'Case Object UUID')],
      responses: ok({
        type: 'object',
        properties: {
          documents: { type: 'array', items: ref('CaseDocument') },
        },
      }),
    },
    post: {
      tags: ['Case Service'],
      summary: 'Attach document to claim case',
      parameters: [idParam('caseId', 'Case Object UUID')],
      requestBody: jsonBody({
        type: 'object',
        required: ['document_name'],
        properties: {
          document_name: { type: 'string', example: 'certified_death_certificate.pdf' },
          document_type: { type: 'string', example: 'DEATH_CERTIFICATE' },
          s3_key: { type: 'string', example: 'claims/2026/04/doc_01.pdf' },
          required: { type: 'boolean', example: true },
          status: { type: 'string', example: 'UPLOADED' },
          type: { type: 'string', example: 'USER_UPLOADED' },
        },
      }),
      responses: created(ref('CaseDocument')),
    },
  },
  '/caseservice/case/{caseId}/documents/{docId}': {
    delete: {
      tags: ['Case Service'],
      summary: 'Remove document from claim case',
      parameters: [idParam('caseId', 'Case Object UUID'), idParam('docId', 'Document identifier or document_name')],
      responses: { '204': { description: 'Document deleted' } },
    },
  },
  '/caseservice/list': {
    get: {
      tags: ['Case Service'],
      summary: 'List claim cases with filters',
      parameters: [q('caseStatus', 'Filter by case status (DRAFT, PENDING_DEATH, UNDER_REVIEW, etc.)'), q('claimType', 'Filter by claim type (DEATH, TI)'), q('policyNumber', 'Filter by policy number')],
      responses: ok({ type: 'array', items: ref('CaseObject') }),
    },
  },
};

export const openapiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'BPM & Case Workflow Engine — Integration API',
    version: '1.0.0',
    description: `## BPM & Case Workflow Engine

Welcome to the **BPM REST & Event Integration API**. This specification covers both developer intake integration and engine management.

### 1. Authentication & API Token Generation
All endpoints (except \`POST /api/auth/login\` and \`GET /api/crypto/public-key\`) require a valid JWT Bearer token:
1. **Acquire Token**: Sign in through single sign-on (\`GET /api/auth/oidc/login\`), or — where local login is enabled — send your credentials to \`POST /api/auth/login\`:
   \`\`\`json
   POST /api/auth/login
   {
     "username": "admin",
     "password": "your-password"
   }
   \`\`\`
2. **Authorize Requests**: Attach the returned token in the HTTP Authorization header:
   \`Authorization: Bearer <token>\`
3. **Pick the workspace**: send \`x-tenant-id: <workspace id>\` on every request (membership is enforced; a missing header means the default workspace).
4. **Browser Direct Access**: When viewing API documentation in a browser, pass \`?token=<token>\` in the URL.

#### Authenticating with an API key instead
For integrations that should not sign in as a person, create an **API key** (Admin → API keys, or \`POST /api/api-keys\`) and send it on every request:

\`X-API-Key: ork_<id>.<secret>\` (or \`Authorization: ApiKey <key>\`, or \`Authorization: Bearer <key>\`)

- A key belongs to **one workspace** (no \`x-tenant-id\` needed; naming another workspace is refused) and carries an explicit list of **permissions**, a subset of what its creator may do. It can never manage users, roles, keys or the workspace.
- The secret is shown **once**, when the key is created; only a hash is stored. Keys can expire and can be revoked at once.
- API keys are accepted wherever an access token is, except the endpoints that are about a signed-in person (profile, own availability).

### 2. Ephemeral In-Transit Cryptography
For high-security environments, credentials and sensitive claims variables can be encrypted before transmission using the ephemeral RSA-OAEP public key retrieved from \`GET /api/crypto/public-key\`.

### 3. Core Integration Workflows
- **Intake & Starting Workflows**: \`POST /api/instances\`, \`POST /api/workflow-instances\`, or \`POST /api/caseservice/case\`
- **Inspecting Running Instances**: \`GET /api/instances/{id}\`, \`GET /api/workflow-instances/{id}\`, or \`GET /api/caseservice/case/{caseId}\`
- **Human Task Workbench**: Query inboxes at \`GET /api/tasks\`, claim via \`POST /api/tasks/{id}/claim\`, complete with outputs via \`POST /api/tasks/{id}/complete\`, or reject/fail via \`POST /api/tasks/{id}/fail\`
- **Event Callbacks & Signals**: Deliver targeted signals via \`POST /api/instances/{id}/signal\` or broadcast signals across all instances via \`POST /api/signals/{signalName}\`
- **Case Roles & Milestones**: Manage case role assignments via \`PUT /api/workflow-instances/{id}/roles/{roleName}\` and track milestones via \`GET /api/workflow-instances/{id}/milestones\`
- **SLA & Workload Analytics**: Query SLA breaches and workload distribution via \`GET /api/query/analytics/sla-violations\` and \`GET /api/query/analytics/workload\`
- **Operational Failures & Recovery**: Monitor incidents at \`GET /api/errors\` and re-trigger execution via \`POST /api/instances/{id}/retry\`

### 4. Realtime Event Streaming (WebSockets)
Connect via WebSocket to \`ws://<host>/api/ws?token=<token>\`. Once connected, subscribe to instance topics:
\`\`\`json
{ "op": "sub", "topics": ["instance:<instanceId>"] }
\`\`\`
`,
  },
  servers: [{ url: '/api', description: 'This server' }],
  tags: [
    { name: 'IAM', description: 'Authentication, Token Issuance, Users, Roles & Permissions' },
    { name: 'Signals', description: 'Broadcast and targeted event signals resuming waiting tokens' },
    { name: 'Case Service', description: 'Consolidated Claim Case CRUD APIs matching enterprise claim schema' },
    { name: 'Workflow Instances', description: 'Business Case Management, Intake, Decisions, Roles & Milestones' },
    { name: 'Human Tasks', description: 'Task Inbox, Claim, Complete, Fail, Delegate & SLA Tracking' },
    { name: 'Instances', description: 'Process Instance Lifecycle, State Inspection & Signal Resumption' },
    { name: 'Workflow Definitions', description: 'Stable Definition to Deployment Bindings' },
    { name: 'Workflow Analytics', description: 'Turnaround Time (TAT) Metrics & Process Analytics' },
    { name: 'Query & Analytics', description: 'jBPM-Style Query Catalog, Inboxes, SLA Violations & Workload' },
    { name: 'Ad-Hoc Query Engine', description: 'Multi-Tenant Data Projection & Saved Queries' },
    { name: 'Projects', description: 'Workflow Projects, Folders & Scoped Permissions' },
    { name: 'Processes', description: 'Process Graph Modeling & Definition Storage' },
    { name: 'Assets', description: 'DMN Decision Tables, DRL Rulesets, Forms & Scorecards' },
    { name: 'Deployments', description: 'Environment Deployments, Rollbacks & Snapshots' },
    { name: 'Versioning', description: 'Drafts, Published Versions & Semantic Diffs' },
    { name: 'Authoring', description: 'BPMN Diagram Graph Validation & Diagnostics' },
    { name: 'Execution Errors', description: 'Operational Incident Queue & Error Retries' },
    { name: 'Jobs & Timers', description: 'Durable Asynchronous Timers & Scheduling' },
    { name: 'Catalog', description: 'Node Specifications, Property Schemas & Ports' },
    { name: 'Governance', description: 'Audit Forensics & Enterprise System Settings' },
    { name: 'API keys', description: 'Workspace API keys: credentials for server-to-server calls, used next to access tokens' },
    { name: 'Notifications', description: 'In-App Operational Alerts & Reminders' },
    { name: 'Import/Export', description: 'jBPM KJAR Archives & Portable Engine JSON Packages' },
  ],
  components: {
    schemas,
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'An access token from sign-in (single sign-on or POST /api/auth/login). It acts as the signed-in person.' },
      apiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key', description: 'A workspace API key (ork_…) for server-to-server calls. It acts with exactly the permissions chosen when the key was created, inside that one workspace. The same key also works as `Authorization: ApiKey <key>` or `Authorization: Bearer <key>`.' },
    },
  },
  // either credential is accepted on every endpoint that asks for authentication
  security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
  paths,
};

/** Self-contained Swagger UI page with session token persistence and request interceptor. */
export const swaggerHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Workflow Engine — Developer Integration API</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css" />
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #fafafa; }
    .topbar { display: none; }
    .auth-banner {
      background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
      color: #ffffff;
      padding: 16px 28px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      box-shadow: 0 4px 14px rgba(79, 70, 229, 0.25);
    }
    .auth-banner h1 { margin: 0; font-size: 16px; font-weight: 700; letter-spacing: -0.01em; }
    .auth-banner p { margin: 4px 0 0; font-size: 12.5px; opacity: 0.92; }
    .auth-badge {
      background: rgba(255, 255, 255, 0.22);
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      backdrop-filter: blur(4px);
    }
    .swagger-ui .info { margin: 25px 0 20px 0; }
    .swagger-ui .info .title { font-size: 28px; color: #1e293b; }
    .swagger-ui .info .description { font-size: 14px; line-height: 1.6; color: #475569; }
  </style>
</head>
<body>
  <div class="auth-banner">
    <div>
      <h1>Workflow Engine — Developer Integration API</h1>
      <p>Interactive OpenAPI 3.0 Documentation for External Systems, Portals, and Claim Integrations</p>
    </div>
    <div class="auth-badge" id="session-badge">Authenticated Session</div>
  </div>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('token') || localStorage.getItem('token') || '';
    if (!token) {
      const badge = document.getElementById('session-badge');
      badge.textContent = 'Unauthenticated (Bearer Required)';
      badge.style.background = '#ef4444';
    }

    const specUrl = token ? ('openapi.json?token=' + encodeURIComponent(token)) : 'openapi.json';

    window.ui = SwaggerUIBundle({
      url: specUrl,
      dom_id: '#swagger-ui',
      deepLinking: true,
      docExpansion: 'list',
      filter: true,
      persistAuthorization: true,
      requestInterceptor: (req) => {
        if (token && !req.headers['Authorization']) {
          req.headers['Authorization'] = 'Bearer ' + token;
        }
        return req;
      }
    });
  </script>
</body>
</html>`;
