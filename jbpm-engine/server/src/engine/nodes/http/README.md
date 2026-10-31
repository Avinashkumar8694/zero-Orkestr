# Service Task (REST HTTP) (`http`)

## 1. Overview & Purpose
The **Service Task (REST)** connects the BPM engine to external microservices, payment gateways, policy administration systems, and cloud APIs. It performs real outbound HTTP requests, extracts JSON response values into process variables, and handles failures via standard BPMN Error Boundary mechanisms.

## 2. Supported Scenarios & Behavioral Variants

### Scenario A: Relative URL (Integration Layer Service Call)
- **Behavior**: When `url` is relative (e.g. `/v1/claims/verify`), the engine automatically prefixes it with the deployment's operator-configured `INTEGRATION_LAYER_URL` (or default `integrationBaseUrl`).
- **SSRF Exemption**: Relative paths are trusted operator configurations and bypass SSRF gating.
- **When to Use**: Internal microservice orchestration within the enterprise cluster.

### Scenario B: Absolute URL with SSRF Guard (`https://api.partner.com/verify`)
- **Behavior**: When `url` begins with `http://` or `https://`, the engine applies the **SSRF Guard**:
  - Resolves DNS addresses.
  - Rejects private, loopback (`127.0.0.1`), link-local (`169.254.169.254`), or internal IPs.
  - Permitted only if the domain is explicitly listed in `outboundAllowlist` (configured in System Settings).
- **When to Use**: Third-party APIs, credit bureaus, SMS gateways, and external vendor integrations.

### Scenario C: JSONPath Response Mapping (`resultTo`)
- **Behavior**: Automatically parses JSON responses and extracts fields into process variables via simple JSONPath dot-notation (e.g. `policyStatus ← $.data.status`).
- **When to Use**: Standard REST responses mapping into process data without writing code.

### Scenario D: Exit Script Post-Processing Hook (`exitScript`)
- **Behavior**: Runs a post-response script (JS or Java) with the raw response body bound to `resPayload` and access to all flow variables (`vars`, `instance`, `node`, `console.log`).
- **When to Use**: Custom response normalization, complex payload handling, or conditional status mapping.
- **Cheat Sheet**: See the [JavaScript & Flow Variables Cheat Sheet](../../../../docs/usage_docs/15-javascript-and-flow-variables-cheatsheet.md) for complete details on `resPayload` and `vars`.

## 3. Property Reference & Possible Values

| Field | JSON Path | Type | Allowed Values | Default | Description |
|---|---|---|---|---|---|
| **Name** | `name` | `string` | Free text | `"Service Task"` | Label displayed on diagram. |
| **Method** | `method` | `string` | `'GET'`, `'POST'`, `'PUT'`, `'DELETE'`, `'PATCH'` | `'POST'` | HTTP method. |
| **URL** | `url` | `string` | Relative path (`/api/v1`) or absolute URL (`https://...`) | `"/"` | Target endpoint URL. |
| **Headers** | `headers` | `Record<string, string>` | Key-value pairs | `{}` | Outbound HTTP request headers. |
| **Body** | `body` | `Record<string, unknown>` | Key-value pairs (`$varName` or literals) | `{}` | Request JSON payload. |
| **Result Mapping** | `resultTo` | `Record<string, string>` | `varName ← JSONPath` | `{}` | Maps response JSON fields to process variables. |
| **Exit Script** | `exitScript` | `string` | Code snippet | `undefined` | Optional post-processing script hook. |

## 4. When to Use & When NOT to Use
- **Do Use**:
  - All external network communication, REST integrations, and microservice calls.
  - Always attach an **Error Boundary** to catch `SERVICE_ERROR` or HTTP 4xx/5xx failures.
  - Use relative URLs for internal services to leverage environment-based URL promotion.
- **Do NOT Use**:
  - Do NOT make HTTP calls inside a Script Task (always use Service Task).
  - Do NOT call private IP addresses directly in author workflows without adding them to `outboundAllowlist`.

## 5. Concrete Step-by-Step Examples

### Example 1: Verify Policy via Internal Integration Service
```json
{
  "id": "http_verify",
  "name": "Verify Policy Status",
  "type": "http",
  "method": "POST",
  "url": "/v1/policies/verify",
  "headers": {
    "X-Correlation-ID": "$instanceId"
  },
  "body": {
    "policyNumber": "$policyNumber",
    "claimDate": "$incidentDate"
  },
  "resultTo": {
    "policyActive": "status.active",
    "coverageLimit": "coverage.maxAmount"
  }
}
```

### Example 2: External Credit Check with Error Catching
```json
{
  "id": "http_bureau",
  "name": "Equifax Credit Lookup",
  "type": "http",
  "method": "GET",
  "url": "https://api.equifax.com/v2/credit-score?ssn=$ssn",
  "resultTo": {
    "creditScore": "score"
  }
}
```

## 6. Testing Scenarios & Verification Guide
1. **Successful 200 OK**: Call mock endpoint; verify mapped variables exist in `inst.variables`.
2. **Non-2xx Failure Handling**: Target returns 500 Internal Error; verify engine generates `SERVICE_ERROR` outcome.
3. **SSRF Blocking**: Absolute URL to `http://169.254.169.254`; verify call is aborted with `errorCode: 'SSRF_BLOCKED'`.
4. **Timeout Enforcement**: Target hangs; verify request aborts after `httpTimeoutSeconds` (default 10s).

## 7. Operational Gotchas & Edge Cases
- **Non-200 Responses**: Any HTTP status $\ge 400$ raises a `SERVICE_ERROR`. Attach an Error Boundary to prevent instance termination.
- **SSRF Protection**: Absolute URLs targeting loopback or cloud metadata are blocked by default. Add trusted internal domains to `outboundAllowlist` in System Settings.
