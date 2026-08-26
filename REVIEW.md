# PR Review

## Credential Redaction Boundary

Redaction is enforced where a value reaches a caller: startup diagnostics, normalized upstream errors, and tool results. It is NOT enforced on the types that exist to carry connection settings.

`InstanceConfiguration` (`src/config/environment.ts`) holds `apiKey` and `baseUrl`, and `UpstreamClient.apiBaseUrl` (`src/http/client.ts`) exposes the resolved API base. Both are deliberate — the client cannot send `X-Api-Key` without the key, and adapters need the base. Do not report these as serialization leaks, and do not add non-enumerable properties or getters to hide them; anything able to read the property can still leak it, so that only obscures the boundary.

Report an actual leak instead: an API key or configured URL appearing in a `ConfigurationError`, an `UpstreamError` (its message, `toJSON`, `cause`, or stack), stderr, or an MCP tool result.

## Task Cross-Reference

Cross-reference every PR against task lists in `docs/changes/` and `docs/tasks.md`. If the PR completes work tracked in those files, the task checkboxes MUST be updated in this same PR. Request changes if missing.
