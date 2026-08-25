# Documentation

## Specs

| Spec | Description | Status |
|------|-------------|--------|
| [Acquisition and Import](specs/acquisition-and-import/) | Release search, grab, automatic search, and guarded manual import workflows | active |
| [Activity Management](specs/activity-management/) | Queue, history, blocklist, health, command, and job behavior | active |
| [Architecture](specs/architecture/) | Local stdio runtime, environment configuration, compatibility, and testing contracts | active |
| [Configuration Reconciliation](specs/configuration-reconciliation/) | Safe observation and reconciliation of upstream application configuration | active |
| [Library Management](specs/library-management/) | Sonarr and Radarr library discovery, query, monitoring, files, and mutations | active |
| [Tool Contracts](specs/tool-contracts/) | Stable typed MCP tools, plan/apply, references, errors, receipts, and jobs | active |

## Changes

| # | Change | Spec | Status | Depends On |
|---|--------|------|--------|------------|
| 0001 | [Project Foundation](changes/0001-project-foundation.md) | [Architecture](specs/architecture/) | draft | — |
| 0002 | [Typed Tool Runtime](changes/0002-tool-runtime.md) | [Tool Contracts](specs/tool-contracts/) | draft | 0001 |
| 0003 | [Library Queries](changes/0003-library-queries.md) | [Library Management](specs/library-management/) | draft | 0001, 0002 |
| 0004 | [Activity Diagnostics](changes/0004-activity-diagnostics.md) | [Activity Management](specs/activity-management/) | draft | 0001, 0002 |
| 0005 | [Release Search and Grab](changes/0005-release-search-and-grab.md) | [Acquisition and Import](specs/acquisition-and-import/) | draft | 0002, 0003 |
| 0006 | [Queue Resolution](changes/0006-queue-resolution.md) | [Activity Management](specs/activity-management/) | draft | 0002, 0004 |
| 0007 | [Guarded Manual Import](changes/0007-manual-import.md) | [Acquisition and Import](specs/acquisition-and-import/) | draft | 0002, 0003, 0004, 0006 |
| 0008 | [Configuration Reconciliation](changes/0008-configuration-reconciliation.md) | [Configuration Reconciliation](specs/configuration-reconciliation/) | draft | 0001, 0002 |
| 0009 | [Library Mutations](changes/0009-library-mutations.md) | [Library Management](specs/library-management/) | draft | 0002, 0003 |
| 0010 | [History and Blocklist Mutations](changes/0010-history-and-blocklist-mutations.md) | [Activity Management](specs/activity-management/) | draft | 0002, 0004 |
