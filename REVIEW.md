# PR Review

## Task Cross-Reference

Cross-reference every PR against task lists in `docs/changes/` and `docs/tasks.md`. If the PR completes work tracked in those files, the task checkboxes MUST be updated in this same PR. Request changes if missing.

## Zod 4 Schema Conventions

This repository pins zod 4 (see `zod` in `package.json`). In zod 4 the custom-message key for `.refine`, `.check`, and the schema factories is `error`; `message` is the legacy zod 3 alias. Both produce the custom message — verified against the pinned version — so `{ error: ... }` is correct and the message is not lost or ignored. Reporting `error` as a mistake, or asking for it to be changed to `message`, is a false positive.
