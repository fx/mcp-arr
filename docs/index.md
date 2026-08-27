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

Changes 0011 through 0014 were scheduled ahead of the lower-numbered domain changes that were still outstanding at the time. 0011 establishes distribution; 0012 through 0014 correct defects found testing the merged server against live Sonarr, Radarr, and Prowlarr instances. 0012 in particular was worth landing before any further domain change, because every one of them adds tools onto the same broken publication path. Which changes are still outstanding is the table's answer rather than this note's.

| # | Change | Spec | Status | Depends On |
|---|--------|------|--------|------------|
| 0001 | [Project Foundation](changes/0001-project-foundation.md) | [Architecture](specs/architecture/) | complete | — |
| 0002 | [Typed Tool Runtime](changes/0002-tool-runtime.md) | [Tool Contracts](specs/tool-contracts/) | complete | 0001 |
| 0003 | [Library Queries](changes/0003-library-queries.md) | [Library Management](specs/library-management/) | complete | 0001, 0002 |
| 0004 | [Activity Diagnostics](changes/0004-activity-diagnostics.md) | [Activity Management](specs/activity-management/) | complete | 0001, 0002 |
| 0005 | [Release Search and Grab](changes/0005-release-search-and-grab.md) | [Acquisition and Import](specs/acquisition-and-import/) | complete | 0002, 0003 |
| 0006 | [Queue Resolution](changes/0006-queue-resolution.md) | [Activity Management](specs/activity-management/) | complete | 0002, 0004 |
| 0007 | [Guarded Manual Import](changes/0007-manual-import.md) | [Acquisition and Import](specs/acquisition-and-import/) | complete | 0002, 0003, 0004, 0006 |
| 0008 | [Configuration Reconciliation](changes/0008-configuration-reconciliation.md) | [Configuration Reconciliation](specs/configuration-reconciliation/) | complete | 0001, 0002 |
| 0009 | [Library Mutations](changes/0009-library-mutations.md) | [Library Management](specs/library-management/) | complete | 0002, 0003 |
| 0010 | [History and Blocklist Mutations](changes/0010-history-and-blocklist-mutations.md) | [Activity Management](specs/activity-management/) | complete | 0002, 0004 |
| 0011 | [npm Publishing](changes/0011-npm-publishing.md) | [Architecture](specs/architecture/) | complete | — |
| 0012 | [Published Tool Schemas](changes/0012-published-tool-schemas.md) | [Tool Contracts](specs/tool-contracts/) | complete | — |
| 0013 | [Result Summary Fidelity](changes/0013-result-summary-fidelity.md) | [Tool Contracts](specs/tool-contracts/) | complete | — |
| 0014 | [Calendar Anchoring](changes/0014-calendar-anchoring.md) | [Library Management](specs/library-management/) | complete | — |
| 0015 | [Flat Tool Input Schemas](changes/0015-flat-tool-input-schemas.md) | [Tool Contracts](specs/tool-contracts/) | in-progress | 0012 |
