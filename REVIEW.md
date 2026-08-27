# PR Review

## Task Cross-Reference

Cross-reference every PR against task lists in `docs/changes/` and `docs/tasks.md`. If the PR completes work tracked in those files, the task checkboxes MUST be updated in this same PR. Request changes if missing.

## Retained Reference Fields: Null and Undefined Are Both Absent

`storedWord` and `storedId` in `src/tools/activity-references.ts` deliberately classify both `undefined` and `null` as **absent** rather than as corrupt, and every resolver that reads a retained field relies on that. Absence is a legitimate answer for an optional retained field — a pending release has no tracked state, a Prowlarr history record has no media association — while a value of the wrong type or range is `invalid` and is refused. Asking for `null` to be rejected as corruption is a false positive: references live only in process memory and are never serialized, so `null` cannot arrive from outside, and the two helpers must keep answering alike or the queue and history resolvers drift apart.

## Zod 4 Schema Conventions

This repository pins zod 4 (see `zod` in `package.json`). In zod 4 the custom-message key for `.refine`, `.check`, and the schema factories is `error`; `message` is the legacy zod 3 alias. Both produce the custom message — verified against the pinned version — so `{ error: ... }` is correct and the message is not lost or ignored. Reporting `error` as a mistake, or asking for it to be changed to `message`, is a false positive.
