import { type NodeDef, MULTI_INSTANCE, GENERAL, EXECUTION, SLA, ADVANCED } from '../def-types.ts';

export const def: NodeDef = {
  engineType: 'http',
  palette: [{ key: 'http', label: 'Service Task (REST)', category: 'Tasks', icon: '🌐', color: '#0d9488', engineType: 'http', defaults: { type: 'http', method: 'POST', url: '/' } }],
  ports: { maxIn: 1, maxOut: 1 },
  schema: [GENERAL, { title: 'Request', fields: [
    { key: 'method', label: 'Method', widget: 'select', options: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'] },
    { key: 'url', label: 'URL (appended to base)', widget: 'text', placeholder: '/v1/claims' },
    { key: 'headers', label: 'Headers', widget: 'keyval' },
    { key: 'body', label: 'Body (value or $var)', widget: 'keyval', valueSource: 'ownRef', help: 'Right side: "$name" to send one of this process\'s own variables, or a literal value.' },
  ] }, { title: 'Response & Error Handling', fields: [
    { key: 'resultTo', label: 'Map response → variable (var ← JSONPath)', widget: 'keyval', keySource: 'own', help: 'Left = this process\'s variable to write (pick an existing one to overwrite it, or type a new name), e.g. verifierId ← $.verifierId.' },
    { key: 'throwError', label: 'Throw error on failure (Default: On)', widget: 'bool', help: 'When off, HTTP 4xx/5xx or network errors are written to errorVar (soft failure) instead of raising SERVICE_ERROR.' },
    { key: 'contentType', label: 'Content type', widget: 'text', placeholder: 'application/json', help: 'Sent as the content-type header. application/x-www-form-urlencoded sends the body as a form.' },
    { key: 'authType', label: 'Authentication', widget: 'select', options: ['none', 'basic', 'bearer'], help: 'Adds the Authorization header for you; an explicit header below still wins.' },
    { key: 'username', label: 'User name (basic)', widget: 'text', placeholder: '$apiUser' },
    { key: 'password', label: 'Password (basic)', widget: 'text', placeholder: '$apiPassword', help: 'Use $variable or ${ENV_NAME} so the secret is not stored in the diagram.' },
    { key: 'token', label: 'Token (bearer)', widget: 'text', placeholder: '$apiToken' },
    { key: 'timeoutSeconds', label: 'Timeout (seconds)', widget: 'number', placeholder: 'workspace default', help: 'Cancel the call after this long (1–300). Empty uses the workspace HTTP timeout.' },
    { key: 'errorVar', label: 'Soft-failure variable (when Throw Error is Off)', widget: 'text', placeholder: 'serviceError', help: 'Variable name to store { httpStatus, url, responseBody, method } on soft failure.' },
    { key: 'exitScript', label: 'Exit script (hook)', widget: 'code', placeholder: '// raw response in resPayload', help: 'Optional post-processing script executed with resPayload bound.' },
  ] }, EXECUTION, MULTI_INSTANCE, SLA, ADVANCED],
  diagram: { icon: 'globe', color: '#0d9488', shape: 'rectangle' },
  typeLabel: 'Service task',
  docs: {
    summary: 'Executes outbound REST HTTP requests with JSONPath mapping, variable substitution, and SSRF guards.',
    purpose: 'Integrates with external microservices and cloud APIs. Relative URLs append to the environment base URL; absolute URLs are screened by SSRF security.',
    whenToUse: [
      'Use for outbound microservice calls, payment gateway requests, and third-party API lookups.',
      'Use resultTo to automatically map JSON response attributes directly into process variables.',
      'Attach an Error Boundary to gracefully recover from network or HTTP 5xx errors.',
    ],
    whenNotToUse: [
      'Do not use for human workflows (use User Task).',
      'Do not make HTTP calls inside a Script Task.',
    ],
    scenarios: [
      {
        title: 'Relative Internal Microservice Call',
        description: 'Appends relative path to deployment base URL; trusted configuration that bypasses SSRF filters.',
        whenToUse: 'Inter-service communication in the same cluster.',
        exampleJson: { id: 'http_internal', name: 'Verify Policy', type: 'http', method: 'POST', url: '/v1/policies', body: { policyId: '$policyId' }, resultTo: { status: 'status' } },
      },
      {
        title: 'External Third-Party API with JSONPath',
        description: 'Calls external HTTPS endpoint with header authentication and maps nested fields.',
        whenToUse: 'Vendor integrations and payment processing.',
        exampleJson: { id: 'http_ext', name: 'Credit Check', type: 'http', method: 'GET', url: 'https://api.partner.com/score?user=$userId', resultTo: { creditScore: 'data.score' } },
      },
    ],
    fields: [
      { key: 'name', label: 'Name', type: 'string', default: 'Service Task (REST)', required: true, description: 'Display name.' },
      { key: 'method', label: 'HTTP Method', type: 'select', options: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'], default: 'POST', required: true, description: 'HTTP request verb.' },
      { key: 'url', label: 'Target URL', type: 'string', default: '/', required: true, description: 'Relative path or absolute URL.' },
      { key: 'headers', label: 'Headers', type: 'keyval', required: false, description: 'HTTP headers.' },
      { key: 'body', label: 'Body', type: 'keyval', required: false, description: 'Payload ($var or literal).' },
      { key: 'resultTo', label: 'Result Mapping', type: 'keyval', required: false, description: 'Mapping: varName ← JSONPath.' },
      { key: 'exitScript', label: 'Exit Script', type: 'string', required: false, description: 'Post-response script executed with resPayload bound.' },
    ],
    gotchas: [
      'Non-2xx HTTP responses generate a SERVICE_ERROR outcome. Attach an Error Boundary to catch this.',
      'Absolute URLs to private/loopback addresses are blocked by the SSRF guard unless added to outboundAllowlist.',
    ],
  },
};
