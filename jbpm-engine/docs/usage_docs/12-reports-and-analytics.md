# Reports & Analytics Architecture

The platform provides a clean architectural separation between **Executive & Operational Analytics (Home)** and **Detailed Tabular Reporting & Data Exports (Reports)**:

```
┌────────────────────────────────────────────────────────┐
│ HOME (/home) — Analytics Hub                           │
│  - KPI Summary Tiles (Active, Completed, Failed, SLAs) │
│  - Interactive Visual Charts (Donut, Bars, Heatmaps)   │
│  - Time-Window Scoping (24h, 7d, 30d, 90d, Custom)     │
│  - Strict On-Demand Lazy-Loaded Analytics Tabs         │
└────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────┐
│ REPORTS (/reports) — Operational Center & Exports      │
│  - Tabular Operational Logs (Executions, SLAs, Cases)  │
│  - System Audit Trail & Security Events                │
│  - Ad-Hoc Query Engine & Saved Filters                 │
│  - Native CSV & JSON File Downloads                    │
└────────────────────────────────────────────────────────┘
```

---

## 1. Home (`/home`) — The Unified Analytics Hub

The Home page serves as the single centralized analytics dashboard for administrators, managers, and authors. All high-level analytics charts are located here to avoid redundant reporting interfaces:

- **Executive KPI Cards**:
  - Active & Waiting Process Instances
  - Daily Throughput & Completion Rate (%)
  - Open Human Tasks & Critical Priority Queue
  - Active SLA Breaches & Escalations
  - System Health & Sidecar JVM Status

- **Interactive Visualizations**:
  - **Status Breakdown**: Interactive donut chart showing instance distribution across `running`, `completed`, `failed`, and `aborted`.
  - **Throughput & Velocity**: Bar charts tracking hourly/daily starts and completions.
  - **Execution Duration Percentiles**: P50, P90, and P99 latency percentiles to identify performance degradation.
  - **Task & Node Bottleneck Heatmap**: Pinpoints nodes with high dwell times or recurring retries.

- **Time Window & Date Range Scoping**:
  - A global time filter in the header scopes all visual metrics: `Last 24 Hours`, `Last 7 Days`, `Last 30 Days`, `Last 90 Days`, or custom `From/To` calendar ranges.

- **Strict On-Demand Tab Lazy Loading**:
  - The Home dashboard utilizes an internal `loadedTabs: Set<string>` cache.
  - Sub-views (e.g., Process Performance, Task Distribution, Case Metrics, Error Trends) only trigger HTTP API requests when their tab is explicitly clicked, keeping initial page load under 100ms.

---

## 2. Reports (`/reports`) — Operational Reporting & Exports

The dedicated Reports section focuses on granular tabular reporting, auditing, and bulk data extraction:

### Available Operational Reports

1. **Process Execution Logs**:
   - Comprehensive log of all executed instances with timestamps, initiator, execution time, error codes, and parent/child bindings.
2. **Task SLA Breaches**:
   - Detailed monitoring of all human tasks that have exceeded their configured deadlines, grouped by assignee and candidate group.
3. **Case Resolution Reports**:
   - Tracks business cases from submission to final resolution, recording status progression and business schema payloads.
4. **Platform Audit Trail**:
   - Immutable security and change log capturing who deployed versions, altered secrets, completed tasks, or aborted instances.
5. **Ad-Hoc Query Engine (`analytics:query`)**:
   - Build custom operational queries with dynamic filters (e.g., `status = 'failed' AND error.code = 'SSRF_BLOCKED'`).
   - Save frequently used queries as reusable presets.

### Native Data Exports (CSV & JSON)

Every tabular report in the Reports center features one-click data export:
- **Export to CSV**: Formats table data into standardized comma-separated values compatible with Excel and business intelligence tools.
- **Export to JSON**: Dumps structured records, preserving nested variable hierarchies and metadata.
- **Client-Side Generation**: Exports are compiled efficiently in-browser via Blob URLs, ensuring immediate downloads without loading server memory.

---

## 3. Data Integrity & Live Querying

- **Real-Time Data Store**: All analytics and reports query the primary platform repository directly — there is no stale batch ETL or nightly sync. Metrics reflect live executions up to the second.
- **Data Retention & Pruning**: History retention settings in System Settings (`instanceRetentionDays` and `auditRetentionDays`) determine how far historical reports can reach before pruning.
